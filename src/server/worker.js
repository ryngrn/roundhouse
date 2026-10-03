export class WorkerLoop {
  constructor({ service, eventBroker = null, intervalMs = 2000, onError = () => {} }) {
    this.service = service;
    this.eventBroker = eventBroker;
    this.intervalMs = intervalMs;
    this.onError = onError;
    this.triageRunning = null;
    this.dispatchRunning = null;
    this.commandRunning = null;
    this.cycleRunning = null;
    this.timer = null;
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
    const store = this.service.store;
    if (!store?.claimRemoteCommand || this.commandRunning) return this.commandRunning ?? { remote_commands: 0 };
    this.commandRunning = (async () => {
      const command = await store.claimRemoteCommand();
      if (!command) { this.commandError = null; return { remote_commands: 0 }; }
      try {
        let result;
        if (command.kind === "intake") {
          result = await this.service.addToDepot(command.payload, { source: "remote-dashboard", actor: "ryan" });
        } else if (command.kind === "decision_session") {
          result = await this.service.answerDecisionSession({ ...command.payload, actor: "ryan" });
        } else {
          throw new Error(`Unsupported remote command: ${command.kind}`);
        }
        await store.finishRemoteCommand(command.id, { result });
        this.lastCommand = new Date().toISOString();
        this.commandError = null;
        return { remote_commands: 1 };
      } catch (error) {
        await store.finishRemoteCommand(command.id, { error: error.message }).catch(() => {});
        this.commandError = error.message;
        this.onError(error);
        return { remote_commands: 1, remote_command_error: error.message };
      }
    })();
    try { return await this.commandRunning; }
    finally { this.commandRunning = null; }
  }

  async triageTick() {
    if (this.triageRunning) return this.triageRunning;
    this.triageRunning = (async () => {
      try {
        const result = this.service.engine ? await this.service.engine.runTriage() : { triaged: 0 };
        const events = this.eventBroker ? await this.eventBroker.drain() : { attempted: 0 };
        this.lastTriage = new Date().toISOString();
        this.lastRun = this.lastTriage;
        this.triageError = null;
        if (!this.dispatchError) this.lastError = null;
        return { ...result, event_deliveries_attempted: events.attempted };
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

  sharedControlPlane() {
    return Boolean(this.service.engine?.store?.shared);
  }

  async tick() {
    if (this.cycleRunning) return this.cycleRunning;
    this.cycleRunning = (async () => {
      // Shared PostgreSQL state is snapshot-serialized. Run triage and dispatch
      // as one control-plane cycle so this process never waits on its own
      // long-lived snapshot transaction. Local file storage keeps the same
      // deterministic ordering for manual ticks.
      const commands = this.sharedControlPlane() ? await this.remoteCommandTick() : { remote_commands: 0 };
      const triage = await this.triageTick();
      const dispatch = await this.dispatchTick();
      return { ...commands, ...triage, ...dispatch, triaged: triage.triaged ?? 0, executed: dispatch.executed ?? 0,
        error: commands.remote_command_error ?? triage.error ?? dispatch.error };
    })();
    try { return await this.cycleRunning; }
    finally { this.cycleRunning = null; }
  }

  wake() {
    queueMicrotask(() => {
      if (this.sharedControlPlane()) this.tick();
      else { this.triageTick(); this.dispatchTick(); }
    });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.sharedControlPlane()) this.tick();
      else { this.triageTick(); this.dispatchTick(); }
    }, this.intervalMs);
    this.timer.unref();
    this.wake();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    return {
      running: Boolean(this.commandRunning || this.triageRunning || this.dispatchRunning),
      command_running: Boolean(this.commandRunning),
      triage_running: Boolean(this.triageRunning),
      dispatch_running: Boolean(this.dispatchRunning),
      current_activity: this.commandRunning ? "Routing remote signal" : this.triageRunning ? "Evaluating Depot work" : this.dispatchRunning ? "Dispatching eligible work" : "Idle",
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
