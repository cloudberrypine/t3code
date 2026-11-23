import { expect, it, vi } from "vite-plus/test";

import { resolveBehaviourNavigation } from "./behaviourNavigation.ts";

const file = (contents: string) => ({
  contents,
  relativePath: "",
  size: contents.length,
  truncated: false,
});

it("reads includes when only another unit in this file defines the name", async () => {
  const contents = `#include "engine.beh"
behaviour Sloth {
  state Browsing() { random_in(p.range); }
}
library Other {
  int random_in(range r) { return 0; }
}
`;
  const read = vi.fn(async (path: string) =>
    path === "behaviours/engine.beh"
      ? file("bindings {\n  effect tick random_in(range r);\n}\n")
      : null,
  );
  const definitions = await resolveBehaviourNavigation({
    source: { path: "behaviours/sloth.beh", contents },
    offset: contents.indexOf("random_in(p") + 2,
    read: read as never,
  });
  expect(read).toHaveBeenCalledWith("behaviours/engine.beh");
  expect(definitions).toEqual([{ path: "behaviours/engine.beh", line: 2 }]);
});

it("does not read includes when the clicked unit defines the name", async () => {
  const contents = `#include "engine.beh"
behaviour Sloth {
  state Browsing() { await Rest(); }
  state Rest() { wait_for(1t); }
}
`;
  const read = vi.fn(async () => null);
  const definitions = await resolveBehaviourNavigation({
    source: { path: "behaviours/sloth.beh", contents },
    offset: contents.indexOf("Rest()") + 1,
    read,
  });
  expect(read).not.toHaveBeenCalled();
  expect(definitions).toEqual([{ path: "behaviours/sloth.beh", line: 4 }]);
});
