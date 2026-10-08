export class WorkerLoop {
  constructor({ service, eventBroker = null, commandQueue = null, onCycle = async () => {}, onError = () => {} }) {
    this.service = service;
    this.eventBroker = eventBroker;
    this.commandQueue = commandQueue;
    this.onCycle = onCycle;
    this.onError = onError;
    this.triageRunning = null;
    this.unblockerRunning = null;
    this.lastUnblocker = null;
    this.unblockerError = null;
    this.unblockerResult = null;
    this.dispatchRunning = null;
    this.commandRunning = null;
    this.cycleRunning = null;
    this.started = false;
    this.stopped = false;
    this.wakeRequested = false;
    this.wakeDrain = null;
    this.lastRun = null;
    this.lastError = null;
    this.lastTriage = null;
    this.lastDispatch = null;
    this.triageError = null;
    this.dispatchError = null;
    this.commandError = null;
    this.lastCommand = null;
  }

  handleError(plane, error) {
    if (!/^Locked:/.test(error.message)) {
      this.lastError = error.message;
      if (plane === "triage") this.triageError = error.message;
      else this.dispatchError = error.message;
      this.onError(error);
    }
    return { error: error.message };
  }

  async remoteCommandTick() {
    const queue = this.commandQueue;
    if (!queue?.claimRemoteCommand || this.commandRunning) return this.commandRunning ?? { remote_commands: 0 };
    this.commandRunning = (async () => {
      let processed = 0;
      let lastError;
      try {
        while (true) {
          const command = await queue.claimRemoteCommand();
          if (!command) break;
          processed += 1;
          try {
            let result;
            if (command.kind === "intake") {
              result = await this.service.addToDepot(command.payload, { source: "remote-dashboard", actor: "ryan" });
            } else if (command.kind === "decision_session") {
              result = await this.service.answerDecisionSession({ ...command.payload, actor: "ryan" });
            } else if (command.kind === "explode_job") {
              result = await this.service.explodeJob({ id: command.payload.job_id, expected_revision: command.payload.expected_revision,
                note: command.payload.note, actor: "ryan" });
            } else if (command.kind === "issue_resolution") {
              result = await this.service.resolveIssue({ ...command.payload, issue_id: command.payload.issue_id,
                expected_revision: command.payload.expected_revision, actor: "ryan" });
            } else {
              throw new Error(`Unsupported remote command: ${command.kind}`);
            }
            await queue.finishRemoteCommand(command.id, { result });
            this.lastCommand = new Date().toISOString();
            this.commandError = null;
          } catch (error) {
            await queue.finishRemoteCommand(command.id, { error: error.message }).catch(() => {});
            this.commandError = error.message;
            lastError = error.message;
            this.onError(error);
          }
        }
      } catch (error) {
        this.commandError = error.message;
        lastError = error.message;
        this.onError(error);
      }
      if (!processed && !lastError) this.commandError = null;
      return { remote_commands: processed, ...(lastError ? { remote_command_error: lastError } : {}) };
    })();
    try { return await this.commandRunning; }
    finally { this.commandRunning = null; }
  }

  async unblockerTick() {
    if (this.unblockerRunning) return this.unblockerRunning;
    if (!this.service.engine?.runUnblocker) return { released_projects: [] };
    this.unblockerRunning = (async () => {
      try {
        const result = await this.service.engine.runUnblocker();
        this.lastUnblocker = new Date().toISOString();
        this.unblockerResult = { released_projects: result.released_projects, refreshed: result.refreshed,
          isolated_jobs: result.isolated_jobs, needs_attention: result.needs_attention };
        this.unblockerError = null;
        return result;
      } catch (error) {
        this.unblockerError = error.message;
        this.onError(error);
        return { released_projects: [], unblocker_error: error.message };
      } finally { this.unblockerRunning = null; }
    })();
    return this.unblockerRunning;
  }

  async triageTick() {
    if (this.triageRunning) return this.triageRunning;
    this.triageRunning = (async () => {
      try {
        const result = this.service.engine ? await this.service.engine.runTriage() : { triaged: 0 };
        this.lastTriage = new Date().toISOString();
        this.lastRun = this.lastTriage;
        this.triageError = null;
        if (!this.dispatchError) this.lastError = null;
        return result;
      } catch (error) { return { triaged: 0, ...this.handleError("triage", error) }; }
      finally { this.triageRunning = null; }
    })();
    return this.triageRunning;
  }

  async dispatchTick() {
    if (this.dispatchRunning) return this.dispatchRunning;
    this.dispatchRunning = (async () => {
      try {
        const result = this.service.engine ? await this.service.engine.runDispatch() : { executed: 0 };
        this.lastDispatch = new Date().toISOString();
        this.lastRun = this.lastDispatch;
        this.dispatchError = null;
        if (!this.triageError) this.lastError = null;
        return result;
      } catch (error) { return { executed: 0, ...this.handleError("dispatch", error) }; }
      finally { this.dispatchRunning = null; }
    })();
    return this.dispatchRunning;
  }

  async tick() {
    if (this.cycleRunning) return this.cycleRunning;
    this.cycleRunning = (async () => {
      // Remote commands are an optional relay concern. The local store remains
      // authoritative, so a relay failure must never prevent local triage or dispatch.
      const commands = this.commandQueue ? await this.remoteCommandTick() : { remote_commands: 0 };
      const unblocker = await this.unblockerTick();
      const triage = await this.triageTick();
      const dispatch = await this.dispatchTick();
      // An execution failure may have created a new isolated hold in this cycle.
      if (dispatch.executed) await this.unblockerTick();
      const events = this.eventBroker ? await this.eventBroker.drain() : { attempted: 0 };
      const result = { ...commands, ...unblocker, ...triage, ...dispatch, triaged: triage.triaged ?? 0, executed: dispatch.executed ?? 0,
        event_deliveries_attempted: events.attempted ?? 0,
        error: commands.remote_command_error ?? triage.error ?? dispatch.error };
      await this.onCycle(result);
      return result;
    })();
    try { return await this.cycleRunning; }
    finally { this.cycleRunning = null; }
  }

  wake() {
    if (this.stopped) return Promise.resolve();
    this.wakeRequested = true;
    if (!this.wakeDrain) {
      this.wakeDrain = Promise.resolve().then(async () => {
        while (this.wakeRequested && !this.stopped) {
          this.wakeRequested = false;
          // A signal received while any cycle is active must cause a distinct
          // cycle after that work finishes; awaiting the active promise alone
          // would otherwise consume and lose the signal.
          if (this.cycleRunning) await this.cycleRunning;
          await this.tick();
        }
      }).catch(this.onError).finally(() => {
        this.wakeDrain = null;
        if (this.wakeRequested && !this.stopped) this.wake();
      });
    }
    return this.wakeDrain;
  }

  start() {
    if (this.started) return this.wakeDrain;
    this.started = true;
    this.stopped = false;
    return this.wake();
  }

  stop() {
    this.stopped = true;
    this.wakeRequested = false;
    return Promise.allSettled([this.wakeDrain, this.cycleRunning].filter(Boolean));
  }

  status() {
    return {
      running: Boolean(this.commandRunning || this.unblockerRunning || this.triageRunning || this.dispatchRunning),
      unblocker_running: Boolean(this.unblockerRunning),
      last_unblocker: this.lastUnblocker,
      unblocker_error: this.unblockerError,
      unblocker_result: this.unblockerResult,
      command_running: Boolean(this.commandRunning),
      triage_running: Boolean(this.triageRunning),
      dispatch_running: Boolean(this.dispatchRunning),
      current_activity: this.commandRunning ? "Routing remote signal" : this.unblockerRunning ? "Unblocker resolving held work" : this.triageRunning ? "Evaluating Depot work" : this.dispatchRunning ? "Dispatching eligible work" : "Idle",
      last_run: this.lastRun,
      last_triage: this.lastTriage,
      last_dispatch: this.lastDispatch,
      last_error: this.lastError,
      triage_error: this.triageError,
      dispatch_error: this.dispatchError,
      command_error: this.commandError,
      last_command: this.lastCommand,
    };
  }
}
