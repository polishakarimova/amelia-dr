import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createHmac, randomBytes, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = fileURLToPath(new URL('.', import.meta.url));

function loadEnvFile() {
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [rawKey, ...rest] = trimmed.split('=');
    const key = rawKey.trim().replace(/^\uFEFF/, '');
    let value = rest.join('=').trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

const dataDir = process.env.DATA_DIR || join(root, 'data');
const dbFile = join(dataDir, 'db.json');
const uploadsDir = process.env.UPLOADS_DIR || join(dataDir, 'uploads');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const cookieName = 'povod_session';
const appUrl = (process.env.APP_URL || `http://${host}:${port}`).replace(/\/$/, '');
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const databaseUrl = process.env.DATABASE_URL || '';
const adminToken = process.env.ADMIN_TOKEN || '';
let telegramBotInfo = null;
let pgPool = null;
let pgSchemaReady = false;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

function uid() {
  return randomBytes(10).toString('hex');
}

function now() {
  return new Date().toISOString();
}

function slugify(text) {
  return (text || 'event')
    .toLowerCase()
    .trim()
    .replace(/ё/g, 'e')
    .replace(/й/g, 'i')
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '') || `event-${uid().slice(0, 8)}`;
}

function uniqueSlug(base, db, eventId = '') {
  const initial = slugify(base);
  let slug = initial;
  let index = 2;
  while (db.events.some(event => event.slug === slug && event.id !== eventId)) {
    slug = `${initial}-${index}`;
    index += 1;
  }
  return slug;
}

function createPgPool() {
  if (!databaseUrl) return null;
  const parsed = new URL(databaseUrl);
  const sslMode = parsed.searchParams.get('sslmode');
  let ssl = false;
  if (sslMode && sslMode !== 'disable') {
    ssl = { rejectUnauthorized: false };
    const caPath = process.env.PGSSLROOTCERT;
    if (caPath && existsSync(caPath)) {
      ssl = { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
    }
  }
  return new pg.Pool({ connectionString: databaseUrl, ssl, max: 5 });
}

pgPool = createPgPool();

async function ensurePgSchema() {
  if (!pgPool || pgSchemaReady) return;
  await pgPool.query(`
    create table if not exists povod_users (
      id text primary key,
      data jsonb not null
    );
    create table if not exists povod_sessions (
      token text primary key,
      data jsonb not null
    );
    create table if not exists povod_login_tokens (
      token text primary key,
      data jsonb not null
    );
    create table if not exists povod_events (
      id text primary key,
      user_id text not null,
      slug text not null unique,
      data jsonb not null
    );
    create table if not exists povod_gifts (
      id text primary key,
      event_id text not null,
      data jsonb not null
    );
    create table if not exists povod_broadcasts (
      id text primary key,
      status text not null default 'draft',
      channel text not null default 'telegram',
      audience text not null default 'all',
      data jsonb not null
    );
    create index if not exists povod_events_user_id_idx on povod_events (user_id);
    create index if not exists povod_gifts_event_id_idx on povod_gifts (event_id);
    create index if not exists povod_broadcasts_status_idx on povod_broadcasts (status);
  `);
  pgSchemaReady = true;
  await migrateJsonDbToPostgresIfNeeded();
}

function normalizeDb(db) {
  return {
    users: Array.isArray(db.users) ? db.users : [],
    sessions: Array.isArray(db.sessions) ? db.sessions : [],
    loginTokens: Array.isArray(db.loginTokens) ? db.loginTokens : [],
    events: Array.isArray(db.events) ? db.events : [],
    gifts: Array.isArray(db.gifts) ? db.gifts : [],
    broadcasts: Array.isArray(db.broadcasts) ? db.broadcasts : []
  };
}

async function replacePgDb(db) {
  db = normalizeDb(db);
  const client = await pgPool.connect();
  try {
    await client.query('begin');
    await client.query('delete from povod_gifts');
    await client.query('delete from povod_events');
    await client.query('delete from povod_login_tokens');
    await client.query('delete from povod_sessions');
    await client.query('delete from povod_users');
    await client.query('delete from povod_broadcasts');
    for (const user of db.users) {
      await client.query('insert into povod_users (id, data) values ($1, $2::jsonb)', [user.id, JSON.stringify(user)]);
    }
    for (const session of db.sessions) {
      await client.query('insert into povod_sessions (token, data) values ($1, $2::jsonb)', [session.token, JSON.stringify(session)]);
    }
    for (const loginToken of db.loginTokens) {
      await client.query('insert into povod_login_tokens (token, data) values ($1, $2::jsonb)', [loginToken.token, JSON.stringify(loginToken)]);
    }
    for (const event of db.events) {
      await client.query('insert into povod_events (id, user_id, slug, data) values ($1, $2, $3, $4::jsonb)', [event.id, event.userId, event.slug, JSON.stringify(event)]);
    }
    for (const gift of db.gifts) {
      await client.query('insert into povod_gifts (id, event_id, data) values ($1, $2, $3::jsonb)', [gift.id, gift.eventId, JSON.stringify(gift)]);
    }
    for (const broadcast of db.broadcasts) {
      await client.query(
        'insert into povod_broadcasts (id, status, channel, audience, data) values ($1, $2, $3, $4, $5::jsonb)',
        [broadcast.id, broadcast.status || 'draft', broadcast.channel || 'telegram', broadcast.audience || 'all', JSON.stringify(broadcast)]
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function migrateJsonDbToPostgresIfNeeded() {
  if (!existsSync(dbFile)) return;
  const count = await pgPool.query(`
    select
      (select count(*)::int from povod_users) +
      (select count(*)::int from povod_events) +
      (select count(*)::int from povod_gifts) +
      (select count(*)::int from povod_broadcasts) as total
  `);
  if (Number(count.rows[0]?.total || 0) > 0) return;
  const jsonDb = normalizeDb(JSON.parse(await readFile(dbFile, 'utf8')));
  const total = jsonDb.users.length + jsonDb.events.length + jsonDb.gifts.length;
  if (!total) return;
  await replacePgDb(jsonDb);
  console.log(`Migrated ${total} records from JSON db to PostgreSQL`);
}

function assignAllowed(target, input, fields) {
  for (const field of fields) {
    if (Object.hasOwn(input, field)) target[field] = String(input[field] ?? '');
  }
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, passwordHash) {
  const [salt, expected] = String(passwordHash || '').split(':');
  if (!salt || !expected) return false;
  return hashPassword(password, salt) === passwordHash;
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

function requireAdmin(req, res, url) {
  if (!adminToken) {
    send(res, 503, { error: 'admin_token_not_configured' });
    return false;
  }
  const authHeader = String(req.headers.authorization || '');
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const token = req.headers['x-admin-token'] || bearer || url.searchParams.get('token') || parseCookies(req).povod_admin_token;
  if (!safeCompare(token, adminToken)) {
    send(res, 401, { error: 'admin_unauthorized' });
    return false;
  }
  return true;
}

function safeCompare(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function validateTelegramInitData(initData) {
  if (!telegramBotToken) throw new Error('telegram_bot_token_missing');
  const params = new URLSearchParams(initData || '');
  const receivedHash = params.get('hash');
  if (!receivedHash) throw new Error('telegram_hash_missing');
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(telegramBotToken).digest();
  const calculatedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (!safeCompare(calculatedHash, receivedHash)) throw new Error('telegram_hash_invalid');
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400 * 14) throw new Error('telegram_auth_expired');
  const user = JSON.parse(params.get('user') || '{}');
  if (!user.id) throw new Error('telegram_user_missing');
  return user;
}

function upsertTelegramUser(db, telegramUser) {
  const telegramId = String(telegramUser.id);
  const email = `telegram:${telegramId}`;
  const name = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ').trim() || telegramUser.username || `Telegram ${telegramId}`;
  let user = db.users.find(item => item.email === email || String(item.telegramId || '') === telegramId);
  if (!user) {
    user = {
      id: uid(),
      email,
      name,
      authProvider: 'telegram',
      telegramId,
      telegramUsername: telegramUser.username ? `@${telegramUser.username}` : '',
      createdAt: now()
    };
    db.users.push(user);
  } else {
    Object.assign(user, {
      email,
      name,
      authProvider: 'telegram',
      telegramId,
      telegramUsername: telegramUser.username ? `@${telegramUser.username}` : user.telegramUsername || '',
      updatedAt: now()
    });
  }
  return user;
}

async function telegramApi(method, payload = {}) {
  if (!telegramBotToken) throw new Error('telegram_bot_token_missing');
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) throw new Error(data.description || `telegram_${method}_failed`);
      return data.result;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError || new Error(`telegram_${method}_failed`);
}

async function getTelegramBotInfo() {
  if (telegramBotInfo) return telegramBotInfo;
  telegramBotInfo = await telegramApi('getMe');
  return telegramBotInfo;
}

async function sendTelegramStart(chatId) {
  await telegramApi('sendMessage', {
    chat_id: chatId,
    text: 'Повод поможет собрать праздник, детали и подарки в одной ссылке. Нажмите кнопку ниже, чтобы создать карточку.',
    reply_markup: {
      inline_keyboard: [[
        { text: 'Создать карточку в Поводе', web_app: { url: `${appUrl}/login` } }
      ]]
    }
  });
}

async function sendTelegramLoginConfirmed(chatId, token = '') {
  const returnUrl = token ? `${appUrl}/login?telegramLoginToken=${encodeURIComponent(token)}` : `${appUrl}/login`;
  await telegramApi('sendMessage', {
    chat_id: chatId,
    text: 'Готово, вы авторизованы в Поводе. Вернитесь в приложение — кабинет откроется автоматически.',
    reply_markup: {
      inline_keyboard: [[
        { text: 'Вернуться к созданию повода', web_app: { url: returnUrl } }
      ]]
    }
  });
}

function telegramLoginConsentMarkup(token) {
  const loginUrl = `${appUrl}/login?telegramLoginToken=${encodeURIComponent(token)}&telegramConsent=1`;
  return {
    inline_keyboard: [[
      { text: 'Авторизироваться', web_app: { url: loginUrl } }
    ]]
  };
}

function telegramLoginConsentText() {
  return [
    'Авторизация в Поводе',
    '',
    'Чтобы войти в кабинет организатора, нажмите кнопку «Авторизироваться».',
    '',
    'Нажимая кнопку, вы соглашаетесь на обработку персональных данных, принимаете условия сервиса и разрешаете использовать ваш Telegram-профиль для регистрации и входа в Повод.',
    '',
    'Гости праздника регистрироваться не будут.'
  ].join('\n');
}

async function updateTelegramLoginConfirmed(chatId, messageId, token) {
  const returnUrl = `${appUrl}/login?telegramLoginToken=${encodeURIComponent(token)}`;
  await telegramApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: 'Готово, вы авторизованы в Поводе. Вернитесь к созданию повода.',
    reply_markup: {
      inline_keyboard: [[
        { text: 'Вернуться к созданию повода', web_app: { url: returnUrl } }
      ]]
    }
  });
}

async function sendTelegramLoginRequest(chatId, token, loginToken = {}) {
  await telegramApi('sendMessage', {
    chat_id: chatId,
    text: telegramLoginConsentText(),
    reply_markup: telegramLoginConsentMarkup(token)
  });
}

async function readDb() {
  if (pgPool) {
    await ensurePgSchema();
    const [users, sessions, loginTokens, events, gifts, broadcasts] = await Promise.all([
      pgPool.query('select data from povod_users order by data->>\'createdAt\' desc'),
      pgPool.query('select data from povod_sessions order by data->>\'createdAt\' desc'),
      pgPool.query('select data from povod_login_tokens order by data->>\'createdAt\' desc'),
      pgPool.query('select data from povod_events order by data->>\'createdAt\' desc'),
      pgPool.query('select data from povod_gifts order by data->>\'createdAt\' desc'),
      pgPool.query('select data from povod_broadcasts order by data->>\'createdAt\' desc')
    ]);
    return {
      users: users.rows.map(row => row.data),
      sessions: sessions.rows.map(row => row.data),
      loginTokens: loginTokens.rows.map(row => row.data),
      events: events.rows.map(row => row.data),
      gifts: gifts.rows.map(row => row.data),
      broadcasts: broadcasts.rows.map(row => row.data)
    };
  }
  try {
    return normalizeDb(JSON.parse(await readFile(dbFile, 'utf8')));
  } catch {
    return { users: [], sessions: [], loginTokens: [], events: [], gifts: [], broadcasts: [] };
  }
}

async function writeDb(db) {
  db = normalizeDb(db);
  if (pgPool) {
    await ensurePgSchema();
    await replacePgDb(db);
    return;
  }
  await mkdir(dataDir, { recursive: true });
  await writeFile(dbFile, JSON.stringify(db, null, 2));
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => {
        const index = item.indexOf('=');
        return [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
      })
  );
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function saveDataUrlImage(dataUrl) {
  const match = String(dataUrl || '').match(/^data:image\/(png|jpe?g|webp);base64,([a-z0-9+/=]+)$/i);
  if (!match) {
    const error = new Error('invalid_image');
    error.status = 400;
    throw error;
  }
  const ext = match[1].toLowerCase().replace('jpeg', 'jpg');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > 6 * 1024 * 1024) {
    const error = new Error('image_too_large');
    error.status = 413;
    throw error;
  }
  await mkdir(uploadsDir, { recursive: true });
  const filename = `${new Date().toISOString().slice(0, 10)}-${uid()}.${ext}`;
  await writeFile(join(uploadsDir, filename), buffer);
  return `/uploads/${filename}`;
}

function send(res, status, data, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}

function methodNotAllowed(res) {
  send(res, 405, { error: 'method_not_allowed' });
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${cookieName}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function currentUser(req, db) {
  const token = parseCookies(req)[cookieName];
  const session = db.sessions.find(item => item.token === token);
  if (!session) return null;
  return db.users.find(user => user.id === session.userId) || null;
}

function requireUser(req, res, db) {
  const user = currentUser(req, db);
  if (!user) send(res, 401, { error: 'unauthorized' });
  return user;
}

function eventPayload(event, db) {
  return {
    ...event,
    gifts: db.gifts.filter(gift => gift.eventId === event.id)
  };
}

function adminOverview(db) {
  const users = db.users.map(user => publicUser(user));
  const events = db.events.map(event => {
    const owner = users.find(user => user.id === event.userId);
    const gifts = db.gifts.filter(gift => gift.eventId === event.id);
    return {
      ...event,
      ownerName: owner?.name || owner?.telegramUsername || owner?.email || '',
      ownerEmail: owner?.email || '',
      giftsCount: gifts.length,
      reservedGiftsCount: gifts.filter(gift => gift.status === 'reserved').length
    };
  });
  return {
    stats: {
      users: users.length,
      events: events.length,
      publishedEvents: events.filter(event => event.status === 'published').length,
      gifts: db.gifts.length,
      reservedGifts: db.gifts.filter(gift => gift.status === 'reserved').length,
      broadcasts: db.broadcasts.length
    },
    users,
    events,
    broadcasts: db.broadcasts
  };
}

async function api(req, res, url) {
  const db = await readDb();
  const path = url.pathname;

  if (path === '/api/admin/overview') {
    if (req.method !== 'GET') return methodNotAllowed(res);
    if (!requireAdmin(req, res, url)) return;
    return send(res, 200, adminOverview(db));
  }

  if (path === '/api/admin/broadcasts') {
    if (!requireAdmin(req, res, url)) return;
    if (req.method === 'GET') return send(res, 200, { broadcasts: db.broadcasts });
    if (req.method !== 'POST') return methodNotAllowed(res);
    const input = await body(req);
    const broadcast = {
      id: uid(),
      title: String(input.title || 'Broadcast'),
      message: String(input.message || ''),
      channel: String(input.channel || 'telegram'),
      audience: String(input.audience || 'all'),
      status: input.sendNow ? 'sent' : String(input.status || 'draft'),
      scheduledAt: String(input.scheduledAt || ''),
      sentAt: input.sendNow ? now() : '',
      createdAt: now(),
      updatedAt: now()
    };
    db.broadcasts.unshift(broadcast);
    await writeDb(db);
    return send(res, 201, { broadcast });
  }

  const adminBroadcastMatch = path.match(/^\/api\/admin\/broadcasts\/([^/]+)$/);
  if (adminBroadcastMatch) {
    if (!requireAdmin(req, res, url)) return;
    const broadcast = db.broadcasts.find(item => item.id === adminBroadcastMatch[1]);
    if (!broadcast) return send(res, 404, { error: 'broadcast_not_found' });
    if (req.method === 'DELETE') {
      db.broadcasts = db.broadcasts.filter(item => item.id !== broadcast.id);
      await writeDb(db);
      return send(res, 200, { ok: true });
    }
    if (req.method !== 'PATCH') return methodNotAllowed(res);
    const input = await body(req);
    assignAllowed(broadcast, input, ['title', 'message', 'channel', 'audience', 'status', 'scheduledAt']);
    if (input.sendNow) {
      broadcast.status = 'sent';
      broadcast.sentAt = broadcast.sentAt || now();
    }
    broadcast.updatedAt = now();
    await writeDb(db);
    return send(res, 200, { broadcast });
  }

  if (path === '/api/auth/me') {
    if (req.method !== 'GET') return methodNotAllowed(res);
    const user = currentUser(req, db);
    if (!user) clearSessionCookie(res);
    return send(res, 200, { user: publicUser(user) });
  }

  if (path === '/api/auth/register') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    const input = await body(req);
    const email = String(input.email || '').trim().toLowerCase();
    const password = String(input.password || '');
    if (!email || password.length < 4) return send(res, 400, { error: 'invalid_credentials' });
    if (db.users.some(user => user.email === email)) return send(res, 409, { error: 'email_exists' });
    const user = {
      id: uid(),
      email,
      passwordHash: hashPassword(password),
      name: String(input.name || '').trim(),
      authProvider: 'email',
      createdAt: now()
    };
    const token = uid();
    db.users.push(user);
    db.sessions.push({ token, userId: user.id, createdAt: now() });
    await writeDb(db);
    setSessionCookie(res, token);
    return send(res, 201, { user: publicUser(user) });
  }

  if (path === '/api/auth/login') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    const input = await body(req);
    const user = db.users.find(item => item.email === String(input.email || '').trim().toLowerCase());
    if (!user || !verifyPassword(String(input.password || ''), user.passwordHash)) return send(res, 401, { error: 'invalid_credentials' });
    const token = uid();
    db.sessions.push({ token, userId: user.id, createdAt: now() });
    await writeDb(db);
    setSessionCookie(res, token);
    return send(res, 200, { user: publicUser(user) });
  }

  if (path === '/api/auth/logout') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    const token = parseCookies(req)[cookieName];
    const nextDb = { ...db, sessions: db.sessions.filter(session => session.token !== token) };
    await writeDb(nextDb);
    clearSessionCookie(res);
    return send(res, 200, { ok: true });
  }

  if (path === '/api/auth/telegram-mini-app') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    try {
      const input = await body(req);
      const telegramUser = validateTelegramInitData(String(input.initData || ''));
      const user = upsertTelegramUser(db, telegramUser);
      if (input.consentAccepted) {
        Object.assign(user, {
          consentPersonalDataAt: user.consentPersonalDataAt || now(),
          consentTermsAt: user.consentTermsAt || now(),
          consentAcceptedAt: user.consentAcceptedAt || now()
        });
      }
      const loginToken = input.telegramLoginToken
        ? db.loginTokens.find(item => item.token === String(input.telegramLoginToken))
        : null;
      if (loginToken && !loginToken.usedAt && new Date(loginToken.expiresAt).getTime() > Date.now()) {
        Object.assign(loginToken, {
          userId: user.id,
          telegramChatId: String(telegramUser.id),
          consentPersonalDataAt: loginToken.consentPersonalDataAt || user.consentPersonalDataAt || now(),
          consentTermsAt: loginToken.consentTermsAt || user.consentTermsAt || now(),
          consentAcceptedAt: loginToken.consentAcceptedAt || user.consentAcceptedAt || now(),
          confirmedAt: loginToken.confirmedAt || now()
        });
      }
      const token = uid();
      db.sessions.push({ token, userId: user.id, createdAt: now() });
      await writeDb(db);
      setSessionCookie(res, token);
      return send(res, 200, { user: publicUser(user) });
    } catch (error) {
      return send(res, 401, { error: error.message || 'telegram_auth_failed' });
    }
  }

  if (path === '/api/auth/telegram-login-token') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    try {
      const input = await body(req);
      let telegramUser = null;
      if (input.initData) {
        try {
          telegramUser = validateTelegramInitData(String(input.initData || ''));
        } catch (error) {
          console.error('telegram_init_data_for_login_token_failed', error.message || error);
        }
      }
      const bot = telegramBotToken ? await getTelegramBotInfo() : null;
      if (!bot?.username) return send(res, 503, { error: 'telegram_bot_not_configured' });
      const token = `${uid()}${uid()}`;
      const loginToken = {
        token,
        userId: '',
        telegramId: telegramUser?.id ? String(telegramUser.id) : '',
        telegramUsername: telegramUser?.username ? `@${telegramUser.username}` : '',
        createdAt: now(),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        confirmedAt: '',
        usedAt: ''
      };
      db.loginTokens = db.loginTokens.filter(item => new Date(item.expiresAt).getTime() > Date.now() && !item.usedAt);
      db.loginTokens.push(loginToken);
      await writeDb(db);
      let directMessageSent = false;
      if (telegramUser?.id) {
        try {
          await sendTelegramLoginRequest(telegramUser.id, token, loginToken);
          directMessageSent = true;
        } catch (error) {
          console.error('telegram_direct_login_request_failed', error.message || error);
        }
      }
      return send(res, 201, {
        token,
        expiresAt: loginToken.expiresAt,
        botLink: `https://t.me/${bot.username}?start=login_${token}`,
        botUsername: bot.username,
        startCommand: `/start login_${token}`,
        directMessageSent
      });
    } catch (error) {
      return send(res, 500, { error: error.message || 'telegram_login_token_failed' });
    }
  }

  const telegramTokenMatch = path.match(/^\/api\/auth\/telegram-login-token\/([^/]+)$/);
  if (telegramTokenMatch) {
    if (req.method !== 'GET') return methodNotAllowed(res);
    const token = telegramTokenMatch[1];
    const loginToken = db.loginTokens.find(item => item.token === token);
    if (!loginToken || loginToken.usedAt) return send(res, 404, { error: 'login_token_not_found' });
    if (new Date(loginToken.expiresAt).getTime() <= Date.now()) {
      db.loginTokens = db.loginTokens.filter(item => item.token !== token);
      await writeDb(db);
      return send(res, 410, { error: 'login_token_expired' });
    }
    if (!loginToken.userId) return send(res, 202, { status: 'pending' });
    const user = db.users.find(item => item.id === loginToken.userId);
    if (!user) return send(res, 404, { error: 'telegram_user_not_found' });
    const sessionToken = uid();
    db.sessions.push({ token: sessionToken, userId: user.id, createdAt: now() });
    db.loginTokens = db.loginTokens.filter(item => item.token !== token);
    await writeDb(db);
    setSessionCookie(res, sessionToken);
    return send(res, 200, { user: publicUser(user) });
  }

  if (path === '/api/telegram/config') {
    if (req.method !== 'GET') return methodNotAllowed(res);
    try {
      const bot = telegramBotToken ? await getTelegramBotInfo() : null;
      return send(res, 200, {
        appUrl,
        botUsername: bot?.username || '',
        botLink: bot?.username ? `https://t.me/${bot.username}?start=povod` : '',
        hasBot: Boolean(bot?.username)
      });
    } catch {
      return send(res, 200, { appUrl, botUsername: '', botLink: '', hasBot: false });
    }
  }

  if (path === '/api/telegram/webhook') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    if (telegramWebhookSecret && !safeCompare(req.headers['x-telegram-bot-api-secret-token'], telegramWebhookSecret)) {
      return send(res, 401, { error: 'invalid_telegram_secret' });
    }
    const update = await body(req);
    const callback = update.callback_query;
    if (callback) {
      const callbackMatch = String(callback.data || '').match(/^confirm_login_([a-f0-9]{40})$/i);
      const callbackChatId = callback.message?.chat?.id || callback.from?.id;
      if (callbackMatch && callbackChatId) {
        const token = callbackMatch[1];
        const loginToken = db.loginTokens.find(item => item.token === token);
        if (!loginToken || loginToken.usedAt || new Date(loginToken.expiresAt).getTime() <= Date.now()) {
          db.loginTokens = db.loginTokens.filter(item => item.token !== token);
          await writeDb(db);
          telegramApi('answerCallbackQuery', {
            callback_query_id: callback.id,
            text: 'Ссылка для входа устарела'
          }).catch(error => console.error(error));
          telegramApi('sendMessage', {
            chat_id: callbackChatId,
            text: 'Ссылка для входа устарела. Вернитесь на сайт и нажмите «Авторизоваться через Telegram» ещё раз.'
          }).catch(error => console.error(error));
          return send(res, 200, { ok: true });
        }
        if (!callback.from?.id) {
          telegramApi('answerCallbackQuery', {
            callback_query_id: callback.id,
            text: 'Не получилось подтвердить Telegram-профиль'
          }).catch(error => console.error(error));
          return send(res, 200, { ok: true });
        }
        const user = upsertTelegramUser(db, callback.from);
        Object.assign(loginToken, {
          userId: user.id,
          telegramChatId: String(callbackChatId),
          consentPersonalDataAt: now(),
          consentTermsAt: now(),
          consentAcceptedAt: now(),
          confirmedAt: now()
        });
        await writeDb(db);
        telegramApi('answerCallbackQuery', {
          callback_query_id: callback.id,
          text: 'Вход подтверждён'
        }).catch(error => console.error(error));
        if (callback.message?.message_id) {
          updateTelegramLoginConfirmed(callbackChatId, callback.message.message_id, token).catch(error => console.error(error));
        } else {
          sendTelegramLoginConfirmed(callbackChatId, token).catch(error => console.error(error));
        }
      }
      return send(res, 200, { ok: true });
    }
    const message = update.message || update.edited_message;
    const chatId = message?.chat?.id;
    const telegramUser = message?.from;
    const text = String(message?.text || '');
    if (chatId && text.startsWith('/start')) {
      const loginMatch = text.match(/^\/start\s+login_([a-f0-9]{40})/i);
      if (loginMatch) {
        const token = loginMatch[1];
        const loginToken = db.loginTokens.find(item => item.token === token);
        if (!loginToken || loginToken.usedAt || new Date(loginToken.expiresAt).getTime() <= Date.now()) {
          db.loginTokens = db.loginTokens.filter(item => item.token !== token);
          await writeDb(db);
          await telegramApi('sendMessage', {
            chat_id: chatId,
            text: 'Ссылка для входа устарела. Вернитесь на сайт и нажмите «Авторизоваться через Telegram» ещё раз.'
          }).catch(error => console.error(error));
          return send(res, 200, { ok: true });
        }
        await sendTelegramLoginRequest(chatId, token, loginToken).catch(error => console.error(error));
        return send(res, 200, { ok: true });
      }
      const telegramId = telegramUser?.id ? String(telegramUser.id) : '';
      const latestUserToken = telegramId ? db.loginTokens
        .filter(item => String(item.telegramId || '') === telegramId && !item.userId && !item.usedAt && new Date(item.expiresAt).getTime() > Date.now())
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] : null;
      if (latestUserToken) {
        await sendTelegramLoginRequest(chatId, latestUserToken.token, latestUserToken).catch(error => console.error(error));
        return send(res, 200, { ok: true });
      }
      await sendTelegramStart(chatId).catch(error => console.error(error));
    }
    return send(res, 200, { ok: true });
  }

  if (path === '/api/telegram/setup-webhook') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    const input = await body(req);
    if (telegramWebhookSecret && !safeCompare(input.secret, telegramWebhookSecret)) return send(res, 401, { error: 'invalid_secret' });
    try {
      await telegramApi('setWebhook', {
        url: `${appUrl}/api/telegram/webhook`,
        secret_token: telegramWebhookSecret || undefined,
        allowed_updates: ['message', 'edited_message', 'callback_query'],
        drop_pending_updates: Boolean(input.dropPendingUpdates)
      });
      await telegramApi('setChatMenuButton', {
        menu_button: {
          type: 'web_app',
          text: 'Открыть Повод',
          web_app: { url: appUrl }
        }
      }).catch(() => null);
      const webhook = await telegramApi('getWebhookInfo');
      return send(res, 200, { ok: true, webhook });
    } catch (error) {
      return send(res, 500, { error: error.message || 'telegram_setup_failed' });
    }
  }

  if (path === '/api/uploads') {
    const user = requireUser(req, res, db);
    if (!user) return;
    if (req.method !== 'POST') return methodNotAllowed(res);
    try {
      const input = await body(req);
      const url = await saveDataUrlImage(input.dataUrl);
      return send(res, 201, { url });
    } catch (error) {
      return send(res, error.status || 500, { error: error.message || 'upload_failed' });
    }
  }

  if (path === '/api/events') {
    const user = requireUser(req, res, db);
    if (!user) return;
    if (req.method === 'GET') return send(res, 200, { events: db.events.filter(event => event.userId === user.id).map(event => eventPayload(event, db)) });
    if (req.method !== 'POST') return methodNotAllowed(res);
    const input = await body(req);
    const event = {
      id: uid(),
      userId: user.id,
      title: String(input.title || ''),
      slug: uniqueSlug(input.title || `povod-${uid().slice(0, 8)}`, db),
      type: String(input.type || ''),
      theme: String(input.theme || 'pink'),
      date: String(input.date || ''),
      time: String(input.time || ''),
      placeName: String(input.placeName || ''),
      address: String(input.address || ''),
      mapUrl: String(input.mapUrl || ''),
      description: String(input.description || ''),
      wishes: String(input.wishes || ''),
      coverImage: String(input.coverImage || ''),
      status: 'draft',
      createdAt: now(),
      updatedAt: now()
    };
    db.events.unshift(event);
    await writeDb(db);
    return send(res, 201, { event: eventPayload(event, db) });
  }

  const eventMatch = path.match(/^\/api\/events\/([^/]+)$/);
  if (eventMatch) {
    const user = requireUser(req, res, db);
    if (!user) return;
    const event = db.events.find(item => item.id === eventMatch[1] && item.userId === user.id);
    if (!event) return send(res, 404, { error: 'event_not_found' });
    if (req.method === 'GET') return send(res, 200, { event: eventPayload(event, db) });
    if (req.method === 'DELETE') {
      db.events = db.events.filter(item => item.id !== event.id);
      db.gifts = db.gifts.filter(gift => gift.eventId !== event.id);
      await writeDb(db);
      return send(res, 200, { ok: true });
    }
    if (req.method !== 'PATCH') return methodNotAllowed(res);
    const input = await body(req);
    assignAllowed(event, input, ['title', 'type', 'theme', 'date', 'time', 'placeName', 'address', 'mapUrl', 'description', 'wishes', 'coverImage']);
    if (Object.hasOwn(input, 'slug')) event.slug = uniqueSlug(input.slug || event.title, db, event.id);
    event.updatedAt = now();
    await writeDb(db);
    return send(res, 200, { event: eventPayload(event, db) });
  }

  const publishMatch = path.match(/^\/api\/events\/([^/]+)\/(publish|unpublish)$/);
  if (publishMatch) {
    const user = requireUser(req, res, db);
    if (!user) return;
    const event = db.events.find(item => item.id === publishMatch[1] && item.userId === user.id);
    if (!event) return send(res, 404, { error: 'event_not_found' });
    if (req.method !== 'POST') return methodNotAllowed(res);
    event.status = publishMatch[2] === 'publish' ? 'published' : 'draft';
    event.updatedAt = now();
    await writeDb(db);
    return send(res, 200, { event: eventPayload(event, db) });
  }

  const eventGiftsMatch = path.match(/^\/api\/events\/([^/]+)\/gifts$/);
  if (eventGiftsMatch) {
    const user = requireUser(req, res, db);
    if (!user) return;
    const event = db.events.find(item => item.id === eventGiftsMatch[1] && item.userId === user.id);
    if (!event) return send(res, 404, { error: 'event_not_found' });
    if (req.method === 'GET') return send(res, 200, { gifts: db.gifts.filter(gift => gift.eventId === event.id) });
    if (req.method !== 'POST') return methodNotAllowed(res);
    const input = await body(req);
    const gift = {
      id: uid(),
      eventId: event.id,
      title: String(input.title || ''),
      description: String(input.description || ''),
      url: String(input.url || ''),
      price: Number(input.price || 0),
      image: String(input.image || ''),
      category: String(input.category || 'Подарок'),
      status: 'available',
      createdAt: now(),
      updatedAt: now()
    };
    db.gifts.unshift(gift);
    await writeDb(db);
    return send(res, 201, { gift });
  }

  const giftMatch = path.match(/^\/api\/gifts\/([^/]+)$/);
  if (giftMatch) {
    const user = requireUser(req, res, db);
    if (!user) return;
    const gift = db.gifts.find(item => item.id === giftMatch[1]);
    const event = gift && db.events.find(item => item.id === gift.eventId && item.userId === user.id);
    if (!gift || !event) return send(res, 404, { error: 'gift_not_found' });
    if (req.method === 'DELETE') {
      db.gifts = db.gifts.filter(item => item.id !== gift.id);
      await writeDb(db);
      return send(res, 200, { ok: true });
    }
    if (req.method !== 'PATCH') return methodNotAllowed(res);
    const input = await body(req);
    assignAllowed(gift, input, ['title', 'description', 'url', 'image', 'category']);
    if (Object.hasOwn(input, 'price')) gift.price = Number(input.price || 0);
    gift.updatedAt = now();
    await writeDb(db);
    return send(res, 200, { gift });
  }

  const unreserveMatch = path.match(/^\/api\/gifts\/([^/]+)\/unreserve$/);
  if (unreserveMatch) {
    const user = requireUser(req, res, db);
    if (!user) return;
    const gift = db.gifts.find(item => item.id === unreserveMatch[1]);
    const event = gift && db.events.find(item => item.id === gift.eventId && item.userId === user.id);
    if (!gift || !event) return send(res, 404, { error: 'gift_not_found' });
    if (req.method !== 'POST') return methodNotAllowed(res);
    Object.assign(gift, { status: 'available', reservedByName: '', reservedByContact: '', reservedComment: '', reservedAt: '', updatedAt: now() });
    await writeDb(db);
    return send(res, 200, { gift });
  }

  const publicEventMatch = path.match(/^\/api\/public\/events\/([^/]+)$/);
  if (publicEventMatch) {
    if (req.method !== 'GET') return methodNotAllowed(res);
    const event = db.events.find(item => item.slug === publicEventMatch[1]);
    if (!event) return send(res, 404, { error: 'event_not_found' });
    return send(res, 200, { event: eventPayload(event, db) });
  }

  const reserveMatch = path.match(/^\/api\/public\/gifts\/([^/]+)\/reserve$/);
  if (reserveMatch) {
    if (req.method !== 'POST') return methodNotAllowed(res);
    if (pgPool) {
      await ensurePgSchema();
      const input = await body(req);
      const row = await pgPool.query('select data from povod_gifts where id = $1', [reserveMatch[1]]);
      const gift = row.rows[0]?.data;
      if (!gift) return send(res, 404, { error: 'gift_not_found' });
      if (gift.status === 'reserved') return send(res, 409, { error: 'gift_already_reserved' });
      const reservedGift = {
        ...gift,
        status: 'reserved',
        reservedByName: String(input.name || 'Гость'),
        reservedByContact: String(input.contact || ''),
        reservedComment: String(input.comment || ''),
        reservedAt: now(),
        updatedAt: now()
      };
      const updated = await pgPool.query(
        "update povod_gifts set data = $2::jsonb where id = $1 and coalesce(data->>'status', 'available') <> 'reserved' returning data",
        [gift.id, JSON.stringify(reservedGift)]
      );
      if (!updated.rowCount) return send(res, 409, { error: 'gift_already_reserved' });
      return send(res, 200, { gift: updated.rows[0].data });
    }
    const gift = db.gifts.find(item => item.id === reserveMatch[1]);
    if (!gift) return send(res, 404, { error: 'gift_not_found' });
    if (gift.status === 'reserved') return send(res, 409, { error: 'gift_already_reserved' });
    const input = await body(req);
    Object.assign(gift, {
      status: 'reserved',
      reservedByName: String(input.name || 'Гость'),
      reservedByContact: String(input.contact || ''),
      reservedComment: String(input.comment || ''),
      reservedAt: now(),
      updatedAt: now()
    });
    await writeDb(db);
    return send(res, 200, { gift });
  }

  send(res, 404, { error: 'not_found' });
}

async function staticFile(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith('/uploads/')) {
    const normalizedUpload = normalize(pathname.replace(/^\/uploads\//, '')).replace(/^[/\\]+/, '').replace(/^(\.\.[/\\])+/, '');
    const uploadPath = join(uploadsDir, normalizedUpload);
    try {
      const info = await stat(uploadPath);
      if (!info.isFile()) return send(res, 404, { error: 'upload_not_found' });
      const stream = createReadStream(uploadPath);
      stream.on('error', error => {
        console.error(error);
        if (!res.headersSent) send(res, 500, { error: 'upload_file_error' });
      });
      res.writeHead(200, { 'content-type': mime[extname(uploadPath)] || 'application/octet-stream' });
      stream.pipe(res);
      return;
    } catch {
      return send(res, 404, { error: 'upload_not_found' });
    }
  }
  if (pathname === '/') pathname = 'index.html';
  const normalized = normalize(pathname).replace(/^[/\\]+/, '').replace(/^(\.\.[/\\])+/, '');
  const filePath = join(root, normalized);
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return await serveSpa(res);
    const stream = createReadStream(filePath);
    stream.on('error', error => {
      console.error(error);
      if (!res.headersSent) send(res, 500, { error: 'static_file_error' });
    });
    res.writeHead(200, { 'content-type': mime[extname(filePath)] || 'application/octet-stream' });
    stream.pipe(res);
  } catch {
    await serveSpa(res);
  }
}

async function serveSpa(res) {
  const html = await readFile(join(root, 'index.html'));
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return await staticFile(req, res, url);
  } catch (error) {
    console.error(error);
    send(res, 500, { error: 'server_error' });
  }
}).listen(port, host, () => {
  console.log(`Повод server running on http://${host}:${port}`);
});
