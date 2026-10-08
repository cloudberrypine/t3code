import type { EnvironmentId, ProjectReadFileResult } from "@t3tools/contracts";
import { parsePolyzoniaMesh } from "@t3tools/client-runtime/polyzonia-mesh";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { projectEnvironment } from "../../state/projects";
import { PolyzoniaMeshPreview } from "../files/PolyzoniaMeshPreview";

const MESH_EMBED_HEIGHT = 420;

/** A markdown image of a `.json` file is read as a Polyzonia mesh when it might be one. */
export function isMarkdownMeshEmbedPath(path: string): boolean {
  return /\.json$/i.test(path);
}

/**
 * Fork: a markdown image that points at a Polyzonia mesh JSON shows the file
 * screen's mesh viewer in the message, at a fixed height so the row does not
 * resize when the file arrives. Open shows the file screen at full size.
 */
export function ThreadMarkdownMesh(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly path: string;
  readonly alt: string | null;
  readonly onOpen: () => void;
}) {
  const file = useEnvironmentQuery(
    projectEnvironment.readFile({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, relativePath: props.path, maxBytes: 4 * 1024 * 1024 },
    }),
  );
  const data = file.data as ProjectReadFileResult | null;
  const mesh = useMemo(
    () => (data ? parsePolyzoniaMesh(props.path, data.contents, data.truncated) : null),
    [data, props.path],
  );
  const name = props.alt?.trim() || props.path.split(/[\\/]/).pop() || "Mesh";

  return (
    <View className="self-stretch overflow-hidden rounded-[10px] border border-border bg-sheet">
      <View className="flex-row items-center gap-2 border-b border-border pl-3">
        <Text numberOfLines={1} className="flex-1 text-xs font-medium text-foreground">
          {name}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${name} full size`}
          onPress={props.onOpen}
          className="min-h-11 justify-center px-3"
        >
          <Text className="text-xs text-foreground">Open</Text>
        </Pressable>
      </View>
      {mesh ? (
        <View style={{ height: MESH_EMBED_HEIGHT }}>
          <PolyzoniaMeshPreview mesh={mesh} />
        </View>
      ) : data === null && file.error === null ? (
        <View style={{ height: MESH_EMBED_HEIGHT }} className="items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : (
        <Text className="px-3 py-4 text-xs text-foreground-muted">
          {file.error ?? (data?.truncated ? "Mesh file is over 4 MB" : "Not a Polyzonia mesh")}
        </Text>
      )}
    </View>
  );
}
