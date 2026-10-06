/**
 * Play tickets minted with the client's own environment session (fork-only;
 * see ../polyzoniaPlay.ts and apps/server/src/play/PlayProxy.ts).
 *
 * A client that opens a play page in its own web view signs that view in with
 * a fresh ticket instead of spending the one in a posted link, which belongs
 * to the phone's browser it was minted for. The proxy mints for operate
 * sessions; bearer, DPoP and cookie connections all authenticate as they do
 * for the HTTP API.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { PLAY_TICKET_PATH } from "../polyzoniaPlay.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const TICKET_TIMEOUT_MS = 8_000;
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
