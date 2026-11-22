import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const file = vi.hoisted(() => ({
  state: { data: null as { contents: string; truncated: boolean } | null, isPending: false },
}));
const openFile = vi.hoisted(() => vi.fn());
const buttonClick = vi.hoisted(() => ({ current: undefined as (() => void) | undefined }));

vi.mock("gt-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react")>()),
  useGT: () => (text: string) => text,
  T: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../files/projectFilesQueryState", () => ({
  useProjectFileQuery: () => ({ ...file.state, error: null, isNotFile: false, refresh: vi.fn() }),
}));
vi.mock("../files/PolyzoniaMeshPreview", () => ({
  PolyzoniaMeshPreview: (props: { mesh: { vertices: unknown[] } }) => (
    <canvas data-vertices={props.mesh.vertices.length} />
  ),
}));
vi.mock("~/components/ui/button", () => ({
  Button: (props: ComponentProps<"button">) => {
    buttonClick.current = props.onClick as (() => void) | undefined;
    return <button {...props} />;
  },
}));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openFile }) },
}));

import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS,
} from "@t3tools/shared/markdownPipeline";
import { toHtml } from "hast-util-to-html";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import { ChatMarkdownMesh, rehypeMarkMeshEmbeds } from "./ChatMarkdownMesh";

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

afterEach(() => {
  openFile.mockReset();
  buttonClick.current = undefined;
});

function render(contents: string | null, path = "/tmp/scratch/Jaguar.json") {
  file.state = {
    data: contents === null ? null : { contents, truncated: false },
    isPending: contents === null,
  };
  const text = renderToStaticMarkup(
    <ChatMarkdownMesh
      threadRef={threadRef}
      cwd="/repo"
      path={path}
      alt=""
      copyMarkdown={`![](${path})`}
    />,
  );
  return {
    viewers: [...text.matchAll(/data-vertices="(\d+)"/g)].map((match) => Number(match[1])),
    text,
    open: () => buttonClick.current?.(),
  };
}

describe("ChatMarkdownMesh", () => {
  it("shows the mesh viewer for a file that decodes as a mesh and opens it full size", () => {
    const view = render(mesh);
    expect(view.viewers).toEqual([3]);
    expect(view.text).toContain("Jaguar.json");
    view.open();
    expect(openFile).toHaveBeenCalledWith(threadRef, "/tmp/scratch/Jaguar.json");
  });

  it("explains a JSON file that is not a mesh instead of drawing it", () => {
    const view = render(JSON.stringify({ name: "settings" }));
    expect(view.viewers).toEqual([]);
    expect(view.text).toContain("Not a Polyzonia mesh");
  });

  it("shows a loading state until the file arrives", () => {
    const view = render(null);
    expect(view.viewers).toEqual([]);
    expect(view.text).toContain("Loading mesh");
  });
});

describe("rehypeMarkMeshEmbeds", () => {
  const embeds = async (text: string, lineBreaks = false) => {
    const processor = unified()
      .use(remarkParse)
      .use(lineBreaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(CHAT_MARKDOWN_REHYPE_PLUGINS)
      .use(rehypeMarkMeshEmbeds);
    const html = toHtml((await processor.run(processor.parse(text))) as never);
    return {
      meshes: [...html.matchAll(/<img src="([^"]+)"[^>]*data-mesh-embed/g)].map((m) => m[1]),
      paragraphs: html.match(/<p>/g)?.length ?? 0,
    };
  };

  it("marks JSON images on their own lines as mesh embeds outside a paragraph", async () => {
    const text =
      "Two candidates:\n\n![Jaguar](/tmp/scratch/Jaguar.json)\n![Owl](assets/meshes/Owl.json)";
    for (const lineBreaks of [false, true]) {
      expect(await embeds(text, lineBreaks)).toEqual({
        meshes: ["/tmp/scratch/Jaguar.json", "assets/meshes/Owl.json"],
        paragraphs: 1,
      });
    }
  });

  it("leaves JSON images inside a sentence and other images on the image path", async () => {
    expect(await embeds("See ![Jaguar](/tmp/Jaguar.json) here.\n\n![Shot](/tmp/shot.png)")).toEqual(
      { meshes: [], paragraphs: 2 },
    );
  });
});
