import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Snapshot } from "../../types.js";
import {
  destinationCandidates,
  initialDraft,
  readableSelection,
  type AccountProfile,
  type DiscoveredProject,
  type OnboardingDraft,
  type OnboardingStep,
} from "./model.js";
export const onboardingCommand = <T>(
  action: string,
  input: unknown = {},
  context?: { user: string | null; service?: string },
) =>
  invoke<T>("onboarding_command", { action, input, context: context ?? null });

function ranked(projects: DiscoveredProject[]) {
  return [...projects].sort(
    (a, b) =>
      (b.relevance ?? 0) - (a.relevance ?? 0) ||
      (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) ||
      (b.pendingChanges ?? 0) - (a.pendingChanges ?? 0) ||
      a.name.localeCompare(b.name) ||
      a.path.localeCompare(b.path),
  );
}
interface DiscoveryResult {
  projects: DiscoveredProject[];
  truncated?: boolean;
  incomplete?: boolean;
}

function pickedRows(draft: OnboardingDraft) {
  const { folder } = draft;
  const prefix = folder.endsWith("/") ? folder : `${folder}/`;
  // Legacy drafts saved only the first picker path. Other picks have no history sources.
  return draft.projects.filter(
    (row) =>
      row.folderPick ??
      (!!folder &&
        (row.path === folder ||
          row.path.startsWith(prefix) ||
          row.sources.length === 0)),
  );
}

function discoveryStep(projects: DiscoveredProject[]): OnboardingStep {
  if (!projects.length) return "empty";
  return projects.some((project) => project.readable === false)
    ? "partial-access"
    : "select";
}

function restoredDiscoveryStep(
  before: OnboardingDraft,
  projects: DiscoveredProject[],
): OnboardingStep {
  const step = discoveryStep(projects);
  if (before.step !== "select" || step !== "partial-access") return step;

  // The user can acknowledge blocked folders and continue to the selection step.
  const knownBlocked = new Set(
    before.projects
      .filter((row) => row.readable === false)
      .map((row) => row.path),
  );
  return projects.some(
    (row) => row.readable === false && !knownBlocked.has(row.path),
  )
    ? "partial-access"
    : "select";
}

function foldedProject(history: DiscoveryResult, path: string) {
  if (history.incomplete || history.truncated) return;
  const matches = history.projects.filter((row) =>
    row.worktreePaths?.includes(path),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** Retains saved choices, including rows that are temporarily unavailable. */
function reconcile(
  before: OnboardingDraft,
  projects: DiscoveredProject[],
  history: DiscoveryResult,
  extra: string[] = [],
) {
  const listed = new Map(projects.map((row) => [row.path, row]));
  const keep = new Set(extra);
  for (const path of before.selected) {
    if (listed.has(path)) {
      keep.add(path);
      continue;
    }
    const folded = foldedProject(history, path);
    const target = folded && listed.get(folded.path);
    if (target && target.readable !== false) keep.add(target.path);
  }
  const rows = ranked(projects);
  return {
    projects: rows,
    selected: rows.filter((row) => keep.has(row.path)).map((row) => row.path),
  };
}

export function useOnboarding(
  state: Snapshot,
  refresh: () => Promise<void>,
  onComplete: (projectId: string) => void,
) {
  const scope = useRef({ user: state.user, service: state.config?.apiUrl });
  const command = useCallback(
    <T>(action: string, input: unknown = {}) =>
      onboardingCommand<T>(action, input, scope.current),
    [],
  );
  const [draft, setDraft] = useState<OnboardingDraft>(() => {
    const saved = state.onboarding?.draft;
    const step =
      state.onboarding?.location?.ok === false
        ? "location"
        : saved?.step === "scanning"
          ? "discover"
          : ["finish-setup", "claude", "codex"].includes(saved?.step ?? "")
            ? "invite"
            : (saved?.step ?? "profile");
    return { ...initialDraft, ...saved, step };
  });
  const [profile, setProfile] = useState<AccountProfile | null>(
    state.accountProfile ?? null,
  );
  const [profileReady, setProfileReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = useRef(draft);
  const applyDraft = useCallback((next: OnboardingDraft) => {
    current.current = next;
    setDraft(next);
  }, []);
  const active = useRef(true);
  const locked = useRef(false);
  const draftWrites = useRef(Promise.resolve());
  const draftDirty = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const checkpoint = useCallback(
    async (patch: Partial<OnboardingDraft>) => {
      if (!active.current)
        throw new Error("Account or service changed. Reopen onboarding.");
      const next = { ...current.current, ...patch };
      await command("checkpoint", next);
      if (active.current) applyDraft(next);
      return next;
    },
    [applyDraft, command],
  );
  const queueDraft = useCallback(
    (next: OnboardingDraft, reportError: boolean) => {
      applyDraft(next);
      draftDirty.current = true;
      // Rescans and user edits write complete drafts through the same queue.
      draftWrites.current = draftWrites.current.then(async () => {
        if (!active.current) return;
        try {
          await command("checkpoint", next);
          if (current.current === next) draftDirty.current = false;
        } catch (e) {
          if (reportError && active.current && current.current === next)
            setError(String(e).replace(/^Error:\s*/, ""));
        }
      });
    },
    [applyDraft, command],
  );
  const updateChoices = (
    patch: (
      draft: OnboardingDraft,
    ) => Partial<
      Pick<
        OnboardingDraft,
        "selected" | "sharing" | "choices" | "sourceChoices"
      >
    >,
  ) => {
    if (locked.current || !active.current) return;
    setError("");
    queueDraft({ ...current.current, ...patch(current.current) }, true);
  };
  const run = async (task: () => Promise<unknown>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await draftWrites.current;
      if (!active.current) return;
      // Flush a failed write before any action can use stale progress.
      if (draftDirty.current) {
        await checkpoint({});
        draftDirty.current = false;
      }
      setError("");
      await task();
    } catch (e) {
      if (active.current) setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (draft.step !== "profile") return;
    let live = true;
    void command<AccountProfile>("profile")
      .then((value) => {
        if (live) {
          setProfile(value);
          setProfileReady(true);
        }
      })
      .catch((e) => {
        if (live) {
          setError(String(e));
          setProfileReady(true);
        }
      });
    return () => {
      live = false;
    };
  }, [draft.step, command]);
  useEffect(() => {
    if (!["syncing", "retrying"].includes(draft.step)) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const saved = await command<OnboardingDraft>("progress");
        if (live && saved?.step) applyDraft(saved);
      } catch (e) {
        if (live) setError(String(e));
      } finally {
        if (live) timer = setTimeout(() => void poll(), 800);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [draft.step, command, applyDraft]);
  const go = (step: OnboardingStep) => void run(() => checkpoint({ step }));
  const historyWithFallback = useCallback(
    () =>
      command<DiscoveryResult>("discover").catch((): DiscoveryResult => ({
        projects: [],
        incomplete: true,
      })),
    [command],
  );
  const mergeDiscovery = useCallback(
    async (
      before: OnboardingDraft,
      history: DiscoveryResult,
      picks: DiscoveredProject[] = [],
    ) => {
      const pickedPaths = new Set(pickedRows(before).map((row) => row.path));
      const incomplete = history.incomplete || history.truncated;
      const rows = new Map(history.projects.map((row) => [row.path, row]));
      for (const pick of picks) {
        const latest = rows.get(pick.path);
        rows.set(pick.path, {
          ...pick,
          ...latest,
          readable: pick.readable,
          folderPick: true,
        });
      }
      const recheck: DiscoveredProject[] = [];
      const selected = new Set(before.selected);
      for (const saved of before.projects) {
        const isPick = pickedPaths.has(saved.path);
        const latest = rows.get(saved.path);
        if (latest) {
          if (isPick) rows.set(saved.path, { ...latest, folderPick: true });
          continue;
        }
        const savedT3 =
          /\/\.t3\/worktrees\/[^/]+\/[^/]+$/.test(saved.path) &&
          (saved.readable === false || selected.has(saved.path));
        if (isPick || incomplete || savedT3) {
          recheck.push(isPick ? { ...saved, folderPick: true } : saved);
        }
      }
      if (recheck.length) {
        const statuses = await command<
          Record<string, boolean | null | undefined>
        >("check-discovered-folders", {
          paths: recheck.map((row) => row.path),
          historyPaths: recheck
            .filter((row) => !row.folderPick)
            .map((row) => row.path),
        }).catch(() => null);
        for (const row of recheck) {
          const status = statuses?.[row.path];
          if (status === null) continue;
          // Only a live Git link to a readable repository can replace this checkout.
          if (status === true && !row.folderPick) {
            const folded = foldedProject(history, row.path);
            if (
              folded?.linkedWorktreePaths?.includes(row.path) &&
              rows.get(folded.path)?.readable !== false
            )
              continue;
          }
          rows.set(row.path, { ...row, readable: status ?? row.readable });
        }
      }
      return [...rows.values()];
    },
    [command],
  );
  const rescan = useCallback(async () => {
    const start = current.current;
    const history = await historyWithFallback();
    if (!active.current) return;
    const projects = await mergeDiscovery(start, history);
    const before = current.current;
    if (
      !active.current ||
      locked.current ||
      before.reviewed ||
      before.projects !== start.projects ||
      before.step !== start.step
    )
      return;
    // The scan did not recheck rows the user chose after it started.
    const listed = new Set(projects.map((row) => row.path));
    const previous = new Set(start.selected);
    if (
      before.selected.some((path) => !previous.has(path) && !listed.has(path))
    )
      return;
    const next = reconcile(before, projects, history);
    const step = restoredDiscoveryStep(before, next.projects);
    if (
      step === before.step &&
      JSON.stringify(next.projects) === JSON.stringify(before.projects) &&
      JSON.stringify(next.selected) === JSON.stringify(before.selected)
    )
      return;
    queueDraft({ ...before, ...next, step }, false);
  }, [historyWithFallback, mergeDiscovery, queueDraft]);
  const restored = useRef(draft.step);
  const rescanned = useRef(false);
  useEffect(() => {
    if (rescanned.current || current.current.reviewed) return;
    if (!["select", "partial-access", "empty"].includes(restored.current))
      return;
    rescanned.current = true;
    void rescan();
  }, [rescan]);
  const find = async (paths?: string[], append = false) => {
    const before = current.current;
    applyDraft({ ...before, step: "scanning" });
    try {
      // A picked folder is honored as chosen, so its rows keep that marker.
      const results = paths
        ? await Promise.all(
            paths.map((path) =>
              command<DiscoveryResult>("discover", {
                path,
              }),
            ),
          )
        : [];
      const picks = results.flatMap((result) =>
        result.projects.map((project) => ({ ...project, folderPick: true })),
      );
      const history = !paths
        ? await command<DiscoveryResult>("discover")
        : append && pickedRows(before).length < before.projects.length
          ? await historyWithFallback()
          : { projects: [] };
      const discovered =
        append || !paths
          ? await mergeDiscovery(before, history, picks)
          : [
              ...new Map(
                [...history.projects, ...picks].map((row) => [row.path, row]),
              ).values(),
            ];
      const chosen = new Set(
        results.flatMap((result) =>
          result.projects.length === 1 && result.projects[0].readable !== false
            ? [result.projects[0].path]
            : [],
        ),
      );
      const { projects, selected } = reconcile(
        before,
        discovered,
        history,
        paths
          ? [...chosen].filter(
              (path) =>
                !before.projects.some(
                  (old) => old.path === path && old.readable !== false,
                ),
            )
          : [],
      );
      await checkpoint({
        projects,
        selected,
        folder: paths?.[0] ?? "",
        step: discoveryStep(projects),
        reviewed: false,
      });
    } catch (e) {
      try {
        await checkpoint({ step: "access-error", folder: paths?.[0] ?? "" });
      } catch {
        if (active.current)
          applyDraft({
            ...before,
            step: "access-error",
            folder: paths?.[0] ?? "",
          });
      }
      throw e;
    }
  };
  const chooseFolder = (append = false, defaultPath?: string) =>
    void run(async () => {
      const result = await open({
        directory: true,
        multiple: true,
        title: "Choose project folders",
        defaultPath,
      });
      const paths = typeof result === "string" ? [result] : (result ?? []);
      if (paths.length) await find(paths, append);
    });
  const proceed = () =>
    void run(async () => {
      const selected = readableSelection(current.current).map(
        (project) => project.path,
      );
      if (!selected.length) throw new Error("Choose at least one project.");
      const review = await command<
        Pick<OnboardingDraft, "catalog" | "matches">
      >("review", { paths: selected });
      const choices = Object.fromEntries(
        Object.entries(review.matches ?? {}).flatMap(([path, match]) => {
          const previous = current.current.choices?.[path];
          const sameRemote =
            current.current.matches?.[path]?.remoteKey === match.remoteKey;
          const stillAvailable =
            previous === "new" ||
            destinationCandidates(review, path).some(
              (project) => project.id === previous,
            );
          const choice =
            match.connectedId ??
            (sameRemote && stillAvailable ? previous : undefined);
          return choice ? [[path, choice]] : [];
        }),
      );
      await checkpoint({
        step: "review",
        matches: review.matches,
        catalog: review.catalog,
        choices,
        sourceChoices: Object.fromEntries(
          Object.entries(current.current.sourceChoices ?? {}).filter(
            ([path, source]) => {
              if (review.matches?.[path]?.connectedId) return false;
              const project = destinationCandidates(review, path).find(
                (project) => project.id === choices[path],
              );
              return project?.sources?.some(
                (candidate) => candidate.id === source,
              );
            },
          ),
        ),
        reviewed: false,
      });
    });
  const sync = (retry = false) =>
    void run(async () => {
      if (!retry) {
        // From here the native batch reads selected as the approved set to connect.
        const selected = readableSelection(current.current).map(
          (project) => project.path,
        );
        if (!selected.length) throw new Error("Choose at least one project.");
        await checkpoint({
          step: "syncing",
          selected,
          reviewed: true,
          sharing: { ...current.current.sharing, env: false },
        });
      } else await checkpoint({ step: "retrying" });
      void command<OnboardingDraft>("batch-sync", { retry })
        .then(async (next) => {
          if (active.current) {
            applyDraft(next);
            await refresh();
          }
        })
        .catch((e) => {
          if (active.current) setError(String(e));
        });
    });
  const complete = (projectId?: string, defer = false) =>
    void run(async () => {
      await command("complete", { defer });
      if (!active.current) return;
      const connected = current.current.projects.find(
        (project) =>
          project.projectId && current.current.selected.includes(project.path),
      );
      if (projectId || connected?.projectId)
        onComplete(projectId ?? connected!.projectId!);
      await refresh();
    });
  const background = (enabled: boolean) =>
    void run(async () => {
      try {
        await invoke("background_agent", { enabled });
      } catch (e) {
        if (!enabled) throw e;
        // Only a macOS registration denial belongs in Login Items recovery.
        // A test-build restriction or other failure must keep its real error.
        if (String(e).includes("Enable Orka in macOS Login Items")) {
          await checkpoint({ step: "background-off" });
          return;
        }
        throw e;
      }
      await checkpoint({ step: "invite" });
      await refresh();
    });
  return {
    draft,
    profile,
    profileReady,
    busy,
    error,
    go,
    setProjectChoice: (path: string, id: string) =>
      updateChoices((value) => ({
        choices: { ...value.choices, [path]: id },
        sourceChoices: { ...value.sourceChoices, [path]: "" },
      })),
    setSourceChoice: (path: string, id: string) =>
      updateChoices((value) => ({
        sourceChoices: { ...value.sourceChoices, [path]: id },
      })),
    setSharing: (
      kind: keyof Omit<OnboardingDraft["sharing"], "env">,
      enabled: boolean,
    ) =>
      updateChoices((value) => ({
        sharing: { ...value.sharing, [kind]: enabled, env: false },
      })),
    find: () => void run(() => find()),
    chooseFolder,
    retryFolder: () =>
      void run(() =>
        find(current.current.folder ? [current.current.folder] : undefined),
      ),
    restoreFolder: (path: string) =>
      void run(async () => {
        const chosen = await open({
          directory: true,
          multiple: false,
          defaultPath: path,
          title: "Give Orka access to this project folder",
        });
        if (!chosen) return;
        await command("folder-access", {
          path: chosen,
          expectedPath: path,
        });
        await checkpoint({ step: "retrying" });
        void command<OnboardingDraft>("batch-sync", { retry: true })
          .then((next) => {
            if (active.current) {
              applyDraft(next);
            }
          })
          .catch((e) => {
            if (active.current) setError(String(e));
          });
      }),
    proceed,
    sync,
    complete: () => complete(),
    defer: () => complete(undefined, true),
    completeProject: (id: string) => complete(id),
    background,
    saveProfile: (input: AccountProfile) =>
      void run(async () => {
        if (!input.jobRole?.trim())
          throw new Error("Select your role to continue.");
        const value = await command<AccountProfile>("save-profile", input);
        setProfile(value);
        await checkpoint({ step: "discover" });
        await refresh();
      }),
    toggle: (path: string) =>
      updateChoices((value) => ({
        selected: value.selected.includes(path)
          ? value.selected.filter((p) => p !== path)
          : [...value.selected, path],
      })),
    toggleVisible: (paths: string[]) =>
      updateChoices((value) => {
        const selected = new Set(value.selected);
        if (paths.every((path) => selected.has(path))) {
          for (const path of paths) selected.delete(path);
        } else {
          for (const path of paths) selected.add(path);
        }
        return { selected: [...selected] };
      }),
    openSettings: () =>
      void run(() =>
        command("open-settings", {
          kind: draft.step === "access-error" ? "privacy" : "login",
        }),
      ),
    checkLocation: () =>
      void run(async () => {
        const location = await command<{ ok: boolean }>("app-location");
        if (location.ok) await checkpoint({ step: "profile" });
        else
          throw new Error(
            "Open the copy of Orka in Applications, then check again.",
          );
      }),
  };
}
