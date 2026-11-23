import { isAngelScriptPath } from "@t3tools/shared/angelscript";
import { isBehaviourLanguage, isBehaviourPath } from "@t3tools/shared/behaviour";
import { isCppPath } from "@t3tools/shared/cppNavigation";

/**
 * The C++ lexer for paths @pierre/highlights leaves as plain text: C/C++ extensions Pierre does not
 * know (`.hxx`, `.inl`, `.ipp`, ...), as go-to-definition already treats them, and AngelScript,
 * which has no lexer of its own. AngelScript's semantic colours are laid over these tokens.
 */
export function localHighlightLanguage(
  hint: string | undefined,
  path: string | undefined,
): string | null {
  if (hint === "angelscript") return ANGELSCRIPT_HIGHLIGHT_LANGUAGE;
  if (isBehaviourLanguage(hint) || (path && isBehaviourPath(path)))
    return BEHAVIOUR_HIGHLIGHT_LANGUAGE;
  return path && (isCppPath(path) || isAngelScriptPath(path)) ? "cpp" : null;
}

/** The lexer an AngelScript file tokenizes with before its semantic colours are applied. */
export const ANGELSCRIPT_HIGHLIGHT_LANGUAGE = "cpp";

/**
 * Polyzonia's behaviour language (`.beh`, `.pzb`) has no lexer, and the C++ one would misread its
 * `#` comments: it tokenizes as plain text, one token a line, under its own colours.
 */
export const BEHAVIOUR_HIGHLIGHT_LANGUAGE = "text";
