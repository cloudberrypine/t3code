import { useMemo, useEffect, useSyncExternalStore } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { createApiStore, type ScriptingApiReader } from "@t3tools/client-runtime/angelscript";
import { projectEnvironment } from "~/state/projects";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export interface AngelScriptWorkspace {
  environmentId: EnvironmentId;
  cwd: string;
  revision?: unknown;
}

export function useAngelScript(workspace?: AngelScriptWorkspace) {
  const discover = useAtomQueryRunner(projectEnvironment.searchEntries, {
    refresh: true,
    reportFailure: false,
  });
  const read = useAtomQueryRunner(projectEnvironment.readFile, {
    refresh: true,
    reportFailure: false,
  });
  const environmentId = workspace?.environmentId;
  const cwd = workspace?.cwd;
  const reader = useMemo(
    () => ({
      discover: async () => {
        if (!environmentId || !cwd) return null;
        const result = await discover({
          environmentId,
          input: {
            cwd,
            query: "ScriptingAPI.as",
            exactFileName: "ScriptingAPI.as",
            kind: "file",
            limit: 2,
          },
        });
        return result._tag === "Success" ? result.value : null;
      },
      read: async (relativePath: string) => {
        if (!environmentId || !cwd) return null;
        const result = await read({ environmentId, input: { cwd, relativePath } });
        return result._tag === "Success" ? result.value : null;
      },
    }),
    [cwd, environmentId, discover, read],
  );
  return useScriptingApi(
    environmentId && cwd ? JSON.stringify([environmentId, cwd]) : null,
    reader,
    workspace?.revision,
  );
}

const stores = new Map<string, ReturnType<typeof createApiStore>>();
function useScriptingApi(key: string | null, reader: ScriptingApiReader, refreshToken?: unknown) {
  const store = useMemo(() => {
    if (key === null) return createApiStore();
    let existing = stores.get(key);
    if (!existing) {
      existing = createApiStore();
      stores.set(key, existing);
      if (stores.size > 32) stores.delete(stores.keys().next().value!);
    }
    return existing;
  }, [key]);
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  useEffect(() => {
    if (key === null) return;
    const refresh = () => {
      if (document.visibilityState !== "hidden") void store.refresh(reader);
    };
    refresh();
    const interval = setInterval(refresh, 10_000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [key, reader, refreshToken, store]);
  return key === null ? null : snapshot;
}
