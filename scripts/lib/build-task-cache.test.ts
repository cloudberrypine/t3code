import { afterEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("buildTaskCache", () => {
  it("keeps caching opt-in", async () => {
    vi.stubEnv("T3CODE_BUILD_CACHE", "0");
    const { buildTaskCache } = await import("./build-task-cache.ts");
    expect(buildTaskCache()).toBe(false);
  });

  it("fingerprints root configuration even with explicit task inputs", async () => {
    vi.stubEnv("T3CODE_BUILD_CACHE", "1");
    const { buildTaskCache } = await import("./build-task-cache.ts");
    for (const options of [{}, { input: [{ auto: true as const }, "!dist/**"] }]) {
      const cache = buildTaskCache(options);
      expect(cache).toMatchObject({
        env: expect.arrayContaining(["T3CODE_*", "VITE_*", "EXPO_PUBLIC_*"]),
        input: expect.arrayContaining([
          { base: "workspace", pattern: ".env" },
          { base: "workspace", pattern: ".env.local" },
          { base: "workspace", pattern: ".env.example" },
          { base: "workspace", pattern: "scripts/lib/public-config.ts" },
          { auto: true },
        ]),
      });
    }
    expect(buildTaskCache({ input: ["!dist/**"] })).toMatchObject({
      input: expect.arrayContaining(["!dist/**"]),
    });
  });
});
