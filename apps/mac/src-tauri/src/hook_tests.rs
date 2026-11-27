use super::*;

struct HookFixture {
    _directory: tempfile::TempDir,
    root: PathBuf,
}
impl HookFixture {
    fn new() -> Self {
        let directory = tempfile::Builder::new()
            .prefix("hooks 'quoted' ")
            .tempdir()
            .unwrap();
        let root = directory.path().canonicalize().unwrap();
        Self {
            _directory: directory,
            root,
        }
    }
    fn path(&self, tool: &str) -> PathBuf {
        self.root.join(match tool {
            "claude" => ".claude/settings.local.json",
            "codex" => ".codex/hooks.json",
            _ => unreachable!(),
        })
    }
    fn read(&self, tool: &str) -> Value {
        serde_json::from_slice(&fs::read(self.path(tool)).unwrap()).unwrap()
    }
    fn write(&self, tool: &str, value: &Value) {
        fs::write(self.path(tool), serde_json::to_vec(value).unwrap()).unwrap();
    }
    fn state(&self, tool: &str) -> HookState {
        let status = Hooks::inspect(&self.root).unwrap();
        let file = status
            .files
            .into_iter()
            .find(|file| file.tool == tool)
            .unwrap();
        assert_eq!(file.file, self.path(tool));
        file.state
    }
}

#[test]
fn hook_installation_is_configured_and_repeatable() {
    let f = HookFixture::new();
    Hooks::install(&f.root).unwrap();
    for tool in ["claude", "codex"] {
        assert_eq!(f.state(tool), HookState::Configured);
        let before = fs::read(f.path(tool)).unwrap();
        Hooks::install(&f.root).unwrap();
        assert_eq!(fs::read(f.path(tool)).unwrap(), before);
        let config = f.read(tool);
        for event in ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] {
            let hook = &config["hooks"][event][0]["hooks"][0];
            assert_eq!(hook["type"], "command");
            assert!(hook["command"]
                .as_str()
                .unwrap()
                .ends_with(&format!(" --orka-hook {tool}")));
        }
    }
}

#[test]
fn hook_inspection_distinguishes_missing_and_partial_files() {
    let f = HookFixture::new();
    assert_eq!(f.state("claude"), HookState::Missing);
    assert!(!f.path("claude").exists());
    Hooks::install(&f.root).unwrap();
    let mut config = f.read("claude");
    config["hooks"].as_object_mut().unwrap().remove("Stop");
    f.write("claude", &config);
    assert_eq!(f.state("claude"), HookState::Partial);
    assert_eq!(f.state("codex"), HookState::Configured);
    let before = fs::read(f.path("claude")).unwrap();
    Hooks::inspect(&f.root).unwrap();
    assert_eq!(fs::read(f.path("claude")).unwrap(), before);
}

#[test]
fn hook_inspection_classifies_malformed_and_unreadable_files() {
    let f = HookFixture::new();
    Hooks::install(&f.root).unwrap();
    for raw in ["{", "[]", r#"{"hooks":[]}"#] {
        fs::write(f.path("claude"), raw).unwrap();
        assert_eq!(f.state("claude"), HookState::Malformed, "{raw}");
        assert_eq!(f.state("codex"), HookState::Configured);
        assert!(Hooks::install(&f.root).is_err());
        assert_eq!(fs::read_to_string(f.path("claude")).unwrap(), raw);
    }
    fs::remove_file(f.path("claude")).unwrap();
    fs::create_dir(f.path("claude")).unwrap();
    assert_eq!(f.state("claude"), HookState::Unreadable);
}

#[test]
fn hook_installation_preserves_hookless_groups_and_inspects_as_configured() {
    let f = HookFixture::new();
    Hooks::install(&f.root).unwrap();
    let groups = json!([{}, {"matcher":"external"}, {"hooks":{}}, "external"]);
    for tool in ["claude", "codex"] {
        let mut config = f.read(tool);
        config["hooks"]["SessionStart"] = groups.clone();
        f.write(tool, &config);
        Hooks::install(&f.root).unwrap();
        assert_eq!(f.state(tool), HookState::Configured);
        let installed = f.read(tool);
        let installed_groups = installed["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(&installed_groups[..4], groups.as_array().unwrap());
        assert_eq!(installed_groups.len(), 5);
    }
}

#[test]
fn hook_installation_replaces_non_array_event_values_as_before() {
    let f = HookFixture::new();
    Hooks::install(&f.root).unwrap();
    for tool in ["claude", "codex"] {
        for value in [json!({"external":true}), json!("external"), json!(7)] {
            let mut config = f.read(tool);
            config["hooks"]["SessionStart"] = value;
            f.write(tool, &config);
            assert_eq!(f.state(tool), HookState::Malformed);
            Hooks::install(&f.root).unwrap();
            assert_eq!(f.state(tool), HookState::Configured);
            assert!(f.read(tool)["hooks"]["SessionStart"].is_array());
        }
    }
}

#[test]
#[cfg(unix)]
fn configured_hooks_do_not_bypass_installer_directory_safety() {
    let f = HookFixture::new();
    let outside = HookFixture::new();
    Hooks::install(&outside.root).unwrap();
    std::os::unix::fs::symlink(outside.root.join(".claude"), f.root.join(".claude")).unwrap();
    let before = fs::read(outside.path("claude")).unwrap();
    assert_eq!(f.state("claude"), HookState::Configured);
    assert!(Hooks::install(&f.root).is_err());
    assert_eq!(fs::read(outside.path("claude")).unwrap(), before);
}

#[test]
fn hook_inspection_identifies_wrong_profile_and_executable() {
    let f = HookFixture::new();
    Hooks::install(&f.root).unwrap();
    let original = f.read("claude");
    let mut config = original.clone();
    let command = original["hooks"]["Stop"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap();
    let (executable, _) = command.rsplit_once(" --profile ").unwrap();
    config["hooks"]["Stop"][0]["hooks"][0]["command"] = json!(format!(
        "{executable} --profile 'doctor-other' --orka-hook claude"
    ));
    f.write("claude", &config);
    assert_eq!(f.state("claude"), HookState::WrongProfile);
    Hooks::install(&f.root).unwrap();
    assert_eq!(f.state("claude"), HookState::Configured);
    config = original;
    let profile = crate::profiles::current();
    config["hooks"]["Stop"][0]["hooks"][0]["command"] = json!(format!(
        "'/missing/orka' --profile '{profile}' --orka-hook claude"
    ));
    f.write("claude", &config);
    assert_eq!(f.state("claude"), HookState::WrongExecutable);
    Hooks::install(&f.root).unwrap();
    assert_eq!(f.state("claude"), HookState::Configured);
}

#[test]
fn unrelated_hooks_are_ignored_and_preserved_even_in_a_shared_group() {
    let f = HookFixture::new();
    Hooks::install(&f.root).unwrap();
    let unrelated =
        json!({"type":"command","command":"echo 'example --orka-hook claude'","timeout":7});
    let mut config = f.read("claude");
    config["custom"] = json!({"keep":true});
    config["hooks"]["Stop"][0]["hooks"]
        .as_array_mut()
        .unwrap()
        .push(unrelated.clone());
    config["hooks"]
        .as_object_mut()
        .unwrap()
        .remove("SessionEnd");
    f.write("claude", &config);
    Hooks::install(&f.root).unwrap();
    let installed = f.read("claude");
    assert_eq!(installed["custom"], config["custom"]);
    assert_eq!(installed["hooks"]["Stop"][0]["hooks"], json!([unrelated]));
    assert_eq!(f.state("claude"), HookState::Configured);
    for event in ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] {
        config["hooks"][event] = json!([{"hooks":[unrelated]}]);
    }
    f.write("claude", &config);
    assert_eq!(f.state("claude"), HookState::Missing);
    Hooks::install(&f.root).unwrap();
    let installed = f.read("claude");
    for event in ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] {
        assert_eq!(installed["hooks"][event][0], config["hooks"][event][0]);
    }
    assert_eq!(f.state("claude"), HookState::Configured);
}
