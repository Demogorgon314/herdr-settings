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
| `mods/t3-changes` | Clone of Herdr's `changes` with an [Orca](https://github.com/stablyai/orca)-style commit box: multi-line message (⌘↵ commits), ✨ asks an agent of your choice to write it |
| `mods/t3-sessions` | pi, Claude Code, OpenCode and Codex sessions recorded in the current space's folder; click to resume, `+` to tag, `#tag` to filter |
| `mods/t3-favorites` | Saved folders; click to switch to that space (or open one) |
| `keys.json` | Only the `layout:herdr-t3` section: `cmd-shift-b` switches the sidebar, `cmd-shift-a` the one-agent view |

The layout also uses Herdr's own `workspace-status` and `workspace-chrome` (icons); they ship with
Herdr and are not in this repo.

`t3-files`, `t3-changes`, `t3-sessions` and `t3-favorites` started as ports of
[Lamb-Yang/herdr-sessions](https://github.com/Lamb-Yang/herdr-sessions). Agent marks and colours
follow [HarnessTrajectory](https://github.com/Demogorgon314/HarnessTrajectory) (marks from
lobe-icons, MIT).

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

## AI commit messages

The ✨ in the Changes message box runs the chosen agent once, read-only and without saving a
session (Claude Haiku or Sonnet, Codex, pi, OpenCode; the choice is kept as `t3.commit.agent`).
The prompt goes in on stdin: the changed files, up to 60,000 characters of diff shared fairly
across files, and your last ten commit subjects so the message matches their language and style.
That diff is sent to the model behind the agent you pick. While it writes, the ✨ turns into a
spinner; click it to stop.

## Sync

After changing the layout or a mod in Herdr, pull the current version back into the repo:

```bash
./sync.sh            # the layout the window shows now
./sync.sh <layout>   # or a named one
```

It rebuilds `layouts/`, `mods/` and `keys.json` from that layout and the non-shipped mods it needs
(including mods named in their code). `gpui-kit.d.ts` and `jsconfig.json` are editor files Herdr
writes and are not tracked.

Favorites and session tags live in Herdr's `shared.json` under `t3.favorites` and
`t3.sessions.tags`.
