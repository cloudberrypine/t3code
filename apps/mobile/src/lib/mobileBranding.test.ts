import { describe, expect, it } from "vite-plus/test";
import { resolveMobileStageLabel } from "./mobileBranding";

describe("PolyCode mobile stage labels", () => {
  it("omits a stage for normal builds and keeps Dev and Nightly", () => {
    expect(resolveMobileStageLabel("production")).toBeNull();
    expect(resolveMobileStageLabel(undefined)).toBeNull();
    expect(resolveMobileStageLabel("development")).toBe("Dev");
    expect(resolveMobileStageLabel("preview")).toBe("Nightly");
  });
});
