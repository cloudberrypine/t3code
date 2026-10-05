import { File, type FileOptions, Virtualizer } from "@pierre/diffs/react";

import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";

import { FILE_LINK_REVEAL_UNSAFE_CSS } from "./fileSurfaceChrome";

/**
 * Highlighted source for files that cannot be edited: captured attachments,
 * host files outside the workspace and truncated reads. Same surface theme,
 * word-wrap preference and virtualization as the editable workspace file.
 */
export default function ReadOnlySourcePreview(props: {
  readonly name: string;
  readonly text: string;
  readonly cacheKey?: string;
  readonly lang?: "angelscript";
  readonly unsafeCSSExtra?: string;
  readonly onPostRender?: FileOptions<unknown>["onPostRender"];
}) {
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  return (
    <DiffWorkerPoolProvider>
      <Virtualizer
        key={`${props.name}:${resolvedTheme}:${props.text.length}`}
        className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
        config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
      >
        <File
          file={{
            name: props.name,
            ...(props.lang ? { lang: props.lang } : {}),
            contents: props.text,
            ...(props.cacheKey ? { cacheKey: props.cacheKey } : {}),
          }}
          options={{
            disableFileHeader: true,
            overflow: wordWrap ? "wrap" : "scroll",
            theme: resolveDiffThemeName(resolvedTheme),
            preferredHighlighter: PREFERRED_HIGHLIGHTER,
            themeType: resolvedTheme,
            unsafeCSS: `${FILE_LINK_REVEAL_UNSAFE_CSS}\n${props.unsafeCSSExtra ?? ""}`,
            ...(props.onPostRender ? { onPostRender: props.onPostRender } : {}),
          }}
          className="min-h-full"
        />
      </Virtualizer>
    </DiffWorkerPoolProvider>
  );
}
