const $ = (selector) => document.querySelector(selector);
let configuration = { projects: [] };
let currentOverview = null;
let activeSession = null;
let dashboardFilters = { status: "needs", project: null, search: "", sort: "priority", show: "active", view: "list" };

const TRAIN_LANGUAGE = Object.freeze({
  needs: "Needs a signal",
  active: "Chugging along",
  queued: "Ready to depart",
  shipped: "Reached the station",
  blocked: "Held up",
  depot: "Depot",
  next: "Next departure",
});

const trainState = (state) => {
  if (["Needs You", "Needs Clarification", "Review"].includes(state)) return TRAIN_LANGUAGE.needs;
  if (["Decision", "Executing", "Verification", "Rework"].includes(state)) return TRAIN_LANGUAGE.active;
  if (state === "Ready") return TRAIN_LANGUAGE.queued;
  if (["Shipped", "Imported History"].includes(state)) return TRAIN_LANGUAGE.shipped;
  if (state === "Blocked") return TRAIN_LANGUAGE.blocked;
  if (["Depot", "Imported Pending"].includes(state)) return TRAIN_LANGUAGE.depot;
  return state;
};

function renderTrainLanguage() {
  for (const element of document.querySelectorAll?.("[data-train-label]") || []) {
    element.textContent = TRAIN_LANGUAGE[element.dataset.trainLabel] || element.textContent;
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  let data;
  if (typeof response.text === "function") {
    const raw = await response.text();
    try { data = raw ? JSON.parse(raw) : {}; }
    catch { data = { error: raw.trim() || `Request failed (${response.status})` }; }
  } else {
    data = await response.json();
  }
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

const PROJECT_VISUALS = [
  { match: /roundhouse/i, emoji: "🚂", accent: "#b9d76c" },
  { match: /omnia/i, emoji: "👥", accent: "#5aa7e8" },
  { match: /growthpath/i, emoji: "🌱", accent: "#78c89a" },
  { match: /ryan\.?green/i, emoji: "💻", accent: "#ae8cff" },
  { match: /inclusion/i, emoji: "♿", accent: "#e8a86f" },
  { match: /stringed|guitar/i, emoji: "🎸", accent: "#e7b45f" },
  { match: /cemetery/i, emoji: "🪦", accent: "#9ca1b3" },
  { match: /family legacy/i, emoji: "🌳", accent: "#68b184" },
  { match: /ipad|monitor/i, emoji: "📱", accent: "#72b8c9" },
  { match: /drummer|drum/i, emoji: "🥁", accent: "#d18ce8" },
];

function projectVisual(group) {
  const label = [group.id, group.name].filter(Boolean).join(" ");
  return PROJECT_VISUALS.find((visual) => visual.match.test(label)) || { emoji: "📦", accent: "#78827d" };
}

function statusMatches(item, key) {
  if (!key || key === "all") return true;
  if (key === "needs") return item.needs_you;
  if (key === "active") return ["Decision", "Executing", "Verification", "Rework"].includes(item.state);
  if (key === "queued") return ["Depot", "Ready", "Imported Pending"].includes(item.state) && !item.needs_you;
  if (key === "shipped") return ["Shipped", "Imported History", "Archived", "Reconciled"].includes(item.state);
  if (key === "blocked") return item.state === "Blocked";
  return true;
}

function priorityValue(item) {
  const match = String(item.priority || "").match(/\d+/);
  return match ? Number(match[0]) : 99;
}

function projectIsCompleted(group) {
  return group.items.length > 0 && group.items.every((item) => ["Shipped", "Imported History", "Archived", "Reconciled"].includes(item.state));
}

function updateFilterControls() {
  for (const button of document.querySelectorAll?.("[data-filter-key]") || []) {
    const selected = button.dataset.filterKey === dashboardFilters.status;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  for (const button of document.querySelectorAll?.("[data-view]") || []) {
    const selected = button.dataset.view === dashboardFilters.view;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  const clear = $("#clear-filter");
  if (clear) clear.hidden = dashboardFilters.status === "all" && !dashboardFilters.project && !dashboardFilters.search;
}

function setDashboardFilter(next) {
  dashboardFilters = { ...dashboardFilters, ...next };
  updateFilterControls();
  if (currentOverview) renderBoard(currentOverview);
}


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
  $("#count-all").textContent = overview.items.length;
  const countIds = { needs_you: "needs", active: "active", queued: "queued", completed: "completed", blocked: "blocked" };
  for (const [key, id] of Object.entries(countIds)) $("#count-" + id).textContent = overview.counts[key];
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
  const state = node("span", trainState(item.display_state), `state state-${slug(item.display_state)}`);
  state.title = item.display_state;
  kicker.append(state);
  if (item.priority) kicker.append(node("span", item.priority, "priority"));
  identity.append(kicker, node("strong", item.title), node("span", item.reason || item.brief || item.summary, "row-reason"));
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
    active: items.filter((item) => ["Decision", "Executing", "Verification", "Rework"].includes(item.state)).length,
    queued: items.filter((item) => ["Depot", "Ready", "Imported Pending"].includes(item.state) && !item.needs_you).length,
    shipped: items.filter((item) => ["Shipped", "Imported History"].includes(item.state)).length,
    blocked: items.filter((item) => item.state === "Blocked").length,
  };
}

function allocationSummary(decision) {
  if (!decision) return null;
  const capability = decision.constraints.capability;
  const capacity = decision.constraints.capacity;
  const locks = decision.constraints.locks;
  const fit = capability.missing.length ? `missing ${capability.missing.join(", ")}` : "capabilities fit";
  const conflict = locks.conflicts.length ? `locks ${locks.conflicts.join(", ")}` : "locks clear";
  const resources = decision.constraints.resources.map((resource) => `${resource.resource} ${resource.used}+${resource.requested}/${resource.limit}`).join(", ") || "no counted resources";
  return `${decision.result} · slice ${decision.job_id} · ${decision.eligible ? "eligible" : "ineligible"} · queue ${decision.queue.position}/${decision.queue.length} · weight ${decision.fairness.weight}, score ${decision.fairness.weighted_allocation}, rank ${decision.fairness.rank || "—"} · ${fit} · capacity ${capacity.used}+${capacity.requested}/${capacity.limit} · project ${decision.constraints.project.active}/${decision.constraints.project.limit} · ${resources} · ${conflict} · ${decision.reason.message}`;
}

function renderBoard(overview) {
  const root = $("#project-board");
  root.replaceChildren();
  root.className = "project-board view-" + dashboardFilters.view;

  const configured = new Map((configuration.projects || []).map((project) => [project.id, project]));
  const groups = new Map();
  for (const project of configuration.projects || []) {
    groups.set("project:" + project.id, {
      key: "project:" + project.id, type: "project", id: project.id, name: project.name,
      detail: project.purpose, status: project.status || "active", items: [], allocation: overview.allocations?.latest?.[project.id] ?? null,
    });
  }
  for (const candidate of Object.values(overview.project_candidates || {})) {
    groups.set("candidate:" + candidate.id, {
      key: "candidate:" + candidate.id, type: "candidate", id: candidate.id, name: candidate.name,
      detail: "Project candidate · execution not configured", status: candidate.status || "candidate", items: [],
    });
  }
  groups.set("unassigned", {
    key: "unassigned", type: "unassigned", id: "unassigned", name: "Unknown / Unassigned",
    detail: "Project still needs to be identified", status: "candidate", items: [],
  });

  for (const item of overview.items) {
    const key = item.project ? "project:" + item.project : item.project_candidate ? "candidate:" + item.project_candidate.id : "unassigned";
    if (!groups.has(key)) {
      groups.set(key, {
        key, type: "project", id: item.project, name: configured.get(item.project)?.name || item.project,
        detail: configured.get(item.project)?.purpose || "Configured project", status: configured.get(item.project)?.status || "active", items: [],
        allocation: overview.allocations?.latest?.[item.project] ?? null,
      });
    }
    groups.get(key).items.push(item);
  }

  const query = dashboardFilters.search.trim().toLowerCase();
  let ordered = [...groups.values()]
    .filter((group) => group.items.length || group.type === "project")
    .filter((group) => dashboardFilters.show === "all" || (dashboardFilters.show === "completed" ? projectIsCompleted(group) : !projectIsCompleted(group) || group.status === "active"))
    .filter((group) => !dashboardFilters.project || group.key === dashboardFilters.project)
    .map((group) => {
      const groupMatches = !query || [group.name, group.detail].some((value) => String(value || "").toLowerCase().includes(query));
      let visibleItems = group.items.filter((item) => statusMatches(item, dashboardFilters.status));
      if (query && !groupMatches) {
        visibleItems = visibleItems.filter((item) =>
          [item.title, item.summary, item.reason, item.brief, item.agent_role, item.priority]
            .some((value) => String(value || "").toLowerCase().includes(query)));
      }
      return { ...group, visibleItems, groupMatches };
    })
    .filter((group) => {
      if (dashboardFilters.status !== "all" && !group.visibleItems.length) return false;
      if (query && !group.groupMatches && !group.visibleItems.length) return false;
      return true;
    });

  if (dashboardFilters.sort === "name") {
    ordered.sort((a, b) => a.name.localeCompare(b.name));
  } else if (dashboardFilters.sort === "updated") {
    ordered.sort((a, b) => {
      const latest = (group) => Math.max(0, ...group.items.map((item) => Date.parse(item.updated_at || item.created_at || 0) || 0));
      return latest(b) - latest(a) || a.name.localeCompare(b.name);
    });
  } else {
    ordered.sort((a, b) => {
      const best = (group) => Math.min(99, ...group.items.map(priorityValue));
      return best(a) - best(b) || a.name.localeCompare(b.name);
    });
  }

  const visibleCount = ordered.reduce((sum, group) => sum + group.visibleItems.length, 0);
  const itemCount = $("#project-item-count");
  if (itemCount) itemCount.textContent = visibleCount + (visibleCount === 1 ? " item" : " items");

  if (!ordered.length) {
    root.append(node("p", "No projects match these filters.", "empty-state"));
    return;
  }

  for (const group of ordered) {
    const visual = projectVisual(group);
    const section = node("section", undefined, "project-group project-card");
    section.style.setProperty("--project-accent", visual.accent);

    const heading = node("header", undefined, "project-heading");
    const identity = node("button", undefined, "project-identity");
    identity.type = "button";
    identity.setAttribute("aria-label", "Filter to " + group.name);
    identity.setAttribute("aria-pressed", String(dashboardFilters.project === group.key));
    identity.addEventListener("click", () => {
      setDashboardFilter({ project: dashboardFilters.project === group.key ? null : group.key });
    });

    const icon = node("span", visual.emoji, "project-icon");
    icon.setAttribute("aria-hidden", "true");
    const copy = node("span", undefined, "project-copy");
    copy.append(node("strong", group.name), node("span", group.detail || "", "project-detail"));
    identity.append(icon, copy);

    const counts = groupStatus(group.items);
    const atGlance = node("div", undefined, "project-counts");
    const statuses = [
      ["needs", TRAIN_LANGUAGE.needs, counts.needs],
      ["active", TRAIN_LANGUAGE.active, counts.active],
      ["queued", TRAIN_LANGUAGE.queued, counts.queued],
      ["shipped", TRAIN_LANGUAGE.shipped, counts.shipped],
      ["blocked", TRAIN_LANGUAGE.blocked, counts.blocked],
    ];
    for (const [key, label, value] of statuses) {
      if (!value) continue;
      const filter = node("button", undefined, "project-status status-filter-" + key);
      filter.type = "button";
      filter.setAttribute("aria-label", "Filter " + group.name + " by " + label);
      filter.setAttribute("aria-pressed", String(dashboardFilters.project === group.key && dashboardFilters.status === key));
      filter.append(node("span", label), node("strong", String(value)));
      filter.addEventListener("click", () => {
        const same = dashboardFilters.project === group.key && dashboardFilters.status === key;
        setDashboardFilter({ project: same ? null : group.key, status: same ? "all" : key });
      });
      atGlance.append(filter);
    }

    const chevron = node("button", "›", "project-chevron");
    chevron.type = "button";
    chevron.setAttribute("aria-label", "Filter to " + group.name);
    chevron.addEventListener("click", () => setDashboardFilter({ project: dashboardFilters.project === group.key ? null : group.key }));
    heading.append(identity, atGlance, chevron);
    section.append(heading);
    const allocation = allocationSummary(group.allocation);
    if (allocation) section.append(node("p", `Dispatch · ${allocation}`, "allocation-summary"));

    const labels = node("div", undefined, "row-labels");
    labels.append(node("span", "Work / current activity"), node("span", "Ownership / delivery"), node("span", "Updated"));
    section.append(labels);

    const rows = node("div", undefined, "work-rows");
    if (!group.visibleItems.length) rows.append(node("p", "No matching work", "empty-state compact"));
    for (const item of group.visibleItems) rows.append(workRow(item));
    section.append(rows);
    root.append(section);
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
  for (const section of [detailSection("Outcome", item.outcome || item.brief || "Outcome is still being defined.", "featured"), detailSection("Brief", item.brief), detailSection("Context", item.context), detailSection("Acceptance criteria", item.acceptance_criteria)]) if (section) root.append(section);
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
  const allocationHistory = item.allocation_history
    || item.jobs?.flatMap((job) => job.allocation_history || [])
    || [];
  const allocations = allocationHistory.map(allocationSummary).filter(Boolean);
  root.append(detailSection("Allocation decisions", allocations.length ? allocations : ["No dispatch decision recorded yet."]));
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
  for (const value of [`${trainState(item.display_state)} · ${item.display_state}`, item.priority, item.agent_role ? `Role · ${item.agent_role}` : null, item.owning_node ? `Node · ${item.owning_node}` : null, `Verify · ${item.verification_status}`, `Ship · ${item.shipping_status}`].filter(Boolean)) strip.append(node("span", value));
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

let loadTail = Promise.resolve();
let pendingLoads = 0;
async function readAndRender() {
  try {
    const [overview, config] = await Promise.all([api("/api/overview"), api("/api/config")]); currentOverview = overview; configuration = config.configuration;
    renderConnection(overview); updateFilterControls(); renderBoard(overview); reconcileOpenSession(overview);
  } catch (error) { $("#connection").textContent = `● App unavailable · ${error.message}`; $("#connection").className = "connection failed"; }
}
function load() {
  pendingLoads += 1;
  const queuedLoad = loadTail.then(readAndRender).finally(() => { pendingLoads -= 1; });
  loadTail = queuedLoad;
  return queuedLoad;
}
function loadCoalesced() {
  return pendingLoads > 0 ? loadTail : load();
}

const intakeDialog = $("#intake-dialog");
const intakeForm = $("#intake-form"); const intakeContent = $("#intake-content"); submitOnEnter(intakeContent, intakeForm);
function openIntakeDialog() {
  $("#intake-message").textContent = "";
  intakeDialog.showModal();
  setTimeout(() => intakeContent.focus(), 0);
}
$("#open-intake").addEventListener("click", openIntakeDialog);
$("#close-intake").addEventListener("click", () => intakeDialog.close());
$("#cancel-intake").addEventListener("click", () => intakeDialog.close());
let intakeSubmitting = false;
intakeForm.addEventListener("submit", async (event) => {
  event.preventDefault(); if (intakeSubmitting) return; intakeSubmitting = true;
  const message = $("#intake-message"); message.textContent = "Saving…";
  try {
    const input = { content: intakeContent.value }; if ($("#project-hint").value.trim()) input.project_hint = $("#project-hint").value.trim();
    const result = await api("/api/intake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    message.textContent = `Saved ${result.item.id}. The local worker will pick it up.`;
    intakeContent.value = ""; $("#project-hint").value = "";
    setTimeout(load, 250);
    setTimeout(() => { intakeDialog.close(); message.textContent = ""; }, 550);
  } catch (error) { message.textContent = error.message; } finally { intakeSubmitting = false; }
});

for (const button of document.querySelectorAll?.("[data-filter-key]") || []) {
  button.addEventListener("click", () => setDashboardFilter({ status: button.dataset.filterKey, project: null }));
}
$("#project-search")?.addEventListener("input", (event) => setDashboardFilter({ search: event.target.value }));
$("#project-sort")?.addEventListener("change", (event) => setDashboardFilter({ sort: event.target.value }));
$("#project-show")?.addEventListener("change", (event) => setDashboardFilter({ show: event.target.value }));
for (const button of document.querySelectorAll?.("[data-view]") || []) {
  button.addEventListener("click", () => setDashboardFilter({ view: button.dataset.view }));
}
$("#clear-filter")?.addEventListener("click", () => {
  dashboardFilters = { ...dashboardFilters, status: "all", project: null, search: "" };
  const search = $("#project-search"); if (search) search.value = "";
  updateFilterControls();
  if (currentOverview) renderBoard(currentOverview);
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

if (typeof window !== "undefined") {
  let lifecycleRefreshTimer;
  const refreshAfterLifecycleChange = () => {
    clearTimeout(lifecycleRefreshTimer);
    lifecycleRefreshTimer = setTimeout(() => {
      loadCoalesced();
    }, 150);
  };
  window.addEventListener("pageshow", refreshAfterLifecycleChange);
  window.addEventListener("focus", refreshAfterLifecycleChange);
  document.addEventListener?.("visibilitychange", () => { if (document.visibilityState === "visible") refreshAfterLifecycleChange(); });
}
renderTrainLanguage(); updateFilterControls(); load();
