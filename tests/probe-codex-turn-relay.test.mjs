import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexTurnRelayProbeError, probeCodexTurnRelay } from '../scripts/probe-codex-turn-relay.mjs';

const ICE_SERVERS = [{
  urls: ['turn:turn.example.test:3478?transport=udp'],
  username: 'temporary-user',
  credential: 'temporary-credential',
}];

test('accepts a browser relay candidate and returns only bounded transport metadata', async () => {
  const fake = createChromiumLauncher({
    relayCandidateFound: true,
    completionReason: 'relay',
    candidateCount: 1,
    candidateTypes: ['relay'],
    protocols: ['udp'],
    tcpTypes: [],
    errorCodes: [],
    gatheringCompleted: false,
    elapsedMs: 87,
    address: '203.0.113.10',
    credential: 'must-not-escape',
  });
  const report = await probeCodexTurnRelay({
    iceServers: ICE_SERVERS,
    timeoutMs: 5_000,
    chromiumLauncher: fake.launcher,
  });
  assert.deepEqual(report, {
    relayCandidateFound: true,
    completionReason: 'relay',
    candidateCount: 1,
    candidateTypes: ['relay'],
    protocols: ['udp'],
    tcpTypes: [],
    errorCodes: [],
    gatheringCompleted: false,
    elapsedMs: 87,
  });
  assert.equal(JSON.stringify(report).includes('203.0.113.10'), false);
  assert.equal(JSON.stringify(report).includes('must-not-escape'), false);
  assert.equal(fake.state.closed, true);
  assert.deepEqual(fake.state.launchOptions, { headless: true });
});

test('fails with sanitized diagnostics when a browser cannot gather a relay candidate', async () => {
  const fake = createChromiumLauncher({
    relayCandidateFound: false,
    completionReason: 'timeout',
    candidateCount: 0,
    candidateTypes: [],
    protocols: [],
    tcpTypes: [],
    errorCodes: [701, 701, 9999],
    gatheringCompleted: false,
    elapsedMs: 5_000,
    url: 'turn:private.example.test',
  });
  await assert.rejects(() => probeCodexTurnRelay({
    iceServers: ICE_SERVERS,
    timeoutMs: 5_000,
    chromiumLauncher: fake.launcher,
  }), (error) => {
    assert.equal(error instanceof CodexTurnRelayProbeError, true);
    assert.equal(error.code, 'CODEX_TURN_RELAY_PROBE_FAILED');
    assert.deepEqual(error.details.errorCodes, [701]);
    assert.equal(JSON.stringify(error.details).includes('private.example.test'), false);
    return true;
  });
  assert.equal(fake.state.closed, true);
});

test('rejects missing temporary credentials and out-of-range timeouts before launching a browser', async () => {
  await assert.rejects(() => probeCodexTurnRelay({
    iceServers: [{ urls: 'turn:turn.example.test:3478' }],
  }), /temporary TURN credentials/);
  await assert.rejects(() => probeCodexTurnRelay({
    iceServers: ICE_SERVERS,
    timeoutMs: 999,
  }), /1000 to 60000/);
});

function createChromiumLauncher(result) {
  const state = { closed: false, launchOptions: null };
  return {
    state,
    launcher: {
      async launch(options) {
        state.launchOptions = options;
        return {
          async newPage() {
            return {
              async evaluate(_callback, input) {
                assert.equal(input.browserTimeoutMs >= 1_000, true);
                assert.equal(input.browserIceServers[0].username, 'temporary-user');
                return result;
              },
            };
          },
          async close() {
            state.closed = true;
          },
        };
      },
    },
  };
}
