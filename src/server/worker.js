import { ControlPlaneHealthScheduler } from "./control-plane-health.js";

export class WorkerLoop {
  constructor({ service, eventBroker = null, commandQueue = null, onCycle = async () => {}, onError = () => {},
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, now = () => Date.now(),
    reconciliationIntervalMs = 5 * 60 * 1000, maxRemoteCommandsPerCycle = 20,
    maxImmediateWakeCycles = 2, deferredWakeDelayMs = 1_000, healthScheduler } = {}) {
    this.service = service;
    this.eventBroker = eventBroker;
    this.commandQueue = commandQueue;
    this.onCycle = onCycle;
    this.onError = onError;
    this.triageRunning = null;
    this.dispatchRunning = null;
    this.commandRunning = null;
    this.cycleRunning = null;
    this.started = false;
    this.stopped = false;
    this.wakeRequested = false;
    this.wakeDrain = null;
    this.deferredWakeTimer = null;
    this.deferredWakeDelayMs = deferredWakeDelayMs;
    this.maxImmediateWakeCycles = maxImmediateWakeCycles;
    this.maxRemoteCommandsPerCycle = maxRemoteCommandsPerCycle;
    if (!Number.isInteger(this.maxImmediateWakeCycles) || this.maxImmediateWakeCycles < 1) {
      throw new Error("maxImmediateWakeCycles must be a positive integer.");
    }
    if (!Number.isInteger(this.maxRemoteCommandsPerCycle) || this.maxRemoteCommandsPerCycle < 1) {
      throw new Error("maxRemoteCommandsPerCycle must be a positive integer.");
    }
    if (!Number.isFinite(this.deferredWakeDelayMs) || this.deferredWakeDelayMs < 1) {
      throw new Error("deferredWakeDelayMs must be positive.");
    }
    this.lastRun = null;
    this.lastError = null;
    this.lastTriage = null;
    this.lastDispatch = null;
    this.triageError = null;
    this.dispatchError = null;
    this.commandError = null;
    this.lastCommand = null;
    this.scheduledWakeTimer = null;
    this.nextScheduledWakeAt = null;
    this.reconciliationTimer = null;
    this.nextReconciliationAt = null;
    this.reconciliationIntervalMs = reconciliationIntervalMs;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.now = now;
    this.healthScheduler = healthScheduler ?? new ControlPlaneHealthScheduler({ store: service?.store, onError, now, setTimeoutFn, clearTimeoutFn });
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
        while (processed < this.maxRemoteCommandsPerCycle) {
          const command = await queue.claimRemoteCommand();
          if (!command) break;
          processed += 1;
          try {
            let result;
            if (command.kind === "intake") {
              result = await this.service.addToDepot(command.payload, { source: "remote-dashboard", actor: "ryan" });
            } else if (command.kind === "decision_session") {
              result = await this.service.answerDecisionSession({ ...command.payload, actor: "ryan" });
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
      return { remote_commands: processed,
        remote_command_limit_reached: processed >= this.maxRemoteCommandsPerCycle,
        ...(lastError ? { remote_command_error: lastError } : {}) };
    })();
    try { return await this.commandRunning; }
    finally { this.commandRunning = null; }
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
      const triage = await this.triageTick();
      const dispatch = await this.dispatchTick();
      const events = this.eventBroker ? await this.eventBroker.drain() : { attempted: 0 };
      const result = { ...commands, ...triage, ...dispatch, triaged: triage.triaged ?? 0, executed: dispatch.executed ?? 0,
        event_deliveries_attempted: events.attempted ?? 0,
        error: commands.remote_command_error ?? triage.error ?? dispatch.error };
      await this.onCycle(result);
      await this.scheduleNextWake();
      return result;
    })();
    try { return await this.cycleRunning; }
    finally { this.cycleRunning = null; }
  }

  async scheduleNextWake() {
    if (this.scheduledWakeTimer) this.clearTimeoutFn(this.scheduledWakeTimer);
    this.scheduledWakeTimer = null;
    this.nextScheduledWakeAt = null;
    if (this.stopped || !this.service.engine?.nextScheduledWake) return;
    const next = await this.service.engine.nextScheduledWake();
    if (!next) return;
    this.nextScheduledWakeAt = next;
    const delay = Math.max(0, Math.min(Date.parse(next) - this.now(), 2_147_483_647));
    this.scheduledWakeTimer = this.setTimeoutFn(() => {
      this.scheduledWakeTimer = null;
      this.wake();
    }, delay);
    this.scheduledWakeTimer.unref?.();
  }

  wake() {
    if (this.stopped) return Promise.resolve();
    this.wakeRequested = true;
    if (this.deferredWakeTimer) return this.wakeDrain ?? Promise.resolve();
    if (!this.wakeDrain) {
      this.wakeDrain = Promise.resolve().then(async () => {
        let cycles = 0;
        while (this.wakeRequested && !this.stopped && cycles < this.maxImmediateWakeCycles) {
          this.wakeRequested = false;
          // A signal received while any cycle is active must cause a distinct
          // cycle after that work finishes; awaiting the active promise alone
          // would otherwise consume and lose the signal.
          if (this.cycleRunning) await this.cycleRunning;
          await this.tick();
          cycles += 1;
        }
      }).catch(this.onError).finally(() => {
        this.wakeDrain = null;
        if (this.wakeRequested && !this.stopped) this.scheduleDeferredWake();
      });
    }
    return this.wakeDrain;
  }

  scheduleDeferredWake() {
    if (this.stopped || this.deferredWakeTimer) return;
    this.deferredWakeTimer = this.setTimeoutFn(() => {
      this.deferredWakeTimer = null;
      if (!this.stopped && this.wakeRequested) this.wake();
    }, this.deferredWakeDelayMs);
    this.deferredWakeTimer.unref?.();
  }

  scheduleReconciliation() {
    if (this.reconciliationTimer) this.clearTimeoutFn(this.reconciliationTimer);
    this.reconciliationTimer = null;
    this.nextReconciliationAt = null;
    if (this.stopped || !this.commandQueue || this.reconciliationIntervalMs <= 0) return;
    this.nextReconciliationAt = new Date(this.now() + this.reconciliationIntervalMs).toISOString();
    this.reconciliationTimer = this.setTimeoutFn(() => {
      this.reconciliationTimer = null;
      this.nextReconciliationAt = null;
      if (this.stopped) return;
      // Re-arm before inspecting PostgreSQL so this fallback remains independent
      // of both the wake subscription and a slow or failed reconciliation cycle.
      this.scheduleReconciliation();
      this.wake();
    }, this.reconciliationIntervalMs);
    this.reconciliationTimer.unref?.();
  }

  start() {
    if (this.started) return this.wakeDrain;
    this.started = true;
    this.stopped = false;
    this.scheduleReconciliation();
    const wake = this.wake();
    return Promise.all([wake, this.healthScheduler.start()]).then(() => undefined);
  }

  stop() {
    this.stopped = true;
    this.wakeRequested = false;
    if (this.deferredWakeTimer) this.clearTimeoutFn(this.deferredWakeTimer);
    this.deferredWakeTimer = null;
    if (this.scheduledWakeTimer) this.clearTimeoutFn(this.scheduledWakeTimer);
    this.scheduledWakeTimer = null;
    this.nextScheduledWakeAt = null;
    if (this.reconciliationTimer) this.clearTimeoutFn(this.reconciliationTimer);
    this.reconciliationTimer = null;
    this.nextReconciliationAt = null;
    return Promise.allSettled([this.wakeDrain, this.cycleRunning, this.healthScheduler.stop()].filter(Boolean));
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
      next_scheduled_wake_at: this.nextScheduledWakeAt,
      next_reconciliation_at: this.nextReconciliationAt,
      wake_pending: this.wakeRequested,
      control_plane_health: this.healthScheduler.status(),
    };
  }
}
