use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// The user folders the pet reads from (recent files) and tidies into.
#[derive(Clone, Debug)]
pub struct UserDirs {
    pub desktop: PathBuf,
    pub documents: PathBuf,
    pub pictures: PathBuf,
    pub downloads: PathBuf,
}

impl UserDirs {
    /// The real user folders (OneDrive-redirected ones on Windows included), unless
    /// `FUGU_TEST_HOME` points at a sandbox folder — used for testing tidy safely.
    pub fn resolve(app: &AppHandle) -> Result<Self, String> {
        if let Some(home) = std::env::var_os("FUGU_TEST_HOME") {
            return Ok(Self::under(PathBuf::from(home)));
        }
        let p = app.path();
        let err = |e: tauri::Error| e.to_string();
        Ok(UserDirs {
            desktop: p.desktop_dir().map_err(err)?,
            documents: p.document_dir().map_err(err)?,
            pictures: p.picture_dir().map_err(err)?,
            downloads: p.download_dir().map_err(err)?,
        })
    }

    /// Standard layout under one root (sandbox / tests).
    pub fn under(home: PathBuf) -> Self {
        UserDirs {
            desktop: home.join("Desktop"),
            documents: home.join("Documents"),
            pictures: home.join("Pictures"),
            downloads: home.join("Downloads"),
        }
    }
}
