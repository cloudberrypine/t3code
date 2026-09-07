import { expect, it } from "vite-plus/test";
import { getSyntaxHighlighterPromise } from "./syntaxHighlighting";

it("loads AngelScript into the shared highlighter and preserves multiline string/comment state", async () => {
  const highlighter = await getSyntaxHighlighterPromise("angelscript");
  const { tokens } = highlighter.codeToTokens(
    'Shot@ s;\n/* s.wait();\nstill comment */\ns.wait(1.0f);\n"""text\nmore text"""',
    { lang: "angelscript", theme: "pierre-dark" },
  );
  expect(tokens).toHaveLength(6);
  const commentColor = tokens[1]![0]!.color;
  expect(tokens[2]![0]!.color).toBe(commentColor);
  expect(tokens[3]!.find((token) => token.content === "wait")?.color).not.toBe(commentColor);
  expect(tokens[4]![0]!.color).toBe(tokens[5]![0]!.color);
});
