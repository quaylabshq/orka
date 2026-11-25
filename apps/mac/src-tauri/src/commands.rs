use crate::{
    auth, bundles,
    db::{self, Result},
    indexer, native, packages, projects, session_presentation, sync,
    sync_queue::{Priority, SyncQueue, WORKSPACE},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::Duration,
};
use tauri::ipc::{Channel, JavaScriptChannelId};
use uuid::Uuid;

const PENDING_UPLOADS: &str = "(SELECT count(*) FROM outbox WHERE project=projects.id)";
const PENDING_ENV_PUBLICATIONS: &str =
    "(SELECT count(*) FROM meta WHERE ? AND key LIKE 'env:%:pending:%'
      AND json_extract(value,'$.sourceRemoval') IS NULL
      AND json_extract(value,'$.header.manifest.projectId')=projects.id)";

#[tauri::command]
pub fn snapshot() -> Result<Value> {
    let db = db::open()?;
    let mut daemon = db::get(&db, "daemon")?;
    daemon["running"] = json!(db::daemon_running()?);
    let visible = format!("SELECT id FROM projects WHERE {}", projects::ACTIVE);
    let scoped = |table: &str| {
        let order = if table == "drafts" {
            "coalesce(json_extract(value,'$.updatedAt'),json_extract(value,'$.createdAt')) DESC, rowid DESC"
        } else {
            "json_extract(value,'$.updatedAt') DESC"
        };
        let value = if table == "bindings" {
            "json_set(value,'$.resourceId',id,'$.projectId',project)"
        } else {
            "value"
        };
        db::rows(
            &db,
            &format!("SELECT {value} FROM {table} WHERE project IN ({visible}) ORDER BY {order}"),
            &[],
        )
    };
    let mut projects = db::rows(
        &db,
        &format!(
            "SELECT value FROM projects WHERE {} ORDER BY json_extract(value,'$.name')",
            projects::ACTIVE
        ),
        &[],
    )?;
    // Settings can show the reason and offer access to the local copy of an
    // archived, deleted, or unreachable project.
    let mut inactive = db::rows(
        &db,
        &format!(
            "SELECT json_set(value,'$.pendingChanges',{PENDING_UPLOADS},'$.pendingEnvPublications',{PENDING_ENV_PUBLICATIONS})
             FROM projects WHERE coalesce(json_extract(value,'$.hidden'),0)=0 AND NOT ({}) ORDER BY json_extract(value,'$.name')",
            projects::ACTIVE
        ),
        // Removing an inactive copy discards pending publications even if ENV is disabled.
        &[&true],
    )?;
    // Only the changes eligible for upload are advertised in the banner.
    for project in &mut inactive {
        // ENV publications stay outside the ZIP but are discarded by removal.
        project["pendingChanges"] = json!(
            project["pendingChanges"].as_i64().unwrap_or(0)
                + project["pendingEnvPublications"].as_i64().unwrap_or(0)
        );
        project["heldChanges"] = json!(crate::indexer::held_count(
            &db,
            project["id"].as_str().unwrap_or_default()
        )?);
    }
    for project in &mut projects {
        let project_id = project["id"].as_str().unwrap_or_default().to_owned();
        if let Some(sources) = project["sources"].as_array_mut() {
            for source in sources {
                source["folderState"] = json!(crate::sources::source_folder_state(source));
                // Disconnecting a folder only waits for its own unsent changes.
                if let Some(id) = source["id"].as_str().map(str::to_owned) {
                    source["queuedChanges"] =
                        json!(crate::sources::queued_for_source(&db, &project_id, &id)?);
                    if let Some(path) = source["path"].as_str() {
                        // Shown as a hint; a folder outside Git can still sync.
                        source["gitRepository"] = json!(crate::indexer::has_git_repository(
                            std::path::Path::new(path)
                        ));
                    }
                    if source["path"].is_string() {
                        if let Some(at) = crate::sources::sync_after(&db, &project_id, &id)? {
                            source["syncStartsAt"] =
                                json!(chrono::DateTime::from_timestamp_millis(at)
                                    .map(|at| at.to_rfc3339()));
                        }
                    }
                }
            }
        } else {
            project["folderState"] = json!(crate::sources::folder_state(project));
        }
    }
    let deleted_projects = db::rows(
        &db,
        "SELECT value FROM projects WHERE coalesce(json_extract(value,'$.revoked'),0)=0 AND json_extract(value,'$.role')='owner' AND json_extract(value,'$.deletedAt') IS NOT NULL AND coalesce(json_extract(value,'$.purged'),0)=0 AND json_extract(value,'$.detachedAt') IS NULL ORDER BY json_extract(value,'$.name')",
        &[],
    )?;
    let archived_projects = db::rows(
        &db,
        "SELECT value FROM projects WHERE coalesce(json_extract(value,'$.revoked'),0)=0 AND json_extract(value,'$.role')='owner' AND json_extract(value,'$.archivedAt') IS NOT NULL AND json_extract(value,'$.deletedAt') IS NULL AND coalesce(json_extract(value,'$.purged'),0)=0 AND json_extract(value,'$.detachedAt') IS NULL ORDER BY json_extract(value,'$.name')",
        &[],
    )?;
    let mut local_skills = Vec::new();
    for project in &projects {
        for source in crate::sources::views(project) {
            local_skills.extend(crate::global_skills::local_skills(&db, &source)?);
        }
    }
    let mut resources = scoped("resources")?;
    let onboarding = crate::onboarding::snapshot(&db)?;
    let background = db::get(&db, "background")?
        .as_bool()
        .unwrap_or(onboarding["active"] != true && crate::profiles::background_default());
    for resource in &mut resources {
        if resource["kind"] == "skill" && resource["deleted"] != true {
            resource["global"] = json!(crate::global_skills::global_origin(&db, resource)?);
        }
    }
    crate::session_forks::annotate(&db, &mut resources)?;
    let outbox: Vec<Value> = db::rows(&db,&format!("SELECT json_object('id',o.id,'project',o.project,'error',o.error,'resourceId',coalesce(json_extract(o.value,'$.resource.resourceId'),json_extract(o.value,'$.resourceId')),'title',coalesce(json_extract(o.value,'$.resource.title'),json_extract(r.value,'$.title')),'kind',coalesce(json_extract(o.value,'$.resource.kind'),json_extract(r.value,'$.kind')),'reviewPath',o.path,'reviewResource',json_extract(o.value,'$.resource'),'sessionResolution',CASE WHEN o.path='/v2/sessions/resolve' AND o.error IS NULL THEN json_object('conflictId',json_extract(o.value,'$.conflictId'),'revision',json_extract(o.value,'$.expectedRevision')) END) FROM outbox o LEFT JOIN resources r ON r.project=o.project AND r.id=coalesce(json_extract(o.value,'$.resource.resourceId'),json_extract(o.value,'$.resourceId')) WHERE o.project IN ({visible})"),&[])?.into_iter().map(|mut row| {
        row["reviewable"] = json!(crate::upload_review::reviewable(row["reviewPath"].as_str().unwrap_or(""), row["error"].as_str(), &row["reviewResource"]));
        if let Some(fields) = row.as_object_mut() {
            fields.remove("reviewPath");
            fields.remove("reviewResource");
        }
        row
    }).collect();
    Ok(json!({
        "profile":crate::profiles::current(), "onboarding":onboarding, "accountProfile":db::get(&db,"accountProfile")?,
        "user":db::get(&db,"user")?, "config":db::get(&db,"config")?,
        "projects":projects, "inactive":inactive, "deletedProjects":deleted_projects, "archivedProjects":archived_projects, "localSkills":local_skills,
        "managedProjects":db::rows(&db,&format!("SELECT json_set(value,'$.pendingChanges',{PENDING_UPLOADS}+{PENDING_ENV_PUBLICATIONS}) FROM projects ORDER BY json_extract(value,'$.name')"),&[&crate::env::enabled()])?,
        "resources":resources, "bindings":scoped("bindings")?, "conflicts":scoped("conflicts")?,
        "drafts":scoped("drafts")?,
        "governance":db::rows(&db,&format!("SELECT json_object('projectId',substr(key,12),'catalog',json(value)) FROM meta WHERE key LIKE 'governance:%' AND substr(key,12) IN ({visible})"),&[])?,
        "reviewRequests":db::rows(&db,&format!("SELECT json_each.value FROM meta,json_each(meta.value) WHERE meta.key LIKE 'requests:%' AND json_each.type='object' AND substr(meta.key,10) IN ({visible})"),&[])?,
        "activity":db::rows(&db,&format!("SELECT value FROM activity WHERE json_extract(value,'$.resourceId') IN (SELECT id FROM resources WHERE project IN ({visible})) ORDER BY rowid DESC LIMIT 30"),&[])?,
        "outbox":outbox,
        "errors":db::rows(&db,&format!("SELECT json_object('source',source,'error',error) FROM errors WHERE source IN ({visible}) OR source NOT IN (SELECT id FROM projects)"),&[])?,
        "sync":db::get(&db,"sync")?, "syncProgress":sync::current_progress(&db,daemon["running"]==true)?,
        "daemon":daemon, "devices":crate::device_metadata::devices(&db,&db::get(&db,"devices")?)?, "deviceId":db::device(&db)?, "localHardwareFamily":crate::device_metadata::local_family(&db)?, "background":background
    }))
}
#[tauri::command]
pub fn sync_progress() -> Result<Value> {
    let db = db::open()?;
    let running = db::daemon_running()?;
    Ok(json!({"user":db::get(&db, "user")?,"progress":sync::current_progress(&db, running)?}))
}
fn service_config(config: &Value) -> Result<Value> {
    let raw = config["apiUrl"]
        .as_str()
        .ok_or("Enter the service URL")?
        .trim();
    db::validate_url(raw)?;
    let url = raw.trim_end_matches('/');
    let minutes = config["syncMinutes"]
        .as_u64()
        .ok_or("Sync interval must be a whole number")?;
    if !(1..=1440).contains(&minutes) {
        return Err("Choose an interval between 1 and 1440 minutes".into());
    }
    let old = db::get(&db::open()?, "config")?;
    let mode = config["mode"]
        .as_str()
        .or(old["mode"].as_str())
        .unwrap_or("cloud");
    if !["cloud", "self-hosted"].contains(&mode) {
        return Err("Choose Cloud or Self-hosted".into());
    }
    let mut next = json!({"apiUrl":url,"syncMinutes":minutes,"mode":mode});
    for key in ["cloudUrl", "selfHostedUrl"] {
        let saved = config[key].as_str().or(old[key].as_str()).unwrap_or("");
        if !saved.is_empty() {
            db::validate_url(saved)?;
        }
        next[key] = json!(saved.trim_end_matches('/'));
    }
    if old["mode"].is_null() && next["cloudUrl"].as_str().unwrap_or("").is_empty() {
        next["cloudUrl"] = json!(old["apiUrl"].as_str().unwrap_or(""));
    }
    next[if mode == "cloud" {
        "cloudUrl"
    } else {
        "selfHostedUrl"
    }] = json!(url);
    Ok(next)
}
#[tauri::command]
pub fn configure(config: Value) -> Result<()> {
    let next = service_config(&config)?;
    let db = db::open()?;
    let old = db::get(&db, "config")?;
    let _lock = if old["apiUrl"] != next["apiUrl"] {
        Some(projects::lock()?)
    } else {
        None
    };
    if db::get(&db, "user")?.is_string() && old["apiUrl"] != next["apiUrl"] {
        return Err("Use Switch service to change your connection".into());
    }
    if old["apiUrl"] != next["apiUrl"] {
        auth::cancel()?;
    }
    db::set(&db, "config", &next)?;
    SyncQueue::request(&db, WORKSPACE, Priority::User, "service")
}
#[tauri::command]
pub fn switch_service(config: Value) -> Result<()> {
    let next = service_config(&config)?;
    let _lock = projects::lock()?;
    auth::sign_out()?;
    let db = db::open()?;
    db::set(&db, "config", &next)?;
    SyncQueue::request(&db, WORKSPACE, Priority::User, "service")
}
#[tauri::command]
pub fn open_legal_link(document: String) -> Result<()> {
    if !matches!(document.as_str(), "terms" | "privacy") {
        return Err("Unknown legal document".into());
    }
    // Keep the approved placeholder destination fixed; callers cannot launch
    // arbitrary URLs or local files through this sign-in action.
    let status = Command::new("/usr/bin/open")
        .arg("https://x.com")
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Cannot open your browser".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn open_web_link(url: String) -> Result<()> {
    let url = reqwest::Url::parse(&url).map_err(|_| "Invalid web link")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only HTTP and HTTPS links can be opened".into());
    }
    let status = tokio::process::Command::new("/usr/bin/open")
        .arg(url.as_str())
        .status()
        .await
        .map_err(|_| "Cannot open your browser")?;
    if !status.success() {
        return Err("Cannot open your browser".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn auth_capabilities(api_url: String) -> Result<Value> {
    auth::capabilities(api_url).await
}
#[tauri::command]
pub async fn begin_sign_in(method: String, email: Option<String>) -> Result<Value> {
    auth::begin(method, email).await
}
#[tauri::command]
pub async fn pending_email_sign_in() -> Result<Value> {
    tokio::task::spawn_blocking(auth::pending_email_sign_in)
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn complete_sign_in(callback: Option<String>, code: Option<String>) -> Result<Value> {
    let value = auth::complete(callback, code).await?;
    sync_now()?;
    Ok(value)
}
#[tauri::command]
pub fn cancel_sign_in() -> Result<()> {
    let config = db::open().and_then(|db| db::get(&db, "config")).ok();
    auth::cancel()?;
    if let Some(config) = config {
        crate::desktop_usage::lifecycle(&config, "auth_signin_cancelled");
    }
    Ok(())
}
#[tauri::command]
pub fn retry_sign_in_storage() -> Result<Value> {
    let value = auth::retry_storage()?;
    if value["signedIn"] == true {
        sync_now()?;
    }
    Ok(value)
}
#[tauri::command]
pub async fn sign_in(email: String, password: String) -> Result<Value> {
    let r = auth::sign_in(email, password).await?;
    if r["signedIn"] == true {
        sync_now()?;
    }
    Ok(r)
}
#[tauri::command]
pub fn sign_out() -> Result<()> {
    let _lock = projects::lock()?;
    let config = db::open().ok().and_then(|db| {
        db::get(&db, "user")
            .ok()?
            .is_string()
            .then(|| db::get(&db, "config").ok())
            .flatten()
    });
    auth::sign_out()?;
    if let Some(config) = config {
        crate::desktop_usage::lifecycle(&config, "auth_signout_completed");
    }
    Ok(())
}
#[tauri::command(async)]
pub fn sync_now() -> Result<()> {
    SyncQueue::request_all(&db::open()?, Priority::User, "sync now")
}
#[tauri::command]
pub fn cancel_sync(project_id: String) -> Result<()> {
    SyncQueue::cancel(&db::open()?, &project_id)
}
#[tauri::command]
pub fn sync_queue_state() -> Result<Value> {
    SyncQueue::states(&db::open()?, SyncQueue::now())
}
/// Bumped by `cancel_project_setup`; a create or join that is still waiting
/// for the workspace lock gives up once this changes.
static PROJECT_SETUP_CANCEL: AtomicU64 = AtomicU64::new(0);
/// Long enough for a busy sync to reach its next checkpoint; the dialog can be
/// cancelled sooner.
const PROJECT_SETUP_WAIT: Duration = Duration::from_secs(10 * 60);

#[tauri::command]
pub async fn cloud_action(
    action: String,
    input: Value,
    on_progress: Option<JavaScriptChannelId>,
    webview: tauri::Webview,
) -> Result<Value> {
    let progress = on_progress.map(|id| id.channel_on(webview));
    run_cloud_action(action, input, progress.as_ref()).await
}
pub(crate) async fn run_cloud_action(
    action: String,
    input: Value,
    progress: Option<&Channel<Value>>,
) -> Result<Value> {
    if action == "invite-capabilities" {
        let caps = sync::api("GET", "/v2/instance", None).await?;
        return Ok(json!({"email": caps["invites"]["email"] == true}));
    }
    cloud_action_scoped(action, input, None, progress).await
}
#[tauri::command]
pub fn cancel_project_setup() {
    PROJECT_SETUP_CANCEL.fetch_add(1, Ordering::SeqCst);
}
/// Takes the workspace lock for a project create or join. With a progress
/// channel, the caller can show that it is waiting for sync and cancel; without
/// one, a busy workspace fails at once as before.
async fn project_setup_lock(progress: Option<&Channel<Value>>) -> Result<fs::File> {
    let Some(progress) = progress else {
        return projects::lock();
    };
    let generation = PROJECT_SETUP_CANCEL.load(Ordering::SeqCst);
    if let Some(lock) = projects::try_lock()? {
        return Ok(lock);
    }
    let account = setup_account()?;
    let _ = progress.send(json!({"waiting": true}));
    let lock = tauri::async_runtime::spawn_blocking(move || {
        projects::wait_for_lock_unless(PROJECT_SETUP_WAIT, || {
            PROJECT_SETUP_CANCEL.load(Ordering::SeqCst) != generation
        })
    })
    .await
    .map_err(|error| error.to_string())??;
    // Sign-out or a service switch can win the lock first; the request was
    // meant for the account the dialog was opened in.
    if setup_account()? != account {
        return Err(
            "Your account or service changed while waiting for sync. Nothing was changed.".into(),
        );
    }
    let _ = progress.send(json!({"waiting": false}));
    Ok(lock)
}
fn setup_account() -> Result<(Value, Value)> {
    let db = db::open()?;
    Ok((
        db::get(&db, "user")?,
        db::get(&db, "config")?["apiUrl"].clone(),
    ))
}
pub(crate) async fn cloud_action_scoped(
    action: String,
    input: Value,
    scope: Option<(&str, &str)>,
    progress: Option<&Channel<Value>>,
) -> Result<Value> {
    let adding = action == "create" || action == "join";
    let sharing = if adding {
        Some(if input.get("sharing").is_some() {
            serde_json::from_value::<projects::Sharing>(input["sharing"].clone())
                .map_err(|_| "Invalid project sharing choices")?
        } else {
            projects::Sharing::new_project()
        })
    } else {
        None
    };
    // Save consent before the daemon can discover or scan this project.
    let _lock = if adding {
        Some(project_setup_lock(progress).await?)
    } else {
        None
    };
    if let Some((owner, service)) = scope {
        let db = db::open()?;
        if db::get(&db, "user")? != owner || db::get(&db, "config")?["apiUrl"] != service {
            return Err("Account or service changed. Reopen onboarding.".into());
        }
    }
    let mut request = input;
    if adding {
        request
            .as_object_mut()
            .ok_or("Invalid project input")?
            .remove("sharing");
    }
    if action == "join" {
        if let Some(service) = request
            .as_object_mut()
            .and_then(|input| input.remove("serviceUrl"))
        {
            let config = db::get(&db::open()?, "config")?;
            validate_invite_service(&service, &config["apiUrl"])?;
        }
    }
    if action == "create" {
        if let Ok(caps) = sync::api("GET", "/v2/projects/capabilities", None).await {
            if caps["governance"] == 1 {
                request["governance"] = json!(1);
            }
            if caps["rolePolicies"] == 1 {
                request["rolePolicies"] = json!(1);
            }
        }
    }
    let path = project_endpoint(&action)?;
    let mut r = sync::api("POST", path, Some(&request)).await?;
    if let Some(sharing) = sharing {
        let id = r["id"].as_str().ok_or("Missing project")?;
        let db = db::open()?;
        let mut project = db::rows(&db, "SELECT value FROM projects WHERE id=?", &[&id])?
            .into_iter()
            .next()
            .unwrap_or_else(|| json!({"id":id,"name":request["name"].as_str().unwrap_or("Joined project"),"role":if action == "create" {"owner"} else {"member"}}));
        project["sharing"] = json!(sharing);
        if !project["sources"].is_array() {
            project["sources"] = json!([]);
        }
        db::upsert(&db, "projects", id, id, &project)?;
        SyncQueue::request(&db, id, Priority::User, "project")?;
        // Creation has succeeded. A catalog outage must not lose consent or ask
        // the user to create the same project again; sync will refresh it later.
        if let Ok(list) = sync::api("GET", crate::projects::CATALOG_PATH, None).await {
            projects::merge_catalog(&db, &list)?;
        }
        let current = db::rows(&db, "SELECT value FROM projects WHERE id=?", &[&id])?
            .into_iter()
            .next()
            .unwrap_or(Value::Null);
        if (action == "create"
            || current["sources"].as_array().is_some_and(|sources| {
                sources
                    .iter()
                    .any(|source| source["repository"]["id"].is_string())
            }))
            && sync::api("GET", "/v2/instance", None)
                .await
                .is_ok_and(|caps| caps["repositories"]["github"] == 1)
        {
            r["repositorySetup"] = json!(true);
        }
    }
    Ok(r)
}

fn project_endpoint(action: &str) -> Result<&'static str> {
    Ok(match action {
        "create" => "/v2/projects",
        "invite" => "/v2/invites",
        "revoke-invite" => "/v2/invites/revoke",
        "preview-invite" => "/v2/invites/preview",
        "join" => "/v2/join",
        _ => return Err("Unknown project action".into()),
    })
}

#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum InvitePreview {
    Available {
        #[serde(rename = "projectName")]
        project_name: String,
        #[serde(rename = "expiresAt")]
        expires_at: String,
    },
    Unavailable,
    Unsupported,
}

impl InvitePreview {
    pub async fn fetch(token: &str, service: Option<String>) -> Result<Self> {
        if !INVITE_TOKEN.is_match(token) {
            return Err("Paste a valid Orka invite link or token.".into());
        }
        let service = match service {
            Some(service) => service,
            None => db::get(&db::open()?, "config")?["apiUrl"]
                .as_str()
                .ok_or("Configure the service")?
                .to_string(),
        };
        let url = db::validate_url(&service)?;
        let sent = {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|error| error.to_string())?
                .post(format!(
                    "{}{}",
                    url.as_str().trim_end_matches('/'),
                    project_endpoint("preview-invite")?
                ))
                .json(&json!({"token": token}))
                .send()
                .await
        };
        let Ok(response) = sent else {
            return Ok(Self::Unsupported);
        };
        let status = response.status().as_u16();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        Ok(match status {
            200 => Self::Available {
                project_name: body["projectName"]
                    .as_str()
                    .ok_or("Unreadable invite preview")?
                    .into(),
                expires_at: body["expiresAt"]
                    .as_str()
                    .ok_or("Unreadable invite preview")?
                    .into(),
            },
            410 => Self::Unavailable,
            _ => Self::Unsupported,
        })
    }
}

static INVITE_TOKEN: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[a-f0-9]{48}$").unwrap());

#[tauri::command]
pub async fn invite_preview(token: String, service_url: Option<String>) -> Result<Value> {
    let preview = InvitePreview::fetch(&token, service_url).await?;
    serde_json::to_value(preview).map_err(|error| error.to_string())
}

fn validate_invite_service(expected: &Value, current: &Value) -> Result<()> {
    let expected = db::validate_url(expected.as_str().ok_or("Invalid invite service")?)?;
    let current = db::validate_url(current.as_str().ok_or("Configure the service")?)?;
    if expected.as_str().trim_end_matches('/') != current.as_str().trim_end_matches('/') {
        return Err(
            "Switch to the invite's service and sign in before joining this project".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod invite_tests {
    use super::*;
    use std::io::{Read, Write};

    fn serve(status: u16, body: &'static str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            let _ = write!(
                stream,
                "HTTP/1.1 {status} Preview\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
        });
        format!("http://127.0.0.1:{port}")
    }

    #[test]
    fn preview_reports_the_project_or_one_of_two_fallbacks() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let token = "ab".repeat(24);
        for (status, body, expected) in [
            (
                200,
                r#"{"projectName":"Acme","expiresAt":"2027-01-02T03:04:05.000Z"}"#,
                json!({"status":"available","projectName":"Acme","expiresAt":"2027-01-02T03:04:05.000Z"}),
            ),
            (
                410,
                r#"{"error":"This invite is no longer valid. Ask the project owner for a new invite."}"#,
                json!({"status":"unavailable"}),
            ),
            (
                404,
                r#"{"error":"Not found"}"#,
                json!({"status":"unsupported"}),
            ),
        ] {
            let service = serve(status, body);
            let preview = runtime
                .block_on(invite_preview(token.clone(), Some(service)))
                .unwrap();
            assert_eq!(preview, expected);
        }
        assert_eq!(
            runtime
                .block_on(invite_preview(
                    token.clone(),
                    Some("http://127.0.0.1:1".into())
                ))
                .unwrap(),
            json!({"status":"unsupported"})
        );
        assert!(runtime
            .block_on(invite_preview("short".into(), None))
            .is_err());
    }

    #[test]
    fn invites_are_bound_to_the_selected_service() {
        assert!(validate_invite_service(
            &json!("https://ORKA.example:443/"),
            &json!("https://orka.example")
        )
        .is_ok());
        assert!(validate_invite_service(
            &json!("http://127.0.0.1:8080"),
            &json!("http://127.0.0.1:8080/")
        )
        .is_ok());
        for service in [
            json!(null),
            json!("https://other.example"),
            json!("https://orka.example/path"),
            json!("http://orka.example"),
            json!("https://user:secret@orka.example"),
        ] {
            assert!(validate_invite_service(&service, &json!("https://orka.example")).is_err());
        }
    }
}
#[tauri::command]
pub fn connect_project(id: String, path: String) -> Result<()> {
    let _lock = projects::lock()?;
    let db = db::open()?;
    projects::active(&db, &id)?;
    let mut p = db::rows(&db, "SELECT value FROM projects WHERE id=?", &[&id])?
        .into_iter()
        .next()
        .ok_or("Project not found; sync first")?;
    if p["sources"].is_array() {
        return Err("Use Add folders or Locate folder to connect a project source".into());
    }
    let root = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("Choose a folder".into());
    }
    for other in db::rows(&db, "SELECT value FROM projects WHERE id<>?", &[&id])? {
        if other["path"]
            .as_str()
            .is_some_and(|s| root.starts_with(s) || PathBuf::from(s).starts_with(&root))
        {
            return Err("Another project already covers this folder".into());
        }
    }
    if let Some(old) = p["path"].as_str() {
        if old != root.to_string_lossy() {
            return Err("Disconnect the project before changing its folder".into());
        }
    }
    native::Hooks::install(&root)?;
    p["folderIdentity"] = json!(indexer::folder_identity(&root)?);
    p["path"] = json!(root);
    db::upsert(&db, "projects", &id, &id, &p)?;
    SyncQueue::request(&db, &id, Priority::User, "project")?;
    Ok(())
}
#[tauri::command]
pub fn disconnect_project(id: String) -> Result<()> {
    let _lock = projects::lock()?;
    let db = db::open()?;
    let mut p = db::rows(&db, "SELECT value FROM projects WHERE id=?", &[&id])?
        .into_iter()
        .next()
        .ok_or("Project not found")?;
    if p["sources"].is_array() {
        return Err("Choose the source folder to disconnect in Settings".into());
    }
    p["path"] = Value::Null;
    db::upsert(&db, "projects", &id, &id, &p)?;
    db.execute(
        &format!(
            "DELETE FROM bindings WHERE project=?{}",
            crate::pi_sessions::KEEP_COPY_BINDINGS
        ),
        [id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub async fn session_display_title(id: String) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = db::open()?;
        let resource = crate::local_resources::resource(&db, &id)?;
        if resource["kind"] != "session" || resource["deleted"] == true {
            return Err("Session unavailable".into());
        }
        let snapshot = crate::session_forks::reading_resource(&db, &resource)?;
        Ok(crate::session_presentation::title(&snapshot.records()?))
    })
    .await
    .map_err(|error| error.to_string())?
}

const CONFLICT_PREVIEW_MISSING: &str = "Conflict changed; refresh before inspecting";

/// The stored resource, or a conflict's incoming candidate when previewing one.
fn inspection_candidate(
    db: &rusqlite::Connection,
    id: &str,
    conflict_id: Option<&str>,
) -> Result<Value> {
    let resource = match crate::local_resources::resource(db, id) {
        Ok(resource) if resource["deleted"] == true => {
            crate::global_skills::local_skill(db, id)?.unwrap_or(resource)
        }
        Ok(resource) => resource,
        Err(error) => crate::global_skills::local_skill(db, id)?.ok_or(error)?,
    };
    let Some(conflict_id) = conflict_id else {
        return Ok(resource);
    };
    let project_id = resource["projectId"].as_str().ok_or("Missing project")?;
    let conflict = db::rows(
        db,
        "SELECT value FROM conflicts WHERE id=? AND project=?",
        &[&conflict_id, &project_id],
    )?
    .into_iter()
    .next()
    .ok_or(CONFLICT_PREVIEW_MISSING)?;
    let candidate = &conflict["candidate"];
    if conflict["resourceId"] != id
        || candidate["resourceId"] != id
        || candidate["projectId"] != project_id
    {
        return Err("Conflict belongs to another resource".into());
    }
    Ok(candidate.clone())
}

fn inspected_resource(
    db: &rusqlite::Connection,
    id: &str,
    conflict_id: Option<&str>,
) -> Result<crate::history::SessionRead> {
    let resource = inspection_candidate(db, id, conflict_id)?;
    if conflict_id.is_some() {
        Ok(crate::history::SessionRead::stored(resource))
    } else {
        crate::session_forks::reading_resource(db, &resource)
    }
}

/// Parsed conversations for the few sessions a reader pages through at once.
/// Keyed by resource, conflict preview, and file hashes so new revisions miss.
type Conversations = Vec<(String, Arc<Vec<session_presentation::Message>>)>;
static CONVERSATIONS: LazyLock<Mutex<Conversations>> = LazyLock::new(|| Mutex::new(Vec::new()));

fn cached_conversation(key: &str) -> Result<Option<Arc<Vec<session_presentation::Message>>>> {
    Ok(CONVERSATIONS
        .lock()
        .map_err(|_| "Conversation cache unavailable")?
        .iter()
        .find(|(cached, _)| cached == key)
        .map(|(_, turns)| turns.clone()))
}

fn conversation_turns(
    snapshot: &crate::history::SessionRead,
    key: String,
) -> Result<Arc<Vec<session_presentation::Message>>> {
    if let Some(turns) = cached_conversation(&key)? {
        return Ok(turns);
    }
    let turns = Arc::new(session_presentation::conversation_messages(
        &snapshot.records()?,
    ));
    let mut cache = CONVERSATIONS
        .lock()
        .map_err(|_| "Conversation cache unavailable")?;
    if cache.len() >= 6 {
        cache.remove(0);
    }
    cache.push((key, turns.clone()));
    Ok(turns)
}

/// One page of readable conversation turns, oldest first. Reads happen off the
/// UI thread and only the requested window crosses the bridge.
#[tauri::command]
pub async fn session_messages(
    id: String,
    conflict_id: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = db::open()?;
        let resource = inspection_candidate(&db, &id, conflict_id.as_deref())?;
        if resource["deleted"] == true {
            return Ok(json!({"messages":[],"total":0,"offset":0,"removed":true}));
        }
        if resource["kind"] != "session" {
            return Err("Not a session".into());
        }
        let key = |resource: &Value| {
            format!(
                "{id}:{}:{}",
                conflict_id.as_deref().unwrap_or_default(),
                session_snapshot_hash(resource)
            )
        };
        let cached = if conflict_id.is_none() && resource["nativeSession"] == true {
            cached_conversation(&key(&resource))?.filter(|_| {
                crate::local_resources::unchanged_session_manifest(&db, &resource).unwrap_or(false)
            })
        } else {
            None
        };
        let turns = match cached {
            Some(turns) => turns,
            None => {
                let snapshot = if conflict_id.is_some() {
                    crate::history::SessionRead::stored(resource)
                } else {
                    crate::session_forks::reading_resource(&db, &resource)?
                };
                conversation_turns(&snapshot, key(&snapshot.resource))?
            }
        };
        let total = turns.len();
        let offset = offset.unwrap_or(0).min(total);
        let limit = limit.unwrap_or(40).clamp(1, 200);
        let end = (offset + limit).min(total);
        Ok(json!({"messages":&turns[offset..end],"total":total,"offset":offset}))
    })
    .await
    .map_err(|error| error.to_string())?
}
/// Reads a resource file for display or copying. `max_bytes` is the reader's
/// render budget for a session transcript: above it, no text crosses the bridge
/// and the reader offers a download instead. Callers that need the whole text,
/// such as Copy content, omit it.
#[tauri::command]
pub fn inspect_resource(
    id: String,
    file: String,
    conflict_id: Option<String>,
    max_bytes: Option<usize>,
) -> Result<Value> {
    let db = db::open()?;
    let snapshot = inspected_resource(&db, &id, conflict_id.as_deref())?;
    let r = &snapshot.resource;
    if r["deleted"] == true {
        return Ok(
            json!({"content":"This version removes the session from shared history.","previous":null,"paths":null}),
        );
    }
    if let Some(limit) = max_bytes.filter(|_| r["kind"] == "session" && file == "session.jsonl") {
        // The reader only uses the transcript. Avoid reading the previous
        // revision or building secondary representations for this request.
        let records = snapshot.records()?;
        let transcript = native::transcript(&records);
        if transcript.len() > limit {
            let session_snapshot = SessionSnapshotDownload {
                conflict_id,
                snapshot_hash: session_snapshot_hash(r),
            };
            return Ok(
                json!({"content":null,"previous":null,"paths":null,"tooLarge":true,"size":transcript.len(),"sessionSnapshot":session_snapshot}),
            );
        }
        return Ok(json!({"content":transcript,"previous":null,"paths":null}));
    }
    let f = r["files"]
        .as_array()
        .ok_or("Missing files")?
        .iter()
        .find(|f| f["path"] == file)
        .ok_or("File not found")?;
    let bytes = snapshot.read_blob(f["hash"].as_str().ok_or("Missing hash")?)?;
    let binding = indexer::binding(&db, &id)?;
    let previous = binding["previous"]["files"]
        .as_array()
        .and_then(|a| a.iter().find(|f| f["path"] == file))
        .and_then(|f| f["hash"].as_str())
        .and_then(|h| db::blob_read(h).ok())
        .and_then(|b| String::from_utf8(b).ok());
    let (content, messages, conversation) = if r["kind"] == "session" && file == "session.jsonl" {
        let records = snapshot.records()?;
        (
            Some(native::transcript(&records)),
            Some(native::transcript_messages(&records)),
            Some(crate::session_presentation::conversation(&records)),
        )
    } else {
        (String::from_utf8(bytes).ok(), None, None)
    };
    Ok(
        json!({"content":content,"previous":previous,"paths":if r["paths"].is_array() { &r["paths"] } else { &binding["paths"] },"messages":messages,"conversation":conversation}),
    )
}
#[tauri::command]
pub fn open_editor(id: String, file: String) -> Result<()> {
    let db = db::open()?;
    let b = indexer::binding(&db, &id)?;
    let r = inspected_resource(&db, &id, None)?.resource;
    if r["local"] == true || r["localChanges"] == true {
        let project =
            crate::governance::project(&db, r["projectId"].as_str().ok_or("Missing project")?)?;
        crate::sources::validate(
            &crate::sources::for_resource(&project, &r)
                .ok_or("Connect this resource's repository")?,
        )?;
    }
    if r["kind"] == "session" {
        return Err("Use Resume for sessions".into());
    }
    let mut path = PathBuf::from(
        (if r["paths"].is_array() {
            &r["paths"]
        } else {
            &b["paths"]
        })[0]
            .as_str()
            .ok_or("File is not materialized yet")?,
    );
    if r["kind"] == "skill" {
        path = path.join(packages::safe_relative(&file)?);
    }
    if !path.is_file() {
        return Err("File unavailable".into());
    }
    Command::new("/usr/bin/open")
        .arg("-t")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub fn session_action(
    id: String,
    action: String,
    conflict_id: Option<String>,
    selected: Option<String>,
) -> Result<()> {
    let db = db::open()?;
    let r = db::rows(&db, "SELECT value FROM resources WHERE id=?", &[&id])?
        .into_iter()
        .next()
        .ok_or("Session not found")?;
    let project = r["projectId"].as_str().ok_or("Missing project")?;
    projects::active(&db, project)?;
    if action == "delete" {
        let project_state = crate::governance::project(&db, project)?;
        if project_state["rolePolicies"].is_object()
            && project_state["role"] != "owner"
            && !(project_state["role"] == "admin" && r["access"]["mode"] == "publish")
        {
            return Err(
                "Only the Owner or an Admin with write access can delete shared content".into(),
            );
        }
    }
    let input = if let Some(c) = conflict_id {
        if !["keep", "override", "copy"].contains(&action.as_str()) {
            return Err("Invalid conflict action".into());
        }
        let selected = selected.ok_or("Choose a version")?;
        if !["current", "candidate"].contains(&selected.as_str()) {
            return Err("Invalid selection".into());
        }
        json!({"version":2,"id":Uuid::new_v4().to_string(),"projectId":project,"deviceId":db::device(&db)?,"resourceId":id,"expectedRevision":r["revision"],"conflictId":c,"action":action,"selected":selected})
    } else if action == "copy" {
        sync::queue_session_snapshot(&db, &r, &db::device(&db)?)?;
        return SyncQueue::request(&db, project, Priority::User, "session");
    } else if action == "delete" {
        let mut resource = r.clone();
        for key in [
            "projectId",
            "revision",
            "owner",
            "updatedBy",
            "updatedAt",
            "hash",
            "access",
        ] {
            resource
                .as_object_mut()
                .ok_or("Invalid resource")?
                .remove(key);
        }
        resource["deleted"] = json!(true);
        resource["files"] = json!([]);
        json!({"version":2,"id":Uuid::new_v4().to_string(),"projectId":project,"deviceId":db::device(&db)?,"baseRevision":r["revision"],"resource":resource})
    } else {
        return Err("Invalid session action".into());
    };
    if input["conflictId"].is_string() {
        sync::queue_session_resolution(&db, &input)?;
    } else {
        indexer::queue(&db, project, "/v2/sync/push", &input)?;
    }
    SyncQueue::request(&db, project, Priority::User, "session")
}
/// Pin the owner's explicit choice to the deleted revision and incoming version
/// that were actually reviewed. The server checks the same revision on delivery.
#[tauri::command]
pub fn resolve_session_recovery(
    project_id: String,
    id: String,
    expected_revision: i64,
    conflict_id: String,
    choice: String,
    single_candidate: bool,
) -> Result<()> {
    let mut db = db::open()?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    projects::active(&tx, &project_id)?;
    let changed = "The session changed. Review it again before choosing.";
    let current = db::rows(
        &tx,
        "SELECT value FROM resources WHERE project=? AND id=?",
        &[&project_id, &id],
    )?
    .into_iter()
    .next()
    .ok_or(changed)?;
    let conflicts = db::rows(
        &tx,
        "SELECT value FROM conflicts WHERE project=? AND json_extract(value,'$.resourceId')=?",
        &[&project_id, &id],
    )?;
    let conflict = conflicts
        .iter()
        .find(|c| c["id"] == conflict_id)
        .ok_or(changed)?;
    let incoming = &conflict["candidate"];
    if expected_revision <= 0
        || current["revision"] != expected_revision
        || current["kind"] != "session"
        || current["deleted"] != true
        || incoming["deleted"] != false
        || incoming["kind"] != "session"
        || incoming["resourceId"] != id
        || incoming["projectId"] != project_id
        || incoming["files"].as_array().is_none_or(Vec::is_empty)
        || (single_candidate && conflicts.len() != 1)
    {
        return Err(changed.into());
    }
    let user = db::get(&tx, "user")?;
    let (action, selected) = match choice.as_str() {
        "keep" => ("keep", "current"),
        "restore" => ("override", "candidate"),
        "copy" if !single_candidate => ("copy", "candidate"),
        _ => return Err("Invalid recovery choice".into()),
    };
    if user.as_str().is_none_or(str::is_empty)
        || (action == "copy"
            && (incoming["owner"] != user
                || conflict["author"] != user
                || (current["access"].is_object()
                    && (current["access"]["mode"] == "hidden"
                        || current["access"]["create"]
                            .as_str()
                            .is_some_and(|mode| mode != "publish")))))
        || (action != "copy"
            && (current["owner"] != user
                || (current["access"].is_object() && current["access"]["mode"] != "publish")))
    {
        return Err("You do not have permission to queue this choice.".into());
    }
    if single_candidate
        && (conflict["author"] != user
            || incoming["owner"] != user
            || incoming["updatedBy"] != user
            || incoming["source"] != current["source"]
            || incoming["sourceId"] != current["sourceId"]
            || incoming["logicalPath"] != current["logicalPath"]
            || conflict["revision"] != expected_revision
            || incoming["revision"] != expected_revision
            || conflict["deviceId"].as_str().is_none_or(str::is_empty)
            || incoming["updatedAt"]
                .as_str()
                .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
                .is_none())
    {
        return Err(changed.into());
    }
    if single_candidate {
        let binding = indexer::binding(&tx, &id)?;
        let has_other_error: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM errors WHERE source=? AND error<>?)",
                rusqlite::params![
                    id,
                    "Session conflict: choose Keep, Override, or Create copy"
                ],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if binding["needsCopy"] == true
            || matches!(
                binding["installationState"].as_str(),
                Some("update_available" | "review_pending" | "locally_modified")
            )
            || has_other_error
        {
            return Err("Local changes need individual review.".into());
        }
    } else {
        // This exact server response proves the older choice was rejected.
        // A transport error or a pending request can still receive a receipt.
        let rejected = db::rows(&tx,
            "SELECT json_object('id',id) FROM outbox WHERE project=? AND path='/v2/sessions/resolve' AND error='409: Conflict changed; refresh before resolving' AND json_extract(value,'$.resourceId')=? AND json_extract(value,'$.expectedRevision')<?",
            &[&project_id, &id, &expected_revision])?;
        for row in rejected {
            let prior_id = row["id"].as_str().ok_or("Missing rejected request ID")?;
            tx.execute("DELETE FROM outbox WHERE id=?", [prior_id])
                .map_err(|e| e.to_string())?;
            sync::clear_session_copy(&tx, prior_id)?;
        }
    }
    let pending: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM outbox WHERE project=? AND coalesce(json_extract(value,'$.resourceId'),json_extract(value,'$.resource.resourceId'))=?)",
        rusqlite::params![project_id, id], |row| row.get(0)
    ).map_err(|e| e.to_string())?;
    if pending {
        return Err(
            "A change for this session is already queued. Check Sync before choosing again.".into(),
        );
    }
    let input = json!({"version":2,"id":Uuid::new_v4().to_string(),"projectId":project_id,"deviceId":db::device(&tx)?,"resourceId":id,"expectedRevision":expected_revision,"conflictId":conflict_id,"action":action,"selected":selected});
    sync::store_recovery_resolution(&tx, &input)?;
    SyncQueue::request(&tx, &project_id, Priority::User, "session")?;
    tx.commit().map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn session_launch_options(
    id: String,
) -> Result<Vec<crate::session_launcher::LaunchOption>> {
    tauri::async_runtime::spawn_blocking(move || crate::session_launcher::options(&id))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn session_handoff_prompt(id: String) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || crate::session_launcher::handoff_prompt(&id))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn resume_session(
    id: String,
    tool: String,
    destination: Option<crate::session_launcher::Destination>,
    fork: Option<bool>,
) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let tool = crate::session_launcher::Tool::parse(&tool)?;
        let destination = destination.unwrap_or(crate::session_launcher::Destination::Desktop);
        if fork.unwrap_or(false) {
            crate::session_launcher::launch(&id, tool, destination, true)
        } else {
            crate::session_launcher::resume(&id, tool, destination)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshotDownload {
    #[serde(skip_serializing_if = "Option::is_none")]
    conflict_id: Option<String>,
    snapshot_hash: String,
}

const SESSION_SNAPSHOT_CHANGED: &str = "session_snapshot_changed";

/// A fork can materialize new history without changing its catalog revision.
/// Compare the actual session files and provider; title or timestamp edits do
/// not change the transcript or its ancestry.
fn session_snapshot_hash(session: &Value) -> String {
    let mut files = session["files"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|file| (file["path"].as_str(), file["hash"].as_str()))
        .collect::<Vec<_>>();
    files.sort_by_key(|file| file.0);
    let snapshot = json!([
        session["projectId"],
        session["resourceId"],
        session["source"],
        files
    ]);
    db::digest(snapshot.to_string().as_bytes())
}

#[tauri::command]
pub fn export_bundle(
    id: String,
    path: String,
    session_snapshot: Option<SessionSnapshotDownload>,
) -> Result<()> {
    let db = db::open()?;
    let path = PathBuf::from(path);
    let Some(snapshot) = session_snapshot else {
        return bundles::export(&db, &id, &path);
    };
    let resource =
        inspected_resource(&db, &id, snapshot.conflict_id.as_deref()).map_err(|error| {
            if error == CONFLICT_PREVIEW_MISSING {
                SESSION_SNAPSHOT_CHANGED.into()
            } else {
                error
            }
        })?;
    if resource.resource["kind"] != "session" {
        return Err("Choose a session version to download".into());
    }
    if session_snapshot_hash(&resource.resource) != snapshot.snapshot_hash {
        return Err(SESSION_SNAPSHOT_CHANGED.into());
    }
    bundles::export_snapshot(&db, &resource, &path)
}
/// Exports the authorized snapshot, returning true when fresh capture was
/// unavailable for a restorable deleted project.
pub(crate) fn export_project_with_capture(
    cache: &db::CacheScope,
    project_id: &str,
    destination: &std::path::Path,
) -> Result<bool> {
    let capture_only: bool = cache
        .open_read_only()?
        .query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND {})",
                projects::CAPTURE_ONLY
            ),
            [project_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let mut cached_only = false;
    if capture_only {
        if let Some(_workspace) = projects::try_lock()? {
            // Capture writes blobs in the current service. Verify that it is
            // still the invocation's service under the same lock as a switch.
            if db::CacheScope::current()? != *cache {
                return Err("The Orka account or service changed during export. Export again from the project.".into());
            }
            let db = cache.open()?;
            cached_only = match sync::capture_held(&db, project_id) {
                Ok(complete) => !complete,
                Err(error) => {
                    let _ = sync::record_result(&db, project_id, Err(error));
                    true
                }
            };
        } else {
            cached_only = true;
        }
    }
    // Compress a scoped, read-only snapshot after releasing the capture lock.
    bundles::export_project(cache, project_id, destination)?;
    Ok(cached_only)
}

/// Keeps a copy of an inactive project's work before it leaves this Mac.
#[tauri::command]
pub async fn export_project(project_id: String, destination: String) -> Result<bool> {
    let cache = db::CacheScope::current()?;
    tauri::async_runtime::spawn_blocking(move || {
        export_project_with_capture(&cache, &project_id, &PathBuf::from(destination))
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub fn import_bundle(
    project_id: String,
    path: String,
    source_id: Option<String>,
) -> Result<String> {
    let db = db::open()?;
    if db::rows(&db, "SELECT value FROM projects WHERE id=?", &[&project_id])?.is_empty() {
        return Err("Project not found".into());
    }
    projects::active(&db, &project_id)?;
    bundles::import_into_source(&db, &project_id, &PathBuf::from(path), source_id.as_deref())
}
#[tauri::command]
pub async fn retry_uploads(project_id: Option<String>) -> Result<()> {
    let scope = {
        let _lock = projects::lock()?;
        let db = db::open()?;
        let scope = if let Some(project) = &project_id {
            projects::active(&db, project)?;
            Some((
                db::get(&db, "user")?
                    .as_str()
                    .ok_or("Sign in required")?
                    .to_string(),
                db::get(&db, "config")?["apiUrl"]
                    .as_str()
                    .ok_or("Configure the service")?
                    .to_string(),
                project.clone(),
                db::get(&db, "sync")?,
                db::rows(&db,"SELECT json_object('error',error) FROM outbox WHERE project=? AND error IS NOT NULL AND (error NOT GLOB '4[0-9][0-9]:*' OR substr(error,1,3) IN ('401','408','429'))", &[&project])?
                    .into_iter()
                    .filter_map(|item| item["error"].as_str().map(str::to_string))
                    .collect::<Vec<_>>(),
            ))
        } else {
            None
        };
        if project_id.is_none() {
            db.execute(
                "DELETE FROM outbox WHERE path='/v2/sessions/resolve' AND error LIKE '409:%'",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
        db.execute("UPDATE outbox SET error=NULL WHERE ?1 IS NULL OR (project=?1 AND (error IS NULL OR error NOT GLOB '4[0-9][0-9]:*' OR substr(error,1,3) IN ('401','408','429')))", [&project_id])
            .map_err(|e| e.to_string())?;
        scope
    };
    if let Some((owner, origin, project, previous_sync, retried_errors)) = scope {
        tauri::async_runtime::spawn_blocking(move || {
            tokio::runtime::Runtime::new()
                .map_err(|error| error.to_string())?
                .block_on(sync::plugin_once(&owner, &origin, &project))?;
            let _lock = projects::wait_for_lock(std::time::Duration::from_secs(5))?;
            sync::settle_retry_error(
                &db::open()?,
                &owner,
                &origin,
                &previous_sync,
                &retried_errors,
            )
            .map(|_| ())
        })
        .await
        .map_err(|error| error.to_string())?
    } else {
        SyncQueue::request_all(&db::open()?, Priority::User, "retry")
    }
}
#[tauri::command]
pub fn background_agent(enabled: bool) -> Result<()> {
    #[cfg(debug_assertions)]
    if std::env::var_os("ORKA_TEST_HOME").is_some() {
        if enabled {
            return Err(
                "Background sync can’t be enabled in this test build. Choose Not now to continue."
                    .into(),
            );
        }
        return db::set(&db::open()?, "background", &json!(false));
    }
    let home = db::home()?;
    let directory = home.join("Library/LaunchAgents");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let label = crate::profiles::label();
    let path = directory.join(format!("{label}.plist"));
    let uid = Command::new("/usr/bin/id")
        .arg("-u")
        .output()
        .map_err(|e| e.to_string())?;
    let domain = format!("gui/{}", String::from_utf8_lossy(&uid.stdout).trim());
    let db = db::open()?;
    // The app-open worker yields its lock at the next safe cycle boundary.
    db::set(&db, "backgroundHandoff", &json!(enabled))?;
    let _ = Command::new("/bin/launchctl")
        .args(["bootout", &domain, &path.to_string_lossy()])
        .output();
    let result = (|| -> Result<()> {
        if enabled {
            let exe = crate::updates::executable()
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            let xml = format!(
                r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>{label}</string><key>ProgramArguments</key><array><string>{exe}</string><string>--orka-agent</string><string>--profile</string><string>{profile}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer></dict></plist>"#,
                profile = crate::profiles::current()
            );
            db::atomic(&path, xml.as_bytes())?;
            let output = Command::new("/bin/launchctl")
                .args(["bootstrap", &domain, &path.to_string_lossy()])
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err("Enable Orka in macOS Login Items to start the sync service".into());
            }
        } else if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        db::set(&db, "background", &json!(enabled))
    })();
    db::set(&db, "backgroundHandoff", &json!(false))?;
    result
}
pub fn ensure_agent() -> Result<()> {
    let db = db::open()?;
    // A process interrupted during registration must not suppress app-open sync.
    db::set(&db, "backgroundHandoff", &json!(false))?;
    if db::get(&db, "background")?.is_null() && crate::onboarding::snapshot(&db)?["active"] == true
    {
        return Ok(());
    }
    if !db::get(&db, "background")?
        .as_bool()
        .unwrap_or(crate::profiles::background_default())
    {
        return Ok(());
    }
    let lock = db::daemon_lock()?;
    use fs2::FileExt;
    if lock.try_lock_exclusive().is_err() {
        if db::get(&db, "daemon")?["executableIdentity"] != db::executable_identity()? {
            return background_agent(true);
        }
        return Ok(());
    }
    FileExt::unlock(&lock).map_err(|e| e.to_string())?;
    background_agent(true)
}
