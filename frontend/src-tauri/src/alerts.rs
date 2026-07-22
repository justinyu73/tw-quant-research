use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager};

pub const ALERT_STORE_SCHEMA: &str = "tqe-in-app-alerts/v1";
const ALERT_DEFINITION_SCHEMA: &str = "tqe-in-app-alert/v1";
const ALERTS_FILENAME: &str = "in-app-alerts.v1.json";
const MAX_ALERTS: usize = 50;

fn empty_store() -> String {
    format!(r#"{{"schema":"{ALERT_STORE_SCHEMA}","version":1,"alerts":[]}}"#)
}

fn alerts_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(ALERTS_FILENAME))
        .map_err(|error| format!("resolve app data directory: {error}"))
}

fn valid_alert_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ":_-.".contains(character))
}

fn validate_alert(definition: &Value) -> Result<(), String> {
    // Structural fail-closed checks only; the local engine performs the full
    // semantic validation of conditions, dedup, and expiry at evaluation time.
    let object = definition
        .as_object()
        .ok_or_else(|| "alert definition must be a JSON object".to_string())?;
    if object.get("schema").and_then(Value::as_str) != Some(ALERT_DEFINITION_SCHEMA) {
        return Err("alert definition schema mismatch".to_string());
    }
    let alert_id = object
        .get("alert_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "alert definition alert_id must be a string".to_string())?;
    if !valid_alert_id(alert_id) {
        return Err(format!("invalid alert id: {alert_id:?}"));
    }
    let security_id = object
        .get("target")
        .and_then(|target| target.get("security_id"))
        .and_then(Value::as_str);
    match security_id {
        Some(value) if !value.is_empty() => {}
        _ => return Err("alert target.security_id must be a non-empty string".to_string()),
    }
    if !object.get("condition").is_some_and(Value::is_object) {
        return Err("alert condition must be an object".to_string());
    }
    Ok(())
}

fn validate_store(raw: &str) -> Result<(), String> {
    let value: Value = serde_json::from_str(raw).map_err(|error| format!("invalid JSON: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "alert store must be a JSON object".to_string())?;
    if object.get("schema").and_then(Value::as_str) != Some(ALERT_STORE_SCHEMA) {
        return Err("alert store schema mismatch".to_string());
    }
    if object.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("alert store version mismatch".to_string());
    }
    let alerts = object
        .get("alerts")
        .and_then(Value::as_array)
        .ok_or_else(|| "alert store alerts must be an array".to_string())?;
    if alerts.len() > MAX_ALERTS {
        return Err(format!("alert store cannot contain more than {MAX_ALERTS} alerts"));
    }
    let mut seen = std::collections::HashSet::new();
    for definition in alerts {
        validate_alert(definition)?;
        let alert_id = definition["alert_id"].as_str().unwrap_or_default();
        if !seen.insert(alert_id.to_string()) {
            return Err(format!("duplicate alert id: {alert_id:?}"));
        }
    }
    Ok(())
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "alerts path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("create app data directory: {error}"))
}

fn write_alerts(path: &Path, content: &str) -> Result<(), String> {
    validate_store(content)?;
    ensure_parent(path)?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, content.as_bytes()).map_err(|error| format!("write alerts: {error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("commit alerts atomically: {error}"))
}

#[tauri::command]
pub fn load_alerts(app: AppHandle) -> Result<String, String> {
    let path = alerts_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(raw) => {
            validate_store(&raw)?;
            Ok(raw)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(empty_store()),
        Err(error) => Err(format!("read alerts: {error}")),
    }
}

#[tauri::command]
pub fn save_alerts(app: AppHandle, content: String) -> Result<(), String> {
    let path = alerts_path(&app)?;
    write_alerts(&path, &content)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{validate_store, write_alerts};

    fn document(alerts: &str) -> String {
        format!(r#"{{"schema":"tqe-in-app-alerts/v1","version":1,"alerts":{alerts}}}"#)
    }

    fn sample_alert(alert_id: &str) -> String {
        format!(
            r#"{{"schema":"tqe-in-app-alert/v1","alert_id":"{alert_id}","label":"研究提醒","enabled":true,"target":{{"security_id":"2330"}},"condition":{{"type":"price_threshold","field":"close","op":">=","value":100}},"dedup":{{"policy":"once_per_session"}},"expiry":{{"policy":"until","until":"2026-12-31T00:00:00Z"}},"created_at":"2026-07-22T00:00:00Z"}}"#
        )
    }

    #[test]
    fn accepts_empty_and_canonical_alert_ids() {
        assert!(validate_store(&document("[]")).is_ok());
        assert!(validate_store(&document(&format!("[{}]", sample_alert("alert-1")))).is_ok());
    }

    #[test]
    fn rejects_duplicates_and_unknown_shape() {
        let duplicated = document(&format!("[{},{}]", sample_alert("alert-1"), sample_alert("alert-1")));
        assert!(validate_store(&duplicated).is_err());
        assert!(validate_store(r#"{"schema":"wrong","version":1,"alerts":[]}"#).is_err());
        assert!(validate_store(r#"{"schema":"tqe-in-app-alerts/v1","version":1,"alerts":[{"id":"alert-1"}]}"#).is_err());
    }

    #[test]
    fn writes_valid_content_and_preserves_previous_file_on_validation_failure() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("tqe-alerts-test-{}-{suffix}", std::process::id()));
        let path = directory.join("nested").join("in-app-alerts.v1.json");
        let valid = document(&format!("[{}]", sample_alert("alert-1")));
        let invalid = document(&format!("[{},{}]", sample_alert("alert-1"), sample_alert("alert-1")));

        write_alerts(&path, &valid).expect("valid alert store should be written");
        assert_eq!(fs::read_to_string(&path).expect("alert store should exist"), valid);
        assert!(write_alerts(&path, &invalid).is_err());
        assert_eq!(fs::read_to_string(&path).expect("previous alert store should remain"), valid);
        fs::remove_dir_all(&directory).expect("test directory should be removable");
    }
}
