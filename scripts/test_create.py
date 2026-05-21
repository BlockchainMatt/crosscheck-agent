#!/usr/bin/env python3
"""Offline tests for `create` and `create_cheap`.

Stubs the HTTP layer so the full pipeline runs end-to-end without network:
  ingest -> confer -> orchestrate -> review -> audit (+ optional retry).

Covers:
  - documents: local file is read + hashed + truncated; URL is fetched
  - happy path: status=success, all phases ran, single session_id, usage rolled up
  - audit failure -> retry once (attempts==2)
  - create_cheap suppresses retry even on audit failure
  - target_path writes the final to disk (unless dry_run)
  - skip_audit / skip_review honoured
  - all sub-call usage rolls into the macro's `usage`/`timing` totals

Exit 0 on success.
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
        "openai":    {"gpt-test-low":  {"prompt_per_1k": 0.0001, "completion_per_1k": 0.0003, "cached_per_1k": 0.00005}},
        "anthropic": {"claude-test-mid":{"prompt_per_1k": 0.003,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0003}},
        "xai":       {"grok-test-high": {"prompt_per_1k": 0.005,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0025}},
        "gemini":    {"gemini-test":    {"prompt_per_1k": 0.001,  "completion_per_1k": 0.003,  "cached_per_1k": 0.0001}},
        "_tiers": {
            "low":  {"models": [{"provider": "openai",    "model": "gpt-test-low"}]},
            "med":  {"models": [{"provider": "anthropic", "model": "claude-test-mid"}]},
            "high": {"models": [{"provider": "xai",       "model": "grok-test-high"}]},
        },
    }))
    os.environ["CROSSCHECK_PRICING_PATH"] = str(pricing)

    import crosscheck_server as srv

    srv.CFG = dict(srv.CFG)
    srv.CFG["session_db"] = str(tmp / "sessions.db")
    srv.CFG["transcript_dir"] = str(tmp / "transcripts")
    srv.CFG["cache"] = {"enabled": False}
    srv.CFG["fetch"] = {"url_allowlist": ["https://example.test/"]}
    srv.TRANSCRIPT_DIR = Path(srv.CFG["transcript_dir"])
    srv._DB_INIT_DONE = False
    srv._PRICING_CACHE = None
    srv.PRICING_PATH = pricing

    srv.ENV = dict(srv.ENV)
    srv.ENV["OPENAI_API_KEY"] = "stub"; srv.ENV["OPENAI_MODEL"] = "gpt-test-low"
    srv.ENV["ANTHROPIC_API_KEY"] = "stub"; srv.ENV["ANTHROPIC_MODEL"] = "claude-test-mid"
    srv.ENV["XAI_API_KEY"] = "stub"; srv.ENV["XAI_MODEL"] = "grok-test-high"
    srv.ENV["GEMINI_API_KEY"] = "stub"; srv.ENV["GEMINI_MODEL"] = "gemini-test"
    all_built = srv.build_providers()
    srv.ALL_PROVIDERS = {n: p for n, p in all_built.items()
                         if n in {"openai", "anthropic", "xai", "gemini"}}
    srv.CFG["providers"] = ["openai", "anthropic", "xai"]
    srv.CFG["moderator"] = "anthropic"

    # ----- HTTP stubs -----------------------------------------------------
    # State knobs the tests toggle to vary behavior between calls.
    state = {
        "anthropic_audit_score": 0.95,   # default audit pass
        "audit_call_count": 0,
        "anthropic_dag_node_count": 2,
    }

    def _request_text(body: dict) -> str:
        """Return a single string with all relevant prompt content for heuristics."""
        parts: list[str] = []
        if isinstance(body.get("messages"), list):
            for m in body["messages"]:
                if isinstance(m, dict) and isinstance(m.get("content"), str):
                    parts.append(m["content"])
        if isinstance(body.get("system"), str):
            parts.append(body["system"])
        if isinstance(body.get("contents"), list):  # Gemini shape
            for c in body["contents"]:
                for p in (c.get("parts") or []):
                    if isinstance(p.get("text"), str):
                        parts.append(p["text"])
        if isinstance((body.get("systemInstruction") or {}).get("parts"), list):
            for p in body["systemInstruction"]["parts"]:
                if isinstance(p.get("text"), str):
                    parts.append(p["text"])
        return "\n".join(parts)

    def _classify(body: dict) -> str:
        txt = _request_text(body)
        if "RUBRIC ITEMS:" in txt or "Score the OUTPUT against each rubric" in txt:
            return "audit"
        if "Decompose the goal into a small DAG" in txt:
            return "dag"
        return "plain"

    def _audit_response_obj() -> dict:
        score = state["anthropic_audit_score"]
        items = [{"id": rid, "score": score, "pass": score >= 0.7,
                  "rationale": f"audit:{rid}"}
                 for rid in [r["id"] for r in srv.DEFAULT_AUDIT_RUBRICS]]
        return {"items": items, "overall_score": score}

    def _dag_response_obj() -> dict:
        n = state["anthropic_dag_node_count"]
        return {"summary": "test dag",
                "nodes": [{"id": f"n{i}", "task": f"task {i}", "difficulty": "low"}
                          for i in range(1, n + 1)]}

    def fake_post(url, headers, body, timeout):
        kind = _classify(body)
        if kind == "audit":
            state["audit_call_count"] += 1
        # Build per-provider responses, JSON-shaped when the prompt asks for JSON.
        text_for_plain = (
            "openai-out"  if "openai.com" in url else
            "xai-out"     if "x.ai" in url else
            "gemini-out"  if "googleapis.com" in url else
            "anthropic-final"
        )
        text_for_json = json.dumps(
            _audit_response_obj() if kind == "audit" else _dag_response_obj()
        )
        text = text_for_plain if kind == "plain" else text_for_json

        if "openai.com" in url:
            return {"choices": [{"message": {"content": text}}],
                    "usage": {"prompt_tokens": 30, "completion_tokens": 12, "total_tokens": 42}}
        if "x.ai" in url:
            return {"choices": [{"message": {"content": text}}],
                    "usage": {"prompt_tokens": 28, "completion_tokens": 10, "total_tokens": 38}}
        if "googleapis.com" in url:
            return {"candidates": [{"content": {"parts": [{"text": text}]}}],
                    "usageMetadata": {"promptTokenCount": 25, "candidatesTokenCount": 8,
                                       "totalTokenCount": 33}}
        if "anthropic.com" in url:
            return {"content": [{"type": "text", "text": text}],
                    "usage": {"input_tokens": 60, "output_tokens": 25}}
        return {}

    def fake_post_resilient(url, headers, body, timeout, deadline):
        return fake_post(url, headers, body, timeout), 1

    srv._http_post = fake_post
    srv._http_post_resilient = fake_post_resilient

    # ----- 1) Documents: ingest a local file + verify hash/truncation -----
    doc_path = tmp / "spec.md"
    # Need > _CREATE_DOC_MAX_BYTES (32 KiB) to exercise the truncation path.
    doc_path.write_text("rule_42: every feature must be auditable.\n" * 2000)
    descriptors, _fetches = srv._ingest_documents([str(doc_path)], "ingest-test")
    assert len(descriptors) == 1 and descriptors[0]["status"] == "ok"
    assert descriptors[0]["hash"] and len(descriptors[0]["hash"]) == 64
    assert descriptors[0]["truncated"] is True, "should truncate large file"
    assert len(descriptors[0]["content"]) <= srv._CREATE_DOC_MAX_BYTES

    # Missing file -> error descriptor, never crashes
    bad = srv._ingest_documents(["/no/such/file.md"], "ingest-test")[0]
    assert bad[0]["status"] == "error"

    # ----- 2) Happy path: create() runs full pipeline ---------------------
    res = srv.tool_create({
        "instruction": "Tie all features in the project to rules in the docs.",
        "providers":   ["openai", "anthropic", "xai"],
        "documents":   [str(doc_path)],
        "session_id":  "create-ok",
    })
    assert res.get("tool") == "create" and res.get("status") == "success", res.get("status")
    assert res["attempts"] == 1, res["attempts"]
    assert res["documents_ingested"][0]["status"] == "ok"
    assert res["scope_summary"]                       # confer scope ran
    assert res["dag"] and res["dag"].get("nodes")     # orchestrate planner ran
    assert res["nodes"] and all(n["status"] == "ok" for n in res["nodes"])
    assert res["final"]                                # recombine produced text
    assert res["review"] is not None                  # review ran
    assert res["audit"] is not None                   # audit ran
    assert res["audit"]["overall_score"] == 0.95
    # All usage rolled up under one session_id.
    by_purpose = sorted({c["purpose"] for c in res["usage"]["by_call"]})
    assert "confer" in by_purpose and "audit" in by_purpose, by_purpose
    assert res["usage"]["totals"]["calls"] >= 4   # confer x2 + orchestrate + review x2 + synth + audit
    # session row carries cumulative cost
    with srv._db_conn() as conn:
        row = conn.execute("SELECT total_cost_usd, total_tokens, total_cpu_ms "
                           "FROM sessions WHERE session_id = ?", ("create-ok",)).fetchone()
        assert row["total_tokens"] > 0 and row["total_cost_usd"] > 0, dict(row)
    # purpose='audit' shows up in usage_log
    with srv._db_conn() as conn:
        n = conn.execute("SELECT COUNT(*) FROM usage_log WHERE session_id=? AND purpose='audit'",
                         ("create-ok",)).fetchone()[0]
        assert n == 1, n

    # ----- 3) Audit failure -> retry once (attempts == 2) -----------------
    state["anthropic_audit_score"] = 0.45      # below default threshold 0.7
    state["audit_call_count"] = 0
    res2 = srv.tool_create({
        "instruction": "Same instruction, audit will fail first time.",
        "providers":   ["openai", "anthropic", "xai"],
        "session_id":  "create-retry",
    })
    assert res2["attempts"] == 2, res2["attempts"]
    assert state["audit_call_count"] == 2, state["audit_call_count"]
    # Score didn't recover -> status reflects that.
    assert res2["status"] == "audit_failed_after_retry", res2["status"]

    # ----- 4) Audit failure on create_cheap -> NO retry -------------------
    state["anthropic_audit_score"] = 0.45
    state["audit_call_count"] = 0
    res3 = srv.tool_create_cheap({
        "instruction": "cheap path, audit fails, no retry.",
        "providers":   ["openai", "anthropic", "xai"],
        "session_id":  "create-cheap-no-retry",
    })
    assert res3["attempts"] == 1, res3["attempts"]
    assert state["audit_call_count"] == 1, state["audit_call_count"]
    assert res3["status"] == "audit_failed", res3["status"]
    assert res3["cheap_mode"] is True

    # ----- 5) target_path writes the final to disk ------------------------
    state["anthropic_audit_score"] = 0.9   # passes -> writes
    state["audit_call_count"] = 0
    out_path = tmp / "out" / "deliverable.md"
    res4 = srv.tool_create({
        "instruction": "write the deliverable",
        "providers":   ["openai", "anthropic", "xai"],
        "session_id":  "create-write",
        "target_path": str(out_path),
    })
    assert res4["status"] == "success"
    assert out_path.exists(), "expected target_path to be written"
    assert out_path.read_text() == res4["final"]
    assert any(a["path"] == str(out_path) for a in res4["artifacts"])

    # ----- 6) dry_run -> never writes -------------------------------------
    out_path2 = tmp / "out2" / "deliverable.md"
    res5 = srv.tool_create({
        "instruction": "dry run",
        "providers":   ["openai", "anthropic", "xai"],
        "target_path": str(out_path2),
        "dry_run":     True,
    })
    assert not out_path2.exists()
    assert any("dry_run" in w for w in res5["warnings"])

    # ----- 7) skip_audit / skip_review ------------------------------------
    state["audit_call_count"] = 0
    res6 = srv.tool_create({
        "instruction": "skip both",
        "providers":   ["openai", "anthropic", "xai"],
        "skip_audit":  True,
        "skip_review": True,
        "session_id":  "create-skip-all",
    })
    assert res6["audit"] is None and res6["review"] is None, res6
    assert state["audit_call_count"] == 0
    assert res6["status"] == "success"

    # ----- 8) Retry preserves first-attempt usage in the macro envelope ---
    # Session totals (in SQLite) include both attempts because each sub-tool
    # logs its own usage_log rows. The macro's top-level `usage.totals.calls`
    # must match — i.e. it must include calls from both orchestrate attempts.
    state["anthropic_audit_score"] = 0.4
    state["audit_call_count"] = 0
    res7 = srv.tool_create({
        "instruction": "audit retry usage rollup",
        "providers":   ["openai", "anthropic", "xai"],
        "session_id":  "create-retry-usage",
    })
    assert res7["attempts"] == 2
    macro_calls = res7["usage"]["totals"]["calls"]
    # Confer (2) + orchestrate-1 (≥3) + orchestrate-2 (≥3) + review (2) + audit-1 + audit-2 = ≥12
    assert macro_calls >= 10, f"expected >=10 rolled-up calls, got {macro_calls}"
    with srv._db_conn() as conn:
        n_audit_rows = conn.execute(
            "SELECT COUNT(*) FROM usage_log WHERE session_id = ? AND purpose = 'audit'",
            ("create-retry-usage",)).fetchone()[0]
        assert n_audit_rows == 2, f"expected 2 audit usage_log rows, got {n_audit_rows}"

    # ----- 9) audit_inconclusive when auditor returns None overall --------
    # Auditor returns malformed JSON -> _request_structured returns None obj
    # -> overall_score is None.
    state["anthropic_audit_score"] = 0.9  # not used because we'll intercept
    state["audit_call_count"] = 0
    orig_post = srv._http_post_resilient

    def inconclusive_post(url, headers, body, timeout, deadline):
        if _classify(body) == "audit":
            state["audit_call_count"] += 1
            # Return plain text — auditor JSON parse fails -> overall=None
            payload = {"content": [{"type": "text", "text": "not-json"}],
                       "usage": {"input_tokens": 40, "output_tokens": 10}}
            return payload, 1
        return orig_post(url, headers, body, timeout, deadline)

    srv._http_post_resilient = inconclusive_post
    res8 = srv.tool_create({
        "instruction": "inconclusive audit",
        "providers":   ["openai", "anthropic", "xai"],
        "session_id":  "create-inconclusive",
    })
    srv._http_post_resilient = orig_post
    assert res8["status"] == "audit_inconclusive", res8["status"]
    assert res8["attempts"] == 1, "inconclusive must NOT trigger retry"

    print("OK: test_create")
    return 0


if __name__ == "__main__":
    sys.exit(main())
