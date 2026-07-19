use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager};

pub const WATCHLIST_SCHEMA: &str = "tw-quant-engine-watchlist/v1";
const WATCHLIST_FILENAME: &str = "watchlist.v1.json";
const MAX_ITEMS: usize = 100;

fn empty_watchlist() -> String {
    format!(r#"{{"schema":"{WATCHLIST_SCHEMA}","version":1,"items":[]}}"#)
}

fn watchlist_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(WATCHLIST_FILENAME))
        .map_err(|error| format!("resolve app data directory: {error}"))
}

fn valid_instrument_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ":_-.".contains(character))
}

fn validate_watchlist(raw: &str) -> Result<(), String> {
    let value: Value = serde_json::from_str(raw).map_err(|error| format!("invalid JSON: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "watchlist must be a JSON object".to_string())?;
    if object.get("schema").and_then(Value::as_str) != Some(WATCHLIST_SCHEMA) {
        return Err("watchlist schema mismatch".to_string());
    }
    if object.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("watchlist version mismatch".to_string());
    }
    let items = object
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| "watchlist items must be an array".to_string())?;
    if items.len() > MAX_ITEMS {
        return Err(format!("watchlist cannot contain more than {MAX_ITEMS} items"));
    }
    let mut seen = std::collections::HashSet::new();
    for item in items {
        let instrument_id = item
            .as_str()
            .ok_or_else(|| "watchlist items must be strings".to_string())?;
        if !valid_instrument_id(instrument_id) {
            return Err(format!("invalid instrument id: {instrument_id:?}"));
        }
        if !seen.insert(instrument_id) {
            return Err(format!("duplicate instrument id: {instrument_id:?}"));
        }
    }
    Ok(())
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "watchlist path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("create app data directory: {error}"))
}

fn write_watchlist(path: &Path, content: &str) -> Result<(), String> {
    validate_watchlist(content)?;
    ensure_parent(path)?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, content.as_bytes()).map_err(|error| format!("write watchlist: {error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("commit watchlist atomically: {error}"))
}

#[tauri::command]
pub fn load_watchlist(app: AppHandle) -> Result<String, String> {
    let path = watchlist_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(raw) => {
            validate_watchlist(&raw)?;
            Ok(raw)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(empty_watchlist()),
        Err(error) => Err(format!("read watchlist: {error}")),
    }
}

#[tauri::command]
pub fn save_watchlist(app: AppHandle, content: String) -> Result<(), String> {
    let path = watchlist_path(&app)?;
    write_watchlist(&path, &content)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{validate_watchlist, write_watchlist, WATCHLIST_SCHEMA};

    fn document(items: &str) -> String {
        format!(r#"{{"schema":"{WATCHLIST_SCHEMA}","version":1,"items":{items}}}"#)
    }

    #[test]
    fn accepts_empty_and_canonical_instrument_ids() {
        assert!(validate_watchlist(&document("[]")).is_ok());
        assert!(validate_watchlist(&document(r#"["TWSE:2330","TPEx:006201","TAIFEX:TX:202608"]"#)).is_ok());
    }

    #[test]
    fn rejects_duplicates_and_unknown_shape() {
        assert!(validate_watchlist(&document(r#"["TWSE:2330","TWSE:2330"]"#)).is_err());
        assert!(validate_watchlist(r#"{"schema":"wrong","version":1,"items":[]}"#).is_err());
        assert!(validate_watchlist(r#"{"schema":"tw-quant-engine-watchlist/v1","version":1,"items":[{"id":"TWSE:2330"}]}"#).is_err());
    }

    #[test]
    fn writes_valid_content_and_preserves_previous_file_on_validation_failure() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("tqe-watchlist-test-{}-{suffix}", std::process::id()));
        let path = directory.join("nested").join("watchlist.v1.json");
        let valid = document(r#"["TWSE:2330"]"#);
        let invalid = document(r#"["TWSE:2330","TWSE:2330"]"#);

        write_watchlist(&path, &valid).expect("valid watchlist should be written");
        assert_eq!(fs::read_to_string(&path).expect("watchlist should exist"), valid);
        assert!(write_watchlist(&path, &invalid).is_err());
        assert_eq!(fs::read_to_string(&path).expect("previous watchlist should remain"), valid);
        fs::remove_dir_all(&directory).expect("test directory should be removable");
    }
}
