import { getFiletypeFromFileName } from "@pierre/diffs";
import { expect, it } from "vite-plus/test";
import { ANGELSCRIPT_SYNTAX_LANGUAGE } from "./angelScriptSyntax";
import { getSyntaxHighlighterPromise } from "./syntaxHighlighting";

it("maps .as sources to the AngelScript syntax language", () => {
  expect(getFiletypeFromFileName("assets/scripts/Otter.as")).toBe(ANGELSCRIPT_SYNTAX_LANGUAGE);
});

it("highlights AngelScript with the shared highlighter and preserves multiline comment state", async () => {
  const highlighter = await getSyntaxHighlighterPromise(ANGELSCRIPT_SYNTAX_LANGUAGE);
  const { tokens } = highlighter.codeToTokens(
    "Shot@ s;\n/* s.wait();\nstill comment */\ns.wait(1.0f);",
    { lang: ANGELSCRIPT_SYNTAX_LANGUAGE, theme: "pierre-dark" },
  );
  expect(tokens).toHaveLength(4);
  const commentColor = tokens[1]![0]!.color;
  expect(tokens[2]![0]!.color).toBe(commentColor);
  expect(tokens[3]!.find((token) => token.content === "wait")?.color).not.toBe(commentColor);
});
