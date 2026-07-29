import { spawn } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const envText = await readFile(envPath, 'utf8').catch(() => '');
const env = parseEnv(envText);
const args = readArgs(process.argv.slice(2));
const clientId = String(args.clientId || env.SMTP_OAUTH_CLIENT_ID || '').trim();
const tenant = String(args.tenant || env.SMTP_OAUTH_TENANT || 'organizations').trim();
const smtpHost = String(args.host || env.SMTP_HOST || 'smtp.office365.com').trim();
const scope = String(env.SMTP_OAUTH_SCOPE || 'https://outlook.office.com/SMTP.Send offline_access openid profile email').trim();

if (!clientId) {
  console.error('缺少 Microsoft Entra 应用 Client ID。请先在 .env 填写 SMTP_OAUTH_CLIENT_ID，或传入 --client-id。');
  process.exit(2);
}
if (!/^[a-zA-Z0-9.-]+$/.test(tenant)) {
  console.error('SMTP_OAUTH_TENANT 格式无效。');
  process.exit(2);
}

const baseUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;
const device = await postForm(`${baseUrl}/devicecode`, { client_id: clientId, scope });
console.log(device.message || `请打开 ${device.verification_uri} 并输入代码 ${device.user_code}`);
openBrowser(device.verification_uri);

const token = await pollForToken(`${baseUrl}/token`, {
  client_id: clientId,
  device_code: device.device_code,
  grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
}, Number(device.interval) || 5, Number(device.expires_in) || 900);
const claims = decodeJwtPayload(token.id_token);
const email = String(args.email || env.SMTP_USER || claims.preferred_username || claims.email || claims.unique_name || '').trim();
if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
  console.error('授权成功，但无法确认邮箱地址。请用 --email your-account@outlook.com 重新运行。');
  process.exit(2);
}

const nextEnv = updateEnv(envText, {
  SMTP_HOST: smtpHost,
  SMTP_PORT: '587',
  SMTP_SECURE: 'false',
  SMTP_REQUIRE_TLS: 'true',
  SMTP_AUTH: 'oauth2',
  SMTP_USER: email,
  SMTP_FROM: email,
  SMTP_OAUTH_TENANT: tenant,
  SMTP_OAUTH_CLIENT_ID: clientId,
  SMTP_OAUTH_REFRESH_TOKEN: token.refresh_token,
  SMTP_OAUTH_SCOPE: scope,
});
const temporaryPath = `${envPath}.${process.pid}.tmp`;
await writeFile(temporaryPath, nextEnv, 'utf8');
await rename(temporaryPath, envPath);

let verified = false;
try {
  const transport = nodemailer.createTransport({
    host: smtpHost,
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { type: 'OAuth2', user: email, accessToken: token.access_token },
  });
  verified = await transport.verify();
  transport.close();
} catch (error) {
  console.error(`OAuth2 已保存，但 SMTP 验证失败：${String(error?.message || error)}`);
  process.exitCode = 1;
}

if (verified) console.log(`Outlook SMTP OAuth2 已验证并写入本机 .env：${maskEmail(email)}`);
console.log('重启服务后，“发送邮件”按钮会启用。');

async function postForm(url, values) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Microsoft OAuth2 请求失败 (${payload.error || response.status})`);
  return payload;
}

async function pollForToken(url, values, intervalSeconds, expiresInSeconds) {
  const deadline = Date.now() + expiresInSeconds * 1000;
  let interval = Math.max(1, intervalSeconds);
  while (Date.now() < deadline) {
    await delay(interval * 1000);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(values),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload.access_token && payload.refresh_token) return payload;
    if (payload.error === 'authorization_pending') continue;
    if (payload.error === 'slow_down') {
      interval += 5;
      continue;
    }
    throw new Error(`Microsoft OAuth2 授权失败 (${payload.error || response.status})`);
  }
  throw new Error('Microsoft OAuth2 授权已超时，请重新运行。');
}

function parseEnv(source) {
  const result = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (match) result[match[1]] = match[2].trim();
  }
  return result;
}

function updateEnv(source, values) {
  const lines = source ? source.replace(/\r\n/g, '\n').split('\n') : [];
  const remaining = new Map(Object.entries(values));
  const next = lines.map((line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)=/);
    if (!match || !remaining.has(match[1])) return line;
    const value = remaining.get(match[1]);
    remaining.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  if (remaining.size) {
    if (next.length && next.at(-1) !== '') next.push('');
    next.push('# Outlook.com SMTP (OAuth2). Secrets remain local and are never committed.');
    for (const [key, value] of remaining) next.push(`${key}=${value}`);
  }
  return `${next.join('\n').replace(/\n+$/, '')}\n`;
}

function readArgs(tokens) {
  const result = {};
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === '--client-id') result.clientId = tokens[index + 1] || '';
    if (tokens[index] === '--tenant') result.tenant = tokens[index + 1] || '';
    if (tokens[index] === '--host') result.host = tokens[index + 1] || '';
    if (tokens[index] === '--email') result.email = tokens[index + 1] || '';
  }
  return result;
}

function decodeJwtPayload(value) {
  try {
    return JSON.parse(Buffer.from(String(value).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function openBrowser(url) {
  if (!url) return;
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function maskEmail(value) {
  return value.replace(/^(.)([^@]*)(@.+)$/, '$1***$3');
}
