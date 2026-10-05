import type { FileContents, FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import { tokenizeAngelScript } from "@t3tools/shared/angelscript";
import { createAngelScriptClickNavigation, type NavigationSource } from "./angelScriptNavigation";

/** Whitespace-hidden patches may borrow context from the other side of the diff. */
export function diffDefinitionOffset(
  fragment: string,
  offset: number,
  firstLine: number,
  full: string,
): number | null {
  const before = fragment.slice(0, offset);
  const line = firstLine + before.split("\n").length - 1;
  const column = offset - (before.lastIndexOf("\n") + 1);
  const fragmentStart = offset - column;
  const fragmentEnd = fragment.indexOf("\n", fragmentStart);
  const displayed = fragment.slice(fragmentStart, fragmentEnd < 0 ? undefined : fragmentEnd);
  let start = 0;
  for (let current = 1; current < line; current++) {
    const end = full.indexOf("\n", start);
    if (end < 0) return null;
    start = end + 1;
  }
  const end = full.indexOf("\n", start);
  const actual = full.slice(start, end < 0 ? undefined : end);
  if (displayed === actual) return start + column;
  // Compare tokens, not stripped strings: whitespace inside a string remains significant.
  const displayedTokens = tokenizeAngelScript(displayed, true);
  const actualTokens = tokenizeAngelScript(actual, true);
  if (
    displayedTokens.length !== actualTokens.length ||
    displayedTokens.some(
      (token, index) =>
        token.text !== actualTokens[index]!.text || token.comment !== actualTokens[index]!.comment,
    )
  )
    return null;
  const index = displayedTokens.findIndex((token) => token.start <= column && column < token.end);
  if (index < 0) return null;
  return start + actualTokens[index]!.start + column - displayedTokens[index]!.start;
}

/** Keep hunk-local hit testing separate from resolution against the complete revision. */
export function createDiffDefinitionNavigation(
  navigate: (
    file: FileContents,
    offset: number,
    isCurrent: () => boolean,
    side: "additions" | "deletions",
  ) => void,
  loadFiles: FileDiffContentsLoader | undefined,
  onError: () => void,
) {
  const sidesByFile = new WeakMap<FileContents, "additions" | "deletions">();
  const fragments = new WeakMap<
    FileContents,
    {
      diff: FileDiffMetadata;
      deletion: boolean;
      start: number;
    }
  >();
  const sources = new WeakMap<
    FileDiffMetadata,
    {
      additions: string[];
      deletions: string[];
      partial: boolean | undefined;
      source: Exclude<NavigationSource, FileContents>;
      current: { resolve: Exclude<NavigationSource, FileContents> };
    }
  >();
  const clicks = createAngelScriptClickNavigation((file, offset, isCurrent) => {
    const fragment = fragments.get(file);
    if (!fragment) return navigate(file, offset, isCurrent, sidesByFile.get(file)!);
    if (!loadFiles) return onError();
    void loadFiles(fragment.diff)
      .then((files) => {
        if (!isCurrent()) return;
        const full = fragment.deletion ? files.oldFile : files.newFile;
        if (!full || full.contents.length > 2_000_000) return onError();
        const fullOffset = diffDefinitionOffset(
          file.contents,
          offset,
          fragment.start,
          full.contents,
        );
        if (fullOffset === null) return onError();
        navigate(
          { ...full, name: file.name },
          fullOffset,
          isCurrent,
          fragment.deletion ? "deletions" : "additions",
        );
      })
      .catch(() => {
        if (isCurrent()) onError();
      });
  });
  return {
    attach(node: HTMLElement, diff: FileDiffMetadata | undefined, phase?: string) {
      if (!diff || phase === "unmount") return clicks.attach(node, undefined, phase);
      let cached = sources.get(diff);
      if (
        !cached ||
        cached.additions !== diff.additionLines ||
        cached.deletions !== diff.deletionLines ||
        cached.partial !== diff.isPartial
      ) {
        const sides = [false, true].map((deletion) => {
          const side = deletion ? "deletion" : "addition";
          const lines = diff[`${side}Lines`];
          const sections = diff.isPartial
            ? diff.hunks.map((hunk) => ({
                start: hunk[`${side}Start`],
                count: hunk[`${side}Count`],
                contents: lines
                  .slice(hunk[`${side}LineIndex`], hunk[`${side}LineIndex`] + hunk[`${side}Count`])
                  .join(""),
              }))
            : [{ start: 1, count: lines.length, contents: lines.join("") }];
          return sections.map(({ start, count, contents }) => {
            // Results open the current path even when clicking the old side of a rename.
            const file = { name: diff.name, contents };
            sidesByFile.set(file, deletion ? "deletions" : "additions");
            if (diff.isPartial) fragments.set(file, { diff, deletion, start });
            return { start, count, file };
          });
        });
        const source: NavigationSource = (row) => {
          const deletion =
            row.closest("[data-deletions]") !== null || row.dataset.lineType === "change-deletion";
          const line = Number(row.dataset.line);
          const section = sides[deletion ? 1 : 0]!.find(
            ({ start, count }) => start <= line && line < start + count,
          );
          return section
            ? {
                file: section.file,
                line: line - section.start + 1,
                partial: diff.isPartial === true,
              }
            : null;
        };
        // Context expansion hydrates this object in place. Keep its hit-test callback stable
        // so a pending click survives hydration, but cancel when the revision itself changes.
        if (cached && !(cached.partial && !diff.isPartial)) clicks.cancelPending();
        const current = cached?.current ?? { resolve: source };
        current.resolve = source;
        cached = {
          additions: diff.additionLines,
          deletions: diff.deletionLines,
          partial: diff.isPartial,
          source: cached?.source ?? ((row) => current.resolve(row)),
          current,
        };
        sources.set(diff, cached);
      }
      clicks.attach(node, cached.source, phase);
    },
    cancelPending: clicks.cancelPending,
    dispose: clicks.dispose,
  };
}
