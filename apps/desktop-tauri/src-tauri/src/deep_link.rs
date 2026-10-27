use tauri::{AppHandle, Emitter};
use tauri_plugin_deep_link::DeepLinkExt;

pub fn setup(app: &AppHandle) -> Result<(), String> {
    if let Some(urls) = app.deep_link().get_current().map_err(|e| e.to_string())? {
        let urls: Vec<String> = urls.into_iter().map(|url| url.to_string()).collect();
        let _ = app.emit("xdot://deep-link", &urls);
    }

    let handle = app.clone();
    let _listener = app.deep_link().on_open_url(move |event| {
        let urls: Vec<String> = event.urls().iter().map(ToString::to_string).collect();
        let _ = handle.emit("xdot://deep-link", &urls);
    });

    #[cfg(any(windows, target_os = "linux"))]
    app.deep_link().register_all().map_err(|e| e.to_string())?;

    Ok(())
}
