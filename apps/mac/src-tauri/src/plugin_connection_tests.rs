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
fn plugin_proof_requires_live_matching_grant_and_explicit_write_scope() {
    let f = Fixture::new();
    db::set(&f.db, "config", &json!({"apiUrl":"https://plugin.example"})).unwrap();
    let binding = Binding::current().unwrap();
    let proof = json!({"connectionId":Uuid::new_v4().to_string(),"accountId":binding.account_id,
        "serviceOrigin":binding.service_origin,"deviceId":binding.device_id,"generation":binding.generation,
        "scopes":["orka.read"],"expiresAt":"2100-01-01T00:00:00Z"});
    assert!(plugin_connection::validate_proof_for_test(&proof, &binding, false).is_ok());
    let mut canonical = proof.clone();
    canonical["serviceOrigin"] = json!("https://PLUGIN.example/");
    assert!(plugin_connection::validate_proof_for_test(&canonical, &binding, false).is_ok());
    assert!(
        plugin_connection::validate_proof_for_test(&proof, &binding, true)
            .unwrap_err()
            .contains("required read and write")
    );
    let mut write = proof.clone();
    write["scopes"] = json!(["orka.read", "orka.write"]);
    assert!(plugin_connection::validate_proof_for_test(&write, &binding, true).is_ok());
    for (key, value) in [
        ("accountId", json!(Uuid::new_v4().to_string())),
        ("serviceOrigin", json!("https://other.example")),
        ("deviceId", json!(Uuid::new_v4().to_string())),
        ("generation", json!(Uuid::new_v4().to_string())),
        ("connectionId", json!("invalid")),
        ("expiresAt", json!("2000-01-01T00:00:00Z")),
        ("scopes", json!([])),
    ] {
        let mut invalid = proof.clone();
        invalid[key] = value;
        assert!(
            plugin_connection::validate_proof_for_test(&invalid, &binding, false).is_err(),
            "{key}"
        );
    }
    binding.check_current().unwrap();
    plugin_connection::invalidate("Test sign out").unwrap();
    assert_eq!(
        binding.check_current().unwrap_err(),
        plugin_connection::RECONNECT
    );
    // A fresh explicit connection can use the same still-running native process.
    Binding::current().unwrap().check_current().unwrap();
}

#[test]
fn plugin_handoff_callback_cannot_redirect_native_credentials_or_escape_profiles() {
    let _f = Fixture::new();
    let valid = format!(
        "orka://mcp/authorize?handoff={}&service=https%3A%2F%2Fapi.example&profile=alice",
        "a".repeat(43)
    );
    assert_eq!(
        plugin_connection::callback(&valid).unwrap(),
        ("alice".into(), "a".repeat(43), "https://api.example".into())
    );
    for invalid in [
        valid.replace("orka://", "https://"),
        valid.replace("/authorize?", "/other?"),
        format!("{valid}&handoff={}", "b".repeat(43)),
        format!("{valid}&service=https://other.example"),
        format!("{valid}&profile=bob"),
        format!("{valid}&access_token=secret"),
        format!("{valid}#secret"),
        valid.replace("profile=alice", "profile=../default"),
        valid.replace("https%3A%2F%2Fapi.example", "http%3A%2F%2Fevil.example"),
        valid.replace(&"a".repeat(43), "short"),
        valid.replace("mcp/", "user:secret@mcp/"),
    ] {
        assert!(plugin_connection::callback(&invalid).is_err(), "{invalid}");
    }
    let routed = valid.replace("profile=alice", "profile=default");
    crate::profiles::route_plugin_callback(routed.clone()).unwrap();
    assert_eq!(crate::profiles::take_callback().unwrap(), Some(routed));
    assert_eq!(crate::profiles::take_callback().unwrap(), None);
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
