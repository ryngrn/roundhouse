# ChatGPT → Roundhouse Depot

This slice adds a thin ChatGPT adapter over the same authoritative Roundhouse
Depot, decision, question, and readiness state used by the CLI and browser. For a
substantial project or implementation request, ChatGPT's supported action is to
create the authoritative Depot item before any executor or Herdr dispatch. It does
not infer projects, decompose work, assign priority, approve policy, choose or
invoke an executor, or execute jobs.

The server exposes four tools over MCP Streamable HTTP at `/mcp`:

- `add_to_depot` preserves the original intent plus optional context, attachment
  references, metadata, and a non-authoritative project hint.
- `get_needs_human` returns open durable questions with question/decision IDs and
  revision guards.
- `answer_question` durably records one current answer and immediately invokes the
  existing Roundhouse decision/readiness evaluation. It does not execute work.
- `get_work_status` returns compact persisted item and job state.

There is intentionally no `list_projects` tool. Roundhouse can infer a project from
configured project context, while a user-supplied project value remains a hint.
There is also intentionally no implementation or executor tool. Codex, command,
and other configured providers are private runtime adapters selected only after
Roundhouse triage has produced Ready work and dispatch has authoritatively claimed
the eligible job.

Remote Desktop Commander is deliberately outside that project execution path. It
may provide transport, inspect a machine, check connectivity, bootstrap the
Roundhouse/Herdr path, or perform an explicitly directed emergency repair. It must
not edit a project, run its implementation agent, verify it, commit it, push it, or
deliver it as an alternate runtime. A connectivity or bootstrap problem does not
change this boundary: submit substantial work to the Depot, then let Roundhouse
select and claim the configured local or Herdr runtime.

Roundhouse status is authoritative only for work with durable Depot, job, claim,
and execution records. The control room may also show **Untracked execution
activity** when a best-effort local scan finds a configured executor process or an
extra configured-repository worktree without matching launch provenance. Treat
that section as an operator warning, not proof that work is running, complete, or
delivered. First inspect the reported PID or worktree and the durable Roundhouse
status. Stop or preserve unexpected work as appropriate, reconcile any possible
side effects, and submit replacement work through `add_to_depot` if the intended
work still needs to run. Never mark an item complete from an untracked observation.

This observation is intentionally limited. Roundhouse cannot see arbitrary remote
processes, ChatGPT activity, or a machine-local Herdr filesystem, and process or Git
inspection may be unavailable on the host. Machine-local Herdr work is authoritative
only through its persisted `remote_execution`, delivery intent, and nonce-correlated
remote report; that evidence remains marked `independently_verified: false`.

The endpoint is dual-era: it preserves the existing MCP 1.x handshake for current
clients and implements stateless MCP 2.0 protocol version `2026-07-28` for current
ChatGPT plugin discovery. MCP 2.0 requests receive `server/discover`, the same four
tool schemas, and the Events methods described below.

## Same-thread status with MCP Events

Manual polling remains the fallback everywhere the tools work: use
`get_work_status` and `get_needs_human`. On currently supported ChatGPT surfaces,
Roundhouse's tool guidance directs ChatGPT to follow a successful submission with
an immediate `roundhouse.work.updated` subscription for the returned item ID. This
does not require an intervening status request. The tool result includes a typed
`follow` target containing the event name and item arguments; ChatGPT uses that
target to call `events/subscribe`. Roundhouse does not claim that the follow is
durable until that subscription request succeeds. The standard
subscription request has exactly one of these scopes:

```json
{
  "name": "roundhouse.work.updated",
  "arguments": { "item_id": "durable-item-id", "include_progress": false },
  "delivery": {
    "mode": "webhook",
    "url": "https://callback-supplied-by-chatgpt.example/path",
    "secret": "whsec_base64-signing-key"
  },
  "cursor": null
}
```

Use `project_id` instead of `item_id` to watch a configured project. By default,
Roundhouse emits only these durable state outcomes:

- `Needs Clarification` or `Review`, when a current question actually needs a person
- materially `Blocked` work
- `Shipped`, once the complete Depot item is verified and shipped

Set `include_progress: true` explicitly to also receive meaningful `Executing`,
`Verification`, and `Rework` transitions. Process output and terminal noise never
become events.

Subscriptions, hashed ChatGPT conversation correlation, and delivery attempts live
in authoritative Roundhouse state and survive restart. Roundhouse never stores the
raw `openai/session` value. A subscription for an item submitted in that conversation
is marked `originating_submission`; a later item follow is marked `follow`. The
hashed conversation reference is also part of the subscription identity, so two
ChatGPT threads cannot overwrite one another when their owner, callback endpoint,
and item scope are otherwise identical. A new subscription begins at the current
outbox position, so old
transitions are not silently replayed. Each matching transition gets a stable event
ID. Transient delivery failures use bounded backoff with that same ID; successful,
permanent, and exhausted deliveries remain recorded for deduplication and audit.

Roundhouse implements the current webhook subset documented by OpenAI:
`server/discover`, `events/list`, `events/subscribe`, and `events/unsubscribe`.
Subscription callbacks are verified before activation, require an HTTPS public
address, do not follow redirects, are re-resolved and public-address checked for
every delivery, and use Standard Webhooks signatures. The signing secret is stored
in the private state file because it is required for later callbacks. Protect that
file as a secret.

The current local server has no built-in multi-user identity system. Behind an
authenticated reverse proxy, set `ROUNDHOUSE_MCP_PRINCIPAL_HEADER` to the name of
a proxy-injected header containing a stable account subject (for example,
`x-roundhouse-principal`). The proxy must strip client-supplied copies. Roundhouse
stores only a hash of that value as subscription ownership metadata. Without this
setting it hashes the Authorization header when present and otherwise uses the
single local identity; OAuth access-token rotation therefore requires the stable
principal-header configuration for long-lived production subscriptions.

OpenAI currently documents MCP Events on these surfaces only:

- Work chats on ChatGPT web
- Work chats in the desktop app with **Cloud** selected
- OpenAI dots

Workspace plugin and event-trigger controls still apply. This is not universal
mobile support. See OpenAI's current [MCP Events guide](https://developers.openai.com/plugins/build/mcp-events)
and the MCP [`2026-07-28` specification](https://modelcontextprotocol.io/specification/2026-07-28/).

## Run locally

Use a private Roundhouse state directory and an autonomy configuration. Both paths
must be absolute. The configuration's decision provider is used when a human answer
causes reevaluation.

```sh
npm ci
ROUNDHOUSE_STATE_DIR=/absolute/path/to/roundhouse-state \
ROUNDHOUSE_CONFIG=/absolute/path/to/autonomy.yaml \
npm run mcp
```

The defaults are `127.0.0.1:8787` and `http://127.0.0.1:8787/mcp`. Override them
with `ROUNDHOUSE_MCP_HOST` and `ROUNDHOUSE_MCP_PORT`. The server rejects unexpected
HTTP Host values to protect the local endpoint from DNS rebinding. If a development
tunnel preserves its public host header, add that hostname (without scheme or path)
to comma-separated `ROUNDHOUSE_MCP_ALLOWED_HOSTS`.

Test the transport independently with the official MCP Inspector:

```sh
npx @modelcontextprotocol/inspector@latest
```

Choose **Streamable HTTP**, connect to `http://127.0.0.1:8787/mcp`, list the four
tools, then call `add_to_depot`. `npm test` also runs an official MCP SDK client
through the HTTP transport and verifies the persisted state after reconstructing
the Store.

## Connect from ChatGPT

The current official OpenAI flow uses ChatGPT developer mode and a reachable HTTPS
Streamable HTTP endpoint:

1. Start the server and verify it locally with Inspector.
2. Make the local `/mcp` endpoint reachable through Secure MCP Tunnel when it is
   available to your workspace, or through a controlled temporary HTTPS development
   tunnel. Official guidance requires a public HTTPS endpoint for submission; a
   development tunnel is not a production endpoint.
3. In ChatGPT, open **Settings → Security and login** and enable **Developer mode**.
4. Open **ChatGPT Plugins**, select the plus button, and register the HTTPS URL,
   including `/mcp`.
5. Start a new **Work** chat, enable Roundhouse from the tools/plugin menu, and try
   “Send that to Roundhouse.” Refresh the plugin connection after tool metadata or
   schemas change.

The portable plugin package is in `plugin/roundhouse`. Before distributing that
package, replace the example URL in `mcp.json` with the stable authenticated HTTPS
endpoint. Direct developer-mode connection to the MCP endpoint is sufficient for
this local vertical-slice test; no custom UI is required.

## Current platform and security boundary

OpenAI's current documentation demonstrates personal plugin testing in ChatGPT Work
on the web and says developer-mode availability depends on account and workspace
policy. Events additionally support the desktop Work + Cloud surface and OpenAI
dots as listed above. It does not establish equivalent universal mobile support,
so do not create a mobile-specific architecture workaround.

This repository supplies no public MCP hosting or OAuth service. The server is
bound to loopback by default. OpenAI's current guidance says write actions or
customer-specific/private data should authenticate users; before any stable/public
connection, put the MCP endpoint behind the MCP OAuth 2.1 flow and appropriate
transport controls. Developer mode availability depends on account and workspace
policy. The official docs currently establish ChatGPT Work on the web for personal
plugin testing, not equivalent write-capable mobile support. The
packaged placeholder URL is deliberately non-routable until that operator-owned
endpoint exists.

Official references verified for this implementation:

- [MCP server and UI quickstart](https://developers.openai.com/plugins/build/app-quickstart)
- [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server)
- [MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [Plugin authentication](https://developers.openai.com/plugins/build/auth)
- [MCP TypeScript SDK server guidance](https://ts.sdk.modelcontextprotocol.io/server)

## Manual acceptance pass

In one ChatGPT Work conversation:

1. Discuss a messy idea, then say “send that to Roundhouse.” Confirm the result is a
   durable item ID and `Depot` state, not a ChatGPT-created plan.
2. Let the installed background worker route the item (or run the CLI worker in a
   foreground-only development setup). Ask “is anything in Roundhouse waiting on me?”
3. Answer the returned material question. Confirm the tool uses its ID and revision,
   and the response reports the state after reevaluation without a separate continue
   command.
4. Ask for status. Restart the MCP process and ask again to confirm persistence.

For Events on a supported surface, submit from the conversation and confirm ChatGPT
immediately follows the returned item ID without first calling a status tool. Confirm
callback verification, originating-conversation correlation, and subscription persistence,
then cause a Needs You or Shipped transition. The update should arrive in that
conversation without calling a polling tool. Stop monitoring and confirm
`events/unsubscribe` makes later matching transitions silent.
