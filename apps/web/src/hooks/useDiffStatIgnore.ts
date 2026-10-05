import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { useWorkspaceMutationRefresh } from "./useWorkspaceMutationRefresh";

/** Share one workspace-file query across the chat summaries and the diff panel. */
export function useDiffStatIgnore(
  environmentId: EnvironmentId | undefined,
  cwd: string | null,
  mutationId: string | null,
) {
  const query = useEnvironmentQuery(
    environmentId && cwd
      ? projectEnvironment.readFile({
          environmentId,
          input: { cwd, relativePath: ".t3diffignore" },
        })
      : null,
  );
  const refresh = query.refresh;
  useEffect(() => {
    if (!environmentId || !cwd) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [environmentId, cwd, refresh]);
  useWorkspaceMutationRefresh({
    enabled: Boolean(environmentId && cwd),
    mutationId,
    resourceKey: `diff-stat-ignore:${environmentId}:${cwd}`,
    refresh,
  });
  return {
    // A removed or unreadable file must not leave stale rules applied.
    patterns:
      query.error === null && query.data && !query.data.truncated ? query.data.contents : undefined,
    refresh,
  };
}
