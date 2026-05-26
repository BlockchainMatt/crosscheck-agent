#!/usr/bin/env python3
"""Tests for config-file pinning.

Covers:
  - show: reports has_pin_file=false when no pin exists, lists current hashes
  - set: writes the pin file with current hashes
  - show after set: drift=[], has_pin_file=true
  - Modify a tracked file -> show reports drift
  - accept_drift: requires drift to exist, then re-pins
  - clear: removes the pin file
  - reject_drift gate: when reject_drift=true and drift exists,
    the handler's tool dispatch refuses non-config_pin calls
  - config_pin itself is NOT blocked even under reject mode
  - Error taxonomy: bad action, accept_drift with no drift, accept_drift
    with no pin file
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
    # Tracked files live INSIDE tmp so the test doesn't touch the real repo.
    cfg_file     = tmp / "crosscheck.config.json"
    pricing_file = tmp / "config" / "pricing.json"
    pricing_file.parent.mkdir(parents=True, exist_ok=True)
    cfg_file.write_text(json.dumps({
        "providers": ["anthropic", "openai"], "moderator": "anthropic",
        "max_rounds": 3, "token_cap": 8000, "max_time_seconds": 120,
    }))
    pricing_file.write_text(json.dumps({
        "openai":    {"gpt-test":    {"prompt_per_1k": 0.0001, "completion_per_1k": 0.0003, "cached_per_1k": 0.00005}},
        "anthropic": {"claude-test": {"prompt_per_1k": 0.003,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0003}},
    }))
    os.environ["CROSSCHECK_PRICING_PATH"] = str(pricing_file)
    # Make sure the reject-drift env var is clean across test runs.
    os.environ.pop("CROSSCHECK_REJECT_CONFIG_DRIFT", None)

    import crosscheck_server as srv

    # Re-root so the pin helpers point at our tmp tree.
    srv.ROOT = tmp
    srv.CFG = dict(srv.CFG)
    srv.CFG["session_db"]     = str(tmp / "sessions.db")
    srv.CFG["transcript_dir"] = str(tmp / "transcripts")
    srv.CFG["cache"]          = {"enabled": False}
    srv.CFG["node_cache"]     = {"enabled": False}
    srv.CFG["config_pinning"] = {
        "paths":        ["crosscheck.config.json", "config/pricing.json"],
        "pin_file":     ".crosscheck/config_pins.json",
        "reject_drift": False,
    }
    srv.TRANSCRIPT_DIR        = Path(srv.CFG["transcript_dir"])
    srv._DB_INIT_DONE         = False
    srv._FTS5_AVAILABLE       = None
    srv._PRICING_CACHE        = None
    srv.PRICING_PATH          = pricing_file
    srv._CONFIG_PIN_STARTUP_DONE = False

    # ------------------------------------------------------------------
    # 1) show: no pin file yet
    # ------------------------------------------------------------------
    res = srv.tool_config_pin({"action": "show"})
    assert res["has_pin_file"] is False, res
    assert res["pinned"] == {}, res
    # current includes both tracked files with sha256: prefix
    assert "crosscheck.config.json" in res["current"], res
    assert "config/pricing.json"    in res["current"], res
    assert all(h.startswith("sha256:") for h in res["current"].values()), res
    assert res["drift"] == [] and res["missing_files"] == []
    assert res["would_block"] is False

    # ------------------------------------------------------------------
    # 2) set: record the canonical pin
    # ------------------------------------------------------------------
    res = srv.tool_config_pin({"action": "set"})
    assert res["action"] == "set"
    assert "crosscheck.config.json" in res["pins"]
    pin_path = tmp / ".crosscheck" / "config_pins.json"
    assert pin_path.exists(), pin_path
    doc = json.loads(pin_path.read_text())
    assert doc["version"] == 1
    assert "pins" in doc and len(doc["pins"]) == 2

    # ------------------------------------------------------------------
    # 3) show after set: drift=[], has_pin_file=true
    # ------------------------------------------------------------------
    res = srv.tool_config_pin({"action": "show"})
    assert res["has_pin_file"] is True
    assert res["drift"] == [], res
    assert res["would_block"] is False

    # ------------------------------------------------------------------
    # 4) Modify a tracked file -> drift detected
    # ------------------------------------------------------------------
    pricing_file.write_text(json.dumps({
        # Same shape, different values (could be silent cost inflation).
        "openai":    {"gpt-test":    {"prompt_per_1k": 999.0, "completion_per_1k": 999.0, "cached_per_1k": 0.00005}},
        "anthropic": {"claude-test": {"prompt_per_1k": 0.003, "completion_per_1k": 0.015, "cached_per_1k": 0.0003}},
    }))
    res = srv.tool_config_pin({"action": "show"})
    assert res["drift"] == ["config/pricing.json"], res

    # ------------------------------------------------------------------
    # 5) accept_drift refreshes the pin
    # ------------------------------------------------------------------
    res = srv.tool_config_pin({"action": "accept_drift"})
    assert res["action"] == "accept_drift"
    assert res["accepted_drift"] == ["config/pricing.json"], res
    # After acceptance, drift is gone.
    res = srv.tool_config_pin({"action": "show"})
    assert res["drift"] == [], res

    # ------------------------------------------------------------------
    # 6) accept_drift with NO drift returns CONFIG_PIN_NO_DRIFT
    # ------------------------------------------------------------------
    res = srv.tool_config_pin({"action": "accept_drift"})
    assert res.get("error_code") == "CONFIG_PIN_NO_DRIFT", res

    # ------------------------------------------------------------------
    # 7) clear removes the pin file
    # ------------------------------------------------------------------
    res = srv.tool_config_pin({"action": "clear"})
    assert res["existed"] is True
    assert not pin_path.exists()
    # accept_drift with NO pin file returns CONFIG_PIN_NO_PIN_FILE
    res = srv.tool_config_pin({"action": "accept_drift"})
    assert res.get("error_code") == "CONFIG_PIN_NO_PIN_FILE", res

    # ------------------------------------------------------------------
    # 8) Bad action error taxonomy
    # ------------------------------------------------------------------
    res = srv.tool_config_pin({"action": "nope"})
    assert res.get("error_code") == "CONFIG_PIN_BAD_ACTION", res

    # ------------------------------------------------------------------
    # 9) Reject mode gate: drift blocks non-config_pin tool calls
    # ------------------------------------------------------------------
    # Re-pin clean tree, then enable reject mode and introduce drift.
    srv.tool_config_pin({"action": "set"})
    srv.CFG["config_pinning"] = dict(srv.CFG["config_pinning"])
    srv.CFG["config_pinning"]["reject_drift"] = True

    # No drift yet -> would_block=False
    assert srv._config_pin_should_block() is False

    # Drift the pricing file again
    pricing_file.write_text(json.dumps({
        "openai":    {"gpt-test":    {"prompt_per_1k": 0.0002, "completion_per_1k": 0.0003, "cached_per_1k": 0.00005}},
        "anthropic": {"claude-test": {"prompt_per_1k": 0.003,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0003}},
    }))
    assert srv._config_pin_should_block() is True

    # Dispatch a tool call via handle(); should be blocked.
    blocked = srv.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                           "params": {"name": "verify",
                                       "arguments": {"checks": [{"kind": "contains",
                                                                   "id": "x",
                                                                   "target_text": "hi",
                                                                   "value": "hi"}]}}})
    body = json.loads(blocked["result"]["content"][0]["text"])
    assert body.get("error_code") == "CONFIG_PIN_DRIFT_BLOCKED", body
    assert "config/pricing.json" in body["drift"]

    # config_pin itself is NOT blocked
    allowed = srv.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                           "params": {"name": "config_pin",
                                       "arguments": {"action": "show"}}})
    body = json.loads(allowed["result"]["content"][0]["text"])
    assert body.get("error_code") is None, body
    assert body["tool"] == "config_pin"
    assert body["would_block"] is True

    # Accept the drift via the handler -> tool calls unblock
    allowed = srv.handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                           "params": {"name": "config_pin",
                                       "arguments": {"action": "accept_drift"}}})
    body = json.loads(allowed["result"]["content"][0]["text"])
    assert body["action"] == "accept_drift", body

    # Now verify is no longer blocked
    ok = srv.handle({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                      "params": {"name": "verify",
                                  "arguments": {"checks": [{"kind": "contains",
                                                              "id": "x",
                                                              "target_text": "hi",
                                                              "value": "hi"}]}}})
    body = json.loads(ok["result"]["content"][0]["text"])
    assert body["tool"] == "verify" and body["all_passed"] is True, body

    # ------------------------------------------------------------------
    # 10) Env-var bypass: CROSSCHECK_REJECT_CONFIG_DRIFT=1 enables reject
    #     mode even when CFG.config_pinning.reject_drift is false.
    # ------------------------------------------------------------------
    srv.CFG["config_pinning"]["reject_drift"] = False
    assert srv._config_pin_should_block() is False
    # Re-introduce drift, then flip env var.
    pricing_file.write_text(json.dumps({
        "openai": {"gpt-test": {"prompt_per_1k": 0.999, "completion_per_1k": 0.999, "cached_per_1k": 0.0001}},
    }))
    os.environ["CROSSCHECK_REJECT_CONFIG_DRIFT"] = "1"
    assert srv._config_pin_should_block() is True
    os.environ.pop("CROSSCHECK_REJECT_CONFIG_DRIFT", None)
    assert srv._config_pin_should_block() is False

    # ------------------------------------------------------------------
    # 11) Cross-platform CRLF normalization: pinning a file then writing
    #     the same content with CRLF endings doesn't trip drift.
    # ------------------------------------------------------------------
    srv.tool_config_pin({"action": "set"})
    # Rewrite pricing file with CRLF endings, same logical content.
    original = pricing_file.read_text()
    pricing_file.write_bytes(original.replace("\n", "\r\n").encode("utf-8"))
    res = srv.tool_config_pin({"action": "show"})
    assert res["drift"] == [], res

    print("OK: test_config_pin")
    return 0


if __name__ == "__main__":
    sys.exit(main())
