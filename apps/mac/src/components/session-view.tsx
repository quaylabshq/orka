import { UserIcon } from "lucide-react";
import React, {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import { SourceLabel, sourceName } from "./source-label.js";
import { markdownComponents } from "./resource-content.js";
import { useSessionMessages } from "./use-session-messages.js";
import type { ResourceSource, SessionMessage } from "../types.js";
import { DetailLayout, type DetailLayoutProps } from "./detail-layout.js";
import { LoadingRegion } from "./loading-region.js";
import { ReaderState } from "./skill-state.js";

const sampleMessages: SessionMessage[] = [
  {
    index: 0,
    role: "user",
    text: "Review the current project and suggest the next steps.",
  },
  {
    index: 1,
    role: "assistant",
    text: "I’ll check the existing approach and the decisions behind it.\n\nThen I’ll work through the relevant changes and verify the result.",
  },
  {
    index: 2,
    role: "user",
    text: "Keep the existing behavior and project context in mind.",
  },
];

export type SessionViewMode = "conversation" | "transcript";

/** One turn with its speaker column. Memoized so paging never re-parses earlier turns. */
const SessionTurn = memo(function SessionTurn({
  message,
  raw,
  source,
}: {
  message: SessionMessage;
  raw: boolean;
  source: ResourceSource;
}) {
  const user = message.role === "user";
  const speaker = user ? "You" : sourceName(source);
  return (
    <article
      className={
        user
          ? "session-turn session-turn--user"
          : "session-turn session-turn--assistant"
      }
      aria-label={speaker}
    >
      <div className="session-turn-speaker">
        {user ? (
          <>
            <Icon icon={UserIcon} size="sm" variant="primary" />
            <span>You</span>
          </>
        ) : (
          <SourceLabel source={source} />
        )}
      </div>
      <div className="session-turn-body">
        {raw ? (
          <pre className="content">{message.text}</pre>
        ) : (
          <div className="markdown-content">
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {message.text}
            </Markdown>
          </div>
        )}
      </div>
    </article>
  );
});

export interface SessionViewProps {
  id: string;
  contentKey: string;
  /** Native sessions may grow before discovery updates their catalog hashes. */
  refreshOnMount?: boolean;
  /** Conflict preview to read instead of the shared version. */
  conflictId: string;
  source: ResourceSource;
  /** The shared detail shell around the turns. */
  shell: Omit<DetailLayoutProps, "children" | "readerRef" | "bodyClassName">;
  mode: SessionViewMode;
  /** Show turns as literal text instead of rendered Markdown. */
  raw: boolean;
  /** The unchanged original transcript; loaded only in transcript mode. */
  transcript: React.ReactNode;
  offline: boolean;
}

/** The reading view for one session with paged, windowed turns. */
export function SessionView({
  id,
  contentKey,
  refreshOnMount,
  conflictId,
  source,
  shell,
  mode,
  raw,
  transcript,
  offline,
}: SessionViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const session = useSessionMessages(
    id,
    conflictId,
    contentKey,
    refreshOnMount,
  );
  const { messages, total, loading, error, removed, hasMore, loadMore, retry } =
    session;
  const initialLoading = session.pending && !error;
  const conversation = mode === "conversation";
  // The title card scrolls with the turns, so the virtualizer needs the list's
  // offset inside the reading column, refreshed whenever anything above resizes.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const list = listRef.current;
    if (!scroller || !list) return;
    const measure = () =>
      setScrollMargin(
        list.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop,
      );
    measure();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(scroller);
    for (const child of Array.from(scroller.children))
      if (!child.contains(list)) observer.observe(child);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [conversation, initialLoading]);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 160,
    overscan: 6,
    scrollMargin,
    useAnimationFrameWithResizeObserver: true,
    getItemKey: (index) => messages[index].index,
  });
  const items = virtualizer.getVirtualItems();
  const lastVisible = items.at(-1)?.index ?? -1;
  useEffect(() => {
    if (hasMore && !loading && !error && lastVisible >= messages.length - 5)
      loadMore();
  }, [hasMore, loading, error, lastVisible, messages.length, loadMore]);
  const retryButton = (
    <Button size="sm" variant="tertiary" onClick={retry}>
      Retry
    </Button>
  );
  return (
    <DetailLayout {...shell} readerRef={scrollRef} bodyClassName="session-body">
      {!conversation ? (
        transcript
      ) : (
        <div
          className="session-conversation"
          aria-label="Conversation"
          aria-busy={loading}
        >
          {removed && (
            <ReaderState
              illustration="preview-unavailable"
              title="Removed in this version"
              message="This version removes the session from shared history."
            />
          )}
          {error && messages.length === 0 && (
            <ReaderState
              tone={offline ? "status" : "alert"}
              illustration={
                offline ? "file-unavailable-offline" : "preview-unavailable"
              }
              title={
                offline
                  ? "Conversation unavailable offline"
                  : "Couldn’t load this conversation"
              }
              message={offline ? "Reconnect and sync to load it." : undefined}
              action={retryButton}
            />
          )}
          {error && messages.length > 0 && (
            <p className="content-message" role="alert">
              {error} {retryButton}
            </p>
          )}
          {!error && !removed && total === 0 && (
            <ReaderState
              illustration="empty-markdown-body"
              title="No conversation messages"
              message="View the transcript for setup and tool records."
            />
          )}
          <LoadingRegion
            id={`session:${id}:${conflictId}`}
            label="Loading messages…"
            loading={initialLoading}
          >
            {initialLoading ? (
              <div>
                {sampleMessages.map((message) => (
                  <SessionTurn
                    key={message.index}
                    message={message}
                    raw={raw}
                    source={source}
                  />
                ))}
              </div>
            ) : (
              <div
                ref={listRef}
                className="session-turns"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {items.map((item) => (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    className="session-turn-slot"
                    style={{
                      transform: `translateY(${item.start - scrollMargin}px)`,
                    }}
                  >
                    <SessionTurn
                      message={messages[item.index]}
                      raw={raw}
                      source={source}
                    />
                  </div>
                ))}
              </div>
            )}
          </LoadingRegion>
          {!error && hasMore && (
            <div className="session-load-more">
              {loading ? (
                <span role="status">Loading messages…</span>
              ) : (
                <Button size="sm" variant="secondary" onClick={loadMore}>
                  Show more messages
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </DetailLayout>
  );
}
