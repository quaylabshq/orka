import React, { type MouseEvent } from "react";
import { FileIcon, GitCompareIcon, PencilIcon } from "lucide-react";
import type { Inspection, ProjectResource as Resource } from "../types.js";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { SegmentedControl } from "./segmented-control.js";
import { LoadingRegion } from "./loading-region.js";
import { FormattedFileMarkdown } from "./resource-content.js";
import { readSkillMarkdown } from "./skill-markdown.js";
import { FileDiffCard, SourceCard, fileKind } from "./file-diff.js";
import { ReaderState } from "./skill-state.js";
import type { ResourceView } from "./use-resource-view.js";

const sampleInspection: Inspection = {
  content:
    "# Review checklist\n\nKeep the project context available across your tools.\n\n## Working notes\n\nReview the current approach and the decisions behind it.\n\n- Inspect the existing behavior\n- Keep useful context together\n- Verify the result",
  previous: null,
  paths: [],
};

/** “Oct 4 at 3:30 PM”, for the info card. */
export const factDate = (iso: string) => {
  const date = new Date(iso);
  return `${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })} at ${date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })}`;
};
/** “Oct 4, 3:30 PM”, for the compact meta line. */
export const metaDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** What the reader knows about the selected file before its content loads. */
export function fileState(
  resource: Resource,
  view: ResourceView,
  paths: string[],
) {
  const listed = resource.files.some((file) => file.path === view.file);
  return {
    listed,
    missing: !listed || /file not found/i.test(view.inspectionError),
    pending: !view.inspection && !view.inspectionError,
    kind: fileKind(view.file),
    others: paths.some((path) => path !== view.file),
  };
}

interface FileDocumentProps {
  inspection: Inspection;
  file: string;
  changes: boolean;
  rawMarkdown: boolean;
  comparisonFallback?: React.ReactNode;
}

/**
 * One file's content, comparison, or reader state. It is a component rather
 * than an inline render so the loading region's skeleton pass, which clones
 * element children through React.Children.map, never reaches Markdown's
 * string child.
 */
function FileDocument({
  inspection,
  file,
  changes,
  rawMarkdown,
  comparisonFallback,
}: FileDocumentProps) {
  const kind = fileKind(file);
  const skillFile = file === "SKILL.md";
  if (kind.label === "PDF") return <SourceCard path={file} content={null} />;
  if (changes) {
    if (inspection.previous === null)
      return (
        <ReaderState
          illustration="previous-version-unavailable"
          title="Previous version unavailable"
          message="The previous version isn’t cached on this Mac."
        />
      );
    if (inspection.content === null)
      return (
        <ReaderState
          illustration="preview-unavailable"
          title="Preview unavailable"
          message="Binary files can’t be compared. Use Open in editor to view this file."
        />
      );
    if (inspection.previous === inspection.content)
      return (
        <ReaderState
          className="reader-state--large"
          illustration="no-changes"
          title="No changes"
          message="This file matches its cached version."
        />
      );
    return (
      <div className="detail-comparison">
        <span className="detail-comparison-timeline" aria-hidden="true">
          <span />
        </span>
        <FileDiffCard
          path={file}
          before={inspection.previous}
          after={inspection.content}
          fallback={comparisonFallback}
        />
      </div>
    );
  }
  if (inspection.content === null || kind.language !== "markdown")
    return <SourceCard path={file} content={inspection.content} />;
  const document = skillFile ? readSkillMarkdown(inspection.content) : null;
  if (document?.invalid || rawMarkdown)
    return (
      <SourceCard
        path={file}
        content={inspection.content}
        variant={document?.invalid ? "plain" : "file"}
      />
    );
  const body = document ? document.body : inspection.content;
  if (!body.trim())
    return (
      <ReaderState
        illustration="empty-markdown-body"
        title={skillFile ? "No skill instructions" : "Empty file"}
        message={
          skillFile
            ? "Only skill metadata is present."
            : "This file has no content yet."
        }
      />
    );
  return <FormattedFileMarkdown content={body} showProperties={!skillFile} />;
}

/** The selected file with its loading, missing, offline, and failed states. */
export function DetailDocument({
  id,
  view,
  state,
  offline,
  othersMessage,
  skeleton,
  comparisonFallback,
}: {
  id: string;
  view: ResourceView;
  state: ReturnType<typeof fileState>;
  offline: boolean;
  /** Shown when the file is missing but other files can still be opened. */
  othersMessage: string;
  skeleton?: React.ReactNode;
  /** Retains a reader's text comparison on older supported WebViews. */
  comparisonFallback?: React.ReactNode;
}) {
  const retry = (
    <Button size="sm" variant="tertiary" onClick={view.retryInspection}>
      Retry
    </Button>
  );
  const error = state.missing ? (
    <ReaderState
      illustration="skill-md-missing"
      title={`${view.file} is missing`}
      message={state.others ? othersMessage : undefined}
      action={retry}
    />
  ) : offline ? (
    <ReaderState
      illustration="file-unavailable-offline"
      title="File unavailable offline"
      message="Reconnect and sync to load this file."
      action={retry}
    />
  ) : (
    <ReaderState
      tone="alert"
      illustration="preview-unavailable"
      title={`Couldn’t load ${view.file}`}
      action={retry}
    />
  );
  return (
    <LoadingRegion
      id={id}
      label="Loading content…"
      data={view.inspection}
      sample={sampleInspection}
      skeleton={skeleton}
      error={view.inspectionError || !state.listed ? error : undefined}
    >
      {(inspection) => (
        <FileDocument
          inspection={inspection}
          file={view.file}
          changes={view.changes}
          rawMarkdown={view.rawMarkdown}
          comparisonFallback={comparisonFallback}
        />
      )}
    </LoadingRegion>
  );
}

/** Formatted or Markdown, for Markdown files. */
export function MarkdownModeControl({
  view,
  state,
  forced = false,
}: {
  view: ResourceView;
  state: ReturnType<typeof fileState>;
  /** Unreadable metadata locks the reader to the original file. */
  forced?: boolean;
}) {
  return (
    <SegmentedControl
      label="Markdown view"
      value={view.rawMarkdown || forced ? "markdown" : "formatted"}
      options={[
        { value: "formatted", label: "Formatted" },
        { value: "markdown", label: "Markdown" },
      ]}
      disabled={
        forced || state.pending || !state.listed || !!view.inspectionError
      }
      onChange={(mode) => {
        view.setRawMarkdown(mode === "markdown");
        view.setChanges(false);
      }}
    />
  );
}

/** Open in editor, plus View changes for anything that has been shared. */
export function EditorActions({
  resource,
  view,
  state,
  busy,
  offline,
  connected,
  onOpen,
  editorRef,
}: {
  resource: Resource;
  view: ResourceView;
  state: ReturnType<typeof fileState>;
  busy: boolean;
  offline: boolean;
  /** Whether the project folder is connected on this Mac. */
  connected: boolean;
  onOpen: (file: string) => void;
  editorRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <>
      <Button
        ref={editorRef}
        variant="primary"
        size="sm"
        disabled={
          busy ||
          !connected ||
          state.missing ||
          (offline && !!view.inspectionError)
        }
        onClick={() => onOpen(view.file)}
      >
        <Icon icon={PencilIcon} /> Open in editor
      </Button>
      {!resource.local && (
        <Button
          size="sm"
          variant="tertiary"
          className="detail-compare"
          disabled={
            busy ||
            state.pending ||
            !state.listed ||
            !!view.inspectionError ||
            state.kind.label === "PDF" ||
            view.inspection?.content === null
          }
          aria-pressed={view.changes}
          onClick={() => view.setChanges((value) => !value)}
        >
          <Icon icon={view.changes ? FileIcon : GitCompareIcon} />
          {view.changes ? "Show content" : "View changes"}
        </Button>
      )}
    </>
  );
}

/** The file switcher rows shared by the rail card and the compact popover. */
export function FileRows({
  paths,
  view,
  missing,
}: {
  paths: string[];
  view: ResourceView;
  missing: (path: string) => boolean;
}) {
  const select = (event: MouseEvent, path: string) => {
    event.preventDefault();
    if (fileKind(path).label === "PDF") view.setChanges(false);
    view.setFile(path);
  };
  return paths.map((path) => {
    const selected = path === view.file;
    return (
      <li key={path}>
        <button
          type="button"
          className="detail-file"
          aria-current={selected ? "true" : undefined}
          title={path}
          onClick={(event) => select(event, path)}
        >
          <Icon
            icon={fileKind(path).listIcon}
            size="sm"
            variant={selected ? "primary" : "tertiary"}
          />
          <span className="detail-file-name">
            {path}
            {missing(path) ? " · Missing" : ""}
          </span>
        </button>
      </li>
    );
  });
}
