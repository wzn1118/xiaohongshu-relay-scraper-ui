export class CodexTurnRelayProbeError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'CodexTurnRelayProbeError';
    this.code = 'CODEX_TURN_RELAY_PROBE_FAILED';
    this.details = details;
  }
}

export async function probeCodexTurnRelay({
  iceServers,
  timeoutMs = 15_000,
  chromiumLauncher,
} = {}) {
  const normalizedIceServers = normalizeIceServers(iceServers);
  const normalizedTimeoutMs = normalizeTimeout(timeoutMs);
  const launcher = chromiumLauncher || (await import('@playwright/test')).chromium;
  let browser;
  try {
    browser = await launcher.launch({ headless: true });
    const page = await browser.newPage();
    const result = normalizeProbeResult(await page.evaluate(async ({ browserIceServers, browserTimeoutMs }) => {
      const startedAt = performance.now();
      const peer = new RTCPeerConnection({
        iceServers: browserIceServers,
        iceTransportPolicy: 'relay',
      });
      const candidateTypes = new Set();
      const protocols = new Set();
      const tcpTypes = new Set();
      const errorCodes = new Set();
      let candidateCount = 0;
      let gatheringCompleted = false;

      const completed = new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), browserTimeoutMs);
        peer.onicecandidate = ({ candidate }) => {
          if (!candidate) {
            gatheringCompleted = true;
            clearTimeout(timer);
            resolve('complete');
            return;
          }
          candidateCount += 1;
          const candidateText = String(candidate.candidate || '');
          const parsedType = String(candidate.type || /\btyp\s+(\w+)/iu.exec(candidateText)?.[1] || 'unknown').toLowerCase();
          const parsedProtocol = String(candidate.protocol || candidateText.split(/\s+/u)[2] || 'unknown').toLowerCase();
          const parsedTcpType = String(candidate.tcpType || /\btcptype\s+(\w+)/iu.exec(candidateText)?.[1] || '').toLowerCase();
          candidateTypes.add(parsedType);
          protocols.add(parsedProtocol);
          if (parsedTcpType) tcpTypes.add(parsedTcpType);
          if (parsedType === 'relay') {
            clearTimeout(timer);
            resolve('relay');
          }
        };
        peer.onicecandidateerror = (event) => {
          const code = Number(event.errorCode);
          if (Number.isInteger(code)) errorCodes.add(code);
        };
      });

      try {
        peer.createDataChannel('turn-relay-probe');
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        const completionReason = await completed;
        return {
          relayCandidateFound: candidateTypes.has('relay'),
          completionReason,
          candidateCount,
          candidateTypes: [...candidateTypes],
          protocols: [...protocols],
          tcpTypes: [...tcpTypes],
          errorCodes: [...errorCodes],
          gatheringCompleted,
          elapsedMs: Math.round(performance.now() - startedAt),
        };
      } finally {
        peer.close();
      }
    }, {
      browserIceServers: normalizedIceServers,
      browserTimeoutMs: normalizedTimeoutMs,
    }));
    if (!result.relayCandidateFound) {
      throw new CodexTurnRelayProbeError(
        `No TURN relay candidate was gathered within ${normalizedTimeoutMs} ms.`,
        result,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof CodexTurnRelayProbeError) throw error;
    throw new CodexTurnRelayProbeError(`TURN browser probe failed: ${error.message}`);
  } finally {
    await browser?.close().catch(() => {});
  }
}

function normalizeIceServers(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 9) {
    throw new CodexTurnRelayProbeError('TURN browser probe requires from one to nine ICE server entries.');
  }
  const normalized = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new CodexTurnRelayProbeError('TURN browser probe received an invalid ICE server entry.');
    }
    const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    if (!urls.length || urls.some((url) => !String(url || '').trim())) {
      throw new CodexTurnRelayProbeError('TURN browser probe received an ICE server without URLs.');
    }
    const normalizedEntry = { urls: urls.map((url) => String(url).trim()) };
    if (entry.username !== undefined) normalizedEntry.username = String(entry.username);
    if (entry.credential !== undefined) normalizedEntry.credential = String(entry.credential);
    return normalizedEntry;
  });
  const turnEntry = normalized.find((entry) => entry.urls.some((url) => /^turns?:/iu.test(url)));
  if (!turnEntry?.username || !turnEntry?.credential) {
    throw new CodexTurnRelayProbeError('TURN browser probe requires temporary TURN credentials.');
  }
  return normalized;
}

function normalizeTimeout(value) {
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 60_000) {
    throw new CodexTurnRelayProbeError('TURN browser probe timeout must be an integer from 1000 to 60000 milliseconds.');
  }
  return timeout;
}

function normalizeProbeResult(value) {
  const candidateTypes = normalizeStringList(value?.candidateTypes, ['host', 'srflx', 'prflx', 'relay', 'unknown']);
  return {
    relayCandidateFound: value?.relayCandidateFound === true && candidateTypes.includes('relay'),
    completionReason: ['relay', 'complete', 'timeout'].includes(value?.completionReason) ? value.completionReason : 'unknown',
    candidateCount: normalizeCount(value?.candidateCount),
    candidateTypes,
    protocols: normalizeStringList(value?.protocols, ['udp', 'tcp', 'unknown']),
    tcpTypes: normalizeStringList(value?.tcpTypes, ['active', 'passive', 'so', 'unknown']),
    errorCodes: Array.isArray(value?.errorCodes)
      ? [...new Set(value.errorCodes.map(Number).filter((code) => Number.isInteger(code) && code >= 0 && code <= 999))]
      : [],
    gatheringCompleted: value?.gatheringCompleted === true,
    elapsedMs: normalizeCount(value?.elapsedMs, 60_000),
  };
}

function normalizeStringList(value, allowed) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry || '').toLowerCase()).filter((entry) => allowed.includes(entry)))];
}

function normalizeCount(value, max = 1_000) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.min(max, Math.round(count)));
}
