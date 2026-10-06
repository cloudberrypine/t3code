import { assistantTextSelector } from "@t3tools/shared/assistantCitationSelector";
import { describe, expect, it } from "vite-plus/test";

import { createAssistantTextSelector } from "./assistantTextSelection";

// Mobile builds citation selectors with the shared copy; it must match desktop's.
describe("assistant citation selectors", () => {
  const text =
    "First paragraph with   extra   spaces.\n\nSecond 😀 paragraph quotes `code` and more text after it for context.";
  it.each([
    [0, 5],
    [6, 30],
    [21, 25],
    [44, 60],
    [48, 50],
    [text.length - 20, text.length],
    [3, 3],
    [38, 40],
  ])("match desktop for %i-%i", (start, end) => {
    expect(assistantTextSelector(text, start, end)).toEqual(
      createAssistantTextSelector(text, start, end),
    );
  });
});
