export const FILE_LINK_REVEAL_ATTRIBUTE = "data-file-link-reveal";

function paint(node: HTMLElement, line: number | null) {
  const root = node.shadowRoot ?? node;
  for (const element of root.querySelectorAll(`[${FILE_LINK_REVEAL_ATTRIBUTE}]`)) {
    element.removeAttribute(FILE_LINK_REVEAL_ATTRIBUTE);
  }
  if (line === null) return;
  root.querySelector(`[data-line="${line}"]`)?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
  root
    .querySelector(`[data-column-number="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
}

/** A dismissed reveal stays dismissed through edits and virtualized row rerenders. */
export function createFileRevealHighlight() {
  let node: HTMLElement | null = null;
  let requestId: number | null = null;
  let dismissed = false;
  let cleanup: (() => void) | undefined;
  let onDismiss = () => {};
  const dismiss = (event: Event) => {
    if (!node || dismissed) return;
    const inCode = event
      .composedPath()
      .some((part) => part instanceof HTMLElement && part.closest("[data-code]") !== null);
    if (!inCode) return;
    if (
      event.type === "keydown" &&
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
        "PageUp",
        "PageDown",
      ].includes((event as KeyboardEvent).key)
    )
      return;
    if (
      event.type === "pointerdown" &&
      ((event as PointerEvent).button !== 0 ||
        (event as PointerEvent).metaKey ||
        (event as PointerEvent).ctrlKey)
    )
      return;
    dismissed = true;
    paint(node, null);
    onDismiss();
  };
  return {
    paint(
      nextNode: HTMLElement,
      line: number | null,
      nextRequestId: number,
      cancelReveal: () => void,
    ) {
      if (requestId !== nextRequestId) {
        requestId = nextRequestId;
        dismissed = false;
      }
      onDismiss = cancelReveal;
      if (node !== nextNode) {
        cleanup?.();
        node = nextNode;
        const root = node.shadowRoot ?? node;
        for (const type of ["pointerdown", "keydown", "beforeinput"])
          root.addEventListener(type, dismiss, true);
        cleanup = () => {
          for (const type of ["pointerdown", "keydown", "beforeinput"])
            root.removeEventListener(type, dismiss, true);
        };
      }
      paint(nextNode, dismissed ? null : line);
    },
    dispose() {
      cleanup?.();
      cleanup = undefined;
      if (node) paint(node, null);
      node = null;
    },
  };
}
