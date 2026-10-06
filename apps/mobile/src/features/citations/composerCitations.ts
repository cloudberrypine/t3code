import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { Alert, Platform } from "react-native";

import { showTextInputDialog } from "../../components/ConfirmDialogHost";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  getComposerDraftSnapshot,
  insertComposerDraftContext,
  setComposerDraftText,
} from "../../state/use-composer-drafts";
import {
  assistantCitationFromSelection,
  assistantCitationSource,
  parseAssistantCitationSource,
} from "./assistantCitation";

/** Replaces one citation's source in a draft, keeping everything around it. */
export function replaceDraftCitation(
  draftKey: string,
  range: { readonly start: number; readonly end: number; readonly source: string },
  next: string,
): boolean {
  const { text } = getComposerDraftSnapshot(draftKey);
  if (text.slice(range.start, range.end) !== range.source) return false;
  setComposerDraftText(draftKey, `${text.slice(0, range.start)}${next}${text.slice(range.end)}`);
  return true;
}

function promptComment(input: {
  readonly title: string;
  readonly initialValue: string;
  readonly confirmText: string;
  readonly cancelText: string;
  readonly onConfirm: (comment: string) => void;
  readonly onCancel?: () => void;
}) {
  if (Platform.OS === "ios") {
    Alert.prompt(
      input.title,
      undefined,
      [
        { text: input.cancelText, style: "cancel", onPress: () => input.onCancel?.() },
        { text: input.confirmText, onPress: (value?: string) => input.onConfirm(value ?? "") },
      ],
      "plain-text",
      input.initialValue,
    );
    return;
  }
  showTextInputDialog({
    title: input.title,
    initialValue: input.initialValue,
    confirmText: input.confirmText,
    cancelText: input.cancelText,
    onConfirm: input.onConfirm,
    ...(input.onCancel ? { onCancel: input.onCancel } : {}),
  });
}

/**
 * "Cite" on selected assistant text: the quote goes into the thread's composer draft as
 * desktop's citation link (a chip), with an optional comment asked for right away.
 */
export function citeAssistantText(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly selection: { readonly text: string; readonly start: number; readonly end: number };
}): void {
  const citation = assistantCitationFromSelection({ ...input, ...input.selection });
  if (!citation) {
    Alert.alert("Unable to cite", "Select some text, up to 8,000 characters.");
    return;
  }
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  const draftKey = scopedThreadKey(input.environmentId, input.threadId);
  const insert = (comment: string) =>
    insertComposerDraftContext(draftKey, {
      text: assistantCitationSource(citation, comment),
      context: { version: 1, records: [] },
    });
  if (Platform.OS === "ios") {
    // iOS prompts accept an empty comment, so the quote is added only when confirmed.
    promptComment({
      title: "Comment on quote",
      initialValue: "",
      confirmText: "Add quote",
      cancelText: "Cancel",
      onConfirm: insert,
    });
    return;
  }
  // Android's dialog needs text to confirm, so the quote is added first and Skip keeps it bare.
  insert("");
  const source = assistantCitationSource(citation);
  promptComment({
    title: "Comment on quote",
    initialValue: "",
    confirmText: "Add",
    cancelText: "Skip",
    onConfirm: (comment) => {
      const { text } = getComposerDraftSnapshot(draftKey);
      const start = text.lastIndexOf(source);
      if (start >= 0)
        replaceDraftCitation(
          draftKey,
          { start, end: start + source.length, source },
          assistantCitationSource(citation, comment),
        );
    },
  });
}

/** A tapped citation chip edits its comment. Returns false for any other chip. */
export function editDraftCitationComment(
  draftKey: string,
  chip: { readonly source: string; readonly start: number; readonly end: number },
): boolean {
  const citation = parseAssistantCitationSource(chip.source);
  if (!citation) return false;
  promptComment({
    title: "Comment on quote",
    initialValue: citation.comment ?? "",
    confirmText: "Save",
    cancelText: "Cancel",
    onConfirm: (comment) =>
      void replaceDraftCitation(draftKey, chip, assistantCitationSource(citation, comment)),
  });
  return true;
}
