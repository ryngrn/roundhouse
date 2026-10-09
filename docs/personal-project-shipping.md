# Personal projects: ship-first policy

This is the default operating policy for Ryan's **personal, build-in-public** work:
Roundhouse, Portfolio (ryan.green), GrowthPath, Inclusion, Imarchy, kMac,
and other projects Ryan explicitly identifies as personal.

## Default behavior

1. Refine the request into executable work with acceptance criteria.
2. Execute autonomously when the scope is clear, reversible, and authorized.
3. Run applicable tests, build checks, and preview/browser checks when available.
4. When those checks pass, ship to the **project-configured destination**
   without requesting a redundant human approval. If that destination is only
   a branch, do not call the result production-deployed.
5. Verify the deployed destination and record what actually passed.
6. If a reversible low-risk defect appears, prefer an isolated fix-forward job
   rather than a permanent block or silent retry.
7. Report the deployed commit, result, and remaining unknowns.

## Human approval remains required

- Destructive data changes, repository deletion, force pushes, history rewriting,
  protected-branch rule changes, visibility or collaborator-permission changes.
- Exposure or rotation of credentials, personal data, or confidential client data.
- New recurring expenses or consequential external commitments.
- Irreversible migrations, risky infrastructure operations, and materially
  ambiguous product direction.
- Any project-specific rules that are stricter than this document.

**Client projects are not opted in.** Set their approvals and verification
requirements separately, with least-privilege access.

## Configuration contract

Roundhouse already supports `policy.allow_autonomous`,
`policy.approval_required`, `policy.review_after_shipping`,
`policy.continuation`, `policy.shipping`, and project-specific verification.
Do not globally turn off approval handling. For a personal project that already
has a verified CI/release path, an operator may use:

```yaml
policy:
  allow_autonomous: true
  approval_required: false
  review_after_shipping: false
  continuation: continue_project_queue
  shipping: push_branch  # or deploy ONLY with a configured, verified deployment
  max_rework_attempts: 1
```

The `push_branch` setting does not imply that the branch deploys to production.
The project must explicitly configure a supported deployment target and valid
verification before requesting `shipping: deploy`. Do not bypass protected
branches or existing guarded decision workflows.

## Evidence requirement

Record four distinct checkpoints: changes committed, preview checked, production
deployment completed, and public endpoint/browser verification. A failed or
unavailable checkpoint must be reported as such. Agent confidence is not
proof of a passing test or successful deploy.
