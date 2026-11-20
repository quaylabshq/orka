import { useEffect, useRef } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { invoke } from "@tauri-apps/api/core";

/** Delivers orka:// links from launch and from the running app; other protocols are ignored. */
export function useDeepLinks(
  onLink: (link: URL) => void,
  enabled = true,
  deferInvites = false,
) {
  const handler = useRef(onLink);
  const available = useRef(enabled);
  const invitesDeferred = useRef(deferInvites);
  const deferredInvite = useRef<URL | null>(null);
  useEffect(() => {
    handler.current = onLink;
    available.current = enabled;
    invitesDeferred.current = deferInvites;
    if (!deferInvites && deferredInvite.current) {
      const link = deferredInvite.current;
      deferredInvite.current = null;
      onLink(link);
    }
  });
  useEffect(() => {
    let stopped = false;
    const deliver = (link: URL) => {
      if (link.hostname === "join" && invitesDeferred.current) {
        deferredInvite.current = link;
        return;
      }
      handler.current(link);
    };
    const handle = (links: string[]) => {
      if (stopped) return;
      for (const link of links) {
        try {
          const parsed = new URL(link);
          if (parsed.protocol !== "orka:") continue;
          if (parsed.hostname === "auth") {
            void invoke("route_auth_callback", { callback: link }).catch(() => {
              // Surface invalid/unsupported callbacks through the normal login error path.
              if (!stopped) handler.current(parsed);
            });
            continue;
          }
          deliver(parsed);
        } catch {
          /* Ignore links outside Orka's protocol. */
        }
      }
    };
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;
    const poll = async () => {
      try {
        if (!available.current) return;
        const callback = await invoke<string | null>("profile_events");
        if (!stopped && typeof callback === "string")
          deliver(new URL(callback));
      } catch {
        /* The native profile may still be starting. */
      } finally {
        if (!stopped) timer = window.setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    void getCurrent()
      .then((links) => links && handle(links))
      .catch(() => {});
    void onOpenUrl(handle)
      .then((fn) => {
        if (stopped) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, []);
}
