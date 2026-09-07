import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import * as ReviewService from "./ReviewService.ts";

const TestLayer = ReviewService.layer.pipe(
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer))),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(VcsProcess.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-review-service-" })),
  Layer.provideMerge(NodeServices.layer),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  // Both projects and this worktree are outside the server's launch directory and worktreesDir.
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-projects-" });
  const project = path.join(root, "project");
  const otherProject = path.join(root, "other-project");
  const worktree = path.join(root, "external-worktree");
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ operation: "ReviewService.test.git", cwd, args, timeoutMs: 10_000 });
  for (const cwd of [project, otherProject]) {
    yield* fs.makeDirectory(cwd);
    yield* run(cwd, ["init", "-b", "main"]);
    yield* run(cwd, ["config", "user.name", "Test"]);
    yield* run(cwd, ["config", "user.email", "test@example.com"]);
    yield* fs.writeFileString(path.join(cwd, "example.txt"), "original\n");
    yield* run(cwd, ["add", "."]);
    yield* run(cwd, ["commit", "-m", "initial"]);
  }
  yield* run(project, ["worktree", "add", "-b", "feature", worktree]);
  yield* fs.writeFileString(path.join(worktree, "example.txt"), "committed worktree change\n");
  yield* run(worktree, ["commit", "-am", "worktree change"]);
  yield* fs.writeFileString(path.join(worktree, "example.txt"), "uncommitted worktree change\n");
  yield* fs.writeFileString(path.join(project, "example.txt"), "main project change\n");
  yield* fs.writeFileString(path.join(otherProject, "example.txt"), "other project change\n");
  return { project, otherProject, worktree };
});

it.layer(TestLayer)("ReviewService", (it) => {
  it.effect(
    "keeps working-tree previews scoped to each requested project and external worktree",
    () =>
      Effect.gen(function* () {
        const { project, otherProject, worktree } = yield* fixture;
        const review = yield* ReviewService.ReviewService;
        for (const [cwd, expected] of [
          [project, "main project change"],
          [otherProject, "other project change"],
          [worktree, "uncommitted worktree change"],
        ] as const) {
          const result = yield* review.getDiffPreview({ cwd, sourceKind: "working-tree" });
          assert.strictEqual(result.cwd, cwd);
          assert.lengthOf(result.sources, 1);
          assert.include(result.sources[0]?.diff, `+${expected}`);
        }
      }),
  );

  it.effect("loads branch previews and expanded context from the same external worktree", () =>
    Effect.gen(function* () {
      const { worktree } = yield* fixture;
      const review = yield* ReviewService.ReviewService;
      const preview = yield* review.getDiffPreview({
        cwd: worktree,
        sourceKind: "branch-range",
        baseRef: "main",
      });
      const source = preview.sources[0];
      assert.isDefined(source);
      if (!source) return;
      assert.include(source.diff, "+committed worktree change");
      assert.notInclude(source.diff, "uncommitted worktree change");
      const contents = yield* review.getDiffFileContents({
        cwd: worktree,
        sourceKind: source.kind,
        changeType: "change",
        baseRef: source.baseRef,
        headRef: source.headRef,
        oldPath: "example.txt",
        newPath: "example.txt",
      });
      assert.strictEqual(contents.oldContents, "original\n");
      assert.strictEqual(contents.newContents, "committed worktree change\n");
    }),
  );

  it.effect(
    "returns an empty preview for a non-repository instead of substituting the launch repository",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-review-no-repo-" });
        const review = yield* ReviewService.ReviewService;
        const preview = yield* review.getDiffPreview({ cwd });
        assert.strictEqual(preview.cwd, cwd);
        assert.deepStrictEqual(preview.sources, []);
      }),
  );
});
