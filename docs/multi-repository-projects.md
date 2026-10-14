# Multi-repository projects

A Roundhouse project is a durable product/work identity, not a Git checkout. It
may have zero, one, or many connected repositories while retaining one project
ID, work history, audit trail, intent model, and human review queue.

## Configuration

New configuration uses `repositories`. Every entry has a stable lowercase `id`, an optional readable `label`,
and an existing local `checkout_path`. Repository entries may override
`base_ref`, `remote`, `verification`, `policy`, `deployment`, and repository
context settings. Paths are resolved and validated when configuration loads.

```yaml
projects:
  - id: storefront
    name: Storefront
    purpose: Operate the customer storefront
    success_state: Changes are verified and reviewable
    status: active
    executor: { kind: codex, bin: codex }
    policy:
      allow_autonomous: false
      shipping: push_branch
    repositories:
      - id: api
        label: API
        checkout_path: ../storefront-api
        base_ref: main
        remote: origin
        verification:
          - id: api-tests
            command: [npm, test]
      - id: web
        label: Website
        checkout_path: ../storefront-web
        base_ref: main
        remote: origin
        verification:
          - id: web-check
            command: [npm, run, check]
```

The legacy `repository`, `base_ref`, `remote`, project `verification`, and
project shipping policy remain supported. They normalize to one repository with
ID `default`, preserving the prior execution, approval, verification, and
delivery behavior. A project must not mix secret material into repository
configuration; unknown repository fields are rejected.

## Work-item targeting and safety

Each planned slice records `repository_required` and `repository_id`.

- Repository-free research, strategy, and durable-output slices use
  `repository_required: false` and `repository_id: null`.
- A repository-required slice in a one-repository project safely inherits that
  sole stable ID.
- Every repository-required slice in a multi-repository project must name its
  repository. Roundhouse never chooses the first entry.
- An unknown ID, an ambiguous target, or a required repository in a zero-repo
  project produces Needs Clarification before any job is created or dispatched.
  The review tells the operator to connect an existing repository or perform a
  separately authorized create-and-connect setup action. Roundhouse neither
  creates a remote repository nor asks for credentials.

Cross-repository work is represented as separate ordered slices under the same
logical project. Each job persists its repository ID, resolved checkout,
verification set, base ref, remote, delivery authority, policy hash, and lock.
Recovery and reconciliation re-resolve the same ID and fail closed if its
binding or execution authority changed. Commits from a different repository are
not used as Git ancestry constraints.

## Public projection

The project projection exposes stable repository IDs, readable labels,
verification IDs, and shipping policy. Local checkout paths, remote credentials,
commands, tokens, and unrelated configuration are not included in the public
presentation payload. Job
rows expose the stable `repository_id`, so one project continues to feed one
review queue without obscuring the concrete execution target.

## Repository setup

New project initiation writes `repositories: []`. This supports useful
repository-free work immediately. Connecting a checkout later is an explicit
configuration/setup change: prepare or obtain the repository separately, add a
validated repository entry and its verification/delivery policy, then submit or
re-triage the code request. Remote creation, credential provisioning,
permissions, deployment, and rollout remain outside this workflow unless each
is separately authorized.

## Remaining rollout work

This change adds safe repository selection and the repository-setup **trigger**
for development slices with no checkout. The trigger is a focused Needs
Clarification review; it does not yet implement an automatic approved GitHub
repository creation, checkout linking, or guarded add/remove UI. Those should
be separate verified slices with explicit permissions and audit trails.
Likewise, migrating the existing Roundhouse and Roundhouse Dashboard project
records to one unified project is a subsequent reversible data migration,
not a side effect of enabling the schema.

Do not activate multi-repository dispatch on a live control plane until the
full external integration/acceptance suite has passed in its supported
environment. Existing single-repository installations remain supported.
