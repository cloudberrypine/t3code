import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  environmentPlayOrigins,
  resolvePlayLink,
  threadPlayPageUrl,
} from "@t3tools/client-runtime/polyzonia-play";
import {
  createPlayRepositoryAtoms,
  mintPlayTicket,
} from "@t3tools/client-runtime/state/polyzonia-play";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { connectionAtomRuntime } from "../../connection/runtime";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { environmentSession } from "../../state/session";
import type { PlayEnvironments } from "./playRoute";

function samePlayEnvironments(left: PlayEnvironments, right: PlayEnvironments): boolean {
  if (left.ready !== right.ready || left.origins.size !== right.origins.size) return false;
  for (const [environmentId, origins] of left.origins) {
    const other = right.origins.get(environmentId);
    if (other === undefined || other.join(" ") !== origins.join(" ")) return false;
  }
  return true;
}

/**
 * Every enabled environment's addresses: saved direct routes, the live
 * connection's, and T3 Connect's endpoint. Compared by value, so subscribers
 * only re-render when an address changes.
 */
const playEnvironmentsAtom = Atom.make((get): PlayEnvironments => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const relay = get(relayEnvironmentDiscovery.stateValueAtom).environments;
  const origins = new Map<EnvironmentId, ReadonlyArray<string>>();
  for (const [environmentId, entry] of catalog.entries) {
    if (!entry.enabled) continue;
    const prepared = Option.getOrNull(
      get(environmentSession.preparedConnectionValueAtom(environmentId)),
    );
    origins.set(
      environmentId,
      environmentPlayOrigins({
        entry,
        httpBaseUrls: [
          prepared?.httpBaseUrl,
          relay.get(environmentId)?.environment.endpoint.httpBaseUrl,
        ],
      }),
    );
  }
  return { ready: catalog.isReady, origins };
}).pipe(Atom.withEquality(samePlayEnvironments), Atom.withLabel("mobile-play-environments"));

export function usePlayEnvironments(): PlayEnvironments {
  return useAtomValue(playEnvironmentsAtom);
}

export const mintPlayTicketCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:play:mint-ticket",
  execute: (prepared: PreparedConnection) => mintPlayTicket({ prepared }),
});

/**
 * Opens play links in the app's play screen: true when `href` was one, on a
 * saved environment's own address (the thread's first).
 */
export function usePlayLinkOpener(environmentId: EnvironmentId | null): (href: string) => boolean {
  const navigation = useNavigation();
  // Compared by value: changes only when an address does.
  const { origins } = usePlayEnvironments();
  return useCallback(
    (href: string) => {
      const request = resolvePlayLink(href, origins, environmentId);
      if (request === null) return false;
      void Haptics.selectionAsync();
      navigation.navigate("Play", {
        url: request.url.toString(),
        environmentId: request.environmentId,
      });
      return true;
    },
    [environmentId, navigation, origins],
  );
}

const playRepository = createPlayRepositoryAtoms(
  connectionAtomRuntime,
  environmentSession.preparedConnectionValueAtom,
);
const NO_PLAY_REPOSITORY_ATOM = Atom.make<string | null>(null).pipe(
  Atom.withLabel("mobile-play-repository:none"),
);
const NO_PREPARED_CONNECTION_ATOM = Atom.make(Option.none<PreparedConnection>()).pipe(
  Atom.withLabel("mobile-play-prepared-connection:none"),
);

/**
 * "Play web build" for a thread: opens the play screen at its worktree's
 * build. Null (no button) unless the environment's play server serves the
 * thread's repository.
 */
export function useThreadPlayWebBuild(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectRoot: string | null;
  readonly worktreePath: string | null;
}): (() => void) | null {
  const { environmentId, projectRoot, worktreePath } = input;
  const navigation = useNavigation();
  const repository = useAtomValue(
    environmentId === null
      ? NO_PLAY_REPOSITORY_ATOM
      : playRepository.playRepositoryValueAtom(environmentId),
  );
  const prepared = useAtomValue(
    environmentId === null
      ? NO_PREPARED_CONNECTION_ATOM
      : environmentSession.preparedConnectionValueAtom(environmentId),
  );
  const httpBaseUrl = Option.getOrNull(prepared)?.httpBaseUrl ?? null;
  const url =
    httpBaseUrl === null
      ? null
      : threadPlayPageUrl({ httpBaseUrl, playRepository: repository, projectRoot, worktreePath });
  return useMemo(
    () =>
      url === null || environmentId === null
        ? null
        : () => {
            void Haptics.selectionAsync();
            navigation.navigate("Play", { url, environmentId });
          },
    [environmentId, navigation, url],
  );
}
