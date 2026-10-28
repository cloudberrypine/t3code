import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenType,
  AuthAccessTokenResult,
  AuthEnvironmentBootstrapTokenType,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthStandardClientScopes,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./http.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(configLayer),
);
const routesLayer = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(authHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
  Layer.provideMerge(environmentAuthLayer),
  Layer.provide(configLayer),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const decodeAccessToken = Schema.decodeUnknownSync(AuthAccessTokenResult);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.tryPromise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

const legacyClientScopes = AuthStandardClientScopes.filter(
  (scope) => scope !== AuthFilesystemReadScope && scope !== AuthFilesystemWriteScope,
);

const fileScopeCases = [
  { label: "none", scopes: legacyClientScopes },
  { label: "read", scopes: [...legacyClientScopes, AuthFilesystemReadScope] },
  { label: "write", scopes: [...legacyClientScopes, AuthFilesystemWriteScope] },
  { label: "read and write", scopes: AuthStandardClientScopes },
];
it.effect.each(fileScopeCases)(
  "exchanges pairing tokens with filesystem scopes: $label",
  ({ scopes }) => checkPairingExchange(scopes, scopes, 200),
);
it.effect.each(fileScopeCases)("inherits approved filesystem scopes: $label", ({ scopes }) =>
  checkPairingExchange(scopes, undefined, 200),
);

it.effect("rejects unknown token exchange scopes", () =>
  checkPairingExchange(AuthStandardClientScopes, ["filesystem:unknown"], 400, "invalid_scope"),
);

it.effect.each([AuthFilesystemReadScope, AuthFilesystemWriteScope])(
  "refuses %s when the pairing grant does not allow it",
  (scope) =>
    checkPairingExchange(
      legacyClientScopes,
      [...legacyClientScopes, scope],
      400,
      "scope_not_granted",
    ),
);

it.effect("inherits the pairing grant when an old client omits scope", () =>
  checkPairingExchange(legacyClientScopes, undefined, 200),
);

function checkPairingExchange(
  grantedScopes: ReadonlyArray<AuthEnvironmentScope>,
  requestedScopes: ReadonlyArray<string> | undefined,
  expectedStatus: number,
  expectedReason?: string,
) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routesLayer, { disableLogger: true })),
      (environment) =>
        Effect.tryPromise(async () => {
          const devResponse = await environment.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const cookie =
            devResponse.headers
              .getSetCookie()
              .find((value) => value.startsWith("t3_dev_session_"))
              ?.split(";", 1)[0] ?? "";
          const pairingResponse = await environment.handler(
            postJson("/api/auth/pairing-token", { scopes: grantedScopes }, { cookie }),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const response = await environment.handler(
            new Request("http://127.0.0.1/oauth/token", {
              method: "POST",
              body: new URLSearchParams({
                grant_type: AuthTokenExchangeGrantType,
                subject_token: pairing.credential,
                subject_token_type: AuthEnvironmentBootstrapTokenType,
                requested_token_type: AuthAccessTokenType,
                ...(requestedScopes ? { scope: requestedScopes.join(" ") } : {}),
              }),
            }),
            requestContext,
          );
          expect(response.status).toBe(expectedStatus);
          const result = await response.json();
          if (expectedReason) {
            expect(result).toMatchObject({ reason: expectedReason });
          } else {
            const token = decodeAccessToken(result);
            expect(token.token_type).toBe("Bearer");
            expect(token.scope.split(" ").sort()).toEqual(
              [...(requestedScopes ?? grantedScopes)].sort(),
            );
          }
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer));
}
