import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { selectSidebarLimit } from "./sidebarUsageLimits";

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
