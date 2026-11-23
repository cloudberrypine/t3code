import {
  behaviourColors,
  behaviourLineSemantics,
  colorBehaviourTokens,
  type BehaviourLineSemantics,
} from "@t3tools/shared/behaviour";

import { BEHAVIOUR_HIGHLIGHT_LANGUAGE } from "../features/review/desktopCodeLanguages";
import {
  highlightCode,
  type HighlightedLines,
  type HighlightedToken,
  type HighlightScheme,
} from "./highlights";

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

/** A token of a chat fence; the wait word carries its own background. */
export interface BehaviourFenceToken extends HighlightedToken {
  readonly background?: string;
}

/** A behaviour snippet (a chat code fence) as coloured lines, the wait word on its background. */
export function highlightBehaviourCode(
  code: string,
  scheme: HighlightScheme,
): ReadonlyArray<ReadonlyArray<BehaviourFenceToken>> {
  const palette = behaviourColors[scheme];
  return colorBehaviourLines(
    highlightCode(code, BEHAVIOUR_HIGHLIGHT_LANGUAGE, scheme),
    behaviourLineSemantics(code),
    scheme,
  ).map((line) =>
    line.map((token) =>
      token.color === palette.wait
        ? { ...token, background: palette.waitKeywordBackground }
        : token,
    ),
  );
}
