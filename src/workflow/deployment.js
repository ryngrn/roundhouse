import { runProcess } from "./runtime.js";
import { assertNotRemoteDesktopCommanderCommand } from "./remote-desktop-policy.js";

export class FixtureDeployProvider {
  async deploy({ project, verification }) {
    return {
      provider: "fixture",
      environment: project.deployment.environment,
      status: "succeeded",
      revision: verification.commit,
      url: `fixture://${project.id}/${project.deployment.environment}/${verification.commit}`,
      deployed_at: new Date().toISOString(),
    };
  }
}

export class CommandDeployProvider {
  async deploy({ project, prepared, verification, onStart }) {
    assertNotRemoteDesktopCommanderCommand(project.deployment.command, `Project ${project.id} deployment provider`);
    const packet = {
      project: project.id,
      repository: project.repository,
      workspace: prepared.workspace,
      branch: prepared.branch,
      commit: verification.commit,
      environment: project.deployment.environment,
      verification,
    };
    const result = await runProcess(project.deployment.command, {
      cwd: prepared.workspace,
      input: JSON.stringify(packet),
      timeout: project.timeout_ms,
      onStart,
    });
    if (!result.passed) throw new Error(`Deployment command failed (exit ${result.exit_code}): ${result.stderr}`);
    let reported = {};
    if (result.stdout.trim()) {
      try { reported = JSON.parse(result.stdout); }
      catch { throw new Error("Deployment command stdout must be empty or one JSON result object."); }
    }
    if (reported.status && reported.status !== "succeeded") throw new Error(`Deployment provider reported ${reported.status}.`);
    return {
      provider: "command",
      environment: project.deployment.environment,
      status: "succeeded",
      revision: verification.commit,
      deployed_at: new Date().toISOString(),
      ...reported,
    };
  }
}

export function deploymentProvider(project) {
  if (project.deployment?.kind === "fixture") return new FixtureDeployProvider();
  if (project.deployment?.kind === "command") return new CommandDeployProvider();
  return null;
}
