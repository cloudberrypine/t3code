// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { findWorkspaceFile } from "./findWorkspaceFile.ts";
import { listWorkspaceFiles } from "./listWorkspaceFiles.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
it("finds ignored API files without entering nested worktrees or directory symlinks", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-as-"));
  roots.push(root);
  await NodeFSP.mkdir(NodePath.join(root, "generated"));
  await NodeFSP.writeFile(NodePath.join(root, ".gitignore"), "generated/\n");
  await NodeFSP.writeFile(NodePath.join(root, "generated/ScriptingAPI.as"), "class Shot {}");
  await NodeFSP.mkdir(NodePath.join(root, "other"));
  await NodeFSP.writeFile(NodePath.join(root, "other/.git"), "gitdir: elsewhere");
  await NodeFSP.writeFile(NodePath.join(root, "other/ScriptingAPI.as"), "class Wrong {}");
  await NodeFSP.symlink(NodePath.join(root, "generated"), NodePath.join(root, "linked"));
  const found = await findWorkspaceFile(root, "ScriptingAPI.as", 2);
  expect(found.entries.map((entry) => entry.path)).toEqual(["generated/ScriptingAPI.as"]);
  const previous = found.entries[0]!.revision;
  await NodeFSP.writeFile(NodePath.join(root, "generated/ScriptingAPI.as"), "class UpdatedShot {}");
  expect((await findWorkspaceFile(root, "ScriptingAPI.as", 2)).entries[0]!.revision).not.toBe(
    previous,
  );
  const listing = await listWorkspaceFiles(root);
  expect(listing.entries.some((entry) => entry.path === "generated/ScriptingAPI.as")).toBe(true);
  expect(listing.entries.some((entry) => entry.path === "other/ScriptingAPI.as")).toBe(false);
});
