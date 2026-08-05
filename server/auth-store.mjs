import path from 'node:path';
import { promisify } from 'node:util';
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
  scrypt as scryptCallback,
} from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const scrypt = promisify(scryptCallback);
const PASSWORD_KEY_BYTES = 32;
const PASSWORD_SCRYPT_OPTIONS = Object.freeze({ N: 16_384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/i;

export function createAuthStore({
  usersPath,
  sessionSecretPath,
  required = false,
  cookieName = 'xhs_session',
  secureCookie = false,
  sessionTtlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  now = () => Date.now(),
} = {}) {
  const resolvedUsersPath = path.resolve(String(usersPath || 'data/auth/users.json'));
  const resolvedSecretPath = path.resolve(String(sessionSecretPath || path.join(path.dirname(resolvedUsersPath), 'session-secret')));
  const ttlSeconds = Number.isInteger(Number(sessionTtlSeconds)) && Number(sessionTtlSeconds) >= 300
    ? Number(sessionTtlSeconds)
    : DEFAULT_SESSION_TTL_SECONDS;
  let users = [];
  let sessionSecret = '';
  let initialized = false;
  const attempts = new Map();

  return {
    required: Boolean(required),
    async initialize({ bootstrapEmail = '', bootstrapPassword = '' } = {}) {
      await mkdir(path.dirname(resolvedUsersPath), { recursive: true });
      await mkdir(path.dirname(resolvedSecretPath), { recursive: true });
      users = await readUsers(resolvedUsersPath);
      if (!users.length && bootstrapEmail && bootstrapPassword) {
        users = [await createUser(bootstrapEmail, bootstrapPassword, now)];
        await writeUsers(resolvedUsersPath, users);
      }
      if (this.required && !users.length) {
        throw authError('AUTH_BOOTSTRAP_REQUIRED', '公网认证已开启，但还没有可用账号。请注入 XHS_AUTH_EMAIL 和 XHS_AUTH_PASSWORD。', 500);
      }
      sessionSecret = await readOrCreateSecret(resolvedSecretPath);
      initialized = true;
      return { userCount: users.length, required: this.required };
    },
    status() {
      return { required: this.required, initialized, userCount: users.length };
    },
    async provision(email, password, { replace = false } = {}) {
      const nextUser = await createUser(email, password, now);
      if (users.length && !replace) {
        throw authError('AUTH_ALREADY_PROVISIONED', '认证账号已经存在；需要换密时显式使用替换模式。', 409);
      }
      users = replace ? [nextUser] : [...users, nextUser];
      await writeUsers(resolvedUsersPath, users);
      return publicUser(nextUser);
    },
    authenticate(req) {
      if (!this.required) return { email: 'local', roles: ['owner'] };
      if (!initialized) return null;
      const token = parseCookie(req.headers.cookie || '', cookieName);
      if (!token) return null;
      const payload = verifySession(token, sessionSecret, now());
      if (!payload) return null;
      const user = users.find((candidate) => candidate.email === payload.email);
      return user ? publicUser(user) : null;
    },
    async login(email, password) {
      if (!initialized) throw authError('AUTH_NOT_READY', '认证服务尚未初始化。', 503);
      const normalizedEmail = normalizeEmail(email);
      const key = normalizedEmail || 'invalid';
      const current = attempts.get(key) || { count: 0, firstAt: now(), lockedUntil: 0 };
      if (current.lockedUntil > now()) {
        throw authError('AUTH_RATE_LIMITED', '登录尝试过于频繁，请稍后再试。', 429, { retryAfter: Math.ceil((current.lockedUntil - now()) / 1000) });
      }
      const user = users.find((candidate) => candidate.email === normalizedEmail);
      const valid = user ? await verifyPassword(String(password || ''), user) : false;
      if (!valid) {
        const next = current.firstAt + LOGIN_WINDOW_MS <= now()
          ? { count: 1, firstAt: now(), lockedUntil: 0 }
          : { ...current, count: current.count + 1 };
        if (next.count >= MAX_LOGIN_ATTEMPTS) next.lockedUntil = now() + LOGIN_WINDOW_MS;
        attempts.set(key, next);
        throw authError('AUTH_INVALID_CREDENTIALS', '邮箱或密码不正确。', 401);
      }
      attempts.delete(key);
      return publicUser(user);
    },
    setSession(res, user) {
      const token = createSession(publicUser(user), sessionSecret, now(), ttlSeconds);
      const parts = [
        `${cookieName}=${token}`,
        'Path=/',
        `Max-Age=${ttlSeconds}`,
        'HttpOnly',
        'SameSite=Lax',
      ];
      if (secureCookie) parts.push('Secure');
      res.setHeader('Set-Cookie', parts.join('; '));
    },
    clearSession(res) {
      const parts = [`${cookieName}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
      if (secureCookie) parts.push('Secure');
      res.setHeader('Set-Cookie', parts.join('; '));
    },
  };
}

async function createUser(email, password, now) {
  const normalizedEmail = normalizeEmail(email);
  if (!EMAIL_PATTERN.test(normalizedEmail)) throw authError('AUTH_EMAIL_INVALID', '初始账号邮箱格式不正确。', 500);
  if (String(password || '').length < 8) throw authError('AUTH_PASSWORD_WEAK', '初始密码至少需要 8 位。', 500);
  const salt = randomBytes(16);
  const hash = await hashPassword(String(password), salt);
  return { email: normalizedEmail, salt: salt.toString('base64'), hash: hash.toString('base64'), createdAt: new Date(now()).toISOString() };
}

async function hashPassword(password, salt) {
  return scrypt(password, salt, PASSWORD_KEY_BYTES, PASSWORD_SCRYPT_OPTIONS);
}

async function verifyPassword(password, user) {
  try {
    const expected = Buffer.from(String(user.hash || ''), 'base64');
    const actual = await hashPassword(password, Buffer.from(String(user.salt || ''), 'base64'));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function createSession(user, secret, nowMs, ttlSeconds) {
  const payload = base64url(JSON.stringify({ email: user.email, iat: nowMs, exp: nowMs + ttlSeconds * 1000 }));
  return `${payload}.${sign(payload, secret)}`;
}

function verifySession(token, secret, nowMs) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature || !timingEqual(signature, sign(payload, secret))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed.email || !Number.isFinite(parsed.exp) || parsed.exp <= nowMs) return null;
    return parsed;
  } catch {
    return null;
  }
}

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function timingEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function publicUser(user) {
  return { email: user.email, roles: ['owner'] };
}

function parseCookie(header, name) {
  const prefix = `${name}=`;
  for (const part of String(header).split(';')) {
    const value = part.trim();
    if (value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return '';
}

async function readUsers(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return Array.isArray(parsed?.users) ? parsed.users.filter((user) => user?.email && user?.salt && user?.hash) : [];
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw authError('AUTH_USERS_INVALID', '认证账号文件无法读取或格式错误。', 500, { cause: error });
  }
}

async function writeUsers(filePath, users) {
  await writeFile(filePath, `${JSON.stringify({ version: 1, users }, null, 2)}\n`, { mode: 0o600 });
}

async function readOrCreateSecret(filePath) {
  try {
    const value = (await readFile(filePath, 'utf8')).trim();
    if (value.length >= 32) return value;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const value = randomBytes(32).toString('base64url');
  await writeFile(filePath, `${value}\n`, { mode: 0o600 });
  return value;
}

function authError(code, message, status, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  Object.assign(error, details);
  return error;
}
