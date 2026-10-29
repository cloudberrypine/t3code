import type { EnvironmentId, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  remainingPercent,
  type LimitAccount,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { formatLimitResetCountdown } from "./usageLimitFormatting";
import { formatDayAwareTimestamp, formatUpcomingTimestamp } from "../../timestampFormat";

/** Limits pools all accounts. The footer instead prefers the primary environment's
 * first account, then the first connected account, preserving collectLimitAccounts order.
 * Never substitute a session allowance for Codex's weekly allowance. */
export function selectSidebarAccount(
  accounts: readonly LimitAccount[],
  driver: "codex" | "claudeAgent",
  primaryEnvironmentId: EnvironmentId | null,
) {
  const candidates = accounts.filter((account) => account.driver === driver);
  return (
    candidates.find((candidate) =>
      candidate.environments.some(
        (environment) => environment.environmentId === primaryEnvironmentId,
      ),
    ) ?? candidates[0]
  );
}

export function selectSidebarLimit(
  accounts: readonly LimitAccount[],
  driver: "codex" | "claudeAgent",
  primaryEnvironmentId: EnvironmentId | null,
) {
  const account = selectSidebarAccount(accounts, driver, primaryEnvironmentId);
  const windows = account?.limits.windows ?? [];
  return (
    windows.find((window) => window.kind === "weekly") ??
    (driver === "claudeAgent"
      ? (windows.find((window) => window.kind === "session") ?? windows[0])
      : undefined)
  );
}

export function sidebarWindowName(window: ServerProviderUsageWindow) {
  if (window.kind === "weekly" || window.kind === "monthly") return window.kind;
  if (window.kind === "session") {
    return window.windowDurationMins === 300 || window.id === "five_hour"
      ? "5-hour session"
      : "session";
  }
  return window.label;
}

/** Filter the existing widgets' input, including hub accounts, rather than only their headings. */
export function providerLimitPresentations(
  presentations: LimitPresentations,
  driver: "codex" | "claudeAgent",
): LimitPresentations {
  return new Map(
    [...presentations].map(([id, presentation]) => [
      id,
      {
        ...presentation,
        serverConfig: presentation.serverConfig
          ? {
              ...presentation.serverConfig,
              providers: presentation.serverConfig.providers?.filter(
                (provider) => provider.driver === driver,
              ),
              usageLimitSources: presentation.serverConfig.usageLimitSources?.flatMap((source) => {
                const accounts = source.accounts.filter((account) => account.driver === driver);
                return accounts.length ? [{ ...source, accounts }] : [];
              }),
            }
          : null,
      },
    ]),
  );
}

export function sidebarNoDataReason(
  presentations: LimitPresentations,
  driver: "codex" | "claudeAgent",
  primaryEnvironmentId: EnvironmentId | null,
) {
  const providers = [...presentations.values()].flatMap(
    (presentation) => presentation.serverConfig?.providers ?? [],
  );
  const primary = primaryEnvironmentId
    ? presentations
        .get(primaryEnvironmentId)
        ?.serverConfig?.providers?.find((provider) => provider.driver === driver)
    : undefined;
  const provider = primary ?? providers.find((provider) => provider.driver === driver);
  if (provider?.auth.status === "unauthenticated") return "not signed in";
  const unavailable = provider?.usageLimits?.unavailable;
  return (
    unavailable?.message ??
    (unavailable?.reason === "unsupported"
      ? "usage limits are not supported for this account"
      : unavailable?.reason === "probeFailed"
        ? "could not load usage limits"
        : "not loaded yet")
  );
}

/** One sentence with the same facts the existing compact widgets display. */
export function sidebarLimitLabel(
  accounts: readonly LimitAccount[],
  driver: "codex" | "claudeAgent",
  primaryEnvironmentId: EnvironmentId | null,
  timestampFormat: TimestampFormat,
  now: number,
  noDataReason = "not loaded yet",
): string {
  const account = selectSidebarAccount(accounts, driver, primaryEnvironmentId);
  const window = selectSidebarLimit(accounts, driver, primaryEnvironmentId);
  const provider = driver === "codex" ? "Codex" : "Claude";
  const identity =
    accounts.filter((candidate) => candidate.driver === driver).length > 1
      ? (account?.email ?? account?.displayName)
      : null;
  const prefix = `${provider}${identity ? ` (${identity})` : ""}`;
  if (!window) return `${prefix}: no usage limit data yet (${noDataReason})`;
  const details = [
    window,
    ...(account?.limits.windows.filter((other) => other !== window) ?? []),
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
  return `${prefix}: ${details.join("; ")}`;
}
