import {
  AuthStandardClientScopes,
  EnvironmentId,
  type ServerAuthDescriptor,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./connection/catalog.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "./connection/model.ts";
import {
  environmentPlayOrigins,
  parsePlayLink,
  playLinkWithTicket,
  resolvePlayLink,
  sessionMayMintPlayTicket,
} from "./polyzoniaPlay.ts";

const DESK = EnvironmentId.make("desk");
const LAPTOP = EnvironmentId.make("laptop");
const RELAY_ORIGIN = "https://prod-0123456789abcdef.t3coderelay.com";
const LAN_ORIGIN = "http://192.168.1.10:3773";

// A T3 Connect environment the client also learned a LAN route for.
const DESK_ENTRY: ConnectionCatalogEntry = {
  target: new RelayConnectionTarget({ environmentId: DESK, label: "Desk" }),
  profile: Option.none(),
  alternateRoutes: [
    {
      target: new BearerConnectionTarget({
        environmentId: DESK,
        label: "Desk",
        connectionId: "lan",
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId: "lan",
          environmentId: DESK,
          label: "Desk",
          httpBaseUrl: `${LAN_ORIGIN}/`,
          wsBaseUrl: "ws://192.168.1.10:3773/",
          learned: true,
        }),
      ),
    },
  ],
  enabled: true,
};

const ENVIRONMENTS = new Map([
  [DESK, environmentPlayOrigins({ entry: DESK_ENTRY, httpBaseUrls: [`${RELAY_ORIGIN}/`] })],
  [LAPTOP, ["http://10.0.0.5:3773"]],
]);

describe("play links", () => {
  it("collects an environment's saved and runtime addresses as origins", () => {
    expect(ENVIRONMENTS.get(DESK)).toEqual([LAN_ORIGIN, RELAY_ORIGIN]);
    expect(
      environmentPlayOrigins({
        entry: undefined,
        httpBaseUrls: [`${RELAY_ORIGIN}/`, RELAY_ORIGIN, null, "not a url", "ftp://x"],
      }),
    ).toEqual([RELAY_ORIGIN]);
  });

  it("opens play pages on the thread's environment's T3 Connect and LAN hosts", () => {
    const phoneLink = `${RELAY_ORIGIN}/play/fix-frog/#ticket=v1.123.abc.sig`;
    expect(resolvePlayLink(phoneLink, ENVIRONMENTS, DESK)).toEqual({
      environmentId: DESK,
      url: new URL(phoneLink),
    });
    expect(
      resolvePlayLink(`${LAN_ORIGIN}/play/main/?stale`, ENVIRONMENTS, DESK)?.environmentId,
    ).toBe(DESK);
    // The list of builds is a play page too.
    expect(resolvePlayLink(`${RELAY_ORIGIN}/play/`, ENVIRONMENTS, DESK)).not.toBeNull();
  });

  it("finds the environment for a link from elsewhere, preferring the given one", () => {
    expect(resolvePlayLink("http://10.0.0.5:3773/play/x/", ENVIRONMENTS)?.environmentId).toBe(
      LAPTOP,
    );
    expect(resolvePlayLink("http://10.0.0.5:3773/play/x/", ENVIRONMENTS, DESK)?.environmentId).toBe(
      LAPTOP,
    );
  });

  it("leaves every other link to the system browser", () => {
    for (const href of [
      `${RELAY_ORIGIN}/`,
      `${RELAY_ORIGIN}/playground/`,
      `${RELAY_ORIGIN}/play`,
      `${RELAY_ORIGIN}/api/play/x/`,
      `${RELAY_ORIGIN}/play/__auth/ticket`,
      "https://prod-ffffffffffffffff.t3coderelay.com/play/fix-frog/",
      "https://example.com/play/fix-frog/",
      `https://user@${new URL(RELAY_ORIGIN).host}/play/fix-frog/`,
      "http://192.168.1.10:8790/play/fix-frog/",
      "t3code://play?url=x",
      "/play/fix-frog/",
      "not a url",
    ]) {
      expect(resolvePlayLink(href, ENVIRONMENTS, DESK), href).toBeNull();
    }
  });

  it("replaces the link's ticket", () => {
    const link = parsePlayLink(`${RELAY_ORIGIN}/play/fix-frog/?stale#ticket=a%2Bb&x=1`)!;
    expect(playLinkWithTicket(link, "v1.1.n+/s")).toBe(
      `${RELAY_ORIGIN}/play/fix-frog/?stale#ticket=v1.1.n%2B%2Fs`,
    );
    expect(playLinkWithTicket(link, "t", "http://127.0.0.1:3773")).toBe(
      "http://127.0.0.1:3773/play/fix-frog/?stale#ticket=t",
    );
  });

  it("mints only for sessions that may operate, or when that is not known yet", () => {
    const auth: ServerAuthDescriptor = {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
    };
    expect(sessionMayMintPlayTicket(null)).toBe(true);
    expect(
      sessionMayMintPlayTicket({
        authenticated: true,
        auth,
        scopes: [...AuthStandardClientScopes],
      }),
    ).toBe(true);
    expect(
      sessionMayMintPlayTicket({ authenticated: true, auth, scopes: ["orchestration:read"] }),
    ).toBe(false);
    expect(sessionMayMintPlayTicket({ authenticated: false, auth })).toBe(false);
  });
});
