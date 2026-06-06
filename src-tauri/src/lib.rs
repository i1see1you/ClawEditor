mod virbius_gate;

use virbius_gate::{
    virbius_configure, virbius_default_data_dir, virbius_gate_inbound, virbius_gate_outbound,
    virbius_reload,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            virbius_configure,
            virbius_default_data_dir,
            virbius_gate_outbound,
            virbius_gate_inbound,
            virbius_reload,
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
