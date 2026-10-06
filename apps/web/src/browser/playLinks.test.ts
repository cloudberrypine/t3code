import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const readPreparedConnection = vi.fn();

vi.mock("~/state/session", () => ({ readPreparedConnection }));
vi.mock("~/connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("~/connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: {} } }));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: { get: () => ({ isReady: true, entries: new Map() }) },
}));

const ENVIRONMENT = EnvironmentId.make("desk");
const LOCAL = "http://127.0.0.1:3773";
const RELAY = "https://prod-0123456789abcdef.t3coderelay.com";
const PHONE_LINK = `${RELAY}/play/fix-frog/?stale#ticket=meant-for-the-phone`;

const minted = () =>
  Promise.resolve(
    AsyncResult.success({ ticket: "desktop-ticket", publicOrigin: RELAY }) as AsyncResult.Success<
      { ticket: string; publicOrigin: string | null },
      unknown
    >,
  );
const refused = () =>
  Promise.resolve(
    AsyncResult.failure(Cause.fail("refused")) as AsyncResult.Failure<
      { ticket: string; publicOrigin: string | null },
      unknown
    >,
  );

describe("play links in the integrated browser", () => {
  beforeEach(() => {
    readPreparedConnection.mockReset();
    readPreparedConnection.mockReturnValue({ httpBaseUrl: `${LOCAL}/` });
  });

  it("opens a phone link at the local address with a ticket of its own", async () => {
    const { resolvePlayLinkForPreview } = await import("./playLinks");
    await expect(
      resolvePlayLinkForPreview({ href: PHONE_LINK, environmentId: ENVIRONMENT, mint: minted }),
    ).resolves.toBe(`${LOCAL}/play/fix-frog/?stale#ticket=desktop-ticket`);
  });

  it("leaves play pages of other hosts to the system browser", async () => {
    const { resolvePlayLinkForPreview } = await import("./playLinks");
    await expect(
      resolvePlayLinkForPreview({
        href: "https://example.com/play/fix-frog/",
        environmentId: ENVIRONMENT,
        mint: minted,
      }),
    ).resolves.toBeNull();
  });

  it("without a ticket of its own, opens local links as they are", async () => {
    const { resolvePlayLinkForPreview } = await import("./playLinks");
    const local = `${LOCAL}/play/main/#ticket=t`;
    await expect(
      resolvePlayLinkForPreview({ href: local, environmentId: ENVIRONMENT, mint: refused }),
    ).resolves.toBe(local);
    // The environment's public address is only known from its reply.
    await expect(
      resolvePlayLinkForPreview({ href: PHONE_LINK, environmentId: ENVIRONMENT, mint: refused }),
    ).resolves.toBeNull();
  });

  it("needs a connected environment", async () => {
    readPreparedConnection.mockReturnValue(null);
    const { resolvePlayLinkForPreview } = await import("./playLinks");
    await expect(
      resolvePlayLinkForPreview({ href: PHONE_LINK, environmentId: ENVIRONMENT, mint: minted }),
    ).resolves.toBeNull();
  });
});
