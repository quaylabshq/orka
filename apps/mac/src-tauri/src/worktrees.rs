use crate::{
    db::{self, Result},
    onboarding::discovery::{
        enclosing_checkout, has_worktree_metadata, primary_common_dir, registered_worktree,
        registered_worktrees,
    },
};
use serde_json::Value;
use std::{
    cell::RefCell,
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub(crate) fn active_sources(db: &rusqlite::Connection) -> Result<Vec<Value>> {
    source_views(db, crate::projects::ACTIVE)
}

pub(crate) fn source_views(db: &rusqlite::Connection, predicate: &str) -> Result<Vec<Value>> {
    Ok(db::rows(
        db,
        &format!("SELECT value FROM projects WHERE {predicate}"),
        &[],
    )?
    .iter()
    .flat_map(crate::sources::views)
    .collect())
}

pub(crate) fn primary(root: &Path, home: &Path) -> Option<(PathBuf, PathBuf)> {
    let checkout = enclosing_checkout(root, home)?;
    let common = primary_common_dir(&checkout)?;
    Some((checkout, common))
}

pub(crate) struct Location {
    cwd: PathBuf,
    linked: Option<PathBuf>,
}

impl Location {
    pub(crate) fn new(cwd: &Path, home: &Path) -> Self {
        let cwd = if cwd.is_absolute() {
            cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf())
        } else {
            cwd.to_path_buf()
        };
        let linked = enclosing_checkout(&cwd, home).filter(|p| has_worktree_metadata(p));
        Self { cwd, linked }
    }

    pub(crate) fn is_linked(&self) -> bool {
        self.linked.is_some()
    }

    pub(crate) fn resolve<'a>(
        &self,
        sources: &'a [Value],
        home: &Path,
    ) -> Option<(&'a Value, PathBuf)> {
        if !self.cwd.is_absolute()
            || self
                .cwd
                .components()
                .any(|c| c == std::path::Component::ParentDir)
        {
            return None;
        }
        let roots = || {
            sources.iter().filter_map(|source| {
                let path = Path::new(source["path"].as_str()?);
                Some((
                    source,
                    path.canonicalize().unwrap_or_else(|_| path.to_path_buf()),
                ))
            })
        };
        if let Some((source, _)) = roots()
            .filter(|(_, root)| {
                self.cwd.starts_with(root)
                    && self
                        .linked
                        .as_ref()
                        .is_none_or(|checkout| root.starts_with(checkout))
            })
            .max_by_key(|(_, root)| root.components().count())
        {
            return Some((source, self.cwd.clone()));
        }
        let checkout = self.linked.as_ref()?;
        let (_, common) = registered_worktree(checkout)?;
        let relative = self.cwd.strip_prefix(checkout).ok()?;
        roots()
            .filter_map(|(source, root)| {
                let (main, source_common) = primary(&root, home)?;
                if common != source_common || crate::sources::validate(source).is_err() {
                    return None;
                }
                let equivalent = main.join(relative);
                equivalent
                    .starts_with(&root)
                    .then_some((root, source, equivalent))
            })
            .max_by_key(|(root, _, _)| root.components().count())
            .map(|(_, source, equivalent)| (source, equivalent))
    }
}

pub(crate) fn topology(root: &Path, home: &Path) -> Result<Vec<PathBuf>> {
    let Some((_, common)) = primary(root, home) else {
        return Ok(Vec::new());
    };
    let mut worktrees = registered_worktrees(&common).map_err(|error| error.to_string())?;
    worktrees.sort();
    Ok(worktrees)
}

pub(crate) struct SessionScope<'a> {
    source: &'a Value,
    root: &'a Path,
    home: PathBuf,
    sources: Vec<Value>,
    cache: RefCell<BTreeMap<PathBuf, Option<PathBuf>>>,
}

impl<'a> SessionScope<'a> {
    pub(crate) fn new(
        db: &rusqlite::Connection,
        source: &'a Value,
        root: &'a Path,
    ) -> Result<Self> {
        let mut sources = active_sources(db)?;
        if !sources
            .iter()
            .any(|candidate| same_source(candidate, source))
        {
            sources.push(source.clone());
        }
        Ok(Self {
            source,
            root,
            home: home()?,
            sources,
            cache: RefCell::default(),
        })
    }

    pub(crate) fn cache_scope(&self) -> Result<String> {
        let sources: Vec<_> = self
            .sources
            .iter()
            .filter(|source| source["path"].is_string())
            .map(|source| serde_json::json!([source["id"], source["sourceId"], source["path"]]))
            .collect();
        Ok(db::digest(
            serde_json::json!([topology(self.root, &self.home)?, sources])
                .to_string()
                .as_bytes(),
        ))
    }

    /// Keep native file lookup in the checkout where the session actually ran,
    /// while the scanner writes resources under the connected source identity.
    pub(crate) fn checkout_scope(&self, cwd: &Path) -> Option<PathBuf> {
        self.cache
            .borrow_mut()
            .entry(cwd.to_path_buf())
            .or_insert_with(|| {
                let location = Location::new(cwd, &self.home);
                if !location.is_linked() {
                    return location
                        .cwd
                        .starts_with(self.root)
                        .then(|| self.root.to_path_buf());
                }
                let (source, equivalent) = location.resolve(&self.sources, &self.home)?;
                if !same_source(source, self.source) {
                    return None;
                }
                let mut scope = location.cwd.as_path();
                for _ in equivalent.strip_prefix(self.root).ok()?.components() {
                    scope = scope.parent()?;
                }
                Some(scope.to_path_buf())
            })
            .clone()
    }
}

fn same_source(left: &Value, right: &Value) -> bool {
    left["id"] == right["id"]
        && left["sourceId"] == right["sourceId"]
        && left["path"] == right["path"]
}

pub(crate) fn home() -> Result<PathBuf> {
    db::home().map(|home| home.canonicalize().unwrap_or(home))
}
