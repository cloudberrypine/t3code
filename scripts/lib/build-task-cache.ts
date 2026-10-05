// Local fork: opt-in `vp run` caching for the web and server builds, enabled with T3CODE_BUILD_CACHE=1
// (see docs/local-fork.md). Upstream leaves these tasks uncached, which stays the default.
//
// A cached task runs with only the environment it fingerprints, so this lists every variable
// the web and server builds read. The build version and embedded commit are written
// by scripts/build-desktop-artifact.ts after these tasks, so they never come from the cache.
export const buildTaskCacheEnabled = process.env.T3CODE_BUILD_CACHE === "1";

export function buildTaskCache(options: { readonly input?: Array<string | { auto: true }> } = {}) {
  return buildTaskCacheEnabled
    ? { env: ["APP_VERSION", "NODE_ENV", "T3CODE_*", "VERCEL_*", "VITE_*"], ...options }
    : false;
}
