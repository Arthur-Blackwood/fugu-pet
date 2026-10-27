use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub ext: Option<String>,
    /// Bytes. For folders: total of all files inside (recursive).
    pub size: u64,
    pub is_dir: bool,
    /// False if a folder walk ran out of time, in which case `size` is a lower bound.
    pub size_complete: bool,
}

/// Total time allowed for walking dropped folders, across one drop.
const WALK_BUDGET: Duration = Duration::from_secs(3);

/// Resolve paths into metadata, including recursive folder sizes. Read-only.
/// Folder walks can take a while, so this runs off the async runtime.
pub async fn describe_all(paths: Vec<PathBuf>) -> Result<Vec<FileInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + WALK_BUDGET;
        paths.into_iter().map(|p| describe(p, deadline)).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

pub fn describe(p: PathBuf, deadline: Instant) -> FileInfo {
    let meta = fs::symlink_metadata(&p).ok();
    let is_dir = meta.as_ref().is_some_and(|m| m.is_dir());
    let (size, size_complete) = if is_dir {
        dir_size(&p, deadline)
    } else {
        // Follow a dropped symlink/alias to report the target's size.
        (fs::metadata(&p).map(|m| m.len()).unwrap_or(0), true)
    };
    FileInfo {
        name: p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| p.to_string_lossy().into_owned()),
        ext: if is_dir { None } else { p.extension().map(|e| e.to_string_lossy().to_lowercase()) },
        size,
        is_dir,
        size_complete,
        path: p.to_string_lossy().into_owned(),
    }
}

/// Sum file sizes under `root` without following symlinks (avoids cycles and
/// counting things that live elsewhere). Stops early at `deadline`.
fn dir_size(root: &Path, deadline: Instant) -> (u64, bool) {
    let mut total = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if Instant::now() > deadline {
            return (total, false);
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                stack.push(entry.path());
            } else if let Ok(m) = entry.metadata() {
                total += m.len();
            }
        }
    }
    (total, true)
}

/// `base` if free, else "stem (2).ext", "stem (3).ext", … — never overwrite anything.
pub fn unique_path(base: &Path) -> PathBuf {
    if !base.exists() {
        return base.to_path_buf();
    }
    let dir = base.parent().unwrap_or(Path::new(""));
    let stem = base.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = base.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .expect("unbounded range")
}

/// Hidden / system clutter that tools should never touch or list.
pub fn is_junk(name: &str) -> bool {
    name.starts_with('.')
        || name.starts_with("~$")
        || matches!(name.to_ascii_lowercase().as_str(), "desktop.ini" | "thumbs.db" | "icon\r")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_size_is_recursive_and_skips_symlinks() {
        let root = std::env::temp_dir().join(format!("fugu-size-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("top.bin"), vec![0u8; 1000]).unwrap();
        fs::write(root.join("a/b/deep.bin"), vec![0u8; 2345]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("a"), root.join("loop")).unwrap();

        let (size, complete) = dir_size(&root, Instant::now() + WALK_BUDGET);
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(size, 3345);
        assert!(complete);
    }

    #[test]
    fn walk_stops_at_deadline() {
        let (_, complete) = dir_size(&std::env::temp_dir(), Instant::now() - Duration::from_secs(1));
        assert!(!complete);
    }
}
