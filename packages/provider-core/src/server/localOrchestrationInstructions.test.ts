import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "./orchestrationInstructions.ts";
import { T3_CODE_LOCAL_ORCHESTRATION_SECTION } from "./localOrchestrationInstructions.ts";

describe("PolyCode orchestration instructions", () => {
  it("tells a thread it can settle itself after its run", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "`settle_after_run`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "`cancel_settle_after_run`");
  });

  it("points long-lived watches at watch_command instead of harness monitors", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "`watch_command`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "time-limited monitors");
  });

  it("keeps the local section within Codex's per-entry limit", () => {
    assert.include(T3_CODE_ORCHESTRATION_SECTIONS, T3_CODE_LOCAL_ORCHESTRATION_SECTION);
    assert.isBelow(new TextEncoder().encode(T3_CODE_LOCAL_ORCHESTRATION_SECTION).length, 4000);
  });
});
