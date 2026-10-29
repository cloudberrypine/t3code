import type { EnvironmentId } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";

/** Limits pools all accounts. The footer instead prefers the primary environment's
 * first account, then the first connected account, preserving collectLimitAccounts order.
 * Never substitute a session allowance for Codex's weekly allowance. */
export function selectSidebarLimit(
  accounts: readonly LimitAccount[],
  driver: "codex" | "claudeAgent",
  primaryEnvironmentId: EnvironmentId | null,
) {
  const candidates = accounts.filter((account) => account.driver === driver);
  const account =
    candidates.find((candidate) =>
      candidate.environments.some(
        (environment) => environment.environmentId === primaryEnvironmentId,
      ),
    ) ?? candidates[0];
  const windows = account?.limits.windows ?? [];
  return (
    windows.find((window) => window.kind === "weekly") ??
    (driver === "claudeAgent"
      ? (windows.find((window) => window.kind === "session") ?? windows[0])
      : undefined)
  );
}
