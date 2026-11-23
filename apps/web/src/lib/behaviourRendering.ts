// Polyzonia: the prototype's behaviour language (`.beh`, `.pzb`) in file previews and diffs, as
// plain text with every token painted over it by CSS custom highlights. A row that waits gets
// `data-beh-line="wait"`: a gutter stripe beside the amber wait word.
import type { FileContents, FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import {
  BEHAVIOUR_TOKEN_KINDS,
  behaviourColors,
  behaviourLineSemantics,
  createBehaviourRevisionSemantics,
  isBehaviourPath,
  type BehaviourLineKind,
  type BehaviourSemanticToken,
} from "@t3tools/shared/behaviour";
import { textRange } from "~/components/diffs/diffSearch";

const { light, dark } = behaviourColors;
const pair = (key: keyof typeof light) => `light-dark(${light[key]}, ${dark[key]})`;

export const BEHAVIOUR_CSS = `
[data-code] [data-line][data-beh-line="wait"] {
  box-shadow: inset 3px 0 0 ${pair("waitStripe")};
}
${BEHAVIOUR_TOKEN_KINDS.map((kind) => `::highlight(beh-${kind}) { color: ${pair(kind)}; }`).join("\n")}
`;

interface LineSemantics {
  tokens: BehaviourSemanticToken[];
  lineKind: BehaviourLineKind | null;
}
type Lines = Map<number, LineSemantics>;

function linesOf(source: string): Lines {
  const semantics = behaviourLineSemantics(source);
  const lines: Lines = new Map();
  for (const [line, tokens] of semantics.tokens) lines.set(line, { tokens, lineKind: null });
  for (const [line, lineKind] of semantics.lines) {
    const entry = lines.get(line);
    if (entry) entry.lineKind = lineKind;
    else lines.set(line, { tokens: [], lineKind });
  }
  return lines;
}

const ROW_SELECTOR = "[data-code] [data-line]";

export function createBehaviourPainter(loadFiles?: FileDiffContentsLoader) {
  let generation = 0;
  const mounted = new Map<HTMLElement, FileContents | FileDiffMetadata>();
  let loading = new WeakSet<FileDiffMetadata>();
  const revisions = new WeakMap<
    FileDiffMetadata,
    ReturnType<typeof createBehaviourRevisionSemantics>
  >();
  const cache = new WeakMap<
    object,
    {
      source: unknown;
      deletionSource?: unknown;
      partial?: boolean;
      hasRevision?: boolean;
      additions: Lines;
      deletions: Lines;
    }
  >();
  const painted = new Map<HTMLElement, Array<{ kind: string; range: Range }>>();

  function clear(node: HTMLElement) {
    for (const { kind, range } of painted.get(node) ?? [])
      CSS.highlights?.get(`beh-${kind}`)?.delete(range);
    painted.delete(node);
  }

  function analyze(file: FileContents | FileDiffMetadata) {
    const diff = "hunks" in file ? file : null;
    const revision = diff ? revisions.get(diff) : undefined;
    const source = diff ? diff.additionLines : (file as FileContents).contents;
    const cached = cache.get(file);
    if (
      cached &&
      cached.source === source &&
      cached.deletionSource === diff?.deletionLines &&
      cached.partial === diff?.isPartial &&
      cached.hasRevision === (revision !== undefined)
    )
      return cached;
    const additions: Lines = new Map();
    const deletions: Lines = new Map();
    if (!diff) {
      for (const [line, entry] of linesOf((file as FileContents).contents))
        additions.set(line, entry);
    } else {
      for (const side of ["addition", "deletion"] as const) {
        const target = side === "addition" ? additions : deletions;
        const content = diff[`${side}Lines`];
        if (!diff.isPartial) {
          for (const [line, entry] of linesOf(content.join(""))) target.set(line, entry);
          continue;
        }
        // Each hunk is read on its own; omitted code is never concatenated. With the full
        // revisions loaded, a row whose text matches takes the whole file's reading (a condition
        // inside an `await any` block is a wait even when the hunk starts below `await any`).
        for (const hunk of diff.hunks) {
          const start = hunk[`${side}LineIndex`];
          const count = hunk[`${side}Count`];
          const local = linesOf(content.slice(start, start + count).join(""));
          for (let i = 0; i < count; i++) {
            const line = hunk[`${side}Start`] + i;
            const full = revision?.(
              side === "addition" ? "additions" : "deletions",
              line,
              content[start + i] ?? "",
            );
            const entry = full ?? local.get(i + 1);
            if (entry) target.set(line, entry);
          }
        }
      }
    }
    const entry = {
      source,
      ...(diff ? { partial: diff.isPartial, deletionSource: diff.deletionLines } : {}),
      hasRevision: revision !== undefined,
      additions,
      deletions,
    };
    cache.set(file, entry);
    return entry;
  }

  function loadRevisions(diff: FileDiffMetadata) {
    if (!loadFiles || loading.has(diff)) return;
    loading.add(diff);
    const requestGeneration = generation;
    void loadFiles(diff)
      .then((files) => {
        if (requestGeneration !== generation) return;
        revisions.set(
          diff,
          createBehaviourRevisionSemantics({
            oldContents: files.oldFile?.contents ?? "",
            newContents: files.newFile?.contents ?? "",
          }),
        );
        for (const [target, current] of mounted) if (current === diff) paint(target, current);
      })
      .catch(() => {
        /* Keep the hunk-by-hunk reading if the revisions cannot be read. */
      });
  }

  function paint(node: HTMLElement, file?: FileContents | FileDiffMetadata, phase?: string) {
    if (typeof CSS === "undefined" || !CSS.highlights) return;
    clear(node);
    const root = node.shadowRoot ?? node;
    for (const row of root.querySelectorAll("[data-beh-line]"))
      row.removeAttribute("data-beh-line");
    if (phase === "unmount" || !file || !isBehaviourPath(file.name)) {
      mounted.delete(node);
      return;
    }
    mounted.set(node, file);
    const diff = "hunks" in file ? file : null;
    if (diff?.isPartial && root.querySelector(ROW_SELECTOR)) loadRevisions(diff);
    const entry = analyze(file);
    const ranges: Array<{ kind: string; range: Range }> = [];
    for (const row of root.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      const deletion =
        row.closest("[data-deletions]") !== null || row.dataset.lineType === "change-deletion";
      const line = (deletion ? entry.deletions : entry.additions).get(Number(row.dataset.line));
      if (!line) continue;
      if (line.lineKind) row.setAttribute("data-beh-line", line.lineKind);
      for (const token of line.tokens) {
        const range = textRange(row, token.start, token.end);
        if (!range) continue;
        const name = `beh-${token.kind}`;
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
      // Effect cleanup can be replayed by React StrictMode before this painter is reused.
      generation++;
      loading = new WeakSet();
      mounted.clear();
      if (typeof CSS === "undefined" || !CSS.highlights) return;
      for (const node of painted.keys()) clear(node);
      for (const kind of BEHAVIOUR_TOKEN_KINDS) {
        const highlight = CSS.highlights.get(`beh-${kind}`);
        if (highlight?.size === 0) CSS.highlights.delete(`beh-${kind}`);
      }
    },
  };
}
