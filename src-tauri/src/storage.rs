use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone)]
pub struct StoragePaths {
    pub root: PathBuf,
    pub db_dir: PathBuf,
    pub db_path: PathBuf,
    pub attachments_dir: PathBuf,
    pub vectors_dir: PathBuf,
    pub config_dir: PathBuf,
}

pub fn bootstrap(app: &AppHandle) -> Result<StoragePaths, String> {
    let root = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let paths = StoragePaths {
        db_dir: root.join("db"),
        db_path: root.join("db").join("entries_v2.db"),
        attachments_dir: root.join("attachments"),
        vectors_dir: root.join("vectors"),
        config_dir: root.join("config"),
        root,
    };

    fs::create_dir_all(&paths.root).map_err(|e| e.to_string())?;
    fs::create_dir_all(&paths.db_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&paths.attachments_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&paths.vectors_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&paths.config_dir).map_err(|e| e.to_string())?;

    migrate_legacy_db(&paths.root, &paths.db_path)?;
    Ok(paths)
}

fn migrate_legacy_db(root: &Path, db_path: &Path) -> Result<(), String> {
    let legacy_db_path = root.join("entries_v2.db");
    if db_path.exists() || !legacy_db_path.exists() {
        return Ok(());
    }

    match fs::rename(&legacy_db_path, db_path) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(&legacy_db_path, db_path).map_err(|e| e.to_string())?;
            fs::remove_file(&legacy_db_path).map_err(|e| e.to_string())?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::migrate_legacy_db;
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn migrates_legacy_db_when_new_path_missing() {
        let root = std::env::temp_dir().join(format!("scribe-goblin-storage-{}", Uuid::new_v4()));
        let db_dir = root.join("db");
        let legacy_db_path = root.join("entries_v2.db");
        let new_db_path = db_dir.join("entries_v2.db");

        fs::create_dir_all(&db_dir).unwrap();
        fs::write(&legacy_db_path, b"legacy-db").unwrap();

        migrate_legacy_db(&root, &new_db_path).unwrap();

        assert!(!legacy_db_path.exists());
        assert_eq!(fs::read(&new_db_path).unwrap(), b"legacy-db");

        let _ = fs::remove_dir_all(root);
    }
}
