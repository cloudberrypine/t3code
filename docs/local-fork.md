# Local fork: development and installation

This is Anton's fork of T3 Code. These notes apply to the fork only; upstream docs and AGENTS.md
still apply. Check actual Git state rather than trusting the snapshots below.

## Repository and branches

- Main checkout: `/Users/antonholmberg/Projects/t3code`. On another machine, locate the equivalent
  checkout first. Use that working directory (or `git -C`), never an unrelated project.
- Upstream: `https://github.com/pingdotgg/t3code.git`, remote `origin`.
- Our fork: `https://github.com/cloudberrypine/t3code.git`, remote `cloudberrypine`.
- Working and publication branch: `polyzonia`. It supersedes the old `polyzonia` branch and
  `codex/local-nightly-v2`.
- On 5 October 2026 we merged `v0.0.46-nightly.20261005.2667` (Orchestration V2). At that point
  `polyzonia` was at `4e4c37317` (diff scope and terminal session shortcuts).

## Where t3code work happens

t3code work runs in git worktrees under `~/.t3/worktrees/t3code/`, one per task, bound to threads
in the **polyzonia** T3 project. Those threads work on this repository, so they ignore
Polyzonia's AGENTS.md and skills. An orchestrator thread merges finished branches into
`polyzonia`; task threads do not merge or push.

## How we develop

- Investigate the cause of an issue, including whether it exists upstream or comes from our
  customizations.
- Make focused changes and preserve existing behavior. Prefer upstream implementations when they
  provide equivalent features.
- Keep custom functionality in separate modules and hooks where practical, so nightly merges stay
  easy. If a local feature creates a hard merge tradeoff, explain the concrete choice and let Anton
  decide.
- Before merging a nightly, inspect dirty files and preserve outstanding work with authorized
  commits and recoverable Git backups. Merge the verified nightly tag while retaining local
  history, resolve conflicts, remove superseded local implementations, then verify the affected
  features.
- We adopted upstream V2's worktree retention: settled threads keep their worktrees. Do not restore
  our old automatic deletion and restoration.

Our custom features: Polyzonia mesh JSON previews (vertices, joints, skinning, IK handles,
animation playback and scrubbing); AngelScript syntax and semantic highlighting with
source/API/C++ navigation; caret-based reference highlighting; automatic file refresh after disk
changes; file clicks replacing the active tab, with Alt/Option-click opening a new tab; comment
buttons overlaying line numbers without shifting code; diff search, navigation, scroll memory,
filtered statistics, and a selected diff mode that survives updates and reopening; Markdown front
matter; usage adjustments; desktop completion and question notifications; generated-image
rendering; and Cmd+1–9 / session traversal while a terminal has focus, without sending those
chords to the shell. The diff reset we fixed originated upstream in #15005.

## Verification

- Focused behavioral tests, scoped lint, and typechecks for affected packages. No repository-wide
  checks unless requested.
- Terminal and WASM tests run from `apps/web`: `vp test run --project unit <test files>`.
- Consider desktop, web, mobile, and remote connections where relevant. Ask before browser or
  computer-use verification unless already authorized.
- Never start a test server against live `~/.t3/userdata`, modify its database, or copy an active
  SQLite file without a consistent snapshot. Never kill processes by matching names or paths. Never
  set `VITE_HTTP_URL` or `VITE_WS_URL` for dev.

## Building

Commit first (when authorized) so the embedded commit identifies the source, then:

```sh
vp run dist:desktop:artifact --platform mac --target zip --arch arm64 \
  --build-version <0.0.46+local.YYYYMMDD.label.N> --output-dir release/<unique-build-folder>
```

Use a unique `+local` version. Local builds disable automatic updates so custom features stay.
As of 5 October 2026 the installed build is `0.0.46+local.20261005.diff-focus.1`.

## Installing while T3 Code is running

Installing quits T3 Code, which would kill every agent run inside it, including the one doing the
install. `scripts/local-install.mjs` therefore waits for an idle app and runs outside T3:

```sh
node scripts/local-install.mjs --launchd --zip release/<folder>/T3-Code-0.0.46-arm64.zip \
  --version <build version> [--commit <sha>] [--max-wait-minutes 180]
```

- `--launchd` resubmits the command with `launchctl submit` under a
  `com.t3code.local-install.*` label, using absolute paths, so it survives T3 quitting. The
  submitting thread then ends its turn so its own run can finish. launchd reruns submitted jobs
  every 10 seconds even after a clean exit, so the job removes its own label when it finishes. Do
  not submit the script under another label.
- **Gate:** it polls `orchestration_v2_projection_runs` in `~/.t3/userdata/statev2.sqlite`
  (read-only) every 15 seconds and proceeds only after two consecutive polls with no run in
  `queued`, `preparing`, `starting`, `running`, or `waiting`. After `--max-wait-minutes` it gives up
  without changing anything.
- Before waiting, it stages the ZIP on the Applications volume, checks app.asar's version, the
  embedded `t3codeCommitHash` (against `--commit` when given), and markers for our custom
  features, then signs with the stable identity and verifies.
- Once idle, it backs up the installed app to
  `~/Library/Application Support/T3 Code Backups/<timestamp>-before-<version>/` and verifies the
  archive hash, quits T3 via bundle ID `com.t3tools.t3code` and confirms it stopped, swaps the app,
  verifies signature and hash, and relaunches. If anything fails after the quit, it restores and
  relaunches the previous app. Backups are kept.
- Each step is logged to `~/Library/Logs/t3-local-install/<timestamp>.log`, and macOS
  notifications announce waiting, installing, and success or failure.
- `--dry-run` runs the gate once and every verification, including a backup copy inside the
  staging folder, without quitting or replacing anything.

Signing uses the Apple Development identity Anton Karl Love Holmberg (H6SHQW7R8K), team
M6Z4YG5SD6, certificate SHA-1 `9996FD65608B18E540C4FE341030A5E801214B56`. Keeping it stable avoids
recurring Keychain access prompts. Older backups use names such as `20261005-before-diff-focus`.

Only install when the active conversation authorizes it; past installs are not blanket permission.

## Settings and appearance

V2 keeps Electron data in `~/Library/Application Support/t3code-v2` and server state in
`~/.t3/userdata/statev2.sqlite`. App replacement must not touch either. Anton uses the custom
ChatGPT Graphite theme; the first V2 install lost the selection because it created a fresh profile,
and we restored the theme library and selection from the old `t3code` profile. Preserve it. Before
a future database migration, make a consistent read-only SQLite backup.

## Delivery

When publishing is requested, push to `cloudberrypine/polyzonia`. Do not create a PR unless
explicitly asked. Finish with what changed, what was verified, limitations, the branch, and whether
the local installation was replaced.
