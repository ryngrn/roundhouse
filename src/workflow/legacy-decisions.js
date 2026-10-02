import { digest } from "../storage/repository.js";

// This recognizes the structured format emitted by the archived Notion Depot:
// a complete, sequential `1) … 2) …` list. It intentionally does not attempt
// to infer questions from arbitrary prose.
export function parseLegacyEnumeratedDecisions(prompt) {
  if (typeof prompt !== "string") return [];
  const matches = [...prompt.matchAll(/(?:^|\s)(\d+)\)\s+/g)];
  if (matches.length < 2 || matches.some((match, index) => Number(match[1]) !== index + 1)) return [];
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? prompt.length;
    return prompt.slice(start, end).trim().replace(/[.;]\s*$/, "");
  }).filter(Boolean);
}

export function normalizedLegacyQuestions(question, at = new Date().toISOString()) {
  if (question?.kind !== "imported_decision" || question.status !== "open") return null;
  const prompts = parseLegacyEnumeratedDecisions(question.prompt);
  if (prompts.length < 2) return null;
  return prompts.map((prompt, index) => ({
    id: `legacy-question-${digest(`${question.id}:${index + 1}`).slice(0, 24)}`,
    decision_id: question.decision_id ?? null,
    decision_key: `${question.decision_key ?? `legacy:${question.id}`}:${index + 1}`,
    item_id: question.item_id,
    item_revision: question.item_revision,
    revision: 1,
    kind: question.kind,
    prompt,
    status: "open",
    created_at: question.created_at ?? at,
    updated_at: at,
    provenance: {
      normalization: "notion-sequential-enumeration-v1",
      source_question_id: question.id,
      source_prompt: question.prompt,
      position: index + 1,
      count: prompts.length,
    },
  }));
}

export function migrateLegacyDecisionQuestions(store, now = () => new Date().toISOString()) {
  const snapshot = store.read();
  if (snapshot?.then) return snapshot.then(() => migrateLegacyDecisionQuestionsAsync(store, now));
  const candidates = Object.values(snapshot.items).filter((item) =>
    (item.questions ?? []).some((question) => normalizedLegacyQuestions(question, item.updated_at ?? item.created_at)),
  );
  if (!candidates.length) return { migrated_items: 0, created_questions: 0 };
  return store.change((data) => {
    let migratedItems = 0;
    let createdQuestions = 0;
    for (const candidate of candidates) {
      const item = data.items[candidate.id];
      if (!item) continue;
      const at = now();
      let changed = false;
      const additions = [];
      for (const question of item.questions ?? []) {
        const normalized = normalizedLegacyQuestions(question, at);
        if (!normalized) continue;
        question.status = "normalized";
        question.revision += 1;
        question.updated_at = at;
        question.normalized_question_ids = normalized.map((entry) => entry.id);
        additions.push(...normalized);
        changed = true;
      }
      if (!changed) continue;
      item.questions.push(...additions);
      item.revision += 1;
      item.updated_at = at;
      item.domain_migrations ??= [];
      item.domain_migrations.push({ id: "notion-enumerated-decisions-v1", at, created_question_ids: additions.map((entry) => entry.id) });
      migratedItems += 1;
      createdQuestions += additions.length;
    }
    return { migrated_items: migratedItems, created_questions: createdQuestions };
  });
}

async function migrateLegacyDecisionQuestionsAsync(store, now) {
  const snapshot = await store.read();
  const candidates = Object.values(snapshot.items).filter((item) =>
    (item.questions ?? []).some((question) => normalizedLegacyQuestions(question, item.updated_at ?? item.created_at)),
  );
  if (!candidates.length) return { migrated_items: 0, created_questions: 0 };
  return store.change((data) => {
    let migratedItems = 0;
    let createdQuestions = 0;
    for (const candidate of candidates) {
      const item = data.items[candidate.id];
      if (!item) continue;
      const at = now();
      const additions = [];
      for (const question of item.questions ?? []) {
        const normalized = normalizedLegacyQuestions(question, at);
        if (!normalized) continue;
        question.status = "normalized";
        question.revision += 1;
        question.updated_at = at;
        question.normalized_question_ids = normalized.map((entry) => entry.id);
        additions.push(...normalized);
      }
      if (!additions.length) continue;
      item.questions.push(...additions);
      item.revision += 1;
      item.updated_at = at;
      item.domain_migrations ??= [];
      item.domain_migrations.push({ id: "notion-enumerated-decisions-v1", at, created_question_ids: additions.map((entry) => entry.id) });
      migratedItems += 1;
      createdQuestions += additions.length;
    }
    return { migrated_items: migratedItems, created_questions: createdQuestions };
  });
}
