//! Native session-storage measurements, driven by scripts/benchmark-session-storage.py.
use super::*;
use crate::{commands, local_resources, selective_sharing};
use std::{
    collections::BTreeMap, future::Future, io::Write, os::unix::fs::MetadataExt, time::Instant,
};
use uuid::Uuid;

const SESSION_COUNT: usize = 96;
const SHORT_TURNS: usize = 24;
const LONG_TURNS: usize = 2048;
const LONG_TEXT_BYTES: usize = 512;
const APPENDS: usize = 12;
const TIMESTAMP: &str = "2026-10-02T00:00:00Z";
const APPEND_MARKER: &str = "Synthetic append after the approved preview.";

fn account(fixture: &Fixture) -> String {
    db::get(&fixture.db, "user")
        .unwrap()
        .as_str()
        .unwrap()
        .into()
}

fn project_id(project: &Value) -> String {
    project["id"].as_str().unwrap().into()
}

fn set_sharing(db: &rusqlite::Connection, project: &mut Value, origin: &str) {
    project["sharing"] = json!(crate::projects::Sharing::default());
    db::upsert(db, "projects", &project_id(project), "", project).unwrap();
    db::set(db, "config", &json!({"apiUrl":origin,"syncMinutes":15})).unwrap();
}

fn message(tool: &str, id: &str, root: &Path, role: &str, text: &str) -> Value {
    if tool == "codex" {
        let part = if role == "user" {
            "input_text"
        } else {
            "output_text"
        };
        json!({"type":"response_item","payload":{"type":"message","role":role,"content":[{"type":part,"text":text}]}})
    } else {
        json!({"type":role,"cwd":root,"sessionId":id,"version":"2.1.286","message":{"role":role,"content":[{"type":"text","text":text}]}})
    }
}

fn begin_session(tool: &str, id: &str, root: &Path, title: &str, turns: usize) -> PathBuf {
    let root_dir = if tool == "codex" {
        native::codex_home().unwrap().join("sessions/2026/10/02")
    } else {
        native::claude_home().unwrap().join("projects/fixture")
    };
    fs::create_dir_all(&root_dir).unwrap();
    let path = root_dir.join(if tool == "codex" {
        format!("rollout-2026-10-02T00-00-00-{id}.jsonl")
    } else {
        format!("{id}.jsonl")
    });
    let mut records = Vec::with_capacity(turns + 2);
    if tool == "codex" {
        records.push(json!({"type":"session_meta","timestamp":TIMESTAMP,"payload":{"id":id,"cwd":root,"cli_version":"0.159.2","history_mode":"legacy","source":"cli"}}));
    }
    records.push(message(tool, id, root, "user", title));
    let payload = "synthetic text for session storage ";
    let padding = payload.repeat(LONG_TEXT_BYTES / payload.len());
    for turn in 0..turns {
        let role = if turn % 2 == 0 { "assistant" } else { "user" };
        records.push(message(
            tool,
            id,
            root,
            role,
            &format!("Turn {turn}. {padding}"),
        ));
    }
    fs::write(&path, native::encode(&records)).unwrap();
    path
}

fn append(path: &Path, tool: &str, id: &str, root: &Path, text: &str) {
    fs::OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(&native::encode(&[message(tool, id, root, "user", text)]))
        .unwrap();
}

fn add_fork(root: &Path) -> (PathBuf, PathBuf) {
    let mut ancestor = None;
    let mut paths = Vec::new();
    for (suffix, marker) in [(1, "Fixture fork ancestor"), (2, "Fixture fork branch")] {
        let id = Uuid::from_u128(0xffff_0000 + suffix).to_string();
        let ordinal = ancestor.as_ref().map_or(0, |(_, end, _)| *end);
        let mut meta = json!({"type":"session_meta","timestamp":TIMESTAMP,"ordinal":ordinal,"payload":{"id":id,"session_id":id,"timestamp":TIMESTAMP,"cwd":root,"cli_version":"0.159.2","history_mode":"paginated","source":"cli","originator":"codex_cli_rs","model_provider":"openai"}});
        if let Some((id, end, byte_offset)) = ancestor {
            meta["payload"]["history_base"] =
                json!({"thread_id":id,"end_ordinal_exclusive":end,"end_byte_offset":byte_offset});
            meta["payload"]["forked_from_id"] = json!(id);
            meta["payload"]["forked_from_ordinal_exclusive"] = json!(end);
        }
        let mut records = vec![meta];
        records.extend(paginated_turn(&id, marker, ordinal + 1));
        let bytes = native::encode(&records);
        ancestor = Some((id.clone(), ordinal + records.len() as u64, bytes.len()));
        let path = native::codex_home().unwrap().join(format!(
            "sessions/2026/10/02/rollout-2026-10-02T00-00-00-{id}.jsonl"
        ));
        fs::write(&path, bytes).unwrap();
        paths.push(path);
    }
    (paths.remove(0), paths.remove(0))
}

#[derive(Default)]
struct Storage {
    allocated: u64,
    blobs: BTreeMap<PathBuf, u64>,
}

impl Storage {
    fn measure(root: &Path) -> Self {
        let mut result = Self::default();
        for entry in walkdir::WalkDir::new(root) {
            let entry = entry.unwrap();
            let metadata = entry.metadata().unwrap();
            if !metadata.is_file() {
                continue;
            }
            result.allocated += metadata.blocks() * 512;
            if entry
                .path()
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == "blobs")
            {
                result.blobs.insert(entry.into_path(), metadata.len());
            }
        }
        result
    }
}

fn counters() -> (u64, u64) {
    let mut io = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
    let mut mem = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // Both calls initialize the correctly sized macOS SDK structures on success.
    unsafe {
        assert_eq!(
            libc::proc_pid_rusage(libc::getpid(), libc::RUSAGE_INFO_V2, io.as_mut_ptr().cast()),
            0
        );
        assert_eq!(libc::getrusage(libc::RUSAGE_SELF, mem.as_mut_ptr()), 0);
        (
            io.assume_init().ri_diskio_byteswritten,
            mem.assume_init().ru_maxrss as u64,
        )
    }
}

async fn observe<T>(label: &str, action: impl Future<Output = T>) -> T {
    let root = db::root().unwrap();
    let before = Storage::measure(&root);
    let (writes, _) = counters();
    let begin = Instant::now();
    let result = action.await;
    let seconds = begin.elapsed().as_secs_f64();
    let (end_writes, peak) = counters();
    let after = Storage::measure(&root);
    let additions = after
        .blobs
        .iter()
        .filter(|(path, _)| !before.blobs.contains_key(*path));
    let (new_count, new_bytes) = additions.fold((0, 0), |(count, bytes), (_, size)| {
        (count + 1, bytes + size)
    });
    let stats = json!({"phase":label,"elapsedMs":seconds * 1_000.0,"processPeakRssBytes":peak,"processDiskWritesBytes":end_writes.saturating_sub(writes),"newBlobCount":new_count,"newBlobBytes":new_bytes,"allocatedDeltaBytes":(after.allocated as i64) - (before.allocated as i64),"allocatedBytes":after.allocated});
    println!("ORKA_BENCH {stats}");
    result
}

async fn catalog(project: &Value, user: &str, origin: &str) -> Value {
    let result = local_resources::local_resource_catalog(
        project_id(project),
        "session".into(),
        user.into(),
        origin.into(),
        Some(true),
    )
    .await
    .unwrap();
    assert_eq!(result["errors"], json!([]));
    assert_ne!(result["refreshPending"], true);
    result
}

fn find_session(catalog: &Value, title: &str) -> String {
    catalog["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|resource| resource["title"] == title)
        .unwrap_or_else(|| panic!("Missing fixture session {title}"))["resourceId"]
        .as_str()
        .unwrap()
        .into()
}

async fn page(id: &str, offset: usize) -> Value {
    let result = commands::session_messages(id.into(), None, Some(offset), Some(40))
        .await
        .unwrap();
    assert!(result["total"].as_u64().unwrap() > 0);
    result
}

#[tokio::test]
#[ignore = "native benchmark using disposable fixtures"]
async fn browse() {
    let mut fixture = Fixture::new();
    let origin = "http://127.0.0.1:1";
    set_sharing(&fixture.db, &mut fixture.project, origin);
    let user = account(&fixture);
    let long_codex = Uuid::from_u128(200).to_string();
    let long_claude = Uuid::from_u128(201).to_string();
    for index in 0..SESSION_COUNT - 2 {
        let tool = if index % 2 == 0 { "codex" } else { "claude" };
        begin_session(
            tool,
            &Uuid::from_u128(index as u128 + 1).to_string(),
            &fixture.root,
            &format!("Small fixture session {index}"),
            SHORT_TURNS,
        );
    }
    let codex = begin_session(
        "codex",
        &long_codex,
        &fixture.root,
        "Long Codex fixture",
        LONG_TURNS,
    );
    let claude = begin_session(
        "claude",
        &long_claude,
        &fixture.root,
        "Long Claude fixture",
        LONG_TURNS,
    );
    let fixture_sizes = json!({"sessions": SESSION_COUNT, "shortTurns": SHORT_TURNS, "longTurns": LONG_TURNS, "longCodexBytes": fs::metadata(&codex).unwrap().len(),"longClaudeBytes": fs::metadata(&claude).unwrap().len(), "appendsPerLongSession":APPENDS});
    println!("ORKA_FIXTURE {fixture_sizes}");
    let refresh = || catalog(&fixture.project, &user, origin);
    let cold = observe("cold catalog", refresh()).await;
    assert_eq!(cold["resources"].as_array().unwrap().len(), SESSION_COUNT);
    let codex_id = find_session(&cold, "Long Codex fixture");
    let claude_id = find_session(&cold, "Long Claude fixture");
    for _ in 0..3 {
        let warm = observe("unchanged catalog", refresh()).await;
        assert_eq!(warm, cold);
    }
    for (id, label) in [(&codex_id, "Codex"), (&claude_id, "Claude")] {
        let initial = observe(&format!("{label} initial open"), page(id, 0)).await;
        assert_eq!(initial["messages"].as_array().unwrap().len(), 40);
        observe(&format!("{label} next 3 pages"), async {
            for offset in [40, 80, 120] {
                let result = page(id, offset).await;
                assert_eq!(result["messages"].as_array().unwrap().len(), 40);
                assert_eq!(result["offset"], offset);
            }
        })
        .await;
    }
    for (tool, path, native_id, resource_id, label) in [
        (
            "codex",
            &codex,
            &long_codex,
            &codex_id,
            "Codex append refresh + open",
        ),
        (
            "claude",
            &claude,
            &long_claude,
            &claude_id,
            "Claude append refresh + open",
        ),
    ] {
        for n in 1..=APPENDS {
            let marker = format!("{tool} private append {n}");
            append(path, tool, native_id, &fixture.root, &marker);
            observe(label, async {
                refresh().await;
                let view = page(resource_id, LONG_TURNS + n).await;
                assert_eq!(view["messages"][0]["text"], marker);
            })
            .await;
        }
    }
    observe("private session export", async {
        let destination = fixture._home.path().join("session-export.zip");
        commands::export_bundle(codex_id, destination.to_str().unwrap().into(), None).unwrap();
        let mut zip = zip::ZipArchive::new(fs::File::open(destination).unwrap()).unwrap();
        let mut transcript = String::new();
        zip.by_name("transcript.md")
            .unwrap()
            .read_to_string(&mut transcript)
            .unwrap();
        assert!(transcript.contains("codex private append 12"));
    })
    .await;
    let (ancestor, _) = add_fork(&fixture.root);
    let result = observe("Codex fork catalog + open", async {
        let fork = refresh().await;
        let branch = fork["resources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|resource| resource["nativeForkParentId"].is_string())
            .unwrap();
        let selection = branch["resourceId"].as_str().unwrap().to_owned();
        let transcript = page(&selection, 0).await.to_string();
        assert!(
            transcript.contains("Fixture fork ancestor")
                && transcript.contains("Fixture fork branch")
        );
        selection
    })
    .await;
    let source = fs::read_to_string(&ancestor).unwrap();
    fs::write(
        &ancestor,
        source.replace("Fixture fork ancestor", "Updated fork ancestor"),
    )
    .unwrap();
    observe("Codex fork ancestry update + open", async {
        refresh().await;
        let transcript = page(&result, 0).await.to_string();
        assert!(
            transcript.contains("Updated fork ancestor")
                && transcript.contains("Fixture fork branch")
        );
        assert!(!transcript.contains("Fixture fork ancestor"));
    })
    .await;
    assert!(fixture.outbox().is_empty());
}

struct Persistent {
    home: PathBuf,
    project_root: PathBuf,
    project: Value,
    user: String,
    origin: String,
}

impl Persistent {
    fn open() -> Self {
        let home = PathBuf::from(
            std::env::var_os("ORKA_SESSION_BENCH_HOME").expect("Use the benchmark driver"),
        );
        let project_root = home.join("project");
        fs::create_dir_all(&project_root).unwrap();
        let project_root = project_root.canonicalize().unwrap();
        std::env::set_var("ORKA_TEST_HOME", &home);
        std::env::set_var("CODEX_HOME", home.join(".codex"));
        std::env::set_var("CLAUDE_CONFIG_DIR", home.join(".claude"));
        let origin = std::env::var("ORKA_SESSION_BENCH_ORIGIN").expect("Use the benchmark driver");
        assert!(origin.starts_with("http://127.0.0.1:"));
        let user = Uuid::from_u128(4242).to_string();
        let mut project = json!({"id":Uuid::from_u128(4243),"name":"Session benchmark","role":"owner","path":project_root});
        crate::env::test_support::install_memory_keychain();
        db::set(
            &db::open().unwrap(),
            "config",
            &json!({"apiUrl":origin,"syncMinutes":15}),
        )
        .unwrap();
        crate::auth::test_session(&json!({"user":{"id":user},"access_token":"session-bench-fixture","refresh_token":"unused","expires_in":3600})).unwrap();
        set_sharing(&db::open().unwrap(), &mut project, &origin);
        Self {
            home,
            project_root,
            project,
            user,
            origin,
        }
    }

    async fn browse(&self) -> Value {
        catalog(&self.project, &self.user, &self.origin).await
    }

    fn share_input(&self, id: &str) -> Value {
        json!({"accountId":self.user,"serviceOrigin":self.origin,"projectId":self.project["id"],"kind":"session","resourceId":id})
    }
}

#[tokio::test]
#[ignore = "native benchmark using disposable fixtures"]
async fn share_first() {
    let fixture = Persistent::open();
    let native_id = Uuid::from_u128(4244).to_string();
    let path = begin_session(
        "codex",
        &native_id,
        &fixture.project_root,
        "Approved fixture",
        LONG_TURNS,
    );
    let list = observe("share catalog", fixture.browse()).await;
    let id = find_session(&list, "Approved fixture");
    let mut request = fixture.share_input(&id);
    let preview = observe(
        "freeze preview",
        selective_sharing::command("preview_share", &request),
    )
    .await
    .unwrap();
    let files = preview["files"].as_array().unwrap();
    assert_eq!(files.len(), 1);
    let original = db::blob_read(files[0]["hash"].as_str().unwrap()).unwrap();
    assert!(String::from_utf8_lossy(&original).contains("Approved fixture"));
    request["previewToken"] = preview["previewToken"].clone();

    // The edit and archive move occur after approval and before the initial network attempt.
    append(
        &path,
        "codex",
        &native_id,
        &fixture.project_root,
        APPEND_MARKER,
    );
    let archive = native::codex_home().unwrap().join("archived_sessions");
    fs::create_dir_all(&archive).unwrap();
    fs::rename(&path, archive.join(path.file_name().unwrap())).unwrap();
    let first = observe(
        "selected share transient failure",
        selective_sharing::command("share_selected", &request),
    )
    .await
    .unwrap();
    assert_eq!(first["status"], "queued");
    assert!(first["error"].as_str().unwrap().contains("503"));
    fs::write(
        fixture.home.join("benchmark-share.json"),
        json!({"request":request,"requestId":first["requestId"],"files":files,"pid":std::process::id()}).to_string(),
    )
    .unwrap();
}

#[tokio::test]
#[ignore = "native benchmark using disposable fixtures"]
async fn share_retry() {
    let fixture = Persistent::open();
    let saved: Value =
        serde_json::from_slice(&fs::read(fixture.home.join("benchmark-share.json")).unwrap())
            .unwrap();
    assert_ne!(saved["pid"], std::process::id());
    let result = observe(
        "selected share restart + retry",
        selective_sharing::command("share_selected", &saved["request"]),
    )
    .await
    .unwrap();
    assert_eq!(result["status"], "published");
    assert_eq!(result["requestId"], saved["requestId"]);
    let db = db::open().unwrap();
    let resource = db::rows(
        &db,
        "SELECT value FROM resources WHERE project=?",
        &[&project_id(&fixture.project)],
    )
    .unwrap()
    .remove(0);
    assert_eq!(resource["files"], saved["files"]);
    assert_eq!(
        db.query_row("SELECT count(*) FROM outbox", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[tokio::test]
#[ignore = "native benchmark using disposable fixtures"]
async fn upgrade_fixture() {
    let fixture = Persistent::open();
    let native_id = Uuid::from_u128(4245).to_string();
    let path = begin_session(
        "codex",
        &native_id,
        &fixture.project_root,
        "Upgradeable fixture",
        LONG_TURNS,
    );
    let first = fixture.browse().await;
    let id = find_session(&first, "Upgradeable fixture");
    let mut pinned = Vec::new();
    for n in 0..=APPENDS {
        if n != 0 {
            append(
                &path,
                "codex",
                &native_id,
                &fixture.project_root,
                &format!("Synthetic upgrade append {n}"),
            );
            fixture.browse().await;
        }
        if [1, 4, 8].contains(&n) {
            let request = fixture.share_input(&id);
            let preview = selective_sharing::command("preview_share", &request)
                .await
                .unwrap();
            pinned.push(preview["files"][0]["hash"].as_str().unwrap().to_owned());
        }
    }
    let other = db::blob(b"Synthetic non-transcript memory file.\n").unwrap();
    fs::write(
        fixture.home.join("benchmark-upgrade.json"),
        json!({"pinned":pinned,"other":other}).to_string(),
    )
    .unwrap();
}

#[tokio::test]
#[ignore = "native benchmark using disposable fixtures"]
async fn upgraded_read() {
    let fixture = Persistent::open();
    let check: Value =
        serde_json::from_slice(&fs::read(fixture.home.join("benchmark-upgrade.json")).unwrap())
            .unwrap();
    for hash in check["pinned"].as_array().unwrap() {
        assert!(
            String::from_utf8_lossy(&db::blob_read(hash.as_str().unwrap()).unwrap())
                .contains("Upgradeable fixture")
        );
    }
    assert_eq!(
        db::blob_read(check["other"].as_str().unwrap()).unwrap(),
        b"Synthetic non-transcript memory file.\n"
    );
    let list = observe("upgraded catalog + open", async {
        let list = fixture.browse().await;
        let id = find_session(&list, "Upgradeable fixture");
        let tail = page(&id, LONG_TURNS + APPENDS).await;
        assert_eq!(
            tail["messages"][0]["text"],
            format!("Synthetic upgrade append {APPENDS}")
        );
        list
    })
    .await;
    assert_eq!(list["resources"].as_array().unwrap().len(), 1);
}

#[tokio::test]
#[ignore = "native benchmark using disposable fixtures"]
async fn automatic_sync() {
    let fixture = Persistent::open();
    let mut project = fixture.project;
    project["sharing"]["session"] = json!(true);
    let project_id = project_id(&project);
    let native_id = Uuid::from_u128(4246).to_string();
    let db = db::open().unwrap();
    db::upsert(&db, "projects", &project_id, "", &project).unwrap();
    let path = begin_session(
        "codex",
        &native_id,
        &fixture.project_root,
        "Automatic fixture",
        LONG_TURNS,
    );
    indexer::scan(&db, &project).unwrap();
    let latest = "Automatic fixture final unsent append";
    observe("automatic scan two appends", async {
        for marker in ["Automatic fixture first unsent append", latest] {
            append(&path, "codex", &native_id, &fixture.project_root, marker);
            indexer::scan(&db, &project).unwrap();
        }
    })
    .await;
    let queued = db::rows(
        &db,
        "SELECT value FROM outbox WHERE path='/v2/sync/push'",
        &[],
    )
    .unwrap();
    assert_eq!(queued.len(), 1);
    let bytes = db::blob_read(queued[0]["resource"]["files"][0]["hash"].as_str().unwrap()).unwrap();
    let queued_latest = String::from_utf8_lossy(&bytes).contains(latest);
    println!(
        "ORKA_FIXTURE {}",
        json!({"queuedLatestUnsent":queued_latest})
    );
    observe("automatic first sync", sync::once()).await.unwrap();
    observe("automatic second sync", sync::once())
        .await
        .unwrap();
    let outbox = db
        .query_row("SELECT count(*) FROM outbox", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap();
    assert_eq!(outbox, 0);
    let resources = db::rows(
        &db,
        "SELECT value FROM resources WHERE project=?",
        &[&project_id],
    )
    .unwrap();
    let session = resources.iter().find(|r| r["kind"] == "session").unwrap();
    let bytes = db::blob_read(session["files"][0]["hash"].as_str().unwrap()).unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains(latest));
}
