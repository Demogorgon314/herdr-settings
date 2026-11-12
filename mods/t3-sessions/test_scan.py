"""Exercise the embedded scanner against isolated Codex records."""
import contextlib
import io
import json
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch


SCAN = re.search(r"const SCAN = String.raw`(.*?)`;", Path(__file__).with_name("main.js").read_text(), re.S)[1]


class CodexScanTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix=".scan-test-", dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name).resolve()
        self.env = patch.dict(os.environ, {"HOME": str(self.home)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def rollout(self, ident, *messages, archived=False, name=None, **meta):
        root = self.home / ".codex" / ("archived_sessions" if archived else "sessions/2026/11/12")
        root.mkdir(parents=True, exist_ok=True)
        path = root / (name or f"rollout-{ident}.jsonl")
        head = {"type": "session_meta", "payload": {"id": ident, "cwd": "/work/project", **meta}}
        path.write_text("\n".join(json.dumps(o) for o in (head, *messages)) + "\n")
        return path

    def user(self, *texts, kinds=None):
        payload = {"role": "user", "content": [{"type": "input_text", "text": t} for t in texts]}
        if kinds is not None:
            payload["internal_chat_message_metadata_passthrough"] = {"content_item_kinds": kinds}
        return {"type": "response_item", "payload": payload}

    def scan(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exec(compile(SCAN, "<SCAN>", "exec"), {})
        return json.loads(output.getvalue())

    def test_missing_codex_is_empty(self):
        self.assertEqual(self.scan(), [])

    def test_latest_index_name_wins_and_bad_lines_do_not_hide_sessions(self):
        path = self.rollout("named", self.user("fallback"))
        index = self.home / ".codex/session_index.jsonl"
        index.write_text('{"id":"named","thread_name":"Old"}\ninvalid\n'
                         '{"id":"named","thread_name":"Renamed thread"}\n')
        rows = self.scan()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["title"], "Renamed thread")
        self.assertEqual(rows[0]["file"], path.name)
        self.assertEqual(rows[0]["cwd"], "/work/project")
        self.assertEqual(rows[0]["agent"], "codex")

    def test_injected_items_are_skipped_but_human_xml_is_kept(self):
        self.rollout("prompt",
                     self.user("# AGENTS.md instructions\n<INSTRUCTIONS>rules</INSTRUCTIONS>"),
                     self.user("<user_instructions>rules</user_instructions>"),
                     self.user("<environment_context>cwd</environment_context>",
                               "<question>Fix the build</question>"))
        self.assertEqual(self.scan()[0]["title"], "<question>Fix the build</question>")

    def test_structural_provenance_overrides_text_markers(self):
        self.rollout("annotated", self.user("Unmarked injected context", "<skill>Explain this</skill>",
                                            kinds=["context.instructions", "user.text"]))
        self.assertEqual(self.scan()[0]["title"], "<skill>Explain this</skill>")

    def test_exec_and_user_forks_are_kept_children_and_archives_are_skipped(self):
        self.rollout("exec", self.user("Review"), source="exec", originator="codex_exec")
        self.rollout("fork", self.user("Continue"), forked_from_id="parent", source="cli")
        self.rollout("child", parent_thread_id="parent")
        self.rollout("spawn", source={"subagent": {"thread_spawn": {"agent_path": "/root/child"}}})
        self.rollout("legacy", thread_source="subagent")
        self.rollout("archived", archived=True)
        self.assertEqual({r["id"] for r in self.scan()}, {"exec", "fork"})

    def test_revert_lists_only_newest_rollout_of_thread(self):
        old = self.rollout("thread", self.user("Before revert"), name="rollout-old.jsonl")
        new = self.rollout("thread", self.user("After revert"), name="rollout-new.jsonl")
        os.utime(old, (1, 1))
        os.utime(new, (2, 2))
        rows = self.scan()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["title"], "After revert")
        self.assertEqual(rows[0]["file"], new.name)

    def test_fallback_stops_after_prompt_and_caps_empty_rollout_reads(self):
        self.rollout("early", self.user("First prompt"), self.user("Later prompt"))
        path = self.rollout("large")
        with path.open("a") as f:
            f.write(json.dumps({"type": "response_item", "payload": {"role": "assistant", "content": "x" * (1024 * 1024)}}) + "\n")
            f.write(json.dumps(self.user("Beyond probe budget")) + "\n")
        rows = {r["id"]: r for r in self.scan()}
        self.assertEqual(rows["early"]["title"], "First prompt")
        self.assertEqual(rows["large"]["title"], "")


if __name__ == "__main__":
    unittest.main()
