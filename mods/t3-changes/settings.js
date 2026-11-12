// Settings for the AI commit messages, after Orca's: the agents the ✨ can use
// (name, logo, model, effort and command, each on or off), agents of your own,
// and the prompt they get. Models and effort levels come from each CLI's own
// listing (models.js). This mod opened as a dialog with props { settings: true }
// (from the agent menu) draws this instead of the panel; Save writes them to
// shared state.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar, Popup } from "gpui-base";
import { exec, theme, settings, shared, setShared, props, closeOverlay } from "herdr";
import { SETTINGS_KEY, LOGOS, logo, DEFAULT_AGENTS, DEFAULT_PROMPT, binOf, agentsFrom } from "./ai.js";
import { discover, discoverable, discovering, listing, effortsOf, effortLabel } from "./models.js";

const FADE = { duration: 140, easing: "ease-out" }, OPEN = { duration: 180, easing: "ease-out" };
const SLIDE = { response: 220, damping: 0.9 };
const mono = () => settings().font_family ?? "JetBrains Mono";
const PER_ROW = 6, TILE = 30, ROW = 30, LIST = 264;

const ago = (at) => {
  const m = Math.floor((Date.now() - at) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export class CommitSettings {
  constructor(cx) {
    const s = shared(SETTINGS_KEY);
    this.rows = agentsFrom(s).map((a) => this.row(a));
    this.open = null;
    this.query = InputState.new({ placeholder: "Search models, or type one" });
    this.query.on("change", (_e, cx) => cx.notify());
    this.prompt = TextareaState.new({ value: s?.prompt || DEFAULT_PROMPT });
    this.prompt.set_auto_grow(8, 18);
    this.prompt.on("change", (_e, cx) => cx.notify());
    this.prompt.on("focus", (_e, cx) => { this.promptFocused = true; cx.notify(); });
    this.prompt.on("blur", (_e, cx) => { this.promptFocused = false; cx.notify(); });
    this.probe(cx);
  }

  // One agent being edited, its text in retained inputs.
  row(a) {
    const r = { id: a.id, logo: a.logo, off: !a.enabled, focused: null };
    const input = (field, value, placeholder) => {
      const state = InputState.new({ value, placeholder });
      state.on("change", (_e, cx) => cx.notify());
      state.on("focus", (_e, cx) => { r.focused = field; cx.notify(); });
      state.on("blur", (_e, cx) => { if (r.focused === field) r.focused = null; if (field === "cmd") this.probe(cx); cx.notify(); });
      return state;
    };
    r.name = input("name", a.name, "Name");
    r.model = input("model", a.model, "Default model");
    r.effort = input("effort", a.effort, "Effort");
    r.cmd = input("cmd", a.command, "Command that reads the prompt on stdin, e.g. ollama run {model}");
    return r;
  }

  release(rows) { for (const r of rows) for (const k of ["name", "model", "effort", "cmd"]) r[k].release(); }

  // What a row stands for right now, as agentsFrom would read it.
  agentOf(r) {
    const command = r.cmd.value().trim();
    return { id: r.id, name: r.name.value().trim() || binOf(command), logo: r.logo, model: r.model.value().trim(), effort: r.effort.value().trim(), command, bin: binOf(command) };
  }

  // Which of the commands' programs are on PATH, for the "not installed" note;
  // each known CLI then lists its models, unless a fresh listing is kept.
  probe(cx) {
    const bins = [...new Set(this.rows.map((r) => binOf(r.cmd.value())).filter(Boolean))];
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'for b; do command -v "$b" >/dev/null 2>&1 && echo "$b"; done', "sh", ...bins]).catch(() => null);
      this.installed = new Set((r?.stdout ?? "").split("\n").filter(Boolean));
      for (const bin of bins) if (this.installed.has(bin)) discover(bin, cx);
      cx.notify();
    });
  }

  add(cx) {
    const r = this.row({ id: `agent-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: "", logo: "terminal", model: "", effort: "", command: "", enabled: true });
    this.rows.push(r);
    cx.notify();
    cx.timer.after(0, () => r.name.focus());
  }

  remove(r, cx) {
    this.rows = this.rows.filter((x) => x !== r); this.release([r]);
    cx.notify();
  }

  restore(cx) {
    this.release(this.rows);
    this.rows = agentsFrom(null).map((a) => this.row(a)); this.open = null;
    this.probe(cx); cx.notify();
  }

  // What Save would store; an agent with no command is dropped.
  agents() {
    return this.rows.filter((r) => r.cmd.value().trim()).map((r) => {
      const { id, name, logo, model, effort, command } = this.agentOf(r);
      return { id, name, logo, model, effort, command, ...(r.off ? { off: true } : {}) };
    });
  }

  isDefault(agents) { return JSON.stringify(agents) === JSON.stringify(DEFAULT_AGENTS); }

  save() {
    const agents = this.agents(), prompt = this.prompt.value().trim();
    setShared(SETTINGS_KEY, { ...(this.isDefault(agents) ? {} : { agents }), ...(prompt && prompt !== DEFAULT_PROMPT ? { prompt } : {}) });
    closeOverlay(props()?.overlay);
  }

  // A press outside a menu closes it before its trigger's click arrives: that
  // click must not open it again, so the trigger toggles like a switch.
  close(key, cx) {
    if (this.open !== key) return;
    this.open = null; this.closed = { key, at: Date.now() };
    cx.notify();
  }

  toggleOpen(key, cx) {
    const just = this.closed?.key === key && Date.now() - this.closed.at < 400;
    this.closed = null;
    this.open = this.open === key || just ? null : key;
    if (this.open?.endsWith(":model")) { this.query.set_value(""); cx.timer.after(0, () => this.query.focus()); }
    cx.notify();
  }

  // Picking a model keeps the effort only where the new model takes it.
  pickModel(r, id, cx) {
    r.model.set_value(id);
    const efforts = effortsOf(this.agentOf(r), id);
    if (r.effort.value() && efforts.length && !efforts.includes(r.effort.value())) r.effort.set_value("");
    this.open = null; cx.notify();
  }

  // On/off: the knob springs across and the accent fill fades in under it.
  toggle(r, t) {
    const on = !r.off;
    return div().id(`toggle-${r.id}`).relative().w(30).h(18).flex_none().rounded(9).bg(t.border).cursor_pointer()
      .tooltip(on ? "Shown in the agent menu" : "Hidden from the agent menu")
      .on_click((_e, cx) => { r.off = on; cx.notify(); })
      .child(div().absolute().inset_0().rounded(9).bg(t.accent).opacity(on ? 1 : 0).transition("opacity", FADE))
      .child(div().absolute().top(2).left(on ? 14 : 2).size(14).rounded(7).bg(t.background).shadow_sm().spring("left", SLIDE));
  }

  // A menu under its trigger, drawn while closed too at no height so opening
  // grows it and fades it in. h is its open height; grow lets the trigger fill its row.
  // The effort menu hangs from its right edge, which is the card's.
  dropdown(key, trigger, w, h, t, content, grow = false, anchor = "top_left") {
    const open = this.open === key;
    return Popup.new(`popup-${key}`, trigger).anchor(anchor).when(grow, (el) => el.flex_1().min_w(0)).when(!grow, (el) => el.flex_none())
      .content(v_flex().id(`menu-${key}`).mt(4).w(w).overflow_hidden()
        .h(open ? h : 0).opacity(open ? 1 : 0).transition("height", OPEN).transition("opacity", FADE)
        .p(open ? 4 : 0).gap(1).rounded(8).bg(t.popover).border_1().border_color(open ? t.border : t.popover).shadow_md()
        .on_mouse_down_out((_e, cx) => this.close(key, cx))
        .children(content));
  }

  item(id, label, detail, on, act, t) {
    return h_flex().id(id).h(ROW).flex_none().px(8).gap(8).items_center().rounded(6).text_size(12).cursor_pointer()
      .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)).on_click((_e, cx) => act(cx))
      .child(div().flex_none().max_w(150).truncate().child(label))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(detail ?? ""))
      .child(div().w(12).flex_none().child(on ? svg("mods/workspace-chrome/check.svg").size(12).text_color(t.accent) : div()));
  }

  // A field-like button that opens a dropdown.
  select(id, label, open, t, act) {
    return h_flex().id(id).w_full().h(26).px(8).gap(6).items_center().rounded(6).border_1().border_color(open ? t.accent : t.input)
      .bg(t.background).cursor_pointer().text_size(12.5).hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
      .on_click((_e, cx) => act(cx))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .child(svg("mods/workspace-chrome/chevron-down.svg").size(11).flex_none().text_color(t.dim));
  }

  logoPicker(r, t) {
    const key = `${r.id}:logo`, mark = logo(r.logo), open = this.open === key;
    // Padding 6 and a 1px border on each side.
    const rows = Math.ceil(LOGOS.length / PER_ROW), w = PER_ROW * TILE + (PER_ROW - 1) * 4 + 14, h = rows * TILE + (rows - 1) * 4 + 14;
    const tile = div().id(`logo-${r.id}`).w(30).h(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .bg(open ? t.selected : t.raised).hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
      .tooltip("Change the logo").on_click((_e, cx) => this.toggleOpen(key, cx))
      .child(svg(mark.icon).size(14).text_color(mark.color ?? t.foreground));
    return Popup.new(`popup-${key}`, tile).anchor("top_left").flex_none()
      .content(div().id(`logos-${r.id}`).mt(4).w(w).overflow_hidden()
        .h(open ? h : 0).opacity(open ? 1 : 0).transition("height", OPEN).transition("opacity", FADE)
        .p(open ? 6 : 0).flex().flex_wrap().gap(4).rounded(8).bg(t.popover).border_1().border_color(open ? t.border : t.popover).shadow_md()
        .on_mouse_down_out((_e, cx) => this.close(key, cx))
        .children(LOGOS.map((l) => div().id(`logo-${r.id}-${l.id}`).size(TILE).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .border_1().border_color(l.id === r.logo ? t.accent : t.popover)
          .hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
          .on_click((_e, cx) => { r.logo = l.id; this.open = null; cx.notify(); })
          .child(svg(l.icon).size(15).text_color(l.color ?? t.foreground)))));
  }

  // The model: the CLI's listed models to search and pick, its config default
  // first (named when the listing says what it is), or any name typed in.
  modelPicker(r, a, t) {
    const key = `${r.id}:model`, l = listing(a.bin), busy = discovering(a.bin);
    const typed = this.query.value().trim(), q = typed.toLowerCase(), current = r.model.value().trim();
    const models = (l?.models ?? []).filter((m) => !q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
    const rows = [
      ...(!q ? [this.item(`${key}-default`, "Default", l?.default?.label ? `${l.default.label} · from its config` : "from its config", !current, (cx) => this.pickModel(r, "", cx), t)] : []),
      ...models.map((m) => this.item(`${key}-${m.id}`, m.label, m.detail ?? (m.label === m.id ? "" : m.id), m.id === current, (cx) => this.pickModel(r, m.id, cx), t)),
      ...(q && !models.some((m) => m.id.toLowerCase() === q) ? [this.item(`${key}-typed`, `Use "${typed}"`, "not in the list", false, (cx) => this.pickModel(r, typed, cx), t)] : []),
    ];
    const listH = Math.min(LIST, Math.max(1, rows.length) * (ROW + 1));
    const status = busy ? "Listing models…" : l?.error ? `Couldn't list models: ${l.error}` : l ? `${l.models.length} models · listed ${ago(l.at)}` : "Not listed yet";
    const label = current ? l?.models.find((m) => m.id === current)?.label ?? current : l?.default?.label ? `Default · ${l.default.label}` : "Default";
    const trigger = div().w_full().child(this.select(`model-${r.id}`, label, this.open === key, t, (cx) => this.toggleOpen(key, cx)));
    return this.dropdown(key, trigger, 340, 30 + 4 + listH + 7 + 24 + 14, t, [
      div().h(30).flex_none().px(8).flex().items_center().rounded(6).bg(t.raised).cursor_text()
        .child(Input.new(this.query).w_full().text_size(12).text_color(t.foreground)),
      div().h(4).flex_none(),
      div().h(listH).flex_none().relative()
        .child(v_flex().id(`${key}-list`).absolute().inset_0().overflow_y_scroll().gap(1).children(rows))
        .child(Scrollbar.vertical(`${key}-list`).absolute().inset_0()),
      div().h(1).mx(4).my(3).flex_none().bg(t.border),
      h_flex().h(24).flex_none().px(8).gap(6).items_center().text_size(11).text_color(l?.error ? t.blocked : t.dim)
        .when(busy, (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.accent).spin(900)))
        .child(div().flex_1().min_w(0).truncate().child(status))
        .when(!busy, (el) => el.child(this.link(`${key}-refresh`, "Refresh", true, (cx) => discover(a.bin, cx, true), t))),
    ], true);
  }

  // The effort levels the chosen model takes, Default leaving it to the CLI.
  effortPicker(r, a, t) {
    const key = `${r.id}:effort`, efforts = effortsOf(a), current = r.effort.value().trim();
    const options = ["", ...efforts, ...(current && !efforts.includes(current) ? [current] : [])];
    const trigger = div().w(118).flex_none().child(this.select(`effort-${r.id}`, current ? effortLabel(current) : "Default effort", this.open === key, t, (cx) => this.toggleOpen(key, cx)));
    return this.dropdown(key, trigger, 170, options.length * (ROW + 1) + 9, t,
      options.map((e) => this.item(`${key}-${e || "default"}`, e ? effortLabel(e) : "Default", e ? "" : "from its config", e === current,
        (cx) => { r.effort.set_value(e); this.open = null; cx.notify(); }, t)), false, "top_right");
  }

  // A framed single-line input that lights up while typing.
  field(r, key, state, t, mono_) {
    return div().id(`${key}-${r.id}`).h(26).px(8).flex().items_center().rounded(6).border_1()
      .border_color(r.focused === key ? t.accent : t.input).bg(key === "cmd" ? t.raised : t.background).cursor_text()
      .child(Input.new(state).w_full().text_size(mono_ ? 11.5 : 12.5).text_color(t.foreground).when(mono_, (el) => el.font_family(mono())));
  }

  card(r, t) {
    const on = !r.off, a = this.agentOf(r), known = discoverable(a.bin);
    const missing = Boolean(a.bin && this.installed && !this.installed.has(a.bin));
    const unused = (a.model && !a.command.includes("{model}")) || (a.effort && !a.command.includes("{effort}"));
    const note = missing ? [t.blocked, `${a.bin} is not installed`]
      : unused ? [t.dim, "The command has no {model} or {effort} for what's chosen: it is only shown, not passed"]
      : !a.command ? [t.dim, "An agent with no command is dropped on Save"] : null;
    const dim = (el) => el.opacity(on ? 1 : 0.5).transition("opacity", FADE);
    return v_flex().id(`card-${r.id}`).flex_none().p(10).gap(8).rounded(9).border_1().border_color(t.border).bg(t.background)
      .child(h_flex().gap(8).items_center()
        .child(this.logoPicker(r, t))
        .child(dim(div().flex_1().min_w(0)).child(this.field(r, "name", r.name, t)))
        .child(this.toggle(r, t))
        .child(div().id(`remove-${r.id}`).size(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
          .tooltip("Remove this agent").hover((s) => s.bg(t.ansi1 + "18")).active((s) => s.bg(t.ansi1 + "30"))
          .on_click((_e, cx) => this.remove(r, cx))
          .child(svg("mods/workspace-chrome/x.svg").size(12).text_color(t.muted))))
      // A CLI that lists its models gets pickers; any other takes them typed.
      .child(dim(h_flex().gap(8).items_center())
        .child(known ? this.modelPicker(r, a, t) : div().flex_1().min_w(0).child(this.field(r, "model", r.model, t)))
        .child(known ? this.effortPicker(r, a, t) : div().w(118).flex_none().child(this.field(r, "effort", r.effort, t))))
      .child(dim(div()).child(this.field(r, "cmd", r.cmd, t, true)))
      .when(Boolean(note), (el) => el.child(div().text_size(11).text_color(note[0]).child(note[1])));
  }

  // A section's title (with its reset action on the right) over a line on what it does.
  heading(title, detail, action, t) {
    return v_flex().gap(2).flex_none()
      .child(h_flex().h(22).items_center()
        .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child(title.toUpperCase()))
        .child(action))
      .child(div().text_size(11.5).text_color(t.dim).child(detail));
  }

  // A small text action that fades in when it applies, so the row never shifts.
  link(id, label, shown, act, t) {
    return div().id(id).px(6).h(22).flex().items_center().rounded(5).text_size(11).text_color(t.muted)
      .opacity(shown ? 1 : 0).transition("opacity", FADE)
      .when(shown, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).active((s) => s.bg(t.selected)).on_click((_e, cx) => act(cx)))
      .child(label);
  }

  button(id, label, primary, act, t) {
    return div().id(id).h(30).px(14).flex().items_center().rounded(7).text_size(12.5).cursor_pointer()
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.9)).active((s) => s.opacity(0.75)))
      .when(!primary, (el) => el.bg(t.raised).border_1().border_color(t.border).hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected)))
      .on_click((_e, cx) => act(cx)).child(label);
  }

  render(_cx) {
    const t = theme(), prompt = this.prompt.value().trim();
    const edited = this.rows.length !== DEFAULT_AGENTS.length || !this.isDefault(this.agents());
    return v_flex().id("commit-settings").size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => { if (e.key === "enter" && e.modifiers.platform) { cx.stop_propagation(); this.save(); } })
      .child(h_flex().h(56).flex_none().px(18).gap(10).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/t3-changes/sparkles.svg").size(16).text_color(t.accent))
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_size(14).font_semibold().child("Commit messages"))
          .child(div().text_size(11.5).text_color(t.dim).truncate().child("Which agents ✨ can use, and what they are asked")))
        .child(div().id("close").size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .tooltip("Close without saving (Esc)").hover((s) => s.bg(t.hover)).active((s) => s.bg(t.selected))
          .on_click(() => closeOverlay(props()?.overlay))
          .child(svg("mods/workspace-chrome/x.svg").size(13).text_color(t.muted))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("commit-settings-body").absolute().inset_0().overflow_y_scroll().px(18).py(16).gap(10)
          .child(this.heading("Agents", "Each command runs once in the repository, read-only, with the prompt on stdin; what it prints becomes the message. {model} and {effort} take the choices; an empty one is left out with its flag. A small model at low effort writes a commit message about as well as a big one, and faster.",
            this.link("restore-agents", "Restore defaults", edited, (cx) => this.restore(cx), t), t))
          .children(this.rows.map((r) => this.card(r, t)))
          // A dashed slot where the next card goes.
          .child(h_flex().id("add-agent").w_full().h(36).flex_none().gap(6).items_center().justify_center().rounded(9)
            .border_1().border_dashed().border_color(t.border).text_size(12).text_color(t.muted).cursor_pointer()
            .hover((s) => s.bg(t.hover).border_color(t.accent).text_color(t.accent)).active((s) => s.bg(t.selected))
            .on_click((_e, cx) => this.add(cx))
            .child(svg("mods/workspace-chrome/plus.svg").size(12)).child("Add agent"))
          .child(div().h(8).flex_none())
          .child(this.heading("Prompt", "Recent commit subjects, new file names and the diff go after it.",
            this.link("reset-prompt", "Reset to default", prompt !== DEFAULT_PROMPT, () => this.prompt.set_value(DEFAULT_PROMPT), t), t))
          .child(div().id("prompt").flex_none().px(10).py(8).rounded(8).border_1()
            .border_color(this.promptFocused ? t.accent : t.input).bg(t.background).cursor_text()
            .child(Textarea.new(this.prompt).w_full().font_family(mono()).text_size(11.5).text_color(t.foreground))))
        .child(Scrollbar.vertical("commit-settings-body").absolute().inset_0()))
      .child(h_flex().h(56).flex_none().px(18).gap(8).items_center().border_t(1).border_color(t.border)
        .child(div().flex_1().text_size(11).text_color(t.dim).child("⌘↵ saves · Esc cancels"))
        .child(this.button("cancel", "Cancel", false, () => closeOverlay(props()?.overlay), t))
        .child(this.button("save", "Save", true, () => this.save(), t)));
  }
}
