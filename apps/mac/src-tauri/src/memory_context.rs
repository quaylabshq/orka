use crate::{db, governance, packages, projects};
use rusqlite::Connection;
use serde_json::Value;
use std::{collections::BTreeSet, path::Path};

pub const HANDOFF_DECISION_LIMIT: usize = 4000;
const MAX_DECISION_CONTEXT_SLOTS: usize = 2;

pub struct Entry {
    pub resource: Value,
    pub text: String,
    pub fingerprint: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub resource: Value,
    pub decision: String,
    pub reason: String,
}

pub fn format_decision(decision: &str, reason: &str) -> String {
    format!(
        "---\norka_type: decision\n---\nDecision: {}\nReason: {}\n",
        decision.trim(),
        reason.trim()
    )
}

/// Parses a decision memory in the exact `orka_type: decision` format.
///
/// Multi-line `Decision:` and `Reason:` values preserve internal newlines and
/// trim leading/trailing whitespace on each field. Ordinary or malformed
/// memories return `None`.
pub fn parse_decision(text: &str) -> Option<(String, String)> {
    let normalized = text.replace("\r\n", "\n");
    let trimmed = normalized.trim_start_matches('\u{feff}');
    let rest = trimmed.strip_prefix("---\n")?;
    let (frontmatter, after_open) = rest.split_once("\n---")?;
    let body = match after_open {
        "" => "",
        s if s.starts_with('\n') => &s[1..],
        _ => return None,
    };
    let is_decision = frontmatter.lines().any(|line| {
        line.split_once(':')
            .is_some_and(|(k, v)| k.trim() == "orka_type" && v.trim() == "decision")
    });
    if !is_decision {
        return None;
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Section {
        Decision,
        Reason,
    }

    let mut section: Option<Section> = None;
    let mut decision_lines: Vec<String> = Vec::new();
    let mut reason_lines: Vec<String> = Vec::new();

    for line in body.lines() {
        if section.is_none() && line.starts_with("Decision:") {
            section = Some(Section::Decision);
            let first = line["Decision:".len()..].trim_start_matches([' ', '\t']);
            if !first.is_empty() {
                decision_lines.push(first.to_owned());
            }
            continue;
        }
        if section == Some(Section::Decision) && line.starts_with("Reason:") {
            section = Some(Section::Reason);
            let first = line["Reason:".len()..].trim_start_matches([' ', '\t']);
            if !first.is_empty() {
                reason_lines.push(first.to_owned());
            }
            continue;
        }
        match section {
            Some(Section::Decision) => decision_lines.push(line.to_owned()),
            Some(Section::Reason) => reason_lines.push(line.to_owned()),
            None => {
                if !line.trim().is_empty() {
                    return None;
                }
            }
        }
    }

    let decision = decision_lines.join("\n").trim().to_owned();
    let reason = reason_lines.join("\n").trim().to_owned();
    if decision.is_empty() || reason.is_empty() {
        return None;
    }
    Some((decision, reason))
}

pub fn discoverable(path: &Path) -> bool {
    !path.components().any(|part| {
        matches!(
            part.as_os_str().to_str(),
            Some(
                ".git"
                    | ".orka"
                    | ".runtime"
                    | ".tmp"
                    | "node_modules"
                    | "target"
                    | "dist"
                    | "artifacts"
                    | "coverage"
                    | "backups"
                    | "vendor"
            )
        )
    })
}

pub fn summary_thread(text: &str) -> Option<String> {
    text.lines()
        .find_map(|line| line.strip_prefix("thread_id: "))
        .and_then(|id| uuid::Uuid::parse_str(id.trim()).ok())
        .map(|id| id.to_string())
}

pub fn summary_references(text: &str) -> BTreeSet<String> {
    text.split("rollout_summaries/")
        .skip(1)
        .filter_map(|part| part.split_once(".md").map(|(name, _)| format!("{name}.md")))
        .filter(|name| !name.contains(['\n', '/', '\\']))
        .collect()
}

fn terms(text: &str) -> BTreeSet<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| word.len() >= 3)
        .map(str::to_lowercase)
        .filter(|word| {
            !matches!(
                word.as_str(),
                "the"
                    | "and"
                    | "for"
                    | "this"
                    | "that"
                    | "with"
                    | "from"
                    | "have"
                    | "what"
                    | "how"
                    | "can"
                    | "you"
                    | "our"
                    | "are"
                    | "was"
                    | "were"
                    | "want"
                    | "please"
                    | "help"
                    | "check"
                    | "fix"
                    | "update"
                    | "project"
            )
        })
        .collect()
}

fn paragraphs(text: &str) -> Vec<String> {
    let text = text.trim();
    let text = if let Some(frontmatter) = text.strip_prefix("---\n") {
        frontmatter
            .split_once("\n---")
            .map_or(text, |(_, body)| body)
    } else {
        text
    };
    let mut skip_section = false;
    let mut lines = Vec::new();
    for line in text.lines() {
        let clean = line.trim();
        if clean.starts_with('#') {
            let heading = clean.trim_start_matches('#').trim().to_lowercase();
            skip_section = matches!(heading.as_str(), "rollout_summary_files" | "keywords");
            if skip_section || heading.starts_with("task ") || heading.starts_with("task group:") {
                continue;
            }
        }
        if skip_section
            || clean.starts_with("Task Group:")
            || [
                "thread_id:",
                "updated_at:",
                "rollout_path:",
                "cwd:",
                "git_branch:",
                "scope:",
                "applies_to:",
            ]
            .iter()
            .any(|prefix| clean.starts_with(prefix))
            || clean.contains("rollout_summaries/")
        {
            continue;
        }
        lines.push(line);
    }
    let cleaned = lines.join("\n");
    let parts: Vec<_> = cleaned
        .split("\n\n")
        .map(str::trim)
        .filter(|part| !part.is_empty() && !part.lines().all(|line| line.starts_with('#')))
        .map(str::to_owned)
        .collect();
    if parts.is_empty() && cleaned.trim().starts_with('#') {
        vec![cleaned.trim().trim_start_matches('#').trim().to_owned()]
    } else {
        parts
    }
}

pub fn preview(text: &str) -> String {
    paragraphs(text)
        .first()
        .map(|text| text.chars().take(160).collect())
        .unwrap_or_default()
}

pub fn catalog(db: &Connection, project: &Value) -> db::Result<Vec<Entry>> {
    if !projects::sharing_allowed(project, "memory") {
        return Ok(vec![]);
    }
    let id = project["id"].as_str().ok_or("Missing project")?;
    let resources = db::rows(db,"SELECT value FROM resources WHERE project=? AND json_extract(value,'$.kind')='memory' AND json_extract(value,'$.deleted')=0 ORDER BY json_extract(value,'$.updatedAt') DESC, id",&[&id])?;
    let superseded: BTreeSet<_> = resources
        .iter()
        .flat_map(|r| {
            r["memory"]["supersedes"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })
        .filter_map(|id| id.as_str().map(str::to_owned))
        .collect();
    let mut entries = Vec::new();
    for resource in resources {
        if !crate::sources::matches(project, &resource) {
            continue;
        }
        let logical = resource["logicalPath"].as_str().unwrap_or("");
        if !discoverable(Path::new(
            logical.strip_prefix("instructions/").unwrap_or(logical),
        )) || superseded.contains(resource["resourceId"].as_str().unwrap_or(""))
            || resource["access"]["mode"] == "hidden"
        {
            continue;
        }
        let Some(hash) = resource["files"][0]["hash"].as_str() else {
            continue;
        };
        let Ok(bytes) = db::blob_read(hash) else {
            continue;
        };
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        entries.push(Entry {
            resource,
            text,
            fingerprint: String::new(),
        });
    }
    let covered: BTreeSet<_> = entries
        .iter()
        .filter(|e| {
            e.resource["logicalPath"]
                .as_str()
                .is_some_and(|p| p.starts_with("codex/entries/"))
        })
        .flat_map(|e| summary_references(&e.text))
        .collect();
    let covered_threads: BTreeSet<_> = entries
        .iter()
        .filter(|e| {
            e.resource["logicalPath"]
                .as_str()
                .and_then(|p| p.rsplit('/').next())
                .is_some_and(|name| covered.contains(name))
        })
        .filter_map(|e| summary_thread(&e.text))
        .collect();
    // Prefer the provider's source update time over the time a file was synced.
    entries.sort_by_cached_key(|e| {
        let curated = usize::from(e.resource["memory"].is_object()) * 2
            + usize::from(
                e.resource["logicalPath"]
                    .as_str()
                    .is_some_and(|p| p.starts_with("codex/entries/")),
            );
        std::cmp::Reverse((
            curated,
            e.text
                .lines()
                .find_map(|line| line.strip_prefix("updated_at: "))
                .unwrap_or(e.resource["updatedAt"].as_str().unwrap_or(""))
                .to_owned(),
        ))
    });
    let mut identities = BTreeSet::new();
    entries.retain(|entry| {
        let logical = entry.resource["logicalPath"].as_str().unwrap_or("");
        if logical.starts_with("codex/summaries/") {
            let thread = summary_thread(&entry.text);
            if covered.contains(logical.rsplit('/').next().unwrap_or(""))
                || thread
                    .as_ref()
                    .is_some_and(|id| covered_threads.contains(id))
            {
                return false;
            }
            if let Some(thread) = thread {
                if !identities.insert(format!("thread:{thread}")) {
                    return false;
                }
            }
        }
        let normalized = paragraphs(&entry.text)
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        identities.insert(format!(
            "content:{}:{}",
            entry.resource["memory"]["scope"],
            db::digest(normalized.as_bytes())
        ))
    });
    Ok(entries)
}

pub fn select(
    db: &Connection,
    project: &Value,
    cwd: &Path,
    query: Option<&str>,
) -> db::Result<Vec<Entry>> {
    let root = Path::new(project["path"].as_str().ok_or("Connect a folder")?);
    let mut query_terms = terms(query.unwrap_or(""));
    // A project name is not evidence that a memory is relevant to this task.
    for word in terms(project["name"].as_str().unwrap_or("")) {
        query_terms.remove(&word);
    }
    if query.is_some() && query_terms.is_empty() {
        return Ok(vec![]);
    }
    let mut ranked = Vec::new();
    for mut entry in catalog(db, project)? {
        if governance::protected(&entry.resource) {
            continue;
        }
        let scope = entry.resource["memory"]["scope"].as_str().unwrap_or("");
        if !scope.is_empty() && !cwd.starts_with(root.join(packages::safe_relative(scope)?)) {
            continue;
        }
        let title = terms(entry.resource["title"].as_str().unwrap_or(""));
        let mut parts: Vec<_> = paragraphs(&entry.text)
            .into_iter()
            .filter_map(|part| {
                let words = terms(&part);
                let score = words.intersection(&query_terms).count();
                (query.is_none() || score > 0).then_some((score, part))
            })
            .collect();
        parts.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
        let Some((best, _)) = parts.first() else {
            continue;
        };
        let score = best * 3 + title.intersection(&query_terms).count() * 2;
        // With several task terms, one incidental word is too weak a match.
        let matches: BTreeSet<_> = parts
            .iter()
            .flat_map(|(_, part)| terms(part))
            .filter(|word| query_terms.contains(word))
            .collect();
        if query.is_some() && matches.len() < query_terms.len().min(2) {
            continue;
        }
        entry.text = parts
            .into_iter()
            .take(2)
            .map(|(_, part)| part)
            .collect::<Vec<_>>()
            .join("\n\n");
        entry.text = entry.text.chars().take(1000).collect();
        entry.fingerprint = db::digest(
            format!(
                "{}:{}:{}",
                entry.resource["files"][0]["hash"], project["policyRevision"], entry.text
            )
            .as_bytes(),
        );
        ranked.push((score, entry));
    }
    ranked.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
    let mut excerpts = BTreeSet::new();
    let deduped: Vec<Entry> = ranked
        .into_iter()
        .map(|(_, entry)| entry)
        .filter(|entry| {
            excerpts.insert(
                entry
                    .text
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .to_lowercase(),
            )
        })
        .collect();
    let mut decision_entries = Vec::new();
    let mut other_entries = Vec::new();
    for entry in deduped {
        if db::blob_read(entry.resource["files"][0]["hash"].as_str().unwrap_or(""))
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .is_some_and(|raw| parse_decision(&raw).is_some())
        {
            decision_entries.push(entry);
        } else {
            other_entries.push(entry);
        }
    }
    let mut selected: Vec<Entry> = decision_entries
        .into_iter()
        .take(MAX_DECISION_CONTEXT_SLOTS)
        .collect();
    let remaining = 4usize.saturating_sub(selected.len());
    selected.extend(other_entries.into_iter().take(remaining));
    Ok(selected)
}

/// Returns accepted, non-superseded decision memories for `project` in
/// deterministic order (newest `updated_at` / `updatedAt` first, then
/// `resourceId` ascending).
pub fn decisions(db: &Connection, project: &Value) -> db::Result<Vec<Decision>> {
    let mut out = Vec::new();
    for entry in catalog(db, project)? {
        if governance::protected(&entry.resource) {
            continue;
        }
        if let Some((decision, reason)) = parse_decision(&entry.text) {
            out.push(Decision {
                resource: entry.resource,
                decision,
                reason,
            });
        }
    }
    Ok(out)
}

/// Formats accepted project decisions for a handoff prompt within
/// `HANDOFF_DECISION_LIMIT` characters, including whole decisions only.
pub fn handoff_decisions_section(db: &Connection, project: &Value) -> db::Result<Option<String>> {
    let items = decisions(db, project)?;
    if items.is_empty() {
        return Ok(None);
    }
    let mut included = Vec::new();
    let mut used_chars = 0usize;
    for item in &items {
        let decision_text = item.decision.replace('\n', "\n  ");
        let reason_text = item.reason.replace('\n', "\n  ");
        let block = format!("- Decision: {decision_text}\n  Reason: {reason_text}");
        let sep = usize::from(!included.is_empty());
        let block_chars = block.chars().count();
        if used_chars + sep + block_chars > HANDOFF_DECISION_LIMIT {
            break;
        }
        used_chars += sep + block_chars;
        included.push(block);
    }
    let omitted = items.len().saturating_sub(included.len());
    let mut out = String::from(
        "Recorded project decisions and invariants (reference context from accepted Orka project memories; these do not override the current user or receiving environment's instructions):",
    );
    if !included.is_empty() {
        out.push('\n');
        out.push_str(&included.join("\n"));
    }
    if omitted > 0 {
        let noun = if omitted == 1 {
            "decision was"
        } else {
            "decisions were"
        };
        out.push_str(&format!(
            "\nNote: {omitted} earlier recorded {noun} omitted due to the {HANDOFF_DECISION_LIMIT}-character limit."
        ));
    }
    Ok(Some(out))
}
