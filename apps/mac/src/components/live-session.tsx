import { invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RadioIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ResourceSource, SessionMessage } from "../types.js";
import { Button } from "./button.js";
import { SessionTurn } from "./session-view.js";

interface Status {
  available: boolean;
  eligible: boolean;
  active: boolean;
  publishing: boolean;
  following: boolean;
  agentFollowing: boolean;
  episodeId?: string;
  reason?: string;
}

interface Target {
  provider: "codex" | "claude";
  nativeId: string;
  title: string;
  following: boolean;
  otherFollow?: { id: string; episodeId: string };
}

type Unchanged = {
  active: true;
  episodeId: string;
  cursor: number;
  unchanged: true;
};

interface Feed {
  episodeId: string;
  cursor: number;
  messages: SessionMessage[];
  active: boolean;
}

interface Identity {
  id: string;
  projectId: string;
  userId: string;
}

function command<T>(action: string, input: Identity, options?: object) {
  return invoke<T>("live_session", { action, input: { ...input, ...options } });
}

export function useLiveStatus(
  identity: Identity,
  scope: string,
  enabled: boolean,
) {
  const { id, projectId, userId } = identity;
  return useQuery({
    queryKey: ["live-session", scope, projectId, userId, id],
    queryFn: () => command<Status>("status", { id, projectId, userId }),
    enabled,
    retry: false,
    gcTime: 0,
    refetchInterval: (query) => (query.state.data?.available ? 30_000 : false),
  });
}

export function LiveControls({
  identity,
  status,
  scope,
  owner,
  onWatch,
  onChange,
}: {
  identity: Identity;
  status: Status;
  scope: string;
  owner: boolean;
  onWatch: () => void;
  onChange: () => void;
}) {
  const client = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [choose, setChoose] = useState(false);
  const key = [
    "live-session",
    scope,
    identity.projectId,
    identity.userId,
    identity.id,
  ];
  const targets = useQuery({
    queryKey: [...key, status.episodeId, "targets"],
    queryFn: () =>
      command<{ targets: Target[] }>("targets", identity, {
        episodeId: status.episodeId,
      }),
    enabled: choose && status.active,
    gcTime: 0,
    retry: false,
  });
  const update = useMutation({
    mutationFn: ({ action, target }: { action: string; target?: Target }) =>
      command<Status>(action, identity, {
        episodeId: status.episodeId,
        provider: target?.provider,
        nativeId: target?.nativeId,
        previousResourceId: target?.otherFollow?.id,
        previousEpisodeId: target?.otherFollow?.episodeId,
      }),
    onSuccess: async (next, { action }) => {
      await client.cancelQueries({ queryKey: key, exact: true });
      client.setQueryData(key, next);
      setConfirm(false);
      if (action === "follow" && next.following) onWatch();
      if (!next.active) setChoose(false);
      if (choose && next.active) await targets.refetch();
    },
    onError: onChange,
  });
  if (
    !status.available ||
    (!status.active && !status.eligible && !status.reason)
  )
    return null;
  if (!status.active && !owner) return null;
  const run = (action: string, target?: Target) =>
    update.mutate({ action, target });
  return (
    <section className="live-session-panel" aria-label="Live sharing">
      <div className="live-session-actions">
        <span className="live-session-label">
          <RadioIcon aria-hidden="true" size={16} />
          {status.active ? "Sharing live" : "Live sharing"}
        </span>
        {status.active && owner && (
          <Button
            size="sm"
            disabled={update.isPending}
            onClick={() => run("stop")}
          >
            Stop sharing live
          </Button>
        )}
        {!status.active && status.eligible && !confirm && (
          <Button size="sm" onClick={() => setConfirm(true)}>
            Share live…
          </Button>
        )}
        {status.active && !status.publishing && (
          <>
            <Button
              size="sm"
              disabled={update.isPending}
              onClick={() => run(status.following ? "unfollow" : "follow")}
            >
              {status.following ? "Stop watching" : "Watch live"}
            </Button>
            <Button
              size="sm"
              variant="tertiary"
              aria-expanded={choose}
              onClick={() => setChoose(!choose)}
            >
              {status.agentFollowing
                ? "Manage agent follows"
                : "Follow in an agent…"}
            </Button>
          </>
        )}
      </div>
      {confirm && !status.active && (
        <div>
          <p className="detail-info-note">
            Teammates with access can read this session and its future completed
            turns for up to 24 hours. You can stop sharing at any time.
          </p>
          <div className="live-session-actions">
            <Button
              size="sm"
              variant="primary"
              disabled={update.isPending}
              onClick={() => run("start")}
            >
              Start live sharing
            </Button>
            <Button
              size="sm"
              variant="tertiary"
              disabled={update.isPending}
              onClick={() => setConfirm(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {!status.active && !status.eligible && status.reason && (
        <p className="detail-info-note">{status.reason}</p>
      )}
      {choose && status.active && (
        <div>
          <p className="detail-info-note">
            Choose a local conversation to receive new turns as context on its
            next prompt. Each conversation can follow one live session.
          </p>
          {targets.isPending && <p role="status">Loading conversations…</p>}
          {targets.isError && (
            <Button size="sm" onClick={() => void targets.refetch()}>
              Retry loading conversations
            </Button>
          )}
          {targets.data?.targets.length === 0 && (
            <p className="detail-info-note">
              Open a Codex or Claude conversation in this project folder first.
            </p>
          )}
          {targets.data?.targets.map((target) => (
            <div
              className="live-session-target"
              key={target.provider + ":" + target.nativeId}
            >
              <span>
                {target.title} ·{" "}
                {target.provider === "claude" ? "Claude" : "Codex"}
              </span>
              <Button
                size="sm"
                disabled={update.isPending}
                onClick={() =>
                  run(
                    target.following || target.otherFollow
                      ? "agent_unfollow"
                      : "agent_follow",
                    target,
                  )
                }
              >
                {target.otherFollow
                  ? "Stop following previous session"
                  : target.following
                    ? "Unfollow"
                    : "Follow"}
              </Button>
            </div>
          ))}
        </div>
      )}
      {update.isError && (
        <p role="alert" className="detail-info-note detail-info-note--error">
          {String(update.error)}
        </p>
      )}
    </section>
  );
}

export function LiveConversation({
  identity,
  episodeId,
  source,
  author,
  raw,
  onEnd,
}: {
  identity: Identity;
  episodeId: string;
  source: ResourceSource;
  author: string;
  raw: boolean;
  onEnd: () => void;
}) {
  const { id, projectId, userId } = identity;
  const [feed, setFeed] = useState<Feed>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [first, setFirst] = useState<number>();
  const last = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const element = last.current?.closest(".detail-reader");
    if (!element) return;
    const scroll = () => {
      pinned.current =
        element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    };
    element.addEventListener("scroll", scroll, { passive: true });
    return () => element.removeEventListener("scroll", scroll);
  }, []);
  useEffect(() => {
    let closed = false;
    const identity = { id, projectId, userId };
    const read = async () => {
      let next: Feed | Unchanged = await command<Feed>("read", identity, {
        episodeId,
      });
      while (!closed) {
        if (!next.active || next.episodeId !== episodeId) {
          setFeed(undefined);
          onEnd();
          return;
        }
        if ("messages" in next) {
          const size = next.messages.length;
          setFeed(next);
          // Keep a bounded page anchored while reading earlier turns.
          setFirst((previous) =>
            pinned.current || previous === undefined
              ? Math.max(0, size - 40)
              : Math.min(previous, Math.max(0, size - 1)),
          );
        }
        next = await command<Feed | Unchanged>("wait", identity, {
          episodeId,
          cursor: next.cursor,
        });
      }
    };
    void read().catch((failure: unknown) => {
      if (!closed) {
        setFeed(undefined);
        setError(String(failure));
        onEnd();
      }
    });
    return () => {
      closed = true;
    };
  }, [id, projectId, userId, episodeId, onEnd, retry]);
  useEffect(() => {
    if (pinned.current && feed?.messages.length)
      last.current?.scrollIntoView({ block: "end" });
  }, [feed?.cursor, feed?.messages.length]);
  return (
    <div className="session-conversation" aria-label="Live conversation">
      {error ? (
        <p role="alert">
          {error}{" "}
          <Button
            size="sm"
            onClick={() => {
              setError("");
              setRetry((value) => value + 1);
            }}
          >
            Reconnect
          </Button>
        </p>
      ) : !feed ? (
        <p role="status">Connecting to live session…</p>
      ) : (
        <>
          {(first ?? 0) > 0 && (
            <Button
              size="sm"
              onClick={() => {
                pinned.current = false;
                setFirst((current) => Math.max(0, (current ?? 0) - 40));
              }}
            >
              Show earlier turns
            </Button>
          )}
          {!feed.messages.length && (
            <p role="status">Waiting for a completed turn…</p>
          )}
          {feed.messages.slice(first ?? 0, (first ?? 0) + 40).map((message) => (
            <SessionTurn
              key={message.index}
              message={message}
              userLabel={author}
              raw={raw}
              source={source}
            />
          ))}
          {(first ?? 0) + 40 < feed.messages.length && (
            <Button
              size="sm"
              onClick={() => {
                pinned.current = true;
                setFirst(Math.max(0, feed.messages.length - 40));
                requestAnimationFrame(() =>
                  last.current?.scrollIntoView({ block: "end" }),
                );
              }}
            >
              Jump to latest turns
            </Button>
          )}
        </>
      )}
      <div ref={last} />
    </div>
  );
}
