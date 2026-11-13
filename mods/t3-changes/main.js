import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar, Popup } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, shared, setShared, openOverlay, props } from "herdr";
import { SETTINGS_KEY, agentsFrom, commandFor, buildPrompt, truncateDiff, cleanMessage } from "./ai.js";
import { CommitSettings } from "./settings.js";
import { DiffWindow, READ, AREAS, statusColor, keyOf, readChanges } from "./diff.js";
import { discover, modelName, effortLabel } from "./models.js";
import { readBranch, syncAction, fetchRemotes, runSync } from "./sync.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
const AGENT_KEY = "t3.commit.agent";
const FADE = { duration: 140, easing: "ease-out" }, OPEN = { duration: 180, easing: "ease-out" };
const FILE_ROW = 26;
// How often the remote is fetched in the background, as editors do, so Pull knows what's new.
const FETCH_EVERY = 180000;
const MOVING = { publish: "Publishing…", push: "Pushing…", pull: "Pulling…", sync: "Syncing…" };
const paths = (files) => [...new Set(files.map((f) => f.path))];

export default class Changes extends View {
  init(_props, cx) {
    if (props()?.settings) { this.dialog = new CommitSettings(cx); return; }
    if (props()?.diff) { this.dialog = new DiffWindow(cx, this); return; }
    this.files = []; this.collapsed = new Set(); this.message = ""; this.handle = cx.focus_handle();
    this.gen = null; this.picking = false; this.installed = null;
    this.input = TextareaState.new({ placeholder: "Commit message (⌘↵ to commit)" });
    this.input.set_auto_grow(2, 8);
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (e, cx) => this.commit(cx, Boolean(e.modifiers?.shift)));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    cx.timer.every(FETCH_EVERY, (cx) => this.fetch(cx));
  }

  // A review window or tab stops watching its folder when it goes.
  async close() { if (this.dialog) this.dialog.gone = true; this.watched = null; }

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
    // A refresh asked for while one runs (after a stage, say) runs when it ends.
    if (this.loading || this.busy) { this.again = true; return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.viewing = null;
      this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.limited = false; this.branch = null;
    }
    if (!cwd) return;
    this.loading = true; this.again = false;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim();
        const [{ files, hasHead, limited }, branch] = await Promise.all([readChanges({ root, on }), readBranch({ root, on }).catch(() => null)]);
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = hasHead; this.files = files; this.limited = limited; this.error = null; this.branch = branch;
        // A repository newly shown is fetched at once, then every few minutes.
        if (this.fetchedRoot !== root) { this.fetchedRoot = root; this.fetch(cx); }
        if (this.viewing && !files.some((f) => keyOf(f) === this.viewing)) this.viewing = null;
        this.watch(root, cx);
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; if (this.again) this.refresh(cx); cx.notify(); }
    });
  }

  // The changes as GitHub's "Files changed" shows them, in a window, at this file.
  openDiff(file, cx) {
    if (!this.root || !this.files.length) return;
    this.viewing = file ? keyOf(file) : null;
    const files = this.files.map(({ area, path, status, add, del, binary }) => ({ area, path, status, add, del, binary }));
    openOverlay({ mod: "t3-changes", kind: "window", key: "t3-diff", width: 1040, height: 760,
      props: { diff: { root: this.root, on: this.on, files, focus: file ? this.files.indexOf(file) : 0 } } });
    cx.notify();
  }

  // Runs git steps on entries, then reads the status again.
  git(steps, cx) {
    const root = this.root, on = this.on, context = this.context;
    if (!root || this.busy) return;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of steps) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
      } catch (e) { if (key() === context) this.note = `git: ${e.message ?? e}`; }
      this.refresh(cx); cx.notify();
    });
  }

  stage(files, cx) { this.git([["add", "--", ...paths(files)]], cx); }
  unstage(files, cx) { this.git([this.hasHead ? ["restore", "--staged", "--", ...paths(files)] : ["rm", "--cached", "-q", "--", ...paths(files)]], cx); }

  // Discarding loses work: the first click arms the button (red), a second
  // within three seconds discards. An untracked file is deleted.
  discard(file, cx) {
    const k = keyOf(file);
    if (this.confirm !== k) {
      this.confirm = k; cx.notify();
      cx.timer.after(3000, (cx) => { if (this.confirm === k) { this.confirm = null; cx.notify(); } });
      return;
    }
    this.confirm = null;
    this.git([file.area === "untracked" ? ["clean", "-f", "-q", "--", file.path] : ["restore", "--worktree", "--", file.path]], cx);
  }

  // With push, the commit then goes up as the sync button would move it.
  commit(cx, push = false) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    // With anything staged only that is committed; otherwise everything, as editors do.
    const steps = this.files.some((f) => f.area === "staged") ? [["commit", "-m", message]] : [["add", "-A"], ["commit", "-m", message]];
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of steps) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
        const head = await exec("git", ["log", "-1", "--format=%h"], { cwd: root, on }).catch(() => null);
        const done = `Committed ${head?.stdout.trim() ?? ""}`.trim();
        let moved = null;
        if (push) {
          try { moved = await this.move({ root, on }, cx); }
          catch (e) { if (key() === context) this.note = `${done}, but ${e.message ?? e}`; }
        }
        if (key() === context) this.celebrate(moved ? `${done} · ${moved}` : done, cx);
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.moving = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // Fetches quietly in the background; a failure (offline, say) just leaves the counts as they were.
  fetch(cx) {
    const root = this.root, on = this.on, context = this.context;
    if (!root || this.fetching || !(this.branch?.upstream || this.branch?.remote)) return;
    this.fetching = true; cx.notify();
    cx.spawn(async (cx) => {
      await fetchRemotes({ root, on });
      this.fetching = false;
      if (key() === context) this.refresh(cx);
      cx.notify();
    });
  }

  // The sync button: moves commits between the branch and its upstream (see sync.js).
  sync(cx) {
    const root = this.root, on = this.on, context = this.context;
    if (!root || this.busy || this.loading || this.context !== key()) return;
    this.busy = true; this.note = null; this.syncMenu = false;
    cx.spawn(async (cx) => {
      try { const said = await this.move({ root, on }, cx); if (said && key() === context) this.celebrate(said, cx); }
      catch (e) { if (key() === context) this.note = String(e.message ?? e); }
      finally { this.busy = false; this.moving = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // Reads the branch afresh and moves what it needs: what to say, or null with nothing to move.
  async move(repo, cx) {
    const b = await readBranch(repo), action = syncAction(b);
    if (!action) return null;
    this.moving = action; cx.notify();
    return runSync(repo, action, b);
  }

  // A short-lived line above the message box: slides open, then folds away.
  celebrate(text, cx) {
    const shown = { text };
    this.banner = shown; this.bannerOpen = true;
    cx.notify();
    cx.timer.after(2200, (cx) => { if (this.banner === shown) { this.bannerOpen = false; cx.notify(); } });
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
    if (this.busy) return this.moving ? "Syncing with the remote…" : "Commit in progress…";
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
    // It describes what Commit would commit: the staged files, or everything.
    const staged = this.files.some((f) => f.area === "staged");
    const fresh = staged ? [] : this.files.filter((f) => f.area === "untracked").map((f) => f.path);
    const gen = { agent, pid: `/tmp/t3-changes-${Date.now()}.pid` };
    this.gen = gen; this.note = null; this.picking = false;
    cx.spawn(async (cx) => {
      try {
        const [log, diff] = await Promise.all([
          exec("git", [...READ, "log", "--format=%s", "-10"], { cwd: root }).catch(() => null),
          exec("git", [...READ, "diff", ...(staged || !hasHead ? ["--cached"] : ["HEAD"]), "--no-color", "--no-textconv", "--no-ext-diff"], { cwd: root }).catch(() => null),
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

  // Commit, and beside it a menu with Commit & Push (⌘⇧↵).
  commitButton(t, enabled, staged) {
    const what = staged ? "the staged files" : "everything", open = Boolean(this.commitMenu);
    const face = (el) => el.h(24).flex().items_center().bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.9)).active((s) => s.opacity(0.75)));
    const row = (id, label, keys, act) => h_flex().id(id).h(28).flex_none().px(8).gap(8).items_center().rounded(6).text_size(12).cursor_pointer()
      .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)).on_click((_e, cx) => { this.commitMenu = false; act(cx); })
      .child(div().flex_1().child(label)).child(div().text_size(11).text_color(t.dim).child(keys));
    const chevron = face(div().id("commit-more").px(5).rounded_r(6).border_l(1).border_color(enabled ? t.background + "55" : t.border))
      .on_click((_e, cx) => {
        // The press outside the menu already closed it: this click must not reopen it.
        const just = Date.now() - (this.commitMenuClosed ?? 0) < 400;
        this.commitMenu = enabled && !this.commitMenu && !just; this.commitMenuClosed = 0; cx.notify();
      })
      .child(svg("mods/workspace-chrome/chevron-down.svg").size(11).text_color(enabled ? t.solid_foreground : t.dim));
    return h_flex().flex_none().items_center()
      .child(face(div().id("commit").px(10).rounded_l(6).text_size(11.5))
        .tooltip(!enabled ? "Write a message first" : `Commit ${what} (⌘↵)`)
        .on_click((_e, cx) => this.commit(cx))
        .child(this.busy ? MOVING[this.moving] ?? "Committing…" : "Commit"))
      .child(Popup.new("commit-more-popup", chevron).anchor("top_right").min_w(0)
        .content(v_flex().id("commit-more-menu").mt(4).w(220).overflow_hidden()
          .h(open ? 2 * 29 + 8 : 0).opacity(open ? 1 : 0).transition("height", OPEN).transition("opacity", FADE)
          .p(open ? 4 : 0).gap(1).rounded(8).bg(t.popover).border_1().border_color(open ? t.border : t.popover).shadow_md()
          .on_mouse_down_out((_e, cx) => { if (this.commitMenu) { this.commitMenu = false; this.commitMenuClosed = Date.now(); cx.notify(); } })
          .child(row("commit-only", "Commit", "⌘↵", (cx) => this.commit(cx)))
          .child(row("commit-push", "Commit & Push", "⌘⇧↵", (cx) => this.commit(cx, true)))));
  }

  // Under Commit: the branch, its upstream, how far ahead (↑) and behind (↓) it
  // is, Fetch, and the one button that moves it: Publish, Push, Pull or Sync.
  branchRow(t) {
    const b = this.branch, action = syncAction(b), idle = !this.busy && !this.loading;
    const label = this.moving ? MOVING[this.moving]
      : { publish: "Publish branch", push: `Push ↑${b.ahead}`, pull: `Pull ↓${b.behind}`, sync: `Sync ↓${b.behind} ↑${b.ahead}` }[action];
    const tip = { publish: `Push ${b.name} to ${b.remote} and track it (git push -u)`, push: `Push to ${b.upstream}`,
      pull: `Fast-forward from ${b.upstream} (git pull --ff-only)`, sync: `Rebase onto ${b.upstream}, then push` }[action];
    const where = b.upstream ?? (b.remote ? "not published" : "no remote");
    return h_flex().w_full().h(24).mt(8).gap(6).items_center().text_size(11.5).text_color(t.muted)
      .child(svg("mods/workspace-chrome/git-branch.svg").size(12).flex_none().text_color(t.dim))
      .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.foreground).child(b.name))
      .child(div().flex_shrink(2).min_w(0).truncate().text_color(t.dim).child(`→ ${where}`))
      .when(b.behind > 0, (el) => el.child(div().flex_none().child(`↓${b.behind}`)))
      .when(b.ahead > 0, (el) => el.child(div().flex_none().child(`↑${b.ahead}`)))
      .child(div().flex_1())
      .when(Boolean(b.upstream || b.remote), (el) => el.child(div().id("fetch").size(22).flex_none().flex().items_center().justify_center().rounded(5)
        .tooltip(this.fetching ? "Fetching…" : "Fetch").when(!this.fetching, (e) => e.cursor_pointer().hover((s) => s.bg(t.selected)))
        .on_click((_e, cx) => this.fetch(cx))
        .child(svg("mods/t3-changes/rotate-cw.svg").size(12).text_color(t.muted).when(Boolean(this.fetching), (s) => s.spin(900)))))
      .when(Boolean(action || this.moving), (el) => el.child(div().id("sync").flex_none().h(22).px(8).flex().items_center().rounded(6).border_1().border_color(t.border)
        .text_color(idle ? t.foreground : t.dim).tooltip(tip ?? "")
        .when(idle, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)))
        .on_click((_e, cx) => this.sync(cx))
        .child(label)));
  }

  // A small icon button in a row or section title; it acts only while shown,
  // and its click doesn't reach the row under it.
  action(id, icon, tip, shown, act, t, danger = false) {
    return div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(5)
      .when(danger, (el) => el.bg(t.ansi1 + "20"))
      .when(shown, (el) => el.cursor_pointer().tooltip(tip)
        .hover((s) => s.bg(danger ? t.ansi1 + "30" : t.selected)).active((s) => s.bg(danger ? t.ansi1 + "40" : t.selected))
        .on_click((_e, cx) => { cx.stop_propagation(); act(cx); }))
      .child(svg(icon).size(13).text_color(danger ? t.ansi1 : t.muted));
  }

  // A changed file: its icon in the status colour, name, folder, line counts
  // and status letter. Under the pointer the counts give way to its actions.
  fileRow(f, t) {
    const k = keyOf(f), hovered = this.hover === k, armed = this.confirm === k;
    const parts = f.path.split("/"), name = parts.pop();
    const actions = f.area === "staged"
      ? [this.action(`unstage-${k}`, "mods/workspace-chrome/minus.svg", "Unstage", hovered, (cx) => this.unstage([f], cx), t)]
      : [
        ...(f.area === "merge" ? [] : [this.action(`discard-${k}`, f.area === "untracked" ? "mods/workspace-chrome/x.svg" : "mods/t3-changes/undo.svg",
          armed ? "Click again to discard" : f.area === "untracked" ? "Delete this file" : "Discard changes", hovered, (cx) => this.discard(f, cx), t, armed)]),
        this.action(`stage-${k}`, "mods/workspace-chrome/plus.svg", f.area === "merge" ? "Mark resolved (stage)" : "Stage", hovered, (cx) => this.stage([f], cx), t),
      ];
    return h_flex().id(`change-${k}`).h(FILE_ROW).flex_none().pl(24).pr(6).gap(6).items_center().rounded(6).cursor_pointer()
      .when(this.viewing === k, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
      .on_hover((h, cx) => {
        if (h) this.hover = k;
        else if (this.hover === k) this.hover = null;
        cx.notify();
      })
      .on_click((_e, cx) => this.openDiff(f, cx))
      .child(svg("mods/t3-files/file.svg").size(13).flex_none().text_color(statusColor(f.status, t)))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().flex_shrink(1).min_w(0).truncate().text_size(12.5).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/"))))
      // Wide enough for the actions, so they never cover the name.
      .child(div().relative().flex_none().min_w(48).h(22)
        .child(h_flex().h_full().gap(4).items_center().justify_end().text_size(11).opacity(hovered ? 0 : 1).transition("opacity", FADE)
          .when(f.add > 0, (el) => el.child(div().text_color(t.ansi2).child(`+${f.add}`)))
          .when(f.del > 0, (el) => el.child(div().text_color(t.ansi1).child(`−${f.del}`))))
        .child(h_flex().absolute().top(0).right(0).h_full().gap(2).items_center().opacity(hovered ? 1 : 0).transition("opacity", FADE).children(actions)))
      .child(div().w(12).flex_none().text_center().text_size(10.5).font_semibold().text_color(statusColor(f.status, t)).child(f.status));
  }

  // A section (Merge, Staged, Changes, Untracked): its title folds it and,
  // under the pointer, offers to stage or unstage all of it.
  section(area, files, t) {
    const open = !this.collapsed.has(area), hovered = this.hover === `section:${area}`;
    const all = area === "staged"
      ? [this.action(`unstage-all`, "mods/workspace-chrome/minus.svg", "Unstage all", hovered, (cx) => this.unstage(files, cx), t)]
      : area === "merge" ? [] : [this.action(`stage-all-${area}`, "mods/workspace-chrome/plus.svg", "Stage all", hovered, (cx) => this.stage(files, cx), t)];
    return v_flex().flex_none()
      .child(h_flex().id(`section-${area}`).h(28).flex_none().px(6).gap(6).items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
        .on_hover((h, cx) => { if (h) this.hover = `section:${area}`; else if (hovered) this.hover = null; cx.notify(); })
        .on_click((_e, cx) => { if (open) this.collapsed.add(area); else this.collapsed.delete(area); cx.notify(); })
        .child(svg(`mods/t3-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
        .child(div().text_size(11).font_semibold().text_color(t.muted).child(AREAS[area].toUpperCase()))
        .child(div().px(6).rounded(8).bg(t.raised).text_size(10.5).text_color(t.muted).child(String(files.length)))
        .child(div().flex_1())
        .child(h_flex().gap(2).opacity(hovered ? 1 : 0).transition("opacity", FADE).children(all)))
      .child(v_flex().overflow_hidden().h(open ? files.length * (FILE_ROW + 1) : 0).transition("height", OPEN).gap(1)
        .children(files.map((f) => this.fileRow(f, t))));
  }

  // What the list says when it has no files: why, and what to do.
  empty(t) {
    const [icon, title, detail, color] = this.error === "Not a git repository"
      ? ["mods/workspace-chrome/folder.svg", "Not a git repository", "Focus a terminal in a repository to see its changes.", t.muted]
      : this.error ? ["mods/workspace-chrome/x.svg", "Cannot read the changes", this.error, t.ansi1]
      : !this.root ? [null, "Loading changes…", "", t.muted]
      : ["mods/workspace-chrome/circle-check.svg", "No changes", "The working tree matches the last commit.", t.ansi2];
    return v_flex().w_full().pt(32).px(20).gap(6).items_center()
      .child(div().size(36).rounded(18).flex().items_center().justify_center().bg(t.raised)
        .child(icon ? svg(icon).size(16).text_color(color) : svg("mods/workspace-chrome/spinner.svg").size(16).text_color(t.accent).spin(900)))
      .child(div().mt(4).text_size(13).font_semibold().child(title))
      .when(Boolean(detail), (el) => el.child(div().text_center().text_size(11.5).text_color(t.dim).child(detail)));
  }

  render(cx) {
    if (this.dialog) return this.dialog.render(cx);
    if (key() !== this.context) this.refresh(cx);
    this.probe(this.agents().map((a) => a.bin), cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const count = paths(this.files).length, staged = this.files.some((f) => f.area === "staged");
    const groups = Object.keys(AREAS).map((area) => [area, this.files.filter((f) => f.area === area)]).filter(([, files]) => files.length);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${count} ${count === 1 ? "file" : "files"}`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))
        .when(count > 0, (el) => el.child(this.action("review-all", "mods/workspace-chrome/git-compare.svg", "Review all changes", true, (cx) => this.openDiff(null, cx), t))))
      .child(v_flex().flex_none().p(10).gap(6).border_b(1).border_color(t.border)
        .child(div().id("commit-message").relative().w_full().min_w(0).pl(10).pr(32).py(6).rounded(8).border_1()
          .border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_key_down((e, cx) => { if (e.key === "enter" && e.modifiers.platform) { cx.stop_propagation(); this.commit(cx, Boolean(e.modifiers.shift)); } })
          .child(Textarea.new(this.input).w_full().text_size(12).text_color(t.foreground))
          .child(this.generateButton(t)))
        // The banner sits in the row's own column: the area's gap must not count a folded banner.
        .child(v_flex().w_full()
        .child(h_flex().w_full().gap(8).items_center()
          .child(this.agentPicker(t))
          .child(div().flex_1())
          .child(this.commitButton(t, enabled, staged)))
        .when(Boolean(this.branch?.name), (el) => el.child(this.branchRow(t)))
        .child(div().id("commit-banner").w_full().overflow_hidden().h(this.bannerOpen ? 34 : 0).transition("height", OPEN)
          .child(h_flex().mt(8).h(26).w_full().gap(6).items_center().px(10).rounded(7)
            .bg(t.ansi2 + "1c").text_size(11.5).text_color(t.ansi2)
            .opacity(this.bannerOpen ? 1 : 0).transition("opacity", FADE)
            .child(svg("mods/workspace-chrome/check.svg").size(12).flex_none())
            .child(div().flex_1().min_w(0).truncate().child(this.banner?.text ?? ""))))))
      .when(Boolean(this.note), (e) => e.child(div().px(12).py(6).border_b(1).border_color(t.border).text_size(11).text_color(t.ansi1).child(this.note)))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().px(6).py(6).gap(2)
          .when(groups.length > 0, (el) => el.children(groups.map(([area, files]) => this.section(area, files, t))))
          .when(!groups.length, (el) => el.child(this.empty(t)))
          .when(this.limited, (el) => el.child(div().px(8).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files"))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()));
  }
}
