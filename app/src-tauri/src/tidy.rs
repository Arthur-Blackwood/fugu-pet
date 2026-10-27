//! F1 tidy desktop. Two steps: `tidy_preview` proposes moves (read-only), and
//! `tidy_apply` performs the moves the user confirmed. Every batch is logged so
//! `tidy_undo` can put the files back. Nothing is ever deleted or overwritten.
//!
//! Only loose files at the top level of the Desktop are considered; folders, hidden
//! files and unknown types stay where they are.

use crate::{dirs::UserDirs, files::{is_junk, unique_path}};
use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Move {
    pub from: String,
    pub to: String,
    /// Rule label shown in the preview, e.g. "Screenshots".
    pub rule: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Batch {
    at: u64,
    moves: Vec<Move>,
}

#[derive(Serialize, Debug, Default)]
pub struct Report {
    pub moved: Vec<Move>,
    pub failed: Vec<(String, String)>,
}

#[derive(Serialize)]
pub struct LastTidy {
    at: u64,
    count: usize,
}

const SCREENSHOT_PREFIXES: &[&str] = &["screenshot", "screen shot", "screen recording", "截屏", "屏幕快照", "录屏", "屏幕录制"];
const SCREENSHOT_EXTS: &[&str] = &["png", "jpg", "jpeg", "heic", "mov", "mp4"];
const INSTALLERS: &[&str] = &["dmg", "pkg", "exe", "msi", "msix", "appimage", "deb"];
const ARCHIVES: &[&str] = &["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"];
const IMAGES: &[&str] = &["jpg", "jpeg", "png", "gif", "heic", "heif", "webp", "tif", "tiff", "bmp", "svg"];
const DOCUMENTS: &[&str] = &["doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key", "txt", "rtf", "md", "csv"];

/// Where a desktop file should go, or None to leave it alone.
fn destination(dirs: &UserDirs, name: &str, modified: SystemTime) -> Option<(PathBuf, &'static str)> {
    let lower = name.to_lowercase();
    let ext = Path::new(&lower).extension()?.to_string_lossy().into_owned();
    let ext = ext.as_str();
    if SCREENSHOT_EXTS.contains(&ext) && SCREENSHOT_PREFIXES.iter().any(|p| lower.starts_with(p)) {
        let month = DateTime::<Local>::from(modified).format("%Y-%m").to_string();
        return Some((dirs.pictures.join("Screenshots").join(month), "Screenshots"));
    }
    Some(match ext {
        "pdf" => (dirs.documents.join("PDF"), "PDFs"),
        e if INSTALLERS.contains(&e) => (dirs.downloads.join("Installers"), "Installers"),
        e if ARCHIVES.contains(&e) => (dirs.downloads.join("Archives"), "Archives"),
        e if IMAGES.contains(&e) => (dirs.pictures.join("Desktop Images"), "Images"),
        e if DOCUMENTS.contains(&e) => (dirs.documents.join("Desktop Documents"), "Documents"),
        _ => return None,
    })
}

pub fn plan(dirs: &UserDirs) -> Vec<Move> {
    let mut moves: Vec<Move> = fs::read_dir(&dirs.desktop)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let meta = e.metadata().ok()?;
            if is_junk(&name) || !meta.is_file() {
                return None;
            }
            let (dir, rule) = destination(dirs, &name, meta.modified().unwrap_or(UNIX_EPOCH))?;
            Some(Move {
                from: e.path().to_string_lossy().into_owned(),
                to: dir.join(&name).to_string_lossy().into_owned(),
                rule: rule.to_string(),
            })
        })
        .collect();
    moves.sort_by(|a, b| (&a.rule, &a.from).cmp(&(&b.rule, &b.from)));
    moves
}

/// Re-validates every move against the current filesystem, then moves.
pub fn apply(dirs: &UserDirs, moves: &[Move]) -> Report {
    let roots = [&dirs.documents, &dirs.pictures, &dirs.downloads];
    let mut report = Report::default();
    for m in moves {
        let (from, to) = (PathBuf::from(&m.from), PathBuf::from(&m.to));
        let check = || -> Result<(), String> {
            if from.parent() != Some(dirs.desktop.as_path()) {
                return Err("not a Desktop file".into());
            }
            if !from.is_file() {
                return Err("no longer on the Desktop".into());
            }
            if !roots.iter().any(|r| to.starts_with(r)) || to.components().any(|c| c.as_os_str() == "..") {
                return Err("unexpected destination".into());
            }
            Ok(())
        };
        let result = check().and_then(|()| {
            let dir = to.parent().ok_or("bad destination")?;
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            let target = unique_path(&to); // re-checked now: never overwrite
            move_file(&from, &target).map_err(|e| e.to_string())?;
            Ok(target)
        });
        match result {
            Ok(target) => report.moved.push(Move { to: target.to_string_lossy().into_owned(), ..m.clone() }),
            Err(e) => report.failed.push((m.from.clone(), e)),
        }
    }
    report
}

/// Puts a batch back. Files that were moved again or deleted since are reported, not forced.
pub fn undo(moves: &[Move]) -> Report {
    let mut report = Report::default();
    for m in moves.iter().rev() {
        let (now_at, back_to) = (PathBuf::from(&m.to), PathBuf::from(&m.from));
        let result = if !now_at.is_file() {
            Err("it was moved or deleted since".to_string())
        } else {
            let target = unique_path(&back_to);
            move_file(&now_at, &target).map(|()| target).map_err(|e| e.to_string())
        };
        match result {
            Ok(target) => report.moved.push(Move { from: m.to.clone(), to: target.to_string_lossy().into_owned(), rule: m.rule.clone() }),
            Err(e) => report.failed.push((m.to.clone(), e)),
        }
    }
    report
}

/// Rename, falling back to copy-then-remove across volumes (e.g. an external Desktop).
fn move_file(from: &Path, to: &Path) -> io::Result<()> {
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) if from.exists() => {
            let copied = fs::copy(from, to)?;
            if copied != fs::metadata(from)?.len() {
                let _ = fs::remove_file(to);
                return Err(io::Error::other("copy was incomplete"));
            }
            fs::remove_file(from)
        }
        Err(e) => Err(e),
    }
}

/* ---------- log + commands ---------- */

const MAX_BATCHES: usize = 20;

fn log_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().map(|d| d.join("tidy-log.json")).unwrap_or_else(|_| "tidy-log.json".into())
}
fn read_log(app: &AppHandle) -> Vec<Batch> {
    fs::read(log_path(app)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}
fn write_log(app: &AppHandle, log: &[Batch]) {
    let path = log_path(app);
    if let Some(d) = path.parent() {
        let _ = fs::create_dir_all(d);
    }
    if let Ok(json) = serde_json::to_vec_pretty(log) {
        let _ = fs::write(path, json);
    }
}

/// Files held in the belly may have just been moved; update their paths.
fn follow_in_belly(app: &AppHandle, report: &Report) {
    let pairs: Vec<(String, String)> = report.moved.iter().map(|m| (m.from.clone(), m.to.clone())).collect();
    app.state::<crate::belly::Belly>().repath(app, &pairs);
}

#[tauri::command]
pub fn tidy_preview(app: AppHandle) -> Result<Vec<Move>, String> {
    Ok(plan(&UserDirs::resolve(&app)?))
}

#[tauri::command]
pub async fn tidy_apply(app: AppHandle, moves: Vec<Move>) -> Result<Report, String> {
    let dirs = UserDirs::resolve(&app)?;
    let _ = app.emit("pet://tidy", moves.len());
    let report = tauri::async_runtime::spawn_blocking(move || apply(&dirs, &moves)).await.map_err(|e| e.to_string())?;
    follow_in_belly(&app, &report);
    if !report.moved.is_empty() {
        let mut log = read_log(&app);
        let at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        log.push(Batch { at, moves: report.moved.clone() });
        let excess = log.len().saturating_sub(MAX_BATCHES);
        log.drain(..excess);
        write_log(&app, &log);
    }
    Ok(report)
}

#[tauri::command]
pub fn tidy_last(app: AppHandle) -> Option<LastTidy> {
    read_log(&app).last().map(|b| LastTidy { at: b.at, count: b.moves.len() })
}

#[tauri::command]
pub fn tidy_undo(app: AppHandle) -> Result<Report, String> {
    let mut log = read_log(&app);
    let batch = log.pop().ok_or("nothing to undo")?;
    let report = undo(&batch.moves);
    follow_in_belly(&app, &report);
    write_log(&app, &log);
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(tag: &str) -> UserDirs {
        let root = std::env::temp_dir().join(format!("fugu-tidy-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let dirs = UserDirs::under(root);
        fs::create_dir_all(&dirs.desktop).unwrap();
        dirs
    }

    #[test]
    fn plans_by_rule_and_leaves_the_rest() {
        let d = sandbox("plan");
        for f in ["Screenshot 2026-10-10 at 9.00.00.png", "paper.PDF", "setup.dmg", "photo.jpg", "notes.docx", "weird.xyz", ".hidden.pdf"] {
            fs::write(d.desktop.join(f), b"x").unwrap();
        }
        fs::create_dir(d.desktop.join("project.pdf")).unwrap(); // a folder, never moved
        let rules: Vec<_> = plan(&d).into_iter().map(|m| (Path::new(&m.from).file_name().unwrap().to_string_lossy().into_owned(), m.rule)).collect();
        let _ = fs::remove_dir_all(d.desktop.parent().unwrap());
        assert_eq!(rules, [
            ("notes.docx".into(), "Documents".into()),
            ("photo.jpg".into(), "Images".into()),
            ("setup.dmg".into(), "Installers".into()),
            ("paper.PDF".into(), "PDFs".into()),
            ("Screenshot 2026-10-10 at 9.00.00.png".to_string(), "Screenshots".to_string()),
        ]);
    }

    #[test]
    fn apply_never_overwrites_and_undo_restores() {
        let d = sandbox("apply");
        fs::write(d.desktop.join("a.pdf"), b"new").unwrap();
        fs::create_dir_all(d.documents.join("PDF")).unwrap();
        fs::write(d.documents.join("PDF/a.pdf"), b"existing").unwrap();

        let report = apply(&d, &plan(&d));
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!(fs::read(d.documents.join("PDF/a.pdf")).unwrap(), b"existing");
        assert_eq!(fs::read(d.documents.join("PDF/a (2).pdf")).unwrap(), b"new");
        assert!(!d.desktop.join("a.pdf").exists());

        let back = undo(&report.moved);
        assert!(back.failed.is_empty());
        assert_eq!(fs::read(d.desktop.join("a.pdf")).unwrap(), b"new");
        assert_eq!(fs::read(d.documents.join("PDF/a.pdf")).unwrap(), b"existing");
        let _ = fs::remove_dir_all(d.desktop.parent().unwrap());
    }

    #[test]
    fn apply_rejects_moves_outside_the_rules() {
        let d = sandbox("reject");
        let outside = d.desktop.parent().unwrap().join("elsewhere.txt");
        fs::write(&outside, b"x").unwrap();
        fs::write(d.desktop.join("b.txt"), b"x").unwrap();
        let bad = [
            Move { from: outside.to_string_lossy().into(), to: d.documents.join("x.txt").to_string_lossy().into(), rule: "x".into() },
            Move { from: d.desktop.join("b.txt").to_string_lossy().into(), to: "/tmp/b.txt".into(), rule: "x".into() },
        ];
        let report = apply(&d, &bad);
        assert_eq!(report.failed.len(), 2);
        assert!(outside.exists() && d.desktop.join("b.txt").exists());
        let _ = fs::remove_dir_all(d.desktop.parent().unwrap());
    }
}
