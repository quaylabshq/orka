import { invoke } from "@tauri-apps/api/core";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  SessionSnapshotDownload,
  SessionTranscriptOpen,
  SessionTranscriptRange,
} from "../types.js";
import { Button } from "./button.js";
import { LoadingRegion } from "./loading-region.js";
import { ReaderState } from "./skill-state.js";
import {
  restoreTranscriptBlocks,
  transcriptBlocks,
  TRANSCRIPT_READ_BYTES,
  type TranscriptBlock,
} from "./transcript-range.js";

const CACHE_BYTES = 512 * 1024;
const LOOKAHEAD_PX = 4800;
const MAX_SELECTION_BLOCKS = 16;
const NO_BLOCKS: TranscriptBlock[] = [];

interface TranscriptReaderProps {
  id: string;
  conflictId: string;
  readerRef: React.RefObject<HTMLDivElement | null>;
  busy: boolean;
  offline: boolean;
  onDownload: (snapshot: SessionSnapshotDownload | null) => void;
  onReady?: () => void;
}

export function TranscriptReader(props: TranscriptReaderProps) {
  const { id, conflictId, busy, offline, onDownload, readerRef } = props;
  useLayoutEffect(() => {
    if (readerRef.current) readerRef.current.scrollTop = 0;
  }, [readerRef]);
  const [opened, setOpened] = useState<SessionTranscriptOpen | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const retry = () => {
    setOpened(null);
    setError("");
    setAttempt((current) => current + 1);
  };
  useEffect(() => {
    let disposed = false;
    let readerId: string | undefined;
    const close = (readerId: string) =>
      void invoke("close_transcript", { readerId }).catch(() => {});
    void invoke<SessionTranscriptOpen>("open_transcript", {
      id,
      conflictId: conflictId || null,
    }).then(
      (result) => {
        readerId = result.readerId;
        if (disposed) {
          if (readerId) close(readerId);
        } else setOpened(result);
      },
      (reason: unknown) => {
        if (!disposed) setError(String(reason));
      },
    );
    return () => {
      disposed = true;
      if (readerId) close(readerId);
    };
  }, [id, conflictId, attempt]);

  const download = opened?.removed ? null : (
    <Button
      size="sm"
      variant="secondary"
      disabled={busy || (!!conflictId && !opened?.sessionSnapshot)}
      onClick={() => onDownload(opened?.sessionSnapshot ?? null)}
    >
      {conflictId ? "Download incoming version" : "Download session"}
    </Button>
  );
  if (!opened)
    return (
      <section aria-label="Transcript text" className="transcript-reader">
        <div className="transcript-actions">{download}</div>
        {error ? (
          <TranscriptError offline={offline} retry={retry} />
        ) : (
          <TranscriptLoading />
        )}
      </section>
    );
  if (opened.removed)
    return (
      <ReaderState
        illustration="preview-unavailable"
        title="Removed in this version"
        message="This version removes the session from shared history."
      />
    );
  return (
    <TranscriptText
      key={opened.readerId}
      readerId={opened.readerId}
      readerRef={props.readerRef}
      offline={offline}
      download={download}
      reopen={retry}
      onReady={props.onReady}
    />
  );
}

function TranscriptLoading() {
  return (
    <LoadingRegion id="transcript-body" label="Loading transcript…" loading>
      <pre className="content">
        {"Preparing the transcript\n\nSession records will appear here."}
      </pre>
    </LoadingRegion>
  );
}

function TranscriptError({
  offline,
  retry,
}: {
  offline: boolean;
  retry: () => void;
}) {
  return (
    <ReaderState
      tone={offline ? "status" : "alert"}
      illustration={
        offline ? "file-unavailable-offline" : "preview-unavailable"
      }
      title={
        offline
          ? "Transcript unavailable offline"
          : "Couldn’t load the transcript"
      }
      message={offline ? "Reconnect and sync to load it." : undefined}
      action={
        <Button size="sm" variant="tertiary" onClick={retry}>
          Retry
        </Button>
      }
    />
  );
}

type Read =
  | { kind: "initial" | "after" | "before" | "start"; offset: number }
  | { kind: "end"; offset: null }
  | { kind: "restore"; offset: number; blocks: TranscriptBlock[] };

interface TranscriptIndex {
  blocks: TranscriptBlock[];
  start: number;
  end: number;
  eof: boolean;
}

interface Anchor {
  offset: number;
  within: number;
}

function TranscriptText({
  readerId,
  readerRef,
  offline,
  download,
  reopen,
  onReady,
}: {
  readerId: string;
  readerRef: React.RefObject<HTMLDivElement | null>;
  offline: boolean;
  download: React.ReactNode;
  reopen: () => void;
  onReady?: () => void;
}) {
  const region = useRef<HTMLElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const cache = useRef(new Map<number, { text: string; bytes: number }>());
  const cachedBytes = useRef(0);
  const active = useRef<Read | null>(null);
  const queuedJump = useRef<Read | null>(null);
  const generation = useRef(0);
  const anchor = useRef<Anchor | null>(null);
  const bounds = useRef<{ start: number; end: number } | null>(null);
  const position = useRef<"start" | "end" | null>(null);
  const [index, setIndex] = useState<TranscriptIndex | null>(null);
  const [pending, setPending] = useState<Read | null>(null);
  const [failed, setFailed] = useState<"retry" | "invalidated" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [visible, setVisible] = useState(() => !document.hidden);
  const [geometry, setGeometry] = useState({ margin: 0, width: 680 });
  const [version, redraw] = useState(0);
  const blocks = index?.blocks ?? NO_BLOCKS;
  const ready = index !== null;
  const transcriptTop = geometry.margin - (toolbar.current?.offsetHeight ?? 0);
  const readingText = (readerRef.current?.scrollTop ?? 0) >= transcriptTop;
  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => readerRef.current,
    getItemKey: (i) => blocks[i].offset,
    estimateSize: (i) => {
      const { characters, lineCount } = blocks[i];
      return (
        24 *
        Math.max(
          lineCount,
          Math.ceil(characters / Math.max(1, geometry.width / 8)),
        )
      );
    },
    scrollMargin: geometry.margin,
    // The shared column also contains the title and conflict controls above the
    // reader. Preserve a transcript anchor only while the user is reading it.
    anchorTo: readingText ? "end" : "start",
    followOnAppend: false,
    scrollEndThreshold: 1,
    overscan: 2,
    useAnimationFrameWithResizeObserver: true,
    rangeExtractor: (range) =>
      [
        ...new Set([
          ...defaultRangeExtractor(range),
          ...selected
            .map((offset) =>
              blocks.findIndex((block) => block.offset === offset),
            )
            .filter((i) => i >= 0),
        ]),
      ].sort((a, b) => a - b),
  });
  const items = virtualizer.getVirtualItems();
  const startIndex = virtualizer.range?.startIndex ?? 0;
  const endIndex = virtualizer.range?.endIndex ?? 0;
  const first = Math.max(0, startIndex - 2);
  const last = Math.min(blocks.length - 1, endIndex + 2);

  const apply = (request: Read, range: SessionTranscriptRange) => {
    const incoming =
      request.kind === "restore"
        ? restoreTranscriptBlocks(range, request.blocks)
        : transcriptBlocks(range);
    if (request.kind === "end" || request.kind === "start") {
      cache.current.clear();
      cachedBytes.current = 0;
      position.current = request.kind;
      setSelected([]);
    }
    for (const { block, text } of incoming) {
      if (!cache.current.has(block.offset))
        cachedBytes.current += block.end - block.offset;
      cache.current.delete(block.offset);
      cache.current.set(block.offset, {
        text,
        bytes: block.end - block.offset,
      });
    }
    if (request.kind === "restore") {
      redraw((value) => value + 1);
      return;
    }
    const currentBounds = bounds.current;
    bounds.current =
      request.kind === "before" && currentBounds
        ? { ...currentBounds, start: range.offset }
        : request.kind === "after" && currentBounds
          ? { ...currentBounds, end: range.nextOffset }
          : { start: range.offset, end: range.nextOffset };
    const nextBlocks = incoming.map(({ block }) => block);
    setIndex((current) => {
      if (
        !current ||
        request.kind === "initial" ||
        request.kind === "start" ||
        request.kind === "end"
      )
        return {
          blocks: nextBlocks,
          start: range.offset,
          end: range.nextOffset,
          eof: range.eof,
        };
      if (request.kind === "before")
        return {
          ...current,
          blocks: [...nextBlocks, ...current.blocks],
          start: range.offset,
        };
      return {
        ...current,
        blocks: [...current.blocks, ...nextBlocks],
        end: range.nextOffset,
        eof: range.eof,
      };
    });
  };

  const read = (request: Read) => {
    if (
      (request.kind === "before" && bounds.current?.start !== request.offset) ||
      (request.kind === "after" && bounds.current?.end !== request.offset)
    )
      return;
    const ticket = generation.current;
    active.current = request;
    setPending(request);
    setFailed(null);
    if (request.kind === "end" || request.kind === "start")
      setAnnouncement(
        request.kind === "end"
          ? "Preparing the end of the transcript…"
          : "Preparing the start of the transcript…",
      );
    const restored = request.kind === "restore" ? request.blocks.at(-1) : null;
    void invoke<SessionTranscriptRange>("read_transcript", {
      readerId,
      offset: request.offset,
      maxBytes: restored
        ? Math.max(4, restored.end - (request.offset ?? 0))
        : TRANSCRIPT_READ_BYTES,
      before: request.kind === "before",
    })
      .then((range) => {
        if (ticket !== generation.current) return;
        if (queuedJump.current) return;
        if (
          range.offset < 0 ||
          range.nextOffset < range.offset ||
          (request.kind === "before" &&
            (range.nextOffset !== request.offset ||
              range.offset >= request.offset)) ||
          (request.kind === "after" &&
            range.nextOffset === request.offset &&
            !range.eof) ||
          (request.kind !== "end" &&
            request.kind !== "before" &&
            range.offset !== request.offset) ||
          (restored && range.nextOffset < restored.end)
        )
          throw new Error("Transcript range changed.");
        apply(request, range);
      })
      .catch((reason: unknown) => {
        if (ticket !== generation.current) return;
        const invalidated = reason === "transcript_snapshot_invalidated";
        if (queuedJump.current && !invalidated) return;
        if (invalidated) {
          queuedJump.current = null;
          cache.current.clear();
          cachedBytes.current = 0;
          setIndex(null);
          setSelected([]);
        }
        setFailed(invalidated ? "invalidated" : "retry");
        setAnnouncement("");
      })
      .finally(() => {
        if (ticket !== generation.current) return;
        active.current = null;
        setPending(null);
        const next = queuedJump.current;
        queuedJump.current = null;
        if (next) read(next);
      });
  };

  // Closing the native reader cancels preparation. Disregard any late IPC reply.
  useEffect(
    () => () => {
      generation.current++;
      active.current = null;
      queuedJump.current = null;
    },
    [],
  );

  useEffect(() => {
    if (ready) onReady?.();
  }, [ready, onReady]);

  useEffect(() => {
    const syncVisibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", syncVisibility);
    return () =>
      document.removeEventListener("visibilitychange", syncVisibility);
  }, []);

  useEffect(() => {
    const scroller = readerRef.current;
    const element = list.current;
    if (!scroller || !element) return;
    let width = 0;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const margin = Math.round(
        rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop,
      );
      const nextWidth = Math.round(rect.width);
      if (width && width !== nextWidth) {
        const top = scroller.scrollTop;
        const visible = virtualizer.getVirtualItemForOffset(top);
        if (visible && top >= margin - (toolbar.current?.offsetHeight ?? 0))
          anchor.current = {
            offset: Number(visible.key),
            within: top - visible.start,
          };
        virtualizer.measure();
      }
      width = nextWidth;
      setGeometry((old) =>
        old.width === width && old.margin === margin ? old : { width, margin },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(scroller);
    for (const child of Array.from(scroller.children))
      if (!child.contains(element)) observer.observe(child);
    return () => observer.disconnect();
  }, [readerRef, virtualizer]);

  useLayoutEffect(() => {
    if (position.current && blocks.length) {
      const end = position.current === "end";
      position.current = null;
      region.current?.focus({ preventScroll: true });
      virtualizer.scrollToIndex(end ? blocks.length - 1 : 0, {
        align: end ? "end" : "start",
      });
      setAnnouncement(end ? "End of transcript" : "Start of transcript");
    } else if (anchor.current) {
      const saved = anchor.current;
      anchor.current = null;
      const i = blocks.findIndex(({ offset }) => offset === saved.offset);
      if (i < 0) return;
      const at = virtualizer.getOffsetForIndex(i, "start");
      if (at) virtualizer.scrollToOffset(at[0] + saved.within);
    }
  }, [blocks, geometry, virtualizer]);

  useEffect(() => {
    const onSelectionChange = () => {
      const cursor = window.getSelection();
      const elementAt = (node: Node | null) =>
        node instanceof Element ? node : node?.parentElement;
      const start = elementAt(cursor?.anchorNode ?? null)?.closest<HTMLElement>(
        ".transcript-block",
      );
      const end = elementAt(cursor?.focusNode ?? null)?.closest<HTMLElement>(
        ".transcript-block",
      );
      if (
        !cursor ||
        cursor.isCollapsed ||
        !start ||
        !end ||
        !list.current?.contains(start) ||
        !list.current.contains(end)
      ) {
        setSelected((old) => (old.length ? [] : old));
        return;
      }
      const a = Number(start.dataset.index);
      const b = Number(end.dataset.index);
      const next = Array.from(
        list.current?.querySelectorAll<HTMLElement>(
          ".transcript-block[data-offset]",
        ) ?? [],
      )
        .filter(
          (el) =>
            Number(el.dataset.index) >= Math.min(a, b) &&
            Number(el.dataset.index) <= Math.max(a, b),
        )
        .map((el) => Number(el.dataset.offset))
        .slice(0, MAX_SELECTION_BLOCKS);
      setSelected((old) =>
        old.length === next.length &&
        old.every((offset, i) => offset === next[i])
          ? old
          : next,
      );
    };
    const onCopy = (event: ClipboardEvent) => {
      const selection = window.getSelection();
      const content = list.current;
      if (!content || !selection?.rangeCount || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      if (!range.intersectsNode(content)) return;

      const endpointIndex = (node: Node) => {
        const block =
          elementAt(node)?.closest<HTMLElement>(".transcript-block");
        return block && content.contains(block)
          ? Number(block.dataset.index)
          : NaN;
      };
      const from = endpointIndex(range.startContainer);
      const to = endpointIndex(range.endContainer);
      const rendered = Array.from(
        content.querySelectorAll(".transcript-block > pre"),
      );
      if (!rendered.some((pre) => range.intersectsNode(pre))) return;
      const resident = new Set(
        rendered.map((pre) => Number(pre.parentElement?.dataset.index)),
      );
      event.preventDefault();
      if (
        !Number.isInteger(from) ||
        !Number.isInteger(to) ||
        to < from ||
        to - from >= MAX_SELECTION_BLOCKS ||
        Array.from({ length: to - from + 1 }, (_, i) => from + i).some(
          (i) => !resident.has(i),
        )
      ) {
        setAnnouncement("Select a shorter range or download the session.");
        return;
      }

      // DOM Range concatenates text nodes without adding block separators.
      event.clipboardData?.setData("text/plain", range.toString());
      setAnnouncement("");
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("copy", onCopy);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("copy", onCopy);
    };
  }, []);

  useEffect(() => {
    if (!index) return;
    const keep = new Set([
      ...blocks.slice(first, last + 1).map(({ offset }) => offset),
      ...selected,
    ]);
    // Revisit stale positions without evicting the text currently being read.
    for (const offset of keep) {
      const entry = cache.current.get(offset);
      if (!entry) continue;
      cache.current.delete(offset);
      cache.current.set(offset, entry);
    }
    for (const [offset, entry] of cache.current) {
      if (cachedBytes.current <= CACHE_BYTES) break;
      if (keep.has(offset)) continue;
      cache.current.delete(offset);
      cachedBytes.current -= entry.bytes;
    }
  }, [blocks, first, index, last, selected, version]);

  useEffect(() => {
    if (active.current || failed || (!visible && ready)) return;
    if (!index) {
      read({ kind: "initial", offset: 0 });
      return;
    }
    // Load visible gaps first, then reuse the same batch path for overscan.
    let missing = -1;
    for (let i = first; i <= last; i++) {
      if (cache.current.has(blocks[i].offset)) continue;
      if (missing < 0) missing = i;
      if (i >= startIndex && i <= endIndex) {
        missing = i;
        break;
      }
    }
    if (missing >= 0) {
      const offset = blocks[missing].offset;
      const restore: TranscriptBlock[] = [];
      for (let i = missing; i <= last; i++) {
        const block = blocks[i];
        if (
          cache.current.has(block.offset) ||
          block.end - offset > TRANSCRIPT_READ_BYTES
        )
          break;
        restore.push(block);
      }
      read({ kind: "restore", offset, blocks: restore });
      return;
    }
    const scroller = readerRef.current;
    const top = (virtualizer.scrollOffset ?? 0) - geometry.margin;
    const bottom = top + (scroller?.clientHeight ?? 0);
    const extent = virtualizer.getTotalSize();
    if (
      readingText &&
      index.start > 0 &&
      top < LOOKAHEAD_PX &&
      virtualizer.scrollDirection === "backward"
    ) {
      read({ kind: "before", offset: index.start });
    } else if (
      !index.eof &&
      (extent - bottom < LOOKAHEAD_PX || endIndex >= blocks.length - 3)
    ) {
      read({ kind: "after", offset: index.end });
    }
  });

  const jump = (kind: "end" | "start") => {
    if (
      failed !== null ||
      (index && !blocks.length) ||
      pending?.kind === kind ||
      queuedJump.current?.kind === kind
    )
      return;
    if (
      kind === "end" &&
      index?.eof &&
      blocks.length &&
      cache.current.has(blocks.at(-1)!.offset)
    ) {
      region.current?.focus({ preventScroll: true });
      virtualizer.scrollToIndex(blocks.length - 1, { align: "end" });
      setAnnouncement("End of transcript");
      return;
    }
    if (
      kind === "start" &&
      index?.start === 0 &&
      blocks.length &&
      cache.current.has(blocks[0].offset)
    ) {
      region.current?.focus({ preventScroll: true });
      readerRef.current?.scrollTo({ top: 0 });
      setAnnouncement("Start of transcript");
      return;
    }
    const request: Read =
      kind === "end" ? { kind, offset: null } : { kind, offset: 0 };
    if (active.current) {
      queuedJump.current = request;
      setPending(request);
      setAnnouncement(
        kind === "end"
          ? "Preparing the end of the transcript…"
          : "Preparing the start of the transcript…",
      );
    } else read(request);
  };

  // Native closes the reader on a read error. Retry requires a fresh snapshot.
  return (
    <section
      ref={region}
      className="transcript-reader"
      aria-label="Transcript text"
      tabIndex={0}
      onKeyDown={(event) => {
        if (
          event.shiftKey ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.target !== event.currentTarget
        )
          return;
        if (event.key === "End" || event.key === "Home") {
          event.preventDefault();
          jump(event.key === "End" ? "end" : "start");
        }
      }}
    >
      <div ref={toolbar} className="transcript-actions">
        {failed !== "invalidated" && download}
        <Button
          size="sm"
          variant="tertiary"
          onClick={() => jump("start")}
          disabled={
            !!failed || pending?.kind === "start" || (!!index && !blocks.length)
          }
        >
          Jump to start
        </Button>
        <Button
          size="sm"
          variant="tertiary"
          onClick={() => jump("end")}
          disabled={
            !!failed || pending?.kind === "end" || (!!index && !blocks.length)
          }
        >
          Jump to end
        </Button>
        <span
          className={
            announcement.startsWith("Preparing") ||
            announcement.startsWith("Select")
              ? "transcript-jump-status"
              : "sr-only"
          }
          role="status"
        >
          {announcement}
        </span>
      </div>
      {!index &&
        (failed ? (
          <TranscriptError offline={offline} retry={reopen} />
        ) : (
          <TranscriptLoading />
        ))}
      {index && failed && (
        <div className="transcript-range-error" role="alert">
          <p className="content-message">
            Couldn’t load more of the transcript.
          </p>
          <Button size="sm" variant="tertiary" onClick={reopen}>
            Retry
          </Button>
        </div>
      )}
      {index && !blocks.length && (
        <p className="content-message">This transcript is empty.</p>
      )}
      <div
        ref={list}
        className="transcript-blocks"
        aria-busy={!ready && !failed}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {items.map((item) => {
          const block = blocks[item.index];
          if (!block) return null;
          const text = cache.current.get(block.offset)?.text;
          return (
            <div
              className="transcript-block"
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              data-offset={block.offset}
              style={{
                transform: `translateY(${item.start - geometry.margin}px)`,
              }}
            >
              {text === undefined ? (
                <div
                  className="transcript-block-placeholder"
                  aria-hidden="true"
                  style={{ height: item.size }}
                />
              ) : (
                <pre className="content">{text}</pre>
              )}
            </div>
          );
        })}
      </div>
      {index &&
        pending &&
        pending.kind !== "end" &&
        pending.kind !== "start" && (
          <span className="sr-only">Loading more of the transcript…</span>
        )}
    </section>
  );
}
