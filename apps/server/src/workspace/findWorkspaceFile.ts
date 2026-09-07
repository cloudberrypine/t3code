// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Find generated files without consulting gitignore or entering another checkout. */
export async function findWorkspaceFile(cwd: string, name: string, limit: number) {
  const entries: Array<{ path: string; kind: "file"; revision: string }> = [];
  const queue = [""];
  const started = performance.now();
  for (let index = 0; index < queue.length; index++) {
    if (index >= 20_000 || performance.now() - started > 5_000) return { entries, truncated: true };
    const relative = queue[index]!;
    const directory = NodePath.join(cwd, relative);
    const children = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (relative !== "" && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      },
    );
    if (relative && children.some((entry) => entry.name === ".git")) continue;
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const path = relative ? `${relative}/${child.name}` : child.name;
      if (child.isFile() && child.name === name) {
        const info = await NodeFSP.stat(NodePath.join(cwd, path));
        entries.push({
          path,
          kind: "file",
          revision: `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
        });
        if (entries.length > limit) return { entries: entries.slice(0, limit), truncated: true };
      } else if (child.isDirectory() && ![".git", "node_modules", ".t3"].includes(child.name)) {
        queue.push(path);
      }
    }
  }
  return { entries, truncated: false };
}
