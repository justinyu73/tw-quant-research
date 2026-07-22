use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const SIDECAR_NAME: &str = "tqe-sidecar";

mod alerts;
mod watchlist;

struct SidecarProcess(Mutex<Option<CommandChild>>);

struct SidecarPort(u16);

struct SidecarConfig {
    data_dir: PathBuf,
    port: u16,
}

#[tauri::command]
fn sidecar_url(state: tauri::State<'_, SidecarPort>) -> String {
    format!("http://127.0.0.1:{}", state.0)
}

fn reserve_loopback_port() -> std::io::Result<u16> {
    // Bind then release: there is a small race window before the sidecar
    // process takes the port, which is acceptable for a single-user desktop
    // app; a clash only makes the sidecar fail to start, and the front end
    // then follows its existing error path.
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn spawn_sidecar(app: &AppHandle) -> Result<CommandChild, String> {
    let config = app.state::<SidecarConfig>();
    let command = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|error| format!("resolve sidecar: {error}"))?
        .env("TQE_DATA_DIR", config.data_dir.to_string_lossy().to_string())
        .env("TQE_SIDECAR_PORT", config.port.to_string());
    let (mut events, child) = command.spawn().map_err(|error| format!("spawn sidecar: {error}"))?;
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    eprint!("[tqe-sidecar] {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[tqe-sidecar] terminated: {payload:?}");
                }
                CommandEvent::Error(error) => eprintln!("[tqe-sidecar] error: {error}"),
                _ => {}
            }
        }
    });
    Ok(child)
}

fn stop_sidecar(app: &AppHandle) {
    if let Some(process) = app.try_state::<SidecarProcess>() {
        if let Ok(mut slot) = process.0.lock() {
            if let Some(child) = slot.take() {
                let _ = child.kill();
            }
        }
    }
}

fn revive_sidecar(app: &AppHandle) {
    if let Ok(child) = spawn_sidecar(app) {
        if let Some(process) = app.try_state::<SidecarProcess>() {
            if let Ok(mut slot) = process.0.lock() {
                *slot = Some(child);
            }
        }
    }
}

/// Check the public GitHub release for a newer signed build. The endpoints
/// live in tauri.conf.json; access is anonymous against the public repo and
/// only happens when the user explicitly asks.
#[tauri::command]
async fn check_app_update(app: AppHandle) -> Result<serde_json::Value, String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|error| error.to_string())?;
    let update = updater.check().await.map_err(|error| error.to_string())?;
    match update {
        Some(update) => Ok(serde_json::json!({
            "update_available": true,
            "version": update.version,
            "current_version": update.current_version,
            "notes": update.body,
            "date": update.date.map(|value| value.to_string()),
        })),
        None => Ok(serde_json::json!({ "update_available": false })),
    }
}

/// Download, verify (minisign), and install the update, then restart. The
/// bundled sidecar is stopped first so the installer can replace its files
/// (Windows locks running executables); a failed install revives the sidecar
/// so the current session keeps its local backend.
#[tauri::command]
async fn install_app_update(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|error| error.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "already up to date".to_string())?;
    stop_sidecar(&app);
    if let Err(error) = update.download_and_install(|_, _| {}, || {}).await {
        revive_sidecar(&app);
        return Err(format!("install update: {error}"));
    }
    app.restart()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            watchlist::load_watchlist,
            watchlist::save_watchlist,
            alerts::load_alerts,
            alerts::save_alerts,
            sidecar_url,
            check_app_update,
            install_app_update
        ])
        .setup(|app| {
            let data_dir = app.path().app_data_dir().map_err(|error| {
                Box::<dyn std::error::Error>::from(format!("resolve app data directory: {error}"))
            })?;
            std::fs::create_dir_all(&data_dir).map_err(|error| {
                Box::<dyn std::error::Error>::from(format!("create app data directory: {error}"))
            })?;
            let sidecar_port = reserve_loopback_port().map_err(|error| {
                Box::<dyn std::error::Error>::from(format!("reserve sidecar port: {error}"))
            })?;
            app.manage(SidecarConfig {
                data_dir,
                port: sidecar_port,
            });
            app.manage(SidecarPort(sidecar_port));
            let child = spawn_sidecar(app.handle()).map_err(|error| {
                Box::<dyn std::error::Error>::from(error)
            })?;
            app.manage(SidecarProcess(Mutex::new(Some(child))));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(process) = window.app_handle().try_state::<SidecarProcess>() {
                    if let Ok(mut child) = process.0.lock() {
                        if let Some(child) = child.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running TW Quant Research");
}
