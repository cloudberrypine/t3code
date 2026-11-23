import {
  behaviourLineSemantics,
  colorBehaviourTokens,
  type BehaviourLineSemantics,
} from "@t3tools/shared/behaviour";

import { BEHAVIOUR_HIGHLIGHT_LANGUAGE } from "../features/review/desktopCodeLanguages";
import { highlightCode, type HighlightedLines, type HighlightScheme } from "./highlights";

/**
 * Polyzonia's behaviour language (`.beh`, `.pzb`) has no lexer in @pierre/highlights: its code
 * tokenizes as plain text, one token a line, and its own colours are laid over that.
 */
export function colorBehaviourLines(
  lines: HighlightedLines,
  semantics: BehaviourLineSemantics,
  scheme: HighlightScheme,
): HighlightedLines {
  return lines.map((line, index) =>
    colorBehaviourTokens(line, semantics.tokens.get(index + 1) ?? [], scheme),
  );
}

/** A behaviour snippet (a chat code fence) as coloured lines. */
export function highlightBehaviourCode(code: string, scheme: HighlightScheme): HighlightedLines {
  return colorBehaviourLines(
    highlightCode(code, BEHAVIOUR_HIGHLIGHT_LANGUAGE, scheme),
    behaviourLineSemantics(code),
    scheme,
  );
}
