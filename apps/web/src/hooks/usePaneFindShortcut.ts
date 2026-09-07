import type { KeyboardEvent, PointerEvent } from "react";

/** Keep find scoped to the pane receiving keyboard input, including its shadow DOM trees. */
export function usePaneFindShortcut(onFind: () => void) {
  return {
    tabIndex: -1,
    "data-find-pane": "",
    onPointerDownCapture(event: PointerEvent<HTMLDivElement>) {
      // Clicking plain chrome must give the pane focus too. Interactive children manage
      // their own focus; the event path also covers controls inside Pierre's shadow roots.
      const interactive = event.nativeEvent
        .composedPath()
        .some(
          (node) =>
            node instanceof HTMLElement &&
            node.matches(
              "input, textarea, button, a, select, [contenteditable=true], [tabindex]",
            ) &&
            node !== event.currentTarget,
        );
      if (!interactive) event.currentTarget.focus({ preventScroll: true });
    },
    onKeyDownCapture(event: KeyboardEvent<HTMLDivElement>) {
      if (
        event.defaultPrevented ||
        event.key.toLowerCase() !== "f" ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      onFind();
    },
  };
}
