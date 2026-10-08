# Cost-aware recovery gap assessment

This assessment was performed read-only against the checksum manifest in the
2026-10-08 recovery bundle. All four listed files matched their SHA-256 digests.
The preserved patch was based on `12f9b6198cf53e709b4c6ecf987efb9b6830fc1c`,
so its historical test result is evidence about that base only.

The deleted job `a2cc59b6036a9aaa2dfcb6ad-1` was absent from authoritative
job state during this audit. This work does not restore, replay, reconcile, or
claim delivery for it. The required prerequisite, cheapest-sufficient routing
job `a2cc59b6036a9aaa2dfcb6ad-2`, was Shipped and its commit `21e56f7` is an
ancestor of this checkout.

## Preserved-change disposition

| Preserved area | Disposition | Reason |
| --- | --- | --- |
| Tier ranking, capability profiles, provider preferences, and routing evidence | Excluded | Shipped slice 2 already implements deterministic cheapest-sufficient routing with tier, risk, confidence, context, latency, and capability evidence. Reintroducing the older parallel policy would create two routing authorities. |
| Local capability and availability handling | Excluded | Shipped slice 3 implements live capability probing and safe escalation. |
| Per-attempt/project budgets and pre-dispatch estimates | Excluded | Slice 4 owns budget enforcement at dispatch boundaries. Its current Blocked state is not permission to bypass or duplicate it. |
| Compact context and configuration fingerprints | Excluded | Planned slice 5 owns reusable context and routing inputs. |
| Token/cost normalization, attempt usage, aggregation, and outcome telemetry | Excluded | Planned slice 6 owns paid and local usage capture. The recovered post-spend budget check is also too late to serve slice 4's dispatch-boundary outcome. |
| KPI and status-view projections | Excluded | Planned slice 7 owns cost-efficiency metrics and Control Room projection. |
| Broad compatibility and rollout fixtures | Excluded | Planned slice 8 owns end-to-end rollout proof. |
| Bounded explainable complexity record | Retained and rewritten | Neither the recovered work nor slices 2–8 define a request-level and package-level 0–100 score. Roundhouse now computes it from normalized decision and routing evidence without altering routing, budgets, usage capture, approval, action authority, provider capability checks, verification, secrets, quarantine, protected branches, or shipping. |

No recovered source file was copied. In particular, the archived `cost-policy.js`,
engine mutations, configuration extensions, usage aggregation, and view changes
remain excluded.

## Complexity scoring contract

A decision carries one computed `complexity` record for the complete request and
one for each independently executable `work_item`. Missing records remain readable
as `null` for compatibility with existing command providers and durable decisions.
Model-authored values are not used: after normalization, Roundhouse replaces them
with scores derived from request structure, project policy, verification
obligations, and the authoritative cheapest-sufficient routing result.

The seven fixed maximum contributions sum to 100:

| Factor | Weight |
| --- | ---: |
| Scope | 20 |
| Ambiguity | 15 |
| Dependencies | 15 |
| Risk | 15 |
| Verification burden | 15 |
| Local executor capability gap | 10 |
| Resource cost | 10 |

Each contribution is an integer from zero through its weight and includes a
concise evidence rationale. Scope counts normalized packages, acceptance criteria,
capabilities, repositories, and bounded text size. Ambiguity uses execution
confidence, context sufficiency, and unresolved questions. Dependencies count
declared and decomposition edges. Risk uses the highest normalized action class.
Verification burden counts configured check IDs, criteria, and repository work.
The local-capability gap maps the selected authoritative routing tier (mechanical
0, local 1, higher tiers progressively larger), while resource cost uses routing
tier, bounded work-text size, and counted resource types as a non-USD proxy.

The published score is the exact sum. Stable factor IDs, fixed weights, integer
arithmetic, sorted resource keys, canonical factor order, and no timestamps or
identifiers make rescoring stable for unchanged normalized evidence. Changed
requirements, project policy, executor advertisements, verification obligations,
or cost evidence may legitimately change a score.

The same record keeps the selected numeric tier, every eligible executor and why
it passed the existing gates, the selected executor and selection explanation, a
nullable USD prediction with its basis, and a nullable actual outcome. When no
trusted USD estimate is configured the value is explicitly `null`, never guessed.
On terminal delivery or blocking, Roundhouse records a compact status and summary;
it copies a numeric actual cost only when execution evidence already supplies one,
without retaining arbitrary provider payloads or implementing usage aggregation.
Slice 6 remains responsible for trustworthy usage capture. Executor eligibility
remains subordinate to capability, approval, action, and project policy gates; a
score never grants authority or replaces cheapest-sufficient selection.
