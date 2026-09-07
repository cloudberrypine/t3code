import { parseAngelScriptApi, type AngelScriptApi } from "@t3tools/shared/angelscript";
import type { ProjectSearchEntriesResult, ProjectReadFileResult } from "@t3tools/contracts";

export interface ScriptingApiReader {
  discover: () => Promise<ProjectSearchEntriesResult | null>;
  read: (path: string) => Promise<ProjectReadFileResult | null>;
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
