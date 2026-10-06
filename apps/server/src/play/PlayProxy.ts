// @effect-diagnostics nodeBuiltinImport:off - createPlayHttpServer configures the Node HTTP server.
/**
 * Authenticated reverse proxy from `/play/*` to a loopback "play server" (fork-only).
 *
 * Polyzonia's play server (`scripts/web/play_server.py` in that repo) serves every
 * worktree's web build at `/play/<worktree>/` on 127.0.0.1. Reusing the T3 origin
 * is what lets a phone reach it over the connection it already has (T3 Connect,
 * Tailscale or LAN) without exposing anything else.
 *
 * Access is an environment session (read scope; operate for writes) or the play
 * cookie. A phone's browser has no T3 session, so an agent posts a one-time link
 * `https://<host>/play/<wt>/#ticket=<ticket>`: without access, page loads get a
 * small page that redeems the fragment's ticket (`POST /play/__auth/redeem`) for
 * an HttpOnly cookie on `Path=/play`. Tickets come from `POST /play/__auth/ticket`
 * with an operate session or the `play-proxy` secret (local scripts read it from
 * the secrets folder) as `{"key": "<hex>"}` in the JSON body, or in
 * `authorization: T3Play <hex>`. Secrets never go in query strings or in headers
 * the HTTP tracer records: request URLs and headers are traced (to
 * `server.trace.ndjson`), bodies are not. The old `x-t3-play-key` header still
 * works for scripts from before, and is redacted from traces like `authorization`.
 *
 * Every response is `Cache-Control: private` (Cloudflare caches public responses
 * on T3 Connect hostnames). The client is node:http, which never decompresses, so
 * precompressed files keep their Content-Encoding.
 *
 * Optional `<state dir>/play-proxy.json`: `{"enabled": false}` turns the route off,
 * `"upstream"` (loopback http, default http://127.0.0.1:8790), `"publicOrigin"`
 * for minted links.
 */
import * as NodeHttp from "node:http";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  PLAY_COOKIE_MAX_AGE_SECONDS,
  PLAY_COOKIE_NAME,
  PLAY_TICKET_DEFAULT_TTL_SECONDS,
  keyMatches,
  makeCookieValue,
  makeTicket,
  playCookieHeader,
  readCookie,
  verifyCookieValue,
  verifyTicket,
} from "./playTokens.ts";

const PLAY_ROUTE_PREFIX = "/play";
const PLAY_SECRET_NAME = "play-proxy";
const DEFAULT_UPSTREAM = "http://127.0.0.1:8790";
const CONFIG_FILE = "play-proxy.json";
const REDEEMED_FILE = "play-proxy-redeemed.json";
/** Flag uploads (zipped saves, recordings, screenshots); Cloudflare caps bodies at 100 MB. */
const PLAY_MAX_REQUEST_BYTES = 100 * 1024 * 1024;
/** The old header local scripts sent the secret in (still accepted, never traced). */
const PLAY_KEY_HEADER = "x-t3-play-key";

/**
 * Header names the HTTP tracer records as `<redacted>`: Effect's defaults
 * (Headers.CurrentRedactedNames) and the play key's old header. The play routes
 * provide it to the whole server (HttpRouter.serve takes it from the routes).
 */
export const PLAY_REDACTED_HEADER_NAMES: ReadonlyArray<string | RegExp> = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  PLAY_KEY_HEADER,
];
const redactedHeaderNamesLayer = Layer.succeed(Headers.CurrentRedactedNames)(
  PLAY_REDACTED_HEADER_NAMES,
);

/**
 * Node's HTTP server cuts a request that takes longer than `requestTimeout`
 * (300 s by default) to arrive. A flag upload from a phone on a slow uplink
 * can take longer, and the page would send it again from the start every
 * time. Headers must still arrive within `headersTimeout` (60 s).
 */
export const PLAY_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

/** The T3 server's node:http server (server.ts), with room for slow /play uploads. */
export const createPlayHttpServer = () =>
  NodeHttp.createServer({ requestTimeout: PLAY_REQUEST_TIMEOUT_MS });

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cookie",
  "authorization",
  "dpop",
  "origin",
  "content-length",
  "x-t3-play-key",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
]);

const PAGE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const PlayProxyConfigFile = Schema.fromJsonString(
  Schema.Struct({
    enabled: Schema.optional(Schema.Boolean),
    upstream: Schema.optional(Schema.String),
    publicOrigin: Schema.optional(Schema.String),
  }),
);
const decodeConfigFile = Schema.decodeUnknownEffect(PlayProxyConfigFile);
const RedeemedFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Number));
const decodeRedeemed = Schema.decodeUnknownEffect(RedeemedFile);
const encodeRedeemed = Schema.encodeEffect(RedeemedFile);
const TicketResponse = Schema.fromJsonString(
  Schema.Struct({
    ticket: Schema.String,
    expiresAt: Schema.String,
    publicOrigin: Schema.NullOr(Schema.String),
  }),
);
const encodeTicketResponse = Schema.encodeEffect(TicketResponse);

interface PlayProxyConfig {
  readonly enabled: boolean;
  readonly upstream: URL;
  readonly publicOrigin: string | undefined;
}

const DEFAULT_CONFIG: PlayProxyConfig = {
  enabled: true,
  upstream: new URL(DEFAULT_UPSTREAM),
  publicOrigin: undefined,
};

const isLoopbackHost = (hostname: string) =>
  ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname.toLowerCase());

/** A loopback http upstream only: the route must never become an open proxy. */
const parseUpstream = (value: string | undefined) => {
  if (value === undefined || !URL.canParse(value)) return DEFAULT_CONFIG.upstream;
  const url = new URL(value);
  return url.protocol === "http:" && isLoopbackHost(url.hostname) ? url : DEFAULT_CONFIG.upstream;
};

/** The origin the browser used: T3 Connect's tunnel says https in x-forwarded-proto. */
const requestOrigin = (request: HttpServerRequest.HttpServerRequest) => {
  const forwarded = request.headers["x-forwarded-proto"]?.split(",")[0]?.trim();
  const proto = forwarded === "https" ? "https" : "http";
  return { proto, origin: `${proto}://${request.headers.host ?? ""}` };
};

const isPageLoad = (request: HttpServerRequest.HttpServerRequest) =>
  (request.method === "GET" || request.method === "HEAD") &&
  (request.headers["sec-fetch-dest"] === "document" ||
    (request.headers.accept ?? "").includes("text/html"));

/** Writes must come from a page of this origin (or from no page at all, like curl). */
const sameOriginWrite = (request: HttpServerRequest.HttpServerRequest) => {
  const origin = request.headers.origin;
  return origin === undefined || origin === requestOrigin(request).origin;
};

/** Never cacheable by anyone but the browser. */
export const privateCacheControl = (value: string | undefined) => {
  if (!value) return "private, no-cache";
  const directives = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && part.toLowerCase() !== "public");
  if (!directives.some((part) => /^(private|no-store)$/i.test(part))) directives.unshift("private");
  return directives.join(", ");
};

const SIGN_IN_SCRIPT = `
// A link tapped while this page is open may only change the fragment.
// The page is reopened without its query: a link's query is not carried
// through the sign-in into the game.
const signIn = async () => {
  const message = document.getElementById("message");
  const match = /(?:^#|&)ticket=([^&]+)/.exec(location.hash);
  const page = location.pathname;
  if (match) {
    history.replaceState(null, "", page);
    try {
      const response = await fetch("/play/__auth/redeem", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket: decodeURIComponent(match[1]) }),
      });
      if (response.ok) { location.replace(page); return; }
    } catch (error) {}
  }
  // The cookie is SameSite=Strict: a page opened from another app may have
  // arrived without it. A navigation from this page sends it.
  // Once per page and 10 seconds, so a cookie that never arrives cannot loop.
  let retried = "";
  try { retried = sessionStorage.getItem("t3PlayRetry") || ""; } catch (error) {}
  const [retriedPage, retriedAt] = retried.split("|");
  const mayRetry = retriedPage !== page || Date.now() - Number(retriedAt || 0) > 10000;
  try {
    const check = await fetch("/play/__auth/check", { credentials: "same-origin", cache: "no-store" });
    if (check.ok && mayRetry) {
      try { sessionStorage.setItem("t3PlayRetry", page + "|" + Date.now()); } catch (error) {}
      location.replace(page);
      return;
    }
  } catch (error) {}
  message.textContent = match
    ? "This play link was already used or has expired. Ask the thread for a new one."
    : "Open a play link from a T3 Code thread to sign in this browser.";
};
addEventListener("hashchange", signIn);
signIn();
`;

const htmlPage = (status: number, message: string, script = "") =>
  HttpServerResponse.text(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Polyzonia</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; padding: max(24px, env(safe-area-inset-top)) 24px; font: 17px/1.45 -apple-system, system-ui, sans-serif;
  background: #f6f5f1; color: #1d1f1c; }
@media (prefers-color-scheme: dark) { body { background: #121411; color: #e8e9e4; } }
main { max-width: 32rem; margin: 0 auto; }
</style></head>
<body><main><h1>Polyzonia</h1><p id="message">${message}</p></main>
${script ? `<script>${script}</script>` : ""}</body></html>`,
    { status, headers: PAGE_HEADERS, contentType: "text/html; charset=utf-8" },
  );

const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000));

/** Plain-text error replies, never cached (Cloudflare caches a 404 that says nothing). */
const textReply = (body: string, status: number) =>
  HttpServerResponse.text(body, { status, headers: PAGE_HEADERS });

/**
 * The secret as a local script offers it: `key` in the JSON body (bodies are
 * not traced), `authorization: T3Play <hex>`, or the old `x-t3-play-key`.
 */
const offeredKey = (
  request: HttpServerRequest.HttpServerRequest,
  body: Record<string, unknown>,
): string | undefined => {
  if (typeof body.key === "string") return body.key;
  const scheme = /^T3Play\s+(\S+)$/i.exec(request.headers.authorization ?? "");
  if (scheme) return scheme[1];
  return request.headers[PLAY_KEY_HEADER];
};

const readJsonBody = (request: HttpServerRequest.HttpServerRequest) =>
  request.json.pipe(
    Effect.map((value): Record<string, unknown> =>
      value !== null && typeof value === "object" ? { ...value } : {},
    ),
    Effect.orElseSucceed((): Record<string, unknown> => ({})),
  );

const sessionAllows = (request: HttpServerRequest.HttpServerRequest, write: boolean) =>
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth
      .authenticateHttpRequest(request)
      .pipe(Effect.orElseSucceed(() => null));
    return (
      session !== null &&
      session.scopes.includes(write ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope)
    );
  });

/** The route's state: its secret, config file, redeemed tickets and HTTP client. */
const makePlayProxy = Effect.fn("PlayProxy.make")(function* (input: {
  readonly stateDir: string;
  readonly key: Uint8Array | null;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const configPath = path.join(input.stateDir, CONFIG_FILE);
  const redeemedPath = path.join(input.stateDir, REDEEMED_FILE);
  const configCache = yield* Ref.make<{ readonly mtime: number; readonly config: PlayProxyConfig }>(
    {
      mtime: -1,
      config: DEFAULT_CONFIG,
    },
  );
  const redeemed = yield* Ref.make<Map<string, number> | null>(null);
  const redeemLock = yield* Semaphore.make(1);
  const learnedOrigin = yield* Ref.make<string | null>(null);

  /** Re-read when the file changes; no file means the defaults. */
  const config = Effect.gen(function* () {
    const info = yield* fs.stat(configPath).pipe(Effect.option);
    if (Option.isNone(info)) return DEFAULT_CONFIG;
    const mtime = Option.getOrElse(
      Option.map(info.value.mtime, (date) => date.getTime()),
      () => 0,
    );
    const cached = yield* Ref.get(configCache);
    if (cached.mtime === mtime) return cached.config;
    const parsed = yield* fs
      .readFileString(configPath)
      .pipe(Effect.flatMap(decodeConfigFile), Effect.option);
    const next: PlayProxyConfig = Option.match(parsed, {
      onNone: () => DEFAULT_CONFIG,
      onSome: (file) => ({
        enabled: file.enabled !== false,
        upstream: parseUpstream(file.upstream),
        publicOrigin:
          file.publicOrigin !== undefined && /^https?:\/\/[^/]+$/.test(file.publicOrigin)
            ? file.publicOrigin
            : undefined,
      }),
    });
    yield* Ref.set(configCache, { mtime, config: next });
    return next;
  });

  /** True when the ticket was not redeemed before (and now is). */
  const claimTicket = (id: string, expiresAt: number, now: number) =>
    redeemLock.withPermits(1)(
      Effect.gen(function* () {
        let used = yield* Ref.get(redeemed);
        if (used === null) {
          const stored = yield* fs
            .readFileString(redeemedPath)
            .pipe(Effect.flatMap(decodeRedeemed), Effect.option);
          used = new Map(Object.entries(Option.getOrElse(stored, () => ({}))));
        }
        for (const [nonce, expiry] of used) if (expiry <= now) used.delete(nonce);
        if (used.has(id)) {
          yield* Ref.set(redeemed, used);
          return false;
        }
        used.set(id, expiresAt);
        yield* Ref.set(redeemed, used);
        const contents = yield* encodeRedeemed(Object.fromEntries(used));
        yield* writeFileStringAtomically({ filePath: redeemedPath, contents }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("play proxy: could not keep a redeemed ticket", error),
          ),
        );
        return true;
      }),
    );

  const newCookie = (key: Uint8Array, request: HttpServerRequest.HttpServerRequest, now: number) =>
    playCookieHeader(
      makeCookieValue(key, now),
      requestOrigin(request).proto === "https",
      PLAY_COOKIE_MAX_AGE_SECONDS,
    );

  const redeem = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      if (request.method !== "POST") return textReply("Method Not Allowed", 405);
      if (!sameOriginWrite(request)) return textReply("Forbidden", 403);
      const body = yield* readJsonBody(request);
      const now = yield* nowSeconds;
      const verified =
        input.key && typeof body.ticket === "string"
          ? verifyTicket(input.key, body.ticket, now)
          : null;
      if (!input.key || !verified || !(yield* claimTicket(verified.id, verified.expiresAt, now))) {
        return textReply("This play link was already used or has expired.", 401);
      }
      return HttpServerResponse.empty({
        status: 204,
        headers: { ...PAGE_HEADERS, "set-cookie": newCookie(input.key, request, now) },
      });
    });

  const mint = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      if (request.method !== "POST") return textReply("Method Not Allowed", 405);
      const key = input.key;
      const body = yield* readJsonBody(request);
      const allowed =
        key !== null &&
        (keyMatches(key, offeredKey(request, body)) || (yield* sessionAllows(request, true)));
      if (!allowed || key === null) return textReply("Unauthorized", 401);
      const ttl =
        typeof body.ttlSeconds === "number" ? body.ttlSeconds : PLAY_TICKET_DEFAULT_TTL_SECONDS;
      const { ticket, expiresAt } = makeTicket(key, yield* nowSeconds, ttl);
      const publicOrigin = (yield* config).publicOrigin ?? (yield* Ref.get(learnedOrigin));
      const json = yield* encodeTicketResponse({
        ticket,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt * 1000)),
        publicOrigin,
      });
      return HttpServerResponse.text(json, {
        status: 200,
        headers: PAGE_HEADERS,
        contentType: "application/json",
      });
    });

  /** "cookie" (and whether to renew it), "session", or null. */
  const access = (request: HttpServerRequest.HttpServerRequest, write: boolean) =>
    Effect.gen(function* () {
      const cookie = readCookie(request.headers.cookie, PLAY_COOKIE_NAME);
      if (cookie && input.key) {
        const now = yield* nowSeconds;
        const verified = verifyCookieValue(input.key, cookie, now);
        if (verified) {
          return {
            via: "cookie" as const,
            renew: verified.expiresAt - now < PLAY_COOKIE_MAX_AGE_SECONDS / 2,
          };
        }
      }
      return (yield* sessionAllows(request, write))
        ? { via: "session" as const, renew: false }
        : null;
    });

  const forwardHeaders = (request: HttpServerRequest.HttpServerRequest, upstream: URL) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (DROPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
      headers[name] = value;
    }
    headers["x-forwarded-proto"] = requestOrigin(request).proto;
    if (request.headers.host) headers["x-forwarded-host"] = request.headers.host;
    // The origin was checked here; the play server only accepts its own.
    if (request.headers.origin !== undefined) headers.origin = upstream.origin;
    return headers;
  };

  const unavailable = (request: HttpServerRequest.HttpServerRequest, upstream: URL) =>
    isPageLoad(request)
      ? htmlPage(
          502,
          `The Polyzonia play server is not running on this Mac (${upstream.host}). Start it with <code>scripts/play_web.sh</code>.`,
        )
      : textReply("The Polyzonia play server is not running.", 502);

  const proxy = (
    request: HttpServerRequest.HttpServerRequest,
    upstream: URL,
    pathAndQuery: string,
    setCookie: string | undefined,
  ) =>
    Effect.gen(function* () {
      const write = request.method !== "GET" && request.method !== "HEAD";
      const length = request.headers["content-length"];
      const outgoing = HttpClientRequest.make(request.method)(
        new URL(pathAndQuery, upstream).toString(),
      ).pipe(
        HttpClientRequest.setHeaders(forwardHeaders(request, upstream)),
        write
          ? HttpClientRequest.bodyStream(request.stream, {
              contentType: request.headers["content-type"] ?? "application/octet-stream",
              ...(length !== undefined ? { contentLength: Number(length) } : {}),
            })
          : (self) => self,
      );
      const response = yield* client.execute(outgoing).pipe(Effect.option);
      if (Option.isNone(response)) return unavailable(request, upstream);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.value.headers)) {
        if (!DROPPED_RESPONSE_HEADERS.has(name)) headers[name] = value;
      }
      headers["cache-control"] = privateCacheControl(headers["cache-control"]);
      if (setCookie) headers["set-cookie"] = setCookie;
      const status = response.value.status;
      if (request.method === "HEAD" || status === 204 || status === 304) {
        return HttpServerResponse.empty({ status, headers });
      }
      return HttpServerResponse.stream(response.value.stream, {
        status,
        headers,
        ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
      });
    });

  // The route handler itself: an Effect run once per request.
  // @effect-diagnostics-next-line returnEffectInGen:off
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const current = yield* config;
    const url = HttpServerRequest.toURL(request);
    if (!current.enabled || Option.isNone(url)) return textReply("Not Found", 404);
    const { pathname, search } = url.value;
    if (pathname === PLAY_ROUTE_PREFIX) {
      return HttpServerResponse.empty({
        status: 302,
        headers: { ...PAGE_HEADERS, location: `${PLAY_ROUTE_PREFIX}/${search}` },
      });
    }
    if (!pathname.startsWith(`${PLAY_ROUTE_PREFIX}/`)) return textReply("Bad Request", 400);
    if (pathname === "/play/__auth/redeem") return yield* redeem(request);
    if (pathname === "/play/__auth/ticket") return yield* mint(request);
    if (pathname === "/play/__auth/logout") {
      // A write like any other: a link or another site's page cannot sign this
      // browser out.
      if (request.method !== "POST") return textReply("Method Not Allowed", 405);
      if (!sameOriginWrite(request)) return textReply("Forbidden", 403);
      return HttpServerResponse.empty({
        status: 204,
        headers: {
          ...PAGE_HEADERS,
          "set-cookie": playCookieHeader("", requestOrigin(request).proto === "https", 0),
        },
      });
    }

    const write = request.method !== "GET" && request.method !== "HEAD";
    const allowed = yield* access(request, write);
    if (pathname === "/play/__auth/check") {
      return HttpServerResponse.empty({ status: allowed ? 204 : 401, headers: PAGE_HEADERS });
    }
    if (!allowed || !input.key) {
      return isPageLoad(request)
        ? htmlPage(401, "Signing in…", SIGN_IN_SCRIPT)
        : textReply("Open a play link from a T3 Code thread first.", 401);
    }
    const { proto, origin } = requestOrigin(request);
    const hostname = (request.headers.host ?? "").replace(/:\d+$/, "");
    if (proto === "https" && !isLoopbackHost(hostname)) yield* Ref.set(learnedOrigin, origin);
    if (write) {
      if (!sameOriginWrite(request)) return textReply("Forbidden", 403);
      const length = request.headers["content-length"];
      if (length === undefined) return textReply("Length Required", 411);
      if (!(Number(length) <= PLAY_MAX_REQUEST_BYTES)) return textReply("Payload Too Large", 413);
    }
    const setCookie = allowed.renew ? newCookie(input.key, request, yield* nowSeconds) : undefined;
    return yield* proxy(request, current.upstream, `${pathname}${search}`, setCookie);
  });
});

/** The routes, for a state dir and secret; requires FileSystem, Path and an HttpClient. */
export const makePlayProxyRoutes = (input: {
  readonly stateDir: string;
  readonly key: Uint8Array | null;
}) =>
  Layer.unwrap(
    // The wildcard route also takes the bare prefix.
    Effect.map(makePlayProxy(input), (handler) =>
      Layer.merge(HttpRouter.add("*", `${PLAY_ROUTE_PREFIX}/*`, handler), redactedHeaderNamesLayer),
    ),
  );

export const playProxyRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    // Created at startup so local scripts can mint links before the first visit.
    const key = yield* secrets
      .getOrCreateRandom(PLAY_SECRET_NAME, 32)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("play proxy disabled: no signing secret", error).pipe(Effect.as(null)),
        ),
      );
    return makePlayProxyRoutes({ stateDir: config.stateDir, key });
  }),
  // node:http hands bodies through as they are; fetch would decode them.
).pipe(Layer.provide(NodeHttpClient.layerNodeHttp));
