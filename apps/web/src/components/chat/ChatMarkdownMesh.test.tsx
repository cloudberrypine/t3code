import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ComponentProps } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const file = vi.hoisted(() => ({
  state: { data: null as { contents: string; truncated: boolean } | null, isPending: false },
}));
const openFile = vi.hoisted(() => vi.fn());

vi.mock("../files/projectFilesQueryState", () => ({
  useProjectFileQuery: () => ({ ...file.state, error: null, isNotFile: false, refresh: vi.fn() }),
}));
vi.mock("../files/PolyzoniaMeshPreview", () => ({
  PolyzoniaMeshPreview: (props: { mesh: { vertices: unknown[] } }) => (
    <canvas data-vertices={props.mesh.vertices.length} />
  ),
}));
vi.mock("~/components/ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openFile }) },
}));

import { ChatMarkdownMesh } from "./ChatMarkdownMesh";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const mesh = JSON.stringify({
  vertices: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
  ],
  layers: [{ triangles: [{ indices: [0, 1, 2], color: { x: 1, y: 0, z: 0, w: 1 } }] }],
});

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
  openFile.mockReset();
});

async function render(contents: string | null, path = "/tmp/scratch/Jaguar.json") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  file.state = {
    data: contents === null ? null : { contents, truncated: false },
    isPending: contents === null,
  };
  await act(async () => {
    renderer = create(
      <ChatMarkdownMesh
        threadRef={threadRef}
        cwd="/repo"
        path={path}
        alt=""
        copyMarkdown={`![](${path})`}
      />,
    );
  });
  const root = renderer!.root;
  return {
    viewers: root.findAllByType("canvas").map((node) => node.props["data-vertices"]),
    text: JSON.stringify(renderer!.toJSON()),
    open: () => root.findByType("button").props.onClick(),
  };
}

describe("ChatMarkdownMesh", () => {
  it("shows the mesh viewer for a file that decodes as a mesh and opens it full size", async () => {
    const view = await render(mesh);
    expect(view.viewers).toEqual([3]);
    expect(view.text).toContain("Jaguar.json");
    view.open();
    expect(openFile).toHaveBeenCalledWith(threadRef, "/tmp/scratch/Jaguar.json");
  });

  it("explains a JSON file that is not a mesh instead of drawing it", async () => {
    const view = await render(JSON.stringify({ name: "settings" }));
    expect(view.viewers).toEqual([]);
    expect(view.text).toContain("Not a Polyzonia mesh");
  });

  it("shows a loading state until the file arrives", async () => {
    const view = await render(null);
    expect(view.viewers).toEqual([]);
    expect(view.text).toContain("Loading mesh");
  });
});
