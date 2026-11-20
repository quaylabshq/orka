use super::*;

const ROOT: &str = "/work/app";
const ORKA: &str = "'/Applications/Orka.app/Contents/MacOS/portable-workspace-mac' --profile 'default' --orka-hook codex";

/// A `hooks/list` hook entry shaped like Codex 0.171's response.
fn hook(event: &str, trust: &str, command: &str, source_path: &str) -> Value {
    json!({
        "key": format!("{source_path}:{event}:0:0"),
        "eventName": event,
        "source": if source_path.starts_with("/home") { "user" } else { "project" },
        "sourcePath": source_path,
        "handlerType": "command",
        "command": command,
        "enabled": true,
        "trustStatus": trust,
        "currentHash": "sha256:abc",
    })
}
fn orka(trust: &str) -> Vec<Value> {
    ["sessionStart", "userPromptSubmit", "stop", "sessionEnd"]
        .into_iter()
        .map(|event| hook(event, trust, ORKA, &format!("{ROOT}/.codex/hooks.json")))
        .collect()
}
fn listed(hooks: Vec<Value>) -> Value {
    json!({"data":[{"cwd":ROOT,"hooks":hooks,"warnings":[],"errors":[]}]})
}
fn check(hooks: Vec<Value>, config: Value) -> Trust {
    classify(Path::new(ROOT), &listed(hooks), &config)
}

#[test]
fn trusted_only_when_every_orka_hook_is_approved() {
    assert_eq!(check(orka("trusted"), json!({})), Trust::Trusted);
    assert_eq!(check(orka("managed"), json!({})), Trust::Trusted);
    let mut mixed = orka("trusted");
    mixed[2]["trustStatus"] = json!("untrusted");
    assert_eq!(check(mixed, json!({})), Trust::HooksNotApproved);
    let mut duplicate = orka("trusted");
    duplicate.push(hook(
        "stop",
        "untrusted",
        ORKA,
        &format!("{ROOT}/.codex/hooks.json"),
    ));
    assert_eq!(check(duplicate, json!({})), Trust::HooksNotApproved);
    let mut missing = orka("trusted");
    missing.pop();
    assert!(matches!(check(missing, json!({})), Trust::Unknown(_)));
    let mut changed = orka("trusted");
    changed[0]["trustStatus"] = json!("modified");
    assert_eq!(check(changed, json!({})), Trust::HooksChanged);
}

#[test]
fn a_folder_codex_skips_reports_why() {
    // An untrusted project layer is absent from hooks/list entirely.
    let user = vec![hook(
        "sessionStart",
        "trusted",
        "/home/me/hook",
        "/home/me/.codex/hooks.json",
    )];
    assert_eq!(check(user.clone(), json!({})), Trust::FolderNotTrusted);
    let untrusted = json!({"projects":{ROOT:{"trust_level":"untrusted"}}});
    assert_eq!(check(user.clone(), untrusted), Trust::FolderUntrusted);
    // A parent entry (for example the repository root) covers subfolders.
    let parent = json!({"projects":{"/work":{"trust_level":"untrusted"}}});
    assert_eq!(check(user.clone(), parent), Trust::FolderUntrusted);
    // The folder's own entry wins over its parent's.
    let own =
        json!({"projects":{"/work":{"trust_level":"untrusted"},ROOT:{"trust_level":"trusted"}}});
    assert!(matches!(check(user, own), Trust::Unknown(_)));
}

#[test]
fn a_symlink_to_a_nested_source_does_not_hide_its_real_parent() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo").join("nested");
    let folder = repo.join("source");
    std::fs::create_dir_all(&folder).unwrap();
    let alias = tmp.path().join("alias");
    std::os::unix::fs::symlink(&folder, &alias).unwrap();
    let repo_key = format!("{}/", repo.display());
    let config = json!({"projects":{repo_key:{"trust_level":"untrusted"}}});
    let listed = json!({"data":[{"cwd":folder,"hooks":[]}]});
    assert_eq!(classify(&alias, &listed, &config), Trust::FolderUntrusted);
}

#[test]
fn hooks_turned_off_in_codex_are_reported_as_disabled() {
    let off = json!({"features":{"hooks":false}});
    assert_eq!(check(orka("trusted"), off), Trust::HooksDisabled);
    let mut disabled = orka("trusted");
    disabled[1]["enabled"] = json!(false);
    assert_eq!(check(disabled, json!({})), Trust::HooksDisabled);
    let on = json!({"features":{"hooks":true}});
    assert_eq!(check(orka("trusted"), on), Trust::Trusted);
}

#[test]
fn only_orka_hooks_from_this_folder_count() {
    // A user's own project hook and another folder's Orka hooks don't count.
    let foreign = vec![
        hook(
            "sessionStart",
            "trusted",
            "/bin/echo",
            &format!("{ROOT}/.codex/hooks.json"),
        ),
        hook(
            "sessionStart",
            "trusted",
            ORKA,
            "/work/other/.codex/hooks.json",
        ),
    ];
    assert_eq!(check(foreign, json!({})), Trust::FolderNotTrusted);
    // Hooks from older Orka builds and other profiles are still Orka's.
    let legacy =
        "'/Applications/Orka.app/Contents/MacOS/portable-workspace-mac' --workspace-hook codex";
    let old = vec![hook(
        "sessionStart",
        "untrusted",
        legacy,
        &format!("{ROOT}/.codex/hooks.json"),
    )];
    assert_eq!(check(old, json!({})), Trust::HooksNotApproved);
}

#[test]
fn missing_or_unrecognized_answers_stay_unknown() {
    let none = classify(
        Path::new("/work/elsewhere"),
        &listed(orka("trusted")),
        &json!({}),
    );
    assert!(matches!(none, Trust::Unknown(_)));
    let mut failed = listed(Vec::new());
    failed["data"][0]["errors"] = json!(["Cannot load hooks"]);
    assert!(matches!(
        classify(Path::new(ROOT), &failed, &json!({})),
        Trust::Unknown(_)
    ));
    let mut odd = orka("trusted");
    odd[0]["trustStatus"] = json!("pending-review");
    assert!(matches!(check(odd, json!({})), Trust::Unknown(_)));
    assert!(matches!(
        classify(Path::new(ROOT), &json!({}), &json!({})),
        Trust::Unknown(_)
    ));
}
