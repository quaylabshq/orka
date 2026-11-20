import {
  CheckIcon,
  ChevronDownIcon,
  CircleXIcon,
  FileIcon,
  FolderIcon,
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
  useMemo,
  useRef,
  useState,
} from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../types.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { activeSources, repositoryLabel } from "./project-sources.js";
import { readSkillMarkdown } from "./skill-markdown.js";
import { useToasts } from "./toasts.js";
import { connectProject } from "./use-project-setup.js";
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
          aria-label={compact ? undefined : "Add global skills"}
          title="Add global skills"
          aria-haspopup="dialog"
        >
          {compact ? (
            "Add skills"
          ) : (
            <>
              <Icon icon={PlusIcon} />
              Add Global Skills
            </>
          )}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="add-skills-popover"
          role="dialog"
          aria-label="Add global skills"
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
  const repositories = useMemo(
    () => activeSources(project.sources ?? []).filter((source) => source.path),
    [project.sources],
  );
  const [picked, setPicked] = useState("");
  // Falls back to the first connected repository, including one connected
  // while the popover is open.
  const sourceId = repositories.some((source) => source.id === picked)
    ? picked
    : (repositories[0]?.id ?? "");
  const peekId = useId();
  const [connectError, setConnectError] = useState("");
  const connected = project.sources
    ? repositories.some((source) => source.id === sourceId)
    : Boolean(project.path);
  const destination =
    (project.sources && repositoryLabel(project.sources, sourceId)) ||
    project.name;
  const [scan, setScan] = useState<Scan | null>(null);
  const [scanError, setScanError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  /** Why the last attempt failed, when trying again can fix it. */
  const [retry, setRetry] = useState("");
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [peek, setPeek] = useState<{ id: string; top: number }>();
  const active = useRef(true);
  const generation = useRef(0);
  const peekTimer = useRef(0);
  const list = useRef<HTMLUListElement>(null);

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
    if (connected) void rescan();
    return () => {
      active.current = false;
      generation.current += 1;
      window.clearTimeout(peekTimer.current);
    };
  }, [rescan, connected]);

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
          };
        })
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
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
  ) => {
    if (added.length) {
      const subject =
        added.length === 1 ? name(added[0].skillId) : `${added.length} skills`;
      const statuses = added.map((item) => item.result?.status);
      if (statuses.includes("draft"))
        notify({
          kind: "success",
          title: `${subject} added on this Mac. Review ${added.length === 1 ? "it" : "them"} to share.`,
          action: { label: "Review", onClick: onReview },
        });
      else if (statuses.every((status) => status === "local"))
        notify({
          kind: "success",
          title: `${subject} added on this Mac. Sharing is off for skills.`,
        });
      else
        notify({
          kind: "success",
          title: `${subject} added to ${destination}`,
        });
    }
    // A failure that trying again cannot fix is explained once and let go.
    if (dead.length)
      notify({
        kind: "error",
        title:
          dead.length === 1
            ? `${name(dead[0].skillId)} wasn’t added. ${dead[0].error}`
            : `${dead.length} skills weren’t added. ${dead[0].error}`,
      });
  };
  const scanNow = () =>
    invoke<Scan>("scan_global_skills", {
      projectId: project.id,
      sourceId: sourceId || undefined,
    });
  const add = async () => {
    if (pending || !chosen.length) return;
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
    let retryable = 0;
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
        let stale = results.filter((item) => item.error === STALE_SKILL);
        let dead = results.filter(
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
          // A stale skill that is gone from the fresh list cannot be retried.
          const present = new Set(next.skills.map((skill) => skill.id));
          const gone = stale.filter((item) => !present.has(item.skillId));
          stale = stale.filter((item) => present.has(item.skillId));
          dead = [
            ...dead,
            ...gone.map((item) => ({
              ...item,
              error: "It is no longer in your global skills.",
            })),
          ];
        }
        retryable = stale.length;
        report(added, dead, name);
        if (!active.current) return;
        if (next && current === generation.current) setScan(next);
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
        if (!stale.length && !dead.length) onClose();
      });
    } catch (error) {
      if (active.current && !answered)
        setRetry(
          `Couldn’t add ${attempted.length} ${plural(attempted.length)}.\n${String(error)}`,
        );
    } finally {
      window.clearTimeout(timer);
      // Adding a project's first skill moves the button into the toolbar and
      // replaces this popover, so a skill left to retry is reported here.
      if (!active.current && retryable)
        notify({
          kind: "error",
          title: `${retryable} ${plural(retryable)} couldn’t be added. Open Add skills to try again.`,
        });
      if (active.current) {
        setPending(false);
        setWaiting(false);
      }
      onAdding(false);
    }
  };

  const openPeek = (id: string, row: HTMLElement, delay: number) => {
    window.clearTimeout(peekTimer.current);
    const popover = row.closest<HTMLElement>(".add-skills-popover");
    if (!popover) return;
    const top =
      row.getBoundingClientRect().top - popover.getBoundingClientRect().top;
    peekTimer.current = window.setTimeout(() => setPeek({ id, top }), delay);
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

  if (!connected)
    return (
      <div className="add-skills-message">
        <Icon icon={FolderIcon} size="lg" variant="secondary" />
        <h2>Connect a folder first</h2>
        <p>
          Skills are added to a project folder on this Mac, and this project
          does not have one yet.
        </p>
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
          type="search"
          aria-label="Search global skills"
          placeholder="Search your global skills…"
          value={query}
          autoFocus
          disabled={locked}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button
            type="button"
            className="add-skills-clear"
            aria-label="Clear search"
            onClick={() => setQuery("")}
          >
            <XIcon size={12} aria-hidden="true" />
          </button>
        )}
      </label>
      {repositories.length > 1 && (
        <div className="add-skills-repository">
          <FolderIcon size={16} aria-hidden="true" />
          <span>Add to repository</span>
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="add-skills-repository-select"
                aria-label="Add to repository"
                title={destination}
                disabled={locked}
              >
                <span>{destination}</span>
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
                  value={sourceId}
                  onValueChange={(next) => {
                    // What can be added depends on the repository.
                    setPicked(next);
                    setSelected(new Set());
                    setFailed({});
                    setRetry("");
                  }}
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
      {scanError ? (
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
            {skills.length
              ? "Every global skill on this Mac is already in this project."
              : scan.errors.length
                ? "No global skills could be read on this Mac."
                : "No global skills were found in Codex or Claude on this Mac."}
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
          style={{ top: Math.max(0, peek.top - 40) }}
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
