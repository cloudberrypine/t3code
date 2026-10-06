import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  assistantCitationsToPlainText,
  collectAssistantCitations,
} from "@t3tools/shared/assistantCitations";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import { describe, expect, it } from "vite-plus/test";

import { composerContextEditorTokens } from "../../lib/composerContext";
import {
  assistantCitationEditorTokens,
  assistantCitationFromSelection,
  assistantCitationSource,
  parseAssistantCitationSource,
} from "./assistantCitation";

const source = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
};

describe("assistant citations from a native selection", () => {
  it("quote the selected text with desktop's selector, ignoring inline icon placeholders", () => {
    const text = "Open ￼ main.ts and   check the loop before release.";
    const start = text.indexOf("check");
    const citation = assistantCitationFromSelection({
      ...source,
      text,
      start,
      end: start + "check the loop".length,
    });
    expect(citation).toEqual({
      version: 1,
      ...source,
      text: "check the loop",
      start: "Open main.ts and ".length,
      end: "Open main.ts and check the loop".length,
      prefix: "Open main.ts and ",
      suffix: " before release.",
    });
  });

  it("round-trips through the composer source desktop inserts, comment included", () => {
    const citation = assistantCitationFromSelection({
      ...source,
      text: "Use a mutex here.",
      start: 6,
      end: 11,
    })!;
    const withComment = assistantCitationSource(citation, "  Why not a channel?  ");
    expect(
      withComment.startsWith("[Assistant quote](t3-citation://v1/env-1/thread-1/message-1?"),
    ).toBe(true);
    expect(parseAssistantCitationSource(withComment)).toEqual({
      ...citation,
      comment: "Why not a channel?",
    });
    expect(assistantCitationsToPlainText(withComment)).toBe("mutex\nComment: Why not a channel?");
    expect(parseAssistantCitationSource(assistantCitationSource(citation))).toEqual(citation);
  });

  it("rejects blank or over-long selections", () => {
    expect(assistantCitationFromSelection({ ...source, text: "a   b", start: 1, end: 4 })).toBe(
      null,
    );
    const long = "x".repeat(8_001);
    expect(
      assistantCitationFromSelection({ ...source, text: long, start: 0, end: long.length }),
    ).toBe(null);
  });
});

describe("citation chips in the composer", () => {
  it("collapse each citation into one chip, several per message", () => {
    const first = assistantCitationSource(
      assistantCitationFromSelection({ ...source, text: "alpha beta", start: 0, end: 5 })!,
    );
    const second = assistantCitationSource(
      assistantCitationFromSelection({
        ...source,
        text: "a much longer quoted sentence that goes on and on and on",
        start: 0,
        end: 56,
      })!,
      "why?",
    );
    const text = `See ${first} and ${second} in [main.ts](src/main.ts) now`;
    expect(collectAssistantCitations(text)).toHaveLength(2);
    const chips = assistantCitationEditorTokens(text);
    expect(chips.map((chip) => chip.value)).toEqual([
      "“alpha”",
      "“a much longer quoted sentence that …” · comment",
    ]);
    expect(chips.map((chip) => text.slice(chip.start, chip.end))).toEqual([first, second]);

    const tokens = composerContextEditorTokens(text, collectComposerInlineTokens(text));
    expect(tokens.map((token) => token.type)).toEqual(["citation", "citation", "mention"]);
  });
});
