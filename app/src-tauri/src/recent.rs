//! F5 recent files: the newest files sitting in Desktop and Downloads.

use crate::{dirs::UserDirs, files::is_junk};
use serde::Serialize;
use std::{fs, path::Path, time::UNIX_EPOCH};
use tauri::AppHandle;

#[derive(Serialize, Debug)]
pub struct RecentFile {
    path: String,
    name: String,
    ext: Option<String>,
    size: u64,
    /// Unix ms; the later of created and modified, so fresh downloads of old files count.
    time: u64,
    /// "Desktop" or "Downloads".
    folder: &'static str,
}

/// Browsers' partial-download extensions: not ready to be used yet.
const IN_PROGRESS: &[&str] = &["crdownload", "part", "download", "partial", "tmp"];

#[tauri::command]
pub fn recent_files(app: AppHandle, limit: Option<usize>) -> Result<Vec<RecentFile>, String> {
    let dirs = UserDirs::resolve(&app)?;
    Ok(newest(&[(&dirs.downloads, "Downloads"), (&dirs.desktop, "Desktop")], limit.unwrap_or(10)))
}

fn newest(folders: &[(&Path, &'static str)], limit: usize) -> Vec<RecentFile> {
    let mut out: Vec<RecentFile> = folders
        .iter()
        .flat_map(|(dir, label)| {
            fs::read_dir(dir).into_iter().flatten().flatten().filter_map(move |e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let meta = e.metadata().ok()?;
                if is_junk(&name) || !meta.is_file() {
                    return None;
                }
                let ext = Path::new(&name).extension().map(|x| x.to_string_lossy().to_lowercase());
                if ext.as_deref().is_some_and(|x| IN_PROGRESS.contains(&x)) {
                    return None;
                }
                let ms = |t: std::io::Result<std::time::SystemTime>| {
                    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
                };
                Some(RecentFile {
                    path: e.path().to_string_lossy().into_owned(),
                    time: ms(meta.modified()).max(ms(meta.created())),
                    size: meta.len(),
                    name,
                    ext,
                    folder: label,
                })
            })
        })
        .collect();
    out.sort_by(|a, b| b.time.cmp(&a.time));
    out.truncate(limit);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{thread::sleep, time::Duration};

    #[test]
    fn newest_first_skips_junk_folders_and_partials() {
        let root = std::env::temp_dir().join(format!("fugu-recent-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let (a, b) = (root.join("Downloads"), root.join("Desktop"));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(b.join("some folder")).unwrap();
        fs::write(a.join("old.pdf"), b"x").unwrap();
        sleep(Duration::from_millis(30));
        fs::write(b.join("new.png"), b"x").unwrap();
        fs::write(a.join(".DS_Store"), b"x").unwrap();
        fs::write(a.join("movie.mp4.crdownload"), b"x").unwrap();

        let got = newest(&[(&a, "Downloads"), (&b, "Desktop")], 10);
        fs::remove_dir_all(&root).unwrap();
        let names: Vec<_> = got.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["new.png", "old.pdf"]);
        assert_eq!(got[0].folder, "Desktop");
    }
}
