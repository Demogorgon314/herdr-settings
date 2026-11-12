// Review comments, as GitHub leaves them on a diff and Orca hands them to an
// agent: on a line, a run of lines or a whole file, kept per repository in
// shared state (COMMENTS_KEY: { [root]: [comment] }) so they outlive the window
// and move with it into a tab, and sent as one prompt that names each place and
// quotes its code. Sent comments are cleared, as Orca clears delivered notes.
//
// A comment: { id, path, side: "new" | "old", line, from, code: ["+…"], body, at };
// no line means the whole file. Lines count on the side the last line is on:
// a removed line by the old file's numbers, any other by the new file's.

import { shared, setShared } from "herdr";

export const COMMENTS_KEY = "t3.review.comments";
const QUOTE = 12;

export const commentsOf = (root) => shared(COMMENTS_KEY)?.[root] ?? [];

export function saveComments(root, list) {
  const all = { ...(shared(COMMENTS_KEY) ?? {}) };
  if (list.length) all[root] = list; else delete all[root];
  setShared(COMMENTS_KEY, all);
}

// Where a row of a diff is, as a comment anchors to it (null: not a line of either file).
export const anchorOf = (row) => row.kind === "-" ? { side: "old", line: row.old } : row.next !== undefined ? { side: "new", line: row.next } : null;

export const where = (c) => c.line == null ? "File" : c.from != null && c.from !== c.line ? `Lines ${c.from}–${c.line}` : `Line ${c.line}`;

// A comment on rows a..b of a file's diff rows (both ends commentable lines),
// or with no rows on the whole file.
export function commentOn(path, body, rows, a, b) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at = Date.now();
  if (!rows) return { id, path, line: null, body: body.trim(), at };
  const picked = rows.slice(a, b + 1).filter((r) => anchorOf(r));
  const end = anchorOf(picked.at(-1));
  const first = picked.find((r) => anchorOf(r).side === end.side);
  const code = picked.slice(-QUOTE).map((r) => `${r.kind || " "}${r.text}`);
  return { id, path, ...end, from: anchorOf(first).line, code, body: body.trim(), at };
}

export function formatComments(root, list) {
  const parts = list.map((c) => [
    `File: ${c.path}`,
    c.line == null ? "Scope: the whole file" : `${where(c)}${c.side === "old" ? " (removed; old file's numbers)" : ""}`,
    ...(c.code?.length ? ["```diff", ...c.code, "```"] : []),
    `Comment: ${c.body}`,
  ].join("\n"));
  const one = list.length === 1;
  return [`Review ${one ? "comment" : "comments"} on the uncommitted changes in ${root}. Please address ${one ? "it" : "each one"}:`, ...parts].join("\n\n");
}

// Text broken at a column count, so a card's height is known before it's drawn.
export function wrap(text, cols) {
  const out = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (line.length + word.length <= cols) { line += word; continue; }
      if (line.trim()) out.push(line.trimEnd());
      line = word.trimStart();
      while (line.length > cols) { out.push(line.slice(0, cols)); line = line.slice(cols); }
    }
    out.push(line.trimEnd());
  }
  return out;
}

export function ago(at) {
  const s = (Date.now() - at) / 1000;
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}
