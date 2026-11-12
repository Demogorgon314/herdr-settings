// Commit messages written by a coding agent, after Orca's source-control AI:
// each agent run as a one-shot, read-only CLI with the prompt on stdin.

// Every run is isolated: no session saved, no hooks, tools, skills or project
// context files, so it only reads the prompt and answers.
export const AGENTS = [
  { id: "claude-haiku", label: "Claude", model: "Haiku", bin: "claude",
    args: ["-p", "--output-format", "text", "--model", "haiku", "--tools", "", "--strict-mcp-config", "--settings", '{"disableAllHooks":true}'] },
  { id: "claude-sonnet", label: "Claude", model: "Sonnet", bin: "claude",
    args: ["-p", "--output-format", "text", "--model", "sonnet", "--effort", "low", "--tools", "", "--strict-mcp-config", "--settings", '{"disableAllHooks":true}'] },
  { id: "codex", label: "Codex", bin: "codex",
    args: ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-c", "model_reasoning_effort=low"] },
  { id: "pi", label: "pi", bin: "pi",
    args: ["--print", "--no-session", "--no-tools", "--no-skills", "--no-extensions", "--no-context-files", "--mode", "text"] },
  { id: "opencode", label: "opencode", bin: "opencode", args: ["run"] },
];

export function buildPrompt({ diff, recent, fresh }) {
  return [
    "You are generating a single git commit message.",
    "Read the diff below and produce the message.",
    "",
    "Rules:",
    "- First line: imperative mood, <= 72 chars, no trailing period.",
    "- Optional body: blank line, then wrapped at 72 chars explaining WHY. Skip it for small changes.",
    "- Write in the language the recent commits use; follow their style (prefixes, casing).",
    "- Output ONLY the commit message - no preamble, no code fences, no quotes.",
    "- Do not include \"Co-authored-by\" or other git trailers.",
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
