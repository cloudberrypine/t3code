/**
 * Requests to an environment's play routes made with the client's own session
 * (fork-only; see ../polyzoniaPlay.ts and apps/server/src/play/PlayProxy.ts).
 * Bearer, DPoP and cookie connections all authenticate as they do for the
 * HTTP API.
 *
 * - Play tickets: a client that opens a play page in its own web view signs
 *   that view in with a fresh ticket instead of spending the one in a posted
 *   link, which belongs to the phone's browser it was minted for. The proxy
 *   mints for operate sessions.
 * - The play server's repository: threads of that repository get a
 *   "Play web build" action.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { PLAY_HEALTH_PATH, PLAY_TICKET_PATH } from "../polyzoniaPlay.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const TICKET_TIMEOUT_MS = 8_000;
const HEALTH_TIMEOUT_MS = 6_000;
/** Redeemed at once by the view that asked; a short life keeps a stray copy useless. */
const TICKET_TTL_SECONDS = 5 * 60;

const PlayTicketReply = Schema.Struct({
  ticket: Schema.String,
  /** The address the environment gives phones (T3 Connect's, usually), if it knows one. */
  publicOrigin: Schema.NullOr(Schema.String),
});
export type PlayTicketReply = typeof PlayTicketReply.Type;

class PlayTicketRefusedError extends Data.TaggedError("PlayTicketRefusedError")<{
  readonly status: number;
}> {
  override get message(): string {
    return `The environment refused a play ticket (HTTP ${this.status}).`;
  }
}

export const mintPlayTicket = Effect.fn("clientRuntime.state.mintPlayTicket")(function* (input: {
  readonly prepared: PreparedConnection;
}) {
  const httpClient = yield* HttpClient.HttpClient;
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  const response = yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    // The play routes are not part of the HTTP API; only the auth headers are used.
    group: "auth",
    method: "POST",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, PLAY_TICKET_PATH),
    timeoutMs: TICKET_TIMEOUT_MS,
    request: ({ headers, url }) =>
      httpClient.execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeaders({ ...headers }),
          HttpClientRequest.bodyJsonUnsafe({ ttlSeconds: TICKET_TTL_SECONDS }),
        ),
      ),
    // A renewed DPoP token gets one more try, as for the HTTP API.
    isUnauthorizedResponse: (reply) => reply.status === 401,
  });
  if (response.status !== 200) {
    return yield* new PlayTicketRefusedError({ status: response.status });
  }
  return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(PlayTicketReply)));
});

const PlayServerHealth = Schema.Struct({
  /** The checkout the play server serves worktrees of. */
  repo: Schema.String,
});

/**
 * The repository the environment's play server serves, or null when there is
 * none to reach (the proxy is off, the play server is not running).
 */
export const readPlayRepository = Effect.fn("clientRuntime.state.readPlayRepository")(
  function* (input: { readonly prepared: PreparedConnection }) {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    const response = yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: input.prepared,
      signer,
      remoteAuthorization,
      group: "auth",
      method: "GET",
      url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, PLAY_HEALTH_PATH),
      timeoutMs: HEALTH_TIMEOUT_MS,
      request: ({ headers, url }) =>
        httpClient.execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders({ ...headers })),
        ),
      isUnauthorizedResponse: (reply) => reply.status === 401,
    });
    if (response.status !== 200) return null;
    const health = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PlayServerHealth)),
    );
    return health.repo;
  },
);

/**
 * Each environment's play repository, read once per connection and again when
 * a thread mounts after a minute (a play server started later shows up).
 * `playRepositoryValueAtom` is null while unknown or unreachable.
 */
export function createPlayRepositoryAtoms<R, E>(
  runtime: Atom.AtomRuntime<HttpClient.HttpClient | R, E>,
  preparedConnectionValueAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Option.Option<PreparedConnection>>,
) {
  const playRepositoryAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom((get) => {
        const prepared = Option.getOrNull(get(preparedConnectionValueAtom(environmentId)));
        return prepared === null ? Effect.never : readPlayRepository({ prepared });
      })
      .pipe(
        Atom.swr({ staleTime: 60_000, revalidateOnMount: true }),
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`polyzonia-play-repository:${environmentId}`),
      ),
  );

  const playRepositoryValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): string | null =>
        Option.getOrNull(AsyncResult.value(get(playRepositoryAtom(environmentId)))) ?? null,
    ).pipe(Atom.withLabel(`polyzonia-play-repository-value:${environmentId}`)),
  );

  return { playRepositoryValueAtom };
}
