import { describe, expect, it } from "vite-plus/test";
import { markdownPreviewSections, parseMarkdownDocument } from "./markdownDocument";

const table = "| Name | Size |\n| --- | --- |\n| Desk | Large |";
const image = "![Chart](charts/size.png)";
const code = "```md\n" + "| A | B |\n| - | - |\n".repeat(300) + "```";
const prose = "Some preceding text. ".repeat(200).trimEnd();

describe("markdownPreviewSections", () => {
  it("keeps a short preview in a single renderer", () => {
    const markdown = table + "\n\n" + image;
    expect(markdownPreviewSections(markdown)).toEqual([markdown]);
    expect(markdownPreviewSections("")).toEqual([""]);
  });

  it("bounds the amount of Markdown per section at whole blocks", () => {
    const markdown = [prose, table, code, image, prose, table].join("\r\n\r\n");
    const sections = markdownPreviewSections(markdown);
    expect(sections.length).toBeGreaterThan(2);
    expect(sections.join("")).toBe(markdown);
    expect(
      sections.flatMap((section) =>
        parseMarkdownDocument(section).children.map((node) => node.type),
      ),
    ).toEqual(["paragraph", "table", "code", "paragraph", "paragraph", "table"]);
    expect(sections.some((section) => section.includes(code))).toBe(true);
  });

  it("resolves references across sections in their original definition order", () => {
    const markdown = [
      "# Intro\n\n[Document][guide]",
      '> [guide]:\n>   ./first.md\n>   "Read this first"',
      prose,
      "![Chart][figure]\n\n[Document][guide]",
      "[guide]: ./second.md",
      "[figure]: <charts/size chart.png>",
    ].join("\n\n");
    const sections = markdownPreviewSections(markdown);
    expect(sections.length).toBeGreaterThan(1);
    const finalSection = sections.at(-1)!;
    const finalDocument = parseMarkdownDocument(finalSection);
    expect(finalDocument.children[0]).toMatchObject({
      type: "definition",
      identifier: "guide",
      url: "./first.md",
      title: "Read this first",
    });
    expect(finalDocument.children).toContainEqual(
      expect.objectContaining({
        type: "paragraph",
        children: [expect.objectContaining({ type: "imageReference", identifier: "figure" })],
      }),
    );
    expect(finalDocument.children).toContainEqual(
      expect.objectContaining({
        type: "definition",
        identifier: "figure",
        url: "charts/size chart.png",
      }),
    );
  });

  it("preserves escaped labels and finds definitions inside HTML wrappers", () => {
    const markdown = [
      "See [settings][a\\]b] and [notes][hidden].",
      prose,
      "> [a\\]b]: C:\\work\\.t3\\settings.json",
      "<details><summary>Notes</summary>\n[hidden]: ./notes.md\n</details>",
    ].join("\n\n");
    const [firstSection] = markdownPreviewSections(markdown);
    expect(firstSection).toContain("[a\\]b]: C:\\work\\.t3\\settings.json");
    expect(firstSection).toContain("[hidden]: ./notes.md");
    expect(parseMarkdownDocument(firstSection!).children).toContainEqual(
      expect.objectContaining({
        type: "paragraph",
        children: [
          expect.objectContaining({ type: "text" }),
          expect.objectContaining({ type: "linkReference", identifier: "a\\]b" }),
          expect.objectContaining({ type: "text" }),
          expect.objectContaining({ type: "linkReference", identifier: "hidden" }),
          expect.objectContaining({ type: "text" }),
        ],
      }),
    );
  });
});
