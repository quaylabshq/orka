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
