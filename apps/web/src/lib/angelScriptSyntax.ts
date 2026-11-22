/**
 * Highlights (upstream's syntax highlighter) has no AngelScript lexer and renders custom
 * grammars as text, so AngelScript sources use its C++ lexer for the base syntax colours.
 * `angelScriptRendering.ts` paints the AngelScript semantic layer on top.
 */
export const ANGELSCRIPT_SYNTAX_LANGUAGE = "cpp" as const;
