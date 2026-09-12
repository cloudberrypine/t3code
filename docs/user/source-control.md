# Source control

T3 Code integrates with GitHub, GitLab, Bitbucket, and Azure DevOps to clone and publish
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

### GitLab

Install [GitLab CLI](https://gitlab.com/gitlab-org/cli), then sign in:

```bash
glab auth login
```

### Bitbucket

Set an access token in the server's environment:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
```

Or use an Atlassian account email and API token with read/write access to repositories and pull
requests, plus user read access (`read:user:bitbucket`):

```bash
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

The access token takes precedence if both are configured. Restart the server after changing these
variables.

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), add the DevOps extension, and sign in:

```bash
az extension add --name azure-devops
az login
```

## Clone or publish a project

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it.

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

For Azure DevOps, use the host website to view diffs or change comments. Bitbucket does not support
reopening a declined pull request.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket,
  confirm the running server received the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.
- **A review cannot load:** open it on the host website while resolving connectivity, permissions,
  or rate limits.

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

Drag the left edge of the file list to resize it beside the preview. Its width is remembered.

With the file browser focused, **Cmd/Ctrl+F** focuses **Search files**. When the selected file's
source editor has focus, the same shortcut opens text search inside that file.

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
background. The receiver must be identifiable from the available source; unrelated methods with
the same name are not highlighted. Added and removed lines retain their diff gutter markers.
Both sides of a diff use the current worktree's API.

The API is checked again when the pane opens, after relevant workspace updates, when the app
regains focus and every ten seconds while visible. Only changed API files are downloaded again.
When the API disappears, its symbol highlights are cleared and basic syntax highlighting remains.
Semantic highlighting is limited to source segments up to two million characters.

File-name headers in the diff view have a persistent background slightly brighter than the
collapsed-context markers, making file boundaries easier to find.
