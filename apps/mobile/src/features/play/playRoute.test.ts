import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldHandleAppLink } from "../../lib/appLinking";
import { resolvePlayRoute, type PlayEnvironments } from "./playRoute";

const DESK = EnvironmentId.make("desk");
const LAPTOP = EnvironmentId.make("laptop");
const RELAY = "https://prod-0123456789abcdef.t3coderelay.com";
const PHONE_LINK = `${RELAY}/play/fix-frog/#ticket=v1.1.n.s`;

const ENVIRONMENTS: PlayEnvironments = {
  ready: true,
  origins: new Map([
    [DESK, [RELAY, "http://192.168.1.10:3773"]],
    [LAPTOP, ["http://10.0.0.5:3773"]],
  ]),
};

describe("play deep link", () => {
  it("reaches the app's router", () => {
    expect(shouldHandleAppLink(`t3code://play?url=${encodeURIComponent(PHONE_LINK)}`)).toBe(true);
  });

  it("opens a play page on a paired environment, which it names", () => {
    expect(resolvePlayRoute({ url: PHONE_LINK }, ENVIRONMENTS, false)).toEqual({
      kind: "open",
      environmentId: DESK,
      url: new URL(PHONE_LINK),
    });
    expect(
      resolvePlayRoute(
        { url: "http://10.0.0.5:3773/play/main/", environmentId: "desk" },
        ENVIRONMENTS,
        false,
      ),
    ).toMatchObject({ kind: "open", environmentId: LAPTOP });
  });

  it("refuses anything but a play page on a paired environment", () => {
    for (const url of [
      undefined,
      "",
      `${RELAY}/`,
      `${RELAY}/play/__auth/ticket`,
      "https://example.com/play/fix-frog/",
      "javascript:alert(1)",
    ]) {
      expect(resolvePlayRoute({ url }, ENVIRONMENTS, false), String(url)).toEqual({
        kind: "refused",
      });
    }
    expect(resolvePlayRoute(undefined, ENVIRONMENTS, false)).toEqual({ kind: "refused" });
  });

  it("waits for addresses that arrive with the connection before refusing", () => {
    const loading: PlayEnvironments = { ready: false, origins: new Map() };
    const link = { url: "https://example.com/play/fix-frog/" };
    expect(resolvePlayRoute(link, loading, false)).toEqual({ kind: "waiting" });
    expect(resolvePlayRoute(link, ENVIRONMENTS, true)).toEqual({ kind: "waiting" });
    expect(resolvePlayRoute(link, ENVIRONMENTS, false)).toEqual({ kind: "refused" });
    // A link that is not a play page never waits.
    expect(resolvePlayRoute({ url: `${RELAY}/` }, loading, true)).toEqual({ kind: "refused" });
  });
});
