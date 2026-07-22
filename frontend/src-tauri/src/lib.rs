use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const SIDECAR_NAME: &str = "tqe-sidecar";

mod alerts;
mod watchlist;

struct SidecarProcess(Mutex<Option<CommandChild>>);

struct SidecarPort(u16);

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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            watchlist::load_watchlist,
            watchlist::save_watchlist,
            alerts::load_alerts,
            alerts::save_alerts,
            sidecar_url
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
            let command = app.shell().sidecar(SIDECAR_NAME).map_err(|error| {
                Box::<dyn std::error::Error>::from(format!("resolve sidecar: {error}"))
            })?
                .env("TQE_DATA_DIR", data_dir.to_string_lossy().to_string())
                .env("TQE_SIDECAR_PORT", sidecar_port.to_string());
            let (mut events, child) = command.spawn().map_err(|error| {
                Box::<dyn std::error::Error>::from(format!("spawn sidecar: {error}"))
            })?;
            app.manage(SidecarProcess(Mutex::new(Some(child))));
            app.manage(SidecarPort(sidecar_port));
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
