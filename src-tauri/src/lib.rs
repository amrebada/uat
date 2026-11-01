mod collections;
mod demo;
mod docker;
mod flows;
mod mcp;
mod networks;
mod process;
mod share;
mod trace;

use tauri::RunEvent;

/// `app mcp`: MCP over stdio for AI agents, instead of the window
pub fn mcp_stdio() {
    mcp::stdio()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(process::Processes::default())
        .manage(mcp::Mcp::default())
        .setup(|app| {
            process::load(app.handle());
            mcp::setup(app.handle());
            // Nothing runs yet, so proxies and sidecars left from the last session are stale
            tauri::async_runtime::spawn(async {
                let _ = docker::remove_proxies(None).await;
                let _ = trace::remove_sniffers().await;
            });
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            docker::docker_status,
            docker::docker_networks,
            docker::docker_create_network,
            docker::docker_services,
            docker::docker_other_containers,
            docker::docker_add_service,
            docker::docker_attach,
            docker::docker_start,
            docker::docker_stop,
            docker::docker_remove,
            docker::docker_logs,
            docker::docker_inspect_dockerfile,
            networks::docker_network_plan,
            networks::docker_remove_network,
            share::network_snapshot,
            share::images_here,
            share::git_info,
            share::find_repos,
            share::ports_in_use,
            share::git_clone,
            share::share_read,
            share::share_write,
            collections::workspace_load,
            collections::workspace_save,
            collections::workspace_path,
            process::process_list,
            process::process_create,
            process::process_update,
            process::process_delete,
            process::process_start,
            process::process_stop,
            process::process_restart,
            process::process_logs,
            process::process_clear_logs,
            process::process_inspect_folder,
            trace::trace_prepare,
            trace::trace_query,
            trace::trace_logs,
            trace::trace_warm,
            demo::demo_start,
            flows::flows_load,
            flows::flows_save,
            flows::flow_write_sheet,
            flows::flow_write_report,
            flows::flow_open,
            mcp::mcp_register,
            mcp::mcp_reply,
            mcp::mcp_status,
            mcp::mcp_set_enabled,
            mcp::mcp_clients,
            mcp::mcp_install,
            mcp::mcp_uninstall,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                process::kill_all(app);
                trace::stop_all();
            }
        });
}
