const $ = (selector) => document.querySelector(selector);
let configuration;
const needsDrafts = new Map();

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function formatState(state) { return state.replace("Needs Clarification", "Needs You"); }

function submitOnEnter(textarea, form) {
  textarea.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    form.requestSubmit();
  });
}

function renderNeeds(questions) {
  const list = $("#needs-list");
  list.replaceChildren();
  list.className = questions.length ? "cards" : "cards empty";
  if (!questions.length) return list.append(node("p", "Nothing needs you."));
  for (const question of questions) {
    const card = node("article", undefined, "card attention");
    const label = question.kind === "review" ? "Approval" : question.kind === "imported_decision" ? "Imported decision" : "Clarification";
    card.append(node("span", label, "pill"), node("h3", question.prompt));
    const form = node("form", undefined, "answer-form");
    const input = node("textarea"); input.required = true; input.placeholder = "Your answer…";
    const button = node("button", "Answer");
    input.value = needsDrafts.get(question.id) ?? "";
    input.addEventListener("input", () => {
      needsDrafts.set(question.id, input.value);
      input.setCustomValidity("");
    });
    form.append(input, button);
    submitOnEnter(input, form);
    let submitting = false;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submitting) return;
      submitting = true; button.disabled = true; input.setCustomValidity("");
      try {
        if (question.kind === "review" && input.value.trim().toLowerCase() === "approve") {
          await api(`/api/items/${encodeURIComponent(question.item_id)}/approve`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ expected_revision: question.item_revision }),
          });
        } else {
          await api(`/api/questions/${encodeURIComponent(question.id)}/answer`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ answer: input.value, expected_revision: question.revision }),
          });
        }
        needsDrafts.delete(question.id);
        input.value = "";
        await load();
      } catch (error) { input.setCustomValidity(error.message); input.reportValidity(); }
      finally { submitting = false; button.disabled = false; }
    });
    if (question.kind === "review") card.append(node("p", 'Type “approve” to approve this revision, or provide guidance.', "hint"));
    card.append(form);
    list.append(card);
  }
}

function workCard(item) {
  const card = node("article", undefined, "work-card");
  const top = node("div", undefined, "work-top");
  top.append(node("span", formatState(item.state), `pill state-${item.state.toLowerCase().replaceAll(" ", "-")}`), node("span", item.project || item.project_candidate?.name || "Unassigned", "project-label"));
  if (item.priority) top.append(node("span", item.priority, "pill"));
  card.append(top, node("h3", item.summary));
  if (item.outcome) card.append(node("p", item.outcome, "outcome"));
  else if (item.reason) card.append(node("p", item.reason, "hint"));
  const checks = item.evidence?.checks ?? [];
  const deliveries = item.evidence?.deliveries ?? [];
  if (checks.length) card.append(node("p", `Checks: ${checks.map((check) => `${check.id} ${check.passed ? "✓" : "✕"}`).join(" · ")}`, "evidence"));
  for (const delivery of deliveries) {
    const detail = delivery.deployment
      ? `Deployed to ${delivery.deployment.environment} via ${delivery.deployment.provider} · ${delivery.commit.slice(0, 9)}`
      : `${delivery.pushed ? "Pushed" : "Committed"} · ${delivery.branch} · ${delivery.commit?.slice(0, 9)}`;
    card.append(node("p", detail, "evidence"));
  }
  if (item.imported) {
    const details = node("details", undefined, "provenance");
    details.append(node("summary", "Imported from archived Notion Depot"));
    const source = item.provenance?.source_page_url;
    if (source && /^https?:\/\//i.test(source)) {
      const link = node("a", "Open archived source");
      link.href = source; link.target = "_blank"; link.rel = "noreferrer";
      details.append(link);
    }
    const facts = [
      item.provenance?.source_id ? `Source ID: ${item.provenance.source_id}` : "",
      item.provenance?.legacy_roundhouse_id ? `Legacy Roundhouse ID: ${item.provenance.legacy_roundhouse_id}` : "",
      item.legacy?.["Workflow State"] ? `Legacy workflow: ${item.legacy["Workflow State"]}` : "",
      item.legacy?.Status ? `Legacy status: ${item.legacy.Status}` : "",
      item.legacy?.["Decisions Needed"] ? `Decisions needed: ${item.legacy["Decisions Needed"]}` : "",
      item.legacy?.["Acceptance Criteria"] ? `Acceptance criteria: ${item.legacy["Acceptance Criteria"]}` : "",
      item.legacy?.["Delivery Summary"] ? `Delivery summary: ${item.legacy["Delivery Summary"]}` : "",
    ].filter(Boolean);
    for (const fact of facts) details.append(node("p", fact, "hint"));
    if (item.requires_reevaluation) {
      details.append(node("p", "Execution disabled until an explicit Roundhouse re-evaluation.", "evidence"));
      const reevaluate = node("button", "Re-evaluate in Roundhouse", "secondary");
      reevaluate.type = "button";
      reevaluate.addEventListener("click", async () => {
        if (!window.confirm("Re-evaluate this imported item now? If Roundhouse finds it ready, the worker may execute it.")) return;
        reevaluate.disabled = true;
        try {
          await api(`/api/items/${encodeURIComponent(item.id)}/reevaluate-import`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ expected_revision: item.revision }),
          });
          await load();
        } catch (error) {
          window.alert(error.message);
          reevaluate.disabled = false;
        }
      });
      details.append(reevaluate);
    }
    card.append(details);
  }
  return card;
}

function renderBoard(items) {
  const board = $("#work-board"); board.replaceChildren();
  const groups = [
    ["Incoming", ["Depot", "Decision", "Needs Clarification", "Review", "Imported Pending"]],
    ["Active / queued", ["Ready", "Executing", "Verification", "Rework"]],
    ["Completed", ["Shipped", "Imported History"]],
    ["Blocked", ["Blocked"]],
  ];
  for (const [name, states] of groups) {
    const column = node("div", undefined, "column");
    const matches = items.filter((item) => states.includes(item.state));
    column.append(node("h3", `${name} · ${matches.length}`));
    if (!matches.length) column.append(node("p", "No work", "empty"));
    for (const item of matches) column.append(workCard(item));
    board.append(column);
  }
}

function renderProjects(projects) {
  const root = $("#projects"); root.replaceChildren();
  root.className = projects.length ? "projects" : "projects empty";
  if (!projects.length) return root.append(node("p", "No projects configured yet. Add one in project configuration."));
  for (const project of projects) {
    const card = node("article", undefined, "project-card");
    card.append(node("h3", project.name), node("p", project.purpose, "hint"));
    const values = [
      ["Weight", project.weight],
      ["Repository", project.repository],
      ["Runtime", project.runtime],
      ["Executor", project.executor.kind],
      ["Human review", project.policy.approval_required || !project.policy.allow_autonomous ? "Required" : "Policy permits autonomy"],
      ["Shipping", project.policy.shipping],
      ["Deployment", project.deployment ? `${project.deployment.kind} → ${project.deployment.environment}` : "Not configured"],
      ["Verification", project.verification.map((check) => check.id).join(", ")],
    ];
    const dl = node("dl");
    for (const [key, value] of values) { dl.append(node("dt", key), node("dd", String(value))); }
    card.append(dl); root.append(card);
  }
}

async function load() {
  try {
    const [overview, config] = await Promise.all([api("/api/overview"), api("/api/config")]);
    configuration = config.configuration;
    $("#connection").textContent = `● Local connected · MCP ${overview.connection.mcp} · ChatGPT external · Worker ${overview.connection.worker.running ? "working" : "ready"}`;
    $("#connection").className = "connection connected";
    const countIds = { needs_you: "needs", active: "active", queued: "queued", completed: "completed", blocked: "blocked" };
    for (const [key, id] of Object.entries(countIds)) $(`#count-${id}`).textContent = overview.counts[key];
    $("#needs-badge").textContent = overview.counts.needs_you;
    renderNeeds(overview.needs_you);
    renderBoard(overview.items);
    renderProjects(configuration.projects || []);
  } catch (error) {
    $("#connection").textContent = `● Disconnected · ${error.message}`;
    $("#connection").className = "connection failed";
  }
}

const intakeForm = $("#intake-form");
const intakeContent = $("#intake-content");
submitOnEnter(intakeContent, intakeForm);
let intakeSubmitting = false;
intakeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (intakeSubmitting) return;
  intakeSubmitting = true;
  const message = $("#intake-message"); message.textContent = "Saving…";
  try {
    const input = { content: intakeContent.value };
    if ($("#project-hint").value.trim()) input.project_hint = $("#project-hint").value.trim();
    const result = await api("/api/intake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    message.textContent = `Saved ${result.item.id}. The local worker will pick it up.`;
    intakeContent.value = ""; $("#project-hint").value = "";
    setTimeout(load, 500);
  } catch (error) { message.textContent = error.message; }
  finally { intakeSubmitting = false; }
});

$("#refresh").addEventListener("click", load);
$("#edit-config").addEventListener("click", () => {
  $("#config-editor").value = JSON.stringify(configuration, null, 2);
  $("#config-message").textContent = "";
  $("#config-dialog").showModal();
});
$("#config-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  try {
    const edited = JSON.parse($("#config-editor").value);
    await api("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ configuration: edited }) });
    $("#config-dialog").close(); await load();
  } catch (error) { $("#config-message").textContent = error.message; }
});

load();
setInterval(load, 5000);
