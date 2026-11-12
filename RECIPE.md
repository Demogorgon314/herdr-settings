# herdr-t3

A working layout for running coding agents: a 268px sidebar with spaces and agents (or a focus
list of the agents waiting on you), a 40px tab bar, the terminal, and a 368px tools panel on the
right with Files, Changes, Sessions and Favorites. Everything follows the theme's tokens, so it
looks native in light and dark.

![herdr-t3](preview.png)

**What you see:** left to right. The sidebar (`background: chrome`, 268px, `min 180`, `max 480`)
holds a 40px brand bar with the traffic lights at `[16, 13]`, then either Spaces over Agents
(`weight 1` each, `min 90`) or the Focus list, then a 41px footer with Settings. The work column
has a 40px tab bar, then a row (padding `[2, 8]`, gap 8) with the active tab's panes and the tools
panel, then a 6px inset. Panes have a 28px `t3-pane` header on top, radius 8, gap 8, a 2px border in
the background colour and terminal padding `[8, 0]`. The tools panel (368px, `min 280`, `max 900`,
hidden at first) is a 38px segmented switch over a stack of four panels. Root: `background: canvas`,
1px `border` dividers, `titlebar: "none"`, `terminal_opacity: 0`. Type is the theme's own; panel
text 11–13px.

- **Spaces**: a coloured letter avatar per space (one of `ansi1`–`ansi6`, kept in
  `shared("space.colors")`), worktrees indented under their checkout, grouped by machine when more
  than one is known; a branch or ahead/behind only when unusual.
- **Agents**: Priority (blocked, done, working, idle) or Grouped by space; a parent takes its most
  urgent sub-agent's place.
- **Tab bar**: tabs named after their lead agent, then a 28px button group on a `raised` track:
  one-agent view, New…, tools panel. The button whose thing is showing sits raised (`background`
  fill, 1px `border`, small shadow, `accent` icon).
- **Tools switch**: four equal segments (Files, Changes, Sessions, Favorites) on a 30px `raised`
  track; labels show from 326px of track, icons only below.
- **Files**: the focused pane's folder as a lazy tree with git marks (A, M, D, U).
- **Changes**: under its header, a multi-line message box (2–8 rows) with ✨ in its corner, an agent
  chip and a 24px Commit button; then the changed files; then the diff.
- **Sessions**: rows of title, `time · folder` and tags, led by the agent's mark on a 22×20
  `raised` tile: Claude `#D97757`, Codex `#5B7CFF`, pi `#1F9D8A`, OpenCode in the text colour. The
  header counts sessions per agent as mark + number, only for agents present.
- **Favorites**: two-line rows (name; machine · folder) with an `Open` badge when a space is there.

**How it behaves:** agent statuses read the same everywhere: working is a spinning
`mods/workspace-chrome/spinner.svg` in `working`, blocked a `!` on a `blocked` tint, done a 7px
`done` dot; a viewed done agent turns idle. Clicking a space or tab selects it; right-click opens
its menu; tabs drag to reorder and double-click renames. `cmd-shift-b` switches the sidebar between
lists and Focus, `cmd-shift-a` between tabs and the one-agent view.

Motion is native and small: hover actions fade (140ms ease-out), menus and banners fold (180ms
ease-out), the tools pill springs between segments (response 260, damping 0.86) and follows the
panel's width. Every button has a hover fill and a darker pressed state.

- **Files**: hovering a row fades in Favorite (folders), `cd` here (folders) and Copy path; a done
  action shows a green check for 1.2s instead of a toast.
- **Changes**: ✨ runs the agent from the chip (Claude Haiku, Claude Sonnet, Codex, pi, OpenCode;
  missing ones are marked `not installed`) and fills the box; while it runs the ✨ spins and turns
  into a red stop square under the pointer. Disabled states explain themselves in the tooltip
  (loading, committing, no changes, message not empty, remote repo, agent not installed). The chip
  drops its menu over the file list. ⌘↵ or Commit stages everything and commits; a green
  `✓ Committed <hash>` banner folds open under the button for 2.2s.
- **Sessions**: rescans every 30s and whenever the space or focused terminal changes. A click
  resumes the session in a new tab in its recorded folder; `+` (fades in on hover) adds
  comma-separated tags; clicking a tag filters by it; search takes words and `#tag`s.
- **Favorites**: a click selects the space on that folder or makes one; Add current saves the
  space's own folder; Add a folder… picks any; ✕ (fades in on hover) removes.

**Built from:** `layouts/herdr-t3.json`, a `row`:

- `sidebar` (column): `brand` → `t3-chrome` (40px, `window_drag`); stack `sidebar-lists`
  (`active: lists`) of column `lists` [`spaces` → `t3-spaces`, `agents` → `t3-agents`] and `focus` →
  `t3-focus` (`props.newMenu: "t3-new-menu"`); `sidebar-footer` → `t3-chrome` (`props.footer: true`,
  41px).
- `work` (column): `tabs` → `t3-tabs` (40px, `window_drag`); row `work-body` of stack `view`
  (`main` = `{ tab: "active", pane: { header: { content: { mod: "t3-pane" }, height: 28 } } }`,
  `agent` = `{ agent: "focused" }`) and column `panel` [`tools-nav` → `t3-tools-nav` (38px), stack
  `tools-body` of `files` → `t3-files`, `changes` → `t3-changes`, `sessions` → `t3-sessions`,
  `favorites` → `t3-favorites`]; `work-bottom-inset` (6px); `status` → `workspace-status` (hidden).

Mods: `t3-files` and `t3-changes` are clones of the shipped `files` and `changes`
(`mod.clone`); `t3-changes/ai.js` holds the agent table, prompt, diff budget and output cleanup.
`t3-sessions` scans with one `python3 -c` pass (pi `~/.pi/agent/sessions/*/*.jsonl`, Claude
`~/.claude/projects/*/*.jsonl`, Codex `~/.codex/sessions/*/*/*/rollout-*.jsonl` titled from
`~/.codex/session_index.jsonl`) plus `sqlite3` on `~/.local/share/opencode/opencode.db`. Agent
marks are `mods/t3-sessions/agents/{claude,codex,pi,opencode}.svg`, used by both mods. Shared state:
`t3.favorites`, `t3.sessions.tags`, `t3.commit.agent`. Calls: `exec`, `hc send` (cd),
`run("terminal.open" | "layout.select" | "layout.toggle" | "space.select" | "space.new" | "mod.open")`,
`setShared`, `pickFolder`, `notify`. Shipped mods relied on: `workspace-status`, and art from
`workspace-chrome` (spinner, check, square, chevron-down, plus, panel-right).

## Watch out

- Measure, don't trust the layout: the tools pill takes the track's drawn width from
  `on_size_change`; a node's `size.px` can differ from what it got (min/max, unsaved resizes).
- `transition` only animates later changes: anything that fades in on hover or folds open is drawn
  all the time at opacity 0 or height 0. A folded element still counts in its parent's `gap`; wrap
  it with its neighbour instead.
- A dropdown below other content must go in a `Popup`, or later siblings paint over it.
- `exec` has no stdin and no cancel: commit messages run through
  `sh -c 'f=$1; echo $$ > "$f"; p=$2; shift 2; printf "%s" "$p" | "$@"; …'` and Stop kills the
  children of the pid in that file. Save the pid file's path before `shift`.
- Agents run one-shot and isolated: Claude `-p --tools "" --strict-mcp-config --settings
  {"disableAllHooks":true}`; Codex `exec --ephemeral -s read-only`; pi `--print --no-session
  --no-tools --no-skills --no-extensions --no-context-files`. Codex and OpenCode take 14–17s, Claude
  Haiku and pi 2–4s.
- Codex user prompts start with injected context (AGENTS.md, `<environment_context>`…): skip it for
  titles; leave out delegated sub-agent rollouts; collapse a thread's rollouts to the newest.
- A panel is not re-rendered when the space or focus changes: Sessions watches `where()` on a 500ms
  timer.
- Editing a mod doesn't reload the copy on screen: switch layouts and back.
- Sessions filters by the space's own folder, not the terminal's; a space made elsewhere shows that
  folder's sessions.

## Done when

- `herdr-app check` passes for all twelve `t3-*` mods and `layout.switch --name herdr-t3` leaves no
  entry in `herdr-app status`'s `errors`.
- The tools button opens the panel; each segment shows its panel and the pill slides under it.
- In Files, hovering a folder fades in three actions; Copy path leaves the absolute path on the
  clipboard and shows a check.
- In Changes, ✨ fills the box with a message from the chosen agent, Stop ends it, and
  Commit commits and shows the banner.
- Sessions lists Codex rows with the Codex mark and resumes one with `codex resume <id>` in its
  folder; `#tag` narrows the list.
- Favorites' Add current saves the space's folder and a click switches to that space.
