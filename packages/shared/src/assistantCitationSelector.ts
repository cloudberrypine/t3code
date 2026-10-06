import { ASSISTANT_CITATION_CONTEXT_LENGTH } from "@t3tools/contracts";

/**
 * Where a quote sits in an assistant message's rendered text, as desktop's citations store it
 * (`createAssistantTextSelector` in apps/web/src/lib/assistantTextSelection.ts, which this
 * mirrors so mobile builds the same selector): the exact text, UTF-16 positions after
 * collapsing each whitespace run to one space, and up to 32 characters of context each side.
 */
export interface AssistantTextSelectorFields {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly prefix: string;
  readonly suffix: string;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

export function assistantTextSelector(
  text: string,
  rawStart: number,
  rawEnd: number,
): AssistantTextSelectorFields | null {
  const quote = text.slice(rawStart, rawEnd);
  if (quote.trim().length === 0) return null;

  const normalized = normalizeWhitespace(text);
  let start = normalizeWhitespace(text.slice(0, rawStart)).length;
  // A selection starting inside a whitespace run includes its normalized space.
  if (rawStart > 0 && /\s/.test(text[rawStart - 1]!) && /\s/.test(text[rawStart]!)) {
    start -= 1;
  }
  const end = normalizeWhitespace(text.slice(0, rawEnd)).length;
  let prefixStart = Math.max(0, start - ASSISTANT_CITATION_CONTEXT_LENGTH);
  let suffixEnd = Math.min(normalized.length, end + ASSISTANT_CITATION_CONTEXT_LENGTH);
  // A split pair becomes a replacement character when the context enters a URL.
  if (splitsSurrogatePair(normalized, prefixStart)) prefixStart += 1;
  if (splitsSurrogatePair(normalized, suffixEnd)) suffixEnd -= 1;
  return {
    text: quote,
    start,
    end,
    prefix: normalized.slice(prefixStart, start),
    suffix: normalized.slice(end, suffixEnd),
  };
}
