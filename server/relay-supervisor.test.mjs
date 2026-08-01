import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelaySupervisor } from './lib/relay-supervisor.mjs';

const summary = {
  targetCount: 1,
  pageCount: 1,
  xiaohongshuPages: 1,
  unrelatedPages: 0,
  iframeCount: 0,
  workerCount: 0,
  securityPages: 0,
  pressure: 'normal',
  pressureReasons: [],
  recoveryRecommended: false,
};

function successfulRecovery(overrides = {}) {
  return {
    ok: true,
    ready: true,
    running: true,
    cdpReady: true,
    repaired: true,
    playwrightVerified: true,
    warnings: [],
    before: summary,
    after: summary,
    message: 'Relay recovered.',
    ...overrides,
  };
}

function createFixture(overrides = {}) {
  return createRelaySupervisor({
    getConfig: () => ({ port: 18800, profile: 'openclaw', autoConnect: true }),
    relayConnector: async ({ port, profile }) => ({ ok: true, ready: true, running: true, cdpReady: true, port, profile }),
    relayRecoverer: async () => successfulRecovery(),
    relayProber: async () => ({ ok: true, running: true, cdpReady: true, xiaohongshuTabs: 1, checkedAt: new Date().toISOString() }),
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  });
}

test('joins concurrent recovery requests instead of rebuilding the browser twice', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let recoveryCalls = 0;
  const supervisor = createFixture({
    relayRecoverer: async () => {
      recoveryCalls += 1;
      await gate;
      return successfulRecovery();
    },
  });

  const first = supervisor.recover({ port: 18800, profile: 'openclaw' });
  const second = supervisor.recover({ port: 18800, profile: 'openclaw' });
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(recoveryCalls, 1);
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.joinedRecovery, false);
  assert.equal(secondResult.joinedRecovery, true);
  assert.equal(supervisor.snapshot().inProgress, false);
  assert.equal(supervisor.snapshot().phase, 'idle');
});

test('uses one bounded hard restart when Playwright verification initially fails', async () => {
  const forceRestarts = [];
  let recoveries = 0;
  const supervisor = createFixture({
    relayConnector: async ({ port, profile, forceRestart }) => {
      forceRestarts.push(Boolean(forceRestart));
      return { ok: true, ready: true, running: true, cdpReady: true, port, profile };
    },
    relayRecoverer: async () => {
      recoveries += 1;
      return recoveries === 1
        ? { ok: false, ready: false, warnings: [], message: 'Playwright verification failed.' }
        : successfulRecovery();
    },
  });

  const result = await supervisor.recover({ port: 18800, profile: 'openclaw' });

  assert.equal(result.ok, true);
  assert.equal(result.playwrightVerified, true);
  assert.equal(result.hardRestarted, true);
  assert.equal(result.recoveryAttempts, 2);
  assert.deepEqual(forceRestarts, [false, true]);
});

test('watchdog recovers after consecutive offline probes and respects the cooldown', async () => {
  let probeCalls = 0;
  let recoveryCalls = 0;
  let now = Date.parse('2026-07-31T00:00:00.000Z');
  const supervisor = createFixture({
    failureThreshold: 2,
    recoveryCooldownMs: 5_000,
    now: () => now,
    relayProber: async () => {
      probeCalls += 1;
      return { ok: false, running: false, cdpReady: false, xiaohongshuTabs: 0, message: 'offline' };
    },
    relayRecoverer: async () => {
      recoveryCalls += 1;
      return successfulRecovery();
    },
  });

  const first = await supervisor.checkNow();
  const second = await supervisor.checkNow();
  const coolingDown = await supervisor.checkNow();
  now += 5_001;
  const afterCooldown = await supervisor.checkNow();

  assert.equal(first.recovered, false);
  assert.equal(second.recovered, true);
  assert.equal(coolingDown.recovered, false);
  assert.equal(afterCooldown.recovered, true);
  assert.equal(probeCalls, 4);
  assert.equal(recoveryCalls, 2);
});

test('watchdog does not restart a live task for a transient missing target tab', async () => {
  let recoveryCalls = 0;
  const supervisor = createFixture({
    getActiveJob: () => ({ id: 'active-job' }),
    failureThreshold: 1,
    relayProber: async () => ({ ok: true, running: true, cdpReady: true, xiaohongshuTabs: 0 }),
    relayRecoverer: async () => {
      recoveryCalls += 1;
      return successfulRecovery();
    },
  });

  const result = await supervisor.checkNow();

  assert.equal(result.recovered, false);
  assert.equal(recoveryCalls, 0);
});

test('monitor checks are single-flight and convert thrown probes into diagnostics', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let probes = 0;
  const supervisor = createFixture({
    relayProber: async () => {
      probes += 1;
      await gate;
      throw new Error('probe exploded');
    },
  });

  const first = supervisor.runMonitorCheck();
  const second = supervisor.runMonitorCheck();
  assert.equal(first, second);
  release();
  const result = await first;

  assert.equal(probes, 1);
  assert.equal(result.checked, false);
  assert.match(result.message, /probe exploded/);
  assert.match(supervisor.snapshot().lastError, /probe exploded/);
});
