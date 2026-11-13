// The changes the way GitHub's "Files changed" shows them: a tree of the
// changed files on the left; on the right every file's diff in turn, each a
// card whose header folds it and marks it viewed (a viewed file folds). The
// panel opens this mod as a window with props { diff: { root, on, files, focus } },
// keyed so opening it again replaces it; the window can move itself into a
// tab of its own (tab.new with the same props, plus tab, viewed and folded).
// It reads the changes again when the folder changes or on Refresh, keeping
// what was viewed unless that file's diff changed since. j / k step through
// the files; in the window Esc closes.
//
// Comments, as on GitHub: a line shows + under the pointer; click it to comment
// (shift-click another to take the lines between), or the comment button in a
// card's header for the whole file. The form opens under the lines (⌘↵ adds,
// Esc cancels), the comments show there and follow their lines as the files
// change, a click on one edits it in place, and Send pastes them into the
// prompt of an agent in this space, for the person to submit (see comments.js).

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, TextareaState, Textarea, Popup, TextView } from "gpui-base";
import { exec, readTextFile, watchFolder, theme, settings, props, closeOverlay, run, agents, spaces, setShared } from "herdr";
import { CLEAR_KEY, commentsOf, saveComments, clearsSent, toSend, anchorOf, quote, locate, where, commentOn, formatComments, wrap, ago } from "./comments.js";

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
export const AREAS = { merge: "Merge", staged: "Staged", changes: "Changes", untracked: "Untracked" };
// Added and untracked green, deleted and conflicted red, modified amber, as editors mark them.
export const statusColor = (status, t) => status === "A" || status === "U" ? t.ansi2 : status === "D" || status === "C" ? t.ansi1 : t.ansi3;
export const keyOf = (f) => `${f.area}:${f.path}`;

const ROW = 20, HEAD = 38, FOOT = 14, LARGE = 800, MAX = 20000, TREE_ROW = 26;
// The Viewed and comment buttons' widths, and what a row spends before its code: borders, two gutters, the sign.
const VIEWED = 82, NOTE = 40, GUTTERS = 2 + 46 * 2 + 16;
// A comment card's height before its body lines, and each line.
const CARD = 54, CARD_LINE = 18;
// The comment form's rows (its text row is as tall as the text), and its
// controls' widths, which say what a press on one hit.
const FORM = { "c-head": 46, "c-tabs": 40, "c-hint": 32, "c-foot": 50 }, TAB = 76, SUGGEST = 28, ADD = 112, CANCEL = 72, DELETE = 72;
// Where the form's content starts in from either side of the pane: the list's
// padding, the card's border, the form's margin, border and padding.
const FORM_IN = 16 + 1 + 12 + 1 + 10;
const FADE = { duration: 140, easing: "ease-out" };

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each line on both sides once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@+ -(\d+)(?:,\d+)? .*?\+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const line_ = line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line;
    const kind = line_[0], text = untab(line_.slice(1)) || " ";
    if (kind === "-") return { kind, old: old++, text };
    if (kind === "+") return { kind, next: next++, text };
    if (kind === " ") return { kind, old: old++, next: next++, text };
    return { kind: "", text: line_ };
  });
}

// Splits one `git diff` into each file's lines from its first hunk. Without
// renames both sides of a header name the same path.
function splitDiff(out) {
  const files = {};
  let path = null, lines = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const s = line.slice(11);
      path = s.slice(2, 2 + (s.length - 5) / 2); lines = files[path] = { hunks: [], binary: false };
    } else if (line.startsWith("diff --cc ")) {
      path = line.slice(10); lines = files[path] = { hunks: [], binary: false };
    } else if (!lines) continue;
    else if (line.startsWith("Binary files ")) lines.binary = true;
    else if (lines.hunks.length || line.startsWith("@@")) lines.hunks.push(line);
  }
  for (const f of Object.values(files)) if (f.hunks.at(-1) === "") f.hunks.pop();
  return files;
}

// The changed files, each once per section it's in, with its line counts.
export async function readChanges({ root, on }) {
  const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
  const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  if (status.code !== 0) throw new Error(status.stderr);
  // Line counts by side: the index against HEAD, the worktree against the index.
  const [head, cached, worktree] = await Promise.all([
    git(["rev-parse", "--verify", "HEAD"]),
    git(["diff", "--cached", "--numstat", "-z", "--no-renames"]),
    git(["diff", "--numstat", "-z", "--no-renames"]),
  ]);
  const stats = (result) => {
    if (result.code !== 0) throw new Error(result.stderr);
    const out = {};
    for (const entry of result.stdout.split("\0")) {
      const [a, d, ...parts] = entry.split("\t");
      if (parts.length) out[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
    }
    return out;
  };
  const staged = stats(cached), changed = stats(worktree), none = { add: 0, del: 0 };
  // Each entry once per section it's in, as editors list them: a file both
  // staged and edited since shows in Staged and in Changes.
  const files = [];
  const entries = status.stdout.split("\0").filter(Boolean);
  for (const entry of entries.slice(0, 1000)) {
    const x = entry[0], y = entry[1], path = entry.slice(3);
    if (x === "?") files.push({ area: "untracked", path, status: "U", ...none });
    else if (x === "U" || y === "U" || (x === y && (x === "A" || x === "D"))) files.push({ area: "merge", path, status: "C", ...(changed[path] ?? none) });
    else {
      if (x !== " ") files.push({ area: "staged", path, status: x === "D" ? "D" : x === "A" ? "A" : "M", ...(staged[path] ?? none) });
      if (y !== " ") files.push({ area: "changes", path, status: y === "D" ? "D" : "M", ...(changed[path] ?? none) });
    }
  }
  const order = Object.keys(AREAS);
  files.sort((a, b) => order.indexOf(a.area) - order.indexOf(b.area));
  return { files, hasHead: head.code === 0, limited: entries.length > 1000 };
}

// Every file's diff, as its section means it: staged against HEAD, changes
// against the index, an untracked file whole.
async function loadAll({ root, on }, files) {
  const git = (args) => exec("git", [...READ, "-c", "core.quotePath=false", "diff", ...args, "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color"], { cwd: root, on, timeout: 60000 });
  const areas = new Set(files.map((f) => f.area));
  const [staged, changes] = await Promise.all([
    areas.has("staged") ? git(["--cached"]) : null,
    areas.has("changes") || areas.has("merge") ? git([]) : null,
  ]);
  const by = { staged: staged ? splitDiff(staged.stdout) : {}, changes: changes ? splitDiff(changes.stdout) : {} };
  by.merge = by.changes;
  return Promise.all(files.map(async (f) => {
    if (f.area !== "untracked") {
      const d = by[f.area][f.path];
      return !d ? { note: "No text diff available" } : d.binary ? { note: "Binary file changed" } : d.hunks.length ? { lines: d.hunks } : { note: "No text diff available" };
    }
    const text = await readTextFile(`${root}/${f.path}`, { on }).catch(() => null);
    if (text === null) return { note: "Cannot preview this file (binary, too large, or unreadable)" };
    if (text.includes("\0")) return { note: "Binary file · no text diff" };
    if (!text) return { note: "Empty file" };
    const lines = text.replace(/\n$/, "").split("\n");
    return { lines: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)] };
  }));
}

// The files as a tree under their sections, a folder with one folder in it
// named as one ("src/lib"), the way GitHub draws it.
function buildTree(files) {
  const sections = [];
  for (const area of Object.keys(AREAS)) {
    const mine = files.map((f, i) => [f, i]).filter(([f]) => f.area === area);
    if (!mine.length) continue;
    const root = { dirs: {}, files: [] };
    for (const [f, i] of mine) {
      const parts = f.path.split("/"), name = parts.pop();
      let node = root;
      for (const p of parts) node = node.dirs[p] ??= { dirs: {}, files: [] };
      node.files.push({ name, index: i });
    }
    const squash = (name, node) => {
      const kids = Object.keys(node.dirs);
      if (kids.length === 1 && !node.files.length) return squash(`${name}/${kids[0]}`, node.dirs[kids[0]]);
      return { name, node };
    };
    sections.push({ area, count: mine.length, root });
    sections.at(-1).squash = squash;
  }
  return sections;
}

export class DiffWindow {
  constructor(cx) {
    const p = props().diff;
    this.repo = { root: p.root, on: p.on }; this.tab = Boolean(p.tab);
    this.files = p.files; this.current = p.focus ?? 0;
    // By file (keyOf), so a reload keeps them: viewed holds each file's diff as it was seen.
    this.viewed = new Map(p.viewed ?? []); this.folded = new Set(p.folded ?? []); this.seen = new Set(p.folded ? this.files.map(keyOf) : []);
    this.diffs = null; this.sx = 0; this.paneW = 0; this.paneH = 0; this.closedDirs = new Set();
    this.tree = buildTree(this.files);
    this.list = VirtualListScrollHandle.new();
    this.handle = cx.focus_handle(); this.handle.focus();
    // The comment being written: { i, anchor, a, b } on rows a..b of file i, { i, file } on the file, or { i, id } editing one;
    // key names file i, and pins the rows, so both are found again when the diff is read again.
    this.draft = null; this.preview = false; this.textH = 0;
    this.note = TextareaState.new({ placeholder: "Leave a comment" });
    this.note.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.note.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    // The text row grows with the text, as GitHub's does.
    this.note.on("change", (_e, cx) => { if (this.draft && this.noteH() !== this.textH) this.layout(); cx.notify(); });
    this.load(cx, false);
    if (!this.repo.on) this.watch(cx);
  }

  // Reads the diffs (and with fresh, the file list first) and lays them out
  // again. One at a time: one asked for meanwhile runs when it ends.
  load(cx, fresh = true) {
    if (this.loading) { this.again = true; return; }
    this.loading = true; this.again = false;
    const first = !this.diffs, was = this.files[this.current] && keyOf(this.files[this.current]);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (fresh) {
          this.files = (await readChanges(this.repo)).files;
          this.current = Math.max(0, this.files.findIndex((f) => keyOf(f) === was));
          this.tree = buildTree(this.files);
        }
        this.diffs = (await loadAll(this.repo, this.files)).map(({ lines, note }) => ({ note, sig: lines?.join("\n") ?? note, rows: lines ? diffRows(lines.slice(0, MAX)) : [], more: (lines?.length ?? 0) > MAX }));
        this.diffs.forEach((d, i) => {
          const k = keyOf(this.files[i]);
          // A large diff starts folded, once; a viewed file that changed since is unviewed, as on GitHub.
          if (!this.seen.has(k) && d.rows.length > LARGE) this.folded.add(k);
          this.seen.add(k);
          if (this.viewed.has(k) && this.viewed.get(k) !== d.sig) { this.viewed.delete(k); this.folded.delete(k); }
        });
        this.error = null;
        this.rebase();
        this.layout();
        // Comments whose lines moved keep their new numbers, which a send names.
        if (this.moved.size) saveComments(this.repo.root, commentsOf(this.repo.root).map((c) => this.moved.has(c.id) ? { ...c, ...this.moved.get(c.id) } : c));
      } catch (e) { this.error = String(e.message ?? e); }
      this.loading = false;
      cx.notify();
      if (first && this.diffs) this.reveal(this.current, cx);
      if (this.again) this.load(cx);
    });
  }

  watch(cx) {
    cx.spawn(async (cx) => {
      try { while (!this.gone) { await watchFolder(this.repo.root); if (!this.gone) this.load(cx); } } catch {}
    });
  }

  // Where each comment shows: under the row it belongs on (see locate) in a
  // card with its file, its own section's first; else (the whole file, or a line
  // no longer in the diff) at the top of that card. One with no card isn't shown,
  // but sends. Comments found on other line numbers than they say go in moved.
  place(comments) {
    const at = new Map(), by = new Map();
    this.moved = new Map();
    for (const c of comments) {
      const cards = this.files.map((_f, i) => i).filter((i) => this.files[i].path === c.path)
        .sort((x, y) => (this.files[y].area === c.area) - (this.files[x].area === c.area));
      if (!cards.length) continue;
      at.set(c.id, `${cards[0]}:top`);
      if (c.line == null || !c.code?.length) continue;
      for (const i of cards) {
        const r = locate(this.diffs[i].rows, c);
        if (r < 0) continue;
        at.set(c.id, `${i}:${r}`);
        const { line } = anchorOf(this.diffs[i].rows[r]);
        if (line !== c.line) this.moved.set(c.id, { line, from: c.from == null ? c.from : c.from + line - c.line });
        break;
      }
    }
    for (const c of comments) if (at.has(c.id)) by.set(at.get(c.id), [...(by.get(at.get(c.id)) ?? []), c]);
    return by;
  }

  // The rows a draft is on, so they're found again (see locate).
  pins(rows, ...rs) {
    return rs.map((r) => ({ ...anchorOf(rows[r]), code: rows.slice(Math.max(0, r - 3), r + 1).filter(anchorOf).map(quote) }));
  }

  // After the diff is read again: the draft's file and lines where they are now.
  // One whose file or lines went closes; what was typed stays for the next.
  rebase() {
    const d = this.draft;
    if (!d) return;
    const i = this.files.findIndex((f) => keyOf(f) === d.key);
    if (i < 0) { this.draft = null; return; }
    d.i = i;
    if (d.file || d.id) return;
    const rows = this.diffs[i].rows, [anchor, a, b] = d.pins.map((p) => locate(rows, p));
    if (anchor < 0 || a < 0 || b < 0) this.draft = null;
    else Object.assign(d, { anchor, a, b, pins: this.pins(rows, anchor, a, b) });
  }

  // The form's text row: the text's height at what fits, within GitHub's bounds.
  noteH() {
    const cols = Math.max(20, Math.floor((this.paneW - 2 * FORM_IN - 2 - 16 - 18) / 7.3));
    return Math.min(260, Math.max(96, wrap(this.note.value(), cols).length * 18 + 18));
  }

  // One list item per row of the cards: each file's header, its rows (and
  // comments) unless folded, a note when there are none, then the card's foot.
  layout() {
    this.items = []; this.heads = [];
    const comments = commentsOf(this.repo.root), by = this.place(comments);
    this.commentSig = JSON.stringify(comments);
    // Comment bodies wrap at what fits in a card, in the code font.
    const cols = Math.max(20, Math.floor((this.paneW - 32 - 2 - 24 - 22) / 7.3));
    const d = this.draft;
    this.textH = this.noteH();
    const form = (i) => { if (d) d.i = i; for (const type of ["c-head", "c-tabs", "c-text", "c-hint", "c-foot"]) this.items.push({ type, i }); };
    // The comment being edited shows as the form, in its place.
    const cards = (key, i) => {
      for (const c of by.get(key) ?? []) {
        if (d?.id === c.id) { form(i); continue; }
        const lines = wrap(c.body, cols);
        this.items.push({ type: "comment", i, c, lines, outdated: key.endsWith(":top") && c.line != null, size: CARD + lines.length * CARD_LINE });
      }
    };
    this.files.forEach((f, i) => {
      this.heads.push(this.items.length);
      this.items.push({ type: "head", i });
      if (this.folded.has(keyOf(f))) { this.items.push({ type: "gap" }); return; }
      const rows = this.diffs[i], mine = d && !d.id && d.i === i;
      cards(`${i}:top`, i);
      if (mine && d.file) form(i);
      if (rows.note) this.items.push({ type: "note", i, text: rows.note });
      rows.rows.forEach((row, r) => {
        this.items.push({ type: "row", i, r, row }); cards(`${i}:${r}`, i);
        if (mine && !d.file && r === d.b) form(i);
      });
      if (rows.more) this.items.push({ type: "note", i, text: `Showing the first ${MAX.toLocaleString()} lines` });
      this.items.push({ type: "foot" });
    });
    // The longest line on show, so rows scroll sideways together.
    this.width = Math.max(0, ...this.items.map((it) => it.type === "row" ? it.row.text.length : 0)) * 7.3 + 24;
    this.sx = Math.min(this.sx, this.maxX());
    this.sizes = this.items.map((it) => it.type === "head" ? HEAD : it.type === "foot" ? FOOT : it.type === "gap" ? 10 : it.type === "note" ? 32
      : it.type === "comment" ? it.size : it.type === "c-text" ? this.textH + 16 : FORM[it.type] ?? ROW);
  }

  // A list item's key, which is what a click on it reports.
  key(it, index) {
    return it.type === "head" ? `head:${it.i}` : it.type === "row" ? `row:${it.i}:${it.r}` : it.type === "comment" ? `comment:${it.c.id}` : `${it.type}:${index}`;
  }

  // How far the code can scroll sideways in the pane as drawn.
  maxX() { return Math.max(0, (this.width ?? 0) - (this.paneW - 32 - GUTTERS)); }

  // A list row can't hold handlers, so a header click is told apart by where
  // the press landed: on Viewed it marks the file, on the comment button it
  // comments on the file, anywhere else it folds it. A line opens a comment on
  // it; a comment opens itself for editing.
  click(key, cx) {
    const [type, a, b] = key.split(":");
    if (type === "head") {
      const i = +a, right = this.paneW - 16 - 1 - 10;
      this.current = i;
      if (this.pressX > right - VIEWED - 2) this.view(i, cx);
      else if (this.pressX > right - VIEWED - 8 - NOTE - 2) this.compose({ i, file: true }, cx);
      else this.fold(i, cx);
    } else if (type === "row") this.pick(+a, +b, cx);
    else if (type === "comment") this.edit(a, cx);
    else if (type === "c-tabs") {
      const x = this.pressX - FORM_IN - 1, right = this.paneW - FORM_IN - 1 - 6;
      if (x >= 0 && x < 2 * TAB) { this.preview = x >= TAB; if (!this.preview) this.note.focus(); cx.notify(); }
      else if (this.canSuggest() && this.pressX > right - SUGGEST && this.pressX <= right) this.suggest(cx);
    } else if (type === "c-foot") {
      const x = this.pressX, right = this.paneW - FORM_IN;
      if (x > right - ADD && x <= right) this.submit(cx);
      else if (x > right - ADD - 8 - CANCEL && x <= right - ADD - 8) this.cancel(cx);
      else if (this.draft?.id && x >= FORM_IN && x < FORM_IN + DELETE) this.remove(this.draft.id, cx);
    }
  }

  // A click on a line starts a comment there; shift-click stretches it to the
  // lines between, as GitHub does. Text already typed stays.
  pick(i, r, cx) {
    if (!anchorOf(this.diffs[i].rows[r])) return;
    const d = this.draft;
    if (this.pressShift && d && d.i === i && d.anchor != null) this.compose({ ...d, a: Math.min(d.anchor, r), b: Math.max(d.anchor, r) }, cx);
    else this.compose({ i, anchor: r, a: r, b: r }, cx);
  }

  compose(draft, cx) {
    if (this.draft?.id && !draft.id) this.note.set_value("");
    const f = this.files[draft.i], rows = this.diffs[draft.i].rows;
    this.draft = { ...draft, key: keyOf(f), pins: draft.file || draft.id ? null : this.pins(rows, draft.anchor, draft.a, draft.b) };
    this.current = draft.i; this.preview = false;
    this.folded.delete(keyOf(f));
    this.note.focus();
    this.layout(); cx.notify();
    // Bring the whole form on screen, its buttons last.
    const foot = this.items.findIndex((it) => it.type === "c-foot");
    if (foot >= 0) cx.timer.after(30, (cx) => { this.list.scroll_to_item(foot); cx.notify(); });
  }

  // GitHub's suggestion: the picked lines as they read now, in a block to edit.
  canSuggest() { const d = this.draft; return Boolean(d && !d.file && !d.id); }
  suggest(cx) {
    const d = this.draft, rows = this.diffs[d.i].rows.slice(d.a, d.b + 1).filter((r) => anchorOf(r) && r.kind !== "-");
    const text = this.note.value(), lines = rows.map((r) => r.text === " " ? "" : r.text);
    this.note.set_value(`${text}${text && !text.endsWith("\n") ? "\n" : ""}\`\`\`suggestion\n${lines.join("\n")}\n\`\`\`\n`);
    this.preview = false; this.note.focus();
    this.layout(); cx.notify();
  }

  edit(id, cx) {
    const c = commentsOf(this.repo.root).find((c) => c.id === id);
    const it = this.items.find((it) => it.type === "comment" && it.c.id === id);
    if (!c || !it) return;
    this.note.set_value(c.body);
    this.compose({ i: it.i, id }, cx);
  }

  cancel(cx) {
    this.draft = null; this.preview = false; this.note.set_value(""); this.handle.focus();
    this.layout(); cx.notify();
  }

  submit(cx) {
    const d = this.draft, body = this.note.value().trim(), root = this.repo.root;
    if (!d || !body) return;
    const list = commentsOf(root), f = this.files[d.i];
    if (d.id) saveComments(root, list.map((c) => c.id === d.id ? { ...c, body, at: Date.now(), sent: null } : c));
    else saveComments(root, [...list, d.file ? commentOn(f, body) : commentOn(f, body, this.diffs[d.i].rows, d.a, d.b)]);
    this.cancel(cx);
  }

  remove(id, cx) {
    saveComments(this.repo.root, commentsOf(this.repo.root).filter((c) => c.id !== id));
    this.cancel(cx);
  }

  // Who comments can go to: the agents in the shown space (all of them when it
  // has none), the focused one first, then the most recently active.
  targets() {
    const all = agents(), space = spaces().find((s) => s.active)?.id, here = all.filter((a) => a.space === space);
    return (here.length ? here : all).slice().sort((a, b) => (b.focused - a.focused) || (b.seq - a.seq));
  }

  // Pastes the comments a send takes into the agent's prompt, unsubmitted, and
  // shows the agent so the person can read, edit and submit them. Herdr pastes
  // only from the clipboard, so they go through it. Then they're marked sent,
  // or cleared when the menu says so.
  send(agent, cx) {
    const root = this.repo.root, all = commentsOf(root), list = toSend(all);
    this.menu = false;
    if (!list.length) return;
    const ids = new Set(list.map((c) => c.id)), sent = { to: agent.program?.name ?? agent.title, at: Date.now() };
    saveComments(root, clearsSent() ? all.filter((c) => !ids.has(c.id)) : all.map((c) => ids.has(c.id) ? { ...c, sent } : c));
    cx.write_to_clipboard(formatComments(root, list));
    if (!this.tab) this.close();
    run("agent.focus", { terminal: agent.address });
    run("terminal.paste");
    this.layout(); cx.notify();
  }

  // Brings a file's header to the top. The list only reveals an item, at
  // whichever edge is nearer: so first reveal the item a pane below the header,
  // which lands the header at the top coming down, then the header itself, which
  // places it there coming up.
  reveal(i, cx) {
    const head = this.heads[i];
    let k = head, h = this.sizes[head];
    while (k + 1 < this.items.length && h + this.sizes[k + 1] <= this.paneH) h += this.sizes[++k];
    this.list.scroll_to_item(k, "top");
    cx.notify();
    cx.timer.after(30, (cx) => { this.list.scroll_to_item(head, "top"); cx.notify(); });
  }

  jump(i, cx) {
    if (!this.diffs || i < 0 || i >= this.files.length) return;
    this.current = i;
    this.reveal(i, cx);
    cx.notify();
  }

  fold(i, cx) {
    const k = keyOf(this.files[i]);
    if (this.folded.has(k)) this.folded.delete(k); else this.folded.add(k);
    this.layout(); cx.notify();
  }

  // Marking a file viewed folds it, unmarking unfolds it, as on GitHub.
  view(i, cx) {
    const k = keyOf(this.files[i]);
    if (this.viewed.has(k)) { this.viewed.delete(k); this.folded.delete(k); }
    else { this.viewed.set(k, this.diffs[i].sig); this.folded.add(k); }
    this.layout(); cx.notify();
  }

  foldAll(fold, cx) {
    this.folded = fold ? new Set(this.files.map(keyOf)) : new Set();
    this.layout(); this.jump(Math.min(this.current, this.files.length - 1), cx);
  }

  close() { this.gone = true; closeOverlay(props()?.overlay); }

  // The same review, where it was, as a tab of its own in the selected space.
  toTab() {
    const name = this.repo.root.split("/").pop();
    run("tab.new", { name: `Review · ${name}`, mod: "t3-changes", props: { diff: { ...this.repo, files: this.files, focus: this.current, tab: true,
      viewed: [...this.viewed], folded: [...this.folded] } } });
    this.close();
  }

  // A press on a control stops there, so it doesn't drag the window.
  icon(id, icon, tip, act, t, spin = false) {
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .tooltip(tip).hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)).on_click((_e, cx) => act(cx))
      .child(svg(icon).size(14).text_color(t.muted).when(spin, (s) => s.spin(900)));
  }

  checkbox(on, t) {
    return div().size(14).flex_none().flex().items_center().justify_center().rounded(4).border_1()
      .border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background)
      .child(svg("mods/workspace-chrome/check.svg").size(10).text_color(t.accent_foreground ?? t.background).opacity(on ? 1 : 0));
  }

  head(i, t) {
    const f = this.files[i], folded = this.folded.has(keyOf(f)), viewed = this.viewed.has(keyOf(f));
    const parts = f.path.split("/"), name = parts.pop();
    return h_flex().w_full().h(HEAD).flex_none()
      .child(h_flex().w_full().h(HEAD - 4).mt(4).px(10).gap(8).items_center().cursor_pointer().bg(t.raised).border_1().border_color(t.border)
        .when(folded, (el) => el.rounded(8)).when(!folded, (el) => el.rounded_t(8))
        .child(div().size(22).flex_none().flex().items_center().justify_center()
          .child(svg(`mods/t3-files/chevron-${folded ? "right" : "down"}.svg`).size(12).text_color(t.muted)))
        .child(div().w(12).flex_none().text_size(11).font_semibold().text_color(statusColor(f.status, t)).child(f.status))
        .child(h_flex().flex_1().min_w(0).text_size(12.5)
          .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.muted).child(parts.length ? `${parts.join("/")}/` : ""))
          .child(div().flex_none().font_semibold().child(name)))
        // A large diff starts folded, as on GitHub: say why.
        .when(folded && (this.diffs?.[i]?.rows.length ?? 0) > LARGE, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`Large diff · ${this.diffs[i].rows.length.toLocaleString()} lines`)))
        .child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.dim).child(AREAS[f.area]))
        .when(f.add > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.ansi2).child(`+${f.add}`)))
        .when(f.del > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.ansi1).child(`−${f.del}`)))
        .child(this.noteButton(i, t))
        .child(h_flex().w(VIEWED).flex_none().h(24).px(8).gap(6).items_center().rounded(6).border_1().border_color(viewed ? t.accent : t.border)
          .text_size(11.5).text_color(viewed ? t.foreground : t.muted)
          .child(this.checkbox(viewed, t)).child("Viewed")));
  }

  // The file's comment button, before Viewed: how many comments it has, and
  // what a click on it starts.
  noteButton(i, t) {
    const n = commentsOf(this.repo.root).filter((c) => c.path === this.files[i].path).length, on = this.draft?.file && this.draft.i === i;
    return h_flex().w(NOTE).h(24).flex_none().gap(4).items_center().justify_center().rounded(6).border_1().border_color(on ? t.accent : t.border)
      .text_size(11.5).text_color(n || on ? t.foreground : t.muted)
      .child(svg("mods/t3-changes/message-square.svg").size(12).text_color(n || on ? t.accent : t.muted))
      .when(n > 0, (el) => el.child(String(n)));
  }

  // Inside a card: the left and right borders run down every row.
  side(el, t) { return el.border_l(1).border_r(1).border_color(t.border); }

  item(it, t) {
    if (it.type === "head") return this.head(it.i, t);
    if (it.type === "gap") return div().h(10).flex_none();
    if (it.type === "foot") return div().h(FOOT).flex_none().child(this.side(div().h(6), t).border_b(1).rounded_b(8));
    if (it.type.startsWith("c-")) return this.form(it, t);
    if (it.type === "comment") return this.card(it, t);
    if (it.type === "note") return this.side(h_flex().w_full().h(32).flex_none().px(14).items_center().text_size(11.5).text_color(t.dim), t).child(it.text);
    const { kind, old, next, text } = it.row;
    if (kind === "@") return this.side(h_flex().w_full().h(ROW).flex_none().px(12).items_center().bg(t.accent + "14").text_color(t.dim), t).child(div().flex_1().min_w(0).truncate().child(text));
    const gutter = (n) => div().w(46).flex_none().pr(8).text_right().text_color(t.dim).child(n === undefined ? "" : String(n));
    const d = this.draft, picked = d && !d.file && !d.id && d.i === it.i && it.r >= d.a && it.r <= d.b;
    // GitHub's + on the line under the pointer. A row takes no handlers, and a
    // hover colour reaches no child, so the + sits on a clear layer over the
    // whole row that its own hover shows.
    return this.side(h_flex().w_full().h(ROW).flex_none().relative().items_center().cursor_pointer(), t)
      .when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .when(picked, (e) => e.bg(t.accent + "30"))
      .child(gutter(old)).child(gutter(next))
      .child(div().w(16).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind === "+" || kind === "-" ? kind : ""))
      .child(div().flex_1().min_w(0).h_full().overflow_hidden().child(div().h_full().flex().items_center().ml(-this.sx).whitespace_nowrap().child(text)))
      .when(Boolean(anchorOf(it.row)), (e) => e.child(div().id(`plus:${it.i}:${it.r}`).absolute().inset_0().opacity(0).hover((s) => s.opacity(1))
        .child(div().absolute().left(87).top(1.5).size(17).flex().items_center().justify_center().rounded(4).bg(t.accent)
          .child(svg("mods/workspace-chrome/plus.svg").size(13).text_color(t.accent_foreground ?? t.background)))));
  }

  // A comment under its line, inside the file's card.
  card(it, t) {
    const { c, lines } = it;
    return this.side(div().w_full().h(it.size).flex_none().px(12).py(6), t)
      .child(v_flex().size_full().p(10).gap(4).rounded(8).border_1().border_color(t.border).bg(t.background).cursor_pointer()
        .child(h_flex().h(16).gap(6).items_center().text_size(11).text_color(t.dim)
          .child(svg("mods/t3-changes/message-square.svg").size(11).text_color(t.accent))
          .child(div().text_color(t.muted).child(where(c)))
          .when(it.outdated, (el) => el.child(div().px(4).rounded(3).border_1().border_color(t.border).child("not in the diff now")))
          .child(div().child(`· ${ago(c.at)}`))
          .when(Boolean(c.sent), (el) => el.child(h_flex().gap(3).items_center().text_color(t.ansi2)
            .child(svg("mods/workspace-chrome/check.svg").size(10).text_color(t.ansi2)).child(`sent to ${c.sent?.to}`)))
          .child(div().flex_1())
          .child(div().child("click to edit")))
        .children(lines.map((l) => div().h(CARD_LINE).whitespace_nowrap().child(l || " "))));
  }

  // The comment form, GitHub's, under its lines. A list row can't hold
  // handlers, so the form is five rows drawn as one box (the title; Write,
  // Preview and the suggestion button; the text; a hint; the buttons), and
  // click() tells its controls apart by where the press landed.
  form(it, t) {
    const d = this.draft, type = it.type, f = this.files[it.i], editing = d.id && commentsOf(this.repo.root).find((c) => c.id === d.id);
    const outer = (h) => this.side(div().w_full().h(h).flex_none().px(12), t);
    const frame = () => div().size_full().px(10).bg(t.background).border_l(1).border_r(1).border_color(t.border);
    const editor = () => div().size_full().border_l(1).border_r(1).border_color(t.border);
    if (type === "c-head") {
      const lines = (c) => { const p = c.side === "old" ? "L" : "R"; return c.from != null && c.from !== c.line ? `lines ${p}${c.from} to ${p}${c.line}` : `line ${p}${c.line}`; };
      const title = editing ? `Edit comment${editing.line != null ? ` on ${lines(editing)}` : ""}`
        : d.file ? "Add a comment on this file" : `Add a comment on ${lines(commentOn(f, "", this.diffs[it.i].rows, d.a, d.b))}`;
      return outer(FORM[type]).pt(8).child(frame().border_t(1).rounded_t(8).flex().items_center().gap(8)
        .child(svg("mods/t3-changes/message-square.svg").size(14).flex_none().text_color(t.accent))
        .child(div().flex_none().text_size(13).font_semibold().child(title))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(f.path)));
    }
    if (type === "c-tabs") {
      const tab = (label, on, first) => div().w(TAB).h_full().flex_none().flex().items_center().justify_center().text_size(12.5).cursor_pointer()
        .border_color(t.border).text_color(on ? t.foreground : t.muted)
        .when(on, (el) => el.bg(t.background).border_r(1).when(!first, (el) => el.border_l(1)))
        .when(!on, (el) => el.border_b(1).hover((s) => s.text_color(t.foreground)))
        .child(label);
      return outer(FORM[type]).child(frame().child(h_flex().size_full().overflow_hidden().rounded_t(6).border_t(1).border_l(1).border_r(1).border_color(t.border).bg(t.raised)
        .child(tab("Write", !this.preview, true)).child(tab("Preview", this.preview, false))
        .child(h_flex().flex_1().h_full().pr(6).justify_end().items_center().border_b(1).border_color(t.border)
          .when(this.canSuggest(), (el) => el.child(div().w(SUGGEST).h(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .child(svg("mods/t3-changes/file-diff.svg").size(15).text_color(t.muted)))))));
    }
    if (type === "c-text") {
      const text = this.note.value().trim();
      return outer(this.textH + 16).child(frame().child(editor().px(8).py(8).child(this.preview
        ? div().w_full().h(this.textH).px(8).py(6).text_size(12.5).text_color(text ? t.foreground : t.dim)
          .child(TextView.markdown("note-preview", text || "Nothing to preview").size_full().scrollable(true))
        : div().w_full().h(this.textH).px(8).py(6).rounded(6).border_1().border_color(this.typing ? t.accent : t.border).bg(t.background).cursor_text()
          .child(Textarea.new(this.note).w_full().h(this.textH - 14).text_size(12.5).text_color(t.foreground)))));
    }
    if (type === "c-hint") {
      const hint = ["Markdown is supported", ...(this.canSuggest() ? ["shift-click another line to take the lines between", "± suggests a change"] : []), "⌘↵ to save", "Esc to cancel"];
      return outer(FORM[type]).child(frame().child(editor().h_full().border_b(1).rounded_b(6).px(10).flex().items_center()
        .text_size(11.5).text_color(t.dim).child(div().flex_1().min_w(0).truncate().child(hint.join(" · ")))));
    }
    const button = (label, w, solid, danger, off) => div().w(w).h(32).flex_none().flex().items_center().justify_center().rounded(6).text_size(12.5).cursor_pointer()
      .when(solid, (el) => el.bg(t.solid).text_color(t.solid_foreground).opacity(off ? 0.5 : 1))
      .when(!solid, (el) => el.border_1().border_color(t.border).bg(t.raised).text_color(danger ? t.ansi1 : t.foreground).hover((s) => s.bg(t.hover)))
      .child(label);
    return outer(FORM[type]).pb(8).child(frame().border_b(1).rounded_b(8).flex().items_center().gap(8)
      .when(Boolean(editing), (el) => el.child(button("Delete", DELETE, false, true)))
      .child(div().flex_1())
      .child(button("Cancel", CANCEL))
      .child(button(editing ? "Update comment" : "Add comment", ADD, true, false, !this.note.value().trim())));
  }

  // Send, in the title bar: the comments to an agent, picked from a menu, with
  // whether sent ones are cleared, Copy, and the deletes.
  sendMenu(n, t) {
    const open = Boolean(this.menu), targets = this.targets(), root = this.repo.root;
    const all = commentsOf(root), fresh = all.filter((c) => !c.sent).length, clear = clearsSent();
    const glyph = (p, size, color) => !p?.icon ? svg("mods/workspace-chrome/terminal.svg").size(size).flex_none().text_color(color)
      : p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
    const row = (id, lead, label, detail, act, color) => h_flex().id(id).h(30).flex_none().px(8).gap(8).items_center().rounded(6).text_size(12)
      .text_color(color ?? t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => act(cx))
      .child(lead).child(div().flex_1().min_w(0).truncate().child(label))
      .child(div().flex_none().max_w(150).truncate().text_size(11).text_color(t.dim).child(detail));
    const trigger = h_flex().id("send-comments").h(26).px(10).gap(6).items_center().rounded(6).text_size(12).cursor_pointer()
      .bg(t.solid).text_color(t.solid_foreground).active((s) => s.opacity(0.85))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .tooltip("Paste the comments into an agent's prompt")
      .on_click((_e, cx) => {
        // The press outside the menu already closed it: this click must not reopen it.
        const just = Date.now() - (this.menuClosed ?? 0) < 400;
        this.menu = !this.menu && !just; this.menuClosed = 0; cx.notify();
      })
      .child(svg("mods/t3-changes/send.svg").size(12).text_color(t.solid_foreground))
      .child(fresh ? `Send ${fresh} ${fresh === 1 ? "comment" : "comments"}` : `Send ${n} again`)
      .child(svg("mods/workspace-chrome/chevron-down.svg").size(11).text_color(t.solid_foreground));
    const full = (Math.max(1, targets.length) + (fresh < n ? 4 : 3)) * 31 + 40;
    return Popup.new("send-popup", trigger).anchor("top_right")
      .content(v_flex().id("send-menu").mt(4).w(300).overflow_hidden()
        .h(open ? full : 0).opacity(open ? 1 : 0).transition("height", { duration: 180, easing: "ease-out" }).transition("opacity", FADE)
        .p(open ? 4 : 0).gap(1).rounded(8).bg(t.popover).border_1().border_color(open ? t.border : t.popover).shadow_md()
        .on_mouse_down_out((_e, cx) => { if (this.menu) { this.menu = false; this.menuClosed = Date.now(); cx.notify(); } })
        .child(div().h(24).px(8).flex().items_center().text_size(11).text_color(t.dim).child("Paste into the prompt of"))
        .when(!targets.length, (el) => el.child(div().h(30).px(8).flex().items_center().text_size(12).text_color(t.dim).child("No agent running")))
        .children(targets.map((a) => row(`send-${a.address}`, glyph(a.program, 14, a.program?.color ?? t.foreground), a.program?.name ?? a.title,
          `${a.tab_name || `Tab ${a.tab_index + 1}`}${a.focused ? " · focused" : ""} · ${a.status}`, (cx) => this.send(a, cx))))
        .child(div().h(1).mx(4).my(3).flex_none().bg(t.border))
        .child(row("send-clears", this.checkbox(clear, t), "Clear after sending", clear ? "" : "kept, marked sent", (cx) => {
          setShared(CLEAR_KEY, !clear); cx.notify();
        }))
        .child(row("send-copy", svg("mods/t3-files/copy.svg").size(13).flex_none().text_color(t.muted), "Copy as text", "", (cx) => {
          cx.write_to_clipboard(formatComments(root, toSend(all))); this.menu = false; cx.notify();
        }))
        .when(fresh < n, (el) => el.child(row("send-delete-sent", svg("mods/workspace-chrome/x.svg").size(13).flex_none().text_color(t.muted), "Delete sent comments", String(n - fresh), (cx) => {
          const gone = this.draft?.id && all.find((c) => c.id === this.draft.id)?.sent;
          saveComments(root, all.filter((c) => !c.sent)); this.menu = false; if (gone) this.draft = null; this.layout(); cx.notify();
        })))
        .child(row("send-clear", svg("mods/workspace-chrome/x.svg").size(13).flex_none().text_color(t.ansi1), "Delete all comments", "", (cx) => {
          saveComments(root, []); this.menu = false; this.draft = null; this.layout(); cx.notify();
        }, t.ansi1)));
  }

  // The tree: sections, folders that fold, files that jump to their card.
  treeRows(t) {
    const rows = [];
    const file = (name, i, depth) => {
      const f = this.files[i], here = i === this.current, viewed = this.viewed.has(keyOf(f));
      rows.push(h_flex().id(`tree-${i}`).h(TREE_ROW).flex_none().pl(8 + depth * 12).pr(8).gap(6).items_center().rounded(6).cursor_pointer()
        .when(here, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.jump(i, cx))
        .child(svg("mods/t3-files/file.svg").size(13).flex_none().text_color(statusColor(f.status, t)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(viewed ? t.dim : t.foreground).child(name))
        .when(viewed, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(11).flex_none().text_color(t.dim)))
        .child(div().flex_none().text_size(10.5).font_semibold().text_color(statusColor(f.status, t)).child(f.status)));
    };
    const dir = (section, name, node, depth, path) => {
      const { name: label, node: real } = section.squash(name, node), id = `${section.area}:${path}/${label}`, open = !this.closedDirs.has(id);
      rows.push(h_flex().id(`dir-${id}`).h(TREE_ROW).flex_none().pl(8 + depth * 12).pr(8).gap(6).items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { if (open) this.closedDirs.add(id); else this.closedDirs.delete(id); cx.notify(); })
        .child(svg(`mods/t3-files/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim))
        .child(svg("mods/t3-files/folder.svg").size(13).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(label)));
      if (open) children(section, real, depth + 1, `${path}/${label}`);
    };
    const children = (section, node, depth, path) => {
      for (const name of Object.keys(node.dirs).sort()) dir(section, name, node.dirs[name], depth, path);
      for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) file(f.name, f.index, depth);
    };
    for (const section of this.tree) {
      if (this.tree.length > 1) rows.push(h_flex().h(24).flex_none().px(8).mt(rows.length ? 6 : 0).gap(6).items_center()
        .child(div().text_size(10.5).font_semibold().text_color(t.muted).child(AREAS[section.area].toUpperCase()))
        .child(div().text_size(10.5).text_color(t.dim).child(String(section.count))));
      children(section, section.root, 0, "");
    }
    return rows;
  }

  render(_cx) {
    // Comments changed elsewhere (another copy of the review, a send): lay out again.
    if (this.diffs && JSON.stringify(commentsOf(this.repo.root)) !== this.commentSig) this.layout();
    const notes = commentsOf(this.repo.root).length;
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const allFolded = this.files.length > 0 && this.files.every((f) => this.folded.has(keyOf(f)));
    const viewed = this.files.filter((f) => this.viewed.has(keyOf(f))).length;
    return v_flex().id("diff-window").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        // In the comment's text: ⌘↵ saves it, Esc closes the form.
        if (this.typing) {
          if (e.key === "enter" && e.modifiers?.platform) this.submit(cx);
          else if (e.key === "escape") this.cancel(cx);
          else return;
          cx.stop_propagation();
          return;
        }
        if (e.key === "escape" && this.draft) this.cancel(cx);
        else if (e.key === "escape" && !this.tab) this.close();
        else if (e.key === "j") this.jump(this.current + 1, cx);
        else if (e.key === "k") this.jump(this.current - 1, cx);
        else return;
        cx.stop_propagation();
      })
      // The title bar: drag the window by it.
      .child(h_flex().h(44).flex_none().pl(16).pr(8).gap(10).items_center().border_b(1).border_color(t.border).bg(t.chrome ?? t.raised)
        .child(div().font_semibold().child("Changes"))
        .child(div().text_size(12).text_color(t.muted).child(`${this.files.length} ${this.files.length === 1 ? "file" : "files"}`))
        .child(div().text_size(12).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(12).text_color(t.ansi1).child(`−${del}`))
        .child(div().flex_1())
        .when(!notes && Boolean(this.diffs) && this.files.length > 0, (el) => el.child(div().text_size(11.5).text_color(t.dim).child("Click a line to comment")))
        .when(notes > 0, (el) => el.child(this.sendMenu(notes, t)))
        .child(div().text_size(11.5).text_color(t.dim).child(`${viewed} / ${this.files.length} viewed`))
        .child(this.icon("diff-refresh", "mods/t3-changes/rotate-cw.svg", "Refresh", (cx) => this.load(cx), t, Boolean(this.loading)))
        .child(this.icon("fold-all", `mods/t3-changes/chevrons-${allFolded ? "up-down" : "down-up"}.svg`, allFolded ? "Expand all" : "Collapse all", (cx) => this.foldAll(!allFolded, cx), t))
        .when(!this.tab, (el) => el
          .child(this.icon("diff-tab", "mods/t3-changes/app-window.svg", "Open in a tab", () => this.toTab(), t))
          .child(this.icon("diff-close", "mods/workspace-chrome/x.svg", "Close (Esc)", () => this.close(), t))))
      .child(h_flex().flex_1().min_h(0)
        .child(div().w(260).flex_none().h_full().relative().border_r(1).border_color(t.border).bg(t.chrome ?? t.background)
          .child(v_flex().id("diff-tree").absolute().inset_0().overflow_y_scroll().p(6).gap(1).children(this.treeRows(t)))
          .child(Scrollbar.vertical("diff-tree").absolute().inset_0()))
        .child(div().flex_1().min_w(0).h_full().relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
          .on_size_change((size, cx) => {
            const wider = size.width !== this.paneW;
            this.paneW = size.width; this.paneH = size.height;
            if (wider && this.diffs) this.layout(); else this.sx = Math.min(this.sx, this.maxX());
            cx.notify();
          })
          .on_mouse_down("left", (e, cx) => { this.pressX = e.local_position?.x ?? e.position.x - (e.bounds?.x ?? 0); this.pressShift = Boolean(e.modifiers?.shift); cx.stop_propagation(); })
          // Sideways wheel or trackpad moves the code alone; headers and line numbers stay.
          .on_scroll_wheel((e, cx) => {
            if (Math.abs(e.delta.x) <= Math.abs(e.delta.y)) return;
            const sx = Math.min(Math.max(0, this.sx - e.delta.x), this.maxX());
            if (sx !== this.sx) { this.sx = sx; cx.notify(); }
          })
          .when(!this.diffs, (el) => el.child(h_flex().size_full().gap(8).items_center().justify_center().text_color(this.error ? t.ansi1 : t.dim).text_size(12.5)
            .when(!this.error, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(14).text_color(t.accent).spin(900)))
            .child(this.error ? `Cannot show the changes: ${this.error}` : "Loading changes…")))
          .when(Boolean(this.diffs) && !this.files.length, (el) => el.child(h_flex().size_full().items_center().justify_center().text_color(t.dim).text_size(12.5).child("No changes")))
          .when(Boolean(this.diffs) && this.files.length > 0, (el) => el
            .child(div().size_full().px(16)
              .child(v_virtual_list("diff-rows", this.items.length, this.sizes, (i) => this.key(this.items[i], i),
                (range) => this.items.slice(range.start, range.end).map((it) => this.item(it, t)))
                .track_scroll(this.list).on_item_click((key, cx) => this.click(key, cx)).size_full()))
            .child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0()))));
  }
}
