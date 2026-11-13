// The branch against its upstream, and moving commits between them, as editors
// do under their Commit button: Publish a branch with no upstream, Push what's
// ahead, Pull (fast-forward only) what's behind, and when it's both, Sync:
// rebase onto the upstream (work in progress stashed and put back) and push.
// Nothing forces: a rejected push stops, and a rebase that conflicts is undone,
// both for a terminal. Network steps never ask for a password, which would wait
// where nobody sees it; ssh keys and credential helpers still answer.

import { exec } from "herdr";
import { READ } from "./diff.js";

// Pushes run hooks and big uploads: give them minutes.
const NET = 300000, FETCH = 60000;

const net = ({ root, on }, args, timeout = NET) => exec("env", ["GIT_TERMINAL_PROMPT=0", "git", ...args], { cwd: root, on, timeout });

// { name, commits, upstream, remote, ahead, behind }: name null when detached;
// commits false before the first; upstream null when it has none, and then
// remote is where Publish sends it (null with no remote).
export async function readBranch({ root, on }) {
  const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
  const [head, born] = await Promise.all([git(["symbolic-ref", "--short", "-q", "HEAD"]), git(["rev-parse", "-q", "--verify", "HEAD"])]);
  if (head.code !== 0) return { name: null };
  const name = head.stdout.trim(), commits = born.code === 0;
  const up = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (up.code !== 0) {
    const remotes = (await git(["remote"])).stdout.split("\n").filter(Boolean);
    return { name, commits, upstream: null, remote: remotes.includes("origin") ? "origin" : remotes[0] ?? null, ahead: 0, behind: 0 };
  }
  const counts = await git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
  const [ahead = 0, behind = 0] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [];
  return { name, commits, upstream: up.stdout.trim(), ahead, behind };
}

// What moving a branch means now: "publish", "push", "pull", "sync", or null.
export function syncAction(b) {
  if (!b?.name || !b.commits) return null;
  if (!b.upstream) return b.remote ? "publish" : null;
  return b.ahead && b.behind ? "sync" : b.ahead ? "push" : b.behind ? "pull" : null;
}

export const fetchRemotes = (repo) => net(repo, ["fetch", "--quiet"], FETCH).catch(() => null);

const commits = (n) => `${n} ${n === 1 ? "commit" : "commits"}`;

// git's own reason, without its hints: the error or rejection, else its last word.
function reason(r) {
  const lines = `${r.stderr}\n${r.stdout}`.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("hint:"));
  return lines.find((l) => /^(fatal|error):|\[rejected\]/.test(l)) ?? lines.at(-1) ?? "git failed";
}

// Runs an action on branch b; resolves with what to say, or throws git's reason.
export async function runSync(repo, action, b) {
  const step = async (args) => {
    const r = await net(repo, args);
    if (r.code !== 0) throw new Error(reason(r));
  };
  if (action === "publish") { await step(["push", "-u", b.remote, "HEAD"]); return `Published ${b.name} to ${b.remote}`; }
  if (action === "push") { await step(["push"]); return `Pushed ${commits(b.ahead)} to ${b.upstream}`; }
  if (action === "pull") { await step(["pull", "--ff-only"]); return `Pulled ${commits(b.behind)} from ${b.upstream}`; }
  try { await step(["pull", "--rebase", "--autostash"]); }
  catch (e) {
    const undone = await net(repo, ["rebase", "--abort"], FETCH).catch(() => null);
    throw new Error(undone?.code === 0 ? `${e.message} (rebase undone: pull in a terminal to resolve)` : e.message);
  }
  await step(["push"]);
  return `Synced with ${b.upstream}: ↓${b.behind} ↑${b.ahead}`;
}
