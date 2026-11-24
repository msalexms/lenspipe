use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

struct SidecarState(Mutex<Option<CommandChild>>);

#[derive(Clone)]
struct ServerUrls {
    studio_url: String,
    obs_url: String,
}

struct ServerState(Mutex<Option<ServerUrls>>);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyPayload {
    url: String,
    obs_url: Option<String>,
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn kill_sidecar(app: &AppHandle) {
    if let Ok(mut guard) = app.state::<SidecarState>().0.lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
}

fn resolve_dist_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res_dir) = app.path().resource_dir() {
        candidates.push(res_dir.join("web"));
        candidates.push(res_dir.join("web").join("dist"));
        candidates.push(res_dir.join("dist"));
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join("web"));
            candidates.push(exe_dir.join("dist"));
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist"));
    candidates
        .into_iter()
        .find(|dir| dir.join("control.html").is_file())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }));
    }

    let app = builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(SidecarState(Mutex::new(None)))
        .manage(ServerState(Mutex::new(None)))
        .setup(|app| {
            let open_item =
                MenuItem::with_id(app, "open", "Open LensPipe Studio", true, None::<&str>)?;
            let browser_item = MenuItem::with_id(
                app,
                "open_browser",
                "Open Studio in Browser",
                true,
                None::<&str>,
            )?;
            let obs_item =
                MenuItem::with_id(app, "open_obs", "Open OBS Preview", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit LensPipe", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[
                    &open_item,
                    &browser_item,
                    &obs_item,
                    &separator,
                    &quit_item,
                ],
            )?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&tray_menu)
                .tooltip("LensPipe — Studio Camera")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main_window(app),
                    "open_browser" | "open_obs" => {
                        let url = app.state::<ServerState>().0.lock().ok().and_then(|guard| {
                            guard.as_ref().map(|urls| match event.id().as_ref() {
                                "open_obs" => urls.obs_url.clone(),
                                _ => urls.studio_url.clone(),
                            })
                        });
                        if let Some(target) = url {
                            let _ = app.opener().open_url(target, None::<&str>);
                        }
                    }
                    "quit" => {
                        kill_sidecar(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            tray_builder.build(app)?;

            let mut sidecar_cmd = app
                .shell()
                .sidecar("lenspipe-server")?
                .env("LENSPIPE_DESKTOP", "1")
                .env("LENSPIPE_LOCAL_HTTP", "1")
                .env("LENSPIPE_PARENT_WATCH", "1")
                .env("LOG_LEVEL", "warn");

            if let Some(dist_dir) = resolve_dist_dir(app.handle()) {
                sidecar_cmd =
                    sidecar_cmd.env("LENSPIPE_DIST_DIR", dist_dir.to_string_lossy().as_ref());
            }

            let (mut rx, child) = sidecar_cmd.spawn()?;
            if let Ok(mut guard) = app.state::<SidecarState>().0.lock() {
                *guard = Some(child);
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut stdout_buf = String::new();
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            stdout_buf.push_str(&String::from_utf8_lossy(&bytes));
                            while let Some(pos) = stdout_buf.find('\n') {
                                let line = stdout_buf[..pos].trim().to_string();
                                stdout_buf.drain(..=pos);
                                if let Some(json) = line.strip_prefix("LENSPIPE_READY ") {
                                    if let Ok(payload) = serde_json::from_str::<ReadyPayload>(json)
                                    {
                                        let obs_url = payload
                                            .obs_url
                                            .clone()
                                            .unwrap_or_else(|| payload.url.replace("/control", "/obs"));
                                        if let Ok(mut guard) =
                                            handle.state::<ServerState>().0.lock()
                                        {
                                            *guard = Some(ServerUrls {
                                                studio_url: payload.url.clone(),
                                                obs_url,
                                            });
                                        }
                                        if let (Some(window), Ok(target)) = (
                                            handle.get_webview_window("main"),
                                            tauri::Url::parse(&payload.url),
                                        ) {
                                            let _ = window.navigate(target);
                                        }
                                    }
                                } else if !line.is_empty() {
                                    println!("{line}");
                                }
                            }
                        }
                        CommandEvent::Stderr(bytes) => {
                            eprint!("{}", String::from_utf8_lossy(&bytes));
                        }
                        CommandEvent::Terminated(_) => break,
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building LensPipe");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            kill_sidecar(app_handle);
        }
    });
}
