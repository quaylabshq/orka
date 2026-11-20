use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::Notify, time::Instant};

const DEBOUNCE: Duration = Duration::from_millis(150);

#[derive(Default)]
struct Pending {
    repos: Mutex<BTreeSet<PathBuf>>,
    wake: Notify,
}

impl Pending {
    fn signal(&self, common: &Path) {
        self.repos.lock().unwrap().insert(common.to_path_buf());
        self.wake.notify_one();
    }

    fn take(&self) -> BTreeSet<PathBuf> {
        std::mem::take(&mut *self.repos.lock().unwrap())
    }
}

struct Subscription {
    identity: (u64, u64),
    _watcher: Option<RecommendedWatcher>,
}

type Subscribe = fn(&Path, Arc<Pending>) -> notify::Result<RecommendedWatcher>;

pub(super) struct Watches {
    pending: Arc<Pending>,
    subscriptions: BTreeMap<PathBuf, Subscription>,
    subscribe: Subscribe,
}

impl Default for Watches {
    fn default() -> Self {
        Self {
            pending: Arc::default(),
            subscriptions: BTreeMap::new(),
            subscribe,
        }
    }
}

impl Watches {
    #[cfg(test)]
    pub(super) fn failing() -> Self {
        Self {
            subscribe: |_, _| Err(notify::Error::generic("injected startup failure")),
            ..Self::default()
        }
    }

    #[cfg(test)]
    pub(super) fn counts(&self) -> (usize, usize) {
        (
            self.subscriptions.len(),
            self.subscriptions
                .values()
                .filter(|sub| sub._watcher.is_some())
                .count(),
        )
    }

    pub(super) fn refresh<'a>(&mut self, commons: impl Iterator<Item = &'a Path>) {
        let available: BTreeMap<_, _> = commons
            .collect::<BTreeSet<_>>()
            .into_iter()
            .filter_map(|common| {
                let meta = fs::metadata(common).ok()?;
                meta.is_dir().then_some((common, (meta.dev(), meta.ino())))
            })
            .collect();
        self.subscriptions
            .retain(|path, sub| available.get(path.as_path()) == Some(&sub.identity));
        for (common, identity) in available {
            if !self.subscriptions.contains_key(common) {
                let watcher = (self.subscribe)(common, self.pending.clone())
                    .map_err(|error| {
                        eprintln!(
                            "Worktree watch {}: {error}; using the poll",
                            common.display()
                        );
                    })
                    .ok();
                // Keep failed subscriptions until the connection or directory changes.
                self.subscriptions.insert(
                    common.to_path_buf(),
                    Subscription {
                        identity,
                        _watcher: watcher,
                    },
                );
            }
        }
    }
}

fn subscribe(common: &Path, pending: Arc<Pending>) -> notify::Result<RecommendedWatcher> {
    let root = common.to_path_buf();
    let admin = common.join("worktrees");
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            if event.need_rescan()
                || (!event.kind.is_access()
                    && event
                        .paths
                        .iter()
                        .any(|path| path == &root || path.starts_with(&admin)))
            {
                pending.signal(&root);
            }
        }
    })?;
    // Watching the common dir includes the first creation of worktrees/ without
    // having to restart the stream or leave a gap in coverage.
    watcher.watch(common, RecursiveMode::Recursive)?;
    Ok(watcher)
}

pub(super) async fn run<S: Send + 'static>(
    mut state: S,
    mut watches: Watches,
    poll_interval: Duration,
    mut pass: impl FnMut(&mut S, &mut Watches, Option<&BTreeSet<PathBuf>>) + Send + 'static,
) {
    let pending = watches.pending.clone();
    let mut next_poll = Instant::now();
    loop {
        let full = tokio::select! {
            biased;
            () = tokio::time::sleep_until(next_poll) => true,
            () = pending.wake.notified() => false,
        };
        let repos = if full {
            None
        } else {
            tokio::time::sleep(DEBOUNCE).await;
            let repos = pending.take();
            if repos.is_empty() {
                continue;
            }
            Some(repos)
        };
        // While this pass runs, callbacks only fill the set for the next pass.
        let Ok(next) = tokio::task::spawn_blocking(move || {
            pass(&mut state, &mut watches, repos.as_ref());
            (state, watches, pass)
        })
        .await
        else {
            return;
        };
        (state, watches, pass) = next;
        if full {
            next_poll = Instant::now() + poll_interval;
        }
    }
}
