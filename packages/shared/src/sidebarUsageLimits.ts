import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshots,
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

function sidebarNoDataReason(
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
  /** The instance's own accent colour; the ring uses the driver's colour without one. */
  readonly accentColor: string | undefined;
  /** Why there is no weekly window; null when there is one. */
  readonly noDataReason: string | null;
}

type InstanceEntry = ReturnType<typeof instanceLimitAccounts>[number] & { readonly key: string };

/** The provider settings' order: each driver's default instance, then `instanceOrder` (the
 * settings' providerInstances keys). The server sorts its providers by display name instead. */
function inSettingsOrder(
  instances: ReturnType<typeof instanceLimitAccounts>,
  instanceOrder: readonly string[],
) {
  const rank = ({ provider }: (typeof instances)[number]) => {
    const index = instanceOrder.indexOf(provider.instanceId);
    return provider.instanceId === defaultInstanceIdForDriver(provider.driver)
      ? -1
      : index === -1
        ? instanceOrder.length
        : index;
  };
  return [...instances].sort((left, right) => rank(left) - rank(right));
}

/** Each driver gets one ring from any environment, preferring the primary's account. */
function driverRings(
  presentations: LimitPresentations,
  primaryEnvironmentId: EnvironmentId | null,
): readonly SidebarRing[] {
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

/** One ring per account of `instances` (already in ring order); the first instance on an
 * account owns its ring. */
function instanceRings(
  presentations: LimitPresentations,
  instances: readonly InstanceEntry[],
  primaryEnvironmentId: EnvironmentId | null,
): readonly SidebarRing[] {
  return SIDEBAR_DRIVERS.flatMap((driver) => {
    const rings = instances
      .filter((entry) => entry.provider.driver === driver)
      .filter(
        (entry, index, all) =>
          all.findIndex((other) => other.accountKey === entry.accountKey) === index,
      );
    return rings.map(({ key, provider, account: own }): SidebarRing => {
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
        key,
        driver,
        title: email ? `${name} (${email})` : name,
        account,
        window,
        // The instance's own colour only: a merged account carries the first accent of any
        // instance on it, in any environment.
        accentColor: provider.accentColor,
        noDataReason: window ? null : providerNoDataReason(provider),
      };
    });
  });
}

/** One ring per account of the primary environment's enabled Codex and Claude instances,
 * in the provider settings' order. Until the primary environment's providers load, or without
 * one, each driver gets one ring from any environment. */
export function selectSidebarRings(
  presentations: LimitPresentations,
  primaryEnvironmentId: EnvironmentId | null,
  instanceOrder: readonly string[] = [],
): readonly SidebarRing[] {
  const loaded = primaryEnvironmentId
    ? presentations.get(primaryEnvironmentId)?.serverConfig
    : undefined;
  if (!primaryEnvironmentId || !loaded) return driverRings(presentations, primaryEnvironmentId);
  const instances = inSettingsOrder(
    instanceLimitAccounts(presentations, primaryEnvironmentId),
    instanceOrder,
  ).map((entry) => ({ ...entry, key: entry.provider.instanceId }));
  return instanceRings(presentations, instances, primaryEnvironmentId);
}

type PooledRingPresentations = ReadonlyMap<
  EnvironmentId,
  {
    readonly entry: { readonly target: { readonly label: string } };
    readonly serverConfig: {
      readonly providers: readonly ServerProvider[];
      readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
      readonly settings?: { readonly providerInstances: Readonly<Record<string, unknown>> };
    } | null;
  }
>;

/** The rings of a client without a primary environment (the phone): one per account of the
 * enabled Codex and Claude instances of every environment, each environment's instances in its
 * own settings order, an account's ring owned by the first environment that has it. Until any
 * environment's providers load, each driver gets one ring. */
export function selectPooledSidebarRings(
  presentations: PooledRingPresentations,
): readonly SidebarRing[] {
  if (![...presentations.values()].some(({ serverConfig }) => serverConfig))
    return driverRings(presentations, null);
  const instances = [...presentations].flatMap(([environmentId, { serverConfig }]) =>
    serverConfig
      ? inSettingsOrder(
          instanceLimitAccounts(presentations, environmentId),
          Object.keys(serverConfig.settings?.providerInstances ?? {}),
        ).map((entry) => ({ ...entry, key: `${environmentId}:${entry.provider.instanceId}` }))
      : [],
  );
  return instanceRings(presentations, instances, null);
}
