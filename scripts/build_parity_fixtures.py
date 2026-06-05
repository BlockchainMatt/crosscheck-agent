#!/usr/bin/env python3
"""Generate cross-language parity fixtures.

For each TS port module that mirrors a Python primitive, we generate a
JSON fixture file containing (input_args, expected_output) cases produced
BY THE PYTHON IMPLEMENTATION ITSELF. The TS test then loads the fixture
and asserts byte-equal results from its port. If Python drifts, the
fixture regenerates; if TS drifts, the test fails.

Fixtures land in `servers/typescript/test/parity/fixtures/<module>.json`.

Currently generates:
  - budgets.json    (budgetForPurpose + isReasoningModel)
  - pricing.json    (calculateCost across a permutation grid)

Invocation:
    python3 scripts/build_parity_fixtures.py [module-name ...]
    python3 scripts/build_parity_fixtures.py             # regenerates all
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = ROOT / "servers" / "typescript" / "test" / "parity" / "fixtures"


def _import_server():
    sys.path.insert(0, str(ROOT / "servers" / "python"))
    import crosscheck_server as srv          # noqa: WPS433
    return srv


# ----------------------------------------------------------------------
# budgets.json
# ----------------------------------------------------------------------
def fixture_budgets() -> dict:
    srv = _import_server()
    # Reset CFG so the fixture doesn't pick up user config.
    srv.CFG = dict(srv.CFG)
    srv.CFG.pop("token_budgets", None)
    srv.CFG.pop("token_budgets_by_provider", None)

    purposes = sorted(set(srv._DEFAULT_TOKEN_BUDGETS) |
                       set(srv._NON_REASONING_TOKEN_BUDGETS))
    providers_models = [
        ("openai",    "gpt-5"),         # reasoning openai
        ("openai",    "gpt-test"),      # non-reasoning openai
        ("anthropic", "claude-opus-4-7"),  # reasoning anthropic
        ("anthropic", "claude-test"),    # non-reasoning anthropic
        ("xai",       "grok-4-latest"),  # non-reasoning xai (no caps prefix)
        ("gemini",    "gemini-2.5-pro"), # reasoning gemini
        ("gemini",    "gemini-1.5-flash"), # non-reasoning gemini
        ("groq",      "llama-3.3-70b"),  # always non-reasoning
    ]

    cases: list[dict] = []

    # Tier 4/5: no CFG overrides — straight model-class fall-through.
    for purpose in purposes + ["nope-unknown-purpose"]:
        for prov, model in providers_models:
            cases.append({
                "label":   f"default::{purpose}::{prov}::{model}",
                "purpose": purpose,
                "provider": prov,
                "model":   model,
                "cfg":     {},
                "expected": {
                    "budget":    srv._budget_for_purpose(purpose, prov, model),
                    "reasoning": srv._is_reasoning_model(prov, model),
                },
            })
        # No provider supplied → reasoning-safe default path.
        cases.append({
            "label":    f"no-provider::{purpose}",
            "purpose":  purpose,
            "provider": None,
            "model":    None,
            "cfg":      {},
            "expected": {
                "budget":    srv._budget_for_purpose(purpose),
                "reasoning": None,
            },
        })

    # Tier 1: global override.
    srv.CFG["token_budgets"] = {"confer": 300, "audit": 0, "synth": -1}
    for purpose in ["confer", "audit", "synth", "debate"]:
        for prov, model in providers_models[:3]:
            cases.append({
                "label":   f"global-override::{purpose}::{prov}",
                "purpose": purpose,
                "provider": prov,
                "model":   model,
                "cfg":     {"token_budgets": dict(srv.CFG["token_budgets"])},
                "expected": {
                    "budget":    srv._budget_for_purpose(purpose, prov, model),
                    "reasoning": srv._is_reasoning_model(prov, model),
                },
            })
    srv.CFG.pop("token_budgets", None)

    # Tier 2: per-provider operator override (also catches positive>0 gating).
    srv.CFG["token_budgets_by_provider"] = {
        "openai":    {"confer": 8192, "audit": 0, "synth": -10},
        "anthropic": {"debate": 4096},
    }
    for purpose in ["confer", "audit", "synth", "debate"]:
        for prov, model in providers_models[:5]:
            cases.append({
                "label":   f"provider-override::{purpose}::{prov}",
                "purpose": purpose,
                "provider": prov,
                "model":   model,
                "cfg":     {"token_budgets_by_provider":
                            dict(srv.CFG["token_budgets_by_provider"])},
                "expected": {
                    "budget":    srv._budget_for_purpose(purpose, prov, model),
                    "reasoning": srv._is_reasoning_model(prov, model),
                },
            })
    srv.CFG.pop("token_budgets_by_provider", None)

    # Tier 1 beats Tier 2 (global override wins).
    srv.CFG["token_budgets"]              = {"confer": 500}
    srv.CFG["token_budgets_by_provider"]  = {"openai": {"confer": 9999}}
    cases.append({
        "label":   "tier1-beats-tier2",
        "purpose": "confer",
        "provider": "openai",
        "model":   "gpt-5",
        "cfg":     {
            "token_budgets":             dict(srv.CFG["token_budgets"]),
            "token_budgets_by_provider": dict(srv.CFG["token_budgets_by_provider"]),
        },
        "expected": {
            "budget":    srv._budget_for_purpose("confer", "openai", "gpt-5"),
            "reasoning": srv._is_reasoning_model("openai", "gpt-5"),
        },
    })
    srv.CFG.pop("token_budgets", None)
    srv.CFG.pop("token_budgets_by_provider", None)

    return {
        "module":      "budgets",
        "description": "budgetForPurpose + isReasoningModel parity",
        "case_count":  len(cases),
        "cases":       cases,
    }


# ----------------------------------------------------------------------
# pricing.json
# ----------------------------------------------------------------------
def fixture_pricing() -> dict:
    srv = _import_server()

    # Build a small pricing.json that exercises the calculation paths.
    pricing_payload = {
        "openai": {
            "gpt-5":     {"prompt_per_1k": 0.001,  "completion_per_1k": 0.003,  "cached_per_1k": 0.0005},
            "gpt-test":  {"prompt_per_1k": 0.0001, "completion_per_1k": 0.0003, "cached_per_1k": 0.00005},
            "weird":     {"prompt_per_1k": 0.0,    "completion_per_1k": 0.0,    "cached_per_1k": 0.0},
        },
        "anthropic": {
            "claude-test":    {"prompt_per_1k": 0.003, "completion_per_1k": 0.015, "cached_per_1k": 0.0003},
            "claude-opus-4-7": {"prompt_per_1k": 0.015, "completion_per_1k": 0.075, "cached_per_1k": 0.0015},
        },
        "gemini": {
            "gemini-2.5-pro": {"prompt_per_1k": 0.0025, "completion_per_1k": 0.01, "cached_per_1k": 0.0005},
        },
        # No "missing-provider" key on purpose so we exercise the missing path.
    }

    # Persist a tmp pricing.json so the Python helper reads it.
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "pricing.json"
        p.write_text(json.dumps(pricing_payload))
        os.environ["CROSSCHECK_PRICING_PATH"] = str(p)
        srv.PRICING_PATH = p
        srv._PRICING_CACHE = None

        # Permutation grid — every interesting input shape.
        triples = [
            # (provider, model)
            ("openai",    "gpt-5"),
            ("openai",    "gpt-test"),
            ("openai",    "weird"),       # zero rates
            ("openai",    "missing-model"),  # missing inside known provider
            ("anthropic", "claude-test"),
            ("anthropic", "claude-opus-4-7"),
            ("gemini",    "gemini-2.5-pro"),
            ("missing-provider", "anything"),  # missing top-level key
        ]
        token_shapes = [
            (0,    0,    0),
            (100,  50,   0),
            (1000, 500,  200),       # cached > 0 (subset of prompt)
            (300,  100,  300),       # cached == prompt
            (1,    1,    1),         # smallest non-zero
            (50000, 20000, 5000),    # large numbers — accuracy stress
            (-5,   -10,  -3),        # negative inputs (must clamp to 0)
            (123,  456,  789),       # cached > prompt (Python clamps prompt-cached to 0)
        ]
        cases: list[dict] = []
        for (provider, model) in triples:
            for (pt, ct, cached) in token_shapes:
                cost, estimated = srv._calculate_cost(provider, model, pt, ct, cached)
                cases.append({
                    "label":     f"{provider}::{model}::p{pt}-c{ct}-cd{cached}",
                    "provider":  provider,
                    "model":     model,
                    "prompt_tokens":     pt,
                    "completion_tokens": ct,
                    "cached_tokens":     cached,
                    "expected": {
                        "cost_usd":  cost,
                        "estimated": estimated,
                    },
                })

    return {
        "module":         "pricing",
        "description":    "calculateCost parity across provider/model/usage permutations",
        "pricing_doc":    pricing_payload,
        "case_count":     len(cases),
        "cases":          cases,
    }


# ----------------------------------------------------------------------
# Wiring
# ----------------------------------------------------------------------
BUILDERS = {
    "budgets": fixture_budgets,
    "pricing": fixture_pricing,
}


def main(argv: list[str]) -> int:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    targets = argv[1:] if len(argv) > 1 else sorted(BUILDERS)
    written: list[str] = []
    for name in targets:
        builder = BUILDERS.get(name)
        if builder is None:
            print(f"unknown fixture: {name}", file=sys.stderr)
            return 2
        doc = builder()
        path = FIXTURE_DIR / f"{name}.json"
        path.write_text(json.dumps(doc, indent=2, ensure_ascii=False))
        written.append(str(path.relative_to(ROOT)))
        print(f"wrote {written[-1]}  ({doc['case_count']} cases)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
