import {
  analyzeAngelScript,
  colorAngelScriptTokens,
  isAngelScriptPath,
  usesAngelScript,
  type AngelScriptApi,
} from "@t3tools/shared/angelscript";
import {
  analyzeBehaviour,
  behaviourColors,
  colorBehaviourTokens,
  isBehaviourPath,
} from "@t3tools/shared/behaviour";
import { getFiletypeFromFileName } from "@pierre/diffs";
import type { ProjectContentMatch } from "@t3tools/contracts";
import { memo, Suspense, use, type CSSProperties } from "react";

import { ANGELSCRIPT_SYNTAX_LANGUAGE } from "~/lib/angelScriptSyntax";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

import { RenderErrorBoundary } from "../RenderErrorBoundary";

interface Range {
  readonly start: number;
  readonly end: number;
}

interface CodeToken {
  readonly content: string;
  readonly offset: number;
  readonly color?: string;
  readonly fontStyle?: number;
}

interface Segment {
  readonly content: string;
  readonly isMatch: boolean;
  readonly start: number;
  readonly end: number;
  readonly token: CodeToken;
}

function normalizeRanges(match: ProjectContentMatch): Range[] {
  const ranges = match.matchRanges
    .map((range) => ({
      start: Math.max(0, Math.min(match.lineContent.length, range.start)),
      end: Math.max(0, Math.min(match.lineContent.length, range.end)),
    }))
    .filter((range) => range.end > range.start)
    .toSorted((left, right) => left.start - right.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function splitToken(line: string, token: CodeToken, ranges: ReadonlyArray<Range>): Segment[] {
  const segments: Segment[] = [];
  const tokenEnd = token.offset + token.content.length;
  let cursor = token.offset;

  for (const range of ranges) {
    if (range.end <= cursor) continue;
    if (range.start >= tokenEnd) break;

    const matchStart = Math.max(cursor, range.start);
    if (matchStart > cursor) {
      segments.push({
        content: line.slice(cursor, matchStart),
        isMatch: false,
        start: cursor,
        end: matchStart,
        token,
      });
    }

    const matchEnd = Math.min(tokenEnd, range.end);
    segments.push({
      content: line.slice(matchStart, matchEnd),
      isMatch: true,
      start: matchStart,
      end: matchEnd,
      token,
    });
    cursor = matchEnd;
  }

  if (cursor < tokenEnd) {
    segments.push({
      content: line.slice(cursor, tokenEnd),
      isMatch: false,
      start: cursor,
      end: tokenEnd,
      token,
    });
  }
  return segments;
}

function tokenStyle(token: CodeToken): CSSProperties {
  const fontStyle = token.fontStyle ?? 0;
  return {
    ...(token.color ? { color: token.color } : {}),
    ...(fontStyle & 1 ? { fontStyle: "italic" } : {}),
    ...(fontStyle & 2 ? { fontWeight: 700 } : {}),
    ...(fontStyle & 4 ? { textDecoration: "underline" } : {}),
  };
}

function HighlightedTokens(props: {
  readonly line: string;
  readonly ranges: ReadonlyArray<Range>;
  readonly tokens: ReadonlyArray<CodeToken>;
}) {
  return props.tokens
    .flatMap((token) => splitToken(props.line, token, props.ranges))
    .map((segment) =>
      segment.isMatch ? (
        <mark
          className="rounded-xs bg-primary/25 text-inherit"
          key={`${segment.start}:${segment.end}:match`}
          style={tokenStyle(segment.token)}
        >
          {segment.content}
        </mark>
      ) : (
        <span key={`${segment.start}:${segment.end}:code`} style={tokenStyle(segment.token)}>
          {segment.content}
        </span>
      ),
    );
}

function firstLineTokens(
  highlighter: Awaited<ReturnType<typeof getSyntaxHighlighterPromise>>,
  line: string,
  language: string,
  theme: "light" | "dark",
) {
  try {
    return highlighter.codeToTokens(line, { lang: language, theme: resolveDiffThemeName(theme) })
      .tokens[0];
  } catch {
    return undefined;
  }
}

/** AngelScript's semantic split changes token boundaries, so offsets are recomputed. */
function withOffsets(tokens: ReadonlyArray<Omit<CodeToken, "offset">>): CodeToken[] {
  let offset = 0;
  return tokens.map((token) => {
    const result = { ...token, offset };
    offset += token.content.length;
    return result;
  });
}

function SyntaxHighlightedTokens(props: {
  readonly line: string;
  readonly language: string;
  readonly api?: AngelScriptApi | null;
  readonly behaviour?: boolean;
  readonly ranges: ReadonlyArray<Range>;
  readonly theme: "light" | "dark";
}) {
  const highlighter = use(getSyntaxHighlighterPromise(props.language));
  const tokens = firstLineTokens(highlighter, props.line, props.language, props.theme);
  // Polyzonia: the behaviour language is plain text to the highlighter and coloured here; a
  // line that waits keeps its tint and gutter stripe in the results too.
  const behaviour = props.behaviour ? analyzeBehaviour(props.line) : null;
  const colored =
    tokens && behaviour
      ? withOffsets(colorBehaviourTokens(tokens, behaviour.tokens, props.theme))
      : tokens && props.api
        ? withOffsets(
            colorAngelScriptTokens(tokens, analyzeAngelScript(props.line, props.api), props.theme),
          )
        : tokens;

  if (colored && behaviour?.lines.get(1) === "wait") {
    const palette = behaviourColors[props.theme];
    return (
      <span
        data-beh-line="wait"
        style={{
          backgroundColor: palette.waitBackground,
          boxShadow: `inset 3px 0 0 ${palette.waitStripe}`,
          paddingLeft: 6,
        }}
      >
        <HighlightedTokens line={props.line} ranges={props.ranges} tokens={colored} />
      </span>
    );
  }
  return colored ? (
    <HighlightedTokens line={props.line} ranges={props.ranges} tokens={colored} />
  ) : (
    <HighlightedTokens
      line={props.line}
      ranges={props.ranges}
      tokens={[{ content: props.line, offset: 0 }]}
    />
  );
}

export const HighlightedSearchLine = memo(function HighlightedSearchLine(props: {
  readonly match: ProjectContentMatch;
  readonly path: string;
  readonly api?: AngelScriptApi | null;
  readonly theme: "light" | "dark";
}) {
  const ranges = normalizeRanges(props.match);
  const fallback = (
    <HighlightedTokens
      line={props.match.lineContent}
      ranges={ranges}
      tokens={[{ content: props.match.lineContent, offset: 0 }]}
    />
  );

  return (
    <RenderErrorBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <SyntaxHighlightedTokens
          line={props.match.lineContent}
          language={
            usesAngelScript(props.path, props.match.lineContent, props.api ?? null)
              ? ANGELSCRIPT_SYNTAX_LANGUAGE
              : getFiletypeFromFileName(props.path)
          }
          api={isAngelScriptPath(props.path) ? (props.api ?? null) : null}
          behaviour={isBehaviourPath(props.path)}
          ranges={ranges}
          theme={props.theme}
        />
      </Suspense>
    </RenderErrorBoundary>
  );
});
