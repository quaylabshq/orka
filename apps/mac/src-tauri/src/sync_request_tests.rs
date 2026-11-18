//! Each former writer of the `syncRequest` flag now queues the projects it
//! changed. The flag stays readable for older builds, but nothing here writes it.
use super::*;
use crate::sync_queue::WORKSPACE;

fn queue(f: &Fixture) -> Vec<Value> {
    db::rows(
        &f.db,
        "SELECT json_object('project',project,'priority',priority,'reason',reason) FROM sync_queue ORDER BY project",
        &[],
    )
    .unwrap()
}

fn assert_user(job: &Value, project: &str, reason: &str) {
    assert_eq!(job["project"], json!(project));
    assert_eq!(job["priority"], json!(2), "{job}");
    assert_eq!(job["reason"], json!(reason), "{job}");
}

#[test]
fn sync_now_queues_the_workspace_and_every_project_at_user_priority() {
    let f = Fixture::new();
    crate::commands::sync_now().unwrap();
    let jobs = queue(&f);
    let projects: Vec<_> = jobs.iter().map(|job| job["project"].as_str()).collect();
    assert_eq!(projects, [Some(WORKSPACE), f.project["id"].as_str()]);
    for job in &jobs {
        assert_user(job, job["project"].as_str().unwrap(), "sync now");
    }
    assert!(db::get(&f.db, "syncRequest").unwrap().is_null());
}

#[test]
fn a_service_change_queues_only_the_workspace_at_user_priority() {
    let f = Fixture::new();
    db::set(&f.db, "user", &Value::Null).unwrap();
    crate::commands::configure(json!({"apiUrl":"https://service.example","syncMinutes":15}))
        .unwrap();
    let jobs = queue(&f);
    assert_eq!(jobs.len(), 1, "{jobs:?}");
    assert_user(&jobs[0], WORKSPACE, "service");
}

#[test]
fn connecting_a_project_folder_queues_that_project_at_user_priority() {
    let f = Fixture::new();
    let id = f.project["id"].as_str().unwrap().to_string();
    crate::commands::connect_project(id.clone(), f.root.to_string_lossy().into()).unwrap();
    let jobs = queue(&f);
    assert_eq!(jobs.len(), 1, "{jobs:?}");
    assert_user(&jobs[0], &id, "project");
}

#[test]
fn a_session_action_queues_that_project_at_user_priority() {
    let f = Fixture::new();
    let mut project = f.project.clone();
    project["role"] = json!("owner");
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &project,
    )
    .unwrap();
    let resource = json!({"resourceId":uuid::Uuid::new_v4().to_string(),"kind":"session","source":"claude","projectId":f.project["id"],"revision":1,"files":[],"deleted":false,"access":{"mode":"publish"}});
    let id = resource["resourceId"].as_str().unwrap().to_string();
    db::upsert(
        &f.db,
        "resources",
        &id,
        f.project["id"].as_str().unwrap(),
        &resource,
    )
    .unwrap();
    crate::commands::session_action(id, "delete".into(), None, None).unwrap();
    let jobs = queue(&f);
    assert_eq!(jobs.len(), 1, "{jobs:?}");
    assert_user(&jobs[0], f.project["id"].as_str().unwrap(), "session");
}

#[test]
fn a_teammates_changed_session_queues_its_project_at_local_priority() {
    let f = Fixture::new();
    let native_id = uuid::Uuid::new_v4().to_string();
    let resource = uuid::Uuid::new_v4().to_string();
    let directory = native::claude_home().unwrap().join("projects/test");
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join(format!("{native_id}.jsonl"));
    let records = [
        json!({"type":"user","cwd":f.root,"sessionId":native_id,"version":"2.1.286","message":{"role":"user","content":"Teammate turn"}}),
    ];
    fs::write(&path, native::encode(&records)).unwrap();
    // A session this Mac did not create: its contents changed locally, so the
    // project needs one more sync to send a copy back.
    let binding = json!({"nativeId":native_id,"paths":[path],"lastSeenHash":"stale","base":{"resourceId":resource,"owner":uuid::Uuid::new_v4().to_string(),"projectId":f.project["id"]}});
    db::upsert(
        &f.db,
        "bindings",
        &resource,
        f.project["id"].as_str().unwrap(),
        &binding,
    )
    .unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let jobs = queue(&f);
    assert_eq!(jobs.len(), 1, "{jobs:?}");
    assert_eq!(jobs[0]["project"], f.project["id"]);
    assert_eq!(jobs[0]["priority"], 1, "{jobs:?}");
    assert_eq!(jobs[0]["reason"], "indexer");
    assert!(db::get(&f.db, "syncRequest").unwrap().is_null());
}
