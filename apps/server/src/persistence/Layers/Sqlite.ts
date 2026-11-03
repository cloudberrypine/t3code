import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import { initializeV2Database } from "../initializeV2Database.ts";
import { ensureToolOutputSchema } from "../ToolOutputStore.ts";
import * as ServerConfig from "../../config.ts";

// Size the -wal file is cut back to on the first commit after a WAL reset.
export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

// Rows ANALYZE samples per index, so a refresh stays short on a
// multi-gigabyte database.
export const ANALYSIS_LIMIT = 1000;
const OPTIMIZE_INTERVAL = Duration.hours(6);

// The query planner trusts sqlite_stat1. Statistics taken while a table was
// small make it scan whole tables later. `optimize` re-analyzes each table
// whose size has changed about tenfold since its last ANALYZE (0x10002 also
// checks tables this connection has not queried yet). Nothing here creates
// statistics: a database without sqlite_stat1 keeps the planner's defaults.
const refreshPlannerStatistics = (sql: SqlClient.SqlClient, pragma: string) =>
  Effect.gen(function* () {
    const stat = yield* sql<{ readonly present: number }>`
      SELECT EXISTS (
        SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_stat1'
      ) AS present
    `;
    if (stat[0]?.present !== 1) return;
    // Migrations change the schema on this connection, which leaves the
    // in-memory row estimates that optimize compares against out of date.
    // Reload them from sqlite_stat1 first; this reads no table data.
    yield* sql.unsafe("ANALYZE sqlite_schema;");
    yield* sql.unsafe(pragma);
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Failed to refresh SQLite planner statistics", { cause }),
    ),
  );

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    // PASSIVE checkpoints never shrink the -wal file, so it otherwise keeps its
    // largest size until the last connection closes.
    yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
    yield* runMigrations();
    yield* ensureToolOutputSchema(sql);
    yield* sql.unsafe(`PRAGMA analysis_limit = ${ANALYSIS_LIMIT};`);
    yield* refreshPlannerStatistics(sql, "PRAGMA optimize = 0x10002;");
    yield* refreshPlannerStatistics(sql, "PRAGMA optimize;").pipe(
      Effect.delay(OPTIMIZE_INTERVAL),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);

export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    setup,
    NodeSqliteClient.layer({
      filename: dbPath,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3code-server",
      },
    }),
  );
}, Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    yield* initializeV2Database(dbPath);
    return makeSqlitePersistenceLive(dbPath);
  }),
);
