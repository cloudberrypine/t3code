import type { EnvironmentId } from "@t3tools/contracts";
import type { LimitAccount, LimitPresentations } from "@t3tools/shared/usageLimits";

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
