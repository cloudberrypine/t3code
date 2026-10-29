import { describe, expect, it } from "vite-plus/test";
import { formatLimitResetCountdown } from "./usageLimitFormatting";

const now = Date.parse("2026-10-29T09:00:00Z");
const window = { id: "weekly", label: "Weekly", kind: "weekly" as const, usedPercent: 27 };
describe("readable limit reset countdown", () => {
  it("spells out days and preserves hours, imminent resets and missing times", () => {
    expect(formatLimitResetCountdown({ ...window, resetsAt: "2026-10-31T14:00:00Z" }, now)).toBe(
      "resets in 2 days 5 h",
    );
    expect(formatLimitResetCountdown({ ...window, resetsAt: "2026-10-30T09:00:00Z" }, now)).toBe(
      "resets in 1 day 0 h",
    );
    expect(formatLimitResetCountdown({ ...window, resetsAt: "2026-10-29T08:00:00Z" }, now)).toBe(
      "resets now",
    );
    expect(formatLimitResetCountdown(window, now)).toBeNull();
  });
});
