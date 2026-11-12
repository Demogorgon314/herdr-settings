import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar, v_virtual_list, Popup } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, shared, setShared, openOverlay, props } from "herdr";
import { SETTINGS_KEY, agentsFrom, commandFor, buildPrompt, truncateDiff, cleanMessage } from "./ai.js";
import { CommitSettings } from "./settings.js";
import { discover, modelName, effortLabel } from "./models.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const AGENT_KEY = "t3.commit.agent";
const FADE = { duration: 140, easing: "ease-out" }, OPEN = { duration: 180, easing: "ease-out" };
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    if (props()?.settings) { this.dialog = new CommitSettings(cx); return; }
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.gen = null; this.picking = false; this.installed = null;
    this.input = TextareaState.new({ placeholder: "Commit message (⌘↵ to commit)" });
    this.input.set_auto_grow(2, 8);
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  // Which of the agents' programs are on PATH, looked up again when settings name others.
  probe(bins, cx) {
    const want = [...new Set(bins.filter(Boolean))].sort().join(" ");
    if (want === this.probed) return;
    this.probed = want;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'for b; do command -v "$b" >/dev/null 2>&1 && echo "$b"; done', "sh", ...want.split(" ")]).catch(() => null);
      if (this.probed !== want) return;
      this.installed = new Set((r?.stdout ?? "").split("\n").filter(Boolean));
      cx.notify();
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
        const head = await exec("git", ["log", "-1", "--format=%h"], { cwd: root, on }).catch(() => null);
        if (key() === context) this.celebrate(`Committed ${head?.stdout.trim() ?? ""}`.trim(), cx);
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // A short-lived line above the message box: slides open, then folds away.
  celebrate(text, cx) {
    const shown = { text };
    this.banner = shown; this.bannerOpen = true;
    cx.notify();
    cx.timer.after(2200, (cx) => { if (this.banner === shown) { this.bannerOpen = false; cx.notify(); } });
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  // The agents switched on in settings, and the one picked from them (null: none on).
  agents() { return agentsFrom(shared(SETTINGS_KEY)).filter((a) => a.enabled); }
  agent() {
    const id = shared(AGENT_KEY), on = this.agents();
    return on.find((a) => a.id === id) ?? on.find((a) => this.installed?.has(a.bin)) ?? on[0] ?? null;
  }

  openSettings(cx) {
    this.picking = false; cx.notify();
    openOverlay({ mod: "t3-changes", kind: "dialog", width: 560, height: 640, props: { settings: true } });
  }

  // Why the generate button can't run now, or null when it can.
  blocked() {
    if (!this.root || this.loading) return "Loading changes…";
    if (this.busy) return "Commit in progress…";
    if (this.on) return "AI messages work in local repositories only";
    if (!this.files.length) return "No changes to describe";
    if (this.message.trim()) return "Clear the message to regenerate";
    const agent = this.agent();
    if (!agent) return "No agent is on: turn one on in the agent menu's Settings";
    if (this.installed && !this.installed.has(agent.bin)) return `${agent.bin} is not installed: pick another agent`;
    return null;
  }

  // Fills the message box with what the chosen agent writes from the diff. The
  // prompt goes in on stdin (an argument would show in `ps`), the command is a
  // shell line from settings, and the pid file lets Stop kill the run.
  generate(cx) {
    if (this.gen || this.blocked() || this.context !== key()) return;
    const root = this.root, context = this.context, hasHead = this.hasHead, agent = this.agent();
    const fresh = this.files.filter((f) => f.fresh).map((f) => f.path);
    const gen = { agent, pid: `/tmp/t3-changes-${Date.now()}.pid` };
    this.gen = gen; this.note = null; this.picking = false;
    cx.spawn(async (cx) => {
      try {
        const [log, diff] = await Promise.all([
          exec("git", [...READ, "log", "--format=%s", "-10"], { cwd: root }).catch(() => null),
          exec("git", [...READ, "diff", ...(hasHead ? ["HEAD"] : ["--cached"]), "--no-color", "--no-textconv", "--no-ext-diff"], { cwd: root }).catch(() => null),
        ]);
        const prompt = buildPrompt({
          instructions: shared(SETTINGS_KEY)?.prompt,
          diff: truncateDiff(diff?.code === 0 ? diff.stdout : ""),
          recent: log?.code === 0 ? log.stdout.trim() : "",
          fresh,
        });
        const run = 'f=$1; p=$2; c=$3; echo $$ > "$f"; printf "%s" "$p" | eval "$c"; s=$?; rm -f "$f"; exit $s';
        const r = await exec("sh", ["-c", run, "sh", gen.pid, prompt, commandFor(agent)], { cwd: root, timeout: 180000 });
        if (this.gen !== gen || key() !== context) return;
        const message = cleanMessage(r.stdout);
        if (!message) throw new Error((r.stderr || "").trim().split("\n").pop() || `${agent.name} returned nothing`);
        this.message = message; this.input.set_value(message);
      } catch (e) { if (this.gen === gen && key() === context) this.note = `${agent.name} could not write a message: ${e}`; }
      finally { if (this.gen === gen) this.gen = null; cx.notify(); }
    });
    cx.notify();
  }

  stop(cx) {
    const gen = this.gen;
    if (!gen) return;
    this.gen = null;
    // The whole tree under the run's shell: a command can be a pipeline or a wrapper.
    const kill = 'k() { for c in $(pgrep -P "$1"); do k "$c"; kill -TERM "$c" 2>/dev/null; done; }; pid=$(cat "$1" 2>/dev/null) && k "$pid"; rm -f "$1"';
    exec("sh", ["-c", kill, "sh", gen.pid]).catch(() => null);
    cx.notify();
  }

  // The ✨ in the message box's corner: generate, or while generating a spinner
  // that turns into Stop under the pointer.
  generateButton(t) {
    const base = div().id("commit-ai").absolute().top(6).right(6).size(22).flex().items_center().justify_center().rounded(5);
    if (this.gen) {
      return base.cursor_pointer().hover((s) => s.bg(t.ansi1 + "18")).active((s) => s.bg(t.ansi1 + "30"))
        .tooltip(`${this.gen.agent.name} is writing a message. Click to stop.`)
        .on_hover((h, cx) => { if (h !== Boolean(this.stopHover)) { this.stopHover = h; cx.notify(); } })
        .on_click((_e, cx) => { cx.stop_propagation(); this.stop(cx); })
        .child(this.stopHover
          ? svg("mods/workspace-chrome/square.svg").size(12).text_color(t.ansi1)
          : svg("mods/workspace-chrome/spinner.svg").size(13).text_color(t.accent).spin(900));
    }
    const why = this.blocked();
    return base.tooltip(why ?? `Write a message with ${this.agent().name}`)
      .when(!why, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)))
      .on_click((_e, cx) => { cx.stop_propagation(); this.generate(cx); })
      .child(svg("mods/t3-changes/sparkles.svg").size(13).text_color(why ? t.dim : t.accent));
  }

  // Which agent writes the message: a chip that drops a list over the file list,
  // ending in Settings.
  agentPicker(t) {
    const agent = this.agent(), agents = this.agents();
    const model = agent && modelName(agent), name = !agent ? "No agent" : model ? `${agent.name} · ${model}` : agent.name;
    // The menu says which model each runs, at what effort; Default names the CLI's own when listed.
    const detail = (a) => [modelName(a) || (a.command.includes("{model}") ? "default model" : ""), a.effort && effortLabel(a.effort)].filter(Boolean).join(" · ");
    // Drawn while closed too, at no height: opening then grows it and fades it in.
    const open = this.picking, full = agents.length * 29 + 46;
    const row = (id, icon, color, label, detail, mark, act) => h_flex().id(id).h(28).flex_none().px(8).gap(8).items_center().rounded(6).text_size(12)
      .text_color(act ? t.foreground : t.dim)
      .when(Boolean(act), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)).on_click((_e, cx) => act(cx)))
      .child(svg(icon).size(13).flex_none().text_color(color))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .child(div().flex_none().max_w(150).truncate().text_size(11).text_color(t.dim).child(detail))
      .child(div().w(12).flex_none().child(mark ? svg("mods/workspace-chrome/check.svg").size(12).text_color(t.accent) : div()));
    const chip = h_flex().id("commit-agent").min_w(0).max_w(240).h(24).px(6).gap(4).items_center().rounded(7).cursor_pointer().text_size(11.5).text_color(t.muted)
        .when(open, (el) => el.bg(t.selected).text_color(t.foreground))
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected))
        .tooltip("Agent that writes commit messages")
        .on_click((_e, cx) => {
          // The press outside the menu already closed it: this click must not reopen it.
          const just = Date.now() - (this.pickClosed ?? 0) < 400;
          this.picking = !this.picking && !just; this.pickClosed = 0;
          if (this.picking) for (const a of agents) if (this.installed?.has(a.bin)) discover(a.bin, cx);
          cx.notify();
        })
        .child(svg(agent?.icon ?? "mods/t3-changes/sparkles.svg").size(12).flex_none().text_color(agent ? agent.color ?? t.foreground : t.dim))
        .child(this.gen
          ? div().loop("opacity", { from: 0.45, to: 1, period: 1400 }).child(`${this.gen.agent.name} is writing…`)
          : div().min_w(0).truncate().child(name))
        .child(svg("mods/workspace-chrome/chevron-down.svg").size(11).flex_none().text_color(t.dim));
    // A Popup paints in a layer above the panel, so the list below can't cover it.
    return Popup.new("commit-agent-popup", chip).anchor("top_left").min_w(0)
      .content(v_flex().id("commit-agent-menu").mt(4).w(280).overflow_hidden()
        .h(open ? full : 0).opacity(open ? 1 : 0).transition("height", OPEN).transition("opacity", FADE)
        .p(open ? 4 : 0).gap(1).rounded(8).bg(t.popover).border_1().border_color(open ? t.border : t.popover).shadow_md()
        .on_mouse_down_out((_e, cx) => { if (this.picking) { this.picking = false; this.pickClosed = Date.now(); cx.notify(); } })
        .children(agents.map((a) => {
          const here = this.installed?.has(a.bin) ?? true;
          return row(`agent-${a.id}`, a.icon, here ? a.color ?? t.foreground : t.dim, a.name, !here ? "not installed" : detail(a), a.id === agent?.id,
            here && ((cx) => { setShared(AGENT_KEY, a.id); this.picking = false; cx.notify(); }));
        }))
        .child(div().h(1).mx(4).my(3).flex_none().bg(t.border))
        .child(row("agent-settings", "mods/workspace-chrome/settings.svg", t.muted, "Settings…", "agents, prompt", false, (cx) => this.openSettings(cx))));
  }

  render(cx) {
    if (this.dialog) return this.dialog.render(cx);
    if (key() !== this.context) this.refresh(cx);
    this.probe(this.agents().map((a) => a.bin), cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .child(v_flex().flex_none().p(10).gap(6).border_b(1).border_color(t.border)
        .child(div().id("commit-message").relative().w_full().min_w(0).pl(10).pr(32).py(6).rounded(8).border_1()
          .border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_key_down((e, cx) => { if (e.key === "enter" && e.modifiers.platform) { cx.stop_propagation(); this.commit(cx); } })
          .child(Textarea.new(this.input).w_full().text_size(12).text_color(t.foreground))
          .child(this.generateButton(t)))
        // The banner sits in the row's own column: the area's gap must not count a folded banner.
        .child(v_flex().w_full()
        .child(h_flex().w_full().gap(8).items_center()
          .child(this.agentPicker(t))
          .child(div().flex_1())
          .child(div().id("commit").flex_none().h(24).px(10).flex().items_center().rounded(6).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(11.5)
            .when(enabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.9)).active((s) => s.opacity(0.75))).tooltip(enabled ? "Stage everything and commit (⌘↵)" : "Write a message first")
            .on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")))
        .child(div().id("commit-banner").w_full().overflow_hidden().h(this.bannerOpen ? 34 : 0).transition("height", OPEN)
          .child(h_flex().mt(8).h(26).w_full().gap(6).items_center().px(10).rounded(7)
            .bg(t.ansi2 + "1c").text_size(11.5).text_color(t.ansi2)
            .opacity(this.bannerOpen ? 1 : 0).transition("opacity", FADE)
            .child(svg("mods/workspace-chrome/check.svg").size(12).flex_none())
            .child(div().flex_1().min_w(0).truncate().child(this.banner?.text ?? ""))))))
      .when(Boolean(this.note), (e) => e.child(div().px(12).py(6).border_b(1).border_color(t.border).text_size(11).text_color(t.ansi1).child(this.note)))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).max_h(this.files.length * 28 + 12).relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))));
  }
}
