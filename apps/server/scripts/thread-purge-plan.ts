#!/usr/bin/env node

/**
 * Plans the settled-thread purge against a state database without changing
 * it: opens the database read-only, applies the purge's keep rules (with the
 * keep file and command watches next to the database) and writes the plan.
 *
 *   node apps/server/scripts/thread-purge-plan.ts [--db <statev2.sqlite>] [--keep <keep.json>] [--out <plan.json>]
 *
 * The server writes the same plan before it purges; see
 * apps/server/src/persistence/ThreadPurge.ts and docs/local-fork.md.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Command, Flag } from "effect/unstable/cli";

import {
  THREAD_PURGE_KEEP_FILE,
  readKeepThreadIds,
  selectThreadsToPurge,
} from "../src/persistence/ThreadPurge.ts";

const encodePlan = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const planCommand = Command.make(
  "thread-purge-plan",
  {
    db: Flag.String("db").pipe(Flag.optional),
    keep: Flag.String("keep").pipe(Flag.optional),
    out: Flag.String("out").pipe(Flag.optional),
  },
  ({ db, keep, out }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dbPath = Option.getOrElse(db, () =>
        path.join(process.env.HOME ?? "", ".t3", "userdata", "statev2.sqlite"),
      );
      const keepFile = Option.getOrElse(keep, () =>
        path.join(path.dirname(dbPath), THREAD_PURGE_KEEP_FILE),
      );
      const keepThreadIds = readKeepThreadIds(path.dirname(dbPath), keepFile);
      if (keepThreadIds === undefined) return yield* Console.error(`Missing ${keepFile}`);
      const selection = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* selectThreadsToPurge(sql, { keepThreadIds });
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
      yield* Console.log(
        `Would purge ${selection.purge.length} thread(s); keeps ${selection.kept} (${selection.keptSettled} settled).`,
      );
      yield* Console.log(`Kept by reason: ${encodePlan(selection.keptByReason)}`);
      const plannedAt = DateTime.formatIso(yield* DateTime.now);
      const plan = encodePlan({ plannedAt, mode: "plan", ...selection });
      if (Option.isSome(out)) {
        yield* fs.writeFileString(out.value, `${plan}\n`);
        yield* Console.log(`Plan written to ${out.value}`);
      } else {
        yield* Console.log(plan);
      }
    }),
);

Command.run(planCommand, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
