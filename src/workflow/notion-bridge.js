import { digest } from "./store.js";

export function pageId(value) {
  const id = String(value ?? "").replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("A Notion page UUID is required.");
  return id;
}

// Connector transport supplies fetched pages; only explicit Depot opt-ins enter execution.
export function pickup(store, batch, projects, convert) {
  const source = pageId(batch.data_source_id);
  if (!Array.isArray(batch.pages)) throw new Error("pages must be an array");
  return batch.pages.map((page) => {
    const id = pageId(page.id);
    if (pageId(page.data_source_id) !== source) throw new Error("Unexpected data source");
    const existing = Object.values(store.read().items).find((item) => item.input.notion?.page_id === id);
    if (existing) return { page_id: id, id: existing.id, duplicate: true };
    const props = page.properties ?? {};
    const state = typeof props["Workflow State"] === "string" ? props["Workflow State"] : props["Workflow State"]?.select?.name;
    if (page.archived || page.in_trash || state !== "Depot") return { page_id: id, skipped: true };
    if (props["Roundhouse Job ID"]) throw new Error("Page already owned by another state store; inspect before pickup");
    const input = convert({ ...page, url: `https://notion.so/${id}` }, projects);
    if (!input.project_id) throw new Error("Unattended pickup requires an explicitly configured project");
    input.notion = { page_id: id, data_source_id: source };
    const item = store.submit(input, `notion:${id}`);
    return { page_id: id, id: item.id, duplicate: false };
  });
}

export function updates(data, view) {
  return view(data).items.flatMap((item) => {
    const stored = data.items[item.id];
    if (!stored.input.notion) return [];
    const properties = {
      "Workflow State": item.state,
      "Roundhouse Job ID": item.id,
      "Delivery Summary": [
        `State: ${item.state}`,
        item.question ?? "",
        ...item.jobs.map((job) => `${job.title}: ${job.state}. ${job.reason ?? ""}${job.shipping ? ` Delivery: ${JSON.stringify(job.shipping)}` : ""}`),
      ].filter(Boolean).join("\n").slice(0, 18000),
    };
    const token = digest(properties);
    return stored.notion_sync_token === token ? [] : [{ page_id: stored.input.notion.page_id, item_id: item.id, token, properties }];
  });
}

export function acknowledge(store, receipt, view) {
  return store.change((data) => {
    const update = updates(data, view).find((u) => u.item_id === receipt.item_id && u.token === receipt.token);
    if (!update) throw new Error("Stale or unknown sync receipt; regenerate updates");
    data.items[update.item_id].notion_sync_token = update.token;
    for (const event of data.outbox) if (event.item_id === update.item_id) event.delivered = true;
    return { acknowledged: true };
  });
}
