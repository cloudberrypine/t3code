import { requireOptionalNativeModule } from "expo";

interface AndroidCiteEvent {
  readonly reactTag: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface T3MarkdownTextSelectionNativeModule {
  readonly setCiteEnabled?: (reactTag: number, enabled: boolean) => void;
  readonly addListener?: (
    event: "onCite",
    listener: (event: AndroidCiteEvent) => void,
  ) => { remove: () => void };
  readonly setSelectionHandleColor?: (reactTag: number, color: number) => void;
  readonly installCopySanitizer: (reactTag: number, contextClipboardConfig: string) => void;
  readonly renderContextChip?: (payloadJson: string) => {
    readonly uri: string;
    readonly width: number;
    readonly height: number;
    /** Inline box height: the paragraph font's ascent, so the line box never grows. */
    readonly boxHeight: number;
    /** Bitmap top relative to the box top; negative when the chip overhangs the box. */
    readonly offsetY: number;
  } | null;
}

const nativeModule =
  requireOptionalNativeModule<T3MarkdownTextSelectionNativeModule>("T3MarkdownTextSelection");

export function installMarkdownCopySanitizer(reactTag: number, contextClipboardConfig = ""): void {
  nativeModule?.installCopySanitizer(reactTag, contextClipboardConfig);
}

export function setMarkdownSelectionHandleColor(reactTag: number, color: number): void {
  nativeModule?.setSelectionHandleColor?.(reactTag, color);
}

export function renderAndroidContextChip(payloadJson: string) {
  return nativeModule?.renderContextChip?.(payloadJson) ?? null;
}

/** Android: offers "Cite" in a text view's selection menu; returns the cleanup. */
export function enableMarkdownCite(
  reactTag: number,
  onCite: (selection: { start: number; end: number; text: string }) => void,
): () => void {
  if (!nativeModule?.setCiteEnabled || !nativeModule.addListener) return () => {};
  const subscription = nativeModule.addListener("onCite", (event) => {
    if (event.reactTag === reactTag) onCite(event);
  });
  nativeModule.setCiteEnabled(reactTag, true);
  return () => {
    subscription.remove();
    nativeModule.setCiteEnabled?.(reactTag, false);
  };
}
