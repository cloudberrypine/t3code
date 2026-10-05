import {
  angelScriptStateTree,
  parseAngelScriptApi,
  type AngelScriptApi,
} from "@t3tools/shared/angelscript";
import type { ProjectSearchEntriesResult, ProjectReadFileResult } from "@t3tools/contracts";
import {
  angelScriptNavigationFile,
  angelScriptNavigationDependencies,
  createAngelScriptNavigation,
  type AngelScriptSource,
} from "@t3tools/shared/angelscriptNavigation";

export interface ScriptingApiReader {
  discover: () => Promise<ProjectSearchEntriesResult | null>;
  read: (path: string) => Promise<ProjectReadFileResult | null>;
}

/** Reads use the caller's environment; no local-machine paths or language server are required. */
export async function resolveAngelScriptNavigation({
  source,
  api,
  offset,
  read,
}: {
  source: AngelScriptSource;
  api: AngelScriptApi | null;
  offset: number;
  read: ScriptingApiReader["read"];
}) {
  const sources = [source];
  if (api?.source && api.source.path !== source.path) sources.push(api.source);
  const local = createAngelScriptNavigation(sources).resolve(source.path, offset);
  if (local) return local;
  const path = angelScriptNavigationFile(source, offset);
  const lineStart = source.contents.lastIndexOf("\n", offset - 1) + 1;
  const include =
    /^\s*#\s*include\b/.test(source.contents.slice(lineStart)) ||
    angelScriptStateTree(source.contents).some(
      (entry) =>
        entry.fileStart !== undefined &&
        entry.fileStart <= offset &&
        offset < entry.fileStart + entry.file!.length,
    );
  const paths = include
    ? path
      ? [path]
      : []
    : [...new Set([...(path ? [path] : []), ...angelScriptNavigationDependencies(source)])];
  const visited = new Set(sources.map((entry) => entry.path));
  let pending = paths;
  let bytes = source.contents.length;
  // Includes are textual and may form cycles. Follow their closure only on an
  // unresolved click, with a request/size budget for remote environments.
  while (pending.length) {
    const batch = [...new Set(pending)].filter((candidate) => !visited.has(candidate));
    if (!batch.length) break;
    if (visited.size + batch.length > 64) return null;
    for (const candidate of batch) visited.add(candidate);
    const files = await Promise.all(
      batch.map(async (candidate) => {
        const file = await read(candidate);
        return file && !file.truncated ? { path: candidate, contents: file.contents } : null;
      }),
    );
    pending = [];
    for (const file of files) {
      if (!file) continue;
      bytes += file.contents.length;
      if (bytes > 8_000_000) return null;
      sources.push(file);
      if (!include) pending.push(...angelScriptNavigationDependencies(file, true));
    }
  }
  if (include) return path && sources.some((file) => file.path === path) ? { path, line: 1 } : null;
  const definition = createAngelScriptNavigation(sources).resolve(source.path, offset);
  return definition;
}

export function createApiStore() {
  let snapshot: AngelScriptApi | null = null;
  let revision: string | undefined;
  let inFlight: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh(reader: ScriptingApiReader) {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        const found = await reader.discover();
        if (!found) return;
        // Multiple APIs are ambiguous: never silently borrow symbols from another subtree.
        const matches = found.entries.filter((entry) =>
          /(?:^|\/)ScriptingAPI\.as$/.test(entry.path),
        );
        const entry = !found.truncated && matches.length === 1 ? matches[0] : undefined;
        const nextRevision = entry ? `${entry.path}:${entry.revision}` : undefined;
        if (!entry && revision === undefined) return;
        if (entry?.revision !== undefined && nextRevision === revision) return;
        const file = entry ? await reader.read(entry.path) : null;
        if (entry && !file) return;
        // Keep the AngelScript language association after an API disappears, but drop its symbols.
        snapshot =
          file || snapshot
            ? parseAngelScriptApi(file && !file.truncated ? file.contents : "")
            : null;
        if (snapshot && entry && file && !file.truncated) {
          snapshot.source = { path: entry.path, contents: file.contents };
        }
        revision = nextRevision;
        for (const listener of listeners) listener();
      })()
        .catch(() => undefined)
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}
