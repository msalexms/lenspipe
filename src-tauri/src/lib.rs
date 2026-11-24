use serde::Deserialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, Url, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{process::CommandEvent, process::CommandChild, ShellExt};

/// The server must print `LENSPIPE_READY` within this time, or the start is reported as failed.
const READY_TIMEOUT: Duration = Duration::from_secs(45);
/// A server that crashes after it was ready is restarted, unless it already crashed this often recently.
const MAX_RESTARTS: usize = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(120);
/// Last stderr lines shown on the error screen.
const STDERR_LINES: usize = 12;

/// The bundled Node server (sidecar) and its supervision state.
#[derive(Default)]
struct Sidecar {
    child: Mutex<Option<CommandChild>>,
    /// Bumped on every spawn, so events from an older (killed) process are ignored.
    generation: AtomicU64,
    ready: AtomicBool,
    quitting: AtomicBool,
    crashes: Mutex<Vec<Instant>>,
    stderr: Mutex<VecDeque<String>>,
    timed_out: AtomicBool,
}

#[derive(Clone)]
struct ServerUrls {
    studio_url: String,
    obs_url: String,
}

#[derive(Default)]
struct ServerState(Mutex<Option<ServerUrls>>);

/// The bundled splash page (`frontendDist`), shown again for restarts and the error screen.
/// Tauri serves app assets from this origin; the window's own URL is still about:blank during setup.
#[cfg(windows)]
const SPLASH_URL: &str = "http://tauri.localhost/index.html";
#[cfg(not(windows))]
const SPLASH_URL: &str = "tauri://localhost/index.html";

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
    if let Ok(mut guard) = app.state::<Sidecar>().child.lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
}

fn quit(app: &AppHandle) {
    app.state::<Sidecar>().quitting.store(true, Ordering::SeqCst);
    kill_sidecar(app);
    app.exit(0);
}

/// Shows the splash page again: plain ("Starting…"), or as an error screen with a Retry button.
fn show_splash(app: &AppHandle, error: Option<(&str, &str)>) {
    let Ok(mut url) = Url::parse(SPLASH_URL) else {
        return;
    };
    if let Some((message, details)) = error {
        url.query_pairs_mut()
            .append_pair("error", message)
            .append_pair("details", details);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.navigate(url);
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

/// Starts the server sidecar and supervises it: navigates to the studio once it is ready, restarts it
/// after a crash, and shows the error screen when it cannot start.
fn start_server(app: &AppHandle) -> Result<(), String> {
    let sidecar = app.state::<Sidecar>();
    // Bump first, so the Terminated event of the process killed below is ignored.
    let generation = sidecar.generation.fetch_add(1, Ordering::SeqCst) + 1;
    kill_sidecar(app);
    sidecar.ready.store(false, Ordering::SeqCst);
    sidecar.timed_out.store(false, Ordering::SeqCst);
    if let Ok(mut lines) = sidecar.stderr.lock() {
        lines.clear();
    }
    if let Ok(mut urls) = app.state::<ServerState>().0.lock() {
        *urls = None;
    }

    let mut command = app
        .shell()
        .sidecar("lenspipe-server")
        .map_err(|error| error.to_string())?
        .env("LENSPIPE_DESKTOP", "1")
        .env("LENSPIPE_LOCAL_HTTP", "1")
        .env("LENSPIPE_PARENT_WATCH", "1")
        .env("LOG_LEVEL", "warn")
        // Hides Node's single-executable notice, which would bury real errors on the error screen.
        .env("NODE_NO_WARNINGS", "1");
    if let Some(dist_dir) = resolve_dist_dir(app) {
        command = command.env("LENSPIPE_DIST_DIR", dist_dir.to_string_lossy().as_ref());
    }
    let (mut rx, child) = command.spawn().map_err(|error| error.to_string())?;
    if let Ok(mut guard) = sidecar.child.lock() {
        *guard = Some(child);
    }

    // Startup watchdog: a server that never reports ready is killed and reported.
    let watchdog = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(READY_TIMEOUT);
        let sidecar = watchdog.state::<Sidecar>();
        if sidecar.generation.load(Ordering::SeqCst) == generation && !sidecar.ready.load(Ordering::SeqCst) {
            sidecar.timed_out.store(true, Ordering::SeqCst);
            kill_sidecar(&watchdog);
        }
    });

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut stdout_buf = String::new();
        let mut stderr_buf = String::new();
        while let Some(event) = rx.recv().await {
            let sidecar = handle.state::<Sidecar>();
            if sidecar.generation.load(Ordering::SeqCst) != generation {
                return; // a newer server replaced this one
            }
            match event {
                CommandEvent::Stdout(bytes) => {
                    stdout_buf.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(pos) = stdout_buf.find('\n') {
                        let line = stdout_buf[..pos].trim().to_string();
                        stdout_buf.drain(..=pos);
                        if let Some(json) = line.strip_prefix("LENSPIPE_READY ") {
                            on_ready(&handle, json);
                        } else if !line.is_empty() {
                            println!("{line}");
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    eprint!("{text}");
                    stderr_buf.push_str(&text);
                    while let Some(pos) = stderr_buf.find('\n') {
                        let line = stderr_buf[..pos].trim_end().to_string();
                        stderr_buf.drain(..=pos);
                        if line.is_empty() {
                            continue;
                        }
                        if let Ok(mut lines) = sidecar.stderr.lock() {
                            if lines.len() == STDERR_LINES {
                                lines.pop_front();
                            }
                            lines.push_back(line);
                        }
                    }
                }
                CommandEvent::Terminated(payload) => {
                    on_terminated(&handle, payload.code);
                    return;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn on_ready(app: &AppHandle, json: &str) {
    let Ok(payload) = serde_json::from_str::<ReadyPayload>(json) else {
        return;
    };
    app.state::<Sidecar>().ready.store(true, Ordering::SeqCst);
    let obs_url = payload
        .obs_url
        .clone()
        .unwrap_or_else(|| payload.url.replace("/control", "/obs"));
    if let Ok(mut guard) = app.state::<ServerState>().0.lock() {
        *guard = Some(ServerUrls {
            studio_url: payload.url.clone(),
            obs_url,
        });
    }
    if let (Some(window), Ok(target)) = (app.get_webview_window("main"), Url::parse(&payload.url)) {
        let _ = window.navigate(target);
    }
}

fn on_terminated(app: &AppHandle, code: Option<i32>) {
    let sidecar = app.state::<Sidecar>();
    if let Ok(mut guard) = sidecar.child.lock() {
        guard.take();
    }
    if let Ok(mut urls) = app.state::<ServerState>().0.lock() {
        *urls = None;
    }
    if sidecar.quitting.load(Ordering::SeqCst) {
        return;
    }

    let was_ready = sidecar.ready.load(Ordering::SeqCst);
    if was_ready {
        let recent = sidecar
            .crashes
            .lock()
            .map(|mut crashes| {
                crashes.retain(|time| time.elapsed() < RESTART_WINDOW);
                crashes.push(Instant::now());
                crashes.len()
            })
            .unwrap_or(usize::MAX);
        if recent <= MAX_RESTARTS {
            eprintln!("LensPipe server stopped (code {code:?}); restarting ({recent}/{MAX_RESTARTS}).");
            show_splash(app, None);
            let handle = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(1));
                if let Err(error) = start_server(&handle) {
                    show_splash(&handle, Some(("LensPipe could not restart its server.", &error)));
                }
            });
            return;
        }
    }

    let message = if sidecar.timed_out.load(Ordering::SeqCst) {
        format!("LensPipe's server did not start within {} seconds.", READY_TIMEOUT.as_secs())
    } else if was_ready {
        "LensPipe's server keeps stopping.".to_string()
    } else {
        match code {
            Some(code) => format!("LensPipe's server could not start (exit code {code})."),
            None => "LensPipe's server could not start.".to_string(),
        }
    };
    let details = sidecar
        .stderr
        .lock()
        .map(|lines| lines.iter().cloned().collect::<Vec<_>>().join("\n"))
        .unwrap_or_default();
    show_splash(app, Some((&message, &details)));
    show_main_window(app);
}

/// Called by the error screen's Retry button.
#[tauri::command]
fn restart_server(app: AppHandle) -> Result<(), String> {
    if let Ok(mut crashes) = app.state::<Sidecar>().crashes.lock() {
        crashes.clear();
    }
    start_server(&app)
}

/// The first time the window is closed, explain that LensPipe keeps running in the tray.
fn notify_tray_once(app: &AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let marker = dir.join("tray-notice-shown");
    if marker.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&marker, b"1");
    let _ = app
        .notification()
        .builder()
        .title("LensPipe is still running")
        .body("The camera stays available to OBS. Use Quit LensPipe in the tray menu to stop it.")
        .show();
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
        .plugin(tauri_plugin_notification::init())
        .manage(Sidecar::default())
        .manage(ServerState::default())
        .invoke_handler(tauri::generate_handler![restart_server])
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
                &[&open_item, &browser_item, &obs_item, &separator, &quit_item],
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
                    "quit" => quit(app),
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

            if let Err(error) = start_server(app.handle()) {
                show_splash(app.handle(), Some(("LensPipe could not start its server.", &error)));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                notify_tray_once(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building LensPipe");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            app_handle.state::<Sidecar>().quitting.store(true, Ordering::SeqCst);
            kill_sidecar(app_handle);
        }
    });
}
