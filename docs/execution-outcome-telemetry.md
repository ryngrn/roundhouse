# Execution-path outcome telemetry

Roundhouse records a versioned `execution_outcome` on a terminal job when durable
evidence is sufficient to classify the path that actually completed, recovered,
or stopped. The job lifecycle state and the outcome answer different questions:
`Shipped` says the job is complete, while `execution_outcome` says how it became
complete. A Shipped flag alone never proves autonomous success.

The authoritative record lives with the job in local `state.json` or in the
PostgreSQL `roundhouse.execution_outcomes` table. Status, MCP, and the Control Room
are projections of that record. They must not invent missing provenance.

## Classification and precedence

Classification is evaluated in this order:

1. A job marked `historical_import` is not classified for metrics. This exclusion
   wins even if old state says Shipped.
2. A terminal Blocked or Archived job is `failed_or_abandoned` because the desired
   outcome was not completed.
3. A Shipped job with a human-task completion or explicit exception-completion
   annotation is `exception_success`. This takes precedence over recovery because
   the bypass is the material fact.
4. A Shipped job with confirmed recovery or reconciliation evidence is
   `recovered_success`.
5. A Shipped job is `native_success` only when every native provenance stage below
   is present and valid.
6. Any other job has no outcome yet. It is `unclassified`, not native success, and
   stays outside outcome-rate denominators until authoritative evidence is added.

The four terminal classifications mean:

- `native_success`: Roundhouse retained evidence for intake, dispatch, executor
  ownership, verification, and delivery, with no human intervention.
- `recovered_success`: Roundhouse completed the authoritative workflow after a
  stale, interrupted, or externally uncertain attempt was reconciled against
  durable evidence.
- `exception_success`: the desired result was achieved through an explicitly
  recorded manual or out-of-band path.
- `failed_or_abandoned`: the attempted result was not completed and the job ended
  Blocked or Archived.

## Evidence and execution path

Every outcome has `schema_version`, `recorded_at`, `recorded_by`, the actual
`execution_path`, `provenance`, intervention fields, and durable `evidence_links`.
Each path component uses a controlled kind and may identify provider, runtime,
machine, detail, and component-specific evidence. Supported path kinds are:

`local_codex`, `local_claude`, `local_command`, `herdr_codex`, `herdr_claude`,
`herdr_command`, `manual_rdc`, `direct_local_shell`, `chatgpt_execution`,
`manual_file_edits`, `operator_reconciliation`, `human_task`, and `other`.

Native success requires all five provenance stages, each with a timestamp and at
least one durable link:

| Stage | Required proof |
| --- | --- |
| `intake` | Authoritative Depot input and creation record |
| `dispatch` | Ready-to-Executing claim or equivalent dispatch transition |
| `executor_ownership` | Correlated run ID and invoked provider ownership |
| `verification` | Passing verification tied to the candidate identity |
| `delivery` | Confirmed delivery evidence for that verified candidate |

Recovered and exception outcomes preserve whatever Roundhouse provenance really
exists; they do not fill absent native stages. Recovery adds the reconciliation
step to the execution path. Exception completion requires an out-of-band path and
at least one supplied evidence link.

## Reasons, authorization, and intervention

`recovered_success`, `exception_success`, and `failed_or_abandoned` require a
structured reason code plus a nonempty freeform note. The taxonomy is:

- `stale_worker`
- `missing_capability`
- `provider_limit`
- `herdr_failure`
- `remote_completion_evidence_missing`
- `repository_lock`
- `credential_config_gap`
- `unsupported_action`
- `human_only_action`
- `control_plane_bug`
- `other`

The note records the concrete circumstance, not a restatement of the code.
`exception_expected` is required only for `exception_success`: `true` means the
exception was expected or authorized, while `false` means it was unexpected.
Authorization does not make an exception native.

`human_intervention_required` must equal whether `human_intervention_count` is
greater than zero. The count is the approximate number of distinct interventions,
not keystrokes or commands. `human_minutes` is optional and nonnegative; leave it
null when estimating it would add burden. Native success requires zero
interventions. Recovered work records the known reconciliation intervention count;
exception annotation requires at least one.

## Recording an exception completion

Use the revision-guarded annotation command when RDC, direct shell work, ChatGPT
execution, manual file edits, or another bypass produced the desired result:

```sh
node src/cli.js depot complete-exception --state-dir STATE --config CONFIG \
  --id JOB_ID --revision REVISION --annotation-id rdc-2026-10-08-1 \
  --path manual_rdc --reason missing_capability \
  --note "The configured worker could not operate the native application." \
  --expected false --interventions 1 --human-minutes 5 --actor operator \
  --evidence '[{"kind":"screenshot","uri":"roundhouse://evidence/rdc-2026-10-08-1"}]'
```

Only current Ready, Review, or Blocked jobs accept this transition. The stable
annotation ID makes exact retries idempotent; reuse with different content is
rejected. Missing evidence, invalid reasons, or a stale revision leaves the job
unchanged. A successful annotation records `exception_success`, changes the job to
Shipped, and uses the non-shipping `exception_annotation` policy with `pushed:
false`. It does not push, merge, deploy, or manufacture executor/verification
evidence.

## KPI definitions

Only valid, non-historical `execution_outcome` records are measured. A measured
completion is `native_success`, `recovered_success`, or `exception_success`.
`failed_or_abandoned` is measured in classification and trend totals but is not a
completed-job denominator.

`% tasks completed without intervention` and `native_path_success_rate` are the
same KPI:

```text
native_success count / measured completed outcome count
```

The denominator therefore includes native, recovered, and exception completions,
and excludes failed/abandoned, historical imports, and unclassified jobs. A legacy
Shipped job cannot raise either side of the ratio. Recovered-versus-bypassed uses
recovered plus exception completions as its denominator. Intervention average and
median use all measured completed jobs, including native jobs with zero. Human-time
statistics use only completed jobs whose estimate is present.

The projection also reports exception reasons and expected/unexpected counts,
daily and monthly trends, and classification/exception rates by project, executor,
provider, machine, runtime, and job type. Counts and denominators accompany rates.
The Control Room summary shows native-path rate, exception and recovery counts,
leading exception reasons, measurement coverage, and a job-level drill-down with
path, reason, interventions, provenance, and evidence counts.

## Migration and delivery behavior

The PostgreSQL migration creates a constrained, indexed outcome table without
retroactively labeling existing Shipped rows as native. During `state.json` to
PostgreSQL cutover, jobs with an existing valid outcome keep it. Jobs without one
receive `execution_outcome_exclusion: historical_import`; their lifecycle history
is preserved, but they cannot pollute newly measured rates. Newly terminal jobs are
classified from durable lifecycle records at the transition boundary.

Outcome telemetry does not broaden delivery authority. Normal code delivery
continues to use `commit_only` or `push_branch`; `push_branch` targets the job's
reviewable branch and never merges a default or protected branch. Exception
annotation is metadata-only delivery evidence and never pushes. The deterministic
acceptance fixture in `test/fixtures/execution-outcome-scenarios.json` proves native,
recovered, RDC exception, failed, historical, unclassified-Shipped, aggregation,
and Control Room projection behavior without contacting a remote or changing a
protected branch.
