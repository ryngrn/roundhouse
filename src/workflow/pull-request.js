import { runProcess } from "./runtime.js";

function parseResult(result, operation) {
  if (!result.passed) throw new Error(`Pull-request ${operation} command failed (exit ${result.exit_code}): ${result.stderr}`);
  if (!result.stdout.trim()) throw new Error(`Pull-request ${operation} command must return one JSON result object.`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`Pull-request ${operation} command returned invalid JSON.`); }
}

function assertPullRequest(result, request) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Pull-request provider returned an invalid result.");
  if (!String(result.id ?? "").trim() || !String(result.url ?? "").trim()) throw new Error("Pull-request provider must return stable id and url fields.");
  if (result.correlation_key !== request.correlation_key) throw new Error("Pull-request provider did not preserve the durable job correlation key.");
  if (result.head_commit !== request.commit) throw new Error("Pull-request provider did not confirm the exact candidate commit.");
  if (request.previous && result.id !== request.previous.id) throw new Error("Pull-request provider replaced the correlated pull request during update.");
  return { ...result, status: result.status ?? "open", updated_at: new Date().toISOString() };
}

export class FixturePullRequestProvider {
  async upsert(request) {
    return assertPullRequest({
      id: request.previous?.id ?? `fixture-${request.correlation_key}`,
      url: request.previous?.url ?? `fixture://pull-request/${request.correlation_key}`,
      correlation_key: request.correlation_key,
      head_commit: request.commit,
      status: "open",
    }, request);
  }

  async merge(request) {
    return {
      status: "merged", pull_request_id: request.pull_request.id,
      head_commit: request.commit, merge_commit: request.commit,
      merged_at: new Date().toISOString(), provider: "fixture",
    };
  }
}

export class CommandPullRequestProvider {
  async #invoke(project, prepared, packet, onStart) {
    const result = await runProcess(project.pull_request.command, {
      cwd: prepared.workspace, input: JSON.stringify(packet), timeout: project.timeout_ms, onStart,
    });
    return parseResult(result, packet.action);
  }

  async upsert(request, { project, prepared, onStart }) {
    const result = await this.#invoke(project, prepared, { action: "upsert", ...request }, onStart);
    return assertPullRequest(result, request);
  }

  async merge(request, { project, prepared, onStart }) {
    const result = await this.#invoke(project, prepared, { action: "merge", ...request }, onStart);
    if (result?.status !== "merged") throw new Error(`Pull-request provider did not confirm merge (reported ${result?.status ?? "no status"}).`);
    if (result.pull_request_id !== request.pull_request.id || result.head_commit !== request.commit) {
      throw new Error("Pull-request provider merge result does not match the approved pull request and candidate commit.");
    }
    return { ...result, merged_at: result.merged_at ?? new Date().toISOString(), provider: "command" };
  }
}

export function pullRequestProvider(project) {
  if (project.pull_request?.kind === "fixture") return new FixturePullRequestProvider();
  if (project.pull_request?.kind === "command") return new CommandPullRequestProvider();
  return null;
}
