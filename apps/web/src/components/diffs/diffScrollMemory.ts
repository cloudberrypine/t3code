import type { CodeView, CodeViewItem, SelectionSide } from "@pierre/diffs";
import { diffJumpExpansion } from "~/lib/diffJumpReveal";
import { findAnchoredDiffItem } from "./diffScrollAnchor";

// Match the shared viewer's sticky header. Store geometry, never source contents or DOM nodes.
const HEADER_HEIGHT = 32;
const MAX_VIEWS = 100;
type ScrollViewer<LAnnotation> = Pick<
  CodeView<LAnnotation>,
  "getHeight" | "getScrollTop" | "getTopForItem" | "getRenderedItems" | "scrollTo"
>;
interface DiffScrollPosition {
  id: string;
  viewportOffset: number;
  line?: number;
  side?: SelectionSide;
  lastVisibleLine?: number;
}
const positions = new Map<string, DiffScrollPosition>();

export function hasDiffScrollPosition(key: string) {
  return positions.has(key);
}

/** A session bookmark follows the visible line even if earlier files change height. */
export function createDiffScrollMemory(key?: string) {
  let pending = key ? positions.get(key) : undefined;
  let revealed = false;
  const expanded = new WeakMap<object, Set<number>>();

  function cancel() {
    pending = undefined;
  }

  function save<LAnnotation>(
    viewer: ScrollViewer<LAnnotation>,
    items: readonly CodeViewItem<LAnnotation>[],
  ) {
    if (!key || pending || viewer.getHeight() <= 0) return;
    const scrollTop = viewer.getScrollTop();
    const item = findAnchoredDiffItem(items, scrollTop, (id) => viewer.getTopForItem(id));
    if (!item) return;
    const top = viewer.getTopForItem(item.id);
    if (top === undefined) return;
    const rendered = viewer.getRenderedItems().find((entry) => entry.id === item.id);
    const localTop = scrollTop + HEADER_HEIGHT - top;
    const anchor =
      top < scrollTop && !item.collapsed
        ? rendered?.instance.getNumericScrollAnchor(localTop)
        : undefined;
    const end = anchor
      ? rendered?.instance.getNumericScrollAnchor(
          Math.min(
            localTop + viewer.getHeight() - HEADER_HEIGHT,
            rendered.instance.getVirtualizedHeight() - HEADER_HEIGHT,
          ),
        )
      : undefined;
    positions.delete(key);
    positions.set(key, {
      id: item.id,
      viewportOffset: top + (anchor?.top ?? 0) - scrollTop,
      ...(anchor ? { line: anchor.lineNumber, side: anchor.side ?? "additions" } : {}),
      ...(end && end.side === anchor?.side ? { lastVisibleLine: end.lineNumber } : {}),
    });
    if (positions.size > MAX_VIEWS) positions.delete(positions.keys().next().value!);
  }

  function restore<LAnnotation>(
    viewer: ScrollViewer<LAnnotation>,
    items: readonly CodeViewItem<LAnnotation>[],
    reveal?: (id: string) => void,
  ) {
    if (!pending || viewer.getHeight() <= 0 || items.length === 0) return;
    const item = items.find((entry) => entry.id === pending!.id);
    if (!item) return cancel();
    if (pending.line !== undefined && item.collapsed) {
      if (!revealed && reveal) {
        revealed = true;
        reveal(item.id);
      }
      return;
    }
    if (pending.line === undefined) {
      viewer.scrollTo({
        type: "item",
        id: item.id,
        align: "start",
        offset: pending.viewportOffset,
        behavior: "instant",
      });
      return cancel();
    }
    const rendered = viewer.getRenderedItems().find((entry) => entry.id === item.id);
    if (!rendered) {
      viewer.scrollTo({ type: "item", id: item.id, align: "start", behavior: "instant" });
      return;
    }
    if (rendered.type === "diff" && rendered.instance.fileDiff) {
      for (const line of [pending.line, pending.lastVisibleLine]) {
        if (line === undefined) continue;
        const expansion = diffJumpExpansion(
          rendered.instance.fileDiff,
          line,
          pending.side ?? "additions",
        );
        if (!expansion) continue;
        let attempted = expanded.get(rendered.instance);
        if (!attempted) expanded.set(rendered.instance, (attempted = new Set()));
        if (!attempted.has(line)) {
          attempted.add(line);
          rendered.instance.expandHunk(expansion.index, expansion.direction, expansion.count);
          return;
        }
        // Loading context is asynchronous. Leave the bookmark intact until the line exists.
        if (rendered.instance.fileDiff.isPartial) return;
      }
    }
    if (!rendered.instance.getLinePosition(pending.line, pending.side)) return;
    viewer.scrollTo({
      type: "line",
      id: item.id,
      lineNumber: pending.line,
      ...(pending.side ? { side: pending.side } : {}),
      align: "start",
      offset: pending.viewportOffset - HEADER_HEIGHT,
      behavior: "instant",
    });
    cancel();
  }

  return { save, restore, cancel, isRestoring: () => pending !== undefined };
}
