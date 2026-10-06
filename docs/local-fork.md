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
chords to the shell. The diff reset we fixed originated upstream in #15005. The Polyzonia `/play`
proxy is described below.

## Mobile code navigation, line comments and citations

Mobile reuses desktop's logic rather than its own copies: code is coloured with desktop's Pierre
syntax themes (`apps/mobile/src/features/review/desktopCodeThemes.ts`, plus AngelScript's semantic
colours), and go-to-definition is `resolveDefinitions` in
`packages/client-runtime/src/definitionNavigation.ts`, which desktop's hook also calls. Where the
logic is upstream web-only code, a shared copy carries a parity test against it
(`fileReviewComment.ts`, `assistantCitationSelector.ts`).

- In the file viewer (`apps/mobile/src/features/code-navigation/`), long-pressing a symbol opens its
  definition as a pushed screen, or a picker for overloads, which desktop leaves unresolved.
  Long-pressing a line number opens the review-comment sheet, and the result is the same file-comment
  record desktop's Files panel sends. With word wrap on, symbols take the long press; the rest of the
  line stays selectable.
- In chat (`apps/mobile/src/features/citations/`), Cite beside Copy turns selected assistant text into
  desktop's `[Assistant quote](t3-citation://…)` link, shown as a composer chip. Tap the chip to edit
  its comment.
- The native code canvas (`modules/t3-review-diff`) reports long-press gutter or column hits and draws
  the symbol tint. The markdown text module (`modules/t3-markdown-text`) adds the Cite menu item.
  Both need a rebuilt app.

## Polyzonia play proxy

`apps/server/src/play/` proxies `/play/*` to Polyzonia's play server on `127.0.0.1:8790`, so the
phone plays any worktree's web build over the same T3 Connect, Tailscale or LAN connection
(Polyzonia's `docs/remote_play.md` has the whole picture). In `server.ts` it is the route
layer and `createPlayHttpServer()`, Node's HTTP server with a 30-minute `requestTimeout` (Node's
default of 5 minutes cuts slow flag uploads from a phone).

- Access is a T3 session (read scope; operate for writes) or the `t3_play` cookie (`Path=/play`,
  HttpOnly, SameSite=Strict, 90 days, renewed on use). A browser gets the cookie from a one-time
  link `https://<host>/play/<worktree>/#ticket=<ticket>` that an agent posts in a thread.
- Links come from `POST /play/__auth/ticket`, with an operate session or the hex of
  `userdata/secrets/play-proxy.bin` as `{"key": "<hex>"}` in the JSON body, or in
  `authorization: T3Play <hex>` (Polyzonia's `scripts/play_web.sh` reads the file). Never in
  another header: the HTTP tracer writes request headers to `userdata/logs/server.trace.ndjson`
  except the redacted names. The play routes add `x-t3-play-key` (the header scripts used before,
  still accepted) to those names. Replacing the secret file and restarting revokes every link and
  cookie.
- Every response is `Cache-Control: private`: Cloudflare caches public responses on the T3 Connect
  hostname. The proxy's own replies (errors included) are `private, no-store`. The client is
  node:http, so precompressed bodies pass through untouched.
- `POST /play/__auth/logout` (same origin only) clears the cookie.
- Optional `userdata/play-proxy.json`: `{"enabled": false}` turns it off; `"upstream"` (loopback
  http only) and `"publicOrigin"` (for minted links) override the defaults.
- A minted link's address (`publicOrigin` in the ticket reply, with `publicOriginSource`):
  play-proxy.json's (`config`), else the https address a signed-in play page was last opened at,
  kept in `userdata/play-proxy-origin.json` across restarts (`learned`; never from a request
  without access), else T3 Connect's address derived from the managed tunnel's name in the
  `cloud-endpoint-runtime-config` secret (`t3-connect`: the relay names the tunnel
  `t3coderelay-managedendpoint-<stage>-<hash>` and the host `<stage>-<hash>.t3coderelay.com`; only
  the name is read, never the connector token).
- Tests: `vp test run src/play/PlayProxy.test.ts` in `apps/server`.

Clients open play links themselves (`packages/client-runtime/src/polyzoniaPlay.ts` is the rule: a
page under `/play/` on one of the thread's environment's addresses; anything else keeps its usual
target):

- Mobile (`apps/mobile/src/features/play/`) shows a full-screen play screen; so does
  `<scheme>://play?url=<encoded play link>` for paired environments only. A link's own ticket is
  redeemed by the page; without one, or once it is spent, the screen mints one with the app's
  session when the page reports it is signed out. A 16 pt strip on the left edge takes the closing
  swipe: WebKit fails native gestures over a page that prevents its touches' default, as the game
  does. The local module `apps/mobile/modules/t3-play-orientation` (iOS) widens the app's
  orientation mask while the screen is open; it answers `supportedInterfaceOrientationsFor`, so it
  must keep returning Info.plist's orientations otherwise. Native changes need a rebuilt app.
- Desktop opens the page in the integrated browser at the address it is connected to, with a
  ticket minted from its own session, so the posted ticket stays unspent; T3 Connect links are
  recognized through the ticket reply's `publicOrigin`.

**Play web build** plays a thread's own worktree without a posted link: ▶ in the mobile thread
header (`useThreadPlayWebBuild`, passed to `ThreadGitControls` as `playWebBuild`), and a row
under the project scripts in the desktop thread details panel (`PlayWebBuildControl`; the
project's own "Play" script is the desktop build). It shows when the environment's play server
(`/play/__health`'s `repo`) serves the thread's project root, and is disabled while that is not
known yet. `createPlayServerAtoms` asks on every connect and reconnect, and every 15 seconds
while the play server does not answer, so an open thread follows the connection. The iOS header
re-applies its native items only when its `optionsVersion` changes (the item factory is
stabilized), so the thread header includes `playWebBuildOptionsVersion`. It opens
`/play/__open?path=<worktree, or the project root>`: the play server owns worktree naming and
redirects to `/play/<name>/`, whose launcher explains or starts a missing, stale or failed
build. On web and desktop, ⌥⇧⌘D (Ctrl+Alt+Shift+D elsewhere) plays it from anywhere in the
thread, the terminal included: the `play.webBuild` keybinding command, rebindable in Settings →
Keybindings and backfilled into existing `keybindings.json` files at startup. The clients never
poll build state. To keep the thread title on an iPhone, the
compact thread header drops upstream's terminal button (`useThreadGitRightHeaderItems`); split
view and Android keep theirs.

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

Dependencies are installed with `vp install`; pnpm is not on PATH in agent shells. Commit first
(when authorized) so the embedded commit identifies the source, then:

```sh
T3CODE_BUILD_CACHE=1 vp run dist:desktop:artifact --platform mac --target dir --arch arm64 \
  --build-version <0.0.46+local.YYYYMMDD.label.N> --output-dir release/<unique-build-folder>
```

This leaves `release/<folder>/mac-arm64/T3 Code (Alpha).app`. `--target zip` still produces a ZIP,
which takes about 30 seconds longer.

`T3CODE_BUILD_CACHE=1` turns on our opt-in `vp run` cache for the web and server bundles (see
`scripts/lib/build-task-cache.ts`; upstream leaves them uncached). Unchanged bundles are restored
from `node_modules/.vite/task-cache` of that checkout. The build version and embedded commit are
written after the cached steps, so every build gets its own. vp keeps one entry per task, so going
back to older sources rebuilds; `vp cache clean` clears it. Measured on 5 October 2026: about 34
seconds after a web change, 14 after a server-only change and 12 with no change, against 63 for
the old uncached ZIP build.

Use a unique `+local` version. Local builds disable automatic updates so custom features stay.
As of 6 October 2026 the installed build is `0.0.46+local.20261006.playweb.1`.

## Installing while T3 Code is running

Installing quits T3 Code, which would kill every agent run inside it, including the one doing the
install. `scripts/local-install.mjs` therefore waits for an idle app and runs outside T3:

```sh
node scripts/local-install.mjs --launchd --app "release/<folder>/mac-arm64/T3 Code (Alpha).app" \
  --version <build version> [--commit <sha>] [--max-wait-minutes 180]
```

Pass `--zip <file>` instead of `--app` for a ZIP build.

- `--launchd` resubmits the command with `launchctl submit` under a
  `com.t3code.local-install.*` label, using absolute paths, so it survives T3 quitting. The
  submitting thread then ends its turn so its own run can finish. launchd reruns submitted jobs
  every 10 seconds even after a clean exit, so the job removes its own label when it finishes. Do
  not submit the script under another label.
- **Gate:** it polls `orchestration_v2_projection_runs` in `~/.t3/userdata/statev2.sqlite`
  (read-only) every 15 seconds and proceeds only after two consecutive polls with no run in
  `queued`, `preparing`, `starting`, `running`, or `waiting`. After `--max-wait-minutes` it gives up
  without changing anything.
- Before waiting, it copies the app (or unpacks the ZIP) onto the Applications volume, checks app.asar's version, the
  embedded `t3codeCommitHash` (against `--commit` when given), and markers for our custom
  features, then signs with the stable identity and verifies.
- Once idle, it backs up the installed app to
  `~/Library/Application Support/T3 Code Backups/<timestamp>-before-<version>/` and verifies the
  archive hash, quits T3 via bundle ID `com.t3tools.t3code` and confirms it stopped, swaps the app,
  verifies signature and hash, and relaunches. If anything fails after the quit, it restores and
  relaunches the previous app. Backups are kept.
- Each step is logged to `~/Library/Logs/t3-local-install/<timestamp>.log`, and macOS
  notifications announce waiting, installing, and success or failure.
- `launchctl remove <label>` stops a waiting job. Before T3 is quit it removes its stage and
  exits; once the swap has started it finishes the swap or the restore first.
- `--dry-run` runs the gate once and every verification, including a backup copy inside the
  staging folder, without quitting or replacing anything.

Signing uses the Apple Development identity Anton Karl Love Holmberg (H6SHQW7R8K), team
M6Z4YG5SD6, certificate SHA-1 `9996FD65608B18E540C4FE341030A5E801214B56`. Keeping it stable avoids
recurring Keychain access prompts. Older backups use names such as `20261005-before-diff-focus`.

Only install when the active conversation authorizes it; past installs are not blanket permission.

## Several t3code threads at once

- Task threads do not build or install the app. They commit on their branch, run scoped checks
  (and installer `--dry-run`s when they touch it), and report to the orchestrator.
- The orchestrator lands branches onto `polyzonia` one at a time in the main checkout, then
  builds once from the landed head and installs once with `--launchd`.
- If another branch lands while an installer still waits for idle T3, the orchestrator finds the
  waiting job with `launchctl list | grep com.t3code.local-install.`, checks that its latest log
  line under `~/Library/Logs/t3-local-install/` is still a `Gate:` line, removes it with
  `launchctl remove <label>`, then builds and submits a new installer for the newer head.

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
