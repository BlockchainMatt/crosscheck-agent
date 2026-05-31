#!/usr/bin/env python3
"""Tests for per-provider token-budget overrides.

Problem this solves: gpt-5 charges reasoning tokens against
`max_completion_tokens`. At the reasoning-class default of 2048 it
routinely runs out before emitting visible answer text on multi-round
work like confer / debate. The fix is a per-provider override layer
sitting between the global CFG override and the reasoning / non-
reasoning fall-back tables.

Precedence the test enforces (highest first):
  1. CFG.token_budgets[purpose]
  2. CFG.token_budgets_by_provider[provider][purpose]
  3. _PROVIDER_TOKEN_BUDGETS[provider][purpose] (shipped defaults)
  4. _NON_REASONING_TOKEN_BUDGETS[purpose] (non-reasoning model)
  5. _DEFAULT_TOKEN_BUDGETS[purpose] (reasoning-safe default)
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
        "openai":    {"gpt-test":    {"prompt_per_1k": 0.0001, "completion_per_1k": 0.0003, "cached_per_1k": 0.00005},
                       "gpt-5":      {"prompt_per_1k": 0.001,  "completion_per_1k": 0.003,  "cached_per_1k": 0.0005}},
        "anthropic": {"claude-test": {"prompt_per_1k": 0.003,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0003}},
        "xai":       {"grok-test":   {"prompt_per_1k": 0.005,  "completion_per_1k": 0.015,  "cached_per_1k": 0.0025},
                       "grok-4-latest": {"prompt_per_1k": 0.005, "completion_per_1k": 0.015, "cached_per_1k": 0.0025}},
    }))
    os.environ["CROSSCHECK_PRICING_PATH"] = str(pricing)
    os.environ.pop("CROSSCHECK_REJECT_CONFIG_DRIFT", None)

    import crosscheck_server as srv

    srv.CFG = dict(srv.CFG)
    srv.CFG["session_db"]     = str(tmp / "sessions.db")
    srv.CFG["transcript_dir"] = str(tmp / "transcripts")
    srv.CFG["cache"]          = {"enabled": False}
    srv.CFG["node_cache"]     = {"enabled": False}
    srv.CFG["prompt_adapters"] = {"enabled": False}
    srv.CFG["config_pinning"] = {"reject_drift": False}
    srv.CFG.pop("token_budgets", None)
    srv.CFG.pop("token_budgets_by_provider", None)
    srv.TRANSCRIPT_DIR        = Path(srv.CFG["transcript_dir"])
    srv._DB_INIT_DONE         = False
    srv._FTS5_AVAILABLE       = None
    srv._PRICING_CACHE        = None
    srv.PRICING_PATH          = pricing
    srv._CONFIG_PIN_STARTUP_DONE = True

    # ------------------------------------------------------------------
    # 1) Shipped provider overrides = 6144 on the multi-perspective flows
    #    (gpt-5 and gemini-2.5-pro both burn reasoning tokens against the
    #    completion budget; bumping confer/debate/triangulate prevents
    #    mid-answer MAX_TOKENS truncation)
    # ------------------------------------------------------------------
    # OpenAI
    assert srv._budget_for_purpose("confer",      "openai", "gpt-5")    == 6144
    assert srv._budget_for_purpose("debate",      "openai", "gpt-5")    == 6144
    assert srv._budget_for_purpose("triangulate", "openai", "gpt-5")    == 6144
    # Non-reasoning OpenAI model: the override still applies — it's keyed
    # on provider, not model class. (The whole point is that the provider
    # has a quirky reasoning-token accounting model.)
    assert srv._budget_for_purpose("confer", "openai", "gpt-test") == 6144
    # Gemini — only confer + triangulate were bumped this round; debate
    # falls through to the non-reasoning ceiling because gemini-2.5-pro
    # isn't currently tagged in PROVIDER_CAPS.reasoning_prefixes (a
    # separate fix; flagged as a follow-up).
    assert srv._budget_for_purpose("confer",      "gemini", "gemini-2.5-pro") == 6144
    assert srv._budget_for_purpose("triangulate", "gemini", "gemini-2.5-pro") == 6144
    assert srv._budget_for_purpose("debate",      "gemini", "gemini-2.5-pro") == 1500

    # Non-overridden purposes for OpenAI fall through to the tier table.
    # audit / synth on a NON-reasoning model -> non-reasoning ceiling.
    assert srv._budget_for_purpose("audit", "openai", "gpt-test") == 768
    assert srv._budget_for_purpose("synth", "openai", "gpt-test") == 1024
    # audit / synth on a reasoning model -> reasoning-safe default.
    assert srv._budget_for_purpose("audit", "openai", "gpt-5") == 2048

    # ------------------------------------------------------------------
    # 2) Other providers are unaffected by the openai shipped override.
    # ------------------------------------------------------------------
    assert srv._budget_for_purpose("confer", "anthropic", "claude-test") == 1500   # non-reasoning ceiling
    assert srv._budget_for_purpose("debate", "anthropic", "claude-test") == 1500
    assert srv._budget_for_purpose("confer", "anthropic", "claude-opus-4-7") == 2048  # reasoning default
    assert srv._budget_for_purpose("confer", "xai", "grok-4-latest") == 1500

    # ------------------------------------------------------------------
    # 3) Precedence: global CFG.token_budgets beats the per-provider override
    # ------------------------------------------------------------------
    srv.CFG["token_budgets"] = {"confer": 999}
    assert srv._budget_for_purpose("confer", "openai", "gpt-5") == 999
    # And it still beats the provider override for OTHER models too:
    assert srv._budget_for_purpose("confer", "anthropic", "claude-test") == 999
    srv.CFG.pop("token_budgets", None)

    # ------------------------------------------------------------------
    # 4) Precedence: CFG.token_budgets_by_provider beats shipped defaults
    # ------------------------------------------------------------------
    srv.CFG["token_budgets_by_provider"] = {
        "openai":    {"confer": 8192},        # bump higher than the shipped 6144
        "anthropic": {"debate": 4096},        # add an override anthropic didn't have
    }
    assert srv._budget_for_purpose("confer", "openai", "gpt-5") == 8192
    # Anthropic now has a debate override even though there's no shipped one
    assert srv._budget_for_purpose("debate", "anthropic", "claude-opus-4-7") == 4096
    # Non-overridden purpose on the same provider still falls through
    assert srv._budget_for_purpose("audit", "openai", "gpt-5") == 2048
    # And the global CFG.token_budgets still wins over the per-provider one
    srv.CFG["token_budgets"] = {"confer": 500}
    assert srv._budget_for_purpose("confer", "openai", "gpt-5") == 500
    srv.CFG.pop("token_budgets", None)
    srv.CFG.pop("token_budgets_by_provider", None)

    # ------------------------------------------------------------------
    # 5) Operator-supplied override of 0 / negative is ignored
    # ------------------------------------------------------------------
    srv.CFG["token_budgets_by_provider"] = {"openai": {"confer": 0}}
    # Falls through to the SHIPPED override (6144), not the table below it
    assert srv._budget_for_purpose("confer", "openai", "gpt-5") == 6144
    srv.CFG["token_budgets_by_provider"] = {"openai": {"confer": -1}}
    assert srv._budget_for_purpose("confer", "openai", "gpt-5") == 6144
    srv.CFG.pop("token_budgets_by_provider", None)

    # ------------------------------------------------------------------
    # 6) No provider / no model -> reasoning-safe defaults (unchanged)
    # ------------------------------------------------------------------
    assert srv._budget_for_purpose("confer") == 2048
    assert srv._budget_for_purpose("debate") == 2048
    assert srv._budget_for_purpose("audit")  == 2048

    # ------------------------------------------------------------------
    # 7) End-to-end: the wire payload for openai confer carries 6144
    # ------------------------------------------------------------------
    srv.ENV = dict(srv.ENV)
    srv.ENV["OPENAI_API_KEY"]    = "stub"; srv.ENV["OPENAI_MODEL"]    = "gpt-5"
    srv.ENV["ANTHROPIC_API_KEY"] = "stub"; srv.ENV["ANTHROPIC_MODEL"] = "claude-opus-4-7"
    srv.ALL_PROVIDERS = srv.build_providers()

    captured: list[dict] = []
    def fake_post(url, h, b, **kw):
        captured.append({"url": url, "body": b})
        if "openai.com" in url:
            return ({"choices": [{"message": {"content": "ok"}}],
                     "usage": {"prompt_tokens": 30, "completion_tokens": 10}}, 1)
        return ({"content": [{"type": "text", "text": "ok"}],
                 "usage": {"input_tokens": 30, "output_tokens": 10}}, 1)
    srv._http_post_resilient = fake_post

    import time as _t
    # Caller passes a huge max_tokens (8000); the budget should clamp it to
    # 6144 because openai+confer trips the shipped override.
    srv._ask_one(srv.ALL_PROVIDERS["openai"],
                 [{"role": "user", "content": "hi"}],
                 deadline=_t.monotonic() + 10, max_tokens=8000, purpose="confer")
    sent = captured[-1]["body"]
    # gpt-5 is reasoning class -> openai uses max_completion_tokens, not max_tokens
    assert sent.get("max_completion_tokens") == 6144, sent

    # Same call on Anthropic confer (no provider override) clamps to the
    # reasoning default of 2048.
    captured.clear()
    srv._ask_one(srv.ALL_PROVIDERS["anthropic"],
                 [{"role": "user", "content": "hi"}],
                 deadline=_t.monotonic() + 10, max_tokens=8000, purpose="confer")
    assert captured[-1]["body"].get("max_tokens") == 2048, captured[-1]

    print("OK: test_provider_token_budgets")
    return 0


if __name__ == "__main__":
    sys.exit(main())
