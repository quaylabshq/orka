use crate::{
    db::{self, Result},
    governance, indexer,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
    process::Command,
};

pub(crate) const LOCAL_EDITS: &str =
    "Local skill edits preserved; resolve them before applying the shared update";

type Copy<'a> = (&'a PathBuf, Value);

fn installed_base<'a>(binding: &'a Value, shared: &Value) -> Option<&'a Value> {
    let base = &binding["base"];
    let (revision, current) = base["revision"].as_u64().zip(shared["revision"].as_u64())?;
    (revision > 0
        && revision <= current
        && base["deleted"] != true
        && base["files"].as_array().is_some_and(|files| !files.is_empty())
        && [
            "resourceId",
            "projectId",
            "sourceId",
            "kind",
            "source",
            "logicalPath",
        ]
        .into_iter()
        .all(|key| base[key] == shared[key]))
    .then_some(base)
}

fn hold_unsent_drafts(db: &Connection, project: &str, resource: &str) -> Result<()> {
    db.execute(
        "UPDATE drafts SET value=json_set(value,'$.automaticSharing',json('false'),'$.conflictReview',json('true'))
         WHERE project=?1 AND json_extract(value,'$.resource.resourceId')=?2
           AND json_extract(value,'$.status')='local'
           AND json_extract(value,'$.submission') IS NULL
           AND json_extract(value,'$.requestId') IS NULL",
        params![project, resource],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

fn snapshot(copies: &[Copy<'_>]) -> BTreeMap<String, String> {
    copies
        .iter()
        .filter(|(_, files)| files.as_array().is_some_and(|files| !files.is_empty()))
        .map(|(path, files)| (path.to_string_lossy().into_owned(), indexer::manifest_hash(files)))
        .collect()
}

fn decision(shared: &Value, guards: &BTreeMap<String, String>) -> Value {
    json!({"revision":shared["revision"],"manifest":indexer::manifest_hash(&shared["files"]),"guards":guards})
}

pub(crate) fn kept(binding: &Value, shared: &Value, copies: &[Copy<'_>]) -> bool {
    !binding["keptLocalSkill"].is_null()
        && binding["keptLocalSkill"] == decision(shared, &snapshot(copies))
}

pub(crate) fn keep(
    db: &Connection,
    project: &Value,
    shared: &Value,
    mut binding: Value,
    review: &Value,
) -> Result<()> {
    let id = shared["resourceId"].as_str().ok_or("Missing resource")?;
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let empty = indexer::manifest_hash(&json!([]));
    let guards = binding["paths"].as_array().ok_or("Missing paths")?
        .iter()
        .zip(review["guards"].as_array().ok_or("Missing review guards")?)
        .filter_map(|(path, hash)| Some((path.as_str()?, hash.as_str()?)))
        .filter(|(_, hash)| *hash != empty)
        .map(|(path, hash)| (path.to_owned(), hash.to_owned()))
        .collect();
    binding["keptLocalSkill"] = decision(shared, &guards);
    binding["skillReviewFingerprint"] = Value::Null;
    binding["installationState"] = json!("kept_local");
    binding["availableRevision"] = shared["revision"].clone();
    let tx = db.unchecked_transaction().map_err(|error| error.to_string())?;
    db::upsert(&tx, "bindings", id, project_id, &binding)?;
    // Preserve the prepared local candidate in history when the user chooses
    // to keep the active files. Existing explicit proposals are independent.
    tx.execute(
        "UPDATE drafts SET value=json_set(value,'$.status','dismissed','$.archivedAt',?1)
         WHERE project=?2 AND json_extract(value,'$.resource.resourceId')=?3
           AND json_extract(value,'$.skillReconciliation')=1 AND json_extract(value,'$.status')='local'
           AND json_extract(value,'$.submission') IS NULL AND json_extract(value,'$.requestId') IS NULL",
        params![db::now(), project_id, id],
    )
    .map_err(|error| error.to_string())?;
    clear_review_errors(&tx, project, shared)?;
    tx.commit().map_err(|error| error.to_string())
}

pub(crate) fn clear_review_errors(db: &Connection, project: &Value, shared: &Value) -> Result<()> {
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let skill = shared["logicalPath"].as_str().ok_or("Missing skill path")?;
    let scan_id = project["sourceId"]
        .as_str()
        .map(|source| format!("{project_id}:{source}"))
        .unwrap_or_else(|| project_id.into());
    db.execute(
        "DELETE FROM errors WHERE (source=?1 OR source=?2) AND error IN (?3,?4)",
        params![
            shared["resourceId"].as_str(),
            format!("{scan_id}:scan:skills/{skill}"),
            LOCAL_EDITS,
            indexer::SKILL_MIRROR_REVIEW,
        ],
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

/// The background scanner normally chooses a single edited mirror for publication.
/// A new shared revision or two independently edited mirrors require reconciliation
/// first, even on a project that normally publishes skills automatically.
pub(crate) fn defer_scan(
    db: &Connection,
    project: &Value,
    id: &str,
    name: &str,
    binding: &mut Value,
    copies: &[Copy<'_>],
) -> Result<bool> {
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let shared = db::rows(
        db,
        "SELECT value FROM resources WHERE id=? AND project=?",
        &[&id, &project_id],
    )?
    .into_iter()
    .next();
    let mirrors_differ = copies.windows(2).any(|pair| pair[0].1 != pair[1].1);
    if let Some(shared) = shared {
        if kept(binding, &shared, copies) {
            return Ok(true);
        }
        let base = &binding["base"];
        let base_is_current = base["revision"] == shared["revision"]
            && (installed_base(binding, &shared).is_some_and(|base| base["files"] == shared["files"])
                || (base["resourceId"] == shared["resourceId"]
                    && base["deleted"] == true
                    && shared["deleted"] == true));
        if !base_is_current {
            hold_unsent_drafts(db, project_id, id)?;
            return Ok(true);
        }
        let local_differs = copies.iter().any(|(_, files)| *files != shared["files"]);
        if (mirrors_differ && copies.iter().all(|(_, files)| *files != shared["files"]))
            || (!binding["keptLocalSkill"].is_null() && local_differs)
        {
            if !reconcile(db, project, &shared, binding, copies)? {
                return Err(LOCAL_EDITS.into());
            }
            return Ok(true);
        }
        if !binding["skillReviewFingerprint"].is_null() || !binding["keptLocalSkill"].is_null() {
            binding["skillReviewFingerprint"] = Value::Null;
            binding["keptLocalSkill"] = Value::Null;
            if !local_differs {
                binding["installationState"] = json!("current");
            }
            db::upsert(db, "bindings", id, project_id, binding)?;
        }
    } else if mirrors_differ {
        let fingerprint = db::digest(json!(snapshot(copies)).to_string().as_bytes());
        if binding["skillReviewFingerprint"] != fingerprint {
            let tx = db.unchecked_transaction().map_err(|error| error.to_string())?;
            for (path, files) in copies {
                let resource = json!({"resourceId":id,"kind":"skill","source":"shared","logicalPath":name,"title":name,"files":files,"deleted":false});
                governance::capture(&tx, project, &resource, &json!([path]))?;
            }
            hold_unsent_drafts(&tx, project_id, id)?;
            binding["skillReviewFingerprint"] = json!(fingerprint);
            db::upsert(&tx, "bindings", id, project_id, binding)?;
            tx.commit().map_err(|error| error.to_string())?;
        }
        return Err(indexer::SKILL_MIRROR_REVIEW.into());
    }
    Ok(false)
}

/// Returns true only when the accepted version already contains every local change.
/// Otherwise keep the active mirrors and stage a review, with a merged draft when
/// all versions have a common base and combine cleanly.
pub(crate) fn reconcile(
    db: &Connection,
    project: &Value,
    shared: &Value,
    binding: &mut Value,
    copies: &[Copy<'_>],
) -> Result<bool> {
    let id = shared["resourceId"].as_str().ok_or("Missing resource")?;
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let base = installed_base(binding, shared);
    let fingerprint = db::digest(
        json!([base, shared["revision"], shared["files"], snapshot(copies)])
            .to_string()
            .as_bytes(),
    );
    if binding["skillReviewFingerprint"] == fingerprint {
        return Ok(false);
    }

    let candidate = base.and_then(|base| {
        if shared["deleted"] == true {
            return None;
        }
        copies.iter().filter(|(_, files)| files.as_array().is_some_and(|f| !f.is_empty())).try_fold(
            shared["files"].clone(),
            |candidate, (_, files)| merge_manifest(&base["files"], &candidate, files),
        )
    });
    if candidate.as_ref() == Some(&shared["files"]) {
        return Ok(true);
    }

    let tx = db.unchecked_transaction().map_err(|error| error.to_string())?;
    hold_unsent_drafts(&tx, project_id, id)?;
    if let Some(files) = candidate {
        let existing: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM drafts WHERE project=?1
                 AND json_extract(value,'$.resource.resourceId')=?2
                 AND json_extract(value,'$.resource.files')=json(?3)
                 AND coalesce(json_extract(value,'$.skillReconciliation'),0)=0)",
                params![project_id, id, files.to_string()],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let mut draft = shared.clone();
        draft["files"] = files;
        let paths = copies.iter().map(|(path, _)| *path).collect::<Vec<_>>();
        let draft_id = governance::capture(&tx, project, &draft, &json!(paths))?;
        // This is a local candidate. An explicit review freezes the version
        // sent to the existing publication workflow.
        tx.execute(
            "UPDATE drafts SET value=json_set(value,'$.baseRevision',?1,'$.automaticSharing',json('false'),'$.conflictReview',json('true'),'$.skillReconciliation',json('true'))
             WHERE id=?2 AND project=?3 AND json_extract(value,'$.status')='local'
               AND json_extract(value,'$.submission') IS NULL AND json_extract(value,'$.requestId') IS NULL AND NOT ?4",
            params![shared["revision"].as_u64(), draft_id, project_id, existing],
        )
        .map_err(|error| error.to_string())?;
    }
    binding["installationState"] = json!("locally_modified");
    binding["availableRevision"] = shared["revision"].clone();
    binding["skillReviewFingerprint"] = json!(fingerprint);
    binding["keptLocalSkill"] = Value::Null;
    db::upsert(&tx, "bindings", id, project_id, binding)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(false)
}

fn file_map(files: &Value) -> Option<BTreeMap<&str, &Value>> {
    let files = files.as_array()?;
    let map: BTreeMap<_, _> = files
        .iter()
        .map(|file| Some((file["path"].as_str()?, file)))
        .collect::<Option<_>>()?;
    (map.len() == files.len()).then_some(map)
}

fn merge_manifest(base: &Value, shared: &Value, local: &Value) -> Option<Value> {
    let base = file_map(base)?;
    let shared = file_map(shared)?;
    let local = file_map(local)?;
    let paths = base.keys().chain(shared.keys()).chain(local.keys()).collect::<BTreeSet<_>>();
    let mut merged = Vec::new();
    for path in paths {
        let base = base.get(path).copied();
        let shared = shared.get(path).copied();
        let local = local.get(path).copied();
        let selected = if local == base || local == shared {
            shared.cloned()
        } else if shared == base {
            local.cloned()
        } else {
            Some(merge_file(base?, shared?, local?)?)
        };
        merged.extend(selected);
    }
    let size: u64 = merged
        .iter()
        .try_fold(0_u64, |size, file| size.checked_add(file["size"].as_u64()?))?;
    (merged.len() <= 200 && size <= 4_000_000
        && merged.iter().any(|file| file["path"] == "SKILL.md"))
    .then(|| json!(merged))
}

fn merge_file(base: &Value, shared: &Value, local: &Value) -> Option<Value> {
    let executable = if local["executable"] == base["executable"] {
        &shared["executable"]
    } else {
        &local["executable"]
    };
    let mut file = if local["hash"] == base["hash"] || shared["hash"] == local["hash"] {
        shared.clone()
    } else if shared["hash"] == base["hash"] {
        local.clone()
    } else {
        let text = merge_text(
            local["hash"].as_str()?,
            base["hash"].as_str()?,
            shared["hash"].as_str()?,
        )?;
        let mut file = shared.clone();
        file["hash"] = json!(db::blob(&text).ok()?);
        file["size"] = json!(text.len());
        file
    };
    file["executable"] = executable.clone();
    Some(file)
}

fn merge_text(local: &str, base: &str, shared: &str) -> Option<Vec<u8>> {
    let temp = tempfile::tempdir().ok()?;
    let mut paths = Vec::new();
    for (name, hash) in [("local", local), ("base", base), ("shared", shared)] {
        let bytes = db::blob_read(hash).ok()?;
        if bytes.len() > 1_000_000 || bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
            return None;
        }
        let path = temp.path().join(name);
        fs::write(&path, bytes).ok()?;
        paths.push(path);
    }
    let output = Command::new("/usr/bin/diff3")
        .arg("-m")
        .args(&paths)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    (output.status.success() && output.stdout.len() <= 1_000_000).then_some(output.stdout)
}
