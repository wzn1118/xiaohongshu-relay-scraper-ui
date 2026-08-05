import { createAuthStore } from '../server/auth-store.mjs';
import { config } from '../server/config.mjs';

const email = String(process.env.XHS_AUTH_EMAIL || '').trim();
const password = String(process.env.XHS_AUTH_PASSWORD || '');
const replace = String(process.env.XHS_AUTH_REPLACE || '').toLowerCase() === 'true';

if (!email || !password) {
  throw new Error('请先注入 XHS_AUTH_EMAIL 和 XHS_AUTH_PASSWORD。');
}

const store = createAuthStore({
  usersPath: config.authUsersPath,
  sessionSecretPath: config.authSessionSecretPath,
  required: false,
  cookieName: config.authCookieName,
  secureCookie: config.authSecureCookie,
  sessionTtlSeconds: config.authSessionTtlSeconds,
});
await store.initialize();
const user = await store.provision(email, password, { replace });
console.log(`Auth account provisioned: ${user.email}`);
