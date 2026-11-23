import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Snapshot } from "../types.js";

export type DesktopScreen =
  | "screen:projects"
  | "screen:sessions"
  | "screen:memories"
  | "screen:skills"
  | "screen:plans"
  | "screen:reviews"
  | "screen:members"
  | "screen:envs"
  | "screen:logs"
  | "screen:settings";

type DesktopFeature =
  | "feature:session_resumed"
  | "feature:session_forked"
  | "feature:skill_imported"
  | "feature:memory_shared"
  | "feature:skill_shared"
  | "feature:plan_shared"
  | "feature:session_shared"
  | "feature:source_connected"
  | "feature:review_decided"
  | "feature:settings_saved";

type DesktopUsageEvent = DesktopScreen | DesktopFeature;
type Scope = { accountId: string; serviceOrigin: string };

const screenDwellMs = 750;
const batchDelayMs = 1_250;
const batchLimit = 16;
const dailyScreenLimit = 45;
const dailyLimit = 60;
const utcDayMs = 86_400_000;
const dailyCounts = new Map<string, { total: number; screens: number }>();
let budgetDay = Math.floor(Date.now() / utcDayMs);

const isForeground = () => !document.hidden && document.hasFocus();

class DesktopUsage {
  private active = false;
  private inFlight = false;
  private pending: DesktopUsageEvent[] = [];
  private timer: number | undefined;
  private lastScreen: DesktopScreen | undefined;
  private readonly budgetKey: string;

  constructor(private readonly scope: Scope) {
    this.budgetKey = JSON.stringify([scope.serviceOrigin, scope.accountId]);
  }

  start() {
    this.active = true;
  }

  stop() {
    this.active = false;
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.lastScreen = undefined;
    this.pending = [];
  }

  screen(screen: DesktopScreen) {
    if (screen !== this.lastScreen && this.enqueue(screen))
      this.lastScreen = screen;
  }

  feature(feature: DesktopFeature) {
    return this.enqueue(feature);
  }

  private enqueue(event: DesktopUsageEvent) {
    if (!this.active || this.pending.length >= batchLimit) return false;

    const day = Math.floor(Date.now() / utcDayMs);
    if (day !== budgetDay) {
      budgetDay = day;
      dailyCounts.clear();
    }
    const count = dailyCounts.get(this.budgetKey) ?? { total: 0, screens: 0 };
    const screen = event.startsWith("screen:");
    if (
      count.total >= dailyLimit ||
      (screen && count.screens >= dailyScreenLimit)
    )
      return false;
    count.total += 1;
    if (screen) count.screens += 1;
    dailyCounts.set(this.budgetKey, count);
    this.pending.push(event);
    this.schedule();
    return true;
  }

  private schedule() {
    if (
      !this.active ||
      this.inFlight ||
      this.timer !== undefined ||
      !this.pending.length
    )
      return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      const events = this.pending;
      this.pending = [];
      this.inFlight = true;
      void invoke("record_desktop_usage", { ...this.scope, events })
        .catch(() => {})
        .finally(() => {
          this.inFlight = false;
          this.schedule();
        });
    }, batchDelayMs);
  }
}

const UsageContext = createContext<DesktopUsage | undefined>(undefined);

export function DesktopUsageProvider({
  state,
  children,
}: {
  state: Pick<Snapshot, "user" | "config">;
  children: ReactNode;
}) {
  const accountId = state.user;
  const serviceOrigin = state.config?.apiUrl;
  const selfHosted = state.config?.mode === "self-hosted";
  const usage = useMemo(
    () =>
      isTauri() && accountId && serviceOrigin && !selfHosted
        ? new DesktopUsage({ accountId, serviceOrigin })
        : undefined,
    [accountId, serviceOrigin, selfHosted],
  );
  useLayoutEffect(() => {
    usage?.start();
    return () => usage?.stop();
  }, [usage]);
  return (
    <UsageContext.Provider value={usage}>{children}</UsageContext.Provider>
  );
}

/** Mount alongside the visible screen so a pending Suspense branch does not count. */
export function DesktopUsageScreen({ screen }: { screen?: DesktopScreen }) {
  const usage = useContext(UsageContext);
  useLayoutEffect(() => {
    if (!usage || !screen) return;
    let dwell: number | undefined;
    let recorded = false;
    const update = () => {
      window.clearTimeout(dwell);
      if (recorded || !isForeground()) return;
      dwell = window.setTimeout(() => {
        if (isForeground()) {
          usage.screen(screen);
          recorded = true;
        }
      }, screenDwellMs);
    };
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      window.clearTimeout(dwell);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [screen, usage]);
  return null;
}

/** Capture foreground intent before a feature can move focus to another app. */
export function useDesktopFeature() {
  const usage = useContext(UsageContext);
  return useCallback(
    (feature: DesktopFeature) => {
      const current = isForeground() ? usage : undefined;
      let recorded = false;
      return () => {
        if (recorded) return false;
        recorded = true;
        return current?.feature(feature) ?? false;
      };
    },
    [usage],
  );
}
