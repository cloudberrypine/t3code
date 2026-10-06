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
 *   "Play web build" action. It is checked on every connect and reconnect, and
 *   again shortly while the play server does not answer.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import {
  PLAY_HEALTH_PATH,
  PLAY_SERVER_CHECKING,
  PLAY_TICKET_PATH,
  type PlayServerState,
} from "../polyzoniaPlay.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { followStreamInEnvironment } from "./runtime.ts";

const TICKET_TIMEOUT_MS = 8_000;
const HEALTH_TIMEOUT_MS = 6_000;
/** How soon a play server that did not answer is asked again. */
const PLAY_SERVER_RETRY = Duration.seconds(15);
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

/** One answer from an environment's play routes. */
export type PlayServerCheck =
  | { readonly _tag: "Serving"; readonly repository: string }
  /** No play route, or this session may not use it: only a reconnect changes that. */
  | { readonly _tag: "Absent" }
  /** The play server is not running, or the request failed: asked again soon. */
  | { readonly _tag: "Unreachable" };

const ABSENT: PlayServerCheck = { _tag: "Absent" };
const UNREACHABLE: PlayServerCheck = { _tag: "Unreachable" };

/** Asks the environment which repository its play server serves (`/play/__health`). */
export const checkPlayServer = Effect.fn("clientRuntime.state.checkPlayServer")(
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
    // 404: no play proxy (or it is off); 401/403: not for this session.
    if (response.status === 404 || response.status === 401 || response.status === 403) {
      return ABSENT;
    }
    if (response.status !== 200) return UNREACHABLE;
    return yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PlayServerHealth)),
      Effect.map((health): PlayServerCheck => ({ _tag: "Serving", repository: health.repo })),
      Effect.orElseSucceed(() => ABSENT),
    );
  },
  Effect.orElseSucceed(() => UNREACHABLE),
);

function stateOf(check: PlayServerCheck): PlayServerState {
  return check._tag === "Serving"
    ? { status: "serving", repository: check.repository }
    : { status: "absent" };
}

const sameState = (left: PlayServerState, right: PlayServerState) =>
  left.status === right.status &&
  (left.status !== "serving" || right.status !== "serving" || left.repository === right.repository);

/**
 * An environment's play server as the connection comes and goes: checked on
 * every connect, and again every `retryEvery` while it does not answer. A
 * disconnect keeps the last answer and stops asking; nothing is emitted
 * before the first answer (the caller starts at "checking").
 */
export function followPlayServer<E, R, R2>(input: {
  readonly connected: Stream.Stream<boolean, E, R>;
  readonly check: Effect.Effect<PlayServerCheck, never, R2>;
  readonly retryEvery?: Duration.Input;
}): Stream.Stream<PlayServerState, E, R | R2> {
  const untilAnswered = Stream.fromEffect(input.check).pipe(
    Stream.repeat(Schedule.spaced(input.retryEvery ?? PLAY_SERVER_RETRY)),
    Stream.takeUntil((check) => check._tag !== "Unreachable"),
  );
  return input.connected.pipe(
    Stream.changes,
    Stream.switchMap((connected) => (connected ? untilAnswered : Stream.empty)),
    Stream.map(stateOf),
    Stream.changesWith(sameState),
  );
}

/**
 * Each environment's play server, followed while a thread shows its "Play web
 * build" (and five minutes after). `playServerValueAtom` is "checking" until
 * the first answer after the client connects.
 */
export function createPlayServerAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  const playServerAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(
        followStreamInEnvironment(
          environmentId,
          Stream.unwrap(
            EnvironmentSupervisor.EnvironmentSupervisor.pipe(
              Effect.map((supervisor) =>
                followPlayServer({
                  connected: SubscriptionRef.changes(supervisor.state).pipe(
                    Stream.map((state) => state.phase === "connected"),
                  ),
                  check: SubscriptionRef.get(supervisor.prepared).pipe(
                    Effect.flatMap(
                      Option.match({
                        onNone: () => Effect.succeed(UNREACHABLE),
                        onSome: (prepared) => checkPlayServer({ prepared }),
                      }),
                    ),
                  ),
                }),
              ),
            ),
          ),
        ),
        { initialValue: PLAY_SERVER_CHECKING },
      )
      .pipe(Atom.setIdleTTL(5 * 60_000), Atom.withLabel(`polyzonia-play-server:${environmentId}`)),
  );

  const playServerValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): PlayServerState =>
      Option.getOrElse(
        AsyncResult.value(get(playServerAtom(environmentId))),
        () => PLAY_SERVER_CHECKING,
      ),
    ).pipe(Atom.withLabel(`polyzonia-play-server-value:${environmentId}`)),
  );

  return { playServerValueAtom };
}
