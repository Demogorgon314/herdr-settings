// The changes the way GitHub's "Files changed" shows them, in a window of its
// own: a tree of the changed files on the left; on the right every file's diff
// in turn, each a card whose header folds it and marks it viewed (a viewed
// file folds). The panel opens this mod as a window with props { diff: { root,
// on, files, focus } }, keyed so opening it again replaces it where it was left.
// j / k step through the files, Esc closes.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, readTextFile, theme, settings, props, closeOverlay } from "herdr";

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
export const AREAS = { merge: "Merge", staged: "Staged", changes: "Changes", untracked: "Untracked" };
// Added and untracked green, deleted and conflicted red, modified amber, as editors mark them.
export const statusColor = (status, t) => status === "A" || status === "U" ? t.ansi2 : status === "D" || status === "C" ? t.ansi1 : t.ansi3;
export const keyOf = (f) => `${f.area}:${f.path}`;

const ROW = 20, HEAD = 38, FOOT = 14, LARGE = 800, MAX = 20000, TREE_ROW = 26;
// The Viewed button's width, and what a row spends before its code: borders, two gutters, the sign.
const VIEWED = 82, GUTTERS = 2 + 46 * 2 + 16;

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
    this.repo = { root: p.root, on: p.on }; this.files = p.files; this.current = p.focus ?? 0;
    this.diffs = null; this.sx = 0; this.paneW = 0; this.paneH = 0; this.folded = new Set(); this.viewed = new Set(); this.closedDirs = new Set();
    this.tree = buildTree(this.files);
    this.list = VirtualListScrollHandle.new();
    this.handle = cx.focus_handle(); this.handle.focus();
    cx.spawn(async (cx) => {
      try {
        this.diffs = (await loadAll(this.repo, this.files)).map(({ lines, note }) => ({ note, rows: lines ? diffRows(lines.slice(0, MAX)) : [], more: (lines?.length ?? 0) > MAX }));
        this.diffs.forEach((d, i) => { if (d.rows.length > LARGE) this.folded.add(i); });
        this.layout();
      } catch (e) { this.error = String(e.message ?? e); }
      cx.notify();
      if (this.diffs) this.reveal(this.current, cx);
    });
  }

  // One list item per row of the cards: each file's header, its rows unless
  // folded, a note when there are none, then the card's foot.
  layout() {
    this.items = []; this.heads = [];
    this.files.forEach((f, i) => {
      const d = this.diffs[i];
      this.heads.push(this.items.length);
      this.items.push({ type: "head", i });
      if (this.folded.has(i)) { this.items.push({ type: "gap" }); return; }
      if (d.note) this.items.push({ type: "note", i, text: d.note });
      for (const row of d.rows) this.items.push({ type: "row", row });
      if (d.more) this.items.push({ type: "note", i, text: `Showing the first ${MAX.toLocaleString()} lines` });
      this.items.push({ type: "foot" });
    });
    // The longest line on show, so rows scroll sideways together.
    this.width = Math.max(0, ...this.items.map((it) => it.type === "row" ? it.row.text.length : 0)) * 7.3 + 24;
    this.sx = Math.min(this.sx, this.maxX());
    this.sizes = this.items.map((it) => it.type === "head" ? HEAD : it.type === "foot" ? FOOT : it.type === "gap" ? 10 : it.type === "note" ? 32 : ROW);
  }

  // How far the code can scroll sideways in the pane as drawn.
  maxX() { return Math.max(0, (this.width ?? 0) - (this.paneW - 32 - GUTTERS)); }

  // A list row can't hold handlers, so a header click is told apart by where
  // the press landed: on Viewed it marks the file, anywhere else it folds it.
  click(key, cx) {
    const [type, i] = key.split(":");
    if (type !== "head") return;
    this.current = +i;
    if (this.pressX > this.paneW - 16 - 10 - VIEWED - 4) this.view(+i, cx); else this.fold(+i, cx);
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
    if (this.folded.has(i)) this.folded.delete(i); else this.folded.add(i);
    this.layout(); cx.notify();
  }

  // Marking a file viewed folds it, unmarking unfolds it, as on GitHub.
  view(i, cx) {
    if (this.viewed.has(i)) { this.viewed.delete(i); this.folded.delete(i); }
    else { this.viewed.add(i); this.folded.add(i); }
    this.layout(); cx.notify();
  }

  foldAll(fold, cx) {
    this.folded = fold ? new Set(this.files.map((_, i) => i)) : new Set();
    this.layout(); this.jump(Math.min(this.current, this.files.length - 1), cx);
  }

  close() { closeOverlay(props()?.overlay); }

  // A press on a control stops there, so it doesn't drag the window.
  icon(id, icon, tip, act, t) {
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .tooltip(tip).hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)).on_click((_e, cx) => act(cx))
      .child(svg(icon).size(14).text_color(t.muted));
  }

  checkbox(on, t) {
    return div().size(14).flex_none().flex().items_center().justify_center().rounded(4).border_1()
      .border_color(on ? t.accent : t.input).bg(on ? t.accent : t.background)
      .child(svg("mods/workspace-chrome/check.svg").size(10).text_color(t.accent_foreground ?? t.background).opacity(on ? 1 : 0));
  }

  head(i, t) {
    const f = this.files[i], folded = this.folded.has(i), viewed = this.viewed.has(i);
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
        .child(h_flex().w(VIEWED).flex_none().h(24).px(8).gap(6).items_center().rounded(6).border_1().border_color(viewed ? t.accent : t.border)
          .text_size(11.5).text_color(viewed ? t.foreground : t.muted)
          .child(this.checkbox(viewed, t)).child("Viewed")));
  }

  // Inside a card: the left and right borders run down every row.
  side(el, t) { return el.border_l(1).border_r(1).border_color(t.border); }

  item(it, t) {
    if (it.type === "head") return this.head(it.i, t);
    if (it.type === "gap") return div().h(10).flex_none();
    if (it.type === "foot") return div().h(FOOT).flex_none().child(this.side(div().h(6), t).border_b(1).rounded_b(8));
    if (it.type === "note") return this.side(h_flex().w_full().h(32).flex_none().px(14).items_center().text_size(11.5).text_color(t.dim), t).child(it.text);
    const { kind, old, next, text } = it.row;
    if (kind === "@") return this.side(h_flex().w_full().h(ROW).flex_none().px(12).items_center().bg(t.accent + "14").text_color(t.dim), t).child(div().flex_1().min_w(0).truncate().child(text));
    const gutter = (n) => div().w(46).flex_none().pr(8).text_right().text_color(t.dim).child(n === undefined ? "" : String(n));
    return this.side(h_flex().w_full().h(ROW).flex_none().items_center(), t)
      .when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(gutter(old)).child(gutter(next))
      .child(div().w(16).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind === "+" || kind === "-" ? kind : ""))
      .child(div().flex_1().min_w(0).h_full().overflow_hidden().child(div().h_full().flex().items_center().ml(-this.sx).whitespace_nowrap().child(text)));
  }

  // The tree: sections, folders that fold, files that jump to their card.
  treeRows(t) {
    const rows = [];
    const file = (name, i, depth) => {
      const f = this.files[i], here = i === this.current, viewed = this.viewed.has(i);
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
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const allFolded = this.folded.size === this.files.length;
    return v_flex().id("diff-window").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.close();
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
        .child(div().text_size(11.5).text_color(t.dim).child(`${this.viewed.size} / ${this.files.length} viewed`))
        .child(this.icon("fold-all", `mods/t3-files/chevron-${allFolded ? "down" : "right"}.svg`, allFolded ? "Expand all" : "Collapse all", (cx) => this.foldAll(!allFolded, cx), t))
        .child(this.icon("diff-close", "mods/workspace-chrome/x.svg", "Close (Esc)", () => this.close(), t)))
      .child(h_flex().flex_1().min_h(0)
        .child(div().w(260).flex_none().h_full().relative().border_r(1).border_color(t.border).bg(t.chrome ?? t.background)
          .child(v_flex().id("diff-tree").absolute().inset_0().overflow_y_scroll().p(6).gap(1).children(this.treeRows(t)))
          .child(Scrollbar.vertical("diff-tree").absolute().inset_0()))
        .child(div().flex_1().min_w(0).h_full().relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
          .on_size_change((size, cx) => { this.paneW = size.width; this.paneH = size.height; this.sx = Math.min(this.sx, this.maxX()); cx.notify(); })
          .on_mouse_down("left", (e, cx) => { this.pressX = e.local_position?.x ?? e.position.x - (e.bounds?.x ?? 0); cx.stop_propagation(); })
          // Sideways wheel or trackpad moves the code alone; headers and line numbers stay.
          .on_scroll_wheel((e, cx) => {
            if (Math.abs(e.delta.x) <= Math.abs(e.delta.y)) return;
            const sx = Math.min(Math.max(0, this.sx - e.delta.x), this.maxX());
            if (sx !== this.sx) { this.sx = sx; cx.notify(); }
          })
          .when(!this.diffs, (el) => el.child(h_flex().size_full().gap(8).items_center().justify_center().text_color(this.error ? t.ansi1 : t.dim).text_size(12.5)
            .when(!this.error, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(14).text_color(t.accent).spin(900)))
            .child(this.error ? `Cannot show the changes: ${this.error}` : "Loading changes…")))
          .when(Boolean(this.diffs), (el) => el
            .child(div().size_full().px(16)
              .child(v_virtual_list("diff-rows", this.items.length, this.sizes, (i) => this.items[i].type === "head" ? `head:${this.items[i].i}` : `${this.items[i].type}:${i}`,
                (range) => this.items.slice(range.start, range.end).map((it) => this.item(it, t)))
                .track_scroll(this.list).on_item_click((key, cx) => this.click(key, cx)).size_full()))
            .child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0()))));
  }
}
