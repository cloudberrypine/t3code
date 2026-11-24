import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { collectLimitAccounts } from "@t3tools/shared/usageLimits";
import { CompactLimitAccount } from "./UsageLimitsPooled";

// Local: the sidebar ring hover reuses the limit widgets for one account (compact).
const checkedAt = "2026-09-11T11:55:00.000Z";

function weeklyWindow(): ServerProviderUsageWindow {
  return {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    usedPercent: 40,
    windowDurationMins: 10_080,
    resetsAt: "2026-09-11T14:00:00.000Z",
  };
}

function provider(driver: "codex" | "claudeAgent", plan: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    displayName: driver === "codex" ? "Codex" : "Claude",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated", label: plan },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt, windows: [weeklyWindow()] },
  };
}

describe("compact provider limit widgets", () => {
  it("show one account and update their reset countdown", async () => {
    const [, claude] = collectLimitAccounts(
      new Map([
        [
          EnvironmentId.make("desk"),
          {
            entry: { target: { label: "Desk" } },
            serverConfig: { providers: [provider("codex", "Pro"), provider("claudeAgent", "Max")] },
          },
        ],
      ]),
    );
    if (!claude) throw new Error("expected a Claude account");
    const view = (now: number) => <CompactLimitAccount account={claude} now={now} />;
    await using screen = await render(view(Date.parse("2026-09-11T12:00:00Z")));

    await expect.element(screen.getByText("Max")).toBeVisible();
    await expect.element(screen.getByText("60% left (40% used)")).toBeVisible();
    await expect.element(screen.getByText(/resets in 2h 0m/)).toBeVisible();
    await expect.element(screen.getByText(/^Updated /)).toBeVisible();

    await screen.rerender(view(Date.parse("2026-09-11T13:00:00Z")));
    await expect.element(screen.getByText(/resets in 1h 0m/)).toBeVisible();
  });
});
