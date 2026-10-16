# Project repository connections

A project is a durable product identity with zero, one, or many connected GitHub
repositories. Roundhouse's canonical project ID is `roundhouse`; both repositories
belong to that product:

```yaml
projects:
  - id: roundhouse
    name: Roundhouse
    purpose: Turn human intent into useful verified work
    success_state: Useful work is reviewable
    status: active
    repositories:
      - id: core
        github_url: https://github.com/ryngrn/roundhouse
      - id: dashboard
        github_url: https://github.com/ryngrn/roundhouse.ryan.green
```

Each repository has a stable lowercase `id`, a `github_url`, and an optional
`label` and local `checkout_path`. HTTPS, GitHub SCP-style SSH, and SSH URLs
normalize to credential-free HTTPS repository URLs. Credentials, query strings,
fragments, and non-GitHub hosts are rejected. Remote-only entries carry connection
metadata; local checkout entries continue to require the existing verification
configuration. The Git remote name (`remote: origin`) is separate from `github_url`.
Existing local-only entries remain supported, as does the singular local
`repository` property (stable repository ID `default`). Use `repositories: []`
for a project with no repositories. IDs must remain stable when paths change.

The public project projection includes repository IDs, labels, normalized GitHub
URLs, and existing verification IDs/shipping labels. It omits local paths and
credentials for configured and stored-only projects. The legacy public
`repository` field is always null. Durable connections supplement narrower
configuration by stable ID, so loading a core-only configuration does not erase
the dashboard connection. Repository changes affect the projection revision.
Storage also keeps `repository_connections` because older execution code uses
`repositories` as an operational state map. That map is retained verbatim;
configuration and public responses use the repository list.

This model change does not change execution targeting, scheduling, dispatch,
approval, or deployment. A remote connection alone does not provision a checkout.
The existing self-development manifest is deliberately left unchanged: replacing
its execution configuration with the metadata example above is a separate change.

## Offline Roundhouse identity proposal

The opt-in script operates only on an exported version 1 storage snapshot:

```sh
node scripts/prepare-roundhouse-repositories.mjs snapshot.json proposed.json
diff -u snapshot.json proposed.json
```

It never connects to a database. It creates a new file with mode 0600, refuses to
overwrite files, and leaves the input untouched. Both exports contain private
state; keep them outside version control. Running the transform again is
idempotent. Existing IDs for matching URLs are retained; conflicting `core` or
`dashboard` IDs cause an error for manual review. Existing local/singular
repositories, features, goals, changelogs, other projects, assignments, and jobs
are preserved. A missing canonical record is added with ID `roundhouse`; an
existing canonical record keeps its information and increments its revision only
when changed.

Historical dashboard project records remain intact. This proposal associates
both remotes with `roundhouse`; it does not silently merge project histories,
rewrite old assignments, or replan work. Any consolidation of those records needs
its own reviewed mapping.

For local storage, prepare the proposal from a consistent backup, review the
diff, and obtain approval before replacing any live snapshot with the reviewed
file while writers are stopped. Preserve the backup for rollback.

For PostgreSQL, first obtain a consistent export using the existing storage
snapshot interface. Prepare and review this proposal offline. Database application
requires separate operator approval: back up the original canonical project row,
stop writers, and use a transaction to update only the `roundhouse.projects` row
with `id = 'roundhouse'`. Compare its entire current payload against the exported
original before updating; abort on any difference. Update payload and revision
together (and name when inserting a missing record), without changing operational
columns. If the row was absent, insert only if still absent. Do not import the
entire snapshot or update jobs, features, other project rows, or assignments.
Verify both repository URLs and retained history before committing. Rollback
restores that backed-up row after checking no subsequent writes would be lost.
This handoff supplies the offline proposal only; no live mutation is automatic.
