import { parsePlayLink, resolvePlayLink } from "@t3tools/client-runtime/polyzonia-play";
import type { EnvironmentId } from "@t3tools/contracts";

/**
 * The play screen's route: a thread's play link, or the deep link
 * `<scheme>://play?url=<encoded play link>[&environmentId=<id>]`.
 */
export type PlayRouteParams = {
  readonly url?: string;
  readonly environmentId?: string;
};

/** The addresses each saved environment's play links may use. */
export interface PlayEnvironments {
  /** False until the saved environments have loaded. */
  readonly ready: boolean;
  readonly origins: ReadonlyMap<EnvironmentId, ReadonlyArray<string>>;
}

export type PlayRouteState =
  | { readonly kind: "open"; readonly environmentId: EnvironmentId; readonly url: URL }
  /** An environment's address can arrive with its connection: wait before refusing. */
  | { readonly kind: "waiting" }
  | { readonly kind: "refused" };

/**
 * Only a play page on a saved environment's own address opens: a deep link
 * cannot point the play view, and with it the environment's ticket, anywhere else.
 */
export function resolvePlayRoute(
  params: PlayRouteParams | undefined,
  environments: PlayEnvironments,
  stillConnecting: boolean,
): PlayRouteState {
  const href = params?.url ?? "";
  if (parsePlayLink(href) === null) return { kind: "refused" };
  const preferred = [...environments.origins.keys()].find((id) => id === params?.environmentId);
  const request = resolvePlayLink(href, environments.origins, preferred);
  if (request !== null) return { kind: "open", ...request };
  return !environments.ready || stillConnecting ? { kind: "waiting" } : { kind: "refused" };
}
