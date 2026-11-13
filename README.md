# herdr-settings

My [Herdr](https://herdr.dev) setup: the `herdr-t3` layout, the mods it uses, and its key bindings.

![herdr-t3](preview.png)

Spaces and agents on the left, the terminal in the middle, and a right-hand tools panel with
**Files**, **Changes**, **Sessions** and **Favorites**. Names and terminal text in the preview are
blurred.

## What's in it

| Path | What it is |
| --- | --- |
| `layouts/herdr-t3.json` | The layout (cloned from Herdr's `main`); `herdr-t3.svg` is its picker thumbnail |
| `mods/t3-chrome` | Sidebar brand bar (room for the traffic lights, drags the window) and the Settings footer; `t3-chrome.sidebar` switches the sidebar between spaces/agents and the focus list |
| `mods/t3-spaces` | Spaces with stable coloured avatars, worktrees under their checkout, grouped by machine |
| `mods/t3-agents` | Agents grouped or by priority; a parent takes its most urgent sub-agent's place |
| `mods/t3-focus` | Focus sidebar: only agents still asking for attention, as cards, then Working and Settled |
| `mods/t3-tabs` | Tab bar with agent status, and a button group: one-agent view, New…, tools panel |
| `mods/t3-new-menu` | New: pick a space (or a new one), then what to run there; opened by `t3-tabs` |
| `mods/t3-pane` | Pane header: program icon, title, folder, status; split, zoom and close |
| `mods/t3-tools-nav` | Segmented switch over the tools panel, with a sliding pill; icons only under 326px |
| `mods/t3-files` | Clone of Herdr's `files`; hovering a row fades in Favorite, `cd` here, and Copy path |
| `mods/t3-changes` | Clone of Herdr's `changes`: files in Staged / Changes / Untracked sections with stage, unstage and discard on hover; a GitHub-style review (window or tab) with line comments you send to an agent; an [Orca](https://github.com/stablyai/orca)-style commit box where ✨ asks an agent of your choice to write the message |
| `mods/t3-sessions` | pi, Claude Code, OpenCode and Codex sessions recorded in the current space's folder; click to resume, `+` to tag, `#tag` to filter |
| `mods/t3-favorites` | Saved folders; click to switch to that space (or open one) |
| `keys.json` | Only the `layout:herdr-t3` section: `cmd-shift-b` switches the sidebar, `cmd-shift-a` the one-agent view |

The layout also uses Herdr's own `workspace-status` and `workspace-chrome` (icons); they ship with
Herdr and are not in this repo.

`t3-files`, `t3-changes`, `t3-sessions` and `t3-favorites` started as ports of
[Lamb-Yang/herdr-sessions](https://github.com/Lamb-Yang/herdr-sessions). Agent marks and colours
follow [HarnessTrajectory](https://github.com/Demogorgon314/HarnessTrajectory): Claude and Cursor
from Simple Icons (CC0), Codex, Kimi, Grok, Devin, pi and OpenCode from lobe-icons (MIT), DeepSeek's
fish from deepseek-harness. The marks belong to their makers and only identify the agents here.

## Install

```bash
git clone https://github.com/Demogorgon314/herdr-settings.git
./herdr-settings/install.sh
```

It copies the layout and mods into `~/.config/herdr-app` (`HERDR_APP_HOME` picks another), keeping
anything it replaces as `<name>.backup-<time>`, merges the key section into `keys.json`, runs
`herdr-app check` on every mod, and switches to `herdr-t3`. The tools panel starts hidden: open it
with the panel button at the top right.

`./uninstall.sh` removes them again, restores the backups, and drops the key section.

## Requirements

A missing program only turns off its own feature.

| Program | Used for |
| --- | --- |
| `git` | Files marks, Changes, commits |
| `python3` | Scanning session files for Sessions |
| `sqlite3` | Reading OpenCode's session database |
| `claude`, `codex`, `pi`, `opencode` | Resuming their sessions; writing commit messages (pick one in Changes) |

## Changes and review

Changes lists the files the way editors do, in Merge, Staged, Changes and Untracked sections.
Hover a row for Discard (click twice), Stage or Unstage, or a section header for Stage all /
Unstage all. Commit (⌘↵) commits what is staged, or everything when nothing is.

Clicking a file, or the review icon in the header (Review all changes), opens a window laid out like GitHub's "Files
changed": the changed files as a tree on the left, every diff on the right as a card with old and
new line numbers. Click a file in the tree (or press `j` / `k`) to go to it, a card's header to
fold it, and **Viewed** to tick it off and fold it. Diffs over 800 lines start folded. Esc closes.
The window follows the folder (Refresh reads it again; a viewed file that changed is unticked),
and its tab button moves the review, as it is, into a tab of its own.

### Review comments

Leave comments on the diff the way GitHub does: the line under the pointer shows a blue **+**;
click it (shift-click another line for a range), or a card's comment button for the whole file.
GitHub's form opens under the lines (`Add a comment on lines R57 to R59`, Write / Preview, ±
to insert a suggestion with the lines' code); write and press ⌘↵. Comments show under their lines
and follow them as the files change (one whose line is gone moves to the top of its file, marked
`not in the diff now`); click one to edit it in place or delete it. A click-drag can't pick lines:
Herdr's list rows take no mouse handlers, so a range is a click and a shift-click. **Send N comments** in the title
bar pastes them into the prompt of an agent in the current space (the focused one first), each
as file, lines, the quoted code and your comment, as [Orca](https://github.com/stablyai/orca)
sends review notes, and shows that agent: nothing is submitted, so you read, edit and press Enter
yourself. The paste goes through the clipboard. Sent comments stay, tagged `sent to <agent>`;
the next Send takes only the new ones (or all again once every one was sent), and editing one
makes it new. Tick **Clear after sending** in the same menu to have them cleared instead. The menu
also copies them as text, deletes the sent ones, or deletes all. Comments are kept per repository
in `t3.review.comments`.

## AI commit messages

The ✨ in the Changes message box runs the chosen agent once, read-only and without saving a
session (Claude, Codex, pi and OpenCode to start with; the choice is kept as `t3.commit.agent`).
The prompt goes in on stdin: the instructions, your last ten commit subjects so the message
matches their language and style, new file names, and up to 60,000 characters of diff shared
fairly across files. That diff is sent to the model behind the agent you pick. While it writes,
the ✨ turns into a spinner; click it to stop.

A commit message needs no strong model, so the defaults are small and quick: Claude Haiku and
Codex GPT-6-Luna at low effort, pi at low thinking on its configured model, OpenCode on its own.

**Settings…** at the bottom of the agent menu opens a dialog, laid out after
[Orca](https://github.com/stablyai/orca)'s, where you can:

- switch each agent on or off (only those on are in the menu);
- change its name and logo (Claude, Codex, pi, OpenCode, Cursor, Kimi, Grok, Devin, DeepSeek or
  a plain mark);
- pick its model and effort. Like Orca, each known CLI lists its own models: Claude through its
  `list_models` control request, Codex through `codex app-server`'s `model/list`, pi through
  `--list-models` and OpenCode through `opencode models`. The list is searchable, takes a typed
  name too, and starts with Default, named after what the CLI's config runs (e.g. `Default · Opus
  5.5`). Effort offers the levels the chosen model takes. Listings are kept for a day as
  `t3.commit.models`; Refresh lists again. Other programs take a typed model and effort;
- edit its command, a shell line run in the repository that reads the prompt on stdin and prints
  the message. `{model}` and `{effort}` in it take the choices; an empty one is left out together
  with the flag in front of it, so the CLI uses its own config;
- add agents of your own, e.g. `ollama run {model}`, or remove any (Restore defaults brings the
  four back);
- rewrite the instructions (Reset to default brings them back).

The chip and the menu name the model each agent runs, its config default included (`pi ·
deepseek-v4.1-flash`). Save (⌘↵) keeps the settings in `t3.commit.settings`; nothing is stored
while they match the defaults.

## Sync

After changing the layout or a mod in Herdr, pull the current version back into the repo:

```bash
./sync.sh            # the layout the window shows now
./sync.sh <layout>   # or a named one
```

It rebuilds `layouts/`, `mods/` and `keys.json` from that layout and the non-shipped mods it needs
(including mods named in their code). `gpui-kit.d.ts` and `jsconfig.json` are editor files Herdr
writes and are not tracked.

Favorites, session tags and commit message settings live in Herdr's `shared.json` under
`t3.favorites`, `t3.sessions.tags`, `t3.commit.agent`, `t3.commit.settings`, `t3.commit.models`
and `t3.review.comments`.
