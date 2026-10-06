import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

import { citeAssistantText } from "./composerCitations";

const AssistantCitationScopeContext = createContext<{
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
} | null>(null);

/** The thread whose assistant messages can be cited into its own composer. */
export function AssistantCitationScope(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly children: ReactNode;
}) {
  const { environmentId, threadId } = props;
  const scope = useMemo(() => ({ environmentId, threadId }), [environmentId, threadId]);
  return (
    <AssistantCitationScopeContext value={scope}>{props.children}</AssistantCitationScopeContext>
  );
}

/** "Cite" for one assistant message, or undefined outside a thread (no Cite item). */
export function useAssistantCite(messageId: MessageId | undefined) {
  const scope = useContext(AssistantCitationScopeContext);
  const environmentId = scope?.environmentId;
  const threadId = scope?.threadId;
  const cite = useCallback(
    (selection: { readonly text: string; readonly start: number; readonly end: number }) => {
      if (!environmentId || !threadId || !messageId) return;
      citeAssistantText({ environmentId, threadId, messageId, selection });
    },
    [environmentId, messageId, threadId],
  );
  return environmentId && threadId && messageId ? cite : undefined;
}
