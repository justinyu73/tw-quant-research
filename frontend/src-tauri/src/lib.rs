use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const SIDECAR_NAME: &str = "tqe-sidecar";

mod watchlist;

struct SidecarProcess(Mutex<Option<CommandChild>>);

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            watchlist::load_watchlist,
            watchlist::save_watchlist
        ])
        .setup(|app| {
            let command = app.shell().sidecar(SIDECAR_NAME).map_err(|error| {
                Box::<dyn std::error::Error>::from(format!("resolve sidecar: {error}"))
            })?;
            let (mut events, child) = command.spawn().map_err(|error| {
                Box::<dyn std::error::Error>::from(format!("spawn sidecar: {error}"))
            })?;
            app.manage(SidecarProcess(Mutex::new(Some(child))));
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
