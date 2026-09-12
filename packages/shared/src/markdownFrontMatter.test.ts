import { describe, expect, it } from "vite-plus/test";
import { splitMarkdownFrontMatter } from "./markdownFrontMatter.ts";

describe("Markdown front matter", () => {
  it("separates skill metadata from the body without interpreting YAML as Markdown", () => {
    const metadata =
      "name: check-script\ndescription: Validate AngelScript files.\nargument-hint: [script-path]\nallowed-tools: Bash(./scripts/build_tests.sh *), Read\n";
    const prefix = `---\n${metadata}---\n`;
    const body = "# Check script\n\n- [ ] Run tests\n";
    expect(splitMarkdownFrontMatter(prefix + body)).toEqual({
      frontMatter: metadata,
      body,
      bodyOffset: prefix.length,
    });
  });

  it.each(["\n", "\r\n", "\r"])(
    "keeps exact offsets with BOM, Unicode and %j line endings",
    (newline) => {
      const metadata = `description: 🍃 Ångström${newline}tags:${newline}  - script${newline}`;
      const prefix = `\uFEFF--- \t${newline}${metadata}...\t ${newline}`;
      expect(splitMarkdownFrontMatter(prefix + "- [ ] Done")).toEqual({
        frontMatter: metadata,
        body: "- [ ] Done",
        bodyOffset: prefix.length,
      });
    },
  );

  it("preserves comments, block scalars, indentation and literal markup", () => {
    const metadata =
      "# Metadata\ndescription: |\n  ---\n  <b>literal</b>\n  [ ] not a task\nconfig:\n  enabled: true\n";
    expect(splitMarkdownFrontMatter(`---\n${metadata}---\nBody`).frontMatter).toBe(metadata);
  });

  it.each([
    "---\n# An unfinished header\n",
    "---\nname: script\n----\nBody",
    "Text\n---\nname: script\n---\n",
    "\n---\nname: script\n---\n",
    "```yaml\n---\nname: script\n---\n```",
    "# Plain Markdown\n\n---\n",
  ])("leaves ordinary Markdown or an unclosed block unchanged: %j", (text) => {
    expect(splitMarkdownFrontMatter(text)).toEqual({
      frontMatter: null,
      body: text,
      bodyOffset: 0,
    });
  });

  it("accepts an empty block or a closing delimiter at end of file", () => {
    expect(splitMarkdownFrontMatter("---\n---")).toEqual({
      frontMatter: "",
      body: "",
      bodyOffset: 7,
    });
    expect(splitMarkdownFrontMatter("---\nname: script\n---").body).toBe("");
  });
});
