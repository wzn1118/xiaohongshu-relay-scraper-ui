import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULTS = Object.freeze({
  listenPort: 3478,
  tlsPort: 5349,
  relayMinPort: 49160,
  relayMaxPort: 49200,
  credentialTtlSeconds: 600,
  outputDir: '.runtime/codex-turn',
});

export function buildTurnArtifacts(options = {}) {
  const realm = normalizeRealm(options.realm);
  const publicIp = normalizePublicIp(options.publicIp);
  const listenPort = normalizePort(options.listenPort ?? DEFAULTS.listenPort, 'listen port');
  const tlsPort = normalizePort(options.tlsPort ?? DEFAULTS.tlsPort, 'TLS port');
  const relayMinPort = normalizePort(options.relayMinPort ?? DEFAULTS.relayMinPort, 'relay minimum port');
  const relayMaxPort = normalizePort(options.relayMaxPort ?? DEFAULTS.relayMaxPort, 'relay maximum port');
  const credentialTtlSeconds = normalizeInteger(
    options.credentialTtlSeconds ?? DEFAULTS.credentialTtlSeconds,
    60,
    3_600,
    'credential TTL',
  );
  if (relayMinPort > relayMaxPort) throw new Error('Relay minimum port must not exceed relay maximum port.');
  const cert = normalizeOptionalPath(options.cert);
  const pkey = normalizeOptionalPath(options.pkey);
  if (Boolean(cert) !== Boolean(pkey)) throw new Error('TLS requires both --cert and --pkey.');
  const secret = normalizeSecret(options.secret || randomBytes(32).toString('base64url'));
  const turnHost = isIP(realm) === 6 ? `[${realm}]` : realm;
  const turnUrls = [
    `turn:${turnHost}:${listenPort}?transport=udp`,
    `turn:${turnHost}:${listenPort}?transport=tcp`,
    ...(cert ? [`turns:${turnHost}:${tlsPort}?transport=tcp`] : []),
  ];
  const configLines = [
    `listening-port=${listenPort}`,
    ...(cert ? [`tls-listening-port=${tlsPort}`] : []),
    `realm=${realm}`,
    `server-name=${realm}`,
    `external-ip=${publicIp}`,
    'fingerprint',
    'use-auth-secret',
    `static-auth-secret=${secret}`,
    `min-port=${relayMinPort}`,
    `max-port=${relayMaxPort}`,
    ...(cert ? [`cert=${cert}`, `pkey=${pkey}`] : []),
    'stale-nonce=600',
    'no-cli',
    'no-loopback-peers',
    'no-multicast-peers',
  ];
  const staticServers = JSON.stringify([{ urls: `stun:${turnHost}:${listenPort}` }]);
  const productEnvironment = [
    `XHS_CODEX_MIRROR_ICE_SERVERS_JSON=${staticServers}`,
    `XHS_CODEX_TURN_URLS_JSON=${JSON.stringify(turnUrls)}`,
    `XHS_CODEX_TURN_SHARED_SECRET=${secret}`,
    `XHS_CODEX_TURN_CREDENTIAL_TTL_SECONDS=${credentialTtlSeconds}`,
  ].join('\n');
  const readme = [
    '# Codex Native Mirror TURN deployment',
    '',
    `Realm: ${realm}`,
    `Public IP: ${publicIp}`,
    '',
    '1. Install coturn on a public Linux host.',
    '2. Place `turnserver.conf` at `/etc/coturn/turnserver.conf` with owner-only read permissions.',
    `3. Allow TCP and UDP ${listenPort},${cert ? ` TCP ${tlsPort},` : ''} and UDP ${relayMinPort}-${relayMaxPort} in both the cloud firewall and host firewall.`,
    '4. Start coturn with `turnserver -c /etc/coturn/turnserver.conf` or the distribution systemd unit.',
    '5. Keep `product-turn.env` at `.runtime/codex-turn/product-turn.env`, or pass its absolute path with `-TurnEnvFile` when starting production.',
    '6. Run `npm run verify:codex:turn -- --env <path-to-product-turn.env>` before restarting the API.',
    '7. Run `npm run verify:codex:turn-relay -- --env <path-to-product-turn.env>` to require a real browser relay candidate.',
    '8. Confirm `/api/codex-relay/status` reports `ice.turnConfigured=true`, then open Mirror and verify `connectionPath=relay` from a restricted network.',
    '',
    'The shared secret appears in both generated configuration files. Do not commit or publish this directory.',
  ].join('\n');
  return {
    realm,
    publicIp,
    listenPort,
    tlsPort: cert ? tlsPort : null,
    relayMinPort,
    relayMaxPort,
    turnUrls,
    secret,
    turnserverConfig: `${configLines.join('\n')}\n`,
    productEnvironment: `${productEnvironment}\n`,
    readme: `${readme}\n`,
  };
}

export async function generateTurnConfig(options = {}) {
  const artifacts = buildTurnArtifacts(options);
  const outputDir = resolve(String(options.outputDir || DEFAULTS.outputDir));
  await mkdir(outputDir, { recursive: true });
  const files = {
    turnserverConfig: resolve(outputDir, 'turnserver.conf'),
    productEnvironment: resolve(outputDir, 'product-turn.env'),
    readme: resolve(outputDir, 'README.md'),
  };
  await Promise.all([
    writeFile(files.turnserverConfig, artifacts.turnserverConfig, { encoding: 'utf8', mode: 0o600 }),
    writeFile(files.productEnvironment, artifacts.productEnvironment, { encoding: 'utf8', mode: 0o600 }),
    writeFile(files.readme, artifacts.readme, { encoding: 'utf8' }),
  ]);
  return {
    outputDir,
    files,
    realm: artifacts.realm,
    publicIp: artifacts.publicIp,
    listenPort: artifacts.listenPort,
    tlsPort: artifacts.tlsPort,
    relayMinPort: artifacts.relayMinPort,
    relayMaxPort: artifacts.relayMaxPort,
    turnUrls: artifacts.turnUrls,
    secret: '[generated and written to protected files]',
  };
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name.startsWith('--')) throw new Error(`Unexpected argument: ${name}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}.`);
    index += 1;
    const key = ({
      '--realm': 'realm',
      '--public-ip': 'publicIp',
      '--listen-port': 'listenPort',
      '--tls-port': 'tlsPort',
      '--relay-min-port': 'relayMinPort',
      '--relay-max-port': 'relayMaxPort',
      '--credential-ttl-seconds': 'credentialTtlSeconds',
      '--output': 'outputDir',
      '--secret': 'secret',
      '--cert': 'cert',
      '--pkey': 'pkey',
    })[name];
    if (!key) throw new Error(`Unknown argument: ${name}`);
    options[key] = value;
  }
  return options;
}

function normalizeRealm(value) {
  const realm = String(value || '').trim().toLowerCase();
  const hostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!realm || (!hostname.test(realm) && !isIP(realm))) throw new Error('A valid --realm hostname or IP address is required.');
  return realm;
}

function normalizePublicIp(value) {
  const publicIp = String(value || '').trim();
  if (!isIP(publicIp)) throw new Error('A valid --public-ip IPv4 or IPv6 address is required.');
  return publicIp;
}

function normalizePort(value, label) {
  return normalizeInteger(value, 1, 65_535, label);
}

function normalizeInteger(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return number;
}

function normalizeOptionalPath(value) {
  const path = String(value || '').trim();
  if (/\r|\n/.test(path)) throw new Error('Certificate paths must not contain line breaks.');
  return path;
}

function normalizeSecret(value) {
  const secret = String(value || '');
  if (secret.length < 32 || secret.length > 256 || /\r|\n/.test(secret)) throw new Error('TURN shared secret must contain 32 to 256 characters.');
  return secret;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  generateTurnConfig(parseArguments(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
