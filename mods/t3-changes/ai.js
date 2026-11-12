// Commit messages written by a coding agent, after Orca's source-control AI:
// each agent run as a one-shot, read-only CLI with the prompt on stdin.

// Every run is isolated: no session saved, no hooks, tools, skills or project
// context files, so it only reads the prompt and answers. An agent is a name,
// a logo, a model and a shell command that reads the prompt on stdin; settings
// can change all four, switch agents off and add others.
export const SETTINGS_KEY = "t3.commit.settings";

// Logos to pick from: HarnessTrajectory's marks in their brand colours (null
// takes the theme's text colour), then plain ones.
const MARK = (name) => `mods/t3-sessions/agents/${name}.svg`;
export const LOGOS = [
  { id: "claude", icon: MARK("claude"), color: "#D97757" },
  { id: "codex", icon: MARK("codex"), color: "#5B7CFF" },
  { id: "pi", icon: MARK("pi"), color: "#1F9D8A" },
  { id: "opencode", icon: MARK("opencode"), color: null },
  { id: "cursor", icon: MARK("cursor"), color: null },
  { id: "kimi", icon: MARK("kimi"), color: null },
  { id: "grok", icon: MARK("grok"), color: null },
  { id: "devin", icon: MARK("devin"), color: "#6E56CF" },
  { id: "deepseek", icon: MARK("deepseek"), color: "#4D6BFE" },
  { id: "generic", icon: MARK("generic"), color: null },
  { id: "terminal", icon: "mods/workspace-chrome/terminal.svg", color: null },
  { id: "sparkles", icon: "mods/t3-changes/sparkles.svg", color: null },
];
export const logo = (id) => LOGOS.find((l) => l.id === id) ?? LOGOS.find((l) => l.id === "terminal");

// `{model}` and `{effort}` in a command are replaced by the agent's choices;
// one left empty goes, with the flag in front of it, and the CLI uses its own
// config. A commit message needs no strong model: the defaults are each CLI's
// small one at low effort (pi and OpenCode keep their configured model).
export const DEFAULT_AGENTS = [
  { id: "claude", name: "Claude", logo: "claude", model: "haiku", effort: "low",
    command: `claude -p --output-format text --model {model} --effort {effort} --tools "" --strict-mcp-config --settings '{"disableAllHooks":true}'` },
  { id: "codex", name: "Codex", logo: "codex", model: "gpt-6-luna", effort: "low",
    command: "codex exec --ephemeral --skip-git-repo-check -s read-only -m {model} -c model_reasoning_effort={effort}" },
  { id: "pi", name: "pi", logo: "pi", model: "", effort: "low",
    command: "pi --print --no-session --no-tools --no-skills --no-extensions --no-context-files --mode text --model {model} --thinking {effort}" },
  { id: "opencode", name: "OpenCode", logo: "opencode", model: "", effort: "",
    command: "opencode run -m {model} --variant {effort}" },
];

// The program a command runs, past any VAR=value in front: what "installed" checks.
export const binOf = (command) => (command.trim().split(/\s+/).find((w) => !/^\w+=/.test(w)) ?? "").replace(/^["']|["']$/g, "");

const fill = (command, key, value) => value
  ? command.replaceAll(`{${key}}`, `'${value.replace(/'/g, `'\\''`)}'`)
  : command.replace(new RegExp(`(?:\\s+-{1,2}[\\w-]+(?:=|\\s+))?(?:[\\w.-]+=)?\\{${key}\\}`, "g"), "");
export const commandFor = ({ command, model, effort }) => fill(fill(command, "model", model?.trim()), "effort", effort?.trim());

// Your agents (settings: { agents: [{ id, name, logo, model, effort, command, off }], prompt })
// or the defaults, ready to draw and run.
export function agentsFrom(s) {
  return (s?.agents ?? DEFAULT_AGENTS).map((a) => ({ ...a, ...logo(a.logo), model: a.model ?? "", effort: a.effort ?? "", bin: binOf(a.command), enabled: !a.off }));
}

export const DEFAULT_PROMPT = [
  "You are generating a single git commit message.",
  "Read the diff below and produce the message.",
  "",
  "Rules:",
  "- First line: imperative mood, <= 72 chars, no trailing period.",
  "- Optional body: blank line, then wrapped at 72 chars explaining WHY. Skip it for small changes.",
  "- Write in the language the recent commits use; follow their style (prefixes, casing).",
  "- Output ONLY the commit message - no preamble, no code fences, no quotes.",
  "- Do not include \"Co-authored-by\" or other git trailers.",
].join("\n");

// The instructions (yours or the default), then what the repository says.
export function buildPrompt({ instructions, diff, recent, fresh }) {
  return [
    instructions?.trim() || DEFAULT_PROMPT,
    ...(recent ? ["", "Recent commits:", recent] : []),
    // Untracked files have no diff: their names are the only signal.
    ...(fresh.length ? ["", "New files:", ...fresh.slice(0, 200)] : []),
    "",
    "Diff:",
    "```diff",
    diff || "(no text diff)",
    "```",
  ].join("\n");
}

// Shares the budget across files so one huge generated file can't crowd out the
// others; each file is cut on a line boundary with a marker.
export function truncateDiff(diff, budget = 60000) {
  if (diff.length <= budget) return diff;
  const sections = diff.split(/(?=^diff --git )/m);
  const alloc = sections.map(() => 0);
  let active = sections.map((_, i) => i), left = budget;
  while (active.length && left > 0) {
    const share = Math.floor(left / active.length);
    if (!share) break;
    active = active.filter((i) => {
      const grant = Math.min(sections[i].length - alloc[i], share);
      alloc[i] += grant; left -= grant;
      return alloc[i] < sections[i].length;
    });
  }
  return sections.map((s, i) => {
    if (s.length <= alloc[i]) return s;
    const cut = s.lastIndexOf("\n", alloc[i]);
    return `${s.slice(0, cut > alloc[i] / 2 ? cut : alloc[i])}\n...(diff truncated, ${s.length - alloc[i]} chars omitted)\n`;
  }).join("");
}

// Strips what agents wrap answers in: reasoning blocks, a progress line, one
// enclosing fence, quotes, list markers and trailers.
export function cleanMessage(raw) {
  let text = (raw ?? "").replace(/\r\n?/g, "\n").trim();
  text = text.replace(/^<think>[\s\S]*?<\/think>\s*/, "");
  const first = text.split("\n", 1)[0];
  if (text.includes("\n") && (/^(generating|thinking)\b/i.test(first) || /^[.…]+$/.test(first.trim()))) text = text.slice(first.length + 1).trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1].trim();
  text = text.replace(/^(["'`])([\s\S]*)\1$/, "$2").trim();
  text = text.replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, "");
  text = text.replace(/(\n[A-Z][\w-]*-by: .*)+$/, "").trim();
  return text;
}
