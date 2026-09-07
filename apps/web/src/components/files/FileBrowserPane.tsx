import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useResizableWidth } from "~/hooks/useResizableWidth";
import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";

/** File list beside a preview, or the whole pane when no file is open. */
export function FileBrowserPane({
  besidePreview,
  children,
  storageKey = "t3code.fileExplorerWidth",
  defaultWidth = 352,
}: {
  besidePreview: boolean;
  children: ReactNode;
  storageKey?: string;
  defaultWidth?: number;
}) {
  const ref = useRef<HTMLElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  useLayoutEffect(() => {
    if (!besidePreview) return;
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const measure = () => setAvailableWidth(parent.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [besidePreview]);
  const { width, handlers } = useResizableWidth({
    storageKey,
    defaultWidth,
    minWidth: 160,
    maxWidth: availableWidth > 0 ? Math.max(160, availableWidth - 160) : Infinity,
    edge: "left",
  });
  return (
    <aside
      ref={ref}
      className={
        besidePreview
          ? "relative flex min-h-0 shrink-0 border-l border-border/60 bg-background"
          : "flex min-h-0 min-w-0 flex-1 bg-background"
      }
      style={besidePreview ? { width } : undefined}
    >
      {besidePreview ? (
        <RightPanelResizeHandle handlers={handlers} label="Resize file browser" />
      ) : null}
      {children}
    </aside>
  );
}
