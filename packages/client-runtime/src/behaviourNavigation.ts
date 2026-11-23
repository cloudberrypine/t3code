import {
  behaviourIncludes,
  joinBehaviourPath,
  rankBehaviourDefinitions,
  resolveBehaviourDefinitions,
} from "@t3tools/shared/behaviour";
import type {
  AngelScriptDefinition,
  AngelScriptSource,
} from "@t3tools/shared/angelscriptNavigation";

import type { ScriptingApiReader } from "./angelscript.ts";

/**
 * Polyzonia: go to definition in the prototype's behaviour language (`.beh`, `.pzb`). The files
 * it includes (`#include "../engine.beh"`, and theirs) are read unless the clicked unit defines
 * the name itself, within a small request and size budget.
 */
export async function resolveBehaviourNavigation({
  source,
  offset,
  read,
}: {
  source: AngelScriptSource;
  offset: number;
  read: ScriptingApiReader["read"];
}): Promise<AngelScriptDefinition[]> {
  const files = [source];
  // Only the clicked unit's own name settles it here: a file-level binding in an included file
  // outranks another unit's name in this one.
  const local = rankBehaviourDefinitions(files, offset);
  if (local.rank === 0) return local.definitions;
  const visited = new Set([source.path]);
  let pending = behaviourIncludes(source.contents).map((path) =>
    joinBehaviourPath(source.path, path),
  );
  let bytes = source.contents.length;
  while (pending.length) {
    const batch = [...new Set(pending)].filter((path) => !visited.has(path));
    if (!batch.length) break;
    if (visited.size + batch.length > 32) break;
    for (const path of batch) visited.add(path);
    const read_ = await Promise.all(
      batch.map(async (path) => {
        const file = await read(path);
        return file && !file.truncated ? { path, contents: file.contents } : null;
      }),
    );
    pending = [];
    for (const file of read_) {
      if (!file) continue;
      bytes += file.contents.length;
      if (bytes > 4_000_000) return resolveBehaviourDefinitions(files, offset);
      files.push(file);
      pending.push(
        ...behaviourIncludes(file.contents).map((path) => joinBehaviourPath(file.path, path)),
      );
    }
  }
  return resolveBehaviourDefinitions(files, offset);
}
