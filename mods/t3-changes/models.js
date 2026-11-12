// Model discovery, after Orca: each CLI it knows lists its own models, with
// the effort levels each takes and which one its config runs by default. The
// listings are kept in shared state (MODELS_KEY, by program) and refreshed on
// demand, so the picker and the chip can name models without asking again.

import { exec, shared, setShared } from "herdr";

export const MODELS_KEY = "t3.commit.models";
const STALE = 24 * 3600 * 1000;

const CLAUDE_LIST = `printf '%s\\n' '{"type":"control_request","request_id":"t3","request":{"subtype":"list_models"}}' | claude -p --input-format stream-json --output-format stream-json --verbose --strict-mcp-config --settings '{"disableAllHooks":true}'`;

// `codex app-server` answers model/list over JSON-RPC on stdio, page by page,
// and keeps running: read until the listing ends, then stop it.
const CODEX_LIST = `
import json, subprocess
p = subprocess.Popen(["codex", "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
def send(m):
    p.stdin.write(json.dumps(m) + "\\n"); p.stdin.flush()
send({"method": "initialize", "id": 0, "params": {"clientInfo": {"name": "t3_changes", "title": "t3-changes", "version": "0"}}})
send({"method": "initialized"})
send({"method": "model/list", "id": 1, "params": {"limit": 100, "includeHidden": False}})
rows = []
for line in p.stdout:
    try: d = json.loads(line)
    except ValueError: continue
    if d.get("id", 0) < 1: continue
    r = d.get("result") or {}
    rows += r.get("data") or []
    if not r.get("nextCursor") or d["id"] > 10: break
    send({"method": "model/list", "id": d["id"] + 1, "params": {"limit": 100, "includeHidden": False, "cursor": r["nextCursor"]}})
p.kill()
print(json.dumps(rows))
`;

const words = (s) => s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
export const effortLabel = (e) => e === "xhigh" ? "Extra high" : words(e);

// Each parser answers { models: [{ id, label, detail?, efforts }], default?: { label, efforts } }.
const DISCOVERY = {
  claude: {
    run: () => exec("sh", ["-c", CLAUDE_LIST], { timeout: 20000 }),
    parse(out) {
      let rows = [];
      for (const line of out.split("\n")) {
        try { const d = JSON.parse(line); if (d.type === "control_response") rows = d.response?.response?.models ?? []; } catch {}
      }
      rows = rows.filter((m) => m.value && !m.disabled);
      const fallback = rows.find((m) => m.value === "default");
      return {
        models: rows.filter((m) => m !== fallback).map((m) => ({ id: m.value, label: m.displayName || m.value, detail: m.description, efforts: m.supportedEffortLevels ?? [] })),
        default: fallback && { label: /currently ([^)]+)/.exec(fallback.description ?? "")?.[1] ?? "", efforts: fallback.supportedEffortLevels ?? [] },
      };
    },
  },
  codex: {
    run: () => exec("python3", ["-c", CODEX_LIST], { timeout: 40000 }),
    parse(out) {
      const rows = JSON.parse(out.trim().split("\n").pop() || "[]").filter((m) => m.id && !m.hidden);
      const models = rows.map((m) => ({ id: m.id, label: m.displayName || m.id, detail: m.description, efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort) }));
      const fallback = rows.find((m) => m.isDefault);
      return { models, default: fallback && { label: fallback.displayName || fallback.id, efforts: models.find((m) => m.id === fallback.id).efforts } };
    },
  },
  // pi prints a table (provider, model, context, max-out, thinking, images); its
  // default is in its settings, so they come after a marker line.
  pi: {
    run: () => exec("sh", ["-c", 'pi --list-models; echo "@@settings"; cat "$HOME/.pi/agent/settings.json" 2>/dev/null'], { timeout: 20000 }),
    parse(out) {
      const [table, json] = out.split("@@settings");
      const thinking = ["off", "minimal", "low", "medium", "high", "xhigh"];
      const models = table.split("\n").map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 6 && f[0] !== "provider")
        .map(([provider, model, context, , think]) => ({ id: `${provider}/${model}`, label: model.split("/").pop(), detail: `${provider} · ${context} context`, efforts: think === "yes" ? thinking : [] }));
      let s = {};
      try { s = JSON.parse(json); } catch {}
      const id = s.defaultModel && (s.defaultProvider ? `${s.defaultProvider}/${s.defaultModel}` : s.defaultModel);
      const hit = models.find((m) => m.id === id);
      return { models, default: id && { label: hit?.label ?? id.split("/").pop(), efforts: hit?.efforts ?? thinking } };
    },
  },
  opencode: {
    run: () => exec("opencode", ["models"], { timeout: 30000 }),
    parse(out) {
      const models = out.split("\n").map((l) => l.trim()).filter((l) => l.includes("/") && !/\s/.test(l))
        .map((id) => ({ id, label: id.split("/").slice(1).join("/"), detail: id.split("/")[0], efforts: [] }));
      return { models };
    },
  },
};

export const discoverable = (bin) => Boolean(DISCOVERY[bin]);
export const listing = (bin) => shared(MODELS_KEY)?.[bin] ?? null;

const running = new Set();
export const discovering = (bin) => running.has(bin);

// Lists a program's models unless a fresh listing is kept (force: list anyway).
export function discover(bin, cx, force = false) {
  const kept = listing(bin);
  if (!DISCOVERY[bin] || running.has(bin) || (!force && kept && !kept.error && Date.now() - kept.at < STALE)) return;
  running.add(bin);
  cx.notify();
  cx.spawn(async (cx) => {
    let entry;
    try {
      const r = await DISCOVERY[bin].run();
      const parsed = DISCOVERY[bin].parse(r.stdout ?? "");
      if (!parsed.models.length) throw new Error((r.stderr || "").trim().split("\n").pop() || "no models listed");
      entry = { at: Date.now(), ...parsed };
    } catch (e) { entry = { ...(kept ?? { models: [] }), at: Date.now(), error: String(e.message ?? e) }; }
    running.delete(bin);
    setShared(MODELS_KEY, { ...(shared(MODELS_KEY) ?? {}), [bin]: entry });
    cx.notify();
  });
}

// What an agent's model reads as: the listed name, or the CLI default and what it is.
export function modelName(agent) {
  const m = agent.model?.trim(), l = listing(agent.bin);
  if (m) return l?.models.find((x) => x.id === m)?.label ?? m;
  return l?.default?.label || "";
}

// The effort levels the agent's model takes (empty: none known).
export function effortsOf(agent, model = agent.model) {
  const l = listing(agent.bin), m = model?.trim();
  return (m ? l?.models.find((x) => x.id === m)?.efforts : l?.default?.efforts) ?? [];
}
