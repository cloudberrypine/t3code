import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { formatResetsIn } from "./usageLimits.js";

/** Spell out days so a new user can read the reset countdown at a glance. */
export function formatLimitResetCountdown(window: ServerProviderUsageWindow, now: number) {
  return (
    formatResetsIn(window, now)
      ?.replace(/(\d+)d/g, (_, days: string) => `${days} ${days === "1" ? "day" : "days"}`)
      .replace(/(\d+)h/g, "$1 h")
      .replace(/(\d+)m/g, "$1 min") ?? null
  );
}
