// Polyzonia: chat code fences tagged `beh` or `pzb` (the prototype's behaviour language). The
// syntax highlighter has no lexer for it, so the fence is coloured from the shared analyzer, and
// a line that waits gets the same tint and gutter stripe as in file previews and diffs.
import {
  behaviourColors,
  highlightBehaviour,
  type BehaviourHighlightedLine,
} from "@t3tools/shared/behaviour";
import { Fragment, type CSSProperties } from "react";

import { DIFF_THEME_NAMES, type DiffThemeName } from "../../lib/diffRendering";

function lineStyle(
  line: BehaviourHighlightedLine,
  palette: (typeof behaviourColors)["light"],
): CSSProperties | undefined {
  if (line.lineKind === "wait")
    return {
      display: "inline-block",
      minWidth: "100%",
      backgroundColor: palette.waitBackground,
      boxShadow: `inset 3px 0 0 ${palette.waitStripe}`,
    };
  return undefined;
}

/** Keyed by source offset: a line or token keeps its key while a streamed fence grows. */
function keyedLines(code: string) {
  let offset = 0;
  return highlightBehaviour(code.endsWith("\n") ? code.slice(0, -1) : code).map((line) => {
    const lineStart = offset;
    let tokenStart = lineStart;
    const tokens = line.tokens.map((token) => {
      const keyed = { ...token, key: `${tokenStart}:${token.content.length}` };
      tokenStart += token.content.length;
      return keyed;
    });
    offset = tokenStart + 1;
    return { ...line, key: String(lineStart), tokens };
  });
}

export function BehaviourCodeBlock({
  code,
  themeName,
}: {
  code: string;
  themeName: DiffThemeName;
}) {
  const palette = behaviourColors[themeName === DIFF_THEME_NAMES.dark ? "dark" : "light"];
  const lines = keyedLines(code);
  return (
    <div className="chat-markdown-shiki">
      <pre className="shiki" data-behaviour-language="">
        <code>
          {lines.map((line, index) => (
            <Fragment key={line.key}>
              <span
                className="line"
                data-beh-line={line.lineKind ?? undefined}
                style={lineStyle(line, palette)}
              >
                {line.tokens.map((token) =>
                  token.kind ? (
                    <span
                      key={token.key}
                      style={{
                        color: palette[token.kind],
                        ...(token.kind === "comment" ? { fontStyle: "italic" } : {}),
                        ...(token.kind === "wait"
                          ? {
                              fontWeight: 700,
                              backgroundColor: palette.waitKeywordBackground,
                              borderRadius: 2,
                            }
                          : {}),
                      }}
                    >
                      {token.content}
                    </span>
                  ) : (
                    <Fragment key={token.key}>{token.content}</Fragment>
                  ),
                )}
              </span>
              {index < lines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </code>
      </pre>
    </div>
  );
}
