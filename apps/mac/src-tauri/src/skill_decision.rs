//! Decisions strong enough to publish a reconciled skill without manual review.
mod formats;

use crate::db;
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// All participants must have the same complete package shape. The only new
/// bytes may belong to one existing, non-executable Markdown file.
pub(crate) fn candidate<'a>(
    base: &Value,
    shared: &'a Value,
    mirrors: impl Iterator<Item = &'a Value>,
) -> Option<Value> {
    let originals = base.as_array()?;
    crate::packages::reject_env_files(originals).ok()?;
    let participants: Vec<_> = std::iter::once(shared)
        .chain(mirrors)
        .map(Value::as_array)
        .collect::<Option<_>>()?;
    if originals.len() > 200
        || participants.len() != 3
        || participants
            .iter()
            .any(|files| files.len() != originals.len())
    {
        return None;
    }
    let mut changed = None;
    for (i, original) in originals.iter().enumerate() {
        if participants.iter().all(|files| files[i] == *original) {
            continue;
        }
        let path = original["path"].as_str()?;
        if changed.is_some()
            || !path.ends_with(".md")
            || original["executable"] != false
            || participants.iter().any(|files| {
                files[i]["path"] != original["path"] || files[i]["executable"] != false
            })
        {
            return None;
        }
        changed = Some(i);
    }
    let i = changed?;
    let read = |file: &Value| -> Option<String> {
        let bytes = db::blob_read(file["hash"].as_str()?).ok()?;
        if bytes.len() > 1_000_000
            || file["size"].as_u64()? != bytes.len() as u64
            || bytes.contains(&0)
        {
            return None;
        }
        String::from_utf8(bytes).ok()
    };
    let original = read(&originals[i])?;
    let versions: Vec<_> = participants
        .iter()
        .map(|files| read(&files[i]))
        .collect::<Option<_>>()?;
    let mut differing = versions.iter().filter(|text| **text != original);
    let first = differing.next()?;
    let merged = if differing.all(|other| other == first) {
        first.clone()
    } else {
        merge_references(&original, &versions).or_else(|| {
            // Companion files can impose additional format or validation requirements.
            if originals.len() == 1 && originals[i]["path"] == "SKILL.md" {
                formats::merge(&original, &versions)
            } else {
                None
            }
        })?
    };
    if merged.trim().is_empty()
        || merged.len() > 1_000_000
        || !originals.iter().any(|file| file["path"] == "SKILL.md")
    {
        return None;
    }
    let mut manifest = shared.clone();
    manifest[i]["hash"] = json!(db::blob(merged.as_bytes()).ok()?);
    manifest[i]["size"] = json!(merged.len());
    let size = manifest
        .as_array()?
        .iter()
        .try_fold(0_u64, |sum, file| sum.checked_add(file["size"].as_u64()?))?;
    (size <= 4_000_000).then_some(manifest)
}

/// Compare complete link-definition tables. Do not parse references from
/// within arbitrary Markdown, where changes to surrounding prose can interact.
fn reference_lines(text: &str) -> Option<Vec<(&str, String)>> {
    let body = text.strip_prefix("## References\n")?;
    let mut lines = Vec::new();
    let mut keys = std::collections::BTreeSet::new();
    for line in body.split_inclusive('\n') {
        let (label, url) = line
            .strip_suffix('\n')?
            .strip_prefix('[')?
            .split_once("]: ")?;
        if label.is_empty()
            || label.len() > 999
            || !label
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b" _-".contains(&c))
            || !url.starts_with("https://")
            || !url.is_ascii()
            || url.bytes().any(|c| {
                c.is_ascii_control() || c.is_ascii_whitespace() || b"()<>[]\\\"'".contains(&c)
            })
        {
            return None;
        }
        let parsed = reqwest::Url::parse(url).ok()?;
        if parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return None;
        }
        let key = label
            .split_ascii_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase();
        if key.is_empty() || !keys.insert(key.clone()) {
            return None;
        }
        lines.push((line, key));
    }
    Some(lines)
}

fn merge_references(base: &str, versions: &[String]) -> Option<String> {
    let original = reference_lines(base)?;
    let mut merged = base.to_owned();
    let mut added = BTreeMap::new();
    for text in versions {
        let records = reference_lines(text)?;
        if !records.starts_with(&original) {
            return None;
        }
        for (line, key) in &records[original.len()..] {
            match added.insert(key.clone(), *line) {
                Some(previous) if previous != *line => return None,
                Some(_) => {}
                None => merged.push_str(line),
            }
        }
    }
    Some(merged)
}
