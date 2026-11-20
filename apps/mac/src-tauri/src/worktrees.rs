use crate::{
    db::{self, Result},
    onboarding::discovery::{
        enclosing_checkout, has_worktree_metadata, primary_common_dir, registered_worktree,
        registered_worktrees,
    },
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
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
    boundary: Option<PathBuf>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Observed {
    checkout: PathBuf,
    pub(crate) scope: PathBuf,
    admin: PathBuf,
    project: Value,
    source: Value,
}

impl Observed {
    pub(crate) fn matches(&self, source: &Value) -> bool {
        self.project == source["id"] && self.source == source["sourceId"]
    }

    pub(crate) fn remember(&self, db: &rusqlite::Connection) -> Result<()> {
        db.execute("INSERT INTO worktree_routes(scope,value) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET value=excluded.value WHERE value<>excluded.value", params![self.scope.to_string_lossy(), serde_json::to_string(self).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub(crate) fn pin(&self, db: &rusqlite::Connection, tool: &str, id: &str) -> Result<()> {
        if id != "unknown" {
            db.execute(
                "INSERT OR IGNORE INTO worktree_sessions(tool,native_id,value) VALUES(?,?,?)",
                params![
                    tool,
                    id,
                    serde_json::to_string(self).map_err(|e| e.to_string())?
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

pub(crate) fn pinned_session(
    db: &rusqlite::Connection,
    tool: &str,
    id: &str,
) -> Result<Option<Observed>> {
    db.query_row(
        "SELECT value FROM worktree_sessions WHERE tool=? AND native_id=?",
        [tool, id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|value| serde_json::from_str(&value).map_err(|e| e.to_string()))
    .transpose()
}

fn observations(db: &rusqlite::Connection) -> Result<Vec<Observed>> {
    db::rows(db, "SELECT value FROM worktree_routes ORDER BY scope", &[])?
        .into_iter()
        .map(serde_json::from_value)
        .collect::<std::result::Result<_, _>>()
        .map_err(|e| e.to_string())
}

pub(crate) fn is_stale(db: &rusqlite::Connection, cwd: &Path, home: &Path) -> Result<bool> {
    let Some(location) = Location::new(cwd, home) else {
        return Ok(false);
    };
    Ok(historical(&location, &observations(db)?).is_some())
}

fn historical<'a>(location: &Location, history: &'a [Observed]) -> Option<&'a Observed> {
    history
        .iter()
        .filter(|route| {
            location.cwd.starts_with(&route.scope)
                && location
                    .boundary
                    .as_ref()
                    .is_none_or(|boundary| !boundary.starts_with(&route.checkout))
        })
        .max_by_key(|route| route.scope.components().count())
}

pub(crate) struct Route<'a> {
    pub(crate) source: &'a Value,
    pub(crate) equivalent: PathBuf,
    pub(crate) observed: Option<Observed>,
}

pub(crate) struct Resolver<'a> {
    home: &'a Path,
    sources: Vec<Source<'a>>,
}

struct Source<'a> {
    value: &'a Value,
    root: PathBuf,
    primary: Option<(PathBuf, PathBuf)>,
}

impl<'a> Resolver<'a> {
    pub(crate) fn new(sources: &'a [Value], home: &'a Path) -> Self {
        Self {
            home,
            sources: sources
                .iter()
                .filter_map(|source| {
                    let path = Path::new(source["path"].as_str()?);
                    let root = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
                    let primary =
                        primary(&root, home).filter(|_| crate::sources::validate(source).is_ok());
                    Some(Source {
                        value: source,
                        root,
                        primary,
                    })
                })
                .collect(),
        }
    }

    pub(crate) fn resolve(&self, cwd: &Path) -> Option<Route<'a>> {
        let location = Location::new(cwd, self.home)?;
        let registration = location.boundary.as_deref().and_then(registered_worktree);
        self.resolve_location(&location, registration.as_ref())
    }

    fn resolve_location(
        &self,
        location: &Location,
        registration: Option<&(PathBuf, PathBuf)>,
    ) -> Option<Route<'a>> {
        let cwd = &location.cwd;
        let boundary = location.boundary.as_ref();
        let linked = registration.is_some() || boundary.is_some_and(|p| has_worktree_metadata(p));
        if linked && registration.is_none() {
            return None;
        }
        self.sources
            .iter()
            .filter_map(|source| {
                let root = &source.root;
                let direct = cwd.starts_with(root) && boundary.is_none_or(|p| root.starts_with(p));
                let (scope, equivalent) = if direct {
                    (root.clone(), cwd.clone())
                } else {
                    let (admin, common) = registration?;
                    let (main, source_common) = source.primary.as_ref()?;
                    let checkout = boundary?;
                    if source_common != common || admin == common {
                        return None;
                    }
                    let scope = checkout.join(root.strip_prefix(main).ok()?);
                    let equivalent = root.join(cwd.strip_prefix(&scope).ok()?);
                    (scope, equivalent)
                };
                if direct && linked && crate::sources::validate(source.value).is_err() {
                    return None;
                }
                let depth = scope.components().count();
                let observed = registration
                    .zip(boundary)
                    .map(|((admin, _), checkout)| Observed {
                        checkout: checkout.clone(),
                        scope,
                        admin: admin.clone(),
                        project: source.value["id"].clone(),
                        source: source.value["sourceId"].clone(),
                    });
                Some((
                    (
                        depth,
                        direct,
                        &source.value["id"],
                        &source.value["sourceId"],
                    ),
                    Route {
                        source: source.value,
                        equivalent,
                        observed,
                    },
                ))
            })
            .max_by(|(a, _), (b, _)| {
                a.0.cmp(&b.0)
                    .then(a.1.cmp(&b.1))
                    .then_with(|| b.2.as_str().cmp(&a.2.as_str()))
                    .then_with(|| b.3.as_str().cmp(&a.3.as_str()))
            })
            .map(|(_, route)| route)
    }
}

impl Location {
    fn new(cwd: &Path, home: &Path) -> Option<Self> {
        if !cwd.is_absolute()
            || cwd
                .components()
                .any(|c| c == std::path::Component::ParentDir)
        {
            return None;
        }
        let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
        let boundary = enclosing_checkout(&cwd, home);
        Some(Self { cwd, boundary })
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

#[derive(Clone)]
pub(crate) struct SessionCheckout {
    pub(crate) scope: PathBuf,
    observed: Option<Observed>,
    pub(crate) historical: bool,
}

impl SessionCheckout {
    pub(crate) fn plan_key(&self, tool: &str, relative: &Path) -> String {
        match &self.observed {
            Some(route) => format!(
                "{tool}/worktrees/{}/files/{}",
                db::digest(route.admin.as_os_str().as_encoded_bytes()),
                relative.display()
            ),
            None => format!("{tool}/files/{}", relative.display()),
        }
    }
}

pub(crate) struct SessionScope<'a> {
    db: &'a rusqlite::Connection,
    source: &'a Value,
    root: &'a Path,
    resolver: Resolver<'a>,
    history: Vec<Observed>,
    cache: RefCell<BTreeMap<PathBuf, Option<SessionCheckout>>>,
}

pub(crate) fn session_sources(db: &rusqlite::Connection, source: &Value) -> Result<Vec<Value>> {
    let mut sources = active_sources(db)?;
    // Discovery can scan a source view before the enclosing project is saved.
    sources.retain(|candidate| {
        candidate["id"] != source["id"]
            || candidate["path"] != source["path"]
            || !candidate["sourceId"].is_null()
            || source["sourceId"].is_null()
    });
    if !sources
        .iter()
        .any(|candidate| same_source(candidate, source))
    {
        sources.push(source.clone());
    }
    Ok(sources)
}

impl<'a> SessionScope<'a> {
    pub(crate) fn new(
        db: &'a rusqlite::Connection,
        source: &'a Value,
        root: &'a Path,
        sources: &'a [Value],
        home: &'a Path,
    ) -> Result<Self> {
        let history = observations(db)?;
        Ok(Self {
            db,
            source,
            root,
            resolver: Resolver::new(sources, home),
            history,
            cache: RefCell::default(),
        })
    }

    pub(crate) fn cache_scope(&self) -> Result<String> {
        let sources: Vec<_> = self
            .resolver
            .sources
            .iter()
            .map(|s| serde_json::json!([s.value["id"], s.value["sourceId"], s.root]))
            .collect();
        Ok(db::digest(
            serde_json::json!([
                "worktrees-v2",
                topology(self.root, self.resolver.home).ok(),
                sources,
                self.history
            ])
            .to_string()
            .as_bytes(),
        ))
    }

    pub(crate) fn checkout_scope(&self, cwd: &Path) -> Option<SessionCheckout> {
        self.cache
            .borrow_mut()
            .entry(cwd.to_path_buf())
            .or_insert_with(|| {
                let location = Location::new(cwd, self.resolver.home)?;
                let registration = location.boundary.as_deref().and_then(registered_worktree);
                if let Some(route) = historical(&location, &self.history) {
                    return route.matches(self.source).then(|| SessionCheckout {
                        scope: route.scope.clone(),
                        observed: Some(route.clone()),
                        historical: true,
                    });
                }
                let route = self
                    .resolver
                    .resolve_location(&location, registration.as_ref())?;
                if let Some(observed) = &route.observed {
                    if let Err(error) = observed.remember(self.db) {
                        eprintln!(
                            "Cannot remember worktree {}: {error}",
                            observed.scope.display()
                        );
                    }
                }
                same_source(route.source, self.source).then(|| SessionCheckout {
                    scope: route
                        .observed
                        .as_ref()
                        .map_or_else(|| self.root.to_path_buf(), |route| route.scope.clone()),
                    observed: route.observed,
                    historical: false,
                })
            })
            .clone()
    }

    pub(crate) fn for_session(
        &self,
        tool: &str,
        id: &str,
        cwd: &Path,
    ) -> Result<Option<SessionCheckout>> {
        let saved = pinned_session(self.db, tool, id)?;
        let current = self.checkout_scope(cwd);
        if let Some(route) = saved {
            if !route.matches(self.source) {
                return Ok(None);
            }
            return Ok(Some(
                current
                    .filter(|c| {
                        c.observed
                            .as_ref()
                            .is_some_and(|live| live.admin == route.admin)
                    })
                    .unwrap_or_else(|| SessionCheckout {
                        scope: route.scope.clone(),
                        observed: Some(route),
                        historical: true,
                    }),
            ));
        }
        Ok(current)
    }

    pub(crate) fn pin(&self, checkout: &SessionCheckout, tool: &str, id: &str) -> Result<()> {
        if let Some(observed) = &checkout.observed {
            observed.pin(self.db, tool, id)?;
        }
        Ok(())
    }
}

pub(crate) fn same_source(left: &Value, right: &Value) -> bool {
    left["id"] == right["id"]
        && left["sourceId"] == right["sourceId"]
        && left["path"] == right["path"]
}

pub(crate) fn home() -> Result<PathBuf> {
    db::home().map(|home| home.canonicalize().unwrap_or(home))
}
