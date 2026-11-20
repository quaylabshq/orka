//! Checks trust classification against a real Codex app server in an isolated
//! CODEX_HOME. Run with `cargo test -- --ignored codex_trust_live`, optionally
//! choosing the binary with ORKA_TEST_CODEX_BINARY.
use super::*;
use crate::codex_trust::{self, Report, Trust};

fn inspect(f: &Fixture) -> Trust {
    match codex_trust::inspect(std::slice::from_ref(&f.root)) {
        Report::Folders(mut folders) => folders.remove(0).1,
        other => panic!("Codex did not answer: {other:?}"),
    }
}

/// Approves every Orka hook Codex lists for the folder, as `/hooks` would.
fn approve(f: &Fixture, config: &Path) {
    let mut rpc = native::Rpc::connect().unwrap();
    let listed = rpc.call("hooks/list", json!({"cwds":[f.root]})).unwrap();
    let mut toml = fs::read_to_string(config).unwrap();
    for hook in listed["data"][0]["hooks"].as_array().unwrap() {
        if hook["source"] == "project" {
            toml.push_str(&format!(
                "\n[hooks.state.{}]\ntrusted_hash = {}\n",
                hook["key"], hook["currentHash"]
            ));
        }
    }
    fs::write(config, toml).unwrap();
}

#[test]
#[ignore = "requires installed Codex with hooks/list; isolated CODEX_HOME"]
fn codex_trust_live_matches_what_codex_will_run() {
    let f = Fixture::new();
    f.select_codex_binary();
    native::Hooks::install(&f.root).unwrap();
    let home = native::codex_home().unwrap();
    fs::create_dir_all(&home).unwrap();
    let config = home.join("config.toml");
    let root = f.root.canonicalize().unwrap();
    fs::write(&config, "").unwrap();
    assert_eq!(inspect(&f), Trust::FolderNotTrusted);
    let trusted = format!("[projects.{:?}]\ntrust_level = \"trusted\"\n", root);
    fs::write(&config, &trusted).unwrap();
    assert_eq!(inspect(&f), Trust::HooksNotApproved);
    approve(&f, &config);
    assert_eq!(inspect(&f), Trust::Trusted);
    // A changed hook command (for example a moved Orka.app) needs re-approval.
    let hooks = f.root.join(".codex/hooks.json");
    let text = fs::read_to_string(&hooks).unwrap();
    fs::write(&hooks, text.replace("--profile", "--profile  ")).unwrap();
    assert_eq!(inspect(&f), Trust::HooksChanged);
    fs::write(&hooks, text).unwrap();
    let approved = fs::read_to_string(&config).unwrap();
    fs::write(&config, approved.replace("\"trusted\"", "\"untrusted\"")).unwrap();
    assert_eq!(inspect(&f), Trust::FolderUntrusted);
    fs::write(&config, format!("[features]\nhooks = false\n\n{approved}")).unwrap();
    assert_eq!(inspect(&f), Trust::HooksDisabled);
}

#[test]
#[ignore = "requires installed Codex with hooks/list; isolated CODEX_HOME"]
fn codex_trust_live_trust_action_approves_only_orka_and_keeps_user_config() {
    let f = Fixture::new();
    f.select_codex_binary();
    native::Hooks::install(&f.root).unwrap();
    // A user's own hook in the same file must stay unapproved.
    let hooks = f.root.join(".codex/hooks.json");
    let mut file: Value = serde_json::from_slice(&fs::read(&hooks).unwrap()).unwrap();
    file["hooks"]["Stop"]
        .as_array_mut()
        .unwrap()
        .push(json!({"hooks":[{"type":"command","command":"/bin/echo mine"}]}));
    fs::write(&hooks, serde_json::to_vec_pretty(&file).unwrap()).unwrap();
    let home = native::codex_home().unwrap();
    fs::create_dir_all(&home).unwrap();
    let config = home.join("config.toml");
    let before = "# my settings\nmodel = \"gpt-5\"\n\n[projects.\"/elsewhere\"]\ntrust_level = \"trusted\"\n";
    fs::write(&config, before).unwrap();
    let project = f.project["id"].as_str().unwrap();
    let status = codex_trust::project_status(&f.db, project).unwrap();
    assert_eq!(status["folders"][0]["state"], "folder-not-trusted");
    let result = codex_trust::trust(&f.db, project, project).unwrap();
    assert_eq!(result["state"], "trusted", "{result}");
    let after = fs::read_to_string(&config).unwrap();
    assert!(after.contains("# my settings") && after.contains("model = \"gpt-5\""));
    assert!(after.contains("\"/elsewhere\""));
    assert_eq!(after.matches("trusted_hash").count(), 4, "{after}");
    let mut rpc = native::Rpc::connect().unwrap();
    let listed = rpc.call("hooks/list", json!({"cwds":[f.root]})).unwrap();
    let mine: Vec<_> = listed["data"][0]["hooks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|hook| hook["command"] == "/bin/echo mine")
        .collect();
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0]["trustStatus"], "untrusted");
    // Running it again is a no-op.
    assert_eq!(
        codex_trust::trust(&f.db, project, project).unwrap()["state"],
        "trusted"
    );
    assert_eq!(fs::read_to_string(&config).unwrap(), after);
    // An explicitly untrusted folder is refused and left alone.
    let untrusted = after.replace(
        &format!(
            "{:?}]\ntrust_level = \"trusted\"",
            f.root.canonicalize().unwrap()
        ),
        &format!(
            "{:?}]\ntrust_level = \"untrusted\"",
            f.root.canonicalize().unwrap()
        ),
    );
    assert_ne!(untrusted, after);
    fs::write(&config, &untrusted).unwrap();
    let error = codex_trust::trust(&f.db, project, project).unwrap_err();
    assert!(error.contains("marked untrusted"), "{error}");
    assert_eq!(fs::read_to_string(&config).unwrap(), untrusted);
    // Unknown folders are refused before Codex is touched.
    assert!(codex_trust::trust(&f.db, project, "other").is_err());
}
