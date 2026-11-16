use super::*;
use crate::plugin_connection::{self, Binding};
use uuid::Uuid;

#[test]
fn plugin_generation_survives_restarts_and_invalidates_account_and_service_roundtrips() {
    let f = Fixture::new();
    let first = plugin_connection::generation().unwrap();
    assert_eq!(first, plugin_connection::generation().unwrap());
    db::set(
        &f.db,
        "config",
        &json!({"apiUrl":"https://first.example","syncMinutes":15}),
    )
    .unwrap();
    let initial = plugin_connection::generation().unwrap();
    assert_ne!(first, initial);
    db::set(
        &f.db,
        "config",
        &json!({"apiUrl":"https://first.example","syncMinutes":30}),
    )
    .unwrap();
    assert_eq!(initial, plugin_connection::generation().unwrap());
    db::set(&f.db, "config", &json!({"apiUrl":"https://second.example"})).unwrap();
    db::set(&f.db, "config", &json!({"apiUrl":"https://first.example"})).unwrap();
    assert_ne!(initial, plugin_connection::generation().unwrap());
    let a = Uuid::new_v4().to_string();
    let b = Uuid::new_v4().to_string();
    db::profile(&a).unwrap();
    let selected = plugin_connection::generation().unwrap();
    db::profile(&a).unwrap();
    assert_eq!(selected, plugin_connection::generation().unwrap());
    db::profile(&b).unwrap();
    db::profile(&a).unwrap();
    assert_ne!(selected, plugin_connection::generation().unwrap());
    let current = plugin_connection::generation().unwrap();
    db::guest().unwrap();
    db::profile(&a).unwrap();
    assert_ne!(current, plugin_connection::generation().unwrap());
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(db::root().unwrap().join("plugin-connection.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn browser_plugin_handoffs_cannot_grant_desktop_access() {
    let _f = Fixture::new();
    let callback="orka://mcp/authorize?handoff=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&service=https://api.example";
    assert!(plugin_connection::callback(callback)
        .unwrap_err()
        .contains("no longer supported"));
    assert!(crate::profiles::route_plugin_callback(callback.into()).is_err());
}

#[test]
fn connector_transport_rejects_unregistered_secrets_and_unsafe_directories() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let _f = Fixture::new();
    let broker = crate::plugin_broker::start().unwrap();
    let directory = crate::plugin_broker::directory().unwrap();
    assert_eq!(
        fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(directory.join("broker.sock"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let request = json!({"version":1,"sessionId":Uuid::new_v4().to_string(),"secret":"a".repeat(64),"operation":"call","name":"get_connection_status","arguments":{}});
    assert!(crate::plugin_broker::exchange(&request)
        .unwrap_err()
        .contains("Reconnect"));
    let mut invalid = request.clone();
    invalid["operation"] = json!("approve");
    assert!(crate::plugin_broker::exchange(&invalid)
        .unwrap_err()
        .contains("Unknown"));
    drop(broker);
    fs::remove_dir_all(&directory).unwrap();
    let other = _f._home.path().join("other");
    fs::create_dir(&other).unwrap();
    symlink(&other, &directory).unwrap();
    assert!(crate::plugin_broker::start().is_err());
    fs::remove_file(&directory).unwrap();
}

#[test]
fn plugin_operations_recheck_generation_inside_their_own_workspace_locks() {
    let f = Fixture::new();
    db::set(&f.db, "config", &json!({"apiUrl":"https://plugin.example"})).unwrap();
    let binding = Binding::current().unwrap();
    let request = json!({"accountId":binding.account_id,"serviceOrigin":binding.service_origin,"projectId":f.project["id"]});
    plugin_connection::invalidate("Test account changed after proof verification").unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for action in [
        "list_skills",
        "install_skill",
        "get_sync_status",
        "retry_sync",
        "repair_sync",
    ] {
        assert_eq!(
            runtime
                .block_on(crate::plugin_operations::command(
                    action,
                    &request,
                    Some(&binding)
                ))
                .unwrap_err(),
            plugin_connection::RECONNECT
        );
    }
    for action in ["list_local_resources", "preview_share", "share_selected"] {
        assert_eq!(
            runtime
                .block_on(crate::selective_sharing::plugin_command(
                    action, &request, &binding
                ))
                .unwrap_err(),
            plugin_connection::RECONNECT
        );
    }
    assert_eq!(
        runtime
            .block_on(sync::plugin_once_bound(
                &binding.account_id,
                &binding.service_origin,
                f.project["id"].as_str().unwrap(),
                Some(&binding)
            ))
            .unwrap_err(),
        plugin_connection::RECONNECT
    );
    assert!(f.outbox().is_empty());
    assert!(db::rows(&f.db, "SELECT value FROM local_resources", &[])
        .unwrap()
        .is_empty());
}

#[test]
fn connector_binding_rechecks_individual_revocation_inside_operation_locks() {
    let f = Fixture::new();
    db::set(&f.db, "config", &json!({"apiUrl":"https://plugin.example"})).unwrap();
    let mut binding = Binding::current().unwrap();
    let id = Uuid::new_v4().to_string();
    let path = db::root().unwrap().join("plugin-connection.json");
    let mut state: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    state["sessions"][&id] =
        json!({"state":"approved","binding":{"generation":binding.generation}});
    db::atomic(&path, state.to_string().as_bytes()).unwrap();
    binding.session_id = Some(id.clone());
    binding.check_current().unwrap();
    state["sessions"][&id]["state"] = json!("reconnect_required");
    db::atomic(&path, state.to_string().as_bytes()).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let input = json!({"accountId":binding.account_id,"serviceOrigin":binding.service_origin,"projectId":f.project["id"]});
    assert_eq!(
        runtime
            .block_on(crate::plugin_operations::command(
                "get_sync_status",
                &input,
                Some(&binding)
            ))
            .unwrap_err(),
        plugin_connection::RECONNECT
    );
    assert_eq!(
        runtime
            .block_on(crate::selective_sharing::plugin_command(
                "preview_share",
                &input,
                &binding
            ))
            .unwrap_err(),
        plugin_connection::RECONNECT
    );
    assert!(f.outbox().is_empty());
}

#[test]
fn connector_history_is_bounded_and_expired_pending_requests_require_reconnect() {
    let f = Fixture::new();
    db::set(&f.db, "config", &json!({"apiUrl":"https://plugin.example"})).unwrap();
    let generation = plugin_connection::generation().unwrap();
    let path = db::root().unwrap().join("plugin-connection.json");
    let mut state: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let first = Uuid::new_v4().to_string();
    for i in 0..512 {
        let id = if i == 0 {
            first.clone()
        } else {
            Uuid::new_v4().to_string()
        };
        state["sessions"][&id] = json!({"id":id,"state":"pending","createdAt":i,"expiresAt":"2000-01-01T00:00:00Z","binding":{"generation":generation}});
    }
    db::atomic(&path, state.to_string().as_bytes()).unwrap();
    let status = plugin_connection::plugin_connection_status().unwrap();
    assert_eq!(status["pendingCount"], 0);
    assert!(status["connections"]
        .as_array()
        .unwrap()
        .iter()
        .all(|v| v["state"] == "reconnect_required"));
    assert_eq!(
        plugin_connection::plugin_connection_requests().unwrap(),
        json!([])
    );
    plugin_connection::initialize_session(
        &Uuid::new_v4().to_string(),
        &"a".repeat(64),
        "A fresh connector",
    )
    .unwrap();
    let bounded: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(bounded["sessions"].as_object().unwrap().len(), 512);
    assert!(bounded["sessions"][first].is_null());
}
