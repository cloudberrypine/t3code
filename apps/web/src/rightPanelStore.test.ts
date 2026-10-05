import { useDiffPanelStore, selectThreadDiffPanelSelection } from "./diffPanelStore";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  migratePersistedRightPanelState,
  pullRequestSurface,
  pullRequestSurfaceId,
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectSelectedRightPanelSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "./rightPanelStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

beforeEach(() => {
  useDiffPanelStore.setState({
    byThreadKey: {},
    branchBaseRefByThreadKey: {},
    jumpRevealByThreadKey: {},
  });
  useRightPanelStore.setState({
    byThreadKey: {},
    userActionRevisionByThreadKey: {},
    fileJumpHistoryByThreadKey: {},
  });
});

describe("file definition jump history", () => {
  const location = (path: string, line: number) => ({ path, line });
  const active = (ref = refA) =>
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref);

  it("undoes and redoes multiple same-file jumps, with a fresh reveal each time", () => {
    const store = useRightPanelStore.getState();
    store.jumpToFile(refA, "/repo", location("main.as", 4), location("main.as", 40));
    store.jumpToFile(refA, "/repo", location("main.as", 48), location("main.as", 100));
    for (const [direction, line] of [
      ["back", 48],
      ["back", 4],
      ["forward", 40],
      ["forward", 100],
    ] as const) {
      const previous = active();
      expect(store.traverseFileJumpHistory(refA, "/repo", direction)).toBe(true);
      expect(active()).toMatchObject({
        relativePath: "main.as",
        revealLine: line,
        revealRequestId: previous?.kind === "file" ? previous.revealRequestId + 1 : 1,
      });
    }
    const revision = store.getUserActionRevision(refA);
    expect(store.traverseFileJumpHistory(refA, "/repo", "forward")).toBe(false);
    expect(store.getUserActionRevision(refA)).toBe(revision);
  });

  it("reopens the source tab and replaces forward history after a new jump", () => {
    const store = useRightPanelStore.getState();
    store.jumpToFile(refA, "/repo", location("a.as", 3), location("b.as", 50));
    store.jumpToFile(refA, "/repo", location("b.as", 60), location("c.as", 70));
    store.closeSurface(refA, "file:b.as");
    store.traverseFileJumpHistory(refA, "/repo", "back");
    expect(active()).toMatchObject({ relativePath: "b.as", revealLine: 60 });
    store.jumpToFile(refA, "/repo", location("b.as", 61), location("d.as", 80));
    expect(store.traverseFileJumpHistory(refA, "/repo", "forward")).toBe(false);
    store.traverseFileJumpHistory(refA, "/repo", "back");
    expect(active()).toMatchObject({ relativePath: "b.as", revealLine: 61 });
    store.traverseFileJumpHistory(refA, "/repo", "back");
    expect(active()).toMatchObject({ relativePath: "a.as", revealLine: 3 });
  });

  it("isolates threads, environments and workspaces, and drops history when a thread is removed", () => {
    const store = useRightPanelStore.getState();
    const remote = scopeThreadRef("env-2" as EnvironmentId, refA.threadId);
    store.jumpToFile(refA, "/repo", location("a.as", 3), location("b.as", 50));
    for (const ref of [refB, remote])
      expect(store.traverseFileJumpHistory(ref, "/repo", "back")).toBe(false);
    expect(store.traverseFileJumpHistory(refA, "/other", "back")).toBe(false);
    store.jumpToFile(refA, "/other", location("x.as", 1), location("y.as", 2));
    store.traverseFileJumpHistory(refA, "/other", "back");
    expect(active()).toMatchObject({ relativePath: "x.as", revealLine: 1 });
    expect(store.traverseFileJumpHistory(refA, "/other", "back")).toBe(false);
    store.removeThread(refA);
    expect(store.traverseFileJumpHistory(refA, "/other", "forward")).toBe(false);
  });

  it("does not record ordinary file opens or jumps to the same location", () => {
    const store = useRightPanelStore.getState();
    store.openFile(refA, "a.as", 1);
    store.jumpToFile(refA, "/repo", location("a.as", 1), location("a.as", 1));
    expect(store.traverseFileJumpHistory(refA, "/repo", "back")).toBe(false);
  });
});

describe("rightPanelStore", () => {
  const completedDiff = { id: "diff", kind: "diff" } as const;
  const linkedPullRequest = pullRequestSurface({
    projectId: "project-a",
    repository: "pingdotgg/t3code",
    number: 42,
  });

  it.each(["diff-first", "pull-request-first"])(
    "keeps the linked pull request above the completed diff with %s delivery",
    (order) => {
      const store = useRightPanelStore.getState();
      const revision = store.getUserActionRevision(refA);
      const requests =
        order === "diff-first"
          ? [completedDiff, linkedPullRequest]
          : [linkedPullRequest, completedDiff];
      for (const surface of requests) store.openProactive(refA, surface, revision);

      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
      ).toEqual(linkedPullRequest);

      store.open(refA, "diff");
      expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("diff");
    },
  );

  it.each([
    { choice: "file", choose: () => useRightPanelStore.getState().openFile(refA, "src/app.ts") },
    {
      choice: "pull request",
      choose: () =>
        useRightPanelStore.getState().openPullRequest(refA, { ...linkedPullRequest, number: 41 }),
    },
    { choice: "browser", choose: () => useRightPanelStore.getState().openBrowser(refA, "tab-a") },
    {
      choice: "terminal",
      choose: () => useRightPanelStore.getState().openTerminal(refA, "term-1"),
    },
    {
      choice: "same tab",
      choose: () => useRightPanelStore.getState().activateSurface(refA, "diff"),
    },
    { choice: "hide", choose: () => useRightPanelStore.getState().close(refA) },
    { choice: "toggle", choose: () => useRightPanelStore.getState().toggle(refA, "diff") },
    { choice: "close all", choose: () => useRightPanelStore.getState().closeAllSurfaces(refA) },
    {
      choice: "terminal close",
      choose: () => {
        const store = useRightPanelStore.getState();
        store.openTerminal(refA, "term-1");
        store.closeTerminal(refA, "terminal:term-1", "term-1");
      },
    },
  ])("keeps a later $choice choice when automatic requests arrive", ({ choose }) => {
    const store = useRightPanelStore.getState();
    store.open(refA, "diff");
    const revision = store.getUserActionRevision(refA);
    choose();
    const chosen = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);

    expect(store.openProactive(refA, completedDiff, revision)).toBe(false);
    expect(store.openProactive(refA, linkedPullRequest, revision)).toBe(false);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toBe(
      chosen,
    );
  });

  it("allows automatic panels for a later turn after a manual choice", () => {
    const store = useRightPanelStore.getState();
    const firstTurnRevision = store.getUserActionRevision(refA);
    store.openFile(refA, "src/app.ts");
    expect(store.openProactive(refA, completedDiff, firstTurnRevision)).toBe(false);

    const nextTurnRevision = store.getUserActionRevision(refA);
    expect(store.openProactive(refA, completedDiff, nextTurnRevision)).toBe(true);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("diff");
  });

  it("keeps manual choices scoped to their thread and environment", () => {
    const otherEnvironment = scopeThreadRef("env-2" as EnvironmentId, refA.threadId);
    const store = useRightPanelStore.getState();
    const revision = store.getUserActionRevision(refA);
    store.openFile(refB, "src/app.ts");
    store.openFile(otherEnvironment, "src/app.ts");

    expect(store.openProactive(refA, completedDiff, revision)).toBe(true);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refB)).toBe("file");
    expect(
      selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, otherEnvironment),
    ).toBe("file");
  });

  it("does not treat resource reconciliation as a manual choice", () => {
    const store = useRightPanelStore.getState();
    store.openFile(refA, "src/app.ts");
    const revision = store.getUserActionRevision(refA);
    store.reconcileBrowserSurfaces(refA, ["agent-browser"]);
    store.reconcileFileSurfaces(refA, false);

    expect(store.openProactive(refA, completedDiff, revision)).toBe(true);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("diff");
  });

  it("drops the legacy singleton terminal surface during migration", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            activeSurfaceId: "terminal",
            surfaces: [
              { id: "browser:tab-a", kind: "preview", resourceId: "tab-a" },
              { id: "terminal", kind: "terminal" },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: false,
          activeSurfaceId: null,
          surfaces: [{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
        },
      },
    });
  });

  it("upgrades saved single-session terminal surfaces to split-capable surfaces", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "terminal:term-1",
            surfaces: [{ id: "terminal:term-1", kind: "terminal", resourceId: "term-1" }],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "terminal:term-1",
          surfaces: [
            {
              id: "terminal:term-1",
              kind: "terminal",
              resourceId: "term-1",
              terminalIds: ["term-1"],
              activeTerminalId: "term-1",
            },
          ],
        },
      },
    });
  });

  it("upgrades saved file surfaces with neutral reveal state", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "file:src/index.ts",
            surfaces: [{ id: "file:src/index.ts", kind: "file", relativePath: "src/index.ts" }],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: "file:src/index.ts",
          surfaces: [
            {
              id: "file:src/index.ts",
              kind: "file",
              relativePath: "src/index.ts",
              revealLine: null,
              revealRequestId: 0,
            },
          ],
        },
      },
    });
  });

  it("upgrades the legacy singleton pull request surface to a reference-keyed tab", () => {
    const id = pullRequestSurfaceId({
      projectId: "project-a",
      repository: "pingdotgg/t3code",
      number: 4909,
    });
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "pull-request",
            surfaces: [
              {
                id: "pull-request",
                kind: "pull-request",
                projectId: "project-a",
                repository: "pingdotgg/t3code",
                number: 4909,
              },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: true,
          activeSurfaceId: id,
          surfaces: [
            {
              id,
              kind: "pull-request",
              projectId: "project-a",
              repository: "pingdotgg/t3code",
              number: 4909,
            },
          ],
        },
      },
    });
  });

  it("drops the pull-request list's shared panel so a restart opens the page fresh", () => {
    const id = pullRequestSurfaceId({
      projectId: "project-a",
      repository: "pingdotgg/t3code",
      number: 4909,
    });
    const panelState = {
      isOpen: true,
      activeSurfaceId: id,
      surfaces: [
        {
          id,
          kind: "pull-request" as const,
          projectId: "project-a",
          repository: "pingdotgg/t3code",
          number: 4909,
        },
      ],
    };
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:pull-requests-panel": panelState,
          "env-1:thread-A": panelState,
        },
      }),
    ).toEqual({ byThreadKey: { "env-1:thread-A": panelState } });
  });

  it("drops persisted plan surfaces and does not reopen an empty panel", () => {
    expect(
      migratePersistedRightPanelState({
        byThreadKey: {
          "env-1:thread-A": {
            isOpen: true,
            activeSurfaceId: "plan",
            surfaces: [{ id: "plan", kind: "plan" }],
          },
          "env-1:thread-B": {
            isOpen: true,
            activeSurfaceId: "plan",
            surfaces: [
              { id: "plan", kind: "plan" },
              { id: "diff", kind: "diff" },
            ],
          },
        },
      }),
    ).toEqual({
      byThreadKey: {
        "env-1:thread-A": {
          isOpen: false,
          activeSurfaceId: null,
          surfaces: [],
        },
        "env-1:thread-B": {
          isOpen: true,
          activeSurfaceId: "diff",
          surfaces: [{ id: "diff", kind: "diff" }],
        },
      },
    });
  });

  it("open sets the active panel for a thread", () => {
    useRightPanelStore.getState().open(refA, "preview");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("preview");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refB)).toBeNull();
  });

  it("opening a different kind keeps both surfaces and activates the new one", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().open(refA, "preview");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("preview");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toHaveLength(2);
  });

  it("reopening an inactive singleton activates its existing surface", () => {
    useRightPanelStore.getState().open(refA, "diff");
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().open(refA, "diff");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "diff",
      surfaces: [
        { id: "diff", kind: "diff" },
        { id: "agents", kind: "agents" },
      ],
    });
  });

  it("keeps files as a singleton surface", () => {
    useRightPanelStore.getState().open(refA, "files");
    useRightPanelStore.getState().open(refA, "files");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [{ id: "files", kind: "files" }],
    });
  });

  it("replaces the standalone explorer with peer file surfaces", () => {
    useRightPanelStore.getState().open(refA, "files");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openFile(refA, "README.md");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:README.md",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: null,
          revealRequestId: expect.any(Number),
        },
        {
          id: "file:README.md",
          kind: "file",
          relativePath: "README.md",
          revealLine: null,
          revealRequestId: expect.any(Number),
        },
      ],
    });
  });

  it("replaces the active file in place while explicit new tabs retain the other files", () => {
    const store = useRightPanelStore.getState();
    store.openFile(refA, "first.as");
    store.openFile(refA, "second.as");
    store.openBrowser(refA, "browser");
    store.activateSurface(refA, "file:first.as");
    store.replaceActiveFile(refA, "third.as");
    const replaced = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(replaced.activeSurfaceId).toBe("file:third.as");
    expect(replaced.surfaces.map((surface) => surface.id)).toEqual([
      "file:third.as",
      "file:second.as",
      "browser:browser",
    ]);
    store.openFile(refA, "fourth.as");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["file:third.as", "file:second.as", "browser:browser", "file:fourth.as"]);
  });

  it("activates an already-open file without duplicating it or closing its neighbor", () => {
    const store = useRightPanelStore.getState();
    store.openFile(refA, "first.as");
    store.openFile(refA, "second.as");
    store.replaceActiveFile(refA, "first.as");
    const current = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(current.activeSurfaceId).toBe("file:first.as");
    expect(current.surfaces.map((surface) => surface.id)).toEqual([
      "file:first.as",
      "file:second.as",
    ]);
  });

  it("opens the first file from the explorer and never replaces non-file tabs or another thread", () => {
    const store = useRightPanelStore.getState();
    store.open(refA, "files");
    store.replaceActiveFile(refA, "first.as");
    store.open(refA, "diff");
    store.replaceActiveFile(refA, "second.as");
    store.replaceActiveFile(refB, "other.as");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["file:first.as", "diff", "file:second.as"]);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refB).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["file:other.as"]);
  });

  it("opens an attachment as a file surface without the standalone explorer", () => {
    const attachment = {
      type: "file" as const,
      id: "thread-A-attachment-pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
    };
    useRightPanelStore.getState().open(refA, "files");
    useRightPanelStore.getState().openAttachment(refA, attachment);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "attachment:thread-A-attachment-pdf",
      surfaces: [
        {
          id: "attachment:thread-A-attachment-pdf",
          kind: "file",
          relativePath: "report.pdf",
          revealLine: null,
          revealRequestId: 0,
          attachment,
        },
      ],
    });
  });

  it("keeps attachment and workspace file ids disjoint", () => {
    useRightPanelStore.getState().openFile(refA, "attachment:shared-id");
    useRightPanelStore.getState().openAttachment(refA, {
      type: "file",
      id: "shared-id",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
    });

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["file:attachment:shared-id", "attachment:shared-id"]);
  });

  it("updates line reveal requests when reopening a file surface", () => {
    useRightPanelStore.getState().openFile(refA, "src/index.ts", 42);
    useRightPanelStore.getState().openFile(refA, "src/index.ts", 87);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:src/index.ts",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: 87,
          revealRequestId: expect.any(Number),
        },
      ],
    });

    useRightPanelStore.getState().openFile(refA, "src/index.ts");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:src/index.ts",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: null,
          revealRequestId: expect.any(Number),
        },
      ],
    });
  });

  it("removes persisted file surfaces when their workspace no longer exists", () => {
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().openFile(refA, "README.md");

    useRightPanelStore.getState().reconcileFileSurfaces(refA, false);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "agents",
      surfaces: [{ id: "agents", kind: "agents" }],
    });

    useRightPanelStore.getState().openFile(refB, "conductor.json");
    useRightPanelStore.getState().reconcileFileSurfaces(refB, false);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refB)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("keeps attachment previews when their workspace is unavailable", () => {
    const attachment = {
      type: "file" as const,
      id: "thread-A-attachment-pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
    };
    useRightPanelStore.getState().openFile(refA, "README.md");
    useRightPanelStore.getState().openAttachment(refA, attachment);

    useRightPanelStore.getState().reconcileFileSurfaces(refA, false);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "attachment:thread-A-attachment-pdf",
      surfaces: [
        {
          id: "attachment:thread-A-attachment-pdf",
          kind: "file",
          relativePath: "report.pdf",
          revealLine: null,
          revealRequestId: 0,
          attachment,
        },
      ],
    });
  });

  it("close hides the panel without clearing its selected surface", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().close(refA);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
    expect(
      selectSelectedRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
    ).toEqual({ id: "agents", kind: "agents" });
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: "agents",
      surfaces: [{ id: "agents", kind: "agents" }],
    });
  });

  it("toggles empty panel visibility without creating a surface", () => {
    useRightPanelStore.getState().toggleVisibility(refA);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: null,
      surfaces: [],
    });

    useRightPanelStore.getState().toggleVisibility(refA);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  it("toggle hides the panel without discarding the active surface", () => {
    useRightPanelStore.getState().toggle(refA, "diff");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("diff");
    useRightPanelStore.getState().toggle(refA, "diff");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: "diff",
      surfaces: [{ id: "diff", kind: "diff" }],
    });
  });

  it("toggle to a different kind switches active", () => {
    useRightPanelStore.getState().toggle(refA, "preview");
    useRightPanelStore.getState().toggle(refA, "agents");
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("agents");
  });

  it("removeThread clears persisted state", () => {
    useRightPanelStore.getState().open(refA, "agents");
    useRightPanelStore.getState().removeThread(refA);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBeNull();
  });

  it("close on never-opened thread is a no-op", () => {
    useRightPanelStore.getState().close(refA);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  it("tracks one surface per browser session", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openBrowser(refA, "tab-b");

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual(["browser:tab-a", "browser:tab-b"]);
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "browser:tab-b",
      kind: "preview",
      resourceId: "tab-b",
    });
  });

  it("tracks one surface per pull request", () => {
    const first = { projectId: "project-a", repository: "pingdotgg/t3code", number: 4909 };
    const second = { projectId: "project-a", repository: "pingdotgg/t3code", number: 4910 };
    useRightPanelStore.getState().openPullRequest(refA, first);
    useRightPanelStore.getState().openPullRequest(refA, second);
    useRightPanelStore.getState().openPullRequest(refA, first);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      pullRequestSurfaceId(first),
      pullRequestSurfaceId(second),
    ]);
    expect(state.activeSurfaceId).toBe(pullRequestSurfaceId(first));
  });

  it("keeps one pull request read from two servers as two tabs", () => {
    const local = {
      environmentId: "local",
      projectId: "project-a",
      repository: "pingdotgg/t3code",
      number: 4909,
    };
    const remote = { ...local, environmentId: "remote" };

    useRightPanelStore.getState().openPullRequest(refA, local);
    useRightPanelStore.getState().openPullRequest(refA, remote);

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      pullRequestSurfaceId(local),
      pullRequestSurfaceId(remote),
    ]);
  });

  it("keeps the page's panel tabs reachable when the set of connected servers changes", () => {
    // The pull-requests page keys its one shared panel by a fixed sentinel environment, not by
    // whichever capable server happens to sort first (see PULL_REQUESTS_PANEL_ENVIRONMENT_ID in
    // _chat.pull-requests.tsx) — a server disconnecting must not move every open tab to a store
    // key nobody wrote them under.
    const panelId = ThreadId.make("pull-requests-panel");
    const stableRef = scopeThreadRef("pull-requests-panel" as EnvironmentId, panelId);
    const fromServerA = {
      environmentId: "server-a",
      projectId: "project-a",
      repository: "pingdotgg/t3code",
      number: 1,
    };
    const fromServerB = {
      environmentId: "server-b",
      projectId: "project-b",
      repository: "pingdotgg/t3code",
      number: 2,
    };

    // Both servers connected: tabs from each open under the one stable ref.
    useRightPanelStore.getState().openPullRequest(stableRef, fromServerA);
    useRightPanelStore.getState().openPullRequest(stableRef, fromServerB);

    // Server A disconnects. The stable ref does not depend on which servers remain connected, so
    // the same lookup still finds both tabs.
    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, stableRef);
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      pullRequestSurfaceId(fromServerA),
      pullRequestSurfaceId(fromServerB),
    ]);

    // The bug this guards against: a ref keyed by the first capable environment instead of a
    // fixed sentinel changes identity when that environment drops out, and a lookup under the new
    // key finds nothing even though the tabs are still sitting under the old one.
    const refWhileBothConnected = scopeThreadRef("server-a" as EnvironmentId, panelId);
    const refAfterServerADisconnects = scopeThreadRef("server-b" as EnvironmentId, panelId);
    expect(refWhileBothConnected).not.toEqual(refAfterServerADisconnects);
    expect(
      selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        refAfterServerADisconnects,
      ).surfaces,
    ).toEqual([]);
  });

  it("tracks one surface per terminal session", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().openTerminal(refA, "term-2");

    const state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
    expect(state.surfaces).toEqual([
      {
        id: "terminal:term-1",
        kind: "terminal",
        resourceId: "term-1",
        terminalIds: ["term-1"],
        activeTerminalId: "term-1",
      },
      {
        id: "terminal:term-2",
        kind: "terminal",
        resourceId: "term-2",
        terminalIds: ["term-2"],
        activeTerminalId: "term-2",
      },
    ]);
    expect(state.activeSurfaceId).toBe("terminal:term-2");
  });

  it("tracks split panes and the active pane within a terminal surface", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().splitTerminal(refA, "terminal:term-1", "term-2");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "terminal:term-1",
      kind: "terminal",
      resourceId: "term-1",
      terminalIds: ["term-1", "term-2"],
      activeTerminalId: "term-2",
    });

    useRightPanelStore.getState().activateTerminal(refA, "terminal:term-1", "term-1");
    useRightPanelStore.getState().closeTerminal(refA, "terminal:term-1", "term-1");
    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "terminal:term-1",
      kind: "terminal",
      resourceId: "term-1",
      terminalIds: ["term-2"],
      activeTerminalId: "term-2",
    });
  });

  it("tracks vertical layout for a terminal surface", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().splitTerminal(refA, "terminal:term-1", "term-2", "vertical");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      id: "terminal:term-1",
      kind: "terminal",
      resourceId: "term-1",
      terminalIds: ["term-1", "term-2"],
      activeTerminalId: "term-2",
      splitDirection: "vertical",
    });
  });

  it("closing the final terminal pane removes its surface and closes the panel", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().closeTerminal(refA, "terminal:term-1", "term-1");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("closing the active surface activates a neighboring surface", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().closeSurface(refA, "terminal:term-1");

    expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.id).toBe(
      "browser:tab-a",
    );
  });

  it("closing the final surface closes the panel", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().closeSurface(refA, "terminal:term-1");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("closing other surfaces keeps the selected surface active", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openTerminal(refA, "term-1");

    useRightPanelStore.getState().closeOtherSurfaces(refA, "file:src/index.ts");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "file:src/index.ts",
      surfaces: [
        {
          id: "file:src/index.ts",
          kind: "file",
          relativePath: "src/index.ts",
          revealLine: null,
          revealRequestId: expect.any(Number),
        },
      ],
    });
  });

  it("closing surfaces to the right activates the selected surface when active was removed", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");
    useRightPanelStore.getState().openTerminal(refA, "term-1");

    useRightPanelStore.getState().closeSurfacesToRight(refA, "browser:tab-a");

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "browser:tab-a",
      surfaces: [{ id: "browser:tab-a", kind: "preview", resourceId: "tab-a" }],
    });
  });

  it("closing all surfaces closes the panel", () => {
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openFile(refA, "src/index.ts");

    useRightPanelStore.getState().closeAllSurfaces(refA);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: null,
      surfaces: [],
    });
  });

  it("reconciles browser surfaces without deleting other surface kinds", () => {
    useRightPanelStore.getState().openTerminal(refA, "term-1");
    useRightPanelStore.getState().openBrowser(refA, "tab-a");
    useRightPanelStore.getState().openBrowser(refA, "tab-b");
    useRightPanelStore.getState().reconcileBrowserSurfaces(refA, ["tab-b", "tab-c"]);

    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["terminal:term-1", "browser:tab-b", "browser:tab-c"]);
  });
});

it("traverses a diff-to-file-to-file chain in both directions and restores the original diff", () => {
  const store = useRightPanelStore.getState();
  const from = {
    path: "DiveMovement.cpp",
    line: 165,
    diff: { selection: { kind: "unstaged" as const }, side: "additions" as const },
  };
  store.jumpToFile(refA, "/repo", from, { path: "DiveMovement.cpp", line: 162 });
  store.jumpToFile(
    refA,
    "/repo",
    { path: "DiveMovement.cpp", line: 164 },
    { path: "MeshTypes.h", line: 175 },
  );
  useDiffPanelStore.getState().selectBranchBaseRef(refA, "main");
  store.traverseFileJumpHistory(refA, "/repo", "back");
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
  ).toMatchObject({ kind: "file", revealLine: 164 });
  store.traverseFileJumpHistory(refA, "/repo", "back");
  expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
    id: "diff",
    kind: "diff",
  });
  expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, refA)).toEqual({
    kind: "unstaged",
  });
  expect(Object.values(useDiffPanelStore.getState().jumpRevealByThreadKey)).toEqual([
    { path: "DiveMovement.cpp", line: 165, side: "additions", selection: { kind: "unstaged" } },
  ]);
  store.traverseFileJumpHistory(refA, "/repo", "forward");
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
  ).toMatchObject({ kind: "file", relativePath: "DiveMovement.cpp", revealLine: 162 });
  store.traverseFileJumpHistory(refA, "/repo", "forward");
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
  ).toMatchObject({ kind: "file", relativePath: "MeshTypes.h", revealLine: 175 });
});

it("records a diff-to-Files jump even when its path and line stay the same", () => {
  const store = useRightPanelStore.getState();
  store.jumpToFile(
    refA,
    "/repo",
    {
      path: "a.cpp",
      line: 10,
      diff: { selection: { kind: "branch", baseRef: "main" }, side: "deletions" },
    },
    { path: "a.cpp", line: 10 },
  );
  store.closeSurface(refA, "diff");
  expect(store.traverseFileJumpHistory(refA, "/repo", "back")).toBe(true);
  expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA)?.kind).toBe(
    "diff",
  );
  const reveal = Object.values(useDiffPanelStore.getState().jumpRevealByThreadKey)[0]!;
  expect(reveal.side).toBe("deletions");
  useDiffPanelStore.getState().consumeJump(refA, reveal);
  expect(Object.values(useDiffPanelStore.getState().jumpRevealByThreadKey)).toEqual([]);
  store.jumpToFile(refA, "/repo", { path: "a.cpp", line: 10 }, { path: "b.cpp", line: 20 });
  expect(store.traverseFileJumpHistory(refA, "/repo", "forward")).toBe(false);
});

it("Back closes only destination tabs created by the jump; Forward reopens them", () => {
  const store = useRightPanelStore.getState();
  store.openFile(refA, "a.cpp");
  store.jumpToFile(refA, "/repo", { path: "a.cpp", line: 4 }, { path: "b.h", line: 10 });
  store.traverseFileJumpHistory(refA, "/repo", "back");
  const surfaces = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces;
  expect(surfaces().some((surface) => surface.id === "file:b.h")).toBe(false);
  store.traverseFileJumpHistory(refA, "/repo", "forward");
  expect(surfaces().some((surface) => surface.id === "file:b.h")).toBe(true);
  store.traverseFileJumpHistory(refA, "/repo", "back");
  store.openFile(refA, "b.h");
  store.openFile(refA, "a.cpp");
  store.jumpToFile(refA, "/repo", { path: "a.cpp", line: 4 }, { path: "b.h", line: 10 });
  store.traverseFileJumpHistory(refA, "/repo", "back");
  expect(surfaces().some((surface) => surface.id === "file:b.h")).toBe(true);
});

it("restores the deletion side of a specific turn diff", () => {
  const selection = {
    kind: "turn" as const,
    turnId: TurnId.make("turn-original"),
    filePath: "old.as",
    revealRequestId: 3,
  };
  useRightPanelStore.getState().jumpToFile(
    refA,
    "/repo",
    {
      path: "old.as",
      line: 21,
      diff: { selection, side: "deletions" },
    },
    { path: "api.as", line: 15 },
  );
  useDiffPanelStore.getState().selectTurn(refA, TurnId.make("turn-new"));
  useRightPanelStore.getState().traverseFileJumpHistory(refA, "/repo", "back");
  expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, refA)).toEqual(
    selection,
  );
  expect(Object.values(useDiffPanelStore.getState().jumpRevealByThreadKey)[0]).toMatchObject({
    path: "old.as",
    line: 21,
    side: "deletions",
  });
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.some(
      (surface) => surface.id === "file:api.as",
    ),
  ).toBe(false);
});

it.each([false, true])(
  "issues a fresh API reveal after Back closes its tab (diff origin: %s)",
  (fromDiff) => {
    const store = useRightPanelStore.getState();
    const source = {
      path: "assets/scripts/GiantRiverOtter.as",
      line: 573,
      ...(fromDiff
        ? { diff: { selection: { kind: "unstaged" as const }, side: "additions" as const } }
        : {}),
    };
    const target = { path: "assets/scripts/ScriptingAPI.as", line: 4839 };
    if (fromDiff) store.open(refA, "diff");
    else store.openFile(refA, source.path);
    const active = () =>
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA);
    const seen = new Set<number>();
    for (const line of [4839, 4840, 4839]) {
      store.jumpToFile(refA, "/repo", source, { ...target, line });
      const api = active();
      if (api?.kind !== "file") throw Error("Expected the API tab");
      expect(api.relativePath).toBe(target.path);
      expect(api.revealLine).toBe(line);
      expect(seen.has(api.revealRequestId)).toBe(false);
      seen.add(api.revealRequestId);
      store.traverseFileJumpHistory(refA, "/repo", "back");
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.some(
          (surface) => surface.id === `file:${target.path}`,
        ),
      ).toBe(false);
    }
    store.traverseFileJumpHistory(refA, "/repo", "forward");
    const api = active();
    if (api?.kind !== "file") throw Error("Expected the API tab");
    expect(seen.has(api.revealRequestId)).toBe(false);
  },
);
