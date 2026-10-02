# Retired: unattended Notion pickup

Unattended Notion pickup and status write-back are retired. Notion is an
archive/reference for the former Roundhouse Depot prototype, not an operational
queue or workflow dependency.

New requests must use Roundhouse directly through its browser control room, JSON
API, MCP `add_to_depot` tool, or `roundhouse depot submit`. Do not schedule Notion
queries, invoke a connector heartbeat, or apply Roundhouse state back to Notion.

For the one-time historical import and its safety contract, see
[Notion Depot archive and one-time cutover](chatgpt-rdc-bridge.md).
