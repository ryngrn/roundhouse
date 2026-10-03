const $ = (selector) => document.querySelector(selector);
let configuration = { projects: [] };
let currentOverview = null;
let activeSession = null;

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.code = data.code; error.conflict = data.conflict; error.status = response.status;
    throw error;
  }
  return data;
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

const slug = (value) => String(value || "").toLowerCase().replaceAll(" ", "-");
const projectLabel = (item) => item.project || item.project_candidate?.name || "Unassigned";
const shortDate = (value) => value ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value)) : "—";

function submitOnEnter(textarea, form) {
  textarea.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault(); form.requestSubmit();
  });
}

function renderConnection(overview) {
  const worker = overview.connection.worker.running ? "working" : "ready";
  const storage = overview.connection.storage;
  const authority = storage ? `${storage.kind}${storage.node?.name ? ` · ${storage.node.name}` : ""}` : "storage ready";
  $("#connection").textContent = `● App online · ${authority} · worker ${worker}`;
  $("#connection").className = "connection connected";
  const countIds = { needs_you: "needs", active: "active", queued: "queued", completed: "completed", blocked: "blocked" };
  for (const [key, id] of Object.entries(countIds)) $(`#count-${id}`).textContent = overview.counts[key];
  const next = overview.next_departure;
  $("#next-departure").textContent = next ? `Next departure · ${next.title}${next.priority ? ` · ${next.priority}` : ""}` : "Next departure · none ready";
}

function rowMeta(label, value, className = "") {
  const span = node("span", undefined, `row-meta ${className}`.trim());
  span.append(node("b", label), node("span", value || "—"));
  return span;
}

function workRow(item) {
  const button = node("button", undefined, "work-row");
  button.type = "button"; button.dataset.itemId = item.id;
  button.setAttribute("aria-label", `Open ${item.title}, ${item.display_state}`);
  const identity = node("span", undefined, "row-identity");
  const kicker = node("span", undefined, "row-kicker");
  kicker.append(node("span", item.display_state, `state state-${slug(item.display_state)}`));
  if (item.priority) kicker.append(node("span", item.priority, "priority"));
  identity.append(kicker, node("strong", item.title), node("span", item.triage?.reason || item.reason || item.brief || item.summary, "row-reason"));
  const facts = node("span", undefined, "row-facts");
  facts.append(
    rowMeta("Role", item.agent_role || "Unassigned"),
    rowMeta("Node", item.owning_node || "—"),
    rowMeta("Verify", item.verification_status, item.verification_status === "Passed" ? "positive" : ""),
    rowMeta("Ship", item.shipping_status, item.shipping_status === "Delivered" ? "positive" : ""),
  );
  const tail = node("span", undefined, "row-tail");
  tail.append(node("span", shortDate(item.updated_at), "row-date"), node("span", "→", "row-arrow"));
  if (item.imported) tail.prepend(node("span", "Imported · Notion", "provenance-label"));
  button.append(identity, facts, tail);
  button.addEventListener("click", () => openWork(item.id));
  return button;
}

function groupStatus(items) {
  return {
    needs: items.filter((item) => item.needs_you).length,
    active: items.filter((item) => ["Executing", "Verification", "Rework"].includes(item.state)).length,
    queued: items.filter((item) => item.state === "Ready" && !item.needs_you).length,
    shipped: items.filter((item) => ["Shipped", "Imported History", "Archived", "Reconciled"].includes(item.state)).length,
    blocked: items.filter((item) => item.state === "Blocked").length,
  };
}

function renderBoard(overview) {
  const root = $("#project-board"); root.replaceChildren();
  const configured = new Map((configuration.projects || []).map((project) => [project.id, project]));
  const groups = new Map();
  for (const project of configuration.projects || []) groups.set(`project:${project.id}`, { type: "project", id: project.id, name: project.name, detail: project.purpose, items: [] });
  for (const candidate of Object.values(overview.project_candidates || {})) groups.set(`candidate:${candidate.id}`, { type: "candidate", id: candidate.id, name: candidate.name, detail: "Project candidate · execution not configured", items: [] });
  groups.set("unassigned", { type: "unassigned", name: "Unknown / Unassigned", detail: "Project still needs to be identified", items: [] });
  for (const item of overview.items) {
    const key = item.project ? `project:${item.project}` : item.project_candidate ? `candidate:${item.project_candidate.id}` : "unassigned";
    if (!groups.has(key)) groups.set(key, { type: "project", id: item.project, name: configured.get(item.project)?.name || item.project, detail: "Configured project", items: [] });
    groups.get(key).items.push(item);
  }
  const ordered = [...groups.values()].filter((group) => group.items.length || group.type === "project")
    .sort((a, b) => (a.type === "project" ? 0 : a.type === "candidate" ? 1 : 2) - (b.type === "project" ? 0 : b.type === "candidate" ? 1 : 2) || a.name.localeCompare(b.name));
  if (!ordered.length) return root.append(node("p", "No projects or work yet.", "empty-state"));
  for (const group of ordered) {
    const section = node("section", undefined, "project-group");
    const heading = node("header", undefined, "project-heading");
    const title = node("div"); title.append(node("span", group.type === "project" ? "Project" : group.type === "candidate" ? "Candidate" : "Intake", "eyebrow"), node("h3", group.name), node("p", group.detail || "", "project-detail"));
    const counts = groupStatus(group.items);
    const atGlance = node("dl", undefined, "project-counts");
    for (const [label, value] of [["Needs a signal", counts.needs], ["Chugging along…", counts.active], ["Ready to depart", counts.queued], ["Reached the station", counts.shipped], ["Held up", counts.blocked]]) {
      const cell = node("div"); cell.append(node("dt", label), node("dd", String(value))); atGlance.append(cell);
    }
    heading.append(title, atGlance); section.append(heading);
    const labels = node("div", undefined, "row-labels");
    labels.append(node("span", "Work / current activity"), node("span", "Ownership / delivery"), node("span", "Updated"));
    section.append(labels);
    const rows = node("div", undefined, "work-rows");
    if (!group.items.length) rows.append(node("p", "No current work", "empty-state compact"));
    for (const item of group.items) rows.append(workRow(item));
    section.append(rows); root.append(section);
  }
}

function detailSection(title, value, className = "") {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return null;
  const section = node("section", undefined, `detail-section ${className}`.trim()); section.append(node("h3", title));
  if (Array.isArray(value)) { const list = node("ul"); for (const entry of value) list.append(node("li", entry)); section.append(list); }
  else if (typeof value === "object") section.append(node("pre", JSON.stringify(value, null, 2)));
  else section.append(node("p", value));
  return section;
}

function renderOverview(item) {
  const root = node("div", undefined, "detail-grid");
  for (const section of [detailSection("Outcome", item.outcome || item.brief || "Outcome is still being defined.", "featured"), detailSection("Triage activity", item.triage), detailSection("Brief", item.brief), detailSection("Context", item.context), detailSection("Acceptance criteria", item.acceptance_criteria)]) if (section) root.append(section);
  const raw = node("details", undefined, "raw-details"); raw.append(node("summary", "Raw intake"), node("p", item.raw_intake)); root.append(raw);
  if (item.legacy) { const legacy = node("details", undefined, "raw-details"); legacy.append(node("summary", "Imported record fields"), node("pre", JSON.stringify(item.legacy, null, 2))); root.append(legacy); }
  return root;
}

function setDecisionMessage(text, kind = "") {
  const message = $("#decision-message"); if (message) { message.textContent = text; message.className = `decision-message ${kind}`.trim(); }
}

function renderDecisionQuestion() {
  const questions = activeSession.questions;
  const root = node("div", undefined, "decision-session");
  root.append(node("p", questions.length ? `Question ${activeSession.index + 1} of ${questions.length}` : "No open decisions", "progress-label"));
  if (!questions.length) { root.append(node("p", "Roundhouse is not waiting for an answer on this item.", "empty-state")); return root; }
  const question = questions[activeSession.index];
  const field = node("div", undefined, "decision-field");
  const label = node("label", question.prompt); label.htmlFor = "decision-answer";
  const input = node("textarea"); input.id = "decision-answer"; input.rows = 8; input.placeholder = "Write your answer…"; input.value = activeSession.drafts.get(question.id) || "";
  input.addEventListener("input", () => { activeSession.drafts.set(question.id, input.value); setDecisionMessage(""); });
  field.append(label, input); root.append(field);
  const message = node("p", "", "decision-message"); message.id = "decision-message"; message.setAttribute("role", "status"); root.append(message);
  if (activeSession.stale) setTimeout(() => setDecisionMessage("This item changed remotely. Your drafts are preserved, but this session cannot be submitted. Close and reopen to review the new questions.", "conflict"), 0);
  const actions = node("div", undefined, "decision-actions");
  const back = node("button", "Back", "secondary"); back.type = "button"; back.disabled = activeSession.index === 0;
  back.addEventListener("click", () => { activeSession.index -= 1; renderActiveTab(); }); actions.append(back);
  if (activeSession.index < questions.length - 1) {
    const next = node("button", "Next"); next.type = "button";
    next.addEventListener("click", () => { activeSession.drafts.set(question.id, input.value); activeSession.index += 1; renderActiveTab(); }); actions.append(next);
  } else {
    const submit = node("button", `Submit ${questions.length} answer${questions.length === 1 ? "" : "s"}`); submit.type = "button"; submit.disabled = activeSession.stale;
    submit.addEventListener("click", submitDecisionSession); actions.append(submit);
  }
  root.append(actions); setTimeout(() => input.focus(), 0); return root;
}

async function submitDecisionSession() {
  const questions = activeSession.questions;
  const missing = questions.findIndex((question) => !(activeSession.drafts.get(question.id) || "").trim());
  if (missing >= 0) { activeSession.index = missing; renderActiveTab(); setDecisionMessage("Answer every question before submitting the session.", "error"); return; }
  const button = $(".decision-actions button:last-child"); if (button) button.disabled = true; setDecisionMessage("Submitting all answers…");
  try {
    await api(`/api/items/${encodeURIComponent(activeSession.item.id)}/decision-session`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_item_revision: activeSession.item.revision, answers: questions.map((question) => ({ question_id: question.id, expected_revision: question.revision, answer: activeSession.drafts.get(question.id) })) }),
    });
    activeSession.drafts.clear(); activeSession = null; $("#work-dialog").close(); await load();
  } catch (error) {
    if (error.code === "decision_session_conflict") activeSession.stale = true;
    setDecisionMessage(error.code === "decision_session_conflict" ? `${error.message} No answers were applied; your drafts are preserved.` : error.message, error.code === "decision_session_conflict" ? "conflict" : "error");
    if (button) button.disabled = activeSession.stale;
  }
}

function evidenceView(item) {
  const root = node("div", undefined, "detail-grid");
  root.append(detailSection("Verification", item.evidence.checks.length ? item.evidence.checks.map((check) => `${check.passed ? "Passed" : "Failed"} · ${check.id}${check.summary ? ` — ${check.summary}` : ""}`) : ["No verification evidence recorded yet."]));
  const delivery = node("section", undefined, "detail-section"); delivery.append(node("h3", "Shipping & previews"));
  if (!item.evidence.deliveries.length) delivery.append(node("p", "No shipping evidence recorded yet."));
  for (const entry of item.evidence.deliveries) {
    delivery.append(node("p", `${entry.pushed ? "Pushed" : "Committed"} · ${entry.branch || "branch unavailable"} · ${entry.commit?.slice(0, 10) || "commit unavailable"}`));
    const url = entry.deployment?.url || entry.deployment?.deploy_url;
    if (url) { const link = node("a", `Open ${entry.deployment?.environment || "preview"}`); link.href = url; link.target = "_blank"; link.rel = "noreferrer"; delivery.append(link); }
  }
  root.append(delivery);
  if (item.imported) {
    const provenance = node("section", undefined, "detail-section subordinate"); provenance.append(node("h3", "Imported provenance"), node("p", `${item.provenance?.source || "Archived Notion Depot"} · ${item.provenance?.source_id || "source id unavailable"}`));
    if (item.provenance?.source_page_url) { const link = node("a", "Open archived source"); link.href = item.provenance.source_page_url; link.target = "_blank"; link.rel = "noreferrer"; provenance.append(link); }
    root.append(provenance);
  }
  return root;
}

function historyView(item) {
  const root = node("div", undefined, "timeline");
  const decisions = detailSection("Prior decisions", item.prior_decisions.map((entry) => `${entry.prompt} — ${entry.answer}`)); if (decisions) root.append(decisions);
  const list = node("ol");
  for (const event of [...item.history].reverse()) { const entry = node("li"); entry.append(node("strong", event.to), node("span", event.reason), node("time", event.at ? new Date(event.at).toLocaleString() : "")); list.append(entry); }
  root.append(list); return root;
}

function renderActiveTab() {
  if (!activeSession) return;
  const content = $("#work-modal-content"); content.replaceChildren();
  (document.querySelectorAll?.(".tabs button[data-tab]") || []).forEach((button) => { button.setAttribute("aria-selected", String(button.dataset.tab === activeSession.tab)); });
  if (activeSession.tab === "overview") content.append(renderOverview(activeSession.item));
  else if (activeSession.tab === "decisions") content.append(renderDecisionQuestion());
  else if (activeSession.tab === "evidence") content.append(evidenceView(activeSession.item));
  else content.append(historyView(activeSession.item));
}

function hasDrafts() { return activeSession && [...activeSession.drafts.values()].some((value) => value.trim()); }
function requestCloseWork() {
  if (hasDrafts() && !window.confirm("Discard these unsubmitted drafts and close the work item?")) return;
  $("#work-dialog").close(); activeSession = null;
}

function openWork(itemId) {
  const item = currentOverview.items.find((candidate) => candidate.id === itemId); if (!item) return;
  activeSession = { item: structuredClone(item), questions: structuredClone(item.questions || []), drafts: new Map(), index: 0, stale: false, tab: item.needs_you ? "decisions" : "overview" };
  $("#work-project").textContent = projectLabel(item); $("#work-dialog-title").textContent = item.title; $("#work-outcome").textContent = item.outcome || item.brief || item.summary;
  const strip = $("#work-status-strip"); strip.replaceChildren();
  for (const value of [item.display_state, item.priority, item.agent_role ? `Role · ${item.agent_role}` : null, item.owning_node ? `Node · ${item.owning_node}` : null, `Verify · ${item.verification_status}`, `Ship · ${item.shipping_status}`].filter(Boolean)) strip.append(node("span", value));
  $("#decision-count").textContent = item.questions.length ? String(item.questions.length) : "";
  renderActiveTab(); $("#work-dialog").showModal();
}

function reconcileOpenSession(overview) {
  if (!activeSession) return;
  const latest = overview.items.find((item) => item.id === activeSession.item.id);
  if (!latest || latest.revision !== activeSession.item.revision || latest.questions.length !== activeSession.questions.length || latest.questions.some((question, index) => question.id !== activeSession.questions[index].id || question.revision !== activeSession.questions[index].revision)) {
    activeSession.stale = true;
    setDecisionMessage("This item changed remotely. Your drafts are preserved, but this session cannot be submitted. Close and reopen to review the new questions.", "conflict");
    const submit = document.querySelector(".decision-actions button:last-child"); if (submit && activeSession.index === activeSession.questions.length - 1) submit.disabled = true;
  }
}

async function load() {
  try {
    const [overview, config] = await Promise.all([api("/api/overview"), api("/api/config")]); currentOverview = overview; configuration = config.configuration;
    renderConnection(overview); renderBoard(overview); reconcileOpenSession(overview);
  } catch (error) { $("#connection").textContent = `● App unavailable · ${error.message}`; $("#connection").className = "connection failed"; }
}

const intakeForm = $("#intake-form"); const intakeContent = $("#intake-content"); submitOnEnter(intakeContent, intakeForm);
let intakeSubmitting = false;
intakeForm.addEventListener("submit", async (event) => {
  event.preventDefault(); if (intakeSubmitting) return; intakeSubmitting = true;
  const message = $("#intake-message"); message.textContent = "Saving…";
  try {
    const input = { content: intakeContent.value }; if ($("#project-hint").value.trim()) input.project_hint = $("#project-hint").value.trim();
    const result = await api("/api/intake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    message.textContent = `Saved ${result.item.id}. The local worker will pick it up.`; intakeContent.value = ""; $("#project-hint").value = ""; setTimeout(load, 500);
  } catch (error) { message.textContent = error.message; } finally { intakeSubmitting = false; }
});

$("#refresh").addEventListener("click", load);
$("#close-work").addEventListener("click", requestCloseWork);
$("#work-dialog").addEventListener("cancel", (event) => { if (hasDrafts()) { event.preventDefault(); requestCloseWork(); } else activeSession = null; });
(document.querySelectorAll?.(".tabs button[data-tab]") || []).forEach((button) => button.addEventListener("click", () => { if (!activeSession) return; activeSession.tab = button.dataset.tab; renderActiveTab(); }));
if (typeof window !== "undefined") window.addEventListener("beforeunload", (event) => { if (hasDrafts()) event.preventDefault(); });
$("#edit-config").addEventListener("click", () => { $("#config-editor").value = JSON.stringify(configuration, null, 2); $("#config-message").textContent = ""; $("#config-dialog").showModal(); });
$("#config-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return; event.preventDefault();
  try { const edited = JSON.parse($("#config-editor").value); await api("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ configuration: edited }) }); $("#config-dialog").close(); await load(); }
  catch (error) { $("#config-message").textContent = error.message; }
});

load(); setInterval(load, 5000);
