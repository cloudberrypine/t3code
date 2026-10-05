interface FileScrollPosition {
  scrollTop: number;
  scrollLeft: number;
  revealRequestId: number;
}

// Keep geometry only, bounded to recent source tabs in this client session.
const positions = new Map<string, FileScrollPosition>();
const MAX_FILES = 100;

export function getFileScrollPosition(key: string) {
  return positions.get(key);
}

export function createFileScrollMemory(key: string, revealRequestId: number, hasReveal: boolean) {
  let container: HTMLElement | null = null;
  let frame: number | null = null;
  let restoring = false;

  const save = () => {
    if (restoring || !container?.isConnected || container.clientHeight <= 0) return;
    positions.delete(key);
    positions.set(key, {
      scrollTop: container.scrollTop,
      scrollLeft: container.scrollLeft,
      revealRequestId,
    });
    if (positions.size > MAX_FILES) positions.delete(positions.keys().next().value!);
  };
  const cancelRestore = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    restoring = false;
  };
  const onInput = () => {
    cancelRestore();
    save();
  };
  const dispose = () => {
    save();
    cancelRestore();
    container?.removeEventListener("scroll", save);
    container?.removeEventListener("wheel", onInput);
    container?.removeEventListener("touchstart", onInput);
    container?.removeEventListener("pointerdown", onInput, true);
    container?.removeEventListener("keydown", onInput, true);
    container = null;
  };
  const attach = (node: HTMLElement, height: number) => {
    const next = node.closest<HTMLElement>(".file-preview-virtualizer");
    if (!next) return;
    // Give a freshly mounted virtual file enough height to accept its saved offset.
    node.style.minHeight = `${Math.ceil(Math.max(height, next.clientHeight))}px`;
    if (container === next) return;
    dispose();
    container = next;
    container.addEventListener("scroll", save, { passive: true });
    container.addEventListener("wheel", onInput, { passive: true });
    container.addEventListener("touchstart", onInput, { passive: true });
    container.addEventListener("pointerdown", onInput, { passive: true, capture: true });
    container.addEventListener("keydown", onInput, true);
    const saved = positions.get(key);
    if (!saved || (hasReveal && saved.revealRequestId !== revealRequestId)) return;
    restoring = true;
    // Editor focus, highlighting and virtual layout settle after the first render.
    // Hold the offset briefly, yielding immediately to user input.
    let framesLeft = 30;
    const restore = () => {
      frame = null;
      if (!container?.isConnected) return cancelRestore();
      container.scrollTop = saved.scrollTop;
      container.scrollLeft = saved.scrollLeft;
      if (--framesLeft > 0) frame = requestAnimationFrame(restore);
      else {
        restoring = false;
        save();
      }
    };
    frame = requestAnimationFrame(restore);
  };
  return { attach, dispose };
}
