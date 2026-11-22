import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_TERMINAL_ID } from "@t3tools/contracts";

import { getTerminalLabel } from "@t3tools/shared/terminalLabels";

import {
  nextOpenTerminalId,
  previousLiveTerminalId,
  resolveProjectScriptTerminalId,
  type TerminalMenuSession,
} from "./terminalMenu";

function makeMenuSession(input: {
  readonly terminalId: string;
  readonly status: TerminalMenuSession["status"];
}): TerminalMenuSession {
  return {
    terminalId: input.terminalId,
    cwd: null,
    status: input.status,
    hasRunningSubprocess: false,
    displayLabel: getTerminalLabel(input.terminalId),
    updatedAt: null,
  };
}

describe("nextOpenTerminalId", () => {
  it("allocates separate terminals on repeated visits without readable metadata", () => {
    const first = nextOpenTerminalId({
      listedTerminalIds: [],
      uniqueSuffix: "783c91cc-a413-47c7-8312-c2a5a1f05e40",
    });
    const nextVisit = nextOpenTerminalId({
      listedTerminalIds: [],
      uniqueSuffix: "102315fc-ceef-45c4-b978-c4d4947d3c26",
    });
    expect(first).not.toBe(DEFAULT_TERMINAL_ID);
    expect(nextVisit).not.toBe(first);
  });

  it("avoids the mounted primary tab when the session list is still empty", () => {
    expect(
      nextOpenTerminalId({
        listedTerminalIds: [],
        activeRouteTerminalId: DEFAULT_TERMINAL_ID,
      }),
    ).toBe("term-2");
  });
});

describe("previousLiveTerminalId", () => {
  it("prefers the nearest live session below the exited id", () => {
    expect(
      previousLiveTerminalId({
        sessions: [
          makeMenuSession({ terminalId: DEFAULT_TERMINAL_ID, status: "running" }),
          makeMenuSession({ terminalId: "term-2", status: "running" }),
          makeMenuSession({ terminalId: "term-3", status: "exited" }),
          makeMenuSession({ terminalId: "term-4", status: "running" }),
        ],
        exitedTerminalId: "term-3",
      }),
    ).toBe("term-2");
  });

  it("falls back to the nearest live session above when the exited id was lowest", () => {
    expect(
      previousLiveTerminalId({
        sessions: [
          makeMenuSession({ terminalId: DEFAULT_TERMINAL_ID, status: "exited" }),
          makeMenuSession({ terminalId: "term-2", status: "starting" }),
          makeMenuSession({ terminalId: "term-4", status: "running" }),
        ],
        exitedTerminalId: DEFAULT_TERMINAL_ID,
      }),
    ).toBe("term-2");
  });
});

describe("resolveProjectScriptTerminalId", () => {
  it("uses the default shell when no terminal exists", () => {
    expect(
      resolveProjectScriptTerminalId({
        existingTerminalIds: [],
      }),
    ).toBe(DEFAULT_TERMINAL_ID);
  });

  it("reuses the first existing terminal when shells are already running", () => {
    expect(
      resolveProjectScriptTerminalId({
        existingTerminalIds: [DEFAULT_TERMINAL_ID, "term-2", "term-4"],
      }),
    ).toBe(DEFAULT_TERMINAL_ID);
  });

  it("reuses an existing terminal when the default shell was closed", () => {
    expect(
      resolveProjectScriptTerminalId({
        existingTerminalIds: ["term-2", "term-4"],
      }),
    ).toBe("term-2");
  });

  it("never targets an unseen default terminal when metadata is unavailable", () => {
    const terminalId = resolveProjectScriptTerminalId({
      existingTerminalIds: [],
      uniqueSuffix: "783c91cc-a413-47c7-8312-c2a5a1f05e40",
    });
    expect(terminalId).not.toBe(DEFAULT_TERMINAL_ID);
  });
});
