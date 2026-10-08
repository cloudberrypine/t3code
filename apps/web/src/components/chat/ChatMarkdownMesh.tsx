import type { ScopedThreadRef } from "@t3tools/contracts";
import { parsePolyzoniaMesh } from "@t3tools/client-runtime/polyzonia-mesh";
import { ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { PolyzoniaMeshPreview } from "../files/PolyzoniaMeshPreview";

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const MESH_EMBED_SOURCE = /\.json(?:[?#].*)?$/i;

/**
 * A paragraph holding nothing but `.json` images (one per line) is a row of
 * mesh embeds. The viewer is block content, so the paragraph becomes a `div`
 * and each image is marked `dataMeshEmbed` for the image renderer. A `.json`
 * image inside a sentence keeps the ordinary image path.
 */
export function markMeshEmbeds(node: HastNode) {
  if (node.type === "element" && node.tagName === "p") {
    const children = (node.children ?? []).filter(
      (child) =>
        !(child.type === "text" && child.value?.trim() === "") &&
        !(child.type === "element" && child.tagName === "br"),
    );
    const isMeshImage = (child: HastNode) =>
      child.type === "element" &&
      child.tagName === "img" &&
      typeof child.properties?.src === "string" &&
      MESH_EMBED_SOURCE.test(child.properties.src);
    if (children.length > 0 && children.every(isMeshImage)) {
      node.tagName = "div";
      for (const child of children) child.properties = { ...child.properties, dataMeshEmbed: true };
      return;
    }
  }
  node.children?.forEach(markMeshEmbeds);
}

/**
 * Fork: a markdown image that points at a Polyzonia mesh JSON shows the file
 * preview's mesh viewer in the message. The file is read when shown, so the
 * viewer reflects the file's current contents; anything that does not decode
 * as a mesh shows an unavailable card that still opens the file.
 */
export function ChatMarkdownMesh(props: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly path: string;
  readonly alt: string;
  readonly copyMarkdown: string;
}) {
  const file = useProjectFileQuery(props.threadRef.environmentId, props.cwd, props.path);
  const mesh = useMemo(
    () =>
      file.data ? parsePolyzoniaMesh(props.path, file.data.contents, file.data.truncated) : null,
    [file.data, props.path],
  );
  const loading = file.data === null && file.error === null;
  const name = props.alt.trim() || props.path.split(/[\\/]/).pop() || "Mesh";
  const openFile = () => useRightPanelStore.getState().openFile(props.threadRef, props.path);

  return (
    <div
      data-markdown-copy={props.copyMarkdown}
      className="my-2 flex w-full max-w-[min(100%,48rem)] flex-col overflow-hidden rounded-lg border border-border/40 bg-background"
    >
      <div className="flex items-center gap-2 border-b border-border/60 py-1 ps-3 pe-1 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
        <Button size="xs" variant="ghost" onClick={openFile}>
          <ExternalLinkIcon />
          Open
        </Button>
      </div>
      {mesh ? (
        <div className="flex h-[28rem] flex-col">
          <PolyzoniaMeshPreview mesh={mesh} wheelZoom={false} />
        </div>
      ) : (
        <div
          role={loading ? "status" : "alert"}
          // Loading holds the viewer's height so the message does not move when the file arrives.
          className={cn(
            "flex items-center justify-center gap-1.5 p-2 text-xs text-muted-foreground",
            loading ? "h-[28rem]" : "h-24",
          )}
        >
          {loading ? (
            "Loading mesh…"
          ) : (
            <>
              <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
              {file.error ??
                (file.data?.truncated ? "Mesh file is over 4 MB" : "Not a Polyzonia mesh")}
            </>
          )}
        </div>
      )}
    </div>
  );
}
