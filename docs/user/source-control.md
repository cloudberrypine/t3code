# Source control

T3 Code integrates with GitHub, GitLab, Forgejo, Gitea, Bitbucket, and Azure DevOps to clone and publish
repositories, create pull requests, and review changes.

## Connect an account

Install Git and configure authentication on the machine running your T3 Code server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source Control**
and choose **Rescan**.

### GitHub

Install [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, then sign in:

```bash
gh auth login
```

### Forgejo and Gitea

Install [Forgejo CLI (`fj`)](https://codeberg.org/forgejo-contrib/forgejo-cli) or
[Gitea CLI (`tea`)](https://gitea.com/gitea/tea) 0.16 or later on your T3 Code server.
Sign in with `fj --host https://your-server auth add-token` or `tea login add`.
Repeat for each server you use, including Codeberg.

T3 Code prefers a matching `fj` login and falls back to `tea` when `fj` is unavailable
or has no login for that server. Once an account is selected, failed actions stay on that
account. Settings shows the detected CLI. Forgejo and Gitea share one integration entry.
Servers hosted under a URL subpath, such as `https://example.com/forgejo`, use `tea` because
fj 0.6 does not preserve the subpath when checking its account.

When cloning or publishing, use a full repository URL to select a specific server.
You can use `owner/repo` when only one fj server is configured, or with your default `tea`
login when fj is unavailable or unconfigured. With multiple fj servers, use the full URL.
If you have multiple `tea` accounts on one server, select one with
`tea login default <login-name>`. Git push and clone also need Git credentials or an SSH key
for that server.

### GitLab

Install [GitLab CLI](https://gitlab.com/gitlab-org/cli), then sign in:

```bash
glab auth login
```

### Bitbucket

Open **Settings → Source Control**, expand **Bitbucket**, and choose how to sign in:

- **Access token**: a token created for one repository, project, or workspace. It can only reach
  what it was created for.
- **API token**: an Atlassian API token for your account, used with your account email. It can
  reach every repository you can. Give it read/write access to repositories and pull requests, plus
  user read access (`read:user:bitbucket`).

Choose **Save**; the change applies right away, and replaces any credential saved with the other
method. Credentials are saved on the environment's server, so select a remote environment to
configure it. Saved tokens can't be viewed again; enter a new one to replace it, or choose
**Remove**.

If no credentials are saved, T3 Code falls back to these variables in the server's environment.
Restart the server after changing them:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
# or
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), add the DevOps extension, and sign in:

```bash
az extension add --name azure-devops
az login
```

## Start, clone, or publish a project

To start from nothing, choose **New project** in the command palette (`Cmd/Ctrl+K`), or
**New project** under **Add Project** on any client, and type a name. T3 Code makes a Git
repository in `~/.t3/projects` (the `projects` folder of your T3 data directory) with a README,
an icon, and a first commit, then opens a new thread in it. The folder is named after the project,
like `pinball-stats` for "Pinball Stats". Turn on **Create private repository on GitHub** to also
publish it. If Git has no name or email on that machine, the project is created without the
first commit.

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it. The project opens right away while the
clone runs in the background: you can write your first prompt, and sending waits until the files
are in place. A toast tracks progress and lets you cancel; if the clone fails, retry it from the
toast or from the banner above the composer.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository,
adds it as `origin`, and pushes your commits. If there are no commits yet, it creates the remote;
make your first commit before pushing.

## Create a pull request

Use a thread's Git actions to commit, push, and create a pull request. T3 Code can generate commit
messages, review titles, and descriptions from your changes.

Choose the writing style and model in **Settings → Source Control**. **Repository conventions**
uses the project's instructions and recent commit subjects.

Committing or pushing on the default branch, such as `main`, runs without an extra branch warning
or confirmation. The commit dialog still shows the current branch and selected files.

## Review and merge

Open **Pull requests** to review changes and comments, request reviewers, check out a branch,
or merge. You can edit review titles and descriptions and your own comments where the host allows it.
GitLab calls these merge requests.

GitHub, GitLab, and Azure DevOps support auto-merge while checks are outstanding. GitHub also
supports approving waiting fork workflows and opening a revert pull request for a merged change.

GitHub sharing is off by default. In Settings → Connections → GitHub sharing (Environments on mobile), choose
**Read PRs** or **Read and act** for each environment you trust to share GitHub access.
Enable both the original environment and the environment answering its requests on this client.
**Read and act** can use broader GitHub permissions than the original environment's credential;
only enable it for environments you control and trust. Changing a saved endpoint or removing an
environment clears its permission.

GitHub review details, linked PR status, and permitted review actions can then use another
connected environment signed in to the same GitHub account. Each needs a project on that host.
A connected local environment is preferred for actions and can answer slow or failed reads.
Browsers and mobile clients need a paired environment to use its GitHub CLI credentials.
Credentials stay on their machines. Previously verified credentials remain usable for routing
for ten minutes during a GitHub outage; new credentials must be verified first. An action with
an uncertain result is never automatically retried elsewhere. Listings, diffs, and checkout or
PR creation from Git actions continue to use the project's environment.

For Azure DevOps, use the host website to change comments. Bitbucket does not support reopening a
declined pull request.

### Mark files as viewed

Tick a file off in the **Code** tab once you have read it and it collapses; the toolbar keeps a
running count. A tick belongs to the pull request rather than to a commit, so scoping the tab to a
single commit keeps them. A file pushed to after you cleared it comes back marked **Changed**.

On GitHub these are GitHub's own viewed marks, so a review carries between T3 Code and github.com
in either direction. Forgejo, GitLab, Bitbucket, and Azure DevOps expose no record T3 Code can read, so the
server you are connected to keeps them instead: they follow you across the apps connected to that
server, but the host's own site will not show them, and the count reads **viewed in T3 Code**.

The **Code** tab is a web and desktop surface. The mobile app reports a pull request's status but
does not show its diff, so marks are made and read on web and desktop.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket,
  check the credentials saved in Settings → Source Control, or confirm the running server received
  the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.
- **A review cannot load:** open it on the host website while resolving connectivity, permissions,
  or rate limits.

## Filtered change totals

Add a `.t3diffignore` file at your repository root to see a second +/− total that
excludes matching files. On web and desktop, the Diff panel and the chat's changed-files
summaries show the full total first, then the filtered total in parentheses when the counts differ, such as
**+1,200 −800 (+300, −200)**. All files and their diffs remain visible.

Use `.gitignore` syntax: one pattern per line, `#` comments, `*` and `**` wildcards,
trailing `/` for directories, and `!` to include a matching file again. For example:

```gitignore
pnpm-lock.yaml
generated/
*.snap
!important.snap
```

Rules come from the current checkout, including a thread's worktree. Refresh the diff
or refocus T3 after editing the file externally. Remove `.t3diffignore` to return to a
single total. These rules do not affect Git tracking, commits, or checkpoint restoration.

## Diff navigation

- Show a file tree next to a review's **Code** tab, or a thread's **Diff** panel, to browse the
  changed files as folders and jump straight to any of them. The toolbar toggle remembers your
  choice. Use **Search files** to filter the changed-file tree by name or path, including files
  whose diffs have not been loaded. Press **Cmd/Ctrl+F** with that file browser focused to focus
  its search field; **Escape** clears the filter. Drag the tree’s left edge to resize it in
  thread diffs and pull-request reviews. Its width is remembered separately from the Files panel.
  Clicking an already-selected file scrolls back to that file’s header in the diff.
  As you scroll, the tree highlights the file whose header is at the top of the diff view.
- When a directory is replaced by a file or symlink (or the reverse), the web and desktop diff
  tree keeps both changes visible. The file row gets a **(file)** suffix to distinguish it from
  the folder; selecting it still opens the diff for its original path.
- With the diff viewer focused, **Cmd/Ctrl+F** opens text search. Search loaded diff hunks,
  including their context lines, with match-case, whole-word, and regular-expression options.
  **Enter** moves to the next match, **Shift+Enter** to the previous match, and **Escape** closes
  search. Matches in collapsed files open those files automatically. Load an omitted file's
  diff before searching its contents.
- Large working-tree and branch diffs keep every known changed file visible while limiting the
  initial patch payload to 120 MB per source and considering up to 25,600 files. Individual files
  can load up to 100 MB on demand. Files whose patches were omitted appear as collapsed **Not loaded** rows;
  expand one, or select its **Load** entry in the file tree, to fetch that file on demand. The bulk
  expand control affects only loaded files.
- Diffs follow the selected thread’s project or worktree, including projects outside the folder
  where the server was started.
- Web and desktop diffs use added/removed line backgrounds without extra highlighting on changed
  words or characters. Syntax colors and search-match highlights remain available.
  File-header added/removed counts update with the diff, including while a file is collapsed.
- In web and desktop diffs, each collapsed context section shows its remaining unchanged-line
  count. Use the up and down controls to reveal 20 lines at a time above or below a change.
  Between two changes, expand from either end of the same gap. Clicking the count reveals the
  next 20 lines from the earlier change, or above the first change at the start of a file.
  Context counts load when a file is viewed, including for turn and pull-request diffs.
  If a file changes before its context loads, the existing diff stays visible. Refresh the diff
  to load context from the updated file.

### Refreshing files

The **Files** browser and its file-name search include gitignored files, including generated files.
Git metadata and files inside nested checkouts are excluded. Very large directory trees retain
the file browser's listing limit.

The web and desktop **Files** panel refreshes after file changes and completed commands reported
by the current thread, and after its checkpoints. It does not continuously watch every file on
disk. To see edits from another agent, thread, or application, select the file again or use the
file browser's **Refresh files** button. Both actions reload the selected preview, including SVGs,
other images, videos, and PDFs. Pending local text edits finish saving before a refresh is applied.

Click a file in the web or desktop file tree to replace the current file tab. **Alt-click**
(**Option-click** on macOS) opens it in a new tab. Files already open switch to their existing tab.

Drag the left edge of the file list to resize it beside the preview. Its width is remembered.

With the file browser focused, **Cmd/Ctrl+F** focuses **Search files**. When the selected file's
source editor has focus, the same shortcut opens text search inside that file.

In AngelScript files, **Cmd-click** (macOS) or **Ctrl-click** (Windows/Linux) a symbol to open
its declaration. This works for local declarations, members with known types, and declarations
in the workspace's `ScriptingAPI.as`. You can also follow `#include` paths and script namespace
references, including members defined in those scripts. The original file stays open in its tab.
Ambiguous definitions are left unresolved.
In behavior scripts, Cmd/Ctrl-click a state in the generated tree comment above the species
namespace to open its `state` block, including states from shared libraries. State calls and
`transition(...)` targets also support definition jumps. Older `enum State` members still jump
to their matching blocks. The implicit `e`, `w`, `c`, `p`, and `o` accessors support navigation
to their getters or script classes and members.
Use **Option+Cmd+Left/Right** or **Control+Cmd+Left/Right** on macOS, or
**Ctrl+Alt+Left/Right** on Windows/Linux, while the
Files or diff panel is focused to step backward or forward through definition jumps. Each thread keeps
its own history for the session; a new jump after going back clears the forward history. Back
closes a destination tab if that jump opened it; tabs that were already open stay open. Forward
reopens the destination when needed. Moving
the text cursor or editing clears the blue jump highlight.

In `ScriptingAPI.as`, Cmd-click an API declaration again to follow it into C++.
This follows matching types and fields, nested type aliases, and registered binding wrappers.
C++ files also support Cmd-click navigation for local declarations, types, fields, functions,
methods, and includes. Cmd-click a function declaration in a header to open its implementation;
Cmd-click the function name on its implementation to return to its declaration.
Function bodies are preferred over prototypes when found. These lookups
use the connected workspace and share the same back/forward history.

Cmd-click also works on AngelScript and C++ symbols in thread diffs, in either unified or
split view. The destination opens in **Files**, where the same back/forward shortcuts apply.
Back returns to the originating diff scope, file, line, and side; Forward reopens the definition in Files. Navigation uses the clicked revision for
local context and the connected workspace for other files; it does not check out historical files.

On macOS, **Control+Cmd+Up** and **Control+Cmd+Down** both switch between the current C++
source file and its matching header. Matching files in the same directory take priority;
otherwise the nearest unambiguous match in the workspace is used. These switches also enter
back/forward history.

C++ navigation is approximate: complex templates, generated code, macro expansion, and overloads
requiring full type analysis may remain unresolved. Workspace searches and file reads are bounded;
no C++ language server or build configuration is required.

### Markdown front matter

Rendered Markdown files display a leading YAML front-matter block separately above the document.
Metadata keeps its line breaks and indentation, and long values wrap to fit the preview. It is
shown as literal text, so Markdown-like characters in values do not become headings, links, or
checkboxes. This works in web, desktop, and mobile file previews.

The opening delimiter must be `---` on the first line. Close the block with `---` or `...` on its
own line. A missing closing delimiter leaves the document rendered as ordinary Markdown. Source
view preserves the original file, and task checkboxes below the metadata still update that file.

### AngelScript highlighting

AngelScript files use language-specific syntax highlighting in file previews and diffs.
T3 Code searches the current worktree for a file named **ScriptingAPI.as** and uses its declarations
to highlight API types, constants, globals and functions. The file can live anywhere in the worktree
and may be gitignored. Dependencies in `node_modules`, T3 runtime data and nested checkouts are not searched.
If more than one API file is found, basic syntax highlighting remains available without choosing
one arbitrarily.

Calls to methods annotated with `/** await */` or `/** await(State) */` have an amber line
background. The built-in `AwaitAny(...)`, `WaitUntil(...)`, and identifiable HSM sub-state calls
use the same background. Generic event APIs and native property accessors use the generated
API's types for highlighting. `behavior` and `library` blocks keep their own scopes:
inside a library, `p` and `o` navigate to that library's `Params` and `Object`, including
their fields, regardless of the embedding member's name in the behavior.
For methods, the receiver must be identifiable from the available source; unrelated methods with
the same name are not highlighted. Added and removed lines retain their diff gutter markers.
Both sides of a diff use the current worktree's API.

The API is checked again when the pane opens, after relevant workspace updates, when the app
regains focus and every ten seconds while visible. Only changed API files are downloaded again.
When the API disappears, its symbol highlights are cleared and basic syntax highlighting remains.
Semantic highlighting is limited to source segments up to two million characters.

File-name headers in the diff view have a persistent background slightly brighter than the
collapsed-context markers, making file boundaries easier to find.

## Linked pull requests

A thread can hold several pull requests, including reviews from another repository on the same host.
Use **Link pull request** in the command palette or **Linked pull requests** panel, or right-click a
pull request link in the conversation. Creating a pull request from Git actions links it automatically.
Agents can link their pull requests with the `link_pull_request` tool.

Use **Link this PR** in a branch-detected badge's tooltip to keep it with the thread. From a review
on the Pull Requests page, **Link to thread** lets you search for an active thread. The review header
also lists the threads that link to it, including archived threads, so you can return to their context.

Thread badges show a stack's layer count or the current review number with a count of additional
links. Clicking a badge with more than one review opens the **Linked pull requests** panel. On mobile, the Git overview lists linked reviews and their stacks; tap a review to open it.
Linking and unlinking are available in the web and desktop clients.

The **Linked pull requests** panel lists every review and groups stacks. Unlink a review from its
row menu. An unlinked stack layer stays out of later syncs. Open linked reviews refresh on the server;
closed reviews refresh periodically so reopening one on the host is detected. Merged reviews refresh
when requested. With **Auto-settle merged threads** enabled, a thread can settle after every linked
review is terminal. An open or unsynced link keeps it active.

Ask the agent to watch, monitor, or babysit a pull request and it calls `watch_pull_request`. While
the thread is active, the server checks the pull request every minute and wakes the agent when a check
fails, the required checks pass, someone else comments or reviews, or the branch starts to conflict.
Comments from your own account do not wake it. Watching ends when the pull request merges or closes,
after 10 wakes in a row that bring only comments, or when the server cannot read the pull request for
15 minutes. To start or stop it yourself, use the row menu in the **Linked pull requests** panel.

Cross-repository links use a project on the same host. Azure DevOps reviews require a project checked
out from the matching organization and repository.

## GitHub stacks

The Pull Requests page shows each PR's position in its GitHub stack. Open the stack badge in a
review to navigate its layers. **Merge stack** submits the selected pull request and every unmerged
layer below it to GitHub together, respecting branch rules and merge queues. The confirmation shows
the scope and merge strategy. GitHub rebases the remaining stack after merging.

**Rebase stack** updates remote branches from bottom to top without changing your local checkout.
It can rewrite history and restart checks. If a layer fails, earlier updates remain; resolve that
layer before retrying. GitHub may require manual conflict resolution after a lower layer is amended,
even when its changes look independent. Stack actions require an environment that supports them.
