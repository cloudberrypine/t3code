import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  UsageLimitSourceId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { collectLimitAccounts, type LimitAccount } from "@t3tools/shared/usageLimits";
import { selectSidebarLimit } from "@t3tools/shared/sidebarUsageLimits";
import { sidebarLimitLabel, sidebarWindowName, selectSidebarRings } from "./sidebarUsageLimits";

const primary = EnvironmentId.make("primary");
const other = EnvironmentId.make("other");
const window = (
  id: string,
  kind: ServerProviderUsageWindow["kind"],
): ServerProviderUsageWindow => ({
  id,
  kind,
  label: id,
  usedPercent: 27,
});
const account = (
  driver: "codex" | "claudeAgent",
  environmentId: EnvironmentId,
  windows: ServerProviderUsageWindow[],
): LimitAccount => ({
  key: `${driver}:${environmentId}`,
  driver: ProviderDriverKind.make(driver),
  displayName: null,
  email: undefined,
  plan: undefined,
  accentColor: undefined,
  environments: [{ environmentId, label: environmentId }],
  sourceLabel: null,
  redeem: null,
  limits: { checkedAt: "2026-10-29T10:00:00Z", windows },
});

describe("sidebar limit selection", () => {
  it("prefers the primary environment's account and weekly allowance over a session", () => {
    const weekly = window("secondary", "weekly");
    const accounts = [
      account("codex", other, [window("secondary", "weekly")]),
      account("codex", primary, [window("primary", "session"), weekly]),
    ];
    expect(selectSidebarLimit(accounts, "codex", primary)).toBe(weekly);
  });
  it("uses collection order without a primary account and never shows Codex session as weekly", () => {
    const session = window("primary", "session");
    const accounts = [account("codex", other, [session])];
    expect(selectSidebarLimit(accounts, "codex", primary)).toBeUndefined();
    expect(selectSidebarLimit([], "claudeAgent", primary)).toBeUndefined();
  });
  it("uses only Claude regular weekly without a session fallback", () => {
    const session = window("five_hour", "session");
    const weekly = window("seven_day", "weekly");
    expect(
      selectSidebarLimit(
        [account("claudeAgent", primary, [session, weekly])],
        "claudeAgent",
        primary,
      ),
    ).toBe(weekly);
    expect(
      selectSidebarLimit([account("claudeAgent", primary, [session])], "claudeAgent", primary),
    ).toBeUndefined();
  });
});

const instance = (
  instanceId: string,
  driver: "codex" | "claudeAgent",
  overrides: Partial<ServerProvider> & { email?: string } = {},
): ServerProvider => {
  const { email, ...rest } = overrides;
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated", ...(email ? { email } : {}) },
    checkedAt: "2026-10-29T10:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-10-29T10:00:00Z",
      windows: [
        { ...window("seven_day", "weekly"), usedPercent: email === "two@example.com" ? 90 : 27 },
      ],
    },
    ...rest,
  };
};
const primaryWith = (...providers: ServerProvider[]) =>
  new Map([[primary, { entry: { target: { label: "Primary" } }, serverConfig: { providers } }]]);
const ringSummary = (rings: ReturnType<typeof selectSidebarRings>) =>
  rings.map((ring) => [ring.title, ring.window?.usedPercent, ring.accentColor, ring.noDataReason]);

describe("sidebar rings per provider instance", () => {
  const codex = instance("codex", "codex", { email: "me@example.com" });
  const claude = instance("claudeAgent", "claudeAgent", { email: "one@example.com" });
  it("gives each account of the primary environment's instances a ring in settings order", () => {
    // The server sorts by display name; the provider settings list the default instance first.
    const second = instance("claude2", "claudeAgent", {
      displayName: "Claude 2",
      email: "two@example.com",
      accentColor: "#22aa44",
    });
    expect(
      ringSummary(
        selectSidebarRings(primaryWith(codex, second, claude), primary, [second.instanceId]),
      ),
    ).toEqual([
      ["Codex", 27, undefined, null],
      ["Claude (one@example.com)", 27, undefined, null],
      ["Claude 2 (two@example.com)", 90, "#22aa44", null],
    ]);
    // The shared ring belongs to the first instance and takes its colour, not the other's.
    const sameAccount = instance("claude2", "claudeAgent", {
      email: "One@example.com",
      accentColor: "#112233",
    });
    expect(
      ringSummary(selectSidebarRings(primaryWith(codex, claude, sameAccount), primary)),
    ).toEqual([
      ["Codex", 27, undefined, null],
      ["Claude", 27, undefined, null],
    ]);
    const disabled = { ...second, enabled: false };
    expect(selectSidebarRings(primaryWith(codex, claude, disabled), primary)).toHaveLength(2);
    const signedOut = instance("claude2", "claudeAgent", {
      displayName: "Claude 2",
      auth: { status: "unauthenticated" },
      usageLimits: undefined,
    });
    expect(ringSummary(selectSidebarRings(primaryWith(codex, claude, signedOut), primary))).toEqual(
      [
        ["Codex", 27, undefined, null],
        ["Claude (one@example.com)", 27, undefined, null],
        ["Claude 2", undefined, undefined, "not signed in"],
      ],
    );
  });
  it("keeps one ring per driver when each has one instance or the primary is not loaded", () => {
    const presentations = primaryWith(codex, claude);
    const rings = selectSidebarRings(presentations, primary);
    expect(rings.map((ring) => [ring.driver, ring.title])).toEqual([
      ["codex", "Codex"],
      ["claudeAgent", "Claude"],
    ]);
    expect(rings[1]?.window).toBe(
      selectSidebarLimit(collectLimitAccounts(presentations), "claudeAgent", primary),
    );
    // An accent set on the same account in another environment leaves the driver colour.
    const elsewhere = new Map([
      ...presentations,
      [
        other,
        {
          entry: { target: { label: "Other" } },
          serverConfig: {
            providers: [
              instance("claudeAgent", "claudeAgent", {
                email: "one@example.com",
                accentColor: "#abcdef",
              }),
            ],
          },
        },
      ],
    ]);
    expect(ringSummary(selectSidebarRings(elsewhere, primary))).toEqual([
      ["Codex", 27, undefined, null],
      ["Claude", 27, undefined, null],
    ]);
    expect(ringSummary(selectSidebarRings(new Map(), primary))).toEqual([
      ["Codex", undefined, undefined, "not loaded yet"],
      ["Claude", undefined, undefined, "not loaded yet"],
    ]);
  });
});

const now = Date.parse("2026-10-29T09:00:00Z");
describe("sidebar limit accessible tooltip summary", () => {
  it("names only weekly allowance, usage, countdown, reset, plan and update", () => {
    const weekly = { ...window("seven_day", "weekly"), resetsAt: "2026-10-31T14:00:00Z" };
    const session = { ...window("five_hour", "session"), windowDurationMins: 300, usedPercent: 59 };
    const selected = {
      ...account("claudeAgent", primary, [weekly, session]),
      email: "one@example.com",
      plan: "Max",
    };
    const label = sidebarLimitLabel(
      {
        key: "claudeAgent",
        driver: "claudeAgent",
        title: "Claude (one@example.com)",
        account: selected,
        window: weekly,
        accentColor: undefined,
        noDataReason: null,
      },
      "24-hour",
      now,
    );
    expect(label).toContain("Claude (one@example.com): weekly limit: 73% left (27% used)");
    expect(label).toContain("resets in 2 days 5 h");
    expect(label).not.toContain("session");
    expect(label).toContain("Max; updated");
    expect(label).not.toContain("undefined");
  });
  it("names fallback windows and the reason a ring has no data", () => {
    const session = window("five_hour", "session");
    expect(sidebarWindowName(session)).toBe("5-hour session");
    const [, ring] = selectSidebarRings(
      primaryWith(
        instance("codex", "codex"),
        instance("claudeAgent", "claudeAgent", {
          email: "one@example.com",
          usageLimits: { checkedAt: "2026-10-29T10:00:00Z", windows: [session] },
        }),
      ),
      primary,
    );
    expect(ring && sidebarLimitLabel(ring, "24-hour", now)).toBe(
      "Claude: no usage limit data yet (not loaded yet)",
    );
  });
  it("feeds an instance's ring from a hub report of the same account", () => {
    const presentations = new Map([
      [
        primary,
        {
          entry: { target: { label: "Primary" } },
          serverConfig: {
            providers: [
              instance("codex", "codex"),
              instance("claudeAgent", "claudeAgent", { email: "one@example.com" }),
              instance("claude2", "claudeAgent", {
                email: "two@example.com",
                usageLimits: undefined,
              }),
            ],
            usageLimitSources: [
              {
                id: UsageLimitSourceId.make("hub"),
                kind: "cliproxy" as const,
                checkedAt: "2026-10-29T09:00:00Z",
                label: "Hub",
                accounts: [
                  {
                    id: "two",
                    driver: ProviderDriverKind.make("claudeAgent"),
                    email: "two@example.com",
                    usageLimits: account("claudeAgent", primary, [
                      { ...window("seven_day", "weekly"), usedPercent: 64 },
                    ]).limits,
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    expect(ringSummary(selectSidebarRings(presentations, primary))).toEqual([
      ["Codex", 27, undefined, null],
      ["Claude (one@example.com)", 27, undefined, null],
      ["Claude (two@example.com)", 64, undefined, null],
    ]);
  });
});
