const params = new URLSearchParams(location.hash.slice(1));
const sessionId = params.get('sessionId') || '';
const role = params.get('role') || '';
const token = params.get('token') || '';
const remoteSource = params.get('remote') === '1';
const autoStart = params.get('autostart') === '1';
const forceRelay = params.get('forceRelay') === '1';
const sameHost = params.get('sameHost') === '1';
const fallbackTargetTitle = String(params.get('targetTitle') || 'ChatGPT').trim().slice(0, 300);
const video = document.querySelector('#mirror-video');
const relayCanvas = document.querySelector('#mirror-relay-canvas');
const emptyTitle = document.querySelector('#empty-title');
const emptyDetail = document.querySelector('#empty-detail');
const stateLabel = document.querySelector('#state-label');
const roleLabel = document.querySelector('#role-label');
const launchCodexButton = document.querySelector('#launch-codex');
const selectWindowButton = document.querySelector('#select-window');
const toggleControlButton = document.querySelector('#toggle-control');
const fullscreenButton = document.querySelector('#fullscreen');
const stopButton = document.querySelector('#stop');
const pathMetric = document.querySelector('#path-metric');
const rttMetric = document.querySelector('#rtt-metric');
const inputMetric = document.querySelector('#input-metric');
const fpsMetric = document.querySelector('#fps-metric');

let peer = null;
let stream = null;
let controlChannel = null;
let pointerChannel = null;
let inputSocket = null;
let inputReconnectTimer = 0;
let localViewerSession = false;
let directLocalInput = false;
let relaySocket = null;
let relayReconnectTimer = 0;
let relayFallbackTimer = 0;
let relayPingTimer = 0;
let relayActive = false;
let relayPeerConnected = false;
let relayActivationSent = false;
let relayEncoderState = null;
let relayJpegCanvas = null;
let relayDecoder = null;
let relayDecoderConfigured = false;
let relayFrameSequence = 0;
let relayForceKeyFrame = true;
let relayPingSequence = 0;
const relayFrameTimes = [];
let controlEnabled = false;
let cursor = 0;
let polling = true;
let rtcConfiguration = { iceServers: [] };
let inputQueue = Promise.resolve();
let moveRequestInFlight = false;
let latestMoveRequest = null;
let pendingInputMove = null;
let inputMoveTimer = 0;
let moveFrame = 0;
let pendingMove = null;
let controlSequence = 0;
let pointerSequence = 0;
let lastReceivedPointerSequence = 0;
const pressedButtons = new Set();
const pressedKeys = new Map();
let lastPointerPoint = { x: 0.5, y: 0.5 };
const pendingCandidates = [];
let lastTransportReport = '';
let lastConnectionError = '';
let peerTelemetryTimer = 0;
let appliedQualityProfile = '';
const pendingInputRequests = new Map();
const inputLatencySamples = [];
const sourceRoundTripSamples = [];
const relayBridgeSamples = [];
const dataChannelSamples = [];
const mirrorMetrics = {
  connectionPath: 'unknown',
  rttMs: null,
  inputP50Ms: null,
  inputP95Ms: null,
  inputSamples: 0,
  sourceP50Ms: null,
  sourceP95Ms: null,
  relayBridgeP50Ms: null,
  relayBridgeP95Ms: null,
  dataChannelP50Ms: null,
  dataChannelP95Ms: null,
  fps: null,
  qualityProfile: 'initial',
};
window.__codexMirrorMetrics = mirrorMetrics;
document.body.dataset.transport = 'webrtc';

const headers = () => ({
  'Content-Type': 'application/json',
  'X-Codex-Mirror-Role': role,
  'X-Codex-Mirror-Token': token,
});

function monotonicEpochNow() {
  return performance.timeOrigin + performance.now();
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return Math.round(sorted[index] * 10) / 10;
}

function updateMetrics(next = {}) {
  Object.assign(mirrorMetrics, next);
  if (pathMetric) pathMetric.textContent = mirrorMetrics.connectionPath === 'unknown' ? 'Path --' : `Path ${mirrorMetrics.connectionPath}`;
  if (rttMetric) rttMetric.textContent = Number.isFinite(mirrorMetrics.rttMs) ? `RTT ${Math.round(mirrorMetrics.rttMs)} ms` : 'RTT --';
  if (inputMetric) {
    inputMetric.textContent = Number.isFinite(mirrorMetrics.inputP50Ms)
      ? `Input ${Math.round(mirrorMetrics.inputP50Ms)}/${Math.round(mirrorMetrics.inputP95Ms)} ms`
      : 'Input --';
    inputMetric.title = Number.isFinite(mirrorMetrics.sourceP95Ms)
      ? `Source ${Math.round(mirrorMetrics.sourceP50Ms)}/${Math.round(mirrorMetrics.sourceP95Ms)} ms; bridge ${Math.round(mirrorMetrics.relayBridgeP50Ms)}/${Math.round(mirrorMetrics.relayBridgeP95Ms)} ms`
      : 'End-to-end input P50/P95';
  }
  if (fpsMetric) fpsMetric.textContent = Number.isFinite(mirrorMetrics.fps) ? `FPS ${Math.round(mirrorMetrics.fps)}` : 'FPS --';
  document.body.dataset.connectionPath = mirrorMetrics.connectionPath;
  document.body.dataset.inputSamples = String(mirrorMetrics.inputSamples || 0);
  document.body.dataset.inputP50 = Number.isFinite(mirrorMetrics.inputP50Ms) ? String(mirrorMetrics.inputP50Ms) : '';
  document.body.dataset.inputP95 = Number.isFinite(mirrorMetrics.inputP95Ms) ? String(mirrorMetrics.inputP95Ms) : '';
  document.body.dataset.transportRtt = Number.isFinite(mirrorMetrics.rttMs) ? String(mirrorMetrics.rttMs) : '';
  document.body.dataset.videoFps = Number.isFinite(mirrorMetrics.fps) ? String(mirrorMetrics.fps) : '';
}

function rememberInputRequest(requestId) {
  if (!requestId) return;
  pendingInputRequests.set(requestId, performance.now());
  while (pendingInputRequests.size > 256) pendingInputRequests.delete(pendingInputRequests.keys().next().value);
}

function recordInputResult(requestId, packet = {}) {
  const startedAt = pendingInputRequests.get(requestId);
  pendingInputRequests.delete(requestId);
  if (!Number.isFinite(startedAt)) return;
  const latencyMs = Math.max(0, performance.now() - startedAt);
  inputLatencySamples.push(latencyMs);
  if (inputLatencySamples.length > 200) inputLatencySamples.splice(0, inputLatencySamples.length - 200);
  const telemetry = packet.telemetry && typeof packet.telemetry === 'object' ? packet.telemetry : {};
  const sourceRoundTripMs = Number(telemetry.sourceRespondedAt) - Number(telemetry.sourceReceivedAt);
  const relayBridgeMs = Number(telemetry.bridgeDeliveredAt) - Number(telemetry.relayAcceptedAt);
  if (Number.isFinite(sourceRoundTripMs) && sourceRoundTripMs >= 0) sourceRoundTripSamples.push(sourceRoundTripMs);
  if (Number.isFinite(relayBridgeMs) && relayBridgeMs >= 0) relayBridgeSamples.push(relayBridgeMs);
  const dataChannelMs = latencyMs - sourceRoundTripMs;
  if (Number.isFinite(dataChannelMs) && dataChannelMs >= 0) dataChannelSamples.push(dataChannelMs);
  for (const samples of [sourceRoundTripSamples, relayBridgeSamples, dataChannelSamples]) {
    if (samples.length > 200) samples.splice(0, samples.length - 200);
  }
  updateMetrics({
    inputP50Ms: percentile(inputLatencySamples, 0.5),
    inputP95Ms: percentile(inputLatencySamples, 0.95),
    inputSamples: inputLatencySamples.length,
    sourceP50Ms: percentile(sourceRoundTripSamples, 0.5),
    sourceP95Ms: percentile(sourceRoundTripSamples, 0.95),
    relayBridgeP50Ms: percentile(relayBridgeSamples, 0.5),
    relayBridgeP95Ms: percentile(relayBridgeSamples, 0.95),
    dataChannelP50Ms: percentile(dataChannelSamples, 0.5),
    dataChannelP95Ms: percentile(dataChannelSamples, 0.95),
    lastInputTelemetry: telemetry,
  });
}

function setState(state, label) {
  document.body.dataset.state = state;
  stateLabel.textContent = label;
}

function setPlaying(value) {
  document.body.dataset.playing = value ? 'true' : 'false';
}

function setControl(value) {
  if (!value) releaseViewerInputs();
  controlEnabled = Boolean(value);
  document.body.dataset.control = controlEnabled ? 'enabled' : 'disabled';
  toggleControlButton.textContent = controlEnabled ? 'Release control' : 'Enable control';
  toggleControlButton.setAttribute('aria-pressed', String(controlEnabled));
}

function sendControlResult(requestId, result = {}) {
  if (!requestId) return;
  const packet = {
    type: 'mirror.input-result',
    requestId,
    ok: result.ok === true,
    delivered: result.delivered === true,
    targetFound: result.targetFound !== false,
    message: String(result.message || ''),
    acceptedAt: Number(result.acceptedAt || 0) || null,
    deliveredAt: Number(result.deliveredAt || 0) || null,
    telemetry: result.telemetry && typeof result.telemetry === 'object'
      ? { ...result.telemetry, sourceRespondedAt: monotonicEpochNow() }
      : { sourceRespondedAt: monotonicEpochNow() },
  };
  if (relayActive) {
    sendRelayJson(packet);
    return;
  }
  if (controlChannel?.readyState === 'open') controlChannel.send(JSON.stringify(packet));
}

function inputChannelUrl() {
  let origin = location.origin;
  let inputSessionId = sessionId;
  let inputRole = role;
  let inputToken = token;
  if (role === 'source') {
    try {
      const localOrigin = new URL(String(params.get('localInputOrigin') || ''));
      const localSessionId = String(params.get('localInputSessionId') || '');
      const localRole = String(params.get('localInputRole') || '');
      const localToken = String(params.get('localInputToken') || '');
      const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(localOrigin.hostname.toLowerCase());
      if (
        loopback
        && ['http:', 'https:'].includes(localOrigin.protocol)
        && /^mirror-[A-Za-z0-9-]{8,140}$/.test(localSessionId)
        && localRole === 'source'
        && localToken.length >= 16
      ) {
        origin = localOrigin.origin;
        inputSessionId = localSessionId;
        inputRole = localRole;
        inputToken = localToken;
      }
    } catch {
      // Public authenticated input remains the compatibility fallback.
    }
  }
  const base = new URL(origin);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = '/v1/native-mirror/input';
  base.search = '';
  base.hash = '';
  const url = base;
  url.searchParams.set('sessionId', inputSessionId);
  url.searchParams.set('role', inputRole);
  url.searchParams.set('token', inputToken);
  return url.toString();
}

function relayChannelUrl() {
  const url = new URL(location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/v1/native-mirror/relay';
  url.search = '';
  url.hash = '';
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('role', role);
  url.searchParams.set('token', token);
  return url.toString();
}

function sendRelayJson(packet) {
  if (!relaySocket || relaySocket.readyState !== WebSocket.OPEN || relaySocket.bufferedAmount > 8 * 1024 * 1024) return false;
  relaySocket.send(JSON.stringify(packet));
  return true;
}

function reportRelayConnected() {
  if (!relayActive || !relayPeerConnected) return;
  updateMetrics({ connectionPath: 'wss-relay', qualityProfile: 'relay-realtime' });
  setState('connected', role === 'source' ? 'Connected - WSS relay source active' : 'Connected - WSS relay control ready');
  void Promise.all([
    postSignal('ready', { role, phase: 'peer' }),
    postSignal('ready', { role, phase: 'control' }),
    postSignal('ready', {
      role,
      phase: 'transport',
      localCandidateType: 'relay',
      remoteCandidateType: 'relay',
      protocol: 'wss',
      relayUsed: true,
      rttMs: Number.isFinite(mirrorMetrics.rttMs) ? Math.round(mirrorMetrics.rttMs) : null,
    }),
  ]).catch(showError);
}

function startRelayPings() {
  if (relayPingTimer) window.clearInterval(relayPingTimer);
  if (role !== 'viewer') return;
  const ping = () => {
    if (!relayActive || !relayPeerConnected) return;
    sendRelayJson({ type: 'mirror.ping', id: ++relayPingSequence, sentAt: monotonicEpochNow() });
  };
  ping();
  relayPingTimer = window.setInterval(ping, 1_000);
}

async function activateRelay(reason = 'fallback', { notify = true } = {}) {
  const firstActivation = !relayActive;
  relayActive = true;
  document.body.dataset.transport = 'wss-relay';
  stopPeerTelemetry();
  controlChannel?.close();
  pointerChannel?.close();
  controlChannel = null;
  pointerChannel = null;
  peer?.close();
  peer = null;
  if (role === 'viewer') {
    video.srcObject = null;
    setPlaying(relayFrameTimes.length > 0);
  }
  if (notify && (!relayActivationSent || firstActivation)) {
    relayActivationSent = sendRelayJson({ type: 'mirror.activate', reason });
  }
  if (role === 'source') {
    relayForceKeyFrame = true;
    void startRelayEncoder().catch(showError);
  }
  startRelayPings();
  reportRelayConnected();
  if (!relayPeerConnected) setState('connecting', 'WSS relay waiting for peer');
}

function stopRelayEncoder() {
  const state = relayEncoderState;
  relayEncoderState = null;
  if (!state) return;
  state.closed = true;
  void state.reader.cancel().catch(() => {});
  try { state.encoder.close(); } catch { /* Encoder may already be closed by the browser. */ }
  state.timer && window.clearTimeout(state.timer);
}

async function startRelayEncoder() {
  if (role !== 'source' || !relayActive || !stream || relayEncoderState) return;
  const [track] = stream.getVideoTracks();
  if (!track) return;
  const settings = track.getSettings?.() || {};
  const width = Math.max(16, Math.round(Number(settings.width || video.videoWidth || 1280)));
  const height = Math.max(16, Math.round(Number(settings.height || video.videoHeight || 720)));
  const requestedConfig = {
    codec: 'vp8',
    width,
    height,
    bitrate: width * height > 2_500_000 ? 7_000_000 : 4_500_000,
    framerate: 30,
    latencyMode: 'realtime',
    hardwareAcceleration: 'prefer-hardware',
  };
  if (!window.MediaStreamTrackProcessor || !window.VideoEncoder || !window.EncodedVideoChunk) {
    startJpegRelayEncoder(width, height);
    return;
  }
  const supported = await VideoEncoder.isConfigSupported(requestedConfig);
  if (!supported.supported) throw new Error('VP8 WebCodecs relay encoding is unavailable.');
  const config = supported.config || requestedConfig;
  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();
  const encoder = new VideoEncoder({
    output: (chunk) => sendRelayVideoChunk(chunk),
    error: (error) => {
      if (relayActive) showError(error);
    },
  });
  encoder.configure(config);
  const state = { reader, encoder, closed: false, lastFrameAt: 0 };
  relayEncoderState = state;
  sendRelayJson({
    type: 'mirror.media-config',
    codec: String(config.codec || 'vp8').toLowerCase(),
    codedWidth: width,
    codedHeight: height,
    displayAspectWidth: width,
    displayAspectHeight: height,
  });
  sendRelayJson({ type: 'mirror.media-state', state: 'streaming' });
  while (!state.closed && relayActive && stream?.active) {
    const { value: frame, done } = await reader.read();
    if (done || !frame) break;
    const now = performance.now();
    if (now - state.lastFrameAt < 30 || encoder.encodeQueueSize > 2 || relaySocket?.bufferedAmount > 2 * 1024 * 1024) {
      frame.close();
      continue;
    }
    state.lastFrameAt = now;
    relayFrameSequence += 1;
    const keyFrame = relayForceKeyFrame || relayFrameSequence % 60 === 1;
    relayForceKeyFrame = false;
    try { encoder.encode(frame, { keyFrame }); } finally { frame.close(); }
  }
  if (relayEncoderState === state) relayEncoderState = null;
}

function startJpegRelayEncoder(width, height) {
  if (relayEncoderState || !relayActive || role !== 'source') return;
  relayJpegCanvas ||= document.createElement('canvas');
  relayJpegCanvas.width = width;
  relayJpegCanvas.height = height;
  const context = relayJpegCanvas.getContext('2d', { alpha: false, desynchronized: true });
  const state = { closed: false, timer: 0, encoder: { close() {} }, reader: { cancel: async () => {} } };
  relayEncoderState = state;
  sendRelayJson({ type: 'mirror.media-config', codec: 'image/jpeg', codedWidth: width, codedHeight: height, displayAspectWidth: width, displayAspectHeight: height });
  sendRelayJson({ type: 'mirror.media-state', state: 'streaming-jpeg' });
  const tick = () => {
    if (state.closed || !relayActive || !stream?.active) return;
    context.drawImage(video, 0, 0, width, height);
    try {
      const dataUrl = relayJpegCanvas.toDataURL('image/jpeg', 0.72);
      const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const binary = atob(encoded);
      const payload = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) payload[index] = binary.charCodeAt(index);
      if (!state.closed && relaySocket?.readyState === WebSocket.OPEN && relaySocket.bufferedAmount <= 2 * 1024 * 1024) {
        const buffer = new ArrayBuffer(14 + payload.byteLength);
        const view = new DataView(buffer);
        view.setUint8(0, 2);
        view.setUint8(1, 1);
        view.setUint32(2, ++relayFrameSequence, true);
        view.setFloat64(6, monotonicEpochNow(), true);
        new Uint8Array(buffer, 14).set(payload);
        relaySocket.send(buffer);
      }
    } catch (error) {
      if (!state.closed) showError(error);
    }
    state.timer = window.setTimeout(tick, 80);
  };
  tick();
}

function sendRelayVideoChunk(chunk) {
  if (!relayActive || !relaySocket || relaySocket.readyState !== WebSocket.OPEN || relaySocket.bufferedAmount > 2 * 1024 * 1024) return;
  const headerBytes = 14;
  const buffer = new ArrayBuffer(headerBytes + chunk.byteLength);
  const view = new DataView(buffer);
  view.setUint8(0, 1);
  view.setUint8(1, chunk.type === 'key' ? 1 : 0);
  view.setUint32(2, relayFrameSequence, true);
  view.setFloat64(6, Number(chunk.timestamp) || 0, true);
  chunk.copyTo(new Uint8Array(buffer, headerBytes));
  relaySocket.send(buffer);
}

async function configureRelayDecoder(packet) {
  if (role !== 'viewer') return;
  if (String(packet.codec || '').toLowerCase() === 'image/jpeg') {
    relayDecoderConfigured = true;
    relayCanvas.width = Math.max(16, Number(packet.displayAspectWidth || packet.codedWidth));
    relayCanvas.height = Math.max(16, Number(packet.displayAspectHeight || packet.codedHeight));
    return;
  }
  if (!window.VideoDecoder || !window.EncodedVideoChunk) throw new Error('This browser does not expose the WebCodecs relay decoder.');
  const config = {
    codec: String(packet.codec || 'vp8'),
    codedWidth: Number(packet.codedWidth),
    codedHeight: Number(packet.codedHeight),
  };
  const supported = await VideoDecoder.isConfigSupported(config);
  if (!supported.supported) throw new Error('VP8 WebCodecs relay decoding is unavailable.');
  if (!relayDecoder || relayDecoder.state === 'closed') {
    relayDecoder = new VideoDecoder({
      output: drawRelayFrame,
      error: (error) => {
        relayDecoderConfigured = false;
        if (relayActive) showError(error);
      },
    });
  } else if (relayDecoder.state === 'configured') {
    relayDecoder.reset();
  }
  relayDecoder.configure(supported.config || config);
  relayDecoderConfigured = true;
  relayCanvas.width = Math.max(16, Number(packet.displayAspectWidth || packet.codedWidth));
  relayCanvas.height = Math.max(16, Number(packet.displayAspectHeight || packet.codedHeight));
}

function drawRelayFrame(frame) {
  if (!relayActive) {
    frame.close();
    return;
  }
  if (relayCanvas.width !== frame.displayWidth || relayCanvas.height !== frame.displayHeight) {
    relayCanvas.width = frame.displayWidth;
    relayCanvas.height = frame.displayHeight;
  }
  const context = relayCanvas.getContext('2d', { alpha: false, desynchronized: true });
  context.drawImage(frame, 0, 0, relayCanvas.width, relayCanvas.height);
  frame.close();
  const now = performance.now();
  relayFrameTimes.push(now);
  while (relayFrameTimes.length && relayFrameTimes[0] < now - 1_000) relayFrameTimes.shift();
  updateMetrics({ connectionPath: 'wss-relay', fps: relayFrameTimes.length });
  setPlaying(true);
  setState('connected', 'Connected - WSS relay interactive control ready');
}

async function decodeRelayVideo(data) {
  if (role !== 'viewer' || !relayActive) return;
  const buffer = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
  if (buffer.byteLength <= 14) return;
  const view = new DataView(buffer);
  if (![1, 2].includes(view.getUint8(0))) return;
  if (view.getUint8(0) === 2) {
    const image = await createImageBitmap(new Blob([new Uint8Array(buffer, 14)], { type: 'image/jpeg' }));
    if (!relayDecoderConfigured || relayCanvas.width === 300 && relayCanvas.height === 150) {
      relayCanvas.width = image.width;
      relayCanvas.height = image.height;
      relayDecoderConfigured = true;
    }
    const context = relayCanvas.getContext('2d', { alpha: false, desynchronized: true });
    context.drawImage(image, 0, 0, relayCanvas.width, relayCanvas.height);
    image.close();
    drawRelayJpegFrame();
    return;
  }
  if (!relayDecoderConfigured) return;
  const keyFrame = (view.getUint8(1) & 1) === 1;
  try {
    relayDecoder.decode(new EncodedVideoChunk({
      type: keyFrame ? 'key' : 'delta',
      timestamp: view.getFloat64(6, true),
      data: new Uint8Array(buffer, 14),
    }));
  } catch {
    relayForceKeyFrame = true;
    sendRelayJson({ type: 'mirror.activate', reason: 'keyframe-request' });
  }
}

function drawRelayJpegFrame() {
  const now = performance.now();
  relayFrameTimes.push(now);
  while (relayFrameTimes.length && relayFrameTimes[0] < now - 1_000) relayFrameTimes.shift();
  updateMetrics({ connectionPath: 'wss-relay', fps: relayFrameTimes.length });
  setPlaying(true);
  setState('connected', 'Connected - WSS relay interactive control ready');
}

function handleRelayPacket(packet) {
  if (!packet || typeof packet !== 'object') return;
  if (packet.type === 'mirror.relay-ready') {
    relayPeerConnected = packet.peerConnected === true;
    if (forceRelay) void activateRelay('forced-test');
    return;
  }
  if (packet.type === 'mirror.relay-peer') {
    relayPeerConnected = packet.connected === true;
    if (packet.active === true && !relayActive) void activateRelay('peer-activated', { notify: false });
    if (relayPeerConnected && (forceRelay || relayActive)) {
      relayActivationSent = sendRelayJson({ type: 'mirror.activate', reason: forceRelay ? 'forced-test' : 'fallback' });
      reportRelayConnected();
      if (role === 'source') void startRelayEncoder().catch(showError);
    } else if (relayActive) {
      setState('connecting', 'WSS relay peer reconnecting');
    }
    return;
  }
  if (packet.type === 'mirror.activate') {
    relayForceKeyFrame = true;
    void activateRelay(packet.reason || 'peer-requested', { notify: false });
    return;
  }
  if (packet.type === 'mirror.media-config') {
    void configureRelayDecoder(packet).catch(showError);
    return;
  }
  if (packet.type === 'mirror.media-state' && packet.state !== 'streaming') {
    setState('connecting', `WSS relay media ${String(packet.state || 'waiting')}`);
    return;
  }
  if (role === 'source' && packet.type === 'mirror.input') {
    enqueueInputEvent(packet.event, String(packet.requestId || ''), {
      viewerSentAt: Number(packet.telemetry?.viewerSentAt || 0) || undefined,
      sourceReceivedAt: monotonicEpochNow(),
    });
    return;
  }
  if (role === 'source' && packet.type === 'mirror.pointer') {
    enqueuePointerPacket(packet);
    return;
  }
  if (role === 'source' && packet.type === 'mirror.ping') {
    sendRelayJson({ type: 'mirror.pong', id: packet.id, sentAt: packet.sentAt, sourceAt: monotonicEpochNow() });
    return;
  }
  if (role === 'viewer' && packet.type === 'mirror.pong') {
    const rttMs = Math.max(0, monotonicEpochNow() - Number(packet.sentAt || 0));
    updateMetrics({ connectionPath: 'wss-relay', rttMs });
    return;
  }
  if (role === 'viewer' && packet.type === 'mirror.input-result') {
    recordInputResult(String(packet.requestId || ''), packet);
    if (packet.ok === true && packet.delivered !== false && packet.targetFound !== false) {
      setState('connected', 'Connected - WSS relay input verified');
    } else {
      setState('error', String(packet.message || 'The selected Codex window rejected input.'));
    }
  }
}

function connectRelayChannel() {
  if (!polling || relaySocket) return;
  const socket = new WebSocket(relayChannelUrl());
  socket.binaryType = 'arraybuffer';
  relaySocket = socket;
  socket.addEventListener('open', () => {
    if (relaySocket !== socket) return;
    relayActivationSent = false;
  });
  socket.addEventListener('message', (message) => {
    if (typeof message.data !== 'string') {
      void decodeRelayVideo(message.data).catch(showError);
      return;
    }
    let packet;
    try { packet = JSON.parse(message.data); } catch { return; }
    handleRelayPacket(packet);
  });
  socket.addEventListener('close', () => {
    if (relaySocket !== socket) return;
    relaySocket = null;
    relayPeerConnected = false;
    relayActivationSent = false;
    if (relayActive) setState('connecting', 'WSS relay reconnecting');
    if (polling && !relayReconnectTimer) {
      relayReconnectTimer = window.setTimeout(() => {
        relayReconnectTimer = 0;
        connectRelayChannel();
      }, 750);
    }
  });
  socket.addEventListener('error', () => {});
}

function sendInputPacket(packet) {
  if (!inputSocket || inputSocket.readyState !== WebSocket.OPEN) return false;
  inputSocket.send(JSON.stringify(packet));
  return true;
}

function connectInputChannel() {
  if (role !== 'source' && !(role === 'viewer' && localViewerSession)) return;
  if (inputSocket) return;
  const socket = new WebSocket(inputChannelUrl());
  inputSocket = socket;
  socket.addEventListener('open', () => {
    if (inputSocket !== socket) return;
    document.body.dataset.inputChannel = 'ready';
    if (role === 'source') setState('connecting', 'Input channel ready - waiting for viewer');
  });
  socket.addEventListener('message', (message) => {
    let packet;
    try { packet = JSON.parse(String(message.data || '')); } catch { return; }
    if (packet?.type === 'mirror.input-result') {
      if (role === 'viewer') {
        recordInputResult(String(packet.requestId || ''), packet);
        if (packet.ok === true && packet.delivered !== false && packet.targetFound !== false) {
          setState('connected', 'Connected - local direct input verified');
        } else {
          setState('error', String(packet.message || 'The selected Codex window rejected input.'));
        }
      } else {
        sendControlResult(String(packet.requestId || ''), packet);
      }
    } else if (packet?.type === 'mirror.input-error') {
      showError(packet.message || 'Native input channel rejected a packet.');
    }
  });
  socket.addEventListener('close', () => {
    if (inputSocket !== socket) return;
    inputSocket = null;
    document.body.dataset.inputChannel = 'reconnecting';
    if (polling && !inputReconnectTimer) {
      if (role === 'source') setState('connecting', 'Input channel reconnecting - HTTP fallback active');
      inputReconnectTimer = window.setTimeout(() => {
        inputReconnectTimer = 0;
        connectInputChannel();
      }, 350);
    }
  });
  socket.addEventListener('error', () => {});
}

function updateDirectLocalInput(session = {}) {
  if (role !== 'viewer') return;
  localViewerSession = session?.remote === false;
  directLocalInput = localViewerSession && session?.inputTarget?.delivery === 'window-message';
  document.body.dataset.directLocalInput = directLocalInput ? 'ready' : 'waiting';
  if (localViewerSession && !inputSocket) connectInputChannel();
}

function dispatchInputEvent(eventData, requestId = '', telemetry = {}) {
  const isMove = eventData?.type === 'mouse' && eventData.action === 'move';
  if (isMove) {
    latestMoveRequest = { eventData, requestId, telemetry };
    if (!moveRequestInFlight) void flushFastMove();
    return;
  }
  inputQueue = inputQueue
    .then(async () => {
      try {
        if (role === 'source' && sendInputPacket({ type: 'mirror.input', requestId, event: eventData, telemetry })) return;
        const acceptedAt = monotonicEpochNow();
        const result = await request(`/api/codex-native-mirror/sessions/${encodeURIComponent(sessionId)}/input`, {
          method: 'POST',
          body: JSON.stringify(eventData),
        });
        sendControlResult(requestId, {
          ok: true,
          delivered: result.delivered !== false,
          targetFound: result.targetFound !== false,
          acceptedAt,
          deliveredAt: monotonicEpochNow(),
          telemetry: { ...telemetry, relayAcceptedAt: acceptedAt, bridgeDeliveredAt: monotonicEpochNow() },
        });
      } catch (error) {
        sendControlResult(requestId, {
          ok: false,
          delivered: false,
          targetFound: error?.code !== 'CODEX_MIRROR_INPUT_TARGET_NOT_FOUND',
          message: error?.message || 'Native input was rejected.',
        });
        throw error;
      }
    })
    .catch(showError);
}

async function flushFastMove() {
  if (moveRequestInFlight || !latestMoveRequest) return;
  moveRequestInFlight = true;
  const current = latestMoveRequest;
  latestMoveRequest = null;
  try {
    if (!(role === 'source' && sendInputPacket({ type: 'mirror.pointer', event: current.eventData, telemetry: current.telemetry }))) {
      await request(`/api/codex-native-mirror/sessions/${encodeURIComponent(sessionId)}/input`, {
        method: 'POST',
        body: JSON.stringify(current.eventData),
      });
    }
  } catch (error) {
    showError(error);
  } finally {
    moveRequestInFlight = false;
    if (latestMoveRequest) void flushFastMove();
  }
}

function flushPendingInputMove() {
  inputMoveTimer = 0;
  if (!pendingInputMove) return;
  const { eventData, requestId, telemetry } = pendingInputMove;
  pendingInputMove = null;
  dispatchInputEvent(eventData, requestId, telemetry);
}

function enqueueInputEvent(eventData, requestId = '', telemetry = {}) {
  if (eventData?.type === 'mouse' && eventData.action === 'move') {
    pendingInputMove = { eventData, requestId, telemetry };
    if (!inputMoveTimer) inputMoveTimer = window.setTimeout(flushPendingInputMove, 0);
    return;
  }
  if (inputMoveTimer) {
    window.clearTimeout(inputMoveTimer);
    inputMoveTimer = 0;
  }
  flushPendingInputMove();
  dispatchInputEvent(eventData, requestId, telemetry);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'include',
    cache: 'no-store',
    headers: { ...headers(), ...(options.headers || {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.message || `Native Mirror returned HTTP ${response.status}`);
    error.code = body.code;
    throw error;
  }
  return response.json();
}

async function postSignal(kind, payload = {}) {
  return request(`/api/codex-native-mirror/sessions/${encodeURIComponent(sessionId)}/signals`, {
    method: 'POST',
    body: JSON.stringify({ kind, payload }),
  });
}

function selectedPairDetails(stats) {
  let selectedPair = null;
  for (const report of stats.values()) {
    if (report.type === 'transport' && report.selectedCandidatePairId) {
      selectedPair = stats.get(report.selectedCandidatePairId) || null;
      if (selectedPair) break;
    }
  }
  if (!selectedPair) {
    for (const report of stats.values()) {
      if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
        selectedPair = report;
        break;
      }
    }
  }
  if (!selectedPair) return null;
  const localCandidate = stats.get(selectedPair.localCandidateId) || {};
  const remoteCandidate = stats.get(selectedPair.remoteCandidateId) || {};
  const relayUsed = localCandidate.candidateType === 'relay' || remoteCandidate.candidateType === 'relay';
  return {
    selectedPair,
    localCandidate,
    remoteCandidate,
    relayUsed,
    connectionPath: relayUsed ? 'relay' : 'direct',
    rttMs: Number.isFinite(Number(selectedPair.currentRoundTripTime))
      ? Number(selectedPair.currentRoundTripTime) * 1_000
      : null,
  };
}

async function applyAdaptiveVideoProfile(connection, transport) {
  if (role !== 'source') return;
  const sender = connection.getSenders().find((item) => item.track?.kind === 'video');
  if (!sender) return;
  const rttMs = Number(transport?.rttMs);
  const profile = !Number.isFinite(rttMs) || rttMs < 80
    ? { id: 'high', maxFramerate: 60, maxBitrate: 8_000_000 }
    : rttMs < 180
      ? { id: 'balanced', maxFramerate: 45, maxBitrate: 5_000_000 }
      : { id: 'responsive', maxFramerate: 30, maxBitrate: 2_500_000 };
  if (profile.id === appliedQualityProfile) return;
  const parameters = sender.getParameters();
  parameters.degradationPreference = 'maintain-framerate';
  parameters.encodings = (parameters.encodings?.length ? parameters.encodings : [{}]).map((encoding) => ({
    ...encoding,
    maxFramerate: profile.maxFramerate,
    maxBitrate: profile.maxBitrate,
    priority: 'high',
  }));
  await sender.setParameters(parameters);
  appliedQualityProfile = profile.id;
  updateMetrics({ qualityProfile: profile.id });
}

async function samplePeerTelemetry(connection) {
  if (!connection || connection.connectionState === 'closed') return;
  const stats = await connection.getStats();
  const transport = selectedPairDetails(stats);
  let fps = null;
  if (role === 'viewer') {
    for (const report of stats.values()) {
      if (report.type === 'inbound-rtp' && report.kind === 'video' && Number.isFinite(Number(report.framesPerSecond))) {
        fps = Number(report.framesPerSecond);
        break;
      }
    }
  }
  updateMetrics({
    ...(transport ? { connectionPath: transport.connectionPath, rttMs: transport.rttMs } : {}),
    ...(Number.isFinite(fps) ? { fps } : {}),
  });
  await applyAdaptiveVideoProfile(connection, transport);
}

function startPeerTelemetry(connection) {
  if (peerTelemetryTimer) window.clearInterval(peerTelemetryTimer);
  appliedQualityProfile = '';
  const sample = () => void samplePeerTelemetry(connection).catch(() => {});
  sample();
  peerTelemetryTimer = window.setInterval(sample, 1_000);
}

function stopPeerTelemetry() {
  if (peerTelemetryTimer) window.clearInterval(peerTelemetryTimer);
  peerTelemetryTimer = 0;
}

async function reportSelectedTransport(connection, attempt = 0) {
  const stats = await connection.getStats();
  const transport = selectedPairDetails(stats);
  if (!transport) {
    if (attempt < 4 && connection.connectionState === 'connected') {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      return reportSelectedTransport(connection, attempt + 1);
    }
    return;
  }
  const { localCandidate, remoteCandidate, relayUsed, connectionPath, rttMs } = transport;
  updateMetrics({ connectionPath, rttMs });
  const payload = {
    role,
    phase: 'transport',
    localCandidateType: String(localCandidate.candidateType || 'unknown'),
    remoteCandidateType: String(remoteCandidate.candidateType || 'unknown'),
    protocol: String(localCandidate.protocol || remoteCandidate.protocol || 'unknown'),
    relayUsed,
    rttMs: Number.isFinite(rttMs) ? Math.round(rttMs) : null,
  };
  const signature = JSON.stringify(payload);
  if (signature === lastTransportReport) return;
  lastTransportReport = signature;
  await postSignal('ready', payload);
}

function reportConnectionError(state) {
  const normalizedState = String(state || 'failed');
  if (normalizedState === lastConnectionError) return;
  lastConnectionError = normalizedState;
  void postSignal('ready', { role, phase: 'connection-error', state: normalizedState }).catch(showError);
}

function bindControlChannel(channel) {
  controlChannel = channel;
  controlChannel.addEventListener('open', () => {
    if (relayActive) {
      channel.close();
      return;
    }
    if (relayFallbackTimer) window.clearTimeout(relayFallbackTimer);
    relayFallbackTimer = 0;
    lastConnectionError = '';
    setState('connected', 'Connected · interactive control ready');
    void postSignal('ready', { role, phase: 'control' }).catch(showError);
  });
  controlChannel.addEventListener('close', () => {
    controlChannel = null;
    if (relayActive) return;
    reportConnectionError('control-closed');
  });
  controlChannel.addEventListener('message', (message) => {
    let packet;
    try { packet = JSON.parse(String(message.data || '')); } catch { return; }
      if (role === 'source') {
        if (packet?.type === 'mirror.input') {
          enqueueInputEvent(packet.event, String(packet.requestId || ''), {
            viewerSentAt: Number(packet.telemetry?.viewerSentAt || 0) || undefined,
            sourceReceivedAt: monotonicEpochNow(),
          });
        } else if (packet?.type === 'mirror.pointer') {
          enqueuePointerPacket(packet);
        } else if (packet?.type === 'mouse' || packet?.type === 'key') {
        // Compatibility with sessions opened before the acknowledged control protocol.
        enqueueInputEvent(packet);
      }
      return;
    }
    if (role === 'viewer' && packet?.type === 'mirror.input-result') {
      recordInputResult(String(packet.requestId || ''), packet);
      if (packet.ok === true && packet.delivered !== false && packet.targetFound !== false) {
        setState('connected', 'Connected - interactive input verified');
      } else {
        setState('error', String(packet.message || 'The selected Codex window rejected input.'));
      }
    }
  });
}

function bindPointerChannel(channel) {
  pointerChannel = channel;
  pointerChannel.addEventListener('close', () => {
    if (pointerChannel === channel) pointerChannel = null;
  });
  pointerChannel.addEventListener('message', (message) => {
    let packet;
    try { packet = JSON.parse(String(message.data || '')); } catch { return; }
    if (role === 'source' && packet?.type === 'mirror.pointer') enqueuePointerPacket(packet);
  });
}

function enqueuePointerPacket(packet) {
  const sequence = Number(packet?.sequence || 0);
  if (Number.isSafeInteger(sequence) && sequence > 0) {
    if (sequence <= lastReceivedPointerSequence) return;
    lastReceivedPointerSequence = sequence;
  }
  enqueueInputEvent(packet.event);
}

function sendByeOnPagehide() {
  if (!polling || !sessionId || !token) return;
  void fetch(`/api/codex-native-mirror/sessions/${encodeURIComponent(sessionId)}/signals`, {
    method: 'POST',
    keepalive: true,
    credentials: 'include',
    cache: 'no-store',
    headers: headers(),
    body: JSON.stringify({ kind: 'bye', payload: {} }),
  }).catch(() => {});
}

function createPeer() {
  const connection = new RTCPeerConnection(rtcConfiguration);
  startPeerTelemetry(connection);
  connection.addEventListener('icecandidate', (event) => {
    if (event.candidate) void postSignal('candidate', event.candidate.toJSON()).catch(showError);
  });
  connection.addEventListener('connectionstatechange', () => {
    const state = connection.connectionState;
    if (relayActive) return;
    if (state === 'connected') {
      lastConnectionError = '';
      setState('connected', role === 'source' ? 'Connected · opening control channel' : 'Connected · opening interactive control');
      void postSignal('ready', { role, phase: 'peer' }).catch(showError);
      void reportSelectedTransport(connection).catch(() => {});
    }
    else if (state === 'failed' || state === 'disconnected') {
      if (!relayActive) {
        setState('connecting', `WebRTC ${state} - switching to WSS relay`);
        reportConnectionError(state);
        void activateRelay(`webrtc-${state}`);
      }
    }
    else setState('connecting', `WebRTC ${state}`);
  });
  connection.addEventListener('track', (event) => {
    video.srcObject = event.streams[0] || new MediaStream([event.track]);
    video.muted = true;
    void video.play().then(() => setPlaying(true)).catch(showError);
  });
  connection.addEventListener('datachannel', (event) => {
    if (event.channel.label === 'control') bindControlChannel(event.channel);
    if (event.channel.label === 'pointer') bindPointerChannel(event.channel);
  });
  if (role === 'source') {
    bindControlChannel(connection.createDataChannel('control', { ordered: true }));
    bindPointerChannel(connection.createDataChannel('pointer', { ordered: false, maxRetransmits: 0 }));
  }
  return connection;
}

async function addCandidate(candidate) {
  if (!peer?.remoteDescription) {
    pendingCandidates.push(candidate);
    return;
  }
  await peer.addIceCandidate(candidate);
}

async function flushCandidates() {
  while (pendingCandidates.length) await peer.addIceCandidate(pendingCandidates.shift());
}

async function handleSignal(signal) {
  if (relayActive && ['candidate', 'offer', 'answer'].includes(signal.kind)) return;
  if (role === 'viewer' && signal.kind === 'ready' && signal.payload?.inputOnly === true) {
    setPlaying(false);
    emptyTitle.textContent = 'Interactive control ready';
    emptyDetail.textContent = `Keyboard and pointer events target the ${String(signal.payload.targetTitle || 'Codex')} window while video reconnects.`;
    setState('connected', 'Connected - input control ready');
    return;
  }
  if (signal.kind === 'candidate') return addCandidate(signal.payload);
  if (signal.kind === 'bye') {
    setState('error', 'Peer stopped');
    setPlaying(false);
    return;
  }
  if (role === 'source' && signal.kind === 'answer') {
    await peer.setRemoteDescription(signal.payload);
    await flushCandidates();
    return;
  }
  if (role === 'viewer' && signal.kind === 'offer') {
    if (!peer) peer = createPeer();
    await peer.setRemoteDescription(signal.payload);
    await flushCandidates();
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await postSignal('answer', peer.localDescription);
  }
}

async function pollSignals() {
  while (polling) {
    try {
      const result = await request(`/api/codex-native-mirror/sessions/${encodeURIComponent(sessionId)}/signals?after=${cursor}`);
      updateDirectLocalInput(result.session);
      for (const signal of result.signals || []) {
        cursor = Math.max(cursor, Number(signal.sequence) || 0);
        await handleSignal(signal);
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    } catch (error) {
      if (relayActive && relayPeerConnected) {
        setState('connected', role === 'viewer'
          ? 'Connected - WSS relay control ready'
          : 'Connected - WSS relay source active');
      } else {
        setState('connecting', `Signaling reconnecting - ${String(error?.message || error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

async function selectWindow() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    await selectInputOnlyTarget();
    return;
  }
  // The embedded desktop host can leave getDisplayMedia pending indefinitely.
  // Register the authenticated Windows input target first so remote control is
  // usable immediately; a successful capture below upgrades the same session.
  if (remoteSource) await selectInputOnlyTarget();
  stopRelayEncoder();
  stream?.getTracks().forEach((streamTrack) => streamTrack.stop());
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: 'window',
        frameRate: { ideal: 60, max: 60 },
        cursor: 'never',
      },
      audio: false,
      monitorTypeSurfaces: 'exclude',
      selfBrowserSurface: 'exclude',
    });
  } catch (error) {
    const message = String(error?.message || error || '').toLowerCase();
    if (/not supported|unsupported|display capture|permission denied|failed to fetch|not implemented|invalid state|invalidstate|notallowed|aborterror/.test(message)) {
      await selectInputOnlyTarget();
      return;
    }
    throw error;
  }
  const [track] = stream.getVideoTracks();
  if (!track) throw new Error('No window video track was selected.');
  track.contentHint = 'motion';
  const settings = track.getSettings?.() || {};
  if (settings.displaySurface && settings.displaySurface !== 'window') {
    stream.getTracks().forEach((streamTrack) => streamTrack.stop());
    stream = null;
    throw new Error('Select a single Codex window, not the entire screen.');
  }
  track.addEventListener('ended', () => void stopMirror(false));
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  setPlaying(true);
  if (relayActive) {
    await request(`/api/codex-native-mirror/sessions/${encodeURIComponent(sessionId)}/input-target`, {
      method: 'POST',
      body: JSON.stringify({ label: track.label || '', width: settings.width || video.videoWidth, height: settings.height || video.videoHeight, delivery: sameHost ? 'window-message' : 'sendinput' }),
    });
    await postSignal('ready', { selectedWindow: true, interactive: true });
    await startRelayEncoder();
    setState('connected', 'Window selected - WSS relay streaming');
    selectWindowButton.textContent = 'Change window';
    return;
  }
  peer?.close();
  peer = createPeer();
  for (const streamTrack of stream.getTracks()) peer.addTrack(streamTrack, stream);
  const sender = peer.getSenders().find((item) => item.track?.kind === 'video');
  if (sender) {
    const parameters = sender.getParameters();
    parameters.degradationPreference = 'maintain-framerate';
    parameters.encodings = (parameters.encodings?.length ? parameters.encodings : [{}]).map((encoding) => ({
      ...encoding,
      maxFramerate: 60,
      maxBitrate: 8_000_000,
      priority: 'high',
    }));
    void sender.setParameters(parameters).catch(() => {});
  }
  await request(`/api/codex-native-mirror/sessions/${encodeURIComponent(sessionId)}/input-target`, {
    method: 'POST',
    body: JSON.stringify({ label: track.label || '', width: settings.width || video.videoWidth, height: settings.height || video.videoHeight, delivery: sameHost ? 'window-message' : 'sendinput' }),
  });
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await postSignal('ready', { selectedWindow: true, interactive: true });
  await postSignal('offer', peer.localDescription);
  setState('connecting', 'Window selected · waiting for viewer');
  selectWindowButton.textContent = 'Change window';
}

async function selectInputOnlyTarget() {
  if (role !== 'source') return;
  const targetTitle = fallbackTargetTitle || 'ChatGPT';
  const target = await request(`/api/codex-native-mirror/sessions/${encodeURIComponent(sessionId)}/input-target`, {
    method: 'POST',
    body: JSON.stringify({ label: targetTitle, width: 1920, height: 1080, mode: 'input-only', delivery: sameHost ? 'window-message' : 'sendinput' }),
  });
  await postSignal('ready', { selectedWindow: true, interactive: true, inputOnly: true, targetTitle });
  selectWindowButton.textContent = 'Use Codex window';
  setState('connected', `Input ready - ${target?.target?.label || targetTitle}`);
  emptyTitle.textContent = 'Interactive control ready';
  emptyDetail.textContent = `Keyboard and pointer events target the ${target?.target?.label || targetTitle} window. Video capture is unavailable in this host.`;
}

async function stopMirror(closeSession = true) {
  polling = false;
  if (inputMoveTimer) window.clearTimeout(inputMoveTimer);
  if (inputReconnectTimer) window.clearTimeout(inputReconnectTimer);
  if (relayFallbackTimer) window.clearTimeout(relayFallbackTimer);
  if (relayReconnectTimer) window.clearTimeout(relayReconnectTimer);
  if (relayPingTimer) window.clearInterval(relayPingTimer);
  inputMoveTimer = 0;
  inputReconnectTimer = 0;
  relayFallbackTimer = 0;
  relayReconnectTimer = 0;
  relayPingTimer = 0;
  pendingInputMove = null;
  releaseViewerInputs();
  stopRelayEncoder();
  if (relayDecoder && relayDecoder.state !== 'closed') relayDecoder.close();
  relayDecoder = null;
  relayDecoderConfigured = false;
  stream?.getTracks().forEach((track) => track.stop());
  peer?.close();
  stopPeerTelemetry();
  inputSocket?.close(1000, 'mirror stopped');
  relaySocket?.close(1000, 'mirror stopped');
  inputSocket = null;
  relaySocket = null;
  stream = null;
  peer = null;
  controlChannel = null;
  pointerChannel = null;
  setPlaying(false);
  setState('error', 'Stopped');
  await postSignal('bye', {}).catch(() => {});
  if (closeSession) await request(`/api/codex-native-mirror/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {});
}

function activeMirrorSurface() {
  return relayActive && role === 'viewer' ? relayCanvas : video;
}

function videoPoint(event) {
  const surface = activeMirrorSurface();
  const rect = surface.getBoundingClientRect();
  const width = surface === video ? video.videoWidth || rect.width : relayCanvas.width || rect.width;
  const height = surface === video ? video.videoHeight || rect.height : relayCanvas.height || rect.height;
  if (!width || !height || !rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / width, rect.height / height);
  const renderedWidth = width * scale;
  const renderedHeight = height * scale;
  const left = rect.left + (rect.width - renderedWidth) / 2;
  const top = rect.top + (rect.height - renderedHeight) / 2;
  const x = (event.clientX - left) / renderedWidth;
  const y = (event.clientY - top) / renderedHeight;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

function sendControl(event) {
  if (role !== 'viewer' || !controlEnabled) return;
  const localInputReady = directLocalInput && inputSocket?.readyState === WebSocket.OPEN;
  const relayReady = relayActive && relaySocket?.readyState === WebSocket.OPEN && relayPeerConnected;
  const directReady = !relayActive && controlChannel?.readyState === 'open';
  if (!localInputReady && !relayReady && !directReady) return;
  if (event?.type === 'mouse' && event.action === 'move') {
    const packet = { type: 'mirror.pointer', sequence: ++pointerSequence, event };
    if (localInputReady && sendInputPacket(packet)) return;
    if (relayReady) {
      sendRelayJson(packet);
      return;
    }
    const serialized = JSON.stringify(packet);
    if (pointerChannel?.readyState === 'open') pointerChannel.send(serialized);
    // The pointer channel deliberately drops delayed packets. Mirror the newest
    // point on the ordered channel as a de-duplicated reliability fallback.
    controlChannel.send(serialized);
    return;
  }
  const requiresResult = event?.type === 'key' || (event?.type === 'mouse' && event.action !== 'move');
  const requestId = requiresResult ? `control-${++controlSequence}` : '';
  rememberInputRequest(requestId);
  const packet = {
    type: 'mirror.input',
    requestId,
    event,
    telemetry: { viewerSentAt: monotonicEpochNow() },
  };
  if (localInputReady && sendInputPacket(packet)) return;
  if (relayReady) sendRelayJson(packet);
  else controlChannel.send(JSON.stringify(packet));
}

function pointerButton(event) {
  const button = Number(event?.button);
  return Number.isInteger(button) && button >= 0 && button <= 4 ? button : 0;
}

function sendPointer(action, event) {
  const point = videoPoint(event);
  if (!point) return;
  lastPointerPoint = point;
  sendControl({ type: 'mouse', action, x: point.x, y: point.y, button: pointerButton(event), delta: Number(event.deltaY || 0) });
}

function releaseViewerInputs() {
  if (role !== 'viewer') return;
  for (const button of pressedButtons) {
    sendControl({ type: 'mouse', action: 'up', x: lastPointerPoint.x, y: lastPointerPoint.y, button, delta: 0 });
  }
  pressedButtons.clear();
  for (const [code, key] of pressedKeys) {
    sendControl({ type: 'key', phase: 'up', code, key, repeat: false });
  }
  pressedKeys.clear();
}

function onPointerMove(event) {
  pendingMove = event;
  if (moveFrame) return;
  moveFrame = requestAnimationFrame(() => {
    moveFrame = 0;
    if (pendingMove) sendPointer('move', pendingMove);
    pendingMove = null;
  });
}

function isToolbarTarget(target) {
  return target instanceof HTMLElement && Boolean(target.closest('.mirror-toolbar'));
}

function installViewerControls() {
  for (const surface of [video, relayCanvas]) {
    surface.addEventListener('pointermove', onPointerMove);
    surface.addEventListener('pointerdown', (event) => {
      if (!controlEnabled) return;
      event.preventDefault();
      surface.focus({ preventScroll: true });
      surface.setPointerCapture?.(event.pointerId);
      pressedButtons.add(pointerButton(event));
      sendPointer('down', event);
    });
    surface.addEventListener('pointerup', (event) => {
      if (!controlEnabled) return;
      event.preventDefault();
      sendPointer('up', event);
      pressedButtons.delete(pointerButton(event));
      surface.releasePointerCapture?.(event.pointerId);
    });
    surface.addEventListener('pointercancel', (event) => {
      if (!controlEnabled) return;
      sendPointer('up', event);
      pressedButtons.delete(pointerButton(event));
      surface.releasePointerCapture?.(event.pointerId);
    });
    surface.addEventListener('wheel', (event) => { if (!controlEnabled) return; event.preventDefault(); sendPointer('wheel', event); }, { passive: false });
    surface.addEventListener('contextmenu', (event) => { if (controlEnabled) event.preventDefault(); });
  }
  window.addEventListener('keydown', (event) => {
    if (!controlEnabled || isToolbarTarget(event.target)) return;
    event.preventDefault();
    pressedKeys.set(event.code, event.key);
    sendControl({ type: 'key', phase: 'down', code: event.code, key: event.key, repeat: event.repeat });
  }, true);
  window.addEventListener('keyup', (event) => {
    if (!controlEnabled || isToolbarTarget(event.target)) return;
    event.preventDefault();
    pressedKeys.delete(event.code);
    sendControl({ type: 'key', phase: 'up', code: event.code, key: event.key, repeat: event.repeat });
  }, true);
  window.addEventListener('blur', releaseViewerInputs);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') releaseViewerInputs(); });
}

function showError(error) {
  const message = String(error?.message || error || 'Native Mirror failed');
  if (relayActive && relayPeerConnected) {
    setState('connected', role === 'viewer'
      ? 'Connected - WSS relay control ready'
      : 'Connected - WSS relay source active');
    if (role === 'viewer' && relayFrameTimes.length === 0) {
      emptyTitle.textContent = 'Interactive control ready';
      emptyDetail.textContent = 'Keyboard and pointer control remains active while the video stream reconnects.';
    }
    return;
  }
  setState('error', message);
  emptyTitle.textContent = 'Native Mirror unavailable';
  emptyDetail.textContent = message;
}

async function initialize() {
  if (!sessionId || !token || !['source', 'viewer'].includes(role)) throw new Error('Native Mirror session credentials are missing.');
  document.body.dataset.role = role;
  roleLabel.textContent = role === 'source' ? 'Selected-window source' : 'Interactive viewer';
  launchCodexButton.hidden = role !== 'source' || remoteSource;
  selectWindowButton.hidden = role !== 'source';
  toggleControlButton.hidden = role !== 'viewer';
  if (role === 'viewer') {
    emptyTitle.textContent = 'Waiting for selected window';
    emptyDetail.textContent = 'Interactive control is available after connection';
    setControl(true);
    installViewerControls();
  } else {
    emptyTitle.textContent = 'No window selected';
    emptyDetail.textContent = 'Select a Codex window to start the interactive mirror';
  }
  const details = await request(`/api/codex-native-mirror/sessions/${encodeURIComponent(sessionId)}`);
  rtcConfiguration = details.rtcConfiguration || rtcConfiguration;
  updateDirectLocalInput(details.session);
  connectInputChannel();
  connectRelayChannel();
  if (role === 'viewer' && !forceRelay) peer = createPeer();
  await postSignal('ready', { role, phase: 'page', interactive: details.session?.inputEnabled === true });
  setState('connecting', role === 'source' ? 'Ready to select window' : 'Waiting for source');
  void pollSignals();
  if (role === 'viewer') {
    relayFallbackTimer = window.setTimeout(() => {
      relayFallbackTimer = 0;
      if (!relayActive && controlChannel?.readyState !== 'open') void activateRelay('direct-timeout');
    }, forceRelay ? 0 : 8_000);
  }
  if (role === 'source' && remoteSource && autoStart) {
    window.setTimeout(() => void selectWindow().catch((error) => {
      setState('error', String(error?.message || error));
    }), 250);
  }
}

selectWindowButton.addEventListener('click', () => void selectWindow().catch(showError));
toggleControlButton.addEventListener('click', () => setControl(!controlEnabled));
launchCodexButton.addEventListener('click', () => {
  launchCodexButton.disabled = true;
  setState('connecting', 'Launching Codex Desktop');
  void fetch('/api/codex-desktop/launch', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then((response) => { if (!response.ok) throw new Error(`Codex Desktop launch returned HTTP ${response.status}`); setState('connecting', 'Codex Desktop launched'); })
    .catch(showError)
    .finally(() => { launchCodexButton.disabled = false; });
});
fullscreenButton.addEventListener('click', () => void document.documentElement.requestFullscreen().catch(showError));
stopButton.addEventListener('click', () => void stopMirror(true));
window.addEventListener('pagehide', () => {
  sendByeOnPagehide();
  polling = false;
  if (inputMoveTimer) window.clearTimeout(inputMoveTimer);
  if (inputReconnectTimer) window.clearTimeout(inputReconnectTimer);
  if (relayFallbackTimer) window.clearTimeout(relayFallbackTimer);
  if (relayReconnectTimer) window.clearTimeout(relayReconnectTimer);
  if (relayPingTimer) window.clearInterval(relayPingTimer);
  inputMoveTimer = 0;
  inputReconnectTimer = 0;
  pendingInputMove = null;
  stopRelayEncoder();
  if (relayDecoder && relayDecoder.state !== 'closed') relayDecoder.close();
  stream?.getTracks().forEach((track) => track.stop());
  peer?.close();
  stopPeerTelemetry();
  inputSocket?.close(1000, 'page hidden');
  relaySocket?.close(1000, 'page hidden');
  inputSocket = null;
  relaySocket = null;
  controlChannel = null;
  pointerChannel = null;
});

void initialize().catch(showError);
