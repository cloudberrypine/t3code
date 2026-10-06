import type {
  AngelScriptDefinition,
  AngelScriptSource,
} from "@t3tools/shared/angelscriptNavigation";
import { usesAngelScript, type AngelScriptApi } from "@t3tools/shared/angelscript";
import { angelScriptCppSymbol, isCppPath } from "@t3tools/shared/cppNavigation";

import { resolveAngelScriptDefinitions } from "./angelscript.ts";
import { resolveCppDefinitions } from "./cppNavigation.ts";

export type { AngelScriptDefinition as Definition } from "@t3tools/shared/angelscriptNavigation";

/** The environment reads definition lookups need; each returns null when the request fails. */
export interface DefinitionReader {
  read: Parameters<typeof resolveCppDefinitions>[0]["read"];
  search: Parameters<typeof resolveCppDefinitions>[0]["search"];
  findFiles: Parameters<typeof resolveCppDefinitions>[0]["findFiles"];
}

/** Whether a file's symbols can be followed: C/C++ always, AngelScript once recognized. */
export function supportsDefinitionNavigation(
  source: AngelScriptSource,
  api: AngelScriptApi | null,
) {
  return isCppPath(source.path) || usesAngelScript(source.path, source.contents, api);
}

/**
 * Every client resolves definitions the same way: C/C++ sources and AngelScript calls into the
 * native API go through the C++ resolver first, the rest through AngelScript's. An empty result
 * means nothing was found; more than one means equal-ranked overloads the user can choose from.
 */
export async function resolveDefinitions({
  source,
  offset,
  api,
  ...reader
}: DefinitionReader & {
  source: AngelScriptSource;
  offset: number;
  api: AngelScriptApi | null;
}): Promise<AngelScriptDefinition[]> {
  const angelScript = usesAngelScript(source.path, source.contents, api);
  const apiSymbol = angelScript ? angelScriptCppSymbol(source, offset) : null;
  if (isCppPath(source.path) || apiSymbol) {
    const definitions = await resolveCppDefinitions({
      source,
      offset,
      ...(apiSymbol ? { apiSymbol } : {}),
      ...reader,
    });
    if (definitions.length || !angelScript) return definitions;
  }
  return resolveAngelScriptDefinitions({ source, api, offset, read: reader.read });
}
