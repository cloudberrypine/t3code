import * as NodeCrypto from "node:crypto";
import * as Path from "effect/Path";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

/** Materialize image bytes once on the host; only the file reference enters orchestration. */
export const saveCodexGeneratedImage = Effect.fn("saveCodexGeneratedImage")(function* (
  fs: FileSystem.FileSystem,
  attachmentsDir: string,
  threadId: string,
  item: {
    readonly id: string;
    readonly status: string;
    readonly savedPath?: string | null;
    readonly result: string;
  },
) {
  if (item.status !== "completed") return null;
  let savedPath = item.savedPath;
  if (!savedPath) {
    if (!item.result) return null;
    const key = NodeCrypto.createHash("sha256").update(`${threadId}:${item.id}`).digest("hex");
    const path = yield* Path.Path;
    savedPath = path.join(attachmentsDir, `generated-${key}.png`);
    yield* fs.makeDirectory(attachmentsDir, { recursive: true });
    yield* fs.writeFile(savedPath, Buffer.from(item.result, "base64"));
  }
  const destination = savedPath.split("/").map(encodeURIComponent).join("/");
  return `![Generated image](<${destination}>)`;
}, Effect.provide(NodePath.layer));
