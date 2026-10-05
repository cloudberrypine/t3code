#!/usr/bin/env node
// Replaces the installed local fork build once no T3 thread has an active run.
// See docs/local-fork.md. Usage:
//   node scripts/local-install.mjs (--app <T3 Code (Alpha).app> | --zip <artifact.zip>)
//     --version <build version> [--commit <sha prefix>] [--dry-run] [--max-wait-minutes N] [--launchd]
// --launchd resubmits this command under launchd so it survives T3 quitting.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const require = NodeModule.createRequire(import.meta.url);
const { extractFile, listPackage } = require("@electron/asar");

const HOME = NodeOS.homedir();
const INSTALLED_APP = "/Applications/T3 Code (Alpha).app";
const APP_NAME = "T3 Code (Alpha).app";
const BUNDLE_ID = "com.t3tools.t3code";
const SIGNING_IDENTITY = "9996FD65608B18E540C4FE341030A5E801214B56";
const BACKUP_ROOT = NodePath.join(HOME, "Library/Application Support/T3 Code Backups");
const LOG_DIR = NodePath.join(HOME, "Library/Logs/t3-local-install");
const STATE_DB = NodePath.join(HOME, ".t3/userdata/statev2.sqlite");
const LAUNCHD_LABEL_PREFIX = "com.t3code.local-install.";
const POLL_MS = 15_000;
const ACTIVE_RUNS_QUERY =
  "select thread_id, status from orchestration_v2_projection_runs where status in ('queued','preparing','starting','running','waiting')";
// Strings from our local customizations that must survive into the bundled web assets.
const FEATURE_MARKERS = [
  "Mesh animation",
  "Playback speed",
  "Animation position",
  "Inverse kinematics",
  "projects.watchFile",
  "as-reference",
  "Overlay the line numbers without extending the button into the code.",
  "WaitUntil",
  "AwaitAny",
  "replaceActiveFile",
  "background-color: light-dark(#d6e5f7, #374c68)",
];
const TOOLS = {
  codesign: "/usr/bin/codesign",
  ditto: "/usr/bin/ditto",
  launchctl: "/bin/launchctl",
  open: "/usr/bin/open",
  osascript: "/usr/bin/osascript",
  sqlite3: "/usr/bin/sqlite3",
};

const { values: options } = NodeUtil.parseArgs({
  options: {
    app: { type: "string" },
    zip: { type: "string" },
    version: { type: "string" },
    commit: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "max-wait-minutes": { type: "string", default: "180" },
    launchd: { type: "boolean", default: false },
  },
});
if (!options.app === !options.zip || !options.version) {
  console.error(
    "Usage: node scripts/local-install.mjs (--app <T3 Code (Alpha).app> | --zip <artifact.zip>) --version <build version> [--commit <sha>] [--dry-run] [--max-wait-minutes N] [--launchd]",
  );
  process.exit(2);
}
const sourceFlag = options.app ? "--app" : "--zip";
const sourcePath = NodePath.resolve(options.app ?? options.zip);
const expectedVersion = options.version;
const dryRun = options["dry-run"];
const maxWaitMinutes = Number(options["max-wait-minutes"]);
if (!Number.isFinite(maxWaitMinutes) || maxWaitMinutes < 0) {
  console.error("--max-wait-minutes must be a non-negative number");
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
NodeFS.mkdirSync(LOG_DIR, { recursive: true });
const logPath = NodePath.join(LOG_DIR, `${stamp}.log`);
const log = (message) => {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  NodeFS.appendFileSync(logPath, `${line}\n`);
};
const run = (tool, args) => NodeChildProcess.execFileSync(TOOLS[tool], args, { encoding: "utf8" });
const notify = (message) => {
  const title = dryRun ? "T3 local install (dry run)" : "T3 local install";
  try {
    run("osascript", [
      "-e",
      `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
    ]);
  } catch (error) {
    log(`Notification failed: ${error.message}`);
  }
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const archive = (app) => NodePath.join(app, "Contents/Resources/app.asar");
const hash = (file) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");
const readPackage = (app) => JSON.parse(extractFile(archive(app), "package.json").toString());
const isAppRunning = () =>
  run("osascript", ["-e", `application id "${BUNDLE_ID}" is running`]).trim() === "true";

// launchd reruns submitted jobs every 10 seconds, even after a clean exit, so a job
// submitted with --launchd (or any label with this prefix) removes itself when finished.
const launchdLabel = process.env.XPC_SERVICE_NAME?.startsWith(LAUNCHD_LABEL_PREFIX)
  ? process.env.XPC_SERVICE_NAME
  : null;
const finish = (code) => {
  log(`Exit ${code}. Log: ${logPath}`);
  if (launchdLabel) {
    try {
      run("launchctl", ["remove", launchdLabel]);
    } catch (error) {
      log(`Could not remove launchd job ${launchdLabel}: ${error.message}`);
    }
  }
  process.exit(code);
};

if (options.launchd) {
  const label = `${LAUNCHD_LABEL_PREFIX}${stamp}`;
  // launchd starts jobs in /, so pass every path absolute.
  const command = [
    process.execPath,
    NodeURL.fileURLToPath(import.meta.url),
    sourceFlag,
    sourcePath,
    "--version",
    expectedVersion,
    ...(options.commit ? ["--commit", options.commit] : []),
    ...(dryRun ? ["--dry-run"] : []),
    "--max-wait-minutes",
    String(maxWaitMinutes),
  ];
  run("launchctl", [
    "submit",
    "-l",
    label,
    "-o",
    NodePath.join(LOG_DIR, `${label}.out`),
    "-e",
    NodePath.join(LOG_DIR, `${label}.err`),
    "--",
    ...command,
  ]);
  log(`Submitted launchd job ${label}: ${command.join(" ")}`);
  log(`The job writes its own timestamped log to ${LOG_DIR}`);
  process.exit(0);
}

const activeRuns = () => {
  const output = run("sqlite3", ["-readonly", `file:${STATE_DB}?mode=ro`, ACTIVE_RUNS_QUERY]);
  return output.trim().split("\n").filter(Boolean);
};

async function waitForIdle() {
  const deadline = Date.now() + maxWaitMinutes * 60_000;
  let idlePolls = 0;
  let announced = false;
  for (;;) {
    let runs;
    try {
      runs = activeRuns();
    } catch (error) {
      runs = [`query failed: ${error.message.trim()}`];
    }
    if (runs.length === 0) {
      idlePolls += 1;
      log(`Gate: idle (${idlePolls}/2)`);
      if (dryRun || idlePolls >= 2) return true;
    } else {
      idlePolls = 0;
      log(`Gate: ${runs.length} active run(s): ${runs.join(", ")}`);
      if (dryRun) return false;
      if (!announced) {
        notify("Waiting for active T3 runs to finish before installing.");
        announced = true;
      }
    }
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

function verifyStagedApp(app) {
  const metadata = readPackage(app);
  if (metadata.version !== expectedVersion) {
    throw new Error(`Staged version ${metadata.version}, expected ${expectedVersion}`);
  }
  const commit = metadata.t3codeCommitHash;
  if (typeof commit !== "string" || !/^[0-9a-f]{7,40}$/.test(commit)) {
    throw new Error(`Missing embedded commit hash: ${commit}`);
  }
  if (options.commit && !options.commit.startsWith(commit) && !commit.startsWith(options.commit)) {
    throw new Error(`Embedded commit ${commit}, expected ${options.commit}`);
  }
  log(`Staged app: version ${metadata.version}, commit ${commit}`);
  const missing = new Set(FEATURE_MARKERS);
  for (const file of listPackage(archive(app))) {
    if (!/^\/.*assets\/.*\.js$/.test(file)) continue;
    const text = extractFile(archive(app), file.slice(1)).toString();
    for (const marker of missing) if (text.includes(marker)) missing.delete(marker);
  }
  if (missing.size) throw new Error(`Bundle lacks local features: ${[...missing].join(", ")}`);
  log("Bundle contains all local feature markers");
}

async function quitApp() {
  if (!isAppRunning()) {
    log("T3 Code is not running");
    return;
  }
  log("Quitting T3 Code");
  run("osascript", ["-e", `tell application id "${BUNDLE_ID}" to quit`]);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (!isAppRunning()) {
      log("T3 Code stopped");
      return;
    }
    await sleep(500);
  }
  throw new Error("T3 Code did not quit within 60 seconds");
}

// `launchctl remove` sends SIGTERM, which is how a newer build replaces a waiting job.
// Before the swap starts nothing has changed, so drop the stage and stop; once T3 is
// being quit, finish the swap or the restore instead of leaving a half-installed app.
let stagePath = null;
let replacing = false;
process.on("SIGTERM", () => {
  if (replacing) {
    log("SIGTERM during the swap; finishing it first");
    return;
  }
  log("Stopped by SIGTERM before replacing anything");
  if (stagePath) NodeFS.rmSync(stagePath, { recursive: true, force: true });
  finish(143);
});

async function main() {
  log(`${dryRun ? "Dry run" : "Install"}: ${sourcePath} as ${expectedVersion}`);
  if (!NodeFS.existsSync(sourcePath)) throw new Error(`Missing artifact ${sourcePath}`);
  if (!NodeFS.existsSync(INSTALLED_APP)) throw new Error(`Missing installed app ${INSTALLED_APP}`);
  const installedVersion = readPackage(INSTALLED_APP).version;
  log(`Installed version: ${installedVersion}`);
  if (installedVersion === expectedVersion && !dryRun) {
    log("Target version is already installed");
    notify(`${expectedVersion} is already installed.`);
    return;
  }

  // Stage on the Applications volume so the final swap is an atomic rename.
  const stage = NodeFS.mkdtempSync("/Applications/.t3-local-install.");
  stagePath = stage;
  log(`Staging in ${stage}`);
  try {
    if (options.app)
      run("ditto", [sourcePath, NodePath.join(stage, NodePath.basename(sourcePath))]);
    else run("ditto", ["-x", "-k", sourcePath, stage]);
    const name = NodeFS.readdirSync(stage).find((entry) => entry.endsWith(".app"));
    if (!name) throw new Error("Artifact contains no .app");
    const next = NodePath.join(stage, name);
    verifyStagedApp(next);
    run("codesign", [
      "--force",
      "--deep",
      "--sign",
      SIGNING_IDENTITY,
      "--preserve-metadata=entitlements",
      next,
    ]);
    run("codesign", ["--verify", "--deep", "--strict", next]);
    log("Staged app signed and verified");
    const newHash = hash(archive(next));

    const idle = await waitForIdle();
    if (dryRun) {
      log(`Gate check: ${idle ? "idle" : "busy"}`);
    } else if (!idle) {
      throw new Error(`T3 still had active runs after ${maxWaitMinutes} minutes; nothing changed`);
    }

    const backupDir = dryRun
      ? NodePath.join(stage, "backup")
      : NodePath.join(BACKUP_ROOT, `${stamp}-before-${expectedVersion}`);
    const backupApp = NodePath.join(backupDir, APP_NAME);
    if (NodeFS.existsSync(backupApp)) throw new Error(`Backup already exists: ${backupApp}`);
    NodeFS.mkdirSync(backupDir, { recursive: true });
    run("ditto", [INSTALLED_APP, backupApp]);
    const oldHash = hash(archive(INSTALLED_APP));
    if (hash(archive(backupApp)) !== oldHash) throw new Error("Backup archive hash mismatch");
    log(`Backup verified: ${backupDir}`);

    if (dryRun) {
      log("Dry run complete; nothing was quit or replaced");
      notify("Dry run passed.");
      return;
    }

    replacing = true;
    notify(`Installing ${expectedVersion}. T3 Code will restart.`);
    await quitApp();
    if (hash(archive(INSTALLED_APP)) !== oldHash) {
      throw new Error("Installed app changed during preparation");
    }
    const previous = NodePath.join(stage, "previous.app");
    NodeFS.renameSync(INSTALLED_APP, previous);
    try {
      NodeFS.renameSync(next, INSTALLED_APP);
      run("codesign", ["--verify", "--deep", "--strict", INSTALLED_APP]);
      if (hash(archive(INSTALLED_APP)) !== newHash) throw new Error("Installed archive mismatch");
      log("Installed app verified");
      run("open", [INSTALLED_APP]);
    } catch (error) {
      log(`Install failed after quitting, restoring previous app: ${error.message}`);
      if (NodeFS.existsSync(INSTALLED_APP))
        NodeFS.renameSync(INSTALLED_APP, NodePath.join(stage, "failed.app"));
      NodeFS.renameSync(previous, INSTALLED_APP);
      run("open", [INSTALLED_APP]);
      log("Previous app restored and relaunched");
      throw error;
    }
    log(`Installed and launched ${expectedVersion}. Backup: ${backupDir}`);
    notify(`Installed ${expectedVersion}.`);
  } finally {
    // Keep the stage if the restore itself failed, since it then holds the previous app.
    if (NodeFS.existsSync(INSTALLED_APP)) NodeFS.rmSync(stage, { recursive: true, force: true });
    else log(`Installed app is missing; previous app left in ${stage}`);
  }
}

main().then(
  () => finish(0),
  (error) => {
    log(`FAILED: ${error.stack ?? error}`);
    notify(`Failed: ${error.message}`);
    finish(1);
  },
);
