import type { FileContents, FileDiffMetadata } from "@pierre/diffs";
import {
  analyzeAngelScript,
  angelScriptColors,
  isAngelScriptPath,
  type AngelScriptApi,
  type AngelScriptSemanticToken,
} from "@t3tools/shared/angelscript";
import { textRange } from "~/components/diffs/diffSearch";

export const ANGELSCRIPT_CSS = `
[data-code] [data-line][data-angelscript-await] {
  background-color: light-dark(${angelScriptColors.light.background}, ${angelScriptColors.dark.background}) !important;
}
::highlight(as-type) { color: light-dark(#156b78, #7dcbd4); }
::highlight(as-constant) { color: light-dark(#915324, #e9af78); }
::highlight(as-global) { color: light-dark(#925188, #d8a3d2); }
::highlight(as-function) { color: light-dark(#7551ad, #c6a5ed); }
::highlight(as-await) { color: light-dark(#805900, #edc65e); }
`;

type LineTokens = Map<number, AngelScriptSemanticToken[]>;
const kinds = ["type", "constant", "global", "function", "await"] as const;

export function angelScriptCacheKey(key: string): string {
  return key.startsWith("angelscript:") ? key : `angelscript:${key}`;
}

/** Pierre's worker cache is keyed by cacheKey, independently of the language override. */
export function withAngelScriptLanguage<T extends FileContents | FileDiffMetadata>(file: T): T {
  return {
    ...file,
    lang: "angelscript",
    ...(file.cacheKey ? { cacheKey: angelScriptCacheKey(file.cacheKey) } : {}),
  };
}

function analyzeLines(contents: string, api: AngelScriptApi): LineTokens {
  const lines: LineTokens = new Map();
  // The syntax renderer has its own large-file safeguards. Semantic inference is bounded too.
  if (contents.length > 2_000_000) return lines;
  const offsets = [0];
  for (let i = 0; i < contents.length; i++) if (contents[i] === "\n") offsets.push(i + 1);
  for (const token of analyzeAngelScript(contents, api)) {
    const line = lines.get(token.line) ?? [];
    line.push({
      ...token,
      start: token.start - offsets[token.line - 1]!,
      end: token.end - offsets[token.line - 1]!,
    });
    lines.set(token.line, line);
  }
  return lines;
}

export function createAngelScriptPainter(api: AngelScriptApi | null) {
  const cache = new WeakMap<
    object,
    { source: unknown; partial?: boolean; additions: LineTokens; deletions: LineTokens }
  >();
  const painted = new Map<HTMLElement, Array<{ kind: string; range: Range }>>();
  function clear(node: HTMLElement) {
    for (const { kind, range } of painted.get(node) ?? [])
      CSS.highlights?.get(`as-${kind}`)?.delete(range);
    painted.delete(node);
  }
  function paint(node: HTMLElement, file?: FileContents | FileDiffMetadata, phase?: string) {
    if (typeof CSS === "undefined" || !CSS.highlights) return;
    clear(node);
    if (phase === "unmount") return;
    const root = node.shadowRoot ?? node;
    for (const row of root.querySelectorAll("[data-angelscript-await]"))
      row.removeAttribute("data-angelscript-await");
    if (!api || !file || !isAngelScriptPath(file.name)) return;
    const diff = "hunks" in file ? file : null;
    const source = diff ? diff.additionLines : (file as FileContents).contents;
    let entry = cache.get(file);
    if (!entry || entry.source !== source || entry.partial !== diff?.isPartial) {
      const additions = new Map<number, AngelScriptSemanticToken[]>();
      const deletions = new Map<number, AngelScriptSemanticToken[]>();
      if (!diff) {
        for (const [line, tokens] of analyzeLines((file as FileContents).contents, api))
          additions.set(line, tokens);
      } else {
        for (const side of ["addition", "deletion"] as const) {
          const target = side === "addition" ? additions : deletions;
          const content = diff[`${side}Lines`];
          if (!diff.isPartial) {
            for (const [line, tokens] of analyzeLines(content.join(""), api))
              target.set(line, tokens);
          } else {
            // Each hunk starts an independent lexical context; omitted code is never concatenated.
            for (const hunk of diff.hunks) {
              const start = hunk[`${side}LineIndex`];
              const count = hunk[`${side}Count`];
              for (const [line, tokens] of analyzeLines(
                content.slice(start, start + count).join(""),
                api,
              )) {
                target.set(hunk[`${side}Start`] + line - 1, tokens);
              }
            }
          }
        }
      }
      entry = { source, ...(diff ? { partial: diff.isPartial } : {}), additions, deletions };
      cache.set(file, entry);
    }
    const ranges: Array<{ kind: string; range: Range }> = [];
    for (const row of root.querySelectorAll<HTMLElement>("[data-code] [data-line]")) {
      const deletion =
        row.closest("[data-deletions]") !== null || row.dataset.lineType === "change-deletion";
      const lines = deletion ? entry.deletions : entry.additions;
      for (const token of lines.get(Number(row.dataset.line)) ?? []) {
        if (token.kind === "await") row.setAttribute("data-angelscript-await", "");
        const range = textRange(row, token.start, token.end);
        if (!range) continue;
        const name = `as-${token.kind}`;
        let highlight = CSS.highlights.get(name);
        if (!highlight) {
          highlight = new Highlight();
          CSS.highlights.set(name, highlight);
        }
        highlight.add(range);
        ranges.push({ kind: token.kind, range });
      }
    }
    painted.set(node, ranges);
  }
  return {
    paint,
    dispose() {
      if (typeof CSS === "undefined" || !CSS.highlights) return;
      for (const node of painted.keys()) clear(node);
      for (const kind of kinds) {
        const highlight = CSS.highlights?.get(`as-${kind}`);
        if (highlight?.size === 0) CSS.highlights.delete(`as-${kind}`);
      }
    },
  };
}
