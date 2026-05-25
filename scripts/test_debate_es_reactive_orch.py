#!/usr/bin/env python3
"""Offline tests for PR 16:
  A. Early-stop on debate
  B. Reactive orchestrate (add_node signals only)
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(here / "servers" / "python"))

    tmp = Path(tempfile.mkdtemp())
    pricing = tmp / "pricing.json"
    pricing.write_text(json.dumps({
        "openai":    {"gpt-test":   {"prompt_per_1k": 0.0001, "completion_per_1k": 0.0003, "cached_per_1k": 0.00005}},
        "anthropic": {"claude-test":{"prompt_per_1k": 0.003,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0003}},
        "xai":       {"grok-test":  {"prompt_per_1k": 0.005,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0025}},
        "_tiers": {
            "low":  {"models": [{"provider": "openai",    "model": "gpt-test"}]},
            "med":  {"models": [{"provider": "anthropic", "model": "claude-test"}]},
            "high": {"models": [{"provider": "xai",       "model": "grok-test"}]},
        },
    }))
    os.environ["CROSSCHECK_PRICING_PATH"] = str(pricing)

    import crosscheck_server as srv

    srv.CFG = dict(srv.CFG)
    srv.CFG["session_db"]     = str(tmp / "sessions.db")
    srv.CFG["transcript_dir"] = str(tmp / "transcripts")
    srv.CFG["cache"]          = {"enabled": False}
    srv.CFG["node_cache"]     = {"enabled": False}
    srv.TRANSCRIPT_DIR        = Path(srv.CFG["transcript_dir"])
    srv._DB_INIT_DONE         = False
    srv._PRICING_CACHE        = None
    srv.PRICING_PATH          = pricing

    srv.ENV = dict(srv.ENV)
    srv.ENV["OPENAI_API_KEY"]    = "stub"; srv.ENV["OPENAI_MODEL"]    = "gpt-test"
    srv.ENV["ANTHROPIC_API_KEY"] = "stub"; srv.ENV["ANTHROPIC_MODEL"] = "claude-test"
    srv.ENV["XAI_API_KEY"]       = "stub"; srv.ENV["XAI_MODEL"]       = "grok-test"
    all_built = srv.build_providers()
    srv.ALL_PROVIDERS = {n: p for n, p in all_built.items()
                         if n in {"openai", "anthropic", "xai"}}
    srv.CFG["providers"] = ["openai", "anthropic", "xai"]
    srv.CFG["moderator"] = "anthropic"

    # ------------------------------------------------------------------
    # Shared HTTP stub. Workers/critics return plain text; the agreement
    # judge (which uses anthropic via _check_panel_agreement) returns the
    # JSON dictated by `state["agreement"]`.
    # ------------------------------------------------------------------
    state = {"agreement": {"agreed": True, "confidence": 0.9, "summary": "agreed"}}
    state["worker_outputs"] = {}    # node_id -> output (for reactive test)

    def _is_agreement(body):
        parts = []
        for m in body.get("messages") or []:
            if isinstance(m.get("content"), str): parts.append(m["content"])
        if isinstance(body.get("system"), str): parts.append(body["system"])
        return "agreement checker" in "\n".join(parts)

    def _is_dag_planner(body):
        parts = []
        for m in body.get("messages") or []:
            if isinstance(m.get("content"), str): parts.append(m["content"])
        return "orchestration DAGs as JSON" in "\n".join(parts)

    def _is_worker(body):
        parts = []
        for m in body.get("messages") or []:
            if isinstance(m.get("content"), str): parts.append(m["content"])
        if isinstance(body.get("system"), str): parts.append(body["system"])
        return "worker LLM in an orchestrated DAG" in "\n".join(parts)

    def _worker_task_text(body) -> str:
        """Pull the literal task text from the worker's user message
        (everything after the final `TASK:\\n`). Used by the stub to look
        up canned outputs keyed by task text."""
        parts = []
        for m in body.get("messages") or []:
            if isinstance(m.get("content"), str): parts.append(m["content"])
        for c in body.get("contents") or []:
            for p in (c.get("parts") or []):
                if isinstance(p.get("text"), str): parts.append(p["text"])
        full = "\n".join(parts)
        if "TASK:\n" in full:
            after = full.rsplit("TASK:\n", 1)[1]
            return after.strip()
        return ""

    def fake_post(url, headers, body, timeout):
        text = "ok"
        if _is_agreement(body):
            text = json.dumps(state["agreement"])
        elif _is_dag_planner(body):
            text = json.dumps({"summary": "tiny",
                               "nodes": [
                                   {"id": "n1", "task": "first task",  "difficulty": "low"},
                                   {"id": "n2", "task": "second task", "difficulty": "low",
                                    "depends_on": ["n1"]},
                               ]})
        elif _is_worker(body):
            # Look up canned output by task text.
            task = _worker_task_text(body)
            if task in state["worker_outputs"]:
                text = state["worker_outputs"][task]
            else:
                text = f"worker output for {task!r}"
        if "openai" in url:
            return {"choices": [{"message": {"content": text}}],
                    "usage": {"prompt_tokens": 30, "completion_tokens": 10}}
        if "anthropic" in url:
            return {"content": [{"type": "text", "text": text}],
                    "usage": {"input_tokens": 30, "output_tokens": 10}}
        if "x.ai" in url:
            return {"choices": [{"message": {"content": text}}],
                    "usage": {"prompt_tokens": 30, "completion_tokens": 10}}
        return {}

    def fake_post_resilient(url, headers, body, timeout, deadline):
        return fake_post(url, headers, body, timeout), 1
    srv._http_post = fake_post
    srv._http_post_resilient = fake_post_resilient

    # ------------------------------------------------------------------
    # A) Early-stop on debate
    # ------------------------------------------------------------------
    # Agreement above threshold by round 1 -> stops early (rounds_completed
    # will be 1 but rounds_skipped == max_rounds - 1).
    state["agreement"] = {"agreed": True, "confidence": 0.95, "summary": "they agree"}
    res = srv.tool_debate({
        "topic":       "round-stopping",
        "providers":   ["openai", "anthropic", "xai"],
        "max_rounds":  3,
        "early_stop":  True,
    })
    assert res.get("early_stopped") is True, res
    assert res["early_stopped_round"] == 1, res
    assert res["rounds_skipped"] == 2
    # Transcript only contains round 1 turns
    assert all(e["round"] == 1 for e in res["transcript"]), \
        [e["round"] for e in res["transcript"]]

    # Disagreement -> runs all rounds
    state["agreement"] = {"agreed": False, "confidence": 0.99, "summary": "they disagree"}
    res = srv.tool_debate({
        "topic":       "no stop",
        "providers":   ["openai", "anthropic", "xai"],
        "max_rounds":  3,
        "early_stop":  True,
    })
    assert res.get("early_stopped") is False, res
    assert res.get("rounds_skipped") == 0
    # All 3 rounds completed
    rounds_seen = {e["round"] for e in res["transcript"]}
    assert rounds_seen == {1, 2, 3}, rounds_seen

    # Low confidence -> no stop
    state["agreement"] = {"agreed": True, "confidence": 0.4, "summary": "weak"}
    res = srv.tool_debate({
        "topic":               "low confidence",
        "providers":           ["openai", "anthropic", "xai"],
        "max_rounds":          2,
        "early_stop":          True,
        "early_stop_threshold": 0.7,
    })
    assert res.get("early_stopped") is False
    rounds_seen = {e["round"] for e in res["transcript"]}
    assert rounds_seen == {1, 2}

    # ------------------------------------------------------------------
    # B) Reactive orchestrate (add_node signals)
    # ------------------------------------------------------------------
    # n1 emits one valid add_node signal: a new node "n3" depending on n1.
    state["worker_outputs"] = {
        "first task": ("first task complete.\n"
               "<signals>{\"add_nodes\": [{\"id\": \"n3\", \"task\": \"new reactive task\","
               " \"difficulty\": \"low\", \"depends_on\": [\"n1\"]}]}</signals>"),
        "second task":      "second task complete.",
        "new reactive task":"reactive task complete.",
    }
    # Non-reactive run: signal block is in n1's output but is ignored.
    res = srv.tool_orchestrate({
        "dag": {"summary": "tiny",
                "nodes": [
                    {"id": "n1", "task": "first task",  "difficulty": "low"},
                    {"id": "n2", "task": "second task", "difficulty": "low",
                     "depends_on": ["n1"]},
                ]},
        "providers": ["openai", "anthropic", "xai"],
        "reactive":  False,
    })
    node_ids = sorted(n["id"] for n in res["nodes"])
    assert node_ids == ["n1", "n2"], node_ids
    assert "reactive_applied" not in res

    # Reactive ON: same signal is parsed + accepted + a third node runs.
    res = srv.tool_orchestrate({
        "dag": {"summary": "tiny",
                "nodes": [
                    {"id": "n1", "task": "first task",  "difficulty": "low"},
                    {"id": "n2", "task": "second task", "difficulty": "low",
                     "depends_on": ["n1"]},
                ]},
        "providers": ["openai", "anthropic", "xai"],
        "reactive":  True,
    })
    node_ids = sorted(n["id"] for n in res["nodes"])
    assert node_ids == ["n1", "n2", "n3"], node_ids
    assert res["reactive"] is True
    assert len(res["reactive_applied"]) == 1
    accepted = res["reactive_applied"][0]
    assert accepted["source_node"] == "n1"
    assert accepted["node"]["id"] == "n3"
    n3 = next(n for n in res["nodes"] if n["id"] == "n3")
    assert n3["status"] == "ok"
    assert "reactive task complete." in (n3.get("output") or "")

    # Reactive node with bad deps (deps on pending/unknown node) is rejected.
    state["worker_outputs"] = {
        "first task": ("first task complete.\n"
               "<signals>{\"add_nodes\": [{\"id\": \"nope\", \"task\": \"bad deps\","
               " \"difficulty\": \"low\", \"depends_on\": [\"does_not_exist\"]}]}</signals>"),
        "second task": "second task complete.",
    }
    res = srv.tool_orchestrate({
        "dag": {"summary": "tiny",
                "nodes": [
                    {"id": "n1", "task": "first task",  "difficulty": "low"},
                    {"id": "n2", "task": "second task", "difficulty": "low",
                     "depends_on": ["n1"]},
                ]},
        "providers": ["openai", "anthropic", "xai"],
        "reactive":  True,
    })
    assert len(res["reactive_applied"]) == 0
    assert len(res["reactive_rejected"]) == 1
    assert "deps" in res["reactive_rejected"][0]["reason"]
    # No "nope" node should have run.
    assert "nope" not in [n["id"] for n in res["nodes"]]

    # max_reactive_signals cap: emit 3 signals, cap=2 -> only 2 accepted.
    state["worker_outputs"] = {
        "first task": ("first task complete.\n"
               "<signals>{\"add_nodes\": ["
               "  {\"id\": \"r1\", \"task\": \"react one\",   \"difficulty\": \"low\", \"depends_on\": [\"n1\"]},"
               "  {\"id\": \"r2\", \"task\": \"react two\",   \"difficulty\": \"low\", \"depends_on\": [\"n1\"]},"
               "  {\"id\": \"r3\", \"task\": \"react three\", \"difficulty\": \"low\", \"depends_on\": [\"n1\"]}"
               "]}</signals>"),
        "second task": "second task complete.",
        "react one": "r1 done", "react two": "r2 done", "react three": "r3 done",
    }
    res = srv.tool_orchestrate({
        "dag": {"summary": "tiny",
                "nodes": [
                    {"id": "n1", "task": "first task",  "difficulty": "low"},
                    {"id": "n2", "task": "second task", "difficulty": "low",
                     "depends_on": ["n1"]},
                ]},
        "providers":            ["openai", "anthropic", "xai"],
        "reactive":             True,
        "max_reactive_signals": 2,
    })
    assert len(res["reactive_applied"]) == 2
    # The third was rejected with the cap reason.
    assert len(res["reactive_rejected"]) == 1
    assert "max_reactive_signals" in res["reactive_rejected"][0]["reason"]

    print("OK: test_debate_es_reactive_orch")
    return 0


if __name__ == "__main__":
    sys.exit(main())
