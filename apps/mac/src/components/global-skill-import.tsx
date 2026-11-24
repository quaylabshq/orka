import { productAction } from "./desktop-usage.js";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleXIcon,
  FileIcon,
  FolderIcon,
  MessageSquareIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../types.js";
import { Button } from "./button.js";
import { useDesktopFeature } from "./desktop-usage.js";
import { Icon } from "./icon.js";
import { activeSources, repositoryLabel } from "./project-sources.js";
import { readSkillMarkdown } from "./skill-markdown.js";
import { useToastEscape, useToasts } from "./toasts.js";
import { useConnectProject } from "./use-project-setup.js";
import "./item-menu.css";
import "./global-skill-import.css";

type Agent = "codex" | "claude";
interface GlobalSkill {
  id: string;
  name: string;
  path: string;
  sources: Agent[];
  markdown: string;
  fileCount: number;
  exists: boolean;
  error: string | null;
}
interface Scan {
  skills: GlobalSkill[];
  errors: string[];
  usage?: SkillUsage;
}
interface SkillUsage {
  counts: Record<string, number>;
}
interface ImportResult {
  skillId: string;
  result?: { status: "draft" | "queued" | "local" };
  error?: string;
}
type Run = (action: () => Promise<unknown>) => Promise<void>;

/** How long the pointer rests on a row before its details open. */
const PEEK_DELAY = 400;
/** After this long the Add button says it is waiting on a running sync. */
const SYNC_WAIT_MS = 5000;
/** The one per-skill failure a second attempt can fix: the list went stale. */
const STALE_SKILL = "Global skill unavailable. Scan again.";
/** Native's wording when the project already has a skill folder of that name. */
const NAME_TAKEN =
  "A skill with this folder name is already in the project. Existing files were preserved.";
/** A toast has room for one short reason. */
const reason = (error?: string) =>
  error === NAME_TAKEN
    ? "A skill with the same folder name is already in this project."
    : error;

const agentName = (agent: Agent) => (agent === "codex" ? "Codex" : "Claude");
const plural = (count: number) => (count === 1 ? "skill" : "skills");

function AgentLogos({ agents }: { agents: Agent[] }) {
  return (
    <span
      className="add-skills-agents"
      role="img"
      aria-label={agents.map(agentName).join(" and ")}
    >
      {agents.map((agent) => (
        <img
          key={agent}
          src={`${import.meta.env.BASE_URL}source-icons/${agent}.svg`}
          width={14}
          height={14}
          alt=""
          draggable={false}
        />
      ))}
    </span>
  );
}

/** Paths keep both ends readable: the home folder and the skill's own name. */
function middle(path: string, max = 38) {
  if (path.length <= max) return path;
  const tail = Math.ceil((max - 1) * 0.45);
  return `${path.slice(0, max - 1 - tail)}…${path.slice(-tail)}`;
}

export function GlobalSkillImport({
  project,
  busy,
  run,
  onReview,
  compact = false,
}: {
  project: Project;
  busy: boolean;
  run: Run;
  onReview: () => void;
  /** Toolbar size and the short label, for use beside Filter and Sort. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const dismissToastOnEscape = useToastEscape();
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (adding) content.current?.focus({ preventScroll: true });
  }, [adding]);
  return (
    <Popover.Root
      open={open}
      // Skills are being copied in; the popover stays until that finishes.
      onOpenChange={(next) => (next || !adding) && setOpen(next)}
    >
      <Popover.Trigger asChild>
        <Button
          size={compact ? "sm" : "lg"}
          variant="primary"
          title="Add global skills"
          aria-haspopup="dialog"
        >
          {compact ? (
            "Add skills"
          ) : (
            <>
              <Icon icon={PlusIcon} />
              Add skills
            </>
          )}
        </Button>
      </Popover.Trigger>
      {adding &&
        createPortal(
          <div
            className="add-skills-add-backdrop"
            aria-hidden="true"
            onPointerDown={(event) => event.preventDefault()}
          />,
          document.body,
        )}
      <Popover.Portal>
        <Popover.Content
          ref={content}
          className="add-skills-popover"
          role="dialog"
          aria-label="Add global skills"
          aria-modal={adding || undefined}
          onFocusOutside={(event) => {
            if (!adding) return;
            event.preventDefault();
            content.current?.focus({ preventScroll: true });
          }}
          onPointerDownOutside={(event) => {
            if (adding) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest("[data-orka-toast]")
            )
              event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            if (adding) event.preventDefault();
            else dismissToastOnEscape(event);
          }}
          onKeyDown={(event) => {
            if (adding && event.key === "Tab") event.preventDefault();
          }}
          align="end"
          sideOffset={8}
          collisionPadding={12}
        >
          {/* Mounted per open, so every open reads the folders again. */}
          <AddSkills
            project={project}
            busy={busy}
            run={run}
            onReview={onReview}
            onAdding={setAdding}
            onClose={() => setOpen(false)}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AddSkills({
  project,
  busy,
  run,
  onReview,
  onAdding,
  onClose,
}: {
  project: Project;
  busy: boolean;
  run: Run;
  onReview: () => void;
  onAdding: (adding: boolean) => void;
  onClose: () => void;
}) {
  const { notify } = useToasts();
  const connectProject = useConnectProject();
  const startFeature = useDesktopFeature();
  const repositories = useMemo(
    () => activeSources(project.sources ?? []).filter((source) => source.path),
    [project.sources],
  );
  const [picked, setPicked] = useState(repositories[0]?.id);
  const sourceId = picked ?? repositories[0]?.id;
  // The first connected repository is the default only before a destination exists.
  if (picked === undefined && sourceId) setPicked(sourceId);
  const repository = repositories.find((source) => source.id === sourceId);
  const path = project.sources ? repository?.path : project.path;
  const needsDestination = Boolean(
    project.sources && !repository && repositories.length,
  );
  const destination = repository
    ? (repositoryLabel(project.sources ?? [], repository.id) ?? repository.name)
    : project.name;
  const peekId = useId();
  const [connectError, setConnectError] = useState("");
  const [scan, setScan] = useState<Scan | null>(null);
  const [scanError, setScanError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  /** Why the last attempt failed, when trying again can fix it. */
  const [retry, setRetry] = useState("");
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [peek, setPeek] = useState<{
    id: string;
    top: number;
    maxWidth: number;
    side: "left" | "right";
  }>();
  const active = useRef(true);
  const generation = useRef(0);
  const peekTimer = useRef(0);
  const list = useRef<HTMLUListElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const pendingUsage = useRef<SkillUsage>(undefined);
  const rankingFrame = useRef(0);

  const target = path ? JSON.stringify([sourceId, path]) : null;
  const [previousTarget, setPreviousTarget] = useState(target);
  if (previousTarget !== target) {
    setPreviousTarget(target);
    setScan(null);
    setScanError("");
    setSelected(new Set());
    setFailed({});
    setRetry("");
    setPeek(undefined);
  }

  const rescan = useCallback(async () => {
    const current = ++generation.current;
    setScan(null);
    setScanError("");
    try {
      const next = await invoke<Scan>("scan_global_skills", {
        projectId: project.id,
        sourceId: sourceId || undefined,
      });
      if (active.current && current === generation.current) setScan(next);
    } catch (error) {
      if (active.current && current === generation.current)
        setScanError(String(error));
    }
  }, [project.id, sourceId]);
  useEffect(() => {
    active.current = true;
    if (target) void rescan();
    return () => {
      active.current = false;
      generation.current += 1;
      window.clearTimeout(peekTimer.current);
      window.cancelAnimationFrame(rankingFrame.current);
    };
  }, [rescan, target]);

  const applyRanking = useCallback(() => {
    window.cancelAnimationFrame(rankingFrame.current);
    rankingFrame.current = window.requestAnimationFrame(() => {
      const usage = pendingUsage.current;
      // Wait for the pointer and focus to leave before moving rows.
      if (!usage || list.current?.matches(":hover, :focus-within")) return;
      pendingUsage.current = undefined;
      setScan((current) => current && { ...current, usage });
    });
  }, []);
  const hasSkills = Boolean(scan?.skills.length);
  useEffect(() => {
    if (!hasSkills) return;
    let mounted = true;
    void invoke<SkillUsage>("global_skill_usage", { projectId: project.id })
      .then((next) => {
        if (!mounted) return;
        pendingUsage.current = next;
        applyRanking();
      })
      .catch(() => {
        // The saved order remains usable if history cannot be refreshed.
      });
    return () => {
      mounted = false;
    };
  }, [applyRanking, hasSkills, project.id]);

  const skills = useMemo(
    () =>
      (scan?.skills ?? [])
        .map((skill) => {
          const { name, description } = readSkillMarkdown(skill.markdown);
          return {
            ...skill,
            folder: skill.name,
            name: name || skill.name,
            description,
            count: scan?.usage?.counts[skill.id],
          };
        })
        .sort(
          (a, b) =>
            (b.count ?? 0) - (a.count ?? 0) ||
            a.name.localeCompare(b.name) ||
            a.path.localeCompare(b.path),
        ),
    [scan],
  );
  type Skill = (typeof skills)[number];
  const unavailable = (skill: Skill) =>
    skill.exists ? "Already in project" : skill.error ? "Can’t be added" : "";
  const addable = skills.filter((skill) => !unavailable(skill));
  const search = query.trim().toLocaleLowerCase();
  // Skills that cannot be added stay out of sight until a search asks for one.
  const visible = skills.filter(
    (skill) =>
      (search ? skill.name.toLocaleLowerCase().includes(search) : true) &&
      (search || !unavailable(skill)),
  );
  useEffect(() => {
    // Filtering out every row removes the list without a pointer-leave event.
    if (!visible.length) applyRanking();
  }, [applyRanking, visible.length]);
  const selectable = visible.filter((skill) => !unavailable(skill));
  const chosen = addable.filter((skill) => selected.has(skill.id));
  const allSelected =
    selectable.length > 0 &&
    selectable.every((skill) => selected.has(skill.id));
  const someSelected = selectable.some((skill) => selected.has(skill.id));
  const locked = pending || busy;

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const report = (
    added: ImportResult[],
    dead: ImportResult[],
    name: (id: string) => string,
    keepsPickerOpen: boolean,
  ) => {
    const feedback = keepsPickerOpen
      ? { overPopover: true, returnFocusTo: searchInput.current }
      : {};
    if (added.length) {
      const subject =
        added.length === 1 ? name(added[0].skillId) : `${added.length} skills`;
      const statuses = added.map((item) => item.result?.status);
      if (statuses.includes("draft"))
        notify({
          kind: "success",
          ...feedback,
          title: `${subject} added on this Mac. Review ${added.length === 1 ? "it" : "them"} to share.`,
          action: { label: "Review", onClick: onReview },
        });
      else if (statuses.every((status) => status === "local"))
        notify({
          kind: "success",
          ...feedback,
          title: `${subject} added on this Mac. Sharing is off for skills.`,
        });
      else
        notify({
          kind: "success",
          ...feedback,
          title: `${subject} added to ${destination}`,
        });
    }
    // A failure that trying again cannot fix is explained once and let go.
    if (dead.length)
      notify({
        kind: "error",
        ...feedback,
        title:
          dead.length === 1
            ? `${name(dead[0].skillId)} wasn’t added. ${reason(dead[0].error)}`
            : `${dead.length} skills weren’t added. ${reason(dead[0].error)}`,
      });
  };
  const scanNow = () =>
    invoke<Scan>("scan_global_skills", {
      projectId: project.id,
      sourceId: sourceId || undefined,
    });
  const add = async () => {
    if (locked || !target || !chosen.length) return;
    const record = productAction();
    record("skill_import_started");
    const recordImported = startFeature("feature:skill_imported");
    setPending(true);
    onAdding(true);
    setRetry("");
    setFailed({});
    const timer = window.setTimeout(() => setWaiting(true), SYNC_WAIT_MS);
    const attempted = chosen;
    const name = (id: string) =>
      attempted.find((skill) => skill.id === id)?.name ?? "A skill";
    // Set once native has answered: a later refresh failure is not a failed add.
    let answered = false;
    let closeOnSuccess = false;
    try {
      await run(async () => {
        const { results } = await invoke<{ results: ImportResult[] }>(
          "add_global_skills",
          {
            projectId: project.id,
            sourceId: sourceId || undefined,
            skillIds: attempted.map((skill) => skill.id),
          },
        );
        answered = true;
        const added = results.filter((item) => item.result);
        // Native installs both local mirrors before returning a result. Its
        // queued status applies to publishing those files, not the import.
        if (added.length) recordImported();
        if (added.length < attempted.length) record("skill_import_failed");
        let stale = results.filter((item) => item.error === STALE_SKILL);
        const dead = results.filter(
          (item) => item.error && item.error !== STALE_SKILL,
        );
        const current = ++generation.current;
        let next: Scan | null = null;
        if (stale.length || dead.length) {
          try {
            next = await scanNow();
          } catch {
            // The list on screen stays; the next open reads the folders again.
          }
        }
        if (next) {
          const fresh = new Map(next.skills.map((skill) => [skill.id, skill]));
          const retryable: ImportResult[] = [];
          for (const item of stale) {
            const skill = fresh.get(item.skillId);
            if (skill && !skill.exists && !skill.error) retryable.push(item);
            else
              dead.push({
                ...item,
                error: skill?.exists
                  ? "It is already in this project."
                  : (skill?.error ?? "It is no longer in your global skills."),
              });
          }
          stale = retryable;
        }
        const keepsPickerOpen = stale.length > 0 || dead.length > 0;
        report(added, dead, name, keepsPickerOpen);
        if (!active.current) return;
        if (next && current === generation.current) setScan(next);
        else if (added.length && current === generation.current) {
          const addedIds = new Set(added.map((item) => item.skillId));
          setScan(
            (current) =>
              current && {
                ...current,
                skills: current.skills.map((skill) =>
                  addedIds.has(skill.id) ? { ...skill, exists: true } : skill,
                ),
              },
          );
        }
        const done = new Set([...added, ...dead].map((item) => item.skillId));
        setSelected(
          (current) => new Set([...current].filter((id) => !done.has(id))),
        );
        if (stale.length) {
          setFailed(
            Object.fromEntries(
              stale.map((item) => [
                item.skillId,
                "Its folder changed since the list was read.",
              ]),
            ),
          );
          setRetry(
            added.length
              ? `${added.length} added. ${stale.length} couldn’t be added.`
              : `Couldn’t add ${stale.length} ${plural(stale.length)}.`,
          );
        }
        closeOnSuccess = !keepsPickerOpen;
      });
    } catch (error) {
      if (!answered) record("skill_import_failed");
      if (active.current && !answered)
        setRetry(
          `Couldn’t add ${attempted.length} ${plural(attempted.length)}.\n${String(error)}`,
        );
    } finally {
      window.clearTimeout(timer);
      if (active.current) {
        setPending(false);
        setWaiting(false);
      }
      onAdding(false);
      if (closeOnSuccess) onClose();
    }
  };

  const openPeek = (id: string, row: HTMLElement, delay: number) => {
    window.clearTimeout(peekTimer.current);
    const popover = row.closest<HTMLElement>(".add-skills-popover");
    if (!popover) return;
    const { left, right, top } = popover.getBoundingClientRect();
    const rowTop = row.getBoundingClientRect().top - top;
    const rightSpace = window.innerWidth - right;
    const side = left >= 321 || left >= rightSpace ? "left" : "right";
    const maxWidth = (side === "left" ? left : rightSpace) - 21;
    peekTimer.current = window.setTimeout(
      () => setPeek({ id, top: rowTop, maxWidth, side }),
      delay,
    );
  };
  const closePeek = () => {
    window.clearTimeout(peekTimer.current);
    setPeek(undefined);
  };
  const peeked = peek && skills.find((skill) => skill.id === peek.id);

  const moveFocus = (event: React.KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const boxes = Array.from(
      list.current?.querySelectorAll<HTMLInputElement>(
        "input:not(:disabled)",
      ) ?? [],
    );
    if (!boxes.length) return;
    const index = boxes.indexOf(document.activeElement as HTMLInputElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? boxes.length - 1
          : event.key === "ArrowDown"
            ? Math.min(index + 1, boxes.length - 1)
            : Math.max(index - 1, 0);
    event.preventDefault();
    boxes[next].focus();
  };

  if (!target && !needsDestination)
    return (
      <div className="add-skills-message">
        <Icon icon={FolderIcon} size="lg" variant="secondary" />
        <h2>Connect a folder first</h2>
        <p>Skills are added to a project folder on this Mac.</p>
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => {
            setConnectError("");
            run(async () => {
              await connectProject(project.id);
            }).catch((error) => {
              if (active.current) setConnectError(String(error));
            });
          }}
        >
          <Icon icon={FolderIcon} size="sm" />
          Connect folder
        </Button>
        {connectError && (
          <p className="add-skills-note" data-tone="error" role="alert">
            <span className="add-skills-note-icon">
              <CircleXIcon size={14} aria-hidden="true" />
            </span>
            <span>Couldn’t connect the folder. {connectError}</span>
          </p>
        )}
      </div>
    );

  return (
    <div
      className="add-skills"
      onKeyDown={(event) => {
        // A portaled menu's keys bubble here through React; only keys from
        // inside the popover itself may submit.
        if (
          event.key === "Enter" &&
          event.currentTarget.contains(event.target as Node) &&
          !(event.target as HTMLElement).closest("button")
        ) {
          event.preventDefault();
          void add();
        }
      }}
    >
      <label className="add-skills-search">
        <SearchIcon size={16} aria-hidden="true" />
        <input
          ref={searchInput}
          type="search"
          aria-label="Search global skills"
          placeholder="Search global skills…"
          value={query}
          autoFocus
          disabled={locked || needsDestination}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button
            type="button"
            className="add-skills-clear"
            aria-label="Clear search"
            disabled={locked || needsDestination}
            onClick={() => setQuery("")}
          >
            <XIcon size={12} aria-hidden="true" />
          </button>
        )}
      </label>
      {(repositories.length > 1 || needsDestination) && (
        <div className="add-skills-repository">
          <FolderIcon size={16} aria-hidden="true" />
          <span>Add to repository</span>
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="add-skills-repository-select"
                aria-label="Add to repository"
                title={needsDestination ? undefined : destination}
                disabled={locked}
              >
                <span>
                  {needsDestination ? "Choose repository" : destination}
                </span>
                <ChevronDownIcon size={14} aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="item-menu-content add-skills-repository-menu"
                onKeyDown={(event) => event.stopPropagation()}
                align="end"
                sideOffset={4}
                collisionPadding={10}
              >
                <DropdownMenu.RadioGroup
                  value={repository?.id ?? ""}
                  onValueChange={setPicked}
                >
                  {repositories.map((source) => (
                    <DropdownMenu.RadioItem
                      key={source.id}
                      value={source.id}
                      className="item-menu-action"
                    >
                      <FolderIcon
                        className="item-menu-icon"
                        size={16}
                        aria-hidden
                      />
                      <span className="item-menu-label">
                        {repositoryLabel(project.sources ?? [], source.id)}
                      </span>
                      <DropdownMenu.ItemIndicator>
                        <CheckIcon size={14} aria-hidden="true" />
                      </DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      )}
      {needsDestination ? (
        <div className="add-skills-message" role="status">
          <Icon icon={FolderIcon} size="lg" variant="secondary" />
          <h2>Repository unavailable</h2>
          <p>Choose a connected repository.</p>
        </div>
      ) : scanError ? (
        <div className="add-skills-message">
          <Icon icon={TriangleAlertIcon} size="lg" variant="secondary" />
          <h2>Couldn’t read your global skills</h2>
          <p>{scanError}</p>
          <Button size="sm" variant="secondary" onClick={() => void rescan()}>
            <Icon icon={RefreshCwIcon} size="sm" />
            Try again
          </Button>
        </div>
      ) : !scan ? (
        <div className="add-skills-loading" role="status">
          <span className="sr-only">Reading your global skills…</span>
          {Array.from({ length: 6 }, (_, index) => (
            <span key={index} className="loading-fade" aria-hidden="true" />
          ))}
        </div>
      ) : !addable.length && !search ? (
        <div className="add-skills-message">
          <Icon icon={CheckIcon} size="lg" variant="secondary" />
          <h2>Nothing to add</h2>
          <p>
            {skills.some((skill) => !skill.exists)
              ? "Search for a skill to see why it can’t be added."
              : skills.length
                ? "Every global skill on this Mac is already in this project."
                : scan.errors.length
                  ? "No global skills could be read on this Mac."
                  : "No global skills found in Codex or Claude."}
          </p>
          {scan.errors.map((error, index) => (
            <p key={index} className="add-skills-note" role="status">
              <span className="add-skills-note-icon">
                <TriangleAlertIcon size={14} aria-hidden="true" />
              </span>
              <span>{error}</span>
            </p>
          ))}
        </div>
      ) : (
        <>
          <label className="add-skills-select-all">
            <input
              type="checkbox"
              className="add-skills-checkbox"
              checked={allSelected}
              ref={(input) => {
                if (input) input.indeterminate = !allSelected && someSelected;
              }}
              disabled={locked || !selectable.length}
              onChange={() =>
                setSelected((current) => {
                  const next = new Set(current);
                  for (const skill of selectable) {
                    if (allSelected) next.delete(skill.id);
                    else next.add(skill.id);
                  }
                  return next;
                })
              }
            />
            <span>Select all</span>
            <small>
              {search
                ? `${selectable.length} of ${addable.length} match`
                : `${addable.length} global ${plural(addable.length)}`}
            </small>
          </label>
          {visible.length ? (
            <ul
              ref={list}
              className="add-skills-list"
              aria-label="Global skills"
              onPointerLeave={applyRanking}
              onBlurCapture={applyRanking}
              onKeyDown={moveFocus}
              onScroll={closePeek}
            >
              {visible.map((skill) => {
                const reason = unavailable(skill);
                return (
                  <li key={skill.id}>
                    <label
                      className="add-skills-row"
                      data-unavailable={reason ? "" : undefined}
                      onPointerEnter={(event) =>
                        openPeek(skill.id, event.currentTarget, PEEK_DELAY)
                      }
                      onPointerLeave={closePeek}
                      onFocus={(event) =>
                        openPeek(skill.id, event.currentTarget, 0)
                      }
                      onBlur={closePeek}
                    >
                      <input
                        type="checkbox"
                        className="add-skills-checkbox"
                        aria-label={`Select skill: ${skill.name}`}
                        aria-describedby={
                          peek?.id === skill.id ? peekId : undefined
                        }
                        checked={selected.has(skill.id)}
                        disabled={locked || Boolean(reason)}
                        onChange={() => toggle(skill.id)}
                      />
                      <span className="add-skills-name">{skill.name}</span>
                      {reason && (
                        <span className="add-skills-reason">{reason}</span>
                      )}
                      {failed[skill.id] && (
                        <TriangleAlertIcon
                          className="add-skills-failed"
                          size={14}
                          aria-label="Couldn’t be added"
                        />
                      )}
                      <AgentLogos agents={skill.sources} />
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="add-skills-message">
              <h2>No global skills match “{query.trim()}”</h2>
              <Button
                size="sm"
                variant="secondary"
                disabled={locked}
                onClick={() => setQuery("")}
              >
                Clear search
              </Button>
            </div>
          )}
          <div className="add-skills-footer">
            {scan.errors.map((error, index) => (
              <p key={index} className="add-skills-note" role="status">
                <span className="add-skills-note-icon">
                  <TriangleAlertIcon size={14} aria-hidden="true" />
                </span>
                <span>{error}</span>
              </p>
            ))}
            {retry && (
              <p className="add-skills-note" data-tone="error" role="alert">
                <span className="add-skills-note-icon">
                  <CircleXIcon size={14} aria-hidden="true" />
                </span>
                <span>{retry}</span>
              </p>
            )}
            <Button
              size="sm"
              variant="primary"
              className="add-skills-submit"
              disabled={!chosen.length || locked}
              aria-busy={pending}
              onClick={() => void add()}
            >
              {pending ? (
                waiting ? (
                  "Waiting for sync…"
                ) : (
                  "Adding…"
                )
              ) : retry ? (
                <>
                  <Icon icon={RefreshCwIcon} size="sm" />
                  Try again
                </>
              ) : chosen.length ? (
                <>
                  <Icon icon={PlusIcon} size="sm" />
                  Add {chosen.length} {plural(chosen.length)}
                </>
              ) : (
                "Add skills"
              )}
            </Button>
          </div>
        </>
      )}
      {peeked && peek && (
        <div
          id={peekId}
          className="add-skills-peek"
          role="tooltip"
          data-side={peek.side}
          style={{
            top: Math.max(0, peek.top - 40),
            maxWidth: peek.maxWidth,
          }}
        >
          <div className="add-skills-peek-heading">
            <strong>{peeked.name}</strong>
            <AgentLogos agents={peeked.sources} />
          </div>
          {(failed[peeked.id] || peeked.error) && (
            <p className="add-skills-peek-error">
              <CircleXIcon size={12} aria-hidden="true" />
              <span>{failed[peeked.id] || peeked.error}</span>
            </p>
          )}
          {peeked.count !== undefined && (
            <p className="add-skills-peek-meta">
              <MessageSquareIcon size={12} aria-hidden="true" />
              <span>
                Detected in {peeked.count}{" "}
                {peeked.count === 1 ? "chat" : "chats"}
              </span>
            </p>
          )}
          <p>{peeked.description || "No description"}</p>
          <p className="add-skills-peek-meta">
            <FileIcon size={12} aria-hidden="true" />
            <span>
              {peeked.fileCount} {peeked.fileCount === 1 ? "file" : "files"}
            </span>
          </p>
          <p className="add-skills-peek-meta" title={peeked.path}>
            <FolderIcon size={12} aria-hidden="true" />
            <span>{middle(peeked.path)}</span>
          </p>
        </div>
      )}
    </div>
  );
}
