import { codegenNativeComponent, type CodegenTypes, type ViewProps } from "react-native";

interface TargetedEvent {
  target: CodegenTypes.Int32;
}

interface TextLayoutEvent extends TargetedEvent {
  lines: string[];
}

/**
 * Event fired when text selection changes in the MarkdownTextPrimitive.
 * @property target - The view tag identifier
 * @property start - The start index of the selected range (0-based)
 * @property end - The end index of the selected range (0-based, exclusive)
 */
interface SelectionChangeEvent extends TargetedEvent {
  start: CodegenTypes.Int32;
  end: CodegenTypes.Int32;
}

/** "Cite" chosen from the selection menu; offsets are UTF-16 into `text`, the whole view's text. */
interface CiteEvent extends TargetedEvent {
  start: CodegenTypes.Int32;
  end: CodegenTypes.Int32;
  text: string;
}

type EllipsizeMode = "head" | "middle" | "tail" | "clip";

interface NativeProps extends ViewProps {
  contextClipboardConfig?: string;
  numberOfLines?: CodegenTypes.Int32;
  allowFontScaling?: CodegenTypes.WithDefault<boolean, true>;
  ellipsizeMode?: CodegenTypes.WithDefault<EllipsizeMode, "tail">;
  selectable?: boolean;
  /** Offers "Cite" in the selection menu, reported through onCite. */
  citable?: boolean;
  onCite?: CodegenTypes.BubblingEventHandler<CiteEvent>;
  onTextLayout?: CodegenTypes.BubblingEventHandler<TextLayoutEvent>;
  /**
   * Callback fired when the text selection changes.
   *
   * @example
   * ```tsx
   * <MarkdownTextPrimitive
   *   onSelectionChange={(event) => {
   *     console.log('Selection:', event.nativeEvent.start, event.nativeEvent.end);
   *   }}
   * >
   *   Selectable text
   * </MarkdownTextPrimitive>
   * ```
   */
  onSelectionChange?: CodegenTypes.BubblingEventHandler<SelectionChangeEvent>;
}

export default codegenNativeComponent<NativeProps>("T3MarkdownText", {
  excludedPlatforms: ["android"],
});
