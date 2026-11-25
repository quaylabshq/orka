use crate::{
    db::{self, Result},
    indexer, native, packages, sync,
    sync_queue::{Priority, SyncQueue},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Seek, Write},
    path::Path,
};
use uuid::Uuid;

/// Writes the accepted, private and pending snapshots separately. A queued edit
/// can be newer than both reading catalogs, and every version remains recoverable
/// without changing a retry identity or touching the user's files.
pub fn export_project(cache: &db::CacheScope, project: &str, path: &Path) -> Result<()> {
    let db = cache.open_read_only()?;
    let cached_blob = cache.blob_reader();
    // The WAL snapshot covers both the queue and the manifests it references.
    // Release it before compression, which only reads content-addressed files.
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let saved = exportable_project(&tx, project)?;
    let policy_key = format!("policyRevision:{project}");
    let policy = db::get(&tx, &policy_key)?;
    let mut live_copies = std::collections::HashMap::new();
    let resources = db::rows(
        &tx,
        "SELECT value FROM resources WHERE project=? AND coalesce(json_extract(value,'$.deleted'),0)=0 ORDER BY id",
        &[&project],
    )?
    .into_iter()
    .map(|resource| {
        // Export a private Pi copy with the turns added since it was made. Keep
        // its bytes in memory: export reads the pinned cache and never writes
        // into the current service's blob store.
        let id = resource["resourceId"].as_str().ok_or("Missing resource")?;
        let binding = indexer::binding(&tx, id)?;
        if !crate::pi_sessions::is_private_copy(&binding) {
            return Ok(resource);
        }
        let bytes = crate::pi_sessions::copy_snapshot_bytes(&binding, &resource, &cached_blob)?;
        let hash = db::digest(&bytes);
        let current = crate::pi_sessions::with_session_file(&resource, &bytes, &hash);
        live_copies.insert(hash, bytes);
        Ok(current)
    })
    .collect::<Result<Vec<_>>>()?;
    let read_blob = |hash: &str| {
        live_copies
            .get(hash)
            .cloned()
            .map_or_else(|| cached_blob(hash), Ok)
    };
    let drafts = db::rows(
        &tx,
        "SELECT value FROM drafts WHERE project=? ORDER BY id",
        &[&project],
    )?;
    let mut local = Vec::new();
    for kind in ["memory", "session", "plan"] {
        local.extend(
            crate::local_resources::cached_catalog(&tx, &saved, kind)?["resources"]
                .as_array()
                .ok_or("Invalid local resource catalog")?
                .iter()
                .cloned(),
        );
    }
    let pending = db::rows(
        &tx,
        "SELECT json_object('id',id,'path',path,'value',json(value)) FROM outbox WHERE project=? ORDER BY rowid",
        &[&project],
    )?
    .into_iter()
    .map(|change| {
        let resource = if matches!(
            change["path"].as_str(),
            Some("/v2/sessions/copy" | "/v2/sessions/resolve")
        ) {
            Some(sync::queued_session_snapshot(&tx, &change["value"])?.ok_or(
                "The queued session snapshot is unavailable; keep this project on this Mac",
            )?)
        } else {
            None
        };
        Ok((change, resource))
    })
    .collect::<Result<Vec<_>>>()?;
    let conflicts =
        if saved["revoked"] == true || saved["purged"] == true || saved["detachedAt"].is_string() {
            Vec::new()
        } else {
            db::rows(
                &tx,
                "SELECT value FROM conflicts WHERE project=? ORDER BY id",
                &[&project],
            )?
        };
    tx.commit().map_err(|e| e.to_string())?;
    let header = json!({"version":1,"exportedAt":db::now(),"project":{"id":saved["id"],"name":crate::projects::display_name(&saved),"role":saved["role"]},"resources":resources.len(),"localResources":local.len(),"drafts":drafts.len(),"pendingChanges":pending.len(),"conflicts":conflicts.len()});
    let parent = path.parent().ok_or("Missing output parent")?;
    if !parent.is_dir() {
        return Err("Choose an existing folder for the export".into());
    }
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    {
        let mut zip = zip::ZipWriter::new(staged.as_file_mut());
        let options = options();
        write_json(&mut zip, "project.json", &header, options)?;
        for r in &resources {
            let folder = format!(
                "resources/{}/",
                r["resourceId"].as_str().ok_or("Missing resource")?
            );
            write_project_resource(&mut zip, options, r, &folder, &read_blob)?;
        }
        for r in &local {
            let folder = format!(
                "local-resources/{}/",
                r["resourceId"].as_str().ok_or("Missing resource")?
            );
            if r["nativeSession"] == true {
                match crate::local_resources::export_session(&db, &saved, r)? {
                    Some(snapshot) => {
                        let current =
                            crate::history::SessionRead::from_snapshot(r.clone(), snapshot);
                        write_project_resource(
                            &mut zip,
                            options,
                            &current.resource,
                            &folder,
                            &|hash| current.read_blob(hash),
                        )?;
                    }
                    None => {
                        let cached = r["files"].as_array().is_some_and(|files| {
                            !files.is_empty()
                                && files.iter().all(|file| {
                                    file["hash"]
                                        .as_str()
                                        .is_some_and(|hash| read_blob(hash).is_ok())
                                })
                        });
                        if cached {
                            write_project_resource(&mut zip, options, r, &folder, &read_blob)?;
                        } else {
                            let mut unavailable = r.clone();
                            unavailable["files"] = json!([]);
                            unavailable["contentUnavailable"] = json!(true);
                            write_json(
                                &mut zip,
                                &format!("{folder}resource.json"),
                                &unavailable,
                                options,
                            )?;
                        }
                    }
                }
            } else {
                write_project_resource(&mut zip, options, r, &folder, &read_blob)?;
            }
        }
        for draft in &drafts {
            let folder = format!("drafts/{}/", draft["id"].as_str().ok_or("Missing draft")?);
            write_json(&mut zip, &format!("{folder}draft.json"), draft, options)?;
            write_blobs(&mut zip, options, &draft["resource"], &folder, &read_blob)?;
        }
        for conflict in &conflicts {
            let folder = format!(
                "conflicts/{}/",
                conflict["id"].as_str().ok_or("Missing conflict ID")?
            );
            write_json(
                &mut zip,
                &format!("{folder}conflict.json"),
                conflict,
                options,
            )?;
            write_project_resource(
                &mut zip,
                options,
                &conflict["candidate"],
                &folder,
                &read_blob,
            )?;
        }
        for (change, snapshot) in &pending {
            let folder = format!(
                "pending/{}/",
                change["id"].as_str().ok_or("Missing request ID")?
            );
            write_json(&mut zip, &format!("{folder}request.json"), change, options)?;
            let resource = if let Some(snapshot) = snapshot {
                snapshot
            } else if change["value"]["resource"]["files"].is_array() {
                &change["value"]["resource"]
            } else {
                continue;
            };
            write_project_resource(&mut zip, options, resource, &folder, &read_blob)?;
        }
        zip.finish().map_err(|e| e.to_string())?;
    }
    staged.as_file().sync_all().map_err(|e| e.to_string())?;
    if db::CacheScope::current()? != *cache {
        return Err(
            "The Orka account or service changed during export. Export again from the project."
                .into(),
        );
    }
    // The export represents the authorized snapshot taken above. Discard it
    // if a subsequent access or lifecycle change is visible before publication.
    let current = exportable_project(&db, project)?;
    if [
        "revoked",
        "purged",
        "detachedAt",
        "role",
        "archivedAt",
        "deletedAt",
        "lifecycleRevision",
        "policyRevision",
    ]
    .iter()
    .any(|key| saved[*key] != current[*key])
        || db::get(&db, &policy_key)? != policy
    {
        return Err("Access to this project changed during export. Try exporting again.".into());
    }
    staged.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

fn exportable_project(db: &rusqlite::Connection, project: &str) -> Result<Value> {
    let saved = db::rows(db, "SELECT value FROM projects WHERE id=?", &[&project])?
        .into_iter()
        .next()
        .filter(|saved| saved["hidden"] != true)
        .ok_or("Project not found")?;
    // The catalog records lost access before detaching cached teammate data.
    if (saved["revoked"] == true || saved["purged"] == true) && !saved["detachedAt"].is_string() {
        return Err(
            "Orka is still updating access to this project. Try exporting again shortly.".into(),
        );
    }
    Ok(saved)
}

fn write_project_resource<W: Write + Seek>(
    zip: &mut zip::ZipWriter<W>,
    options: zip::write::SimpleFileOptions,
    resource: &Value,
    folder: &str,
    read_blob: &impl Fn(&str) -> Result<Vec<u8>>,
) -> Result<()> {
    write_json(zip, &format!("{folder}resource.json"), resource, options)?;
    write_blobs(zip, options, resource, folder, read_blob)?;
    // Original native histories may be unavailable; the cached manifest and
    // bytes are still exported even if a readable transcript cannot be built.
    let _ = write_transcript(zip, options, resource, folder, read_blob);
    Ok(())
}

fn options() -> zip::write::SimpleFileOptions {
    zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644)
}

fn write_json<W: Write + Seek>(
    zip: &mut zip::ZipWriter<W>,
    name: &str,
    value: &Value,
    options: zip::write::SimpleFileOptions,
) -> Result<()> {
    zip.start_file(name, options).map_err(|e| e.to_string())?;
    zip.write_all(value.to_string().as_bytes())
        .map_err(|e| e.to_string())
}

fn write_blobs<W: Write + Seek>(
    zip: &mut zip::ZipWriter<W>,
    options: zip::write::SimpleFileOptions,
    resource: &Value,
    prefix: &str,
    read_blob: &impl Fn(&str) -> Result<Vec<u8>>,
) -> Result<()> {
    let mut seen = BTreeSet::new();
    for file in resource["files"].as_array().ok_or("Missing files")? {
        let hash = file["hash"].as_str().ok_or("Missing hash")?;
        if !seen.insert(hash) {
            continue;
        }
        zip.start_file(format!("{prefix}blobs/{hash}"), options)
            .map_err(|e| e.to_string())?;
        zip.write_all(&read_blob(hash)?)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn write_transcript<W: Write + Seek>(
    zip: &mut zip::ZipWriter<W>,
    options: zip::write::SimpleFileOptions,
    resource: &Value,
    prefix: &str,
    read_blob: &impl Fn(&str) -> Result<Vec<u8>>,
) -> Result<()> {
    if resource["kind"] != "session" {
        return Ok(());
    }
    let records = crate::history::resource_records_with(resource, read_blob)?;
    zip.start_file(format!("{prefix}transcript.md"), options)
        .map_err(|e| e.to_string())?;
    zip.write_all(native::transcript(&records).as_bytes())
        .map_err(|e| e.to_string())
}

pub fn export(db: &rusqlite::Connection, id: &str, path: &Path) -> Result<()> {
    let r = crate::local_resources::resource(db, id)?;
    let r = crate::session_forks::reading_resource(db, &r)?;
    export_snapshot(db, &r, path)
}

pub(crate) fn export_snapshot(
    db: &rusqlite::Connection,
    snapshot: &crate::history::SessionRead,
    path: &Path,
) -> Result<()> {
    let r = &snapshot.resource;
    if r["deleted"] == true {
        return Err("Deleted resources cannot be exported".into());
    }
    let project =
        crate::governance::project(db, r["projectId"].as_str().ok_or("Missing project")?)?;
    if r["kind"] == "skill" {
        packages::reject_env_files(r["files"].as_array().ok_or("Missing files")?)?;
    }
    let parent = path.parent().ok_or("Missing output parent")?;
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    {
        let mut zip = zip::ZipWriter::new(staged.as_file_mut());
        let options = options();
        let mut manifest = json!({"version":2,"origin":{"projectId":r["projectId"],"resourceId":r["resourceId"],"governed":project["governed"]==true},"resource":{"resourceId":r["resourceId"],"kind":r["kind"],"source":r["source"],"logicalPath":r["logicalPath"],"title":r["title"],"files":r["files"],"contextSources":r["contextSources"].as_array().cloned().unwrap_or_default(),"deleted":false}});
        if r["sourceId"].is_string() {
            manifest["resource"]["sourceId"] = r["sourceId"].clone();
        }
        write_json(&mut zip, "manifest.json", &manifest, options)?;
        let read = |hash: &str| snapshot.read_blob(hash);
        write_blobs(&mut zip, options, r, "", &read)?;
        write_transcript(&mut zip, options, r, "", &read)?;
        zip.finish().map_err(|e| e.to_string())?;
    }
    staged.as_file().sync_all().map_err(|e| e.to_string())?;
    staged.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
#[cfg(test)]
pub fn import(db: &rusqlite::Connection, project: &str, path: &Path) -> Result<String> {
    import_into_source(db, project, path, None)
}

pub fn import_into_source(
    db: &rusqlite::Connection,
    project: &str,
    path: &Path,
    source_id: Option<&str>,
) -> Result<String> {
    let mut zip = zip::ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if zip.len() > 202 {
        return Err("Bundle has too many files".into());
    }
    let mut names = BTreeSet::new();
    let mut total = 0;
    for i in 0..zip.len() {
        let f = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().map_err(|e| e.to_string())?;
        packages::safe_relative(&name)?;
        if f.is_dir()
            || f.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
            || !names.insert(name.into_owned())
        {
            return Err("Bundle contains directories, symlinks, or duplicate paths".into());
        }
        total += f.size();
        if f.size() > 128 * 1024 * 1024 || total > 256 * 1024 * 1024 {
            return Err("Bundle exceeds size limits".into());
        }
    }
    let mut bytes = Vec::new();
    zip.by_name("manifest.json")
        .map_err(|_| "Missing manifest")?
        .take(128_001)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 128_000 {
        return Err("Manifest too large".into());
    }
    let manifest: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if manifest["version"] != 2 {
        return Err("Unsupported bundle version".into());
    }
    let mut r = manifest["resource"].clone();
    if manifest["origin"]["governed"] == true && manifest["origin"]["projectId"] != project {
        return Err("This governed bundle retains its source audience. Import it into the source project and request sharing there; automatic cross-project publication is unavailable.".into());
    }
    let p = crate::governance::project(db, project)?;
    let source_id = source_id.or_else(|| {
        if manifest["origin"]["projectId"] == project {
            r["sourceId"].as_str()
        } else {
            None
        }
    });
    let p = crate::sources::registered(&p, source_id)?;
    let original = if manifest["origin"]["governed"] == true {
        Some(
            crate::governance::resource(
                db,
                manifest["origin"]["resourceId"]
                    .as_str()
                    .ok_or("Missing source resource")?,
            )
            .map_err(|_| "Refresh source resource access before importing this bundle")?,
        )
    } else {
        None
    };
    if original
        .as_ref()
        .is_some_and(|original| original["sourceId"] != p["sourceId"])
    {
        return Err("Import this governed resource into its original repository".into());
    }
    crate::sources::scope(&p, &mut r);
    let kind = r["kind"].as_str().ok_or("Missing kind")?.to_string();
    if !matches!(kind.as_str(), "skill" | "session" | "plan") {
        return Err("Only skill, session, and plan bundles are supported".into());
    }
    if !matches!(r["source"].as_str(), Some("shared" | "claude" | "codex"))
        || r["title"]
            .as_str()
            .is_none_or(|s| s.is_empty() || s.len() > 256)
    {
        return Err("Invalid bundle source or title".into());
    }
    let logical =
        packages::safe_relative(r["logicalPath"].as_str().ok_or("Missing logical path")?)?;
    if kind == "skill"
        && (logical.components().count() != 1
            || logical.to_string_lossy().starts_with('.')
            || logical.to_string_lossy().len() > 128)
    {
        return Err("Invalid skill folder name".into());
    }
    if kind == "session" && r["source"] == "shared" {
        return Err("Session source must be Claude or Codex".into());
    }
    let files = r["files"].as_array().ok_or("Missing files")?;
    if kind == "skill" {
        packages::reject_env_files(files)?;
    }
    if files.len() > 200 || files.is_empty() {
        return Err("Invalid file count".into());
    }
    let mut paths = BTreeSet::new();
    let mut allowed = BTreeSet::from(["manifest.json".to_string(), "transcript.md".to_string()]);
    let mut size = 0;
    for f in files {
        let relative = f["path"].as_str().ok_or("Missing path")?;
        packages::safe_relative(relative)?;
        if !paths.insert(relative) {
            return Err("Duplicate resource path".into());
        }
        let hash = f["hash"].as_str().ok_or("Missing hash")?;
        db::blob_path(hash)?;
        let name = format!("blobs/{hash}");
        allowed.insert(name.clone());
        let mut bytes = Vec::new();
        let limit = f["size"].as_u64().ok_or("Missing size")?;
        if limit > 128 * 1024 * 1024 {
            return Err("File too large".into());
        }
        zip.by_name(&name)
            .map_err(|_| "Missing blob")?
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 != limit
            || db::digest(&bytes) != hash
            || !f["executable"].is_boolean()
        {
            return Err("Invalid blob hash, size, or mode".into());
        }
        size += limit;
        db::blob(&bytes)?;
    }
    if !names.is_subset(&allowed) {
        return Err("Unrecognized bundle file".into());
    }
    if kind == "skill"
        && (!paths.contains("SKILL.md")
            || size > 4_000_000
            || files
                .iter()
                .any(|f| f["size"].as_u64().unwrap_or(0) > 1_000_000))
    {
        return Err("Invalid skill package".into());
    }
    if kind == "session" {
        let records = crate::history::resource_records(&r)?;
        native::session_info(r["source"].as_str().ok_or("Missing tool")?, &records)?;
    }
    if kind == "plan" {
        crate::plans::validate(&r)?;
    }
    let id = if kind == "skill" || kind == "plan" {
        let logical = r["logicalPath"].as_str().ok_or("Missing path")?;
        original
            .as_ref()
            .and_then(|r| r["resourceId"].as_str())
            .map(String::from)
            .map(Ok)
            .unwrap_or_else(|| indexer::scoped_resource_id(db, &p, &kind, logical))?
    } else {
        Uuid::new_v4().to_string()
    };
    r["resourceId"] = json!(id);
    r["deleted"] = json!(false);
    if kind == "session" {
        r["logicalPath"] = json!(format!("imports/{id}"));
    }
    if let Some(original) = original {
        let mut sources = r["contextSources"].as_array().cloned().unwrap_or_default();
        if original["resourceId"] != id && !sources.contains(&original["resourceId"]) {
            sources.push(original["resourceId"].clone());
        }
        r["contextSources"] = json!(sources);
    }
    if p["governed"] == true {
        crate::governance::capture(db, &p, &r, &json!([]))?;
        return Ok(id);
    }
    let b = indexer::binding(db, &id)?;
    let value = json!({"version":2,"id":Uuid::new_v4().to_string(),"projectId":project,"deviceId":db::device(db)?,"baseRevision":b["base"]["revision"].as_u64().unwrap_or(0),"resource":r});
    indexer::queue(db, project, "/v2/sync/push", &value)?;
    SyncQueue::request(db, project, Priority::User, "import")?;
    Ok(id)
}
