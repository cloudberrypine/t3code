import {
  angelScriptLineSemantics,
  angelScriptColors,
  isAngelScriptPath,
  usesAngelScript,
  type AngelScriptApi,
  type AngelScriptSemanticToken,
} from "@t3tools/shared/angelscript";
import type { NativeReviewDiffData } from "./nativeReviewDiffAdapter";
import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";

export function prepareAngelScriptReview(
  data: NativeReviewDiffData,
  api: AngelScriptApi | null,
  scheme: "light" | "dark",
) {
  const semantics = new Map<string, AngelScriptSemanticToken[]>();
  if (!api) {
    const sources = new Map<string, string>();
    const candidates = new Set(
      data.files.filter((file) => isAngelScriptPath(file.path)).map((file) => file.id),
    );
    for (const row of data.rows) {
      if (!row.fileId || !candidates.has(row.fileId)) continue;
      const source = sources.get(row.fileId) ?? "";
      if (source.length < 16_000) sources.set(row.fileId, source + (row.content ?? "") + "\n");
    }
    const files = data.files.map((file) =>
      usesAngelScript(file.path, sources.get(file.id) ?? "", null)
        ? { ...file, language: "angelscript" as const }
        : file,
    );
    return {
      data: files.some((file, index) => file !== data.files[index]) ? { ...data, files } : data,
      semantics,
    };
  }
  const scriptIds = new Set(
    data.files.filter((file) => isAngelScriptPath(file.path)).map((file) => file.id),
  );
  for (const side of ["add", "delete"] as const) {
    let segment: NativeReviewDiffRow[] = [];
    let currentFile = "";
    let lastLine = -1;
    const flush = () => {
      if (!segment.length) return;
      const lines = angelScriptLineSemantics(
        segment.map((row) => row.content ?? "").join("\n"),
        api,
      );
      for (const [line, tokens] of lines) {
        const row = segment[line - 1];
        if (row) semantics.set(row.id, tokens);
      }
      segment = [];
    };
    for (const row of data.rows) {
      if (row.kind !== "line" || !scriptIds.has(row.fileId ?? "")) {
        flush();
        continue;
      }
      if (row.change === (side === "add" ? "delete" : "add")) continue;
      const line = (side === "add" ? row.newLineNumber : row.oldLineNumber) ?? -1;
      if (currentFile !== row.fileId || line !== lastLine + 1) flush();
      currentFile = row.fileId ?? "";
      lastLine = line;
      segment.push(row);
    }
    flush();
  }
  return {
    semantics,
    data: {
      ...data,
      files: data.files.map((file) =>
        scriptIds.has(file.id) ? { ...file, language: "angelscript" as const } : file,
      ),
      rows: data.rows.map((row) =>
        semantics.get(row.id)?.some((token) => token.kind === "await")
          ? { ...row, awaitBackground: angelScriptColors[scheme].background }
          : row,
      ),
    },
  };
}
