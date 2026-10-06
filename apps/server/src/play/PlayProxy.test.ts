// @effect-diagnostics nodeBuiltinImport:off - a real loopback upstream and raw requests check bytes on the wire.
// @effect-diagnostics preferSchemaOverJson:off - the fake upstream speaks plain JSON.
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { httpCompressionLayer } from "../http.ts";
import {
  PLAY_REQUEST_TIMEOUT_MS,
  createPlayHttpServer,
  makePlayProxyRoutes,
  privateCacheControl,
} from "./PlayProxy.ts";
import {
  makeCookieValue,
  makeTicket,
  playCookieHeader,
  verifyCookieValue,
  verifyTicket,
} from "./playTokens.ts";

const KEY = new Uint8Array(32).fill(7);
const KEY_HEX = Buffer.from(KEY).toString("hex");
const BROTLI_BYTES = Buffer.from([0x1b, 0x03, 0x00, 0xf8, 0xa5, 0x40, 0x42, 0x02]);

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: Buffer;
}

/** Stands in for Polyzonia's play server. */
const fakePlayServer = Effect.acquireRelease(
  Effect.callback<{
    readonly server: NodeHttp.Server;
    readonly seen: Seen[];
    readonly port: number;
  }>((resume) => {
    const seen: Seen[] = [];
    const server = NodeHttp.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        seen.push({
          method: request.method ?? "",
          url: request.url ?? "",
          headers: request.headers,
          body,
        });
        if (request.url === "/play/main/Polyzonia.js") {
          const brotli = (request.headers["accept-encoding"] ?? "").includes("br");
          response.writeHead(200, {
            "content-type": "text/javascript",
            "cache-control": "public, max-age=60",
            ...(brotli ? { "content-encoding": "br" } : {}),
            vary: "Accept-Encoding",
          });
          response.end(brotli ? BROTLI_BYTES : "console.log('game');\n".repeat(200));
          return;
        }
        if (request.url === "/play/main/__polyzonia/flag") {
          response.writeHead(201, {
            "content-type": "application/json",
            "set-cookie": "planted=1; Path=/",
          });
          response.end(JSON.stringify({ ok: true, bytes: body.length }));
          return;
        }
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "private, no-cache",
        });
        response.end(request.method === "HEAD" ? undefined : "<p>game</p>");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resume(
        Effect.succeed({
          server,
          seen,
          port: typeof address === "object" && address ? address.port : 0,
        }),
      );
    });
  }),
  ({ server }) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
);

class NoCredential extends Schema.TaggedError<NoCredential>()("NoCredential", {}) {}

/** Sessions by bearer token: "reader" may read, "operator" may also write. */
const authStub = Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
  authenticateHttpRequest: (request: { readonly headers: Record<string, string | undefined> }) => {
    const token = request.headers.authorization?.replace(/^Bearer /, "");
    if (token === "reader" || token === "operator") {
      return Effect.succeed({
        sessionId: AuthSessionId.make(token),
        subject: token,
        method: "bearer-access-token",
        scopes:
          token === "operator"
            ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
            : [AuthOrchestrationReadScope],
      });
    }
    return Effect.fail(new NoCredential());
  },
} as unknown as EnvironmentAuth.EnvironmentAuth["Service"]);

const startProxy = Effect.fn("PlayProxyTest.start")(function* (options: {
  readonly upstreamPort: number;
  readonly enabled?: boolean;
  readonly tracer?: Tracer.Tracer;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-play-proxy-" });
  yield* fs.writeFileString(
    path.join(stateDir, "play-proxy.json"),
    JSON.stringify({
      upstream: `http://127.0.0.1:${options.upstreamPort}`,
      ...(options.enabled === false ? { enabled: false } : {}),
    }),
  );
  return yield* serveProxy(stateDir, options.tracer);
});

/** A tracer that keeps every span, as the server's trace file would. */
const recordingTracer = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, tracer };
};

const serveProxy = Effect.fn("PlayProxyTest.serve")(function* (
  stateDir: string,
  tracer?: Tracer.Tracer,
) {
  const appLayer = Layer.merge(
    makePlayProxyRoutes({ stateDir, key: KEY }),
    httpCompressionLayer,
  ).pipe(
    Layer.provide(NodeHttpClient.layerNodeHttp),
    Layer.provideMerge(NodeHttpPlatform.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  // Handlers read EnvironmentAuth per request, as in server.ts.
  const served = HttpRouter.serve(appLayer, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provide(authStub),
  );
  const services = yield* Layer.build(
    (tracer ? served.pipe(Layer.provide(Layer.succeed(Tracer.Tracer)(tracer))) : served).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
    ),
  );
  const client = Context.get(services, HttpClient.HttpClient);
  const address = Context.get(services, HttpServer.HttpServer).address;
  const port = "port" in address ? address.port : 0;
  const request = (resource: string, options?: HttpClientRequest.Options) =>
    client.execute(HttpClientRequest.make(options?.method ?? "GET")(resource, options));
  return { request, port, stateDir };
});

/** A request with nothing added or decoded, to see the bytes on the wire. */
const rawRequest = (
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: Buffer },
) =>
  Effect.callback<{ status: number; headers: NodeHttp.IncomingHttpHeaders; body: Buffer }>(
    (resume) => {
      const request = NodeHttp.request(
        {
          host: "127.0.0.1",
          port,
          method: options.method ?? "GET",
          path: options.path,
          headers: options.headers ?? {},
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resume(
              Effect.succeed({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks),
              }),
            ),
          );
        },
      );
      request.on("error", (error) => resume(Effect.die(error)));
      request.end(options.body);
    },
  );

const cookieFrom = (setCookie: string | undefined) => setCookie?.split(";")[0] ?? "";

/** The secret as Polyzonia's scripts send it: in the body, which is never traced. */
const mintRequest = (key = KEY_HEX, extra: Record<string, unknown> = {}) => ({
  method: "POST" as const,
  body: HttpBody.text(JSON.stringify({ key, ...extra }), "application/json"),
});

const signIn = (proxy: Effect.Success<ReturnType<typeof serveProxy>>) =>
  Effect.gen(function* () {
    const minted = yield* proxy.request("/play/__auth/ticket", mintRequest());
    const { ticket } = (yield* minted.json) as { ticket: string };
    const redeemed = yield* proxy.request("/play/__auth/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: HttpBody.text(JSON.stringify({ ticket }), "application/json"),
    });
    return { ticket, redeemed, cookie: cookieFrom(redeemed.headers["set-cookie"]) };
  });

// Live services: links and cookies expire by the real clock.
it.layer(NodeServices.layer, { excludeTestServices: true })("play proxy", (it) => {
  it.effect("asks a browser without access to sign in, and tells it nothing else", () =>
    Effect.gen(function* () {
      const upstream = yield* fakePlayServer;
      const proxy = yield* startProxy({ upstreamPort: upstream.port });
      const page = yield* proxy.request("/play/main/", { headers: { accept: "text/html" } });
      expect(page.status).toBe(401);
      expect(page.headers["cache-control"]).toBe("private, no-store");
      expect(yield* page.text).toContain("/play/__auth/redeem");
      const asset = yield* proxy.request("/play/main/Polyzonia.wasm");
      expect(asset.status).toBe(401);
      const flag = yield* proxy.request("/play/main/__polyzonia/flag", { method: "POST" });
      expect(flag.status).toBe(401);
      expect(upstream.seen).toEqual([]);
    }),
  );

  it.effect("signs a browser in once per link, with a cookie only /play sees", () =>
    Effect.gen(function* () {
      const upstream = yield* fakePlayServer;
      const proxy = yield* startProxy({ upstreamPort: upstream.port });
      const { ticket, redeemed, cookie } = yield* signIn(proxy);
      expect(redeemed.status).toBe(204);
      const setCookie = redeemed.headers["set-cookie"] ?? "";
      expect(setCookie).toMatch(/^t3_play=v1\./);
      expect(setCookie).toContain("Path=/play");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).not.toContain("Secure");

      const again = yield* proxy.request("/play/__auth/redeem", {
        method: "POST",
        body: HttpBody.text(JSON.stringify({ ticket }), "application/json"),
      });
      expect(again.status).toBe(401);

      const page = yield* proxy.request("/play/main/", { headers: { cookie } });
      expect(page.status).toBe(200);
      expect(yield* page.text).toBe("<p>game</p>");
      const forwarded = upstream.seen.at(-1)!;
      expect(forwarded.url).toBe("/play/main/");
      expect(forwarded.headers.cookie).toBeUndefined();
      expect(forwarded.headers.authorization).toBeUndefined();
      expect(forwarded.headers["x-forwarded-proto"]).toBe("http");
      expect(forwarded.headers.host).toBe(`127.0.0.1:${upstream.port}`);
      const check = yield* proxy.request("/play/__auth/check", { headers: { cookie } });
      expect(check.status).toBe(204);
    }),
  );

  it.effect("remembers redeemed links across restarts", () =>
    Effect.gen(function* () {
      const upstream = yield* fakePlayServer;
      const proxy = yield* startProxy({ upstreamPort: upstream.port });
      const { ticket } = yield* signIn(proxy);
      const restarted = yield* serveProxy(proxy.stateDir);
      const reused = yield* restarted.request("/play/__auth/redeem", {
        method: "POST",
        body: HttpBody.text(JSON.stringify({ ticket }), "application/json"),
      });
      expect(reused.status).toBe(401);
    }),
  );

  it.effect("sets a Secure cookie over https", () =>
    Effect.gen(function* () {
      const upstream = yield* fakePlayServer;
      const proxy = yield* startProxy({ upstreamPort: upstream.port });
      const minted = yield* proxy.request("/play/__auth/ticket", mintRequest());
      const { ticket } = (yield* minted.json) as { ticket: string };
      const response = yield* rawRequest(proxy.port, {
        method: "POST",
        path: "/play/__auth/redeem",
        headers: {
          "content-type": "application/json",
          "x-forwarded-proto": "https",
          host: "prod-0123.t3coderelay.com",
          origin: "https://prod-0123.t3coderelay.com",
        },
        body: Buffer.from(JSON.stringify({ ticket })),
      });
      expect(response.status).toBe(204);
      expect(String(response.headers["set-cookie"])).toContain("Secure");
    }),
  );

  it.effect("mints links for the secret or an operator session only", () =>
    Effect.gen(function* () {
      const upstream = yield* fakePlayServer;
      const proxy = yield* startProxy({ upstreamPort: upstream.port });
      const json = (value: unknown) => HttpBody.text(JSON.stringify(value), "application/json");
      for (const [options, status] of [
        [{}, 401],
        [{ body: json({ key: "00".repeat(32) }) }, 401],
        [{ body: json({ key: 7 }) }, 401],
        [{ headers: { "x-t3-play-key": "00".repeat(32) } }, 401],
        [{ headers: { authorization: `T3Play ${"00".repeat(32)}` } }, 401],
        [{ headers: { authorization: "Bearer reader" } }, 401],
        [{ headers: { authorization: "Bearer operator" } }, 200],
        // The secret in the body, as Polyzonia's scripts send it.
        [{ body: json({ key: KEY_HEX, ttlSeconds: 7 * 24 * 3600 }) }, 200],
        [{ headers: { authorization: `T3Play ${KEY_HEX}` } }, 200],
        // The old header, from scripts that predate the body.
        [{ headers: { "x-t3-play-key": KEY_HEX } }, 200],
      ] as const) {
        const response = yield* proxy.request("/play/__auth/ticket", {
          method: "POST",
          ...options,
        });
        expect(response.status).toBe(status);
        expect(response.headers["cache-control"]).toBe("private, no-store");
        if (status === 200) {
          const body = (yield* response.json) as { ticket: string; expiresAt: string };
          expect(body.ticket).toMatch(/^v1\.\d+\./);
          const sixDaysOn = (yield* Clock.currentTimeMillis) + 6 * 24 * 3600 * 1000;
          expect(Date.parse(body.expiresAt)).toBeGreaterThan(sixDaysOn);
        }
      }
    }),
  );

  it.effect("never writes the secret into the server's traces", () =>
    Effect.gen(function* () {
      const upstream = yield* fakePlayServer;
      const { spans, tracer } = recordingTracer();
      const proxy = yield* startProxy({ upstreamPort: upstream.port, tracer });
      const fromBody = yield* proxy.request("/play/__auth/ticket", mintRequest());
      expect(fromBody.status).toBe(200);
      const fromScheme = yield* proxy.request("/play/__auth/ticket", {
        method: "POST",
        headers: { authorization: `T3Play ${KEY_HEX}` },
      });
      expect(fromScheme.status).toBe(200);
      const fromOldHeader = yield* proxy.request("/play/__auth/ticket", {
        method: "POST",
        headers: { "x-t3-play-key": KEY_HEX },
      });
      expect(fromOldHeader.status).toBe(200);
      // The server span is ended after the response is sent.
      yield* Effect.sleep("50 millis");

      const minted = spans.filter(
        (span) => span.attributes.get("url.path") === "/play/__auth/ticket",
      );
      expect(minted).toHaveLength(3);
      const recorded = minted.flatMap((span) => [...span.attributes.values()].map(String));
      expect(recorded.some((value) => value.includes(KEY_HEX))).toBe(false);
      const oldHeaderSpan = minted.find((span) =>
        span.attributes.has("http.request.header.x-t3-play-key"),
      );
      expect(oldHeaderSpan?.attributes.get("http.request.header.x-t3-play-key")).toBe("<redacted>");
      const schemeSpan = minted.find((span) =>
        span.attributes.has("http.request.header.authorization"),
      );
      expect(schemeSpan?.attributes.get("http.request.header.authorization")).toBe("<redacted>");
    }),
  );

  it.effect("signs a browser out only on a POST from this origin", () =>
    Effect.gen(function* () {
      const upstream = yield* fakePlayServer;
      const proxy = yield* startProxy({ upstreamPort: upstream.port });
      const viaLink = yield* proxy.request("/play/__auth/logout");
      expect(viaLink.status).toBe(405);
      expect(viaLink.headers["set-cookie"]).toBeUndefined();
      const crossSite = yield* rawRequest(proxy.port, {
        method: "POST",
        path: "/play/__auth/logout",
        headers: { origin: "https://evil.example" },
      });
      expect(crossSite.status).toBe(403);
      expect(crossSite.headers["set-cookie"]).toBeUndefined();
      const own = yield* rawRequest(proxy.port, {
        method: "POST",
        path: "/play/__auth/logout",
        headers: { origin: `http://127.0.0.1:${proxy.port}` },
      });
      expect(own.status).toBe(204);
      expect(String(own.headers["set-cookie"])).toContain("t3_play=; Path=/play; Max-Age=0");
    }),
  );

  it.effect("keeps error replies out of shared caches", () =>
    Effect.gen(function* () {
      const upstream = yield* fakePlayServer;
      const proxy = yield* startProxy({ upstreamPort: upstream.port });
      const { cookie } = yield* signIn(proxy);
      const replies = [
        yield* rawRequest(proxy.port, { path: "/play/__auth/redeem" }),
        yield* rawRequest(proxy.port, {
          method: "POST",
          path: "/play/__auth/redeem",
          headers: { origin: "https://evil.example" },
        }),
        yield* rawRequest(proxy.port, { path: "/play/__auth/ticket" }),
        yield* rawRequest(proxy.port, {
          method: "POST",
          path: "/play/main/__build",
          headers: { cookie, origin: "https://evil.example", "content-length": "0" },
        }),
        yield* rawRequest(proxy.port, {
          method: "POST",
          path: "/play/main/__build",
          headers: { cookie, "content-length": String(200 * 1024 * 1024) },
        }),
      ];
      expect(replies.map((reply) => reply.status)).toEqual([405, 403, 405, 403, 413]);
      for (const reply of replies) {
        expect(reply.headers["cache-control"]).toBe("private, no-store");
        expect(reply.headers["x-content-type-options"]).toBe("nosniff");
      }
      const off = yield* startProxy({ upstreamPort: upstream.port, enabled: false });
      const notFound = yield* rawRequest(off.port, { path: "/play/main/" });
      expect(notFound.status).toBe(404);
      expect(notFound.headers["cache-control"]).toBe("private, no-store");
    }),
  );

  it.effect("reopens the page without its query after signing in", () =>
    Effect.gen(function* () {
      const upstream = yield* fakePlayServer;
      const proxy = yield* startProxy({ upstreamPort: upstream.port });
      const page = yield* proxy.request("/play/main/?arg=--quit", {
        headers: { accept: "text/html" },
      });
      expect(page.status).toBe(401);
      const html = yield* page.text;
      expect(html).toContain("const page = location.pathname;");
      expect(html).not.toContain("location.search");
    }),
  );

  it.effect("accepts T3 sessions: read for pages, operate for writes", () =>
    Effect.gen(function* () {
      const upstream = yield* fakePlayServer;
      const proxy = yield* startProxy({ upstreamPort: upstream.port });
      const read = yield* proxy.request("/play/main/", {
        headers: { authorization: "Bearer reader" },
      });
      expect(read.status).toBe(200);
      yield* read.text;
      const write = yield* proxy.request("/play/main/__build", {
        method: "POST",
        headers: { authorization: "Bearer reader" },
      });
      expect(write.status).toBe(401);
      const operate = yield* proxy.request("/play/main/__build", {
        method: "POST",
        headers: { authorization: "Bearer operator" },
      });
      expect(operate.status).toBe(200);
      yield* operate.text;
    }),
  );

  it.effect("keeps every response private and precompressed bodies untouched", () =>
    Effect.gen(function* () {
      const upstream = yield* fakePlayServer;
      const proxy = yield* startProxy({ upstreamPort: upstream.port });
      const { cookie } = yield* signIn(proxy);
      const brotli = yield* rawRequest(proxy.port, {
        path: "/play/main/Polyzonia.js",
        headers: { cookie, "accept-encoding": "br, gzip" },
      });
      expect(brotli.status).toBe(200);
      expect(brotli.headers["content-encoding"]).toBe("br");
      expect(brotli.headers["cache-control"]).toBe("private, max-age=60");
      expect(brotli.body.equals(BROTLI_BYTES)).toBe(true);
      expect(upstream.seen.at(-1)!.headers["accept-encoding"]).toBe("br, gzip");
    }),
  );

  it.effect("passes flag uploads through whole, from this origin only", () =>
    Effect.gen(function* () {
      const upstream = yield* fakePlayServer;
      const proxy = yield* startProxy({ upstreamPort: upstream.port });
      const { cookie } = yield* signIn(proxy);
      const zip = Buffer.alloc(3 * 1024 * 1024, 0x5a);
      const accepted = yield* rawRequest(proxy.port, {
        method: "POST",
        path: "/play/main/__polyzonia/flag",
        headers: {
          cookie,
          "content-type": "application/zip",
          "content-length": String(zip.length),
          origin: `http://127.0.0.1:${proxy.port}`,
        },
        body: zip,
      });
      expect(accepted.status).toBe(201);
      expect(JSON.parse(accepted.body.toString())).toEqual({ ok: true, bytes: zip.length });
      expect(accepted.headers["set-cookie"]).toBeUndefined();
      expect(accepted.headers["cache-control"]).toBe("private, no-cache");
      const forwarded = upstream.seen.at(-1)!;
      expect(forwarded.body.equals(zip)).toBe(true);
      expect(forwarded.headers["content-length"]).toBe(String(zip.length));
      expect(forwarded.headers.origin).toBe(`http://127.0.0.1:${upstream.port}`);

      const before = upstream.seen.length;
      const crossSite = yield* rawRequest(proxy.port, {
        method: "POST",
        path: "/play/main/__polyzonia/flag",
        headers: { cookie, "content-type": "application/zip", origin: "https://evil.example" },
        body: Buffer.from("x"),
      });
      expect(crossSite.status).toBe(403);
      const tooLarge = yield* rawRequest(proxy.port, {
        method: "POST",
        path: "/play/main/__polyzonia/flag",
        headers: {
          cookie,
          "content-type": "application/zip",
          "content-length": String(101 * 1024 * 1024),
        },
      });
      expect(tooLarge.status).toBe(413);
      expect(upstream.seen.length).toBe(before);
    }),
  );

  it.effect("says when the play server is not running", () =>
    Effect.gen(function* () {
      const upstream = yield* fakePlayServer;
      const port = upstream.port;
      yield* Effect.callback<void>(
        (resume) => void upstream.server.close(() => resume(Effect.void)),
      );
      const proxy = yield* startProxy({ upstreamPort: port });
      const { cookie } = yield* signIn(proxy);
      const page = yield* proxy.request("/play/main/", {
        headers: { cookie, accept: "text/html" },
      });
      expect(page.status).toBe(502);
      expect(yield* page.text).toContain("play server is not running");
    }),
  );

  it.effect("can be turned off", () =>
    Effect.gen(function* () {
      const upstream = yield* fakePlayServer;
      const proxy = yield* startProxy({ upstreamPort: upstream.port, enabled: false });
      const response = yield* proxy.request("/play/main/", {
        headers: { authorization: "Bearer operator" },
      });
      expect(response.status).toBe(404);
    }),
  );
});

describe("play tokens", () => {
  it("rejects tampered, expired and misused tokens", () => {
    const now = 1_800_000_000;
    const { ticket } = makeTicket(KEY, now, 3600);
    expect(verifyTicket(KEY, ticket, now)).not.toBeNull();
    expect(verifyTicket(KEY, ticket, now + 3601)).toBeNull();
    expect(verifyTicket(new Uint8Array(32).fill(8), ticket, now)).toBeNull();
    expect(verifyTicket(KEY, `${ticket.slice(0, -2)}AA`, now)).toBeNull();
    const parts = ticket.split(".");
    expect(
      verifyTicket(KEY, [parts[0], String(now + 999_999), parts[2], parts[3]].join("."), now),
    ).toBeNull();
    // A ticket is not a cookie, nor a cookie a ticket.
    expect(verifyCookieValue(KEY, ticket, now)).toBeNull();
    expect(verifyTicket(KEY, makeCookieValue(KEY, now), now)).toBeNull();
  });

  it("caps link lifetimes", () => {
    const now = 1_800_000_000;
    expect(makeTicket(KEY, now, 10 * 365 * 24 * 3600).expiresAt - now).toBe(30 * 24 * 3600);
    expect(makeTicket(KEY, now, 1).expiresAt - now).toBe(60);
  });

  it("writes the cookie for /play only", () => {
    expect(playCookieHeader("v", true, 10)).toBe(
      "t3_play=v; Path=/play; Max-Age=10; HttpOnly; SameSite=Strict; Secure",
    );
  });

  it("gives a slow upload half an hour instead of Node's 5 minutes", () => {
    const server = createPlayHttpServer();
    expect(PLAY_REQUEST_TIMEOUT_MS).toBe(30 * 60 * 1000);
    expect(server.requestTimeout).toBe(PLAY_REQUEST_TIMEOUT_MS);
    // Headers still have to arrive promptly.
    expect(server.headersTimeout).toBe(NodeHttp.createServer().headersTimeout);
    server.close();
  });

  it("never lets a response be cached publicly", () => {
    expect(privateCacheControl(undefined)).toBe("private, no-cache");
    expect(privateCacheControl("public, max-age=31536000, immutable")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(privateCacheControl("no-store")).toBe("no-store");
    expect(privateCacheControl("private, no-cache")).toBe("private, no-cache");
  });
});
