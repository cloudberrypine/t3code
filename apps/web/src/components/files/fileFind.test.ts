import { expect, it } from "vite-plus/test";

import { findFileMatches } from "./fileFind";

it("finds every match line by line, case-insensitive unless the query has capitals", () => {
  const text = "await Rest();\nwait_for(1t); // WAIT\nnothing";
  expect(findFileMatches(text, "wait")).toEqual([
    { line: 1, start: 1, end: 5 },
    { line: 2, start: 0, end: 4 },
    { line: 2, start: 17, end: 21 },
  ]);
  expect(findFileMatches(text, "WAIT")).toEqual([{ line: 2, start: 17, end: 21 }]);
  expect(findFileMatches(text, "")).toEqual([]);
  expect(findFileMatches("aaaa", "aa")).toEqual([
    { line: 1, start: 0, end: 2 },
    { line: 1, start: 2, end: 4 },
  ]);
});
