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

#[test]
fn codex_trust_refuses_unsupported_or_unversioned_writes_and_retries_conflicts_once() {
    use std::os::unix::fs::PermissionsExt;

    for (mode, message, writes) in [
        ("old-list", "Codex version", 0),
        ("old-write", "Codex version", 1),
        ("no-version", "Codex version", 0),
        ("conflict", "changed while Orka was saving", 2),
        ("changed-snapshot", "changed while Orka was saving", 0),
    ] {
        let f = Fixture::new();
        native::Hooks::install(&f.root).unwrap();
        let bin = f._home.path().join(".local/bin");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(native::codex_home().unwrap()).unwrap();
        let binary = bin.join("codex");
        let script = r#"#!/bin/sh
mode=@MODE@
reads=0
while IFS= read -r line; do
  case "$line" in '{"id":'*) ;; *) continue ;; esac
  id=${line#*\"id\":}; id=${id%%,*}
  case "$line" in
    *'"method":"initialize"'*) result='{}' ;;
    *'"method":"config/read"'*)
      reads=$((reads+1)); version=version-1
      if [ "$mode" = changed-snapshot ]; then version=version-$reads; fi
      if [ "$mode" = no-version ]; then version=; fi
      result='{"config":@CONFIG@,"layers":[{"name":{"type":"user"},"version":"'"$version"'","config":@CONFIG@}]}' ;;
    *'"method":"hooks/list"'*)
      if [ "$mode" = old-list ]; then
        printf '{"id":%s,"error":{"code":-32601}}\n' "$id"; continue
      fi
      result=@LIST@ ;;
    *'"method":"config/batchWrite"'*)
      case "$line" in *'"keyPath":"hooks.state"'*'"expectedVersion":"version-1"'*) ;; *) exit 1 ;; esac
      echo write >> "$CODEX_HOME/writes"
      if [ "$mode" = old-write ]; then
        printf '{"id":%s,"error":{"code":-32601}}\n' "$id"
      else
        printf '{"id":%s,"error":{"code":-32000,"message":"stale","data":{"config_write_error_code":"configVersionConflict"}}}\n' "$id"
      fi
      continue ;;
    *) exit 1 ;;
  esac
  printf '{"id":%s,"result":%s}\n' "$id" "$result"
done
"#;
        let config = json!({"projects":{f.root.to_str().unwrap():{"trust_level":"trusted"}}});
        let executable = crate::updates::executable().unwrap();
        let command = native::Hooks::current_command(&executable, "codex");
        let listed = json!({"data":[{
            "cwd":f.root, "hooks":[{
                "source":"project", "sourcePath":f.root.join(".codex/hooks.json"),
                "command":command, "handlerType":"command", "enabled":true,
                "trustStatus":"untrusted", "eventName":"Stop", "key":"orka",
                "currentHash":"fixture"
            }]
        }]});
        fs::write(
            &binary,
            script
                .replace("@MODE@", mode)
                .replace("@CONFIG@", &config.to_string())
                .replace(
                    "@LIST@",
                    &crate::session_launcher::shell_quote(&listed.to_string()),
                ),
        )
        .unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        let project = f.project["id"].as_str().unwrap();
        let status = codex_trust::project_status(&f.db, project).unwrap();
        assert_eq!(
            status["state"],
            if mode == "old-list" {
                "unsupported"
            } else {
                "ready"
            }
        );
        let token = status["folders"][0]["folderToken"].as_str();
        // Obtain a real folder token if this server could never report one.
        let token = token.map(str::to_owned).unwrap_or_else(|| {
            let identity = crate::indexer::folder_identity(&f.root).unwrap();
            db::digest(json!([f.root, identity]).to_string().as_bytes())
        });
        let error = codex_trust::approve_hooks(&f.db, project, project, &token).unwrap_err();
        assert!(error.contains(message), "{mode}: {error}");
        assert_eq!(
            fs::read_to_string(native::codex_home().unwrap().join("writes"))
                .unwrap_or_default()
                .lines()
                .count(),
            writes,
            "{mode}"
        );
    }
}

#[test]
fn codex_status_times_out_and_reaps_its_one_child() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    native::Hooks::install(&f.root).unwrap();
    let bin = f._home.path().join(".local/bin");
    fs::create_dir_all(&bin).unwrap();
    let home = native::codex_home().unwrap();
    fs::create_dir_all(&home).unwrap();
    let binary = bin.join("codex");
    fs::write(
        &binary,
        "#!/bin/sh\necho $$ >> \"$CODEX_HOME/pids\"\nexec /bin/sleep 60\n",
    )
    .unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    let started = std::time::Instant::now();
    let project = f.project["id"].as_str().unwrap();
    let status = codex_trust::project_status(&f.db, project).unwrap();
    assert_eq!(status["state"], "unavailable", "{status}");
    assert!(started.elapsed() < std::time::Duration::from_secs(20));
    let pids = fs::read_to_string(home.join("pids")).unwrap();
    assert_eq!(pids.lines().count(), 1, "{pids}");
    let pid = pids.trim().parse::<u32>().unwrap().to_string();
    let child = std::process::Command::new("/bin/ps")
        .args(["-p", &pid])
        .output()
        .unwrap();
    assert!(
        !child.status.success(),
        "Codex child is still present: {child:?}"
    );
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
fn codex_trust_live_approval_requires_user_trust_and_only_approves_orka_hooks() {
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
    let token = status["folders"][0]["folderToken"].as_str().unwrap();
    let replacement = f.root.join("replacement");
    fs::create_dir(&replacement).unwrap();
    native::Hooks::install(&replacement).unwrap();
    let mut changed = f.project.clone();
    changed["path"] = json!(replacement);
    db::upsert(&f.db, "projects", project, project, &changed).unwrap();
    let error = codex_trust::approve_hooks(&f.db, project, project, token).unwrap_err();
    assert!(error.contains("folder changed"), "{error}");
    assert_eq!(fs::read_to_string(&config).unwrap(), before);
    db::upsert(&f.db, "projects", project, project, &f.project).unwrap();
    let result = codex_trust::approve_hooks(&f.db, project, project, token).unwrap();
    assert_eq!(result["state"], "folder-not-trusted", "{result}");
    assert_eq!(fs::read_to_string(&config).unwrap(), before);

    // The user trusts the folder in Codex before approving Orka's hooks.
    let root_entry = format!("\n[projects.{:?}]\ntrust_level = \"trusted\"\n", f.root);
    let manually_trusted = format!("{before}{root_entry}");
    fs::write(&config, &manually_trusted).unwrap();
    let approval_status = codex_trust::project_status(&f.db, project).unwrap();
    assert_eq!(approval_status["folders"][0]["state"], "hooks-not-approved");
    let token = approval_status["folders"][0]["folderToken"]
        .as_str()
        .unwrap();

    // A click from the stale approval notice cannot restore revoked folder trust.
    fs::write(&config, before).unwrap();
    let result = codex_trust::approve_hooks(&f.db, project, project, token).unwrap();
    assert_eq!(result["state"], "folder-not-trusted", "{result}");
    assert_eq!(fs::read_to_string(&config).unwrap(), before);

    fs::write(&config, &manually_trusted).unwrap();
    let result = codex_trust::approve_hooks(&f.db, project, project, token).unwrap();
    assert_eq!(result["state"], "trusted", "{result}");
    let after = fs::read_to_string(&config).unwrap();
    assert!(after.starts_with(manually_trusted.trim_end()), "{after}");
    assert_eq!(after.matches("trust_level").count(), 2, "{after}");
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
        codex_trust::approve_hooks(&f.db, project, project, token).unwrap()["state"],
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
    let error = codex_trust::approve_hooks(&f.db, project, project, token).unwrap_err();
    assert!(error.contains("marked untrusted"), "{error}");
    assert_eq!(fs::read_to_string(&config).unwrap(), untrusted);
    // Unknown folders are refused before Codex is touched.
    assert!(codex_trust::approve_hooks(&f.db, project, "other", token).is_err());
    let parent = f.root.canonicalize().unwrap();
    let conflicting = format!(
        "{after}\n[projects.{:?}]\ntrust_level = \"untrusted\"\n",
        parent.parent().unwrap()
    );
    fs::write(&config, &conflicting).unwrap();
    let error = codex_trust::approve_hooks(&f.db, project, project, token).unwrap_err();
    assert!(error.contains("marked untrusted"), "{error}");
    assert_eq!(fs::read_to_string(&config).unwrap(), conflicting);
}

#[test]
#[ignore = "requires installed Codex with hooks/list; isolated CODEX_HOME"]
fn codex_trust_live_reapproves_moved_app_without_adding_a_nested_trust_entry() {
    let f = Fixture::new();
    f.select_codex_binary();
    // The saved source is a subfolder of a repository already trusted in Codex.
    let repo = f.root.parent().unwrap();
    assert!(std::process::Command::new("git")
        .arg("init")
        .arg(repo)
        .output()
        .unwrap()
        .status
        .success());
    native::Hooks::install(&f.root).unwrap();
    let hooks = f.root.join(".codex/hooks.json");
    let installed = fs::read_to_string(&hooks).unwrap();
    let executable = crate::updates::executable().unwrap();
    let old = executable.with_file_name("Orka-before-moving");
    // Simulate hooks created by a legacy Orka build at the previous location.
    let legacy = installed
        .replace(executable.to_str().unwrap(), old.to_str().unwrap())
        .replace("--orka-hook", "--workspace-hook");
    fs::write(&hooks, legacy).unwrap();
    let home = native::codex_home().unwrap();
    fs::create_dir_all(&home).unwrap();
    let config = home.join("config.toml");
    fs::write(
        &config,
        format!("[projects.{repo:?}]\ntrust_level = \"trusted\"\n"),
    )
    .unwrap();
    assert_eq!(inspect(&f), Trust::HooksNotApproved);
    approve(&f, &config);
    assert_eq!(inspect(&f), Trust::Trusted);
    let approved = fs::read_to_string(&config).unwrap();
    fs::write(
        &config,
        approved.replacen(
            "trusted_hash =",
            "enabled = true # keep this preference\ntrusted_hash =",
            1,
        ),
    )
    .unwrap();
    // Reconnect replaces obsolete commands; approval is still tied to the old hashes.
    fs::write(&hooks, installed).unwrap();
    let project = f.project["id"].as_str().unwrap();
    let status = codex_trust::project_status(&f.db, project).unwrap();
    assert_eq!(status["folders"][0]["state"], "hooks-changed");
    let token = status["folders"][0]["folderToken"].as_str().unwrap();
    assert_eq!(
        codex_trust::approve_hooks(&f.db, project, project, token).unwrap()["state"],
        "trusted"
    );
    let after = fs::read_to_string(&config).unwrap();
    assert_eq!(after.matches("trust_level").count(), 1, "{after}");
    assert_eq!(after.matches("trusted_hash").count(), 4, "{after}");
    assert!(
        after.contains("enabled = true # keep this preference"),
        "{after}"
    );
}
