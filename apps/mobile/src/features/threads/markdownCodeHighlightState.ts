import { useMemo } from "react";

import { isBehaviourLanguage } from "@t3tools/shared/behaviour";

import { highlightBehaviourCode } from "../../lib/behaviourHighlighting";
import { resolveHighlightLanguage } from "../../lib/highlightLanguage";
import { highlightCode, type HighlightedLines, type HighlightScheme } from "../../lib/highlights";

export function useMarkdownCodeHighlight(input: {
  readonly code: string;
  readonly enabled: boolean;
  readonly language: string | null | undefined;
  readonly theme: HighlightScheme;
}): HighlightedLines | null {
  const { code, enabled, theme } = input;
  const language = input.language?.trim();
  return useMemo(
    () =>
      enabled && language
        ? isBehaviourLanguage(language)
          ? highlightBehaviourCode(code, theme)
          : highlightCode(code, resolveHighlightLanguage({ language }), theme)
        : null,
    [code, enabled, language, theme],
  );
}
