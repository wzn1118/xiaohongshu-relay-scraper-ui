import { connectRelay } from './relay-connect.mjs';
import { recoverRelay } from './relay-recovery.mjs';
import { probeRelay } from './relay.mjs';

const DEFAULT_SUMMARY = Object.freeze({
  targetCount: 0,
  pageCount: 0,
  xiaohongshuPages: 0,
  unrelatedPages: 0,
  iframeCount: 0,
  workerCount: 0,
  securityPages: 0,
  pressure: 'normal',
  pressureReasons: [],
  recoveryRecommended: false,
});

export function createRelaySupervisor(options) {
  return new RelaySupervisor(options);
}

export class RelaySupervisor {
  constructor({
    getConfig,
    getActiveJob = () => null,
    openClawConfigPath,
    managedBrowserDataDir,
    pythonBin,
    connectionCheckScriptPath,
    relayConnector = connectRelay,
    relayRecoverer = recoverRelay,
    relayProber = probeRelay,
    monitorIntervalMs = 15_000,
    failureThreshold = 2,
    recoveryCooldownMs = 60_000,
    connectTimeoutMs = 25_000,
    playwrightTimeoutMs = 60_000,
    now = () => Date.now(),
    logger = console,
  }) {
    this.getConfig = getConfig;
    this.getActiveJob = getActiveJob;
    this.openClawConfigPath = openClawConfigPath;
    this.managedBrowserDataDir = managedBrowserDataDir;
    this.pythonBin = pythonBin;
    this.connectionCheckScriptPath = connectionCheckScriptPath;
    this.relayConnector = relayConnector;
    this.relayRecoverer = relayRecoverer;
    this.relayProber = relayProber;
    this.monitorIntervalMs = Math.max(2_000, Number(monitorIntervalMs) || 15_000);
    this.failureThreshold = Math.max(1, Number(failureThreshold) || 2);
    this.recoveryCooldownMs = Math.max(5_000, Number(recoveryCooldownMs) || 60_000);
    this.connectTimeoutMs = Math.max(1_000, Number(connectTimeoutMs) || 25_000);
    this.playwrightTimeoutMs = Math.max(1_000, Number(playwrightTimeoutMs) || 60_000);
    this.now = now;
    this.logger = logger;
    this.recoveryFlight = null;
    this.monitorFlight = null;
    this.monitorTimer = null;
    this.startTimer = null;
    this.state = {
      phase: 'idle',
      inProgress: false,
      automaticEnabled: false,
      consecutiveProbeFailures: 0,
      consecutiveDegradedChecks: 0,
      lastProbeAt: null,
      lastRecoveryAt: null,
      lastSuccessAt: null,
      lastError: null,
      reason: null,
      nextAutomaticAttemptAt: null,
    };
  }

  snapshot() {
    let automaticEnabled = this.state.automaticEnabled;
    try {
      automaticEnabled = Boolean(this.getConfig?.()?.autoConnect);
    } catch {}
    return { ...this.state, automaticEnabled };
  }

  async probe({ port }) {
    const status = await this.relayProber({ port, openClawConfigPath: this.openClawConfigPath });
    this.recordProbe(status);
    return { ...status, supervisor: this.snapshot() };
  }

  async connect({ port, profile, forceRestart = false }) {
    if (this.recoveryFlight) {
      const recovered = await this.recoveryFlight;
      return { ...recovered, joinedRecovery: true, supervisor: this.snapshot() };
    }
    this.state.phase = forceRestart ? 'restarting' : 'connecting';
    let status;
    try {
      status = await this.relayConnector(this.connectionOptions({ port, profile, forceRestart }));
      if (status?.running && status?.cdpReady) this.state.lastError = null;
      else this.state.lastError = status?.message || 'Relay connection is not ready.';
    } finally {
      if (!this.recoveryFlight) this.state.phase = 'idle';
    }
    return { ...status, supervisor: this.snapshot() };
  }

  async recover({ port, profile, reason = 'manual' }) {
    if (this.recoveryFlight) {
      const result = await this.recoveryFlight;
      return { ...result, joinedRecovery: true, supervisor: this.snapshot() };
    }

    this.state.inProgress = true;
    this.state.phase = 'connecting';
    this.state.reason = reason;
    this.state.lastRecoveryAt = new Date(this.now()).toISOString();
    const flight = this.performRecovery({ port, profile, reason })
      .then((result) => {
        if (result.ok) {
          this.state.lastSuccessAt = new Date(this.now()).toISOString();
          this.state.lastError = null;
          this.state.consecutiveProbeFailures = 0;
          this.state.consecutiveDegradedChecks = 0;
        } else {
          this.state.lastError = result.message || 'Relay recovery failed.';
        }
        return result;
      })
      .catch((error) => {
        const message = publicError(error);
        this.state.lastError = message;
        return failureResult({ port, profile, message });
      })
      .finally(() => {
        this.state.inProgress = false;
        this.state.phase = 'idle';
        this.state.reason = null;
        this.state.nextAutomaticAttemptAt = new Date(this.now() + this.recoveryCooldownMs).toISOString();
        if (this.recoveryFlight === flight) this.recoveryFlight = null;
      });
    this.recoveryFlight = flight;
    const result = await flight;
    return { ...result, joinedRecovery: false, supervisor: this.snapshot() };
  }

  async performRecovery({ port, profile }) {
    const connection = await safeCall(
      () => this.relayConnector(this.connectionOptions({ port, profile })),
      'Relay connection failed.',
    );
    if (!connection.running || !connection.cdpReady) {
      return failureResult({
        ...connection,
        port,
        profile,
        message: connection.message || 'Relay service could not be started.',
      });
    }

    this.state.phase = 'verifying';
    const recoveryOptions = this.recoveryOptions({ port, profile });
    const firstRecovery = await safeCall(
      () => this.relayRecoverer(recoveryOptions),
      'Relay Playwright verification failed.',
    );
    if (firstRecovery.ok) {
      return { ...firstRecovery, hardRestarted: false, recoveryAttempts: 1 };
    }

    this.state.phase = 'restarting';
    const restarted = await safeCall(
      () => this.relayConnector(this.connectionOptions({ port, profile, forceRestart: true })),
      'Managed browser rebuild failed.',
    );
    if (!restarted.running || !restarted.cdpReady) {
      return failureResult({
        ...restarted,
        port,
        profile,
        hardRestarted: false,
        recoveryAttempts: 2,
        message: restarted.message || firstRecovery.message || 'Managed browser rebuild failed.',
      });
    }

    this.state.phase = 'verifying';
    const recovery = await safeCall(
      () => this.relayRecoverer(recoveryOptions),
      'Relay verification after browser rebuild failed.',
    );
    return {
      ...failureResult({ port, profile }),
      ...recovery,
      hardRestarted: true,
      recoveryAttempts: 2,
      sessionPreserved: true,
      warnings: [
        ...(Array.isArray(recovery.warnings) ? recovery.warnings : []),
        `Initial recovery failed and triggered a managed browser rebuild: ${firstRecovery.message || 'verification failed'}`,
      ],
    };
  }

  async checkNow() {
    let configured;
    try {
      configured = this.getConfig?.();
    } catch (error) {
      this.state.lastError = publicError(error);
      return { checked: false, recovered: false, message: this.state.lastError };
    }
    const port = Number(configured?.port);
    const profile = String(configured?.profile || 'openclaw');
    this.state.automaticEnabled = Boolean(configured?.autoConnect);
    if (!this.state.automaticEnabled || !Number.isInteger(port)) {
      return { checked: false, recovered: false, reason: 'disabled' };
    }

    const status = await this.relayProber({ port, openClawConfigPath: this.openClawConfigPath });
    this.recordProbe(status);
    const offline = !status?.running || !status?.cdpReady;
    const degraded = offline || Number(status?.xiaohongshuTabs || 0) < 1;
    const pressured = Boolean(status?.recoveryRecommended);
    this.state.consecutiveProbeFailures = offline ? this.state.consecutiveProbeFailures + 1 : 0;
    this.state.consecutiveDegradedChecks = degraded ? this.state.consecutiveDegradedChecks + 1 : 0;

    const idle = !this.getActiveJob?.();
    const thresholdReached = this.state.consecutiveDegradedChecks >= this.failureThreshold;
    const pressureRecovery = pressured && idle;
    const degradationRecovery = thresholdReached && (offline || idle);
    const lastAttempt = Date.parse(this.state.lastRecoveryAt || '') || 0;
    const coolingDown = this.now() - lastAttempt < this.recoveryCooldownMs;
    if ((!degradationRecovery && !pressureRecovery) || coolingDown || this.recoveryFlight) {
      return { checked: true, recovered: false, status, supervisor: this.snapshot() };
    }

    const reason = offline ? 'watchdog_offline' : pressured ? 'watchdog_pressure' : 'watchdog_missing_target';
    this.logger?.warn?.(`[relay-supervisor] ${reason}; starting automatic recovery on port ${port}.`);
    const recovery = await this.recover({ port, profile, reason });
    this.logger?.[recovery.ok ? 'info' : 'error']?.(
      `[relay-supervisor] automatic recovery ${recovery.ok ? 'completed' : 'failed'}: ${recovery.message || 'no message'}`,
    );
    return { checked: true, recovered: recovery.ok, status, recovery, supervisor: this.snapshot() };
  }

  start() {
    if (this.monitorTimer || this.startTimer) return;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.runMonitorCheck();
    }, 1_000);
    this.startTimer.unref?.();
    this.monitorTimer = setInterval(() => void this.runMonitorCheck(), this.monitorIntervalMs);
    this.monitorTimer.unref?.();
  }

  runMonitorCheck() {
    if (this.monitorFlight) return this.monitorFlight;
    const flight = this.checkNow()
      .catch((error) => {
        this.state.lastError = publicError(error);
        this.logger?.error?.(`[relay-supervisor] monitor check failed: ${this.state.lastError}`);
        return { checked: false, recovered: false, message: this.state.lastError };
      })
      .finally(() => {
        if (this.monitorFlight === flight) this.monitorFlight = null;
      });
    this.monitorFlight = flight;
    return flight;
  }

  stop() {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.startTimer = null;
    this.monitorTimer = null;
  }

  recordProbe(status) {
    this.state.lastProbeAt = status?.checkedAt || new Date(this.now()).toISOString();
    if (status?.running && status?.cdpReady) this.state.lastError = null;
    else if (status?.message) this.state.lastError = status.message;
  }

  connectionOptions({ port, profile, forceRestart = false }) {
    return {
      port,
      profile,
      forceRestart,
      timeoutMs: this.connectTimeoutMs,
      openClawConfigPath: this.openClawConfigPath,
      managedBrowserDataDir: this.managedBrowserDataDir,
    };
  }

  recoveryOptions({ port, profile }) {
    return {
      port,
      profile,
      openClawConfigPath: this.openClawConfigPath,
      pythonBin: this.pythonBin,
      connectionCheckScriptPath: this.connectionCheckScriptPath,
      connectTimeoutMs: this.playwrightTimeoutMs,
    };
  }
}

async function safeCall(callback, fallbackMessage) {
  try {
    return await callback();
  } catch (error) {
    return { ok: false, ready: false, running: false, cdpReady: false, warnings: [], message: publicError(error) || fallbackMessage };
  }
}

function failureResult({
  port,
  profile,
  message = 'Relay recovery failed.',
  warnings = [],
  before = DEFAULT_SUMMARY,
  after = DEFAULT_SUMMARY,
  ...rest
}) {
  return {
    ...rest,
    ok: false,
    ready: false,
    running: false,
    cdpReady: false,
    repaired: false,
    port,
    profile,
    before,
    after,
    closedTargets: 0,
    createdFreshTarget: false,
    sessionPreserved: true,
    playwrightVerified: false,
    warnings,
    message,
  };
}

function publicError(error) {
  return String(error?.message || error || 'Unknown Relay error.').replace(/[A-Fa-f0-9]{32,}/g, '[redacted]');
}
