import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const ReviewDiffPreviewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  sourceKind: Schema.optionalKey(ReviewDiffPreviewSourceKind),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffChangeType = Schema.Literals([
  "change",
  "rename-pure",
  "rename-changed",
  "new",
  "deleted",
]);
export type ReviewDiffChangeType = typeof ReviewDiffChangeType.Type;

export const ReviewDiffPreviewFile = Schema.Struct({
  changeType: ReviewDiffChangeType,
  oldPath: TrimmedNonEmptyString,
  newPath: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  patchIncluded: Schema.Boolean,
  isUntracked: Schema.Boolean,
});
export type ReviewDiffPreviewFile = typeof ReviewDiffPreviewFile.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
  files: Schema.optionalKey(Schema.Array(ReviewDiffPreviewFile)),
  fileListTruncated: Schema.optionalKey(Schema.Boolean),
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewDiffFileContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sourceKind: ReviewDiffPreviewSourceKind,
  changeType: ReviewDiffChangeType,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  oldPath: TrimmedNonEmptyString,
  newPath: TrimmedNonEmptyString,
  isUntracked: Schema.optionalKey(Schema.Boolean),
  includePatch: Schema.optionalKey(Schema.Boolean),
  /** Checkpoint snapshots compare exact revisions; branch reviews default to the merge base. */
  baseRefMode: Schema.optionalKey(Schema.Literals(["merge-base", "exact"])),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type ReviewDiffFileContentsInput = typeof ReviewDiffFileContentsInput.Type;

export const ReviewDiffFileContentsResult = Schema.Struct({
  oldContents: Schema.String,
  newContents: Schema.String,
  patch: Schema.optionalKey(Schema.String),
});
export type ReviewDiffFileContentsResult = typeof ReviewDiffFileContentsResult.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;
