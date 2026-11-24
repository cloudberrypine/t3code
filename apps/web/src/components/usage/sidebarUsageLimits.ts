import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { selectUsageLimitWindows, remainingPercent } from "@t3tools/shared/usageLimits";
import type { SidebarRing } from "@t3tools/shared/sidebarUsageLimits";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { formatLimitResetCountdown } from "./usageLimitFormatting";
import { formatDayAwareTimestamp, formatUpcomingTimestamp } from "../../timestampFormat";

export { selectSidebarRings } from "@t3tools/shared/sidebarUsageLimits";

export function sidebarWindowName(window: ServerProviderUsageWindow) {
  if (window.kind === "weekly" || window.kind === "monthly") return window.kind;
  if (window.kind === "session") {
    return window.windowDurationMins === 300 || window.id === "five_hour"
      ? "5-hour session"
      : "session";
  }
  return window.label;
}

/** One sentence with the same facts the existing compact widgets display. */
export function sidebarLimitLabel(
  { driver, title, account, window, noDataReason }: SidebarRing,
  timestampFormat: TimestampFormat,
  now: number,
): string {
  if (!window) return `${title}: no usage limit data yet (${noDataReason ?? "not loaded yet"})`;
  const details = [
    window,
    ...((account
      ? selectUsageLimitWindows(driver, account.limits).windows.filter((other) => other !== window)
      : []) ?? []),
  ].map((entry) => {
    const remaining = remainingPercent(entry);
    const reset = entry.resetsAt
      ? formatUpcomingTimestamp(entry.resetsAt, timestampFormat, now)
      : "";
    const countdown = formatLimitResetCountdown(entry, now);
    return `${sidebarWindowName(entry)} limit: ${remaining}% left (${100 - remaining}% used)${countdown ? `, ${countdown}` : ""}${reset ? ` (${reset})` : ""}`;
  });
  if (account?.plan) details.push(account.plan);
  if (account)
    details.push(
      `updated ${formatDayAwareTimestamp(account.limits.checkedAt, timestampFormat, now)}`,
    );
  return `${title}: ${details.join("; ")}`;
}
