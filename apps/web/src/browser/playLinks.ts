/**
 * Polyzonia play links in the integrated browser (fork-only; the rule is in
 * client-runtime's polyzoniaPlay.ts).
 *
 * A thread's play link names the address the phone reaches the environment at
 * (T3 Connect's, usually) and carries a ticket meant for the phone's browser.
 * The integrated browser instead opens the same page at the address this
 * client is connected to, signed in with a ticket minted from its own session,
 * so the posted ticket stays unspent. Its browser profile keeps the play
 * cookie, so the game's saves stay with that profile.
 */
import {
  environmentPlayOrigins,
  parsePlayLink,
  playLinkWithTicket,
  resolvePlayLink,
  threadPlayPageUrl,
} from "@t3tools/client-runtime/polyzonia-play";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { PlayTicketReply } from "@t3tools/client-runtime/state/polyzonia-play";
import {
  createPlayRepositoryAtoms,
  mintPlayTicket,
} from "@t3tools/client-runtime/state/polyzonia-play";
import {
  type AtomCommandResult,
  createRuntimeCommand,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readLocalApi } from "~/localApi";
import { environmentSession, readPreparedConnection, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

const mintPlayTicketCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:play:mint-ticket",
  execute: (prepared: PreparedConnection) => mintPlayTicket({ prepared }),
});

/**
 * The URL to open a thread's play link at in the integrated browser, or null
 * when the link is not a play page of the thread's environment (it then
 * belongs to the system browser like any other link). The environment's own
 * idea of its public address comes with the ticket.
 */
export async function resolvePlayLinkForPreview(input: {
  readonly href: string;
  readonly environmentId: EnvironmentId;
  readonly mint: (
    prepared: PreparedConnection,
  ) => Promise<AtomCommandResult<PlayTicketReply, unknown>>;
}): Promise<string | null> {
  const prepared = readPreparedConnection(input.environmentId);
  if (prepared === null) return null;
  const minted = await input.mint(prepared);
  const ticket = minted._tag === "Success" ? minted.value : null;
  const entry = appAtomRegistry
    .get(environmentCatalog.catalogValueAtom)
    .entries.get(input.environmentId);
  const origins = environmentPlayOrigins({
    entry,
    httpBaseUrls: [prepared.httpBaseUrl, ticket?.publicOrigin],
  });
  const request = resolvePlayLink(input.href, new Map([[input.environmentId, origins]]));
  if (request === null) return null;
  // Without a ticket of its own, the view redeems the link's (or shows the
  // page's sign-in prompt).
  return ticket === null
    ? input.href
    : playLinkWithTicket(request.url, ticket.ticket, new URL(prepared.httpBaseUrl).origin);
}

/** Whether a click on `href` is the play opener's to handle. */
export const isPlayLinkHref = (href: string): boolean => parsePlayLink(href) !== null;

/**
 * Opens a thread's play link in the integrated browser at its normal size,
 * whatever "Open links in" says. A link that is not a play page of the
 * thread's environment opens where any other link would: in the integrated
 * browser when `inApp` (the setting's answer for this click), else the
 * system browser.
 */
export function usePlayLinkOpener(
  environmentId: EnvironmentId | null,
  openInPreview: (url: string) => Promise<AtomCommandResult<void, unknown>>,
): (href: string, inApp: boolean) => Promise<void> {
  const mint = useAtomCommand(mintPlayTicketCommand, { reportFailure: false });
  return useCallback(
    async (href: string, inApp: boolean) => {
      const playUrl =
        environmentId === null
          ? null
          : await resolvePlayLinkForPreview({ href, environmentId, mint });
      const url = playUrl ?? (inApp ? href : null);
      if (url !== null) {
        const result = await openInPreview(url);
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
        // Settings that could not be read keep the link here, as for other links
        // (BrowserSettingsReadError, by tag: openFileInPreview is heavy to import).
        const failure = squashAtomCommandFailure(result);
        if (Predicate.isTagged(failure, "BrowserSettingsReadError")) return;
      }
      await readLocalApi()?.shell.openExternal(href);
    },
    [environmentId, mint, openInPreview],
  );
}

const playRepository = createPlayRepositoryAtoms(
  connectionAtomRuntime,
  environmentSession.preparedConnectionValueAtom,
);
const NO_PLAY_REPOSITORY_ATOM = Atom.make<string | null>(null).pipe(
  Atom.withLabel("web-play-repository:none"),
);

/**
 * The address of a thread's "Play web build" (the play server's redirect to
 * its worktree's build), or null unless the environment's play server serves
 * the thread's repository. Open it with `usePlayLinkOpener`.
 */
export function useThreadPlayPageUrl(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectRoot: string | null;
  readonly worktreePath: string | null;
}): string | null {
  const { environmentId, projectRoot, worktreePath } = input;
  const repository = useAtomValue(
    environmentId === null
      ? NO_PLAY_REPOSITORY_ATOM
      : playRepository.playRepositoryValueAtom(environmentId),
  );
  const httpBaseUrl = Option.getOrNull(usePreparedConnection(environmentId))?.httpBaseUrl ?? null;
  return httpBaseUrl === null
    ? null
    : threadPlayPageUrl({ httpBaseUrl, playRepository: repository, projectRoot, worktreePath });
}
