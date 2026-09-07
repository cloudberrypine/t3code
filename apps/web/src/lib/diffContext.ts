import {
  SPLIT_WITH_NEWLINES,
  type FileDiffLoadedFiles,
  type FileDiff,
  type FileDiffContentsLoader,
  type FileDiffMetadata,
  type PostRenderPhase,
} from "@pierre/diffs";

export const DIFF_CONTEXT_LINES = 20;

type DiffInstance = Pick<FileDiff<unknown>, "fileDiff" | "expandHunk">;

/** Validate before Pierre hydrates in place: a failed hydration otherwise poisons scroll layout. */
function validateLoadedContext(file: FileDiffMetadata, files: FileDiffLoadedFiles) {
  if (!file.isPartial || (file.type !== "change" && file.type !== "rename-changed")) return;
  const mismatch = () => {
    throw new Error(
      `File contents no longer match the diff for ${file.name}. Refresh the diff to load context.`,
    );
  };
  if (!files.oldFile || !files.newFile) return mismatch();
  const oldLines = files.oldFile.contents ? files.oldFile.contents.split(SPLIT_WITH_NEWLINES) : [];
  const newLines = files.newFile.contents ? files.newFile.contents.split(SPLIT_WITH_NEWLINES) : [];
  const matches = (
    left: readonly string[],
    leftStart: number,
    right: readonly string[],
    rightStart: number,
    count: number,
  ) => {
    if (count < 0 || leftStart + count > left.length || rightStart + count > right.length)
      return false;
    for (let offset = 0; offset < count; offset++) {
      if (left[leftStart + offset] !== right[rightStart + offset]) return false;
    }
    return true;
  };
  let oldEnd = 0;
  let newEnd = 0;
  for (const hunk of file.hunks) {
    const oldStart = Math.max(hunk.deletionStart - 1, 0);
    const newStart = Math.max(hunk.additionStart - 1, 0);
    const gap = oldStart - oldEnd;
    if (
      gap !== newStart - newEnd ||
      !matches(oldLines, oldEnd, newLines, newEnd, gap) ||
      !matches(
        oldLines,
        oldStart,
        file.deletionLines,
        hunk.deletionLineIndex,
        hunk.deletionCount,
      ) ||
      !matches(newLines, newStart, file.additionLines, hunk.additionLineIndex, hunk.additionCount)
    )
      return mismatch();
    oldEnd = oldStart + hunk.deletionCount;
    newEnd = newStart + hunk.additionCount;
  }
  const trailing = oldLines.length - oldEnd;
  if (
    trailing !== newLines.length - newEnd ||
    !matches(oldLines, oldEnd, newLines, newEnd, trailing)
  )
    mismatch();
}

/** Pierre calls expansion from the gap's perspective: `up` consumes its start. */
export function getDiffContextActions(first: boolean, last: boolean, remaining: number) {
  const count = Math.min(DIFF_CONTEXT_LINES, remaining);
  return [
    ...(!first
      ? [{ direction: "up" as const, label: `Show ${count} lines below`, text: `↓ ${count}` }]
      : []),
    ...(!last
      ? [{ direction: "down" as const, label: `Show ${count} lines above`, text: `↑ ${count}` }]
      : []),
  ];
}

/** Loads context for mounted, expanded files and decorates Pierre's virtualized separators. */
export function createDiffContextController(loader?: FileDiffContentsLoader) {
  const requests = new WeakMap<FileDiffMetadata, ReturnType<FileDiffContentsLoader>>();
  const failures = new WeakSet<FileDiffMetadata>();
  const attempted = new WeakMap<DiffInstance, FileDiffMetadata>();
  const repaint = new WeakMap<FileDiffMetadata, () => void>();

  const loadDiffFiles: FileDiffContentsLoader | undefined = loader
    ? (file) => {
        const pending = requests.get(file);
        if (pending) return pending;
        const request = Promise.resolve()
          .then(() => loader(file))
          .then((files) => {
            validateLoadedContext(file, files);
            return files;
          })
          .catch((error: unknown) => {
            failures.add(file);
            repaint.get(file)?.();
            throw error;
          });
        requests.set(file, request);
        return request;
      }
    : undefined;

  function render(
    node: HTMLElement,
    instance: DiffInstance,
    phase: PostRenderPhase,
    collapsed: boolean,
  ) {
    const file = instance.fileDiff;
    if (!file) return;
    if (phase === "unmount" || collapsed) {
      attempted.delete(instance);
      repaint.delete(file);
      return;
    }

    const decorate = () => {
      // A request may finish after this virtualized instance has been recycled.
      if (instance.fileDiff !== file) return;
      const root = node.shadowRoot ?? node;
      for (const separator of root.querySelectorAll<HTMLElement>(
        "[data-separator][data-expand-index]",
      )) {
        const wrapper = separator.querySelector<HTMLElement>("[data-separator-wrapper]");
        const countNode = separator.querySelector<HTMLElement>("[data-unmodified-lines]");
        if (!wrapper || !countNode) continue;
        const first = separator.hasAttribute("data-separator-first");
        const last = separator.hasAttribute("data-separator-last");
        const index = Number(separator.getAttribute("data-expand-index"));
        const unknown = file.isPartial && last;
        const failed = failures.has(file);
        const countText = unknown
          ? failed
            ? "Retry loading context"
            : "Loading context…"
          : (countNode.textContent ?? "");
        const remaining = unknown ? DIFF_CONTEXT_LINES : Number.parseInt(countText, 10);
        if (!Number.isFinite(remaining)) continue;
        const key = `${index}:${countText}:${failed}`;
        if (wrapper.dataset.contextKey === key) continue;
        wrapper.dataset.contextKey = key;
        wrapper.dataset.contextControls = "";

        const expand = (direction: "up" | "down") => {
          if (instance.fileDiff !== file) return;
          if (failures.has(file)) {
            failures.delete(file);
            requests.delete(file);
          }
          instance.expandHunk(index, direction, DIFF_CONTEXT_LINES);
          decorate();
        };
        const button = (text: string, label: string, direction: "up" | "down") => {
          const result = node.ownerDocument.createElement("button");
          result.type = "button";
          result.textContent = text;
          result.title = label;
          result.setAttribute("aria-label", label);
          result.addEventListener("click", (event) => {
            // Own this click so Pierre does not also expand from both ends.
            event.stopPropagation();
            expand(direction);
          });
          return result;
        };
        const actions = getDiffContextActions(first, last, remaining);
        const defaultDirection = first ? "down" : "up";
        const countButton = button(
          countText,
          unknown ? countText : `${countText}. ${actions[0]?.label ?? "Show context"}`,
          defaultDirection,
        );
        countButton.dataset.contextCount = "";
        countNode.textContent = countText;
        countButton.replaceChildren(countNode);
        // Keep a loading status readable; the directional controls remain usable while loading.
        countButton.disabled = unknown && !failed;
        wrapper.replaceChildren(
          ...actions
            .filter((action) => action.direction === "up")
            .map((action) => button(action.text, action.label, action.direction)),
          countButton,
          ...actions
            .filter((action) => action.direction === "down")
            .map((action) => button(action.text, action.label, action.direction)),
        );
      }
    };
    repaint.set(file, decorate);
    decorate();
    if (
      loadDiffFiles &&
      file.isPartial &&
      file.hunks.length > 0 &&
      (file.type === "change" || file.type === "rename-changed") &&
      attempted.get(instance) !== file &&
      !failures.has(file)
    ) {
      attempted.set(instance, file);
      // Hydrate through the viewer so its scroll anchor, highlights and expansion state survive.
      // Zero loads full contents for accurate counts without revealing any extra rows.
      instance.expandHunk(0, "down", 0);
    }
  }

  return { loadDiffFiles, render };
}
