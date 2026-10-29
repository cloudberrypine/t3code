import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  UsageLimitSourceId,
  ProviderDriverKind,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import {
  sidebarLimitLabel,
  sidebarWindowName,
  providerLimitPresentations,
  sidebarNoDataReason,
  selectSidebarLimit,
} from "./sidebarUsageLimits";

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
  it("prefers Claude weekly and falls back to its main session window", () => {
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
    ).toBe(session);
  });
});

const now = Date.parse("2026-10-29T09:00:00Z");
describe("sidebar limit accessible tooltip summary", () => {
  it("names weekly and session allowances, usage, countdown, reset, plan and update", () => {
    const weekly = { ...window("weekly", "weekly"), resetsAt: "2026-10-31T14:00:00Z" };
    const session = { ...window("five_hour", "session"), windowDurationMins: 300, usedPercent: 59 };
    const selected = {
      ...account("claudeAgent", primary, [weekly, session]),
      email: "one@example.com",
      plan: "Max",
    };
    const label = sidebarLimitLabel(
      [selected, account("claudeAgent", other, [])],
      "claudeAgent",
      primary,
      "24-hour",
      now,
    );
    expect(label).toContain("Claude (one@example.com): weekly limit: 73% left (27% used)");
    expect(label).toContain("resets in 2 days 5 h");
    expect(label).toContain("5-hour session limit: 41% left (59% used)");
    expect(label).toContain("Max; updated");
    expect(label).not.toContain("undefined");
  });
  it("names fallback windows and does not expose a lone account email", () => {
    const session = window("five_hour", "session");
    const selected = { ...account("claudeAgent", primary, [session]), email: "one@example.com" };
    expect(sidebarWindowName(session)).toBe("5-hour session");
    expect(sidebarLimitLabel([selected], "claudeAgent", primary, "24-hour", now)).toMatch(
      /^Claude: 5-hour session limit: 73% left/,
    );
    expect(sidebarLimitLabel([], "codex", primary, "24-hour", now, "not signed in")).toBe(
      "Codex: no usage limit data yet (not signed in)",
    );
  });
  it("filters both native and hub accounts to the hovered provider", () => {
    const presentations = new Map([
      [
        primary,
        {
          entry: { target: { label: "Primary" } },
          serverConfig: {
            usageLimitSources: [
              {
                id: UsageLimitSourceId.make("hub"),
                kind: "cliproxy" as const,
                checkedAt: "2026-10-29T09:00:00Z",
                label: "Hub",
                accounts: [
                  {
                    id: "one",
                    driver: ProviderDriverKind.make("codex"),
                    usageLimits: account("codex", primary, []).limits,
                  },
                  {
                    id: "two",
                    driver: ProviderDriverKind.make("claudeAgent"),
                    usageLimits: account("claudeAgent", primary, []).limits,
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const filtered = providerLimitPresentations(presentations, "codex");
    expect(
      filtered
        .get(primary)
        ?.serverConfig?.usageLimitSources?.[0]?.accounts.map((entry) => entry.id),
    ).toEqual(["one"]);
    expect(presentations.get(primary)?.serverConfig.usageLimitSources[0]?.accounts).toHaveLength(2);
    expect(sidebarNoDataReason(new Map(), "claudeAgent", primary)).toBe("not loaded yet");
  });
});
