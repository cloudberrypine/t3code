// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { ProjectEntry } from "@t3tools/contracts";

/** Breadth-first listing keeps shallow generated files visible even in very large trees. */
export async function listWorkspaceFiles(cwd: string, limit = 25_000) {
  const entries: ProjectEntry[] = [];
  const queue = [""];
  const started = performance.now();
  for (let index = 0; index < queue.length; index++) {
    if (performance.now() - started > 5_000) return { entries, truncated: true };
    const relative = queue[index]!;
    const children = await NodeFSP.readdir(NodePath.join(cwd, relative), {
      withFileTypes: true,
    }).catch((error: unknown) => {
      if (relative && ["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
        return [];
      throw error;
    });
    if (relative && children.some((entry) => entry.name === ".git")) continue;
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (child.name === ".git") continue;
      if (!child.isDirectory() && !child.isFile()) continue;
      if (entries.length >= limit) return { entries, truncated: true };
      const path = relative ? `${relative}/${child.name}` : child.name;
      entries.push({ path, kind: child.isDirectory() ? "directory" : "file" });
      if (child.isDirectory()) queue.push(path);
    }
  }
  return { entries, truncated: false };
}
