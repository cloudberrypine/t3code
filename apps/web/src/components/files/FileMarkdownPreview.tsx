import type { ScopedThreadRef } from "@t3tools/contracts";
import { splitMarkdownFrontMatter } from "@t3tools/shared/markdownFrontMatter";
import { useMemo } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { resolvePathLinkTarget } from "~/terminal-links";

export function FileMarkdownPreview(props: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly text: string;
  readonly threadRef: ScopedThreadRef;
  readonly onTaskListChange?:
    | ((input: { readonly markerOffset: number; readonly checked: boolean }) => void)
    | undefined;
}) {
  const document = useMemo(() => splitMarkdownFrontMatter(props.text), [props.text]);
  const lastSeparator = Math.max(
    props.relativePath.lastIndexOf("/"),
    props.relativePath.lastIndexOf("\\"),
  );
  const imageBaseDir =
    lastSeparator >= 0
      ? resolvePathLinkTarget(props.relativePath.slice(0, lastSeparator), props.cwd)
      : props.cwd;

  return (
    <div className="mx-auto w-full min-w-0 max-w-4xl px-6 py-5">
      {document.frontMatter !== null ? (
        <section
          aria-label="YAML front matter"
          className="mb-5 rounded-lg border border-border/60 bg-muted/30 p-4"
        >
          <h2 className="text-xs font-medium text-muted-foreground">Front matter</h2>
          <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/80">
            <code>{document.frontMatter}</code>
          </pre>
        </section>
      ) : null}
      <ChatMarkdown
        text={document.body}
        cwd={props.cwd}
        imageBaseDir={imageBaseDir}
        threadRef={props.threadRef}
        onTaskListChange={
          props.onTaskListChange
            ? ({ markerOffset, checked }) =>
                props.onTaskListChange?.({
                  markerOffset: document.bodyOffset + markerOffset,
                  checked,
                })
            : undefined
        }
      />
    </div>
  );
}
