import { digest } from "../storage/repository.js";

export const actionClasses = ["read_only", "consequential", "human_task"];

/**
 * Action authority is derived at the trusted workflow boundary. A decision may
 * conservatively elevate a slice, but neither model output nor request text can
 * downgrade capabilities whose providers can change the outside world.
 */
export function classifyAction(work = {}) {
  const capabilities = new Set(work.required_capabilities ?? []);
  if (capabilities.has("human-task")) return "human_task";
  if (capabilities.has("external-action")) return "consequential";
  return actionClasses.includes(work.action_class) ? work.action_class : "read_only";
}

export function approvalScope(work, policyHash) {
  return digest({ work, policy_hash: policyHash });
}

export function actionPolicy(work, policyHash, approval = null) {
  const classification = classifyAction(work);
  const scope_digest = approvalScope(work, policyHash);
  const authorized = classification === "read_only" || Boolean(approval
    && approval.scope_digest === scope_digest
    && typeof approval.actor === "string" && approval.actor.trim()
    && typeof approval.approved_at === "string" && !Number.isNaN(Date.parse(approval.approved_at))
    && Number.isInteger(approval.item_revision)
    && approval.item_revision > 0);
  return {
    classification,
    approval_required: classification !== "read_only",
    scope_digest,
    authorized,
    approval: classification === "read_only" ? null : approval,
  };
}

export function assertProviderAuthorized(job) {
  const policy = actionPolicy(job.work, job.policy_hash, job.action_policy?.approval ?? null);
  if (policy.classification === "human_task") {
    throw new Error("Human tasks must be completed through the durable human-task lifecycle, not an execution provider.");
  }
  if (!policy.authorized) {
    throw new Error("Consequential external action requires current revision-bound approval before provider execution.");
  }
  if (policy.classification !== "read_only"
    && (job.action_policy?.classification !== policy.classification || job.action_policy?.scope_digest !== policy.scope_digest)) {
    throw new Error("Action classification or approval scope changed after decision; a new decision and approval are required.");
  }
  return policy;
}
