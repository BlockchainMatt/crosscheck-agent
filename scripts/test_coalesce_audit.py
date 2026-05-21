#!/usr/bin/env python3
"""Offline tests for the coalesce-audit upgrade + run_summary.

Covers:
  - run_summary attached to every multi-LLM tool response; shape correct;
    session-scope vs call-scope; ASCII text rendering.
  - audit coalesce mode: parallel dispatch, median score, majority pass-vote,
    strict_mode all-must-pass; per-judge breakdown.
  - obvious_failure: high-severity item where ANY judge scored < 0.3 flags
    item.flags=['obvious_failure'], surfaces in top-level obvious_failures.
  - obvious_failure: med-severity at threshold 0.2.
  - disagreement: stddev > 0.3 for N>=3; range > 0.4 for N==2.
  - audit_process_failure: when < ceil(N/2) judges return valid responses.
  - Auto-coalesce: when producing_panelists covers every registered provider,
    audit falls back to coalesced_self instead of erroring.
  - Strict mode tanks the run when one judge disagrees on one item.

Exit 0 on success.
"""

from __future__ import annotations

import json
import os
import statistics
import sys
import tempfile
from pathlib import Path


def main() -> int:
    here = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(here / "servers" / "python"))

    tmp = Path(tempfile.mkdtemp())
    pricing = tmp / "pricing.json"
    pricing.write_text(json.dumps({
        "openai":    {"gpt-test": {"prompt_per_1k": 0.0001, "completion_per_1k": 0.0003, "cached_per_1k": 0.00005}},
        "anthropic": {"claude-test": {"prompt_per_1k": 0.003,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0003}},
        "xai":       {"grok-test": {"prompt_per_1k": 0.005,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0025}},
        "gemini":    {"gemini-test": {"prompt_per_1k": 0.001,  "completion_per_1k": 0.003,  "cached_per_1k": 0.0001}},
        "_tiers": {
            "low":  {"models": [{"provider": "openai",    "model": "gpt-test"}]},
            "med":  {"models": [{"provider": "anthropic", "model": "claude-test"}]},
            "high": {"models": [{"provider": "xai",       "model": "grok-test"}]},
        },
    }))
    os.environ["CROSSCHECK_PRICING_PATH"] = str(pricing)

    import crosscheck_server as srv

    srv.CFG = dict(srv.CFG)
    srv.CFG["session_db"]      = str(tmp / "sessions.db")
    srv.CFG["transcript_dir"]  = str(tmp / "transcripts")
    srv.CFG["cache"]           = {"enabled": False}
    srv.TRANSCRIPT_DIR         = Path(srv.CFG["transcript_dir"])
    srv._DB_INIT_DONE          = False
    srv._PRICING_CACHE         = None
    srv.PRICING_PATH           = pricing
    srv.ENV = dict(srv.ENV)
    srv.ENV["OPENAI_API_KEY"]    = "stub";  srv.ENV["OPENAI_MODEL"]    = "gpt-test"
    srv.ENV["ANTHROPIC_API_KEY"] = "stub";  srv.ENV["ANTHROPIC_MODEL"] = "claude-test"
    srv.ENV["XAI_API_KEY"]       = "stub";  srv.ENV["XAI_MODEL"]       = "grok-test"
    srv.ENV["GEMINI_API_KEY"]    = "stub";  srv.ENV["GEMINI_MODEL"]    = "gemini-test"
    all_built = srv.build_providers()
    srv.ALL_PROVIDERS = {n: p for n, p in all_built.items()
                         if n in {"openai", "anthropic", "xai", "gemini"}}
    srv.CFG["providers"] = ["openai", "anthropic", "xai", "gemini"]
    srv.CFG["moderator"] = "anthropic"

    # ------------------------------------------------------------------
    # Stubbed HTTP layer. Different providers return different rubric
    # responses so we can exercise aggregation, obvious_failure, etc.
    # ------------------------------------------------------------------
    # judge_scripts: per-provider per-item score override.
    # Default: every judge scores every item 0.9 pass=true.
    judge_scripts: dict[str, dict[str, dict]] = {}
    judge_status:  dict[str, str]              = {}   # provider -> "ok"|"parse_error"|"refusal"

    import re as _re
    def _extract_rubric_ids_from_prompt(text: str) -> list[dict]:
        """The audit prompt includes lines like '- some_id (severity=high): desc'.
        We pull those back out so the stub matches whatever rubric the tool sent."""
        out: list[dict] = []
        for m in _re.finditer(r"^- ([\w-]+) \(severity=(\w+)\):", text, _re.MULTILINE):
            out.append({"id": m.group(1), "severity": m.group(2)})
        return out

    def _make_audit_obj(provider: str, rubric: list[dict]) -> dict:
        script = judge_scripts.get(provider, {})
        items = []
        for ri in rubric:
            rid = ri["id"]
            override = script.get(rid)
            if override is not None:
                items.append({"id": rid,
                              "score":      override["score"],
                              "pass":       override["pass"],
                              "rationale":  override.get("rationale", f"{provider}:{rid}")})
            else:
                items.append({"id": rid, "score": 0.9, "pass": True,
                              "rationale": f"{provider}:{rid}"})
        numeric = [i["score"] for i in items
                   if isinstance(i["score"], (int, float))]
        overall = statistics.fmean(numeric) if numeric else 0.0
        return {"items": items, "overall_score": overall}

    def _classify_and_extract(body: dict) -> tuple[str, str]:
        parts = []
        if isinstance(body.get("messages"), list):
            for m in body["messages"]:
                if isinstance(m.get("content"), str):
                    parts.append(m["content"])
        if isinstance(body.get("system"), str):
            parts.append(body["system"])
        if isinstance(body.get("contents"), list):
            for c in body["contents"]:
                for p in (c.get("parts") or []):
                    if isinstance(p.get("text"), str):
                        parts.append(p["text"])
        if isinstance((body.get("systemInstruction") or {}).get("parts"), list):
            for p in body["systemInstruction"]["parts"]:
                if isinstance(p.get("text"), str):
                    parts.append(p["text"])
        txt = "\n".join(parts)
        if "RUBRIC ITEMS:" in txt or "Score the OUTPUT against each rubric" in txt:
            return "audit", txt
        return "plain", txt

    def _classify(body: dict) -> str:
        return _classify_and_extract(body)[0]

    def _resp_text_for(provider: str, body: dict, kind: str, full_text: str) -> str:
        status = judge_status.get(provider, "ok")
        if kind == "audit":
            if status == "parse_error":
                return "not-json"
            if status == "refusal":
                return json.dumps({"refusal": "I cannot."})
            rubric_from_prompt = _extract_rubric_ids_from_prompt(full_text)
            if not rubric_from_prompt:
                rubric_from_prompt = list(srv.DEFAULT_AUDIT_RUBRICS)
            return json.dumps(_make_audit_obj(provider, rubric_from_prompt))
        return f"{provider}-out"

    def fake_post(url, headers, body, timeout):
        kind, full_text = _classify_and_extract(body)
        if "openai.com" in url:
            return {"choices": [{"message": {"content": _resp_text_for("openai", body, kind, full_text)}}],
                    "usage": {"prompt_tokens": 40, "completion_tokens": 15, "total_tokens": 55}}
        if "x.ai" in url:
            return {"choices": [{"message": {"content": _resp_text_for("xai", body, kind, full_text)}}],
                    "usage": {"prompt_tokens": 40, "completion_tokens": 15, "total_tokens": 55}}
        if "googleapis.com" in url:
            return {"candidates": [{"content": {"parts": [{"text": _resp_text_for("gemini", body, kind, full_text)}]}}],
                    "usageMetadata": {"promptTokenCount": 30, "candidatesTokenCount": 12, "totalTokenCount": 42}}
        if "anthropic.com" in url:
            return {"content": [{"type": "text", "text": _resp_text_for("anthropic", body, kind, full_text)}],
                    "usage": {"input_tokens": 50, "output_tokens": 20}}
        return {}

    def fake_post_resilient(url, headers, body, timeout, deadline):
        return fake_post(url, headers, body, timeout), 1

    srv._http_post = fake_post
    srv._http_post_resilient = fake_post_resilient

    # ------------------------------------------------------------------
    # 1) run_summary attached to single-tool calls (confer)
    # ------------------------------------------------------------------
    res = srv.tool_confer({
        "question":   "test",
        "providers":  ["openai", "anthropic"],
        "session_id": "rs-confer",
    })
    rs = res.get("run_summary")
    assert isinstance(rs, dict), "run_summary missing on confer"
    assert rs["tool"] == "confer"
    assert rs["session_id"] == "rs-confer"
    assert rs["totals"]["calls"] >= 2
    assert "text" in rs and rs["text"].startswith(("session:", "call:"))
    # Tree glyphs ASCII (default)
    assert "├─" not in rs["text"], "expected ASCII glyphs by default"
    # Should have a per-purpose row for confer.
    purposes = {r["purpose"] for r in rs["rows"]}
    assert "confer" in purposes, purposes

    # ------------------------------------------------------------------
    # 2) Coalesce explicit: 3 judges, majority pass
    # ------------------------------------------------------------------
    judge_scripts.clear(); judge_status.clear()
    # 3 judges, default 0.9 pass=true for all -> overall passes, no disputes.
    res = srv.tool_audit({
        "output_to_audit":     "audited output",
        "producing_panelists": ["anthropic"],   # exclude one only
        "coalesce":            True,
        "max_judges":          3,
        "session_id":          "audit-coalesce-happy",
    })
    assert res.get("tool") == "audit" and "error" not in res, res
    assert res["mode"] == "coalesced", res["mode"]
    assert res["passed"] is True
    assert res["obvious_failures"] == []
    assert res["disagreements"] == []
    assert res["audit_process_failure"] is False
    assert len(res["judges"]) == 3
    for item in res["items"]:
        assert "per_judge" in item and len(item["per_judge"]) == 3
        assert item["score"] >= 0.7
        assert item["pass"] is True
    # run_summary present and reflects N audit calls
    rs = res["run_summary"]
    audit_row = next((r for r in rs["rows"] if r["purpose"] == "audit"), None)
    assert audit_row and audit_row["calls"] == 3, audit_row

    # ------------------------------------------------------------------
    # 3) Obvious_failure: one judge tanks a high-severity item
    # ------------------------------------------------------------------
    judge_scripts.clear(); judge_status.clear()
    # Make xai score `no_pii_leak` (high) at 0.1 -> obvious_failure.
    judge_scripts["xai"] = {"no_pii_leak": {"score": 0.1, "pass": False,
                                             "rationale": "I see a leaked email."}}
    res = srv.tool_audit({
        "output_to_audit":     "audited output",
        "producing_panelists": ["anthropic"],
        "coalesce":            True,
        "max_judges":          3,
        "session_id":          "audit-obvious-failure",
    })
    assert res["mode"] == "coalesced"
    assert "no_pii_leak" in res["obvious_failures"], res["obvious_failures"]
    item = next(i for i in res["items"] if i["id"] == "no_pii_leak")
    assert "obvious_failure" in item["flags"]
    assert "xai" in item["obvious_failure_judges"]
    # Majority still passes (2-of-3 said pass).
    assert item["pass"] is True

    # ------------------------------------------------------------------
    # 4) Obvious_failure on med-severity at threshold 0.2
    # ------------------------------------------------------------------
    judge_scripts.clear(); judge_status.clear()
    judge_scripts["xai"] = {"internally_consistent": {"score": 0.15, "pass": False,
                                                       "rationale": "contradiction"}}
    res = srv.tool_audit({
        "output_to_audit":     "x",
        "producing_panelists": ["anthropic"],
        "coalesce":            True,
        "max_judges":          3,
        "session_id":          "audit-obvious-med",
    })
    assert "internally_consistent" in res["obvious_failures"]
    # Low-severity below 0.2 should NOT trigger obvious_failure.
    judge_scripts.clear(); judge_status.clear()
    judge_scripts["xai"] = {"actionability": {"score": 0.1, "pass": False,
                                               "rationale": "vague"}}
    res = srv.tool_audit({
        "output_to_audit":     "x",
        "producing_panelists": ["anthropic"],
        "coalesce":            True,
        "max_judges":          3,
        "session_id":          "audit-low-severity-no-flag",
    })
    assert "actionability" not in res["obvious_failures"], res["obvious_failures"]

    # ------------------------------------------------------------------
    # 5) Disagreement: stddev > 0.3 at N>=3
    # ------------------------------------------------------------------
    judge_scripts.clear(); judge_status.clear()
    # 3 judges score factual_grounding very differently: 0.95 / 0.5 / 0.1
    # stddev ~ 0.348 -> disputed.
    judge_scripts["openai"] = {"factual_grounding": {"score": 0.95, "pass": True}}
    judge_scripts["xai"]    = {"factual_grounding": {"score": 0.50, "pass": False}}
    judge_scripts["gemini"] = {"factual_grounding": {"score": 0.10, "pass": False}}
    res = srv.tool_audit({
        "output_to_audit":     "x",
        "producing_panelists": ["anthropic"],
        "coalesce":            True,
        "max_judges":          3,
        "session_id":          "audit-disagreement-n3",
    })
    assert "factual_grounding" in res["disagreements"], res["disagreements"]
    item = next(i for i in res["items"] if i["id"] == "factual_grounding")
    assert item["disputed"] is True
    assert item["stddev"] is not None and item["stddev"] > 0.3

    # ------------------------------------------------------------------
    # 6) Disagreement at N==2 uses range > 0.4, not stddev
    # ------------------------------------------------------------------
    judge_scripts.clear(); judge_status.clear()
    judge_scripts["openai"] = {"factual_grounding": {"score": 0.95, "pass": True}}
    judge_scripts["xai"]    = {"factual_grounding": {"score": 0.45, "pass": False}}
    res = srv.tool_audit({
        "output_to_audit":     "x",
        "producing_panelists": ["anthropic", "gemini"],   # leave 2 judges
        "coalesce":            True,
        "max_judges":          2,
        "session_id":          "audit-disagreement-n2",
    })
    assert len(res["judges"]) == 2
    item = next(i for i in res["items"] if i["id"] == "factual_grounding")
    assert item["stddev"] is None   # not computed at N=2
    assert item["disagreement_score"] >= 0.5
    assert item["disputed"] is True

    # ------------------------------------------------------------------
    # 7) audit_process_failure when most judges parse-fail
    # ------------------------------------------------------------------
    judge_scripts.clear()
    judge_status.clear()
    judge_status["openai"] = "parse_error"
    judge_status["xai"]    = "parse_error"
    # gemini still ok -> 1 valid of 3 -> ceil(3/2)=2 -> 1<2 -> process_failure=true
    res = srv.tool_audit({
        "output_to_audit":     "x",
        "producing_panelists": ["anthropic"],
        "coalesce":            True,
        "max_judges":          3,
        "session_id":          "audit-process-failure",
    })
    assert res["audit_process_failure"] is True
    js = res["judges_stats"]
    assert js["total"] == 3 and js["valid"] == 1 and js["parse_errors"] == 2

    # ------------------------------------------------------------------
    # 8) Auto-coalesce when producing_panelists covers every provider
    # ------------------------------------------------------------------
    judge_scripts.clear(); judge_status.clear()
    res = srv.tool_audit({
        "output_to_audit":     "x",
        "producing_panelists": ["openai", "anthropic", "xai", "gemini"],
        "session_id":          "audit-self",
    })
    assert "error" not in res, res
    assert res["mode"] == "coalesced_self", res["mode"]
    assert len(res["judges"]) >= 2

    # ------------------------------------------------------------------
    # 9a) Direct unit tests of the coercion / coalesce helpers (the schema
    # validator normally rejects malformed responses upstream of these
    # helpers, so we exercise them directly with synthetic inputs).
    # ------------------------------------------------------------------
    # _coerce_pass: critical that the literal string "false" returns False,
    # not True (which `bool("false")` would).
    assert srv._coerce_pass(True)    is True
    assert srv._coerce_pass(False)   is False
    assert srv._coerce_pass("true")  is True
    assert srv._coerce_pass("false") is False, "string 'false' must coerce to False"
    assert srv._coerce_pass("False") is False
    assert srv._coerce_pass("yes")   is True
    assert srv._coerce_pass("no")    is False
    assert srv._coerce_pass(1)       is True
    assert srv._coerce_pass(0)       is False
    assert srv._coerce_pass(None)    is None   # invalid -> sentinel
    assert srv._coerce_pass("maybe") is None

    # _coalesce_audit_items: a judge that emits "N/A" for score must be
    # marked score_parse_error for that item only (other items still
    # contribute valid scores from that judge).
    rubric = [{"id": "x_high",   "description": "must be true",   "severity": "high"},
              {"id": "x_medium", "description": "should be true", "severity": "med"}]
    per_judge_obj = [
        {"items": [{"id": "x_high",   "score": "N/A", "pass": "false", "rationale": "bad score"},
                   {"id": "x_medium", "score": 0.9,    "pass": True,    "rationale": "ok"}]},
        {"items": [{"id": "x_high",   "score": 0.95,   "pass": True,    "rationale": "ok"},
                   {"id": "x_medium", "score": 0.9,    "pass": True,    "rationale": "ok"}]},
        {"items": [{"id": "x_high",   "score": 0.9,    "pass": "false", "rationale": "string false"},
                   {"id": "x_medium", "score": 0.9,    "pass": True,    "rationale": "ok"}]},
    ]
    per_judge_meta = [
        {"provider": "a", "model": "ma", "status": "ok"},
        {"provider": "b", "model": "mb", "status": "ok"},
        {"provider": "c", "model": "mc", "status": "ok"},
    ]
    items, flags = srv._coalesce_audit_items(rubric, per_judge_obj, per_judge_meta,
                                             strict_mode=False)
    fg = next(i for i in items if i["id"] == "x_high")
    statuses = [p.get("status") for p in fg["per_judge"]]
    assert "score_parse_error" in statuses, statuses
    # Judge "c" emits pass="false" — this must be coerced to False, not True.
    # That judge's valid contribution to x_high is: score=0.9, pass=False.
    c_entry = next(p for p in fg["per_judge"] if p.get("provider") == "c")
    assert c_entry.get("pass") is False, c_entry
    # x_medium had all valid scores, so partial_judges should NOT be flagged.
    sev_med = next(i for i in items if i["id"] == "x_medium")
    assert "partial_judges" not in sev_med["flags"], sev_med["flags"]
    # x_high should be flagged partial_judges (one judge had parse_error).
    assert "partial_judges" in fg["flags"], fg["flags"]
    assert fg["valid_judges"] == 2

    # ------------------------------------------------------------------
    # 9b) Severity normalization: "medium" -> "med"
    # ------------------------------------------------------------------
    custom_rubric = [
        {"id": "x_high",   "description": "must be true",   "severity": "high"},
        {"id": "x_medium", "description": "should be true", "severity": "medium"},  # alias for med
        {"id": "x_low",    "description": "nice to have",   "severity": "low"},
    ]
    judge_scripts.clear(); judge_status.clear()
    # Set every judge to fail x_medium with 0.15 -> obvious_failure on med
    for prov in ["openai", "xai", "gemini"]:
        judge_scripts[prov] = {"x_medium": {"score": 0.15, "pass": False, "rationale": "bad"}}
    res = srv.tool_audit({
        "output_to_audit":     "x",
        "producing_panelists": ["anthropic"],
        "coalesce":            True,
        "max_judges":          3,
        "rubric":              custom_rubric,
        "session_id":          "audit-severity-alias",
    })
    assert "x_medium" in res["obvious_failures"], (
        f"medium severity (alias) should trip obvious_failure: {res['obvious_failures']}")
    sev_med = next(i for i in res["items"] if i["id"] == "x_medium")
    assert sev_med["severity"] == "med", sev_med["severity"]

    # ------------------------------------------------------------------
    # 9c) Strict mode with one parse-failed judge: that item cannot pass
    # ------------------------------------------------------------------
    judge_scripts.clear(); judge_status.clear()
    judge_status["xai"] = "parse_error"
    # openai + gemini both pass everything (default 0.9). strict_mode should
    # still fail every item because we don't have ALL judges valid.
    res = srv.tool_audit({
        "output_to_audit":     "x",
        "producing_panelists": ["anthropic"],
        "coalesce":            True,
        "strict_mode":         True,
        "max_judges":          3,
        "session_id":          "audit-strict-parse-fail",
    })
    for item in res["items"]:
        assert item["pass"] is False, (
            f"strict + parse-failed judge: item {item['id']} should fail. {item}")
    assert res["passed"] is False

    # ------------------------------------------------------------------
    # 10) Strict mode: one dissenter tanks an item, which tanks `passed`
    # ------------------------------------------------------------------
    judge_scripts.clear(); judge_status.clear()
    # 3 judges; xai disagrees on factual_grounding pass.
    judge_scripts["xai"] = {"factual_grounding": {"score": 0.6, "pass": False,
                                                   "rationale": "borderline"}}
    res = srv.tool_audit({
        "output_to_audit":     "x",
        "producing_panelists": ["anthropic"],
        "coalesce":            True,
        "strict_mode":         True,
        "max_judges":          3,
        "session_id":          "audit-strict",
    })
    fg = next(i for i in res["items"] if i["id"] == "factual_grounding")
    assert fg["pass"] is False, "strict_mode: one dissenter must fail the item"
    assert res["passed"] is False
    # Same setup WITHOUT strict_mode -> majority passes the item.
    res_loose = srv.tool_audit({
        "output_to_audit":     "x",
        "producing_panelists": ["anthropic"],
        "coalesce":            True,
        "strict_mode":         False,
        "max_judges":          3,
        "session_id":          "audit-loose",
    })
    fg_loose = next(i for i in res_loose["items"] if i["id"] == "factual_grounding")
    assert fg_loose["pass"] is True, "loose: majority should pass"

    print("OK: test_coalesce_audit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
