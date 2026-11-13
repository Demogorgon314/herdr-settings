// GitHub's colours (Primer's light and dark defaults) for the review, picked by
// how light the app's background is: the theme's own names, so everything drawn
// with them follows, and the diff's own (line and number backgrounds for added,
// removed, hunk and picked lines, the green button, the + on a line).

const LIGHT = {
  background: "#ffffff", raised: "#f6f8fa", chrome: "#f6f8fa", popover: "#ffffff",
  border: "#d1d9e0", input: "#d1d9e0", foreground: "#1f2328", muted: "#59636e", dim: "#818b98",
  accent: "#0969da", accent_foreground: "#ffffff", hover: "#eff2f5", selected: "#e7ecf0",
  solid: "#25292e", solid_foreground: "#ffffff",
  ansi1: "#d1242f", ansi2: "#1a7f37", ansi3: "#9a6700",
  addLine: "#dafbe1", addNum: "#aceebb", delLine: "#ffebe9", delNum: "#ffcecb",
  hunkLine: "#ddf4ff", hunkNum: "#b6e3ff", pickLine: "#fff8c5", pickNum: "#fae17d",
  green: "#1f883d", green_foreground: "#ffffff", green_off: "#94d3a2",
  button: "#f6f8fa", button_foreground: "#25292e",
};

const DARK = {
  background: "#0d1117", raised: "#151b23", chrome: "#151b23", popover: "#151b23",
  border: "#3d444d", input: "#3d444d", foreground: "#f0f6fc", muted: "#9198a1", dim: "#656c76",
  accent: "#4493f8", accent_foreground: "#ffffff", hover: "#262c36", selected: "#2a313c",
  solid: "#f0f6fc", solid_foreground: "#0d1117",
  ansi1: "#f85149", ansi2: "#3fb950", ansi3: "#d29922",
  addLine: "#2ea04326", addNum: "#3fb9504d", delLine: "#f851491a", delNum: "#f851494d",
  hunkLine: "#388bfd1a", hunkNum: "#388bfd66", pickLine: "#bb800926", pickNum: "#bb800966",
  green: "#238636", green_foreground: "#ffffff", green_off: "#105823",
  button: "#212830", button_foreground: "#f0f6fc",
};

// A #rrggbb colour's relative luminance, 0 (black) to 1 (white).
function luminance(hex) {
  const m = /^#?([0-9a-f]{6})/i.exec(hex ?? "");
  if (!m) return 1;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((c) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const github = (t) => ({ ...t, ...(luminance(t.background) > 0.4 ? LIGHT : DARK) });
