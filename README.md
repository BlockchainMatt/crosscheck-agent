# crosscheck-agent

Confer with multiple LLMs from inside Claude Code. `crosscheck-agent` is a
compact MCP server that lets Claude ask peers from other model families
(GPT, Grok, Gemini, Mistral, Groq, DeepSeek) to reason, debate, plan,
peer-review, **orchestrate sub-agent DAGs**, and **audit each other's
output** — then hands the synthesised answer back to Claude.

Every multi-LLM call now reports real per-provider token usage and an
estimated USD cost, with live CPU and wall-time progress streamed to the
client. Routing can be opted into "cheap mode" so easy subtasks land on
small models and only the hard nodes pay for full power.

The server is **Python, stdlib-only** — no external dependencies, no build
step. (Earlier versions shipped TypeScript/Rust/Perl mirrors; those have
been dropped to remove the 4× maintenance tax. Python is canonical.)

```
       ┌──────────────┐
Claude │ Claude Code  │     MCP      ┌────────────────────────┐
 tool  │  (your IDE)  │ ───────────▶ │  crosscheck-agent MCP  │
 call  │              │   stdio      │       (Python)         │
       └──────────────┘              └───────────┬────────────┘
                                                 │ HTTPS
                                                 ▼
                         ┌────────────────────────────────────────┐
                         │ OpenAI · xAI · Gemini · Mistral · Groq │
                         │ DeepSeek · Anthropic (…)               │ 
                         └────────────────────────────────────────┘
```

## Tools

| Tool             | What it does                                                                 |
|------------------|------------------------------------------------------------------------------|
| `list_providers` | Discover which LLMs are currently available and which are in the active set.|
| `confer`         | Ask one or more providers the same question in parallel; return every answer.|
| `debate`         | Bounded round-trip debate; the configured moderator synthesises a result. Optional `structured: true` makes the synthesis a JSON-schema-validated object (consensus, dissent, key claims, citations, open questions). |
| `plan`           | Collaborative step-by-step planning with risks + alternatives. Honours `structured: true`. |
| `review`         | Peer code / proposal review across one or more LLMs. Pass `untrusted_input: true` when the snippet may contain prompt injections. |
| `coordinate`     | Structured **Proposer → Critic(s) → Synthesizer** flow. Each role emits a JSON envelope; the synthesizer emits a validated `StructuredSynthesis`. Persists key claims to the SQLite claim-list with `supports`/`attacks` edges when `session_id` is provided. |
| `triangulate`    | Run a coordinate flow and return **consensus + minority report** plus per-provider weights drawn from accumulated bench / critic-ballot win-rate. The "give me one answer, but be honest about disagreement" tool. |
| `delegate`       | Cross-model handshake: route a `confer` or `review` call through one named provider, with quota tracking by `session_id` and by requesting provider. Refused calls return `accepted: false` with a structured `reason` and the live quota envelope. |
| `bench`          | Run repo-scoped goldens (`*.json` in `.crosscheck/goldens/`) against a panel; rule-based verifiers (contains / regex_match / contains_any / contains_all / not_contains / min_length) score each provider, and the win-rate feeds `triangulate`'s weights. |
| `solve`          | Iterative **propose → verify → retry**. Provider drafts a literal solution; a `shell` (sandboxed subprocess: timeout, RLIMIT_AS, RLIMIT_CPU, isolated tmpdir) or `regex_response` verifier accepts or rejects; failures feed back to the next attempt. Pass `target_path` to also get a unified-diff `patch` preview (file is never modified). |
| `fetch`          | Retrieve a URL with **deny-by-default allowlist** (`fetch.url_allowlist` prefix list) and persist a sha256-keyed snapshot under `.crosscheck/evidence/`. Cached on repeat unless `force_refresh: true`. Use to ground claims with reproducible evidence. |
| `pick`           | **Multi-criteria decision-making.** Each provider scores every option on every criterion (0..1); the tool aggregates with criterion weights, returns a ranked list, and surfaces the top-K cross-provider disagreements as `dissent_deltas`. |
| `scoreboard`     | Read-only snapshot: per-provider weight + wins/losses/abstains + delegations, plus `totals` for sessions/claims/links/delegations and (optional) the last N redacted event lines. The data the UI panel reads. |
| `orchestrate`    | **Plan-then-execute** across sub-agents. The moderator decomposes a `goal` into a DAG of subtasks (or you pass a pre-authored `dag`), workers run in parallel where deps allow, and a final synth pass recombines node outputs into a coherent deliverable. Each node declares `difficulty: low\|med\|high` — with `cheap_mode: true` the router picks the cheapest registered model in that tier (scoreboard win-rate breaks ties within-tier only). Default failure semantics: partial-recombine with `[MISSING: node_id]` markers; set `fail_fast: true` for strict workflows. |
| `audit`          | **Post-run rubric scoring**. Audits an output (from `output_to_audit`, or pulled from the latest transcript for `session_id`) against a rubric. The auditor is selected to **exclude** the `producing_panelists` so a model cannot grade its own work (override with `allow_self_audit: true`). Default rubric covers factual grounding, constraint adherence, PII leak, internal consistency, open-question coverage, and actionability — override with `rubric: [...]`. Audit cost rolls up under the same `session_id` tagged `purpose: "audit"`. |
| `create` / `create_cheap` | **End-to-end macro tool**. Takes one high-level `instruction` and drives the full lifecycle: ingest documents → confer for scope → orchestrate the build → review → audit, all under a single `session_id`. On audit failure, `create` injects the audit feedback as constraints and runs orchestrate one more time, then re-audits; `create_cheap` defaults `cheap_mode: true` and suppresses the retry to honor cost. Supports `target_path` (write deliverable to disk), `dry_run`, `skip_audit`/`skip_review`, and `documents` (file paths or URLs — URLs go through the `fetch` allowlist). Status is one of `success | audit_failed | audit_failed_after_retry | error`. |
| `update_crosscheck` | Compares your local git HEAD against `main` at https://github.com/fxspeiser/crosscheck-agent. With `apply: true`, runs `git pull --ff-only` in the install directory; the server can't reload itself, so the response asks you to restart Claude Code. The first crosscheck call per server process runs the same check (cached 6h) and attaches an `update_notice` to the result so Claude can offer the upgrade proactively. |

### Usage + cost reporting

Every multi-LLM tool returns a `usage` block (per-call, per-provider, totals
incl. estimated USD cost from [`config/pricing.json`](config/pricing.json))
and a `timing` block (per-call + total `wall_ms` / `cpu_ms`). Sessions
accumulate the same totals so you can see lifetime spend per `session_id`.

```jsonc
// trailing fields on every confer / debate / plan / coordinate / pick /
// solve / bench / orchestrate / audit response:
"usage": {
  "by_call": [
    { "provider": "anthropic", "model": "claude-opus-4-5",
      "prompt_tokens": 1200, "completion_tokens": 340, "cached_tokens": 0,
      "total_tokens": 1540, "cost_usd": 0.0435, "estimated": false,
      "purpose": "confer" },
    { "provider": "openai", "model": "gpt-5",
      "prompt_tokens": 1100, "completion_tokens": 290, "cached_tokens": 200,
      "total_tokens": 1390, "cost_usd": 0.00885, "estimated": false,
      "purpose": "confer" }
  ],
  "by_provider": [
    { "provider": "anthropic", "calls": 1, "total_tokens": 1540, "cost_usd": 0.0435, ... },
    { "provider": "openai",    "calls": 1, "total_tokens": 1390, "cost_usd": 0.00885, ... }
  ],
  "totals": {
    "prompt_tokens": 2300, "completion_tokens": 630, "cached_tokens": 200,
    "total_tokens": 2930, "cost_usd": 0.05235, "estimated": false, "calls": 2
  }
},
"timing": { "wall_ms": 8240, "cpu_ms": 145,
            "by_call": [ {"provider":"anthropic","model":"...","purpose":"confer","wall_ms":7900,"cpu_ms":78,"cache_hit":false}, ... ] },
"budget": { "wall_used_ms": 8240, "cpu_used_ms": 145,
            "total_tokens": 2930, "total_cost_usd": 0.05235, "cost_estimated": false, ... }
```

Sessions are persisted in SQLite (`.crosscheck/sessions.sqlite3`) and gain six
new totals columns: `total_prompt_tokens`, `total_completion_tokens`,
`total_cached_tokens`, `total_tokens`, `total_cost_usd`, `total_cpu_ms`. A new
`usage_log` table holds one row per provider call so you can drill down by
`purpose` (`worker | moderator | synth | audit | confer | debate | ...`).

Pricing is configurable. Set `CROSSCHECK_PRICING_PATH=/path/to/pricing.json`
to override the bundled table. Missing-model lookups return `cost: 0,
estimated: true` with a logged warning rather than failing the call — so
experimenting with a brand-new model never blocks on out-of-date pricing.

### Live progress

When an MCP client passes `_meta.progressToken` with a tool call, the server
emits `notifications/progress` JSON-RPC messages as each node / round / synth
step runs. Whether or not a token is supplied, the same events are also
written as structured JSON lines to stderr — so they appear in your MCP debug
pane regardless of client support.

Sample stderr stream for `orchestrate(goal=…, cheap_mode=true)`:

```
{"kind":"progress","step":1,"wall_ms":0,   "cpu_ms":0,  "message":"orchestrate: starting (moderator=anthropic, cheap_mode=true, fail_fast=false)"}
{"kind":"progress","step":2,"wall_ms":12,  "cpu_ms":4,  "message":"orchestrate: planner drafting DAG"}
{"kind":"progress","step":3,"wall_ms":3400,"cpu_ms":45, "message":"orchestrate: node fetch -> openai:gpt-4o-mini (low)"}
{"kind":"progress","step":4,"wall_ms":3401,"cpu_ms":45, "message":"openai: dispatch","provider":"openai","model":"gpt-4o-mini","purpose":"worker"}
{"kind":"progress","step":5,"wall_ms":4242,"cpu_ms":62, "message":"openai: ok (841ms wall / 17ms cpu, 312 tok, $0.0001)"}
{"kind":"progress","step":6,"wall_ms":4243,"cpu_ms":62, "message":"orchestrate: node draft -> anthropic:claude-sonnet-4-5 (med)"}
{"kind":"progress","step":7,"wall_ms":4244,"cpu_ms":62, "message":"anthropic: dispatch","provider":"anthropic","model":"claude-sonnet-4-5","purpose":"worker"}
{"kind":"progress","step":8,"wall_ms":8108,"cpu_ms":129,"message":"anthropic: ok (3864ms wall / 67ms cpu, 1827 tok, $0.0274)"}
{"kind":"progress","step":9,"wall_ms":8109,"cpu_ms":129,"message":"orchestrate: recombining","missing":[],"partial":false}
{"kind":"progress","step":10,"wall_ms":11823,"cpu_ms":171,"message":"orchestrate: done (2/2 ok, 11823ms wall / 171ms cpu, $0.0421)"}
```

Each line carries running wall and CPU time so you can watch local overhead
vs. upstream LLM latency in real time.

### Sub-agent orchestration (`orchestrate`)

`orchestrate` decomposes a goal into a small DAG of subtasks, dispatches
workers in parallel where dependencies allow, and recombines node outputs
into one coherent deliverable. You can hand it a `goal` (and let the
moderator plan the DAG) or pass a pre-authored `dag` to skip the planning
round entirely — useful for tests and deterministic workflows.

**Node shape:**

```jsonc
{
  "id":         "fetch_facts",
  "task":       "Summarize the spec at https://example.com/spec",
  "difficulty": "low",                  // routes via cheap-mode tier ladder
  "depends_on": [],                     // upstream node ids; empty = root
  "role":       "researcher",           // free-form label surfaced in prompt
  "provider":   "openai",               // optional pin; overrides cheap-mode
  "model":      "gpt-4o-mini"           // optional pin
}
```

**Example — pre-authored DAG with cheap-mode routing:**

```jsonc
orchestrate({
  "session_id": "auth-migration-1",
  "cheap_mode": true,
  "dag": {
    "summary": "draft the auth migration",
    "nodes": [
      { "id": "fetch",   "task": "Extract endpoints + auth scheme from openapi.yaml", "difficulty": "low" },
      { "id": "risks",   "task": "List rollout risks for an opaque-token migration",   "difficulty": "med", "depends_on": ["fetch"] },
      { "id": "rollback","task": "Draft a 1-page rollback runbook",                    "difficulty": "med", "depends_on": ["fetch"] },
      { "id": "summary", "task": "Combine into a stakeholder one-pager",               "difficulty": "high","depends_on": ["risks","rollback"] }
    ]
  }
})
```

Response sketch:

```jsonc
{
  "tool": "orchestrate",
  "dag":   { ... echoed back ... },
  "nodes": [
    { "id":"fetch",   "status":"ok","provider":"openai",   "model":"gpt-4o-mini",         "output":"...","wall_ms":840,  "cpu_ms":17 },
    { "id":"risks",   "status":"ok","provider":"anthropic","model":"claude-sonnet-4-5",   "output":"...","wall_ms":3120, "cpu_ms":52 },
    { "id":"rollback","status":"ok","provider":"anthropic","model":"claude-sonnet-4-5",   "output":"...","wall_ms":2870, "cpu_ms":47 },
    { "id":"summary", "status":"ok","provider":"anthropic","model":"claude-opus-4-5",     "output":"...","wall_ms":5400, "cpu_ms":91 }
  ],
  "final":      "Combined one-pager…",
  "missing":    [],
  "partial":    false,
  "fail_fast":  false,
  "cheap_mode": true,
  "usage":  { "totals": { "total_tokens": 9420, "cost_usd": 0.0512, ... }, ... },
  "timing": { "wall_ms": 12230, "cpu_ms": 207, "by_call": [...] }
}
```

**Failure semantics — partial-recombine by default:**

```jsonc
// If `fetch` fails, downstream still runs. `final` carries explicit gaps.
{
  "nodes": [
    { "id":"fetch", "status":"failed", "error":"HTTP 503: ..." },
    { "id":"risks", "status":"ok",     "output":"..." }
  ],
  "missing": ["fetch"],
  "partial": true,
  "final":   "...[MISSING: fetch — HTTP 503: ...]..."
}
```

Pass `fail_fast: true` for strict workflows — failed upstream marks
downstream nodes `skipped` instead of running them.

**Cheap-mode router** picks the cheapest registered model in each node's
declared difficulty tier from `config/pricing.json` (`_tiers.low / med /
high`). Caller pins (`node.provider` + `node.model`) always win over the
router. Scoreboard win-rate (provider_stats) is used only as a tie-breaker
between identically-priced models in the same tier — never to override the
tier itself.

### One-shot lifecycle (`create` / `create_cheap`)

When you have a high-level instruction and want the **whole** plan-build-review-audit lifecycle in one call, use `create`. It chains: ingest → confer (scope) → orchestrate → review → audit, all under one `session_id` so total cost rolls up cleanly. On audit failure it auto-retries once with the audit feedback injected as constraints. `create_cheap` is the cost-aware variant — `cheap_mode: true` by default, and audit-retry is suppressed.

**Example — the worked case from the panel:**

```jsonc
create({
  "instruction": "Tie all features in the project to rules and regulations mentioned in the project documents.",
  "documents":   ["docs/compliance.md", "docs/security_policy.md", "https://example.org/spec.html"],
  "providers":   ["openai", "anthropic", "xai"],
  "target_path": "REPORTS/feature_compliance_matrix.md",
  "audit_threshold": 0.75
})
```

DAG the planner typically produces for this instruction (5 nodes):

1. **extract_regulations** (`low`) — pull rule IDs and clauses from the documents
2. **extract_features** (`low`) — inventory features from the codebase summary
3. **map_features_to_rules** (`med`) — produce a traceability matrix with citations
4. **gap_analysis** (`med`) — flag unmapped features, low-confidence links
5. **packaging** (`high`) — emit the final report in the requested format

Response sketch:

```jsonc
{
  "tool":     "create",
  "status":   "success",
  "session_id": "create-1748000000-7a3f",
  "attempts": 1,
  "documents_ingested": [
    { "source": "docs/compliance.md",     "type": "file", "status": "ok", "bytes": 4827,  "hash": "..." },
    { "source": "https://example.org/spec.html", "type": "url", "status": "ok", "bytes": 12480, "truncated": false }
  ],
  "scope_summary": "[openai] 5 sub-tasks: extract regs, extract features, ...",
  "dag":   { "nodes": [ {"id":"extract_regulations","difficulty":"low",...}, ... ] },
  "nodes": [ {"id":"extract_regulations","status":"ok","provider":"openai","wall_ms":840,...}, ... ],
  "final": "# Feature Compliance Matrix\n\n| feature | rules | citation |...",
  "audit": { "overall_score": 0.86, "passed": true, "items": [...] },
  "artifacts": [ {"path":"REPORTS/feature_compliance_matrix.md", "bytes": 8420} ],
  "usage":  { "totals": { "total_tokens": 18420, "cost_usd": 0.214 } },
  "budget": { "wall_used_ms": 31200, "cpu_used_ms": 320, "total_cost_usd": 0.214 }
}
```

Use `create_cheap` for the same instruction at a fraction of the cost — it routes each node to the cheapest model in its declared difficulty tier:

```jsonc
create_cheap({
  "instruction": "Tie all features in the project to rules and regulations mentioned in the project documents.",
  "documents":   ["docs/compliance.md", "docs/security_policy.md"]
})
```

### Coalesced multi-judge audit (the "no auditor available" fix)

By default `audit` picks **one** judge outside the producing panel. When the producing panel exhausts the registered pool (every provider was on the panel that produced the answer), the old `no auditor` error becomes a **graceful self-audit** via `mode: "coalesced_self"`. You can also opt in to coalesce mode explicitly with `coalesce: true` to get a multi-judge audit even when an outside auditor exists — useful when you want cross-judge agreement signal.

**What coalesce mode gives you:**
- All judges run **in parallel** (`ThreadPoolExecutor`, max bounded by `max_judges`, default 4).
- Per rubric item: **median** score, **majority pass-vote** (tie-break on score ≥ 0.7), `disputed: bool` (stddev > 0.3 at N ≥ 3, or range > 0.4 at N = 2), and a full `per_judge[]` breakdown.
- Top-level signals — `obvious_failures: [item_id]` (any judge scored < 0.3 on a high-severity item, or < 0.2 on med), `disagreements: [item_id]`, and `audit_process_failure: bool` (set when fewer than `ceil(N/2)` judges produced a valid response — i.e. the audit *process* itself failed, separate from the audited content failing).
- `strict_mode: true` flips the per-item rule to **all judges must pass** that item (including no parse-failures); top-level `passed` then requires all items to pass.

**Convention:** before invoking `audit` from a script or agent, you should typically ask the user whether they want strict mode — it's a substantively stricter bar.

### Run summary on every multi-LLM response

Every `confer` / `debate` / `plan` / `review` / `coordinate` / `triangulate` / `pick` / `solve` / `bench` / `orchestrate` / `audit` / `create` / `create_cheap` response now carries a `run_summary` block — pre-rendered ASCII tree plus structured rows for programmatic consumption. When a `session_id` is passed, the rollup is **session-scoped** (covers every call ever made under that id from `usage_log`); otherwise it's just this call.

```
session: create-feature-design-1   (5 calls, 17,841 tokens, $0.1253, 115.3s wall, 0.172s cpu)
  |- confer          2 calls     4,986 tok   $  0.0561     53.4s wall    0.083s cpu
  |- review          2 calls     7,424 tok   $  0.0640     75.7s wall    0.069s cpu
  `- audit           1 call      4,860 tok   $  0.0052     18.6s wall    0.010s cpu
```

Programmatic view:

```json
"run_summary": {
  "session_id": "create-feature-design-1",
  "tool":       "create",
  "scope":      "session",
  "currency":   "USD",
  "started_at": "2026-05-21T17:10:14Z",
  "ended_at":   "2026-05-21T17:12:09Z",
  "rows":   [{"purpose":"confer","calls":2,"prompt_tokens":1836,"completion_tokens":3150,
              "total_tokens":4986,"cost_usd":0.0561,"wall_ms":53400,"cpu_ms":83, ...}, …],
  "totals": {"calls":5,"total_tokens":17841,"cost_usd":0.1253,"wall_ms":115289,"cpu_ms":172},
  "text":   "session: …\n  |- confer …"
}
```

### Post-run audit (`audit`)

`audit` runs an independent rubric pass over an output (from
`output_to_audit`, or pulled from the latest transcript for a given
`session_id`). The auditor is selected to **exclude** the providers that
produced the output so a model cannot grade its own work.

**Default rubric** (6 items):

| id | severity | what it checks |
|---|---|---|
| `factual_grounding`      | high | Claims grounded in evidence; no hallucinated APIs |
| `constraint_adherence`   | high | Respects stated user constraints (scope, language, format, budget) |
| `no_pii_leak`            | high | No leaked emails, secrets, IPs, etc. |
| `internally_consistent`  | med  | Later statements don't contradict earlier ones |
| `covers_open_questions`  | med  | Surfaces unresolved trade-offs, doesn't paper over them |
| `actionability`          | low  | Concrete and actionable for the stated audience |

Override with `rubric: [{id, description, severity}, ...]` to drop in your
own criteria (e.g. compliance checks for your domain).

**Example:**

```jsonc
audit({
  "session_id": "auth-migration-1",
  "producing_panelists": ["openai", "anthropic", "xai"],
  "constraints": "Zero downtime; 3M active users; Postgres-backed sessions.",
  "cheap_mode": true
})
```

Response sketch:

```jsonc
{
  "tool":  "audit",
  "auditor": { "provider": "gemini", "model": "gemini-2.5-pro" },
  "items": [
    { "id":"factual_grounding",    "score":0.92, "pass":true,  "rationale":"All claims traceable to spec section refs.", "severity":"high" },
    { "id":"constraint_adherence", "score":0.85, "pass":true,  "rationale":"Migration plan respects zero-downtime constraint.",        "severity":"high" },
    { "id":"no_pii_leak",          "score":1.0,  "pass":true,  "rationale":"No PII present in the plan.",                              "severity":"high" },
    { "id":"internally_consistent","score":0.78, "pass":true,  "rationale":"One small inconsistency around token TTL.",                "severity":"med" },
    { "id":"covers_open_questions","score":0.62, "pass":false, "rationale":"Doesn't surface the dual-write window risk.",              "severity":"med" },
    { "id":"actionability",        "score":0.90, "pass":true,  "rationale":"Each step has an owner and exit criterion.",               "severity":"low" }
  ],
  "overall_score": 0.845,
  "passed": false,
  "usage": { "by_call": [{ "provider":"gemini","purpose":"audit", ... }], "totals": { "total_tokens": 1820, "cost_usd": 0.00228, ... } }
}
```

Audit cost rolls up under the **same** `session_id` tagged
`purpose: "audit"`, so audit spend is attributable but doesn't fragment your
session billing.

When every registered provider is on the producing panel, audit returns a
structured `no auditor` error rather than running anyway. The escape hatch
is `allow_self_audit: true` — explicit, never silent.

### Ad-hoc panels

`confer`, `debate`, `plan`, and `review` all accept an optional `providers`
array so you can assemble a panel on the fly instead of using the configured
active set. Some useful patterns from inside Claude Code:

```
# "I want a fast second opinion from Grok only, skip everyone else."
confer(question="…", providers=["xai"])

# "Pit GPT against Gemini, let OpenAI moderate."
debate(topic="…", providers=["openai", "gemini"], moderator="openai")

# "Review this diff with just my local-fast models."
review(snippet="…", providers=["groq", "deepseek"])

# "Plan the migration; I want every model in the house."
plan(goal="…", providers=["anthropic","openai","xai","gemini","mistral","groq","deepseek"])
```

Not sure what's wired up? Call `list_providers` first — it returns every
known provider, whether it has an API key in `.env`, and whether it's in
the configured active set. If you ask for a provider that has no key,
`crosscheck` returns a structured error telling you exactly what's missing
so Claude can self-correct.

Every run obeys the limits in `crosscheck.config.json`:

- `max_rounds` — hard cap on unsupervised round trips.
- `token_cap` — total token budget spread across providers × rounds.
- `max_time_seconds` — wall-clock deadline enforced per run.
- `cache.{enabled,ttl_seconds,max_entries,dir}` — SHA256 exact-match disk cache for provider responses. Cached calls return with `cache_hit: true` and `elapsed_ms: 0`. LRU eviction at write time; default TTL 7 days.
- `retries.{max_attempts,backoff_base_s}` — jittered exponential backoff on transient HTTP errors (429, 5xx, network, timeout). Honours upstream `Retry-After`.
- `rate_limits.{<provider>|default}.{capacity,refill_per_sec}` — per-provider leaky-bucket rate limiter.
- `redaction.{enabled,patterns_extra}` — regex scrub for emails, IPv4, AWS keys, GitHub PATs, Slack tokens, OpenAI keys, bearer tokens, 16-digit cards. Applied recursively to ndjson event records and to JSON transcripts at write time.
- `provider_allowlist` — null = no restriction; otherwise the array is the only set of providers that may run, even when callers ask for others. Blocked providers surface in `blocked_by_allowlist`.
- `events_log` — path to the ndjson event trace (one structured event per `tool_start` / `provider_call` / `tool_end`). Use `scripts/replay` to inspect.
- `delegation.{max_per_session,max_per_requester}` — quota knobs for the `delegate` tool.
- `bench.goldens_dir` — directory holding bench fixtures.

Every tool result includes a `budget` block (`wall_used_ms`, `wall_remaining_ms`, `cache_hits`, `provider_calls`). When `session_id` is supplied, a `session` block carries cumulative `{calls, wall_ms, cache_hits}` across calls — backed by SQLite at `.crosscheck/sessions.sqlite3` (override via `session_db`).

## Asking Claude to use it

Once the MCP server is registered, you don't call the tools by hand — Claude
does, based on what you say. A few prompts that work well inside Claude Code:

**Quick sanity check across the panel**

> "Confer with the panel: is a `uuid.v7()` primary key a bad idea for a
> high-write Postgres table?"

**Pick a specific model on the fly**

> "Ask Grok only — what's the cheapest way to shard this Redis cluster?"

> "Just confer with GPT and Gemini on whether this regex is ReDoS-safe."

**Debate between specific peers**

> "Debate this with OpenAI and Gemini, let Claude moderate: should we use
> Server-Sent Events or WebSockets for the notification stream?"

**Plan with a hand-picked team**

> "Plan the auth migration with Anthropic, OpenAI, and xAI. Constraint: zero
> downtime, Postgres-backed sessions, 3M active users."

**Peer code review**

> "Have Groq and DeepSeek review this migration for race conditions:
> `<paste SQL>`"

**Discover what's wired up**

> "List the providers crosscheck has available and tell me which ones are
> missing an API key."

**Structured coordination (Proposer → Critic → Synthesizer)**

> "Coordinate this with anthropic, openai, and gemini, session_id=auth-rewrite-1: 'should we move from JWT to opaque tokens for our internal-API auth?'"

**Triangulate when you want consensus + dissent**

> "Triangulate across the panel: what's the right batch size for our embedding pipeline given a 16GB GPU and 4M docs?"

**Cross-model delegation**

> "Delegate this code review to xai with requested_by=anthropic, session_id=migrations-2: paste-the-SQL-here."

**Bench the panel**

> "Run bench against alpha, beta, gamma using the goldens in .crosscheck/goldens/ and rank them."

**Orchestrate a sub-agent DAG with cheap-mode routing**

> "Orchestrate this in cheap mode, session_id=auth-1: 'draft a migration plan from JWT to opaque session tokens, including risks and a rollback runbook'."

> "Run this DAG against the panel — fetch endpoints (low), draft risks and rollback in parallel (med), then summarize (high). cheap_mode=true."

**Strict mode when partial answers are useless**

> "Plan-then-execute the cutover. fail_fast=true; I'd rather see what blocked than a Frankenstein summary."

**Audit the panel's output**

> "Audit the last session (session_id=auth-1). Producing panelists were anthropic, openai, xai. Constraint: zero downtime."

> "Audit this paragraph against our internal compliance rubric — rubric=[{id:'cites_sources', ...}, {id:'no_eu_pii', ...}]"

**Check spend on a session**

> "What did session auth-1 cost so far? Show per-provider tokens and dollars."  *(Claude pulls the totals from the session row.)*

**Self-update**

> "Check whether crosscheck-agent has an update."  *(if Claude already saw an `update_notice` on a previous tool call, it will surface it without prompting.)*

> "Yes, upgrade it."  → Claude calls `update_crosscheck` with `apply: true`, then reminds you to restart Claude Code so the new server code loads.

**Replay the event log**

```bash
scripts/replay --tail 50                # last 50 events
scripts/replay --tool coordinate        # only coordinate events
scripts/replay --provider gemini        # all Gemini calls
scripts/replay --kind provider_call --since 5m
```

Claude will call `list_providers`, `confer`, `debate`, `plan`, `review`,
`orchestrate`, `audit` (etc.) under the hood, pass the subset you named, and
stream the responses back. If you name a provider that isn't configured,
crosscheck returns a structured error so Claude can ask you what to do
instead of guessing.

## Quick start

```bash
git clone https://github.com/<you>/crosscheck-agent.git
cd crosscheck-agent

# 1. Interactive setup — writes .env + crosscheck.config.json
bash scripts/setup.sh

# 2. Sanity-check the server starts
python3 servers/python/crosscheck_server.py

# 3. Register with Claude Code
claude mcp add crosscheck -- python3 "$PWD/servers/python/crosscheck_server.py"
```

Then inside Claude Code:

```
/mcp
# call confer / debate / plan / review
```

Requires Python 3.10+. No `pip install` needed.

## Tuning limits from the terminal

The `scripts/crosscheck` CLI edits `crosscheck.config.json` in place.

```bash
scripts/crosscheck config show
scripts/crosscheck config set max_rounds 5
scripts/crosscheck config set token_cap 16000
scripts/crosscheck config set max_time_seconds 300
scripts/crosscheck config set providers anthropic,openai,xai,gemini
scripts/crosscheck config set moderator openai

scripts/crosscheck providers list
scripts/crosscheck providers enable gemini
scripts/crosscheck providers disable xai

scripts/crosscheck doctor     # audit: keys present, config sane
```

Optionally add this line to your shell rc file to make the CLI globally available:

```bash
export PATH="$PATH:/path/to/crosscheck-agent/scripts"
```

## Providers

| Provider   | Env var              | Default model             | Endpoint                |
|------------|----------------------|---------------------------|-------------------------|
| Anthropic  | `ANTHROPIC_API_KEY`  | `claude-opus-4-5`         | native                  |
| OpenAI     | `OPENAI_API_KEY`     | `gpt-5`                   | Chat Completions        |
| xAI (Grok) | `XAI_API_KEY`        | `grok-4-latest`           | OpenAI-compatible       |
| Google     | `GEMINI_API_KEY`     | `gemini-2.5-pro`          | Gemini API              |
| Mistral    | `MISTRAL_API_KEY`    | `mistral-large-latest`    | OpenAI-compatible       |
| Groq       | `GROQ_API_KEY`       | `llama-3.3-70b-versatile` | OpenAI-compatible       |
| DeepSeek   | `DEEPSEEK_API_KEY`   | `deepseek-chat`           | OpenAI-compatible       |

Any provider without a key in `.env` is silently skipped.

## Configuration

`crosscheck.config.json`:

```json
{
  "max_rounds": 3,
  "token_cap": 8000,
  "max_time_seconds": 120,
  "providers": ["anthropic", "openai", "xai"],
  "moderator": "anthropic",
  "temperature": 0.4,
  "log_transcripts": true,
  "transcript_dir": ".crosscheck/transcripts"
}
```

When `log_transcripts` is on, every conferral / debate is persisted as JSON
under `.crosscheck/transcripts/` (also gitignored).

### Picking a sensible `token_cap`

`token_cap` is the total completion-token budget for a single tool call,
split across providers × rounds. The default (60000, for coding work) gives
each call ~6.6k tokens with the default 3 rounds × 3 providers.

One gotcha worth knowing: OpenAI's GPT-5 and o-series are **reasoning
models**. crosscheck-agent reserves `max_completion_tokens` per call, and
OpenAI counts that reservation against your tier's per-request / per-minute
limit *before* the call runs. On lower usage tiers, a 6.6k reservation can
trip a 429. If you see `HTTP 429: exceeded your current quota` on OpenAI
only (Anthropic + xAI still work), drop the cap:

```bash
scripts/crosscheck config set token_cap 20000   # ~2.2k per call
```

Or raise your OpenAI usage tier. crosscheck-agent automatically uses
`max_completion_tokens` and omits `temperature` when the model name starts
with `gpt-5`, `o1`, `o3`, or `o4`.

## Layout

```
crosscheck-agent/
├── .env.example
├── crosscheck.config.example.json
├── scripts/
│   ├── setup.sh            # interactive wizard
│   └── crosscheck          # config + providers CLI
└── servers/
    └── python/             # stdlib-only MCP server (canonical)
```

## Security

- `.env` is gitignored. The setup wizard chmods it to `600`.
- The `crosscheck` CLI never prints API keys, only whether they exist.
- Keys are read at startup and never written anywhere except stderr on an
  HTTP error (which may echo the remote error payload — be mindful if you
  pipe logs to third-party tools).

## Contributing

Issues and PRs welcome. Keep the tool surface (`list_providers`, `confer`,
`debate`, `plan`, `review`, `coordinate`, `triangulate`, `delegate`, `bench`,
`solve`, `fetch`, `pick`, `scoreboard`, `orchestrate`, `audit`,
`update_crosscheck`) backwards-compatible and dependency-light — Python
stdlib only. New fields on existing responses are fine if additive; renames
and removals are not.

## Credits

Built by [Frank Speiser](https://github.com/fspeiser) with pair-programming
assistance from Claude (Anthropic). Mistakes are Frank's; good ideas are shared.

## License

MIT. See [LICENSE](LICENSE).
