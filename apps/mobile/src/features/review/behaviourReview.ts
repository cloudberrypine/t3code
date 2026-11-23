import {
  behaviourColors,
  behaviourLineSemantics,
  colorBehaviourTokens,
  isBehaviourPath,
  type BehaviourLineKind,
  type BehaviourSemanticToken,
  type createBehaviourRevisionSemantics,
} from "@t3tools/shared/behaviour";
import { BEHAVIOUR_HIGHLIGHT_LANGUAGE } from "./desktopCodeLanguages";
import type { NativeReviewDiffData } from "./nativeReviewDiffAdapter";
import type { NativeReviewDiffRow, NativeReviewDiffToken } from "../diffs/nativeReviewDiffSurface";

/** Polyzonia's behaviour language (`.beh`, `.pzb`) in review diffs, beside AngelScript's. */
export type BehaviourRevision = ReturnType<typeof createBehaviourRevisionSemantics>;

const EMPTY_SEMANTICS: ReadonlyMap<string, readonly BehaviourSemanticToken[]> = new Map();

/**
 * Colours every behaviour row and gives its waiting rows the wait background. A file with its
 * complete revisions reads each row in place, so a hunk inside an `await any` block still waits;
 * other rows are read run by run, each run of consecutive lines as its own fragment.
 */
export function prepareBehaviourReview(
  data: NativeReviewDiffData,
  scheme: "light" | "dark",
  revisions?: ReadonlyMap<string, BehaviourRevision>,
): {
  data: NativeReviewDiffData;
  semantics: ReadonlyMap<string, readonly BehaviourSemanticToken[]>;
} {
  const behaviourIds = new Set(
    data.files.filter((file) => isBehaviourPath(file.path)).map((file) => file.id),
  );
  if (behaviourIds.size === 0) return { data, semantics: EMPTY_SEMANTICS };
  const paths = new Map(data.files.map((file) => [file.id, file.path]));
  const semantics = new Map<string, BehaviourSemanticToken[]>();
  const waits = new Set<string>();
  const record = (
    row: NativeReviewDiffRow,
    tokens: BehaviourSemanticToken[],
    lineKind: BehaviourLineKind | null,
  ) => {
    // A context row is read on both sides; the new side's reading stands.
    if (!semantics.has(row.id)) semantics.set(row.id, tokens);
    if (lineKind === "wait") waits.add(row.id);
  };
  for (const side of ["add", "delete"] as const) {
    let segment: NativeReviewDiffRow[] = [];
    let currentFile = "";
    let lastLine = -1;
    const flush = () => {
      if (!segment.length) return;
      const lines = behaviourLineSemantics(segment.map((row) => row.content ?? "").join("\n"));
      segment.forEach((row, index) =>
        record(row, lines.tokens.get(index + 1) ?? [], lines.lines.get(index + 1) ?? null),
      );
      segment = [];
    };
    for (const row of data.rows) {
      if (row.kind !== "line" || !behaviourIds.has(row.fileId ?? "")) {
        flush();
        continue;
      }
      if (row.change === (side === "add" ? "delete" : "add")) continue;
      const line = (side === "add" ? row.newLineNumber : row.oldLineNumber) ?? -1;
      const revision = revisions?.get(paths.get(row.fileId ?? "") ?? "");
      const read = revision?.(side === "add" ? "additions" : "deletions", line, row.content ?? "");
      if (read) {
        flush();
        record(row, read.tokens, read.lineKind);
        continue;
      }
      if (currentFile !== row.fileId || line !== lastLine + 1) flush();
      currentFile = row.fileId ?? "";
      lastLine = line;
      segment.push(row);
    }
    flush();
  }
  const waitBackground = behaviourColors[scheme].waitBackground;
  return {
    semantics,
    data: {
      ...data,
      files: data.files.map((file) =>
        behaviourIds.has(file.id) ? { ...file, language: BEHAVIOUR_HIGHLIGHT_LANGUAGE } : file,
      ),
      rows: data.rows.map((row) =>
        waits.has(row.id) ? { ...row, awaitBackground: waitBackground } : row,
      ),
    },
  };
}

/** A highlighted diff row's tokens with its behaviour colours, or null when it is not a behaviour row. */
export function colorBehaviourReviewRow(
  rowId: string,
  tokens: ReadonlyArray<NativeReviewDiffToken>,
  semantics: ReadonlyMap<string, readonly BehaviourSemanticToken[]> | undefined,
  scheme: "light" | "dark",
): NativeReviewDiffToken[] | null {
  const rowSemantics = semantics?.get(rowId);
  return rowSemantics ? colorBehaviourTokens(tokens, rowSemantics, scheme) : null;
}
