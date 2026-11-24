import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  collectLimitAccounts,
  instanceLimitAccounts,
  selectUsageLimitWindows,
  type LimitAccount,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";

const SIDEBAR_DRIVER_NAMES = { codex: "Codex", claudeAgent: "Claude" } as const;
const SIDEBAR_DRIVERS = ["codex", "claudeAgent"] as const;
type SidebarDriver = (typeof SIDEBAR_DRIVERS)[number];

/** Limits pools all accounts. The footer instead prefers the primary environment's
 * first account, then the first connected account, preserving collectLimitAccounts order.
 * Never substitute a session allowance for Codex's weekly allowance. */
function selectSidebarAccount(
  accounts: readonly LimitAccount[],
  driver: SidebarDriver,
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

function weeklyWindow(driver: SidebarDriver, account: LimitAccount | undefined) {
  const windows = account ? selectUsageLimitWindows(driver, account.limits).windows : [];
  return windows.find((window) => window.kind === "weekly");
}

export function selectSidebarLimit(
  accounts: readonly LimitAccount[],
  driver: SidebarDriver,
  primaryEnvironmentId: EnvironmentId | null,
) {
  return weeklyWindow(driver, selectSidebarAccount(accounts, driver, primaryEnvironmentId));
}

function providerNoDataReason(provider: ServerProvider | undefined) {
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

export function sidebarNoDataReason(
  presentations: LimitPresentations,
  driver: SidebarDriver,
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
  return providerNoDataReason(primary ?? providers.find((provider) => provider.driver === driver));
}

export interface SidebarRing {
  readonly key: string;
  readonly driver: SidebarDriver;
  /** The instance's name, plus the account's email when its driver has several rings. */
  readonly title: string;
  readonly account: LimitAccount | undefined;
  readonly window: ServerProviderUsageWindow | undefined;
  readonly accentColor: string | undefined;
  /** Why there is no weekly window; null when there is one. */
  readonly noDataReason: string | null;
}

/** One ring per account of the primary environment's enabled Codex and Claude instances,
 * in the provider settings' order: drivers first, then each driver's default instance, then
 * `instanceOrder` (the settings' providerInstances keys). Until the primary environment's
 * providers load, or without one, each driver gets one ring from any environment. */
export function selectSidebarRings(
  presentations: LimitPresentations,
  primaryEnvironmentId: EnvironmentId | null,
  instanceOrder: readonly string[] = [],
): readonly SidebarRing[] {
  const loaded = primaryEnvironmentId
    ? presentations.get(primaryEnvironmentId)?.serverConfig
    : undefined;
  if (!primaryEnvironmentId || !loaded) {
    const accounts = collectLimitAccounts(presentations);
    return SIDEBAR_DRIVERS.map((driver) => {
      const account = selectSidebarAccount(accounts, driver, primaryEnvironmentId);
      const window = weeklyWindow(driver, account);
      return {
        key: driver,
        driver,
        title: SIDEBAR_DRIVER_NAMES[driver],
        account,
        window,
        accentColor: undefined,
        noDataReason: window
          ? null
          : sidebarNoDataReason(presentations, driver, primaryEnvironmentId),
      };
    });
  }
  const instances = instanceLimitAccounts(presentations, primaryEnvironmentId);
  return SIDEBAR_DRIVERS.flatMap((driver) => {
    const rank = (instanceId: ProviderInstanceId) => {
      const index = instanceOrder.indexOf(instanceId);
      return instanceId === driver ? -1 : index === -1 ? instanceOrder.length : index;
    };
    const rings = instances
      .filter((entry) => entry.provider.driver === driver)
      .sort((left, right) => rank(left.provider.instanceId) - rank(right.provider.instanceId))
      .filter(
        (entry, index, all) =>
          all.findIndex((other) => other.accountKey === entry.accountKey) === index,
      );
    return rings.map(({ provider, account: own }): SidebarRing => {
      // A lone instance keeps the footer's former fallback to another environment's account.
      const account =
        own ??
        (rings.length === 1
          ? selectSidebarAccount(collectLimitAccounts(presentations), driver, primaryEnvironmentId)
          : undefined);
      const window = weeklyWindow(driver, account);
      const name = provider.displayName?.trim() || SIDEBAR_DRIVER_NAMES[driver];
      const email = rings.length > 1 ? account?.email : undefined;
      return {
        key: provider.instanceId,
        driver,
        title: email ? `${name} (${email})` : name,
        account,
        window,
        accentColor: provider.accentColor ?? account?.accentColor,
        noDataReason: window ? null : providerNoDataReason(provider),
      };
    });
  });
}
