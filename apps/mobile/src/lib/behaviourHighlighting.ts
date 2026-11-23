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

/** A token of a chat fence's waiting line, drawn on the wait background. */
export interface BehaviourFenceToken extends HighlightedToken {
  readonly background?: string;
}

/**
 * A behaviour snippet (a chat code fence) as coloured lines. Every token of a waiting line carries
 * the wait background, and the wait word its own, since a fence draws text runs, not rows.
 */
export function highlightBehaviourCode(
  code: string,
  scheme: HighlightScheme,
): ReadonlyArray<ReadonlyArray<BehaviourFenceToken>> {
  const semantics = behaviourLineSemantics(code);
  const palette = behaviourColors[scheme];
  return colorBehaviourLines(
    highlightCode(code, BEHAVIOUR_HIGHLIGHT_LANGUAGE, scheme),
    semantics,
    scheme,
  ).map((line, index) =>
    semantics.lines.get(index + 1) === "wait"
      ? line.map((token) => ({
          ...token,
          background:
            token.color === palette.wait ? palette.waitKeywordBackground : palette.waitBackground,
        }))
      : line,
  );
}
