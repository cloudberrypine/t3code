import type { CodeViewScrollTarget } from "@pierre/diffs";
import { useCallback, useEffect, useRef, useState } from "react";

interface FileRevealHandle {
  getInstance(): object | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

// The input CodeView itself treats as the reader taking over a pending scroll.
const READER_INPUT_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

// Wait for a mounted viewer and expanded rows, then apply each tree click.
// Lazily loaded files keep arriving around the target, and a short target near the end of the
// loaded files cannot reach the top yet, so the jump is re-applied whenever `readyFileKeys`
// changes, until the reader scrolls, clicks or types.
// Keep scope stable until the diff or external file selection changes.
export function useCodeViewFileReveal<TScope>(
  viewer: FileRevealHandle | null,
  scope: TScope,
  readyFileKeys?: ReadonlyArray<string>,
) {
  const [request, setRequest] = useState<{ fileKey: string; scope: TScope } | null>(null);
  const handledRequest = useRef<typeof request>(null);
  const pinned = useRef<typeof request>(null);

  useEffect(() => {
    const instance = viewer?.getInstance();
    const container =
      instance &&
      "getContainerElement" in instance &&
      typeof instance.getContainerElement === "function"
        ? instance.getContainerElement()
        : undefined;
    const root = container && container instanceof HTMLElement ? container.parentElement : null;
    if (!root) return;
    const release = () => {
      pinned.current = null;
    };
    for (const type of READER_INPUT_EVENTS) root.addEventListener(type, release, true);
    return () => {
      for (const type of READER_INPUT_EVENTS) root.removeEventListener(type, release, true);
    };
  }, [viewer]);

  const previousReadyFileKeys = useRef(readyFileKeys);
  useEffect(() => {
    const readyChanged = previousReadyFileKeys.current !== readyFileKeys;
    previousReadyFileKeys.current = readyFileKeys;
    if (!viewer?.getInstance()) return;
    const isReady = (fileKey: string) => !readyFileKeys || readyFileKeys.includes(fileKey);
    if (request !== null && handledRequest.current !== request) {
      if (request.scope !== scope) {
        handledRequest.current = request;
        return;
      }
      if (!isReady(request.fileKey)) return;
      viewer.scrollTo({ type: "item", id: request.fileKey, align: "start" });
      handledRequest.current = request;
      pinned.current = request;
      return;
    }
    const pin = pinned.current;
    if (readyChanged && pin && pin.scope === scope && isReady(pin.fileKey))
      viewer.scrollTo({ type: "item", id: pin.fileKey, align: "start" });
  }, [request, scope, viewer, readyFileKeys]);

  return useCallback(
    (fileKey: string) => {
      pinned.current = null;
      setRequest({ fileKey, scope });
    },
    [scope],
  );
}
