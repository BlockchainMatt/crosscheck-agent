# crosscheck-agent

Confer with multiple LLMs from inside Claude Code. `crosscheck-agent` is a
compact MCP server that lets Claude ask peers from other model families
(GPT, Grok, Gemini, Mistral, Groq, DeepSeek) to reason, debate, plan, and
peer-review — then hands the synthesised answer back to Claude.

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
| `update_crosscheck` | Compares your local git HEAD against `main` at https://github.com/fxspeiser/crosscheck-agent. With `apply: true`, runs `git pull --ff-only` in the install directory; the server can't reload itself, so the response asks you to restart Claude Code. The first crosscheck call per server process runs the same check (cached 6h) and attaches an `update_notice` to the result so Claude can offer the upgrade proactively. |

### Usage + cost reporting

Every multi-LLM tool now returns a `usage` block (per-call, per-provider, totals
incl. estimated USD cost from [`config/pricing.json`](config/pricing.json)) and
a `timing` block (per-call + total `wall_ms` / `cpu_ms`). Sessions accumulate
the same totals so you can see lifetime spend per `session_id`.

Set `CROSSCHECK_PRICING_PATH=/path/to/pricing.json` to override the bundled
table. Missing-model lookups return `cost: 0, estimated: true` with a logged
warning rather than failing the call.

### Live progress

When an MCP client passes `_meta.progressToken` with a tool call, the server
emits `notifications/progress` messages as each node / round / synth step
runs — including running CPU and wall time, tokens consumed, and cumulative
cost. Without a token, the same progress lines are written as structured
JSON to stderr so they appear in the MCP debug pane.

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

Claude will call `list_providers`, `confer`, `debate`, `plan`, or `review`
under the hood, pass the subset you named, and stream the responses back.
If you name a provider that isn't configured, crosscheck returns a
structured error so Claude can ask you what to do instead of guessing.

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

Issues and PRs welcome. Keep the tool surface (`confer`, `debate`, `plan`,
`review`, `list_providers`) stable and dependency-light. Python stdlib only.

## Credits

Built by [Frank Speiser](https://github.com/fspeiser) with pair-programming
assistance from Claude (Anthropic). Mistakes are Frank's; good ideas are shared.

## License

MIT. See [LICENSE](LICENSE).
