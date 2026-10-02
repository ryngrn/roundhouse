# ChatGPT → Roundhouse Depot

This slice adds a thin ChatGPT adapter over the same Roundhouse Depot, decision,
question, and readiness state used by the CLI and Notion adapter. ChatGPT does not
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
policy. It does not establish an equivalent write-capable mobile setup, so test this
slice on the documented web Work surface and do not create a mobile-specific
architecture workaround.

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
