import type {
  ProjectReadFileResult,
  ProjectSearchContentsResult,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import {
  createAngelScriptNavigation,
  indexNavigationSource,
  qualifiedScope,
  type AngelScriptSource,
} from "@t3tools/shared/angelscriptNavigation";
import {
  cppBindingTargets,
  cppDefinitionQuery,
  cppIncludes,
  cppImplementationQuery,
  cppSymbolAt,
  findCppDefinition,
  isCppPath,
  type CppSymbol,
} from "@t3tools/shared/cppNavigation";

interface CppNavigationReader {
  read: (path: string) => Promise<ProjectReadFileResult | null>;
  search: (query: string) => Promise<ProjectSearchContentsResult | null>;
  findFiles: (name: string) => Promise<ProjectSearchEntriesResult | null>;
}
function relativeInclude(sourcePath: string, include: string) {
  const parts = sourcePath.split("/").slice(0, -1);
  for (const part of include.split("/")) {
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/** On-demand, bounded reads over the existing environment RPCs; never scan/download the whole tree. */
export async function resolveCppNavigation({
  source,
  offset,
  apiSymbol,
  read,
  search,
  findFiles,
}: CppNavigationReader & {
  source: AngelScriptSource;
  offset: number;
  apiSymbol?: CppSymbol;
}) {
  const sources: AngelScriptSource[] = isCppPath(source.path) ? [source] : [];
  const seen = new Set(sources.map((s) => s.path));
  let remainingBytes = 8_000_000;
  let remainingFiles = 24;
  async function load(paths: string[]) {
    const pending = [...new Set(paths)]
      .filter((p) => isCppPath(p) && !seen.has(p))
      .sort(
        (a, b) =>
          Number(/^(?:external|vendor|third_party|node_modules)\//.test(a)) -
          Number(/^(?:external|vendor|third_party|node_modules)\//.test(b)),
      )
      .slice(0, Math.min(8, remainingFiles));
    for (let n = 0; n < pending.length; n += 4) {
      if (remainingBytes <= 0) break;
      await Promise.all(
        pending.slice(n, n + 4).map(async (path) => {
          seen.add(path);
          remainingFiles--;
          const file = await read(path);
          if (
            file &&
            !file.truncated &&
            file.contents.length <= Math.min(remainingBytes, 2_000_000)
          ) {
            remainingBytes -= file.contents.length;
            sources.push({ path, contents: file.contents });
          }
        }),
      );
    }
  }
  async function searchFiles(query: string) {
    const result = await search(query);
    return [...new Set(result?.matches.filter((m) => isCppPath(m.path)).map((m) => m.path) ?? [])];
  }
  const clickedLine = source.contents.slice(0, offset).split("\n").length;
  const includeLine = source.contents.split("\n")[clickedLine - 1] ?? "";
  const include = /^\s*#\s*include\s*["<]([^">]+)[">]/.exec(includeLine);
  if (!apiSymbol && include) {
    const path = relativeInclude(source.path, include[1]!);
    if (path) await load([path]);
    if (path && sources.some((s) => s.path === path)) return { path, line: 1 };
    const result = await findFiles(include[1]!.split("/").at(-1)!);
    const matches =
      result?.entries.filter(
        (e) => e.kind === "file" && (e.path === include[1] || e.path.endsWith(`/${include[1]}`)),
      ) ?? [];
    return !result?.truncated && matches.length === 1 ? { path: matches[0]!.path, line: 1 } : null;
  }
  let symbol = apiSymbol ?? cppSymbolAt(source, offset);
  if (!symbol) return null;
  if (!apiSymbol) {
    const local = createAngelScriptNavigation(sources, true).resolve(source.path, offset);
    if (local) {
      const declaration = indexNavigationSource(source, true).declarations.find(
        (d) => d.token.text === symbol!.name && d.token.line === local.line,
      );
      if (
        declaration &&
        !symbol.declarationOnly &&
        (declaration.kind === "variable" ||
          declaration.kind === "type" ||
          declaration.definition) &&
        declaration.token.start !== offset
      )
        return local;
      if (declaration && !symbol.owner) {
        const owner = declaration.owner ?? qualifiedScope(declaration.scope);
        if (owner) symbol = { ...symbol, owner };
      }
    }
  }
  if (symbol.declarationOnly) {
    const counterpart = await resolveCppCounterpart(source.path, findFiles);
    if (counterpart) await load([counterpart.path]);
    const declaration = findCppDefinition(sources, symbol);
    if (declaration) return declaration;
  }
  const implementationQuery = symbol.declarationOnly ? null : cppImplementationQuery(symbol);
  if (implementationQuery) {
    await load(await searchFiles(implementationQuery));
    if (!apiSymbol) {
      const implementation = findCppDefinition(sources, {
        ...symbol,
        ...((symbol.owner ?? symbol.contextOwner)
          ? { owner: symbol.owner ?? symbol.contextOwner }
          : {}),
        implementationOnly: true,
      });
      if (implementation) return implementation;
    }
  }
  // Searching the owner first avoids fetching hundreds of files for common fields like "position".
  const paths = await searchFiles(
    cppDefinitionQuery(
      symbol.typeOnly ? symbol.name : (symbol.owner ?? symbol.contextOwner ?? symbol.name),
    ),
  );
  await load(paths);
  const includePaths: string[] = [];
  if (!apiSymbol && !symbol.owner) {
    const found = await Promise.all(
      cppIncludes(source)
        .slice(0, 8)
        .map(async (include) => {
          const result = await findFiles(include.split("/").at(-1)!);
          const relative = relativeInclude(source.path, include);
          const matches =
            result?.entries.filter(
              (e) => e.kind === "file" && (e.path === include || e.path.endsWith(`/${include}`)),
            ) ?? [];
          if (matches.some((e) => e.path === relative)) return relative;
          return !result?.truncated && matches.length === 1 ? matches[0]!.path : null;
        }),
    );
    includePaths.push(...found.filter((path): path is string => !!path));
    await load(includePaths);
    const refined = cppSymbolAt(source, offset, sources);
    if (refined) symbol = { ...symbol, ...refined };
  }
  if (!apiSymbol) symbol = { ...symbol, macroPaths: [source.path, ...includePaths] };
  // The CLion bridge maps Polyzonia's API into namespace Process. Prefer that
  // namespace over unrelated same-named types in third-party example sources.
  const findDirect = () => {
    if (apiSymbol) {
      // Generated methods may hide context parameters supplied by the binding (world/entity).
      // Keep exact overload matching first, then accept only a unique owner/name match.
      const { arity: _arity, ...withoutArity } = symbol;
      const inProcess = { ...symbol, owner: ["Process", symbol.owner].filter(Boolean).join("::") };
      return (
        findCppDefinition(sources, inProcess) ??
        (symbol.owner && symbol.arity !== undefined
          ? findCppDefinition(sources, { ...withoutArity, owner: inProcess.owner })
          : null) ??
        findCppDefinition(sources, symbol) ??
        (symbol.owner && symbol.arity !== undefined
          ? findCppDefinition(sources, withoutArity)
          : null)
      );
    }
    return (
      (symbol.contextOwner && !symbol.owner
        ? findCppDefinition(sources, { ...symbol, owner: symbol.contextOwner })
        : null) ??
      (!symbol.owner && symbol.namespace
        ? findCppDefinition(sources, { ...symbol, owner: symbol.namespace })
        : null) ??
      findCppDefinition(sources, symbol)
    );
  };
  let direct = findDirect();
  if (apiSymbol && direct) return direct;
  if (!apiSymbol && !direct) {
    await load(await searchFiles(cppDefinitionQuery(symbol.name)));
    direct = findDirect();
  }
  if (direct) return direct;
  if (!apiSymbol)
    return symbol.implementationOnly || symbol.declarationOnly
      ? null
      : createAngelScriptNavigation(sources, true).resolve(source.path, offset);
  // CLion's bridge resolves wrapper registrations in addition to direct struct members.
  const registrationQuery = symbol.owner
    ? `RegisterObjectMethod\\s*\\(\\s*"${symbol.owner.replaceAll("::", "_")}"`
    : `RegisterGlobalFunction`;
  await load(await searchFiles(registrationQuery));
  let targets = cppBindingTargets(sources, symbol);
  if (!targets.length && symbol.owner) {
    await load(await searchFiles(`"${symbol.owner.replaceAll("::", "_")}"`));
    targets = cppBindingTargets(sources, symbol);
  }
  if (targets.length !== 1) return null;
  const target = targets[0]!;
  await load(await searchFiles(cppDefinitionQuery(target.name)));
  return findCppDefinition(sources, target);
}

/** Match a source/header basename, preferring siblings and then the nearest project directory. */
export async function resolveCppCounterpart(
  path: string,
  findFiles: CppNavigationReader["findFiles"],
) {
  const match = /^(.*)\.([^./]+)$/.exec(path);
  if (!match || !isCppPath(path)) return null;
  const header = /^(?:h|hh|hpp|hxx)$/i.test(match[2]!);
  const extensions = header ? ["cpp", "cc", "cxx", "c"] : ["h", "hpp", "hh", "hxx"];
  const stem = match[1]!.split("/").at(-1)!;
  const directory = path.split("/").slice(0, -1);
  const results = await Promise.all(
    extensions.map(async (extension) => {
      const result = await findFiles(`${stem}.${extension}`);
      return result && !result.truncated
        ? result.entries.filter(
            (e) => e.kind === "file" && e.path.split("/").at(-1) === `${stem}.${extension}`,
          )
        : [];
    }),
  );
  const candidates = results
    .flatMap((entries, priority) =>
      entries.map((entry) => {
        const parts = entry.path.split("/").slice(0, -1);
        let shared = 0;
        while (
          shared < Math.min(parts.length, directory.length) &&
          parts[shared] === directory[shared]
        )
          shared++;
        return {
          path: entry.path,
          distance: parts.length + directory.length - 2 * shared,
          priority,
        };
      }),
    )
    .sort((a, b) => a.distance - b.distance || a.priority - b.priority);
  const first = candidates[0];
  if (
    !first ||
    (candidates[1]?.distance === first.distance && candidates[1]?.priority === first.priority)
  )
    return null;
  return { path: first.path, line: 1 };
}
