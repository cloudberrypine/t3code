import {
  AssistantCitation,
  type EnvironmentId,
  type MessageId,
  type ThreadId,
} from "@t3tools/contracts";
import { assistantTextSelector } from "@t3tools/shared/assistantCitationSelector";
import {
  collectAssistantCitations,
  parseAssistantCitationHref,
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeCitation = Schema.decodeUnknownOption(AssistantCitation);

/**
 * A desktop-shaped citation of text selected in one of an assistant message's native text
 * views. The native string holds U+FFFC placeholders (each with an NBSP spacer) for inline
 * icons and chips that desktop's DOM text does not have, so they are dropped first.
 */
export function assistantCitationFromSelection(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}): AssistantCitation | null {
  let clean = "";
  let start = -1;
  let end = -1;
  for (let index = 0; index <= input.text.length; index++) {
    if (index === input.start) start = clean.length;
    if (index === input.end) end = clean.length;
    if (index === input.text.length) break;
    const character = input.text[index]!;
    if (character === "￼") continue;
    if (character === " " && input.text[index - 1] === "￼") continue;
    clean += character;
  }
  if (start < 0 || end <= start) return null;
  const selector = assistantTextSelector(clean, start, end);
  if (!selector) return null;
  return Option.getOrNull(
    decodeCitation({
      version: 1,
      environmentId: input.environmentId,
      threadId: input.threadId,
      messageId: input.messageId,
      ...selector,
    }),
  );
}

/** The composer source for a citation, as desktop inserts it. */
export function assistantCitationSource(citation: AssistantCitation, comment = ""): string {
  return serializeAssistantCitation(withAssistantCitationComment(citation, comment));
}

export function parseAssistantCitationSource(source: string): AssistantCitation | null {
  const match = /^\[Assistant quote\]\((.+)\)$/s.exec(source);
  return match ? parseAssistantCitationHref(match[1]!) : null;
}

const LABEL_QUOTE_LENGTH = 36;

/** Composer chips for citations, collapsed like context references. */
export function assistantCitationEditorTokens(text: string) {
  return collectAssistantCitations(text).map(({ citation, source, start, end }) => {
    const quote = citation.text.replace(/\s+/g, " ").trim();
    const excerpt =
      quote.length > LABEL_QUOTE_LENGTH ? `${quote.slice(0, LABEL_QUOTE_LENGTH - 1)}…` : quote;
    return {
      type: "citation" as const,
      source,
      start,
      end,
      value: `“${excerpt}”${citation.comment ? " · comment" : ""}`,
    };
  });
}
