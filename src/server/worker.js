export class WorkerLoop {
  constructor({ service, eventBroker = null, intervalMs = 2000, onError = () => {} }) {
    this.service = service;
    this.eventBroker = eventBroker;
    this.intervalMs = intervalMs;
    this.onError = onError;
    this.triageRunning = null;
    this.dispatchRunning = null;
    this.timer = null;
    this.lastRun = null;
    this.lastError = null;
    this.lastTriage = null;
    this.lastDispatch = null;
    this.triageError = null;
    this.dispatchError = null;
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

  async tick() {
    // A manual tick is a deterministic complete pass: first make work eligible,
    // then dispatch it. The recurring timers remain independent so a long
    // execution cannot starve the control plane.
    const triage = await this.triageTick();
    const dispatch = await this.dispatchTick();
    return { ...triage, ...dispatch, triaged: triage.triaged ?? 0, executed: dispatch.executed ?? 0,
      error: triage.error ?? dispatch.error };
  }

  wake() {
    queueMicrotask(() => { this.triageTick(); this.dispatchTick(); });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.triageTick(); this.dispatchTick(); }, this.intervalMs);
    this.timer.unref();
    this.wake();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    return {
      running: Boolean(this.triageRunning || this.dispatchRunning),
      triage_running: Boolean(this.triageRunning),
      dispatch_running: Boolean(this.dispatchRunning),
      current_activity: this.triageRunning ? "Evaluating Depot work" : this.dispatchRunning ? "Dispatching eligible work" : "Idle",
      last_run: this.lastRun,
      last_triage: this.lastTriage,
      last_dispatch: this.lastDispatch,
      last_error: this.lastError,
      triage_error: this.triageError,
      dispatch_error: this.dispatchError,
    };
  }
}
