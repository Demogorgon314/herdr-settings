import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, run, theme } from "herdr";

const tools = [
  ["files", "Files", "mods/t3-files/file.svg"],
  ["changes", "Changes", "mods/t3-changes/changes.svg"],
  ["sessions", "Sessions", "mods/t3-sessions/sessions.svg"],
  ["favorites", "Favorites", "mods/t3-files/star.svg"],
];

// Below this track width the labels no longer fit four equal segments: icons only.
const LABELS_FROM = 326;
// The active segment's pill slides between segments rather than jumping.
const SLIDE = { response: 260, damping: 0.86 };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// A segmented control: equal segments, so switching never moves the others.
export default class ToolsNav extends View {
  render() {
    const t = theme(), root = layout() ?? {}, active = find(root, "tools-body")?.active;
    // The track's drawn width, not the layout's: a panel's recorded size can differ
    // from what it gets (min/max, a resize not yet saved). Inside: 2px inset, 2px gaps.
    const width = this.track, labels = (width ?? Infinity) >= LABELS_FROM;
    const segment = width ? (width - 4 - 2 * (tools.length - 1)) / tools.length : null;
    const index = tools.findIndex(([id]) => id === active);
    return h_flex().size_full().items_center().px(6).bg(t.chrome)
      .child(h_flex().id("tools-track").relative().w_full().h(30).p(2).gap(2).rounded(8).bg(t.raised)
        .on_size_change(({ width }, cx) => { if (width !== this.track) { this.track = width; cx.notify(); } })
        .when(Boolean(segment) && index >= 0, el => el.child(div().id("tools-pill").absolute().top(2).h(26)
          .left(2 + index * (segment + 2)).w(segment).spring("left", SLIDE).spring("width", SLIDE)
          .rounded(6).bg(t.background).border_1().border_color(t.border).shadow_sm()))
        .children(tools.map(([id, label, icon]) => {
          const on = id === active;
          return h_flex().id(id).flex_1().min_w(0).h_full().px(6).gap(5).items_center().justify_center().rounded(6)
            .text_size(12).text_color(on ? t.foreground : t.muted)
            .when(on && !segment, el => el.bg(t.background).border_1().border_color(t.border))
            .when(!on, el => el.cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground)).active(s => s.bg(t.selected)))
            .role("button").accessibility_label(label)
            .when(!labels, el => el.tooltip(label))
            .on_click(() => run("layout.select", { stack: "tools-body", child: id }))
            .child(svg(icon).size(14).flex_none().text_color(on ? t.accent : t.muted))
            .when(labels, el => el.child(div().min_w(0).truncate().child(label)));
        })));
  }
}
