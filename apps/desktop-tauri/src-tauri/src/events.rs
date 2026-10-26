use rakazo_core::Event;
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;

/// Forward native runtime lifecycle events to the Tauri webview.
///
/// The core remains unaware of Tauri. Events are serialized at the shell
/// boundary and delivered on the `rakazo://runtime-event` channel.
pub fn forward(app: AppHandle, mut receiver: broadcast::Receiver<Event>) {
    tauri::async_runtime::spawn(async move {
        loop {
            match receiver.recv().await {
                Ok(event) => {
                    if app.emit("rakazo://runtime-event", &event).is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}
