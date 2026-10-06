import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  environmentPlayOrigins,
  PLAY_SERVER_CHECKING,
  resolvePlayLink,
  threadPlayState,
  type PlayServerState,
} from "@t3tools/client-runtime/polyzonia-play";
import {
  createPlayServerAtoms,
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
import type { PlayWebBuildButton } from "./playWebBuildButton";

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

const playServer = createPlayServerAtoms(connectionAtomRuntime);
const NO_PLAY_SERVER_ATOM = Atom.make<PlayServerState>(PLAY_SERVER_CHECKING).pipe(
  Atom.withLabel("mobile-play-server:none"),
);
const NO_PREPARED_CONNECTION_ATOM = Atom.make(Option.none<PreparedConnection>()).pipe(
  Atom.withLabel("mobile-play-prepared-connection:none"),
);

const NOTHING_TO_PLAY = () => {};

/**
 * "Play web build" for a thread: opens the play screen at its worktree's
 * build. Loading until the environment's play server has answered since the
 * app connected; null (no button) once it does not serve the thread's
 * repository. Follows connects and reconnects while the thread is open.
 */
export function useThreadPlayWebBuild(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectRoot: string | null;
  readonly worktreePath: string | null;
}): PlayWebBuildButton | null {
  const { environmentId, projectRoot, worktreePath } = input;
  const navigation = useNavigation();
  const server = useAtomValue(
    environmentId === null ? NO_PLAY_SERVER_ATOM : playServer.playServerValueAtom(environmentId),
  );
  const prepared = useAtomValue(
    environmentId === null
      ? NO_PREPARED_CONNECTION_ATOM
      : environmentSession.preparedConnectionValueAtom(environmentId),
  );
  const state =
    environmentId === null
      ? null
      : threadPlayState({
          httpBaseUrl: Option.getOrNull(prepared)?.httpBaseUrl ?? null,
          playServer: server,
          projectRoot,
          worktreePath,
        });
  const url = state?.status === "ready" ? state.url : null;
  const loading = state?.status === "loading";
  return useMemo(() => {
    if (loading) return { loading: true, onPress: NOTHING_TO_PLAY };
    if (url === null || environmentId === null) return null;
    return {
      loading: false,
      url,
      onPress: () => {
        void Haptics.selectionAsync();
        navigation.navigate("Play", { url, environmentId });
      },
    };
  }, [environmentId, loading, navigation, url]);
}
