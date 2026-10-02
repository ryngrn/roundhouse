# ChatGPT → Roundhouse Depot

This slice adds a thin ChatGPT adapter over the same authoritative Roundhouse
Depot, decision, question, and readiness state used by the CLI and browser. ChatGPT does not
infer projects, decompose work, assign priority, approve policy, or execute jobs.

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

The endpoint is dual-era: it preserves the existing MCP 1.x handshake for current
clients and implements stateless MCP 2.0 protocol version `2026-07-28` for current
ChatGPT plugin discovery. MCP 2.0 requests receive `server/discover`, the same four
tool schemas, and the Events methods described below.

## Same-thread status with MCP Events

Manual polling remains the fallback everywhere the tools work: use
`get_work_status` and `get_needs_human`. On currently supported ChatGPT surfaces,
a conversation can instead subscribe to `roundhouse.work.updated` with exactly one
of these scopes:

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

Subscriptions and delivery attempts live in the private Roundhouse state file and
survive restart. A new subscription begins at the current outbox position, so old
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
- dots

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
policy. Events additionally support the desktop Work + Cloud surface and dots as
listed above. It does not establish equivalent universal mobile support, so do not
create a mobile-specific architecture workaround.

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

For Events on a supported surface, ask ChatGPT in the same conversation to monitor
the returned item ID. Confirm callback verification and subscription persistence,
then cause a Needs You or Shipped transition. The update should arrive in that
conversation without calling a polling tool. Stop monitoring and confirm
`events/unsubscribe` makes later matching transitions silent.
