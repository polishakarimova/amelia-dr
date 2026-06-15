import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHmac, createHash, randomBytes, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';

const root = fileURLToPath(new URL('.', import.meta.url));
const execFileAsync = promisify(execFile);

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
const giftPreviewProxyUrl = process.env.GIFT_PREVIEW_PROXY_URL || '';
const ozonPreviewProxyUrl = process.env.OZON_PREVIEW_PROXY_URL || giftPreviewProxyUrl;
const scrapingBeeApiKey = process.env.SCRAPINGBEE_API_KEY || '';
const zenRowsApiKey = process.env.ZENROWS_API_KEY || '';
const scraperApiKey = process.env.SCRAPERAPI_KEY || '';
const productPreviewCacheTtlMs = Math.max(1, Number(process.env.PRODUCT_PREVIEW_CACHE_TTL_HOURS || 24)) * 60 * 60 * 1000;
const productPreviewInflight = new Map();
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
    create table if not exists povod_product_previews (
      cache_key text primary key,
      source text not null default '',
      data jsonb not null,
      updated_at text not null
    );
    create index if not exists povod_events_user_id_idx on povod_events (user_id);
    create index if not exists povod_gifts_event_id_idx on povod_gifts (event_id);
    create index if not exists povod_broadcasts_status_idx on povod_broadcasts (status);
    create index if not exists povod_product_previews_updated_at_idx on povod_product_previews (updated_at);
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
    broadcasts: Array.isArray(db.broadcasts) ? db.broadcasts : [],
    productPreviews: Array.isArray(db.productPreviews) ? db.productPreviews : []
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
    for (const productPreview of db.productPreviews) {
      const cacheKey = productPreview.cacheKey || productPreview.key;
      if (!cacheKey) continue;
      await client.query(
        `insert into povod_product_previews (cache_key, source, data, updated_at)
         values ($1, $2, $3::jsonb, $4)
         on conflict (cache_key) do update set source = excluded.source, data = excluded.data, updated_at = excluded.updated_at`,
        [
          cacheKey,
          productPreview.source || productPreview.preview?.source || '',
          JSON.stringify(productPreview),
          productPreview.updatedAt || productPreview.cachedAt || now()
        ]
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

function validateTelegramWidgetUser(input) {
  if (!telegramBotToken) throw new Error('telegram_bot_token_missing');
  const receivedHash = String(input.hash || '');
  if (!receivedHash) throw new Error('telegram_hash_missing');
  const data = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (key === 'hash' || value === undefined || value === null || value === '') continue;
    data[key] = String(value);
  }
  const dataCheckString = Object.entries(data)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHash('sha256').update(telegramBotToken).digest();
  const calculatedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (!safeCompare(calculatedHash, receivedHash)) throw new Error('telegram_hash_invalid');
  const authDate = Number(data.auth_date || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400 * 7) throw new Error('telegram_auth_expired');
  if (!data.id) throw new Error('telegram_user_missing');
  return {
    id: data.id,
    first_name: data.first_name || '',
    last_name: data.last_name || '',
    username: data.username || '',
    photo_url: data.photo_url || '',
    auth_date: authDate
  };
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
        { text: 'Вернуться на сайт', url: returnUrl }
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
        { text: 'Вернуться на сайт', url: returnUrl }
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

async function confirmTelegramLoginToken(db, loginToken, telegramUser, chatId) {
  const user = upsertTelegramUser(db, telegramUser);
  Object.assign(loginToken, {
    userId: user.id,
    telegramChatId: String(chatId),
    consentPersonalDataAt: loginToken.consentPersonalDataAt || user.consentPersonalDataAt || now(),
    consentTermsAt: loginToken.consentTermsAt || user.consentTermsAt || now(),
    consentAcceptedAt: loginToken.consentAcceptedAt || user.consentAcceptedAt || now(),
    confirmedAt: loginToken.confirmedAt || now()
  });
  Object.assign(user, {
    consentPersonalDataAt: user.consentPersonalDataAt || loginToken.consentPersonalDataAt || now(),
    consentTermsAt: user.consentTermsAt || loginToken.consentTermsAt || now(),
    consentAcceptedAt: user.consentAcceptedAt || loginToken.consentAcceptedAt || now()
  });
  await writeDb(db);
  await sendTelegramLoginConfirmed(chatId, loginToken.token).catch(error => console.error(error));
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
    return normalizeDb({});
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

function decodeHtml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseProductUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    const error = new Error('invalid_product_url');
    error.status = 400;
    throw error;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const error = new Error('unsupported_product_url');
    error.status = 400;
    throw error;
  }
  return parsed;
}

function isWildberriesHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'wildberries.ru' || host.endsWith('.wildberries.ru') || host === 'wb.ru' || host.endsWith('.wb.ru');
}

function isWildberriesUrlText(rawUrl) {
  try {
    return isWildberriesHost(parseProductUrl(rawUrl).hostname);
  } catch {
    return false;
  }
}

function isOzonHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'ozon.ru'
    || host.endsWith('.ozon.ru')
    || host === 'ozon.by'
    || host.endsWith('.ozon.by')
    || host === 'ozon.onelink.me'
    || host.endsWith('.ozon.onelink.me');
}

function isDetmirHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'detmir.ru'
    || host.endsWith('.detmir.ru')
    || host === 'detmir.kz'
    || host.endsWith('.detmir.kz')
    || host === 'detmir.by'
    || host.endsWith('.detmir.by');
}

function isOzonUrlText(rawUrl) {
  try {
    return isOzonHost(parseProductUrl(rawUrl).hostname);
  } catch {
    return false;
  }
}

function isDetmirUrlText(rawUrl) {
  try {
    return isDetmirHost(parseProductUrl(rawUrl).hostname);
  } catch {
    return false;
  }
}

function isSupportedGiftStoreUrlText(rawUrl) {
  return isWildberriesUrlText(rawUrl) || isOzonUrlText(rawUrl) || isDetmirUrlText(rawUrl);
}

function wildberriesProductIdFromUrl(rawUrl) {
  const text = String(rawUrl || '');
  return (
    text.match(/\/catalog\/(\d+)\//i)?.[1] ||
    text.match(/[?&](?:nm|card|imt|product)=(\d+)/i)?.[1] ||
    text.match(/\/(\d+)\/detail\.aspx/i)?.[1] ||
    ''
  );
}

function ozonProductIdFromUrl(rawUrl) {
  const text = String(rawUrl || '');
  return (
    text.match(/\/context\/detail\/id\/(\d+)/i)?.[1] ||
    text.match(/\/product\/(?:[^/?#]*-)?(\d+)(?:[/?#]|$)/i)?.[1] ||
    text.match(/[?&](?:product_id|productId|sku)=(\d+)/i)?.[1] ||
    ''
  );
}

function detmirProductIdFromUrl(rawUrl) {
  const text = String(rawUrl || '');
  return (
    text.match(/\/product\/index\/id\/(\d+)/i)?.[1] ||
    text.match(/[?&](?:id|productId|product_id)=(\d+)/i)?.[1] ||
    ''
  );
}

function normalizedProductHref(productUrl) {
  const url = new URL(productUrl.href);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|yclid|gclid|fbclid|from|at|ref|referer|src|spm|sh)$/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, '/') || '/';
  return url.href;
}

function productPreviewCacheKey(productUrl) {
  if (isWildberriesHost(productUrl.hostname)) {
    const id = wildberriesProductIdFromUrl(productUrl.href);
    return `wildberries:${id || normalizedProductHref(productUrl)}`;
  }
  if (isOzonHost(productUrl.hostname)) {
    const id = ozonProductIdFromUrl(productUrl.href);
    return `ozon:${id || normalizedProductHref(productUrl)}`;
  }
  if (isDetmirHost(productUrl.hostname)) {
    const id = detmirProductIdFromUrl(productUrl.href);
    return `detmir:${id || normalizedProductHref(productUrl)}`;
  }
  return `page:${normalizedProductHref(productUrl)}`;
}

function isProbablyProductUrl(productUrl) {
  if (isWildberriesHost(productUrl.hostname)) return Boolean(wildberriesProductIdFromUrl(productUrl.href));
  if (isOzonHost(productUrl.hostname)) return Boolean(ozonProductIdFromUrl(productUrl.href)) || productUrl.hostname.toLowerCase().includes('onelink');
  if (isDetmirHost(productUrl.hostname)) return /\/product\//i.test(productUrl.pathname);
  return true;
}

function wildberriesBasketHost(productId) {
  const vol = Math.floor(Number(productId) / 100000);
  const ranges = [
    [143, '01'], [287, '02'], [431, '03'], [719, '04'], [1007, '05'],
    [1061, '06'], [1115, '07'], [1169, '08'], [1313, '09'], [1601, '10'],
    [1655, '11'], [1919, '12'], [2045, '13'], [2189, '14'], [2405, '15']
  ];
  const basket = ranges.find(([max]) => vol <= max)?.[1]
    || String(Math.min(99, Math.max(16, Math.floor((vol - 2406) / 218) + 16))).padStart(2, '0');
  return `basket-${basket}.wbbasket.ru`;
}

function wildberriesImageUrl(productId, index = 1) {
  const id = Number(productId);
  const vol = Math.floor(id / 100000);
  const part = Math.floor(id / 1000);
  return `https://${wildberriesBasketHost(id)}/vol${vol}/part${part}/${id}/images/big/${index}.webp`;
}

function wildberriesImageUrlForBasket(productId, basket, index = 1) {
  const id = Number(productId);
  const vol = Math.floor(id / 100000);
  const part = Math.floor(id / 1000);
  return `https://basket-${basket}.wbbasket.ru/vol${vol}/part${part}/${id}/images/big/${index}.webp`;
}

function wildberriesBasketNumber(productId) {
  return Number(wildberriesBasketHost(productId).match(/basket-(\d+)/)?.[1] || 16);
}

function wildberriesImageCandidates(productId) {
  const base = wildberriesBasketNumber(productId);
  return [...new Set([base, base - 1, base + 1, base - 2, base + 2]
    .filter(value => value >= 1 && value <= 99)
    .map(value => String(value).padStart(2, '0')))]
    .map(basket => wildberriesImageUrlForBasket(productId, basket));
}

async function imageUrlExists(url) {
  try {
    const response = await fetchWithTimeout(url, { method: 'HEAD', headers: { accept: 'image/webp,image/*,*/*' } }, 2500);
    const contentType = String(response.headers.get('content-type') || '');
    return response.ok && (!contentType || contentType.startsWith('image/'));
  } catch {
    return false;
  }
}

async function resolveWildberriesImageUrl(productId) {
  for (const url of wildberriesImageCandidates(productId)) {
    if (await imageUrlExists(url)) return url;
  }
  return wildberriesImageUrl(productId);
}

function wildberriesPrice(product) {
  const values = [
    product?.salePriceU,
    product?.priceU,
    product?.sizes?.[0]?.price?.total,
    product?.sizes?.[0]?.price?.product,
    product?.sizes?.[0]?.price?.basic
  ];
  const raw = values.find(value => Number(value) > 0);
  return raw ? Math.round(Number(raw) / 100) : 0;
}

function normalizeWildberriesProduct(product, productId) {
  const id = String(product?.id || productId || '');
  const title = decodeHtml([product?.brand, product?.name].filter(Boolean).join(' ')) || `Товар Wildberries ${id}`;
  const image = product?.pics ? wildberriesImageUrl(id) : (product?.image || wildberriesImageUrl(id));
  return {
    source: 'wildberries',
    productId: id,
    title,
    price: wildberriesPrice(product),
    image,
    description: '',
    url: `https://www.wildberries.ru/catalog/${id}/detail.aspx`
  };
}

async function wildberriesProductPreview(product, productId) {
  const preview = normalizeWildberriesProduct(product, productId);
  if (preview.productId) preview.image = await resolveWildberriesImageUrl(preview.productId);
  return preview;
}

function isWildberriesRequest(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return host === 'wildberries.ru'
      || host.endsWith('.wildberries.ru')
      || host === 'wb.ru'
      || host.endsWith('.wb.ru')
      || host.endsWith('.wb.ru')
      || host.endsWith('.wbbasket.ru');
  } catch {
    return false;
  }
}

function isOzonRequest(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return host === 'ozon.ru'
      || host.endsWith('.ozon.ru')
      || host === 'ozon.by'
      || host.endsWith('.ozon.by')
      || host === 'ozon.onelink.me'
      || host.endsWith('.ozon.onelink.me')
      || host.endsWith('.ozone.ru')
      || host.endsWith('.ozonusercontent.com');
  } catch {
    return false;
  }
}

function isDetmirRequest(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return host === 'detmir.ru'
      || host.endsWith('.detmir.ru')
      || host === 'detmir.kz'
      || host.endsWith('.detmir.kz')
      || host === 'detmir.by'
      || host.endsWith('.detmir.by')
      || host === 'catalog-cdn.detmir.st'
      || host.endsWith('.detmir.st');
  } catch {
    return false;
  }
}

function isMarketplaceRequest(url) {
  return isWildberriesRequest(url) || isOzonRequest(url) || isDetmirRequest(url);
}

async function fetchWithCurl(url, options = {}, timeoutMs = 8000) {
  const ozonRequest = isOzonRequest(url);
  const referer = isOzonRequest(url)
    ? 'https://www.ozon.ru/'
    : (isWildberriesRequest(url) ? 'https://www.wildberries.ru/' : (isDetmirRequest(url) ? 'https://www.detmir.ru/' : ''));
  const args = [
    '-L',
    '-sS',
    '--max-redirs', ozonRequest ? '10' : '50',
    '--max-time', String(Math.max(2, Math.ceil(timeoutMs / 1000))),
    '-A', 'Mozilla/5.0',
    '-H', `accept: ${options.headers?.accept || 'application/json,text/html;q=0.9,*/*;q=0.8'}`
  ];
  if (ozonRequest) {
    const cookieJar = join(root, '.ozon-curl-cookies');
    args.push('-c', cookieJar, '-b', cookieJar, '-H', 'accept-language: ru-RU,ru;q=0.9,en;q=0.8');
  }
  if (referer) args.push('-H', `referer: ${referer}`);
  if (String(options.method || 'GET').toUpperCase() === 'HEAD') args.push('-I');
  args.push('-w', '\n__POVOD_HTTP_STATUS__:%{http_code}', String(url));
  let stdout;
  try {
    ({ stdout } = await execFileAsync('curl', args, { maxBuffer: 12 * 1024 * 1024, windowsHide: true }));
  } catch (error) {
    if (ozonRequest) error.status = 422;
    throw error;
  }
  const marker = '\n__POVOD_HTTP_STATUS__:';
  const markerIndex = stdout.lastIndexOf(marker);
  const text = markerIndex >= 0 ? stdout.slice(0, markerIndex) : stdout;
  const status = markerIndex >= 0 ? Number(stdout.slice(markerIndex + marker.length).trim()) : 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => '' },
    text: async () => text,
    json: async () => JSON.parse(text)
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const referer = isOzonRequest(url)
    ? 'https://www.ozon.ru/'
    : (isWildberriesRequest(url) ? 'https://www.wildberries.ru/' : (isDetmirRequest(url) ? 'https://www.detmir.ru/' : ''));
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
        ...(referer ? { referer } : {}),
        ...(options.headers || {})
      }
    });
    if (isMarketplaceRequest(url) && [403, 429, 498].includes(response.status)) {
      return await fetchWithCurl(url, options, timeoutMs);
    }
    return response;
  } catch (error) {
    if (isMarketplaceRequest(url)) return await fetchWithCurl(url, options, timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWildberriesApi(productId) {
  const apiUrl = new URL('https://card.wb.ru/cards/v4/detail');
  apiUrl.searchParams.set('appType', '1');
  apiUrl.searchParams.set('curr', 'rub');
  apiUrl.searchParams.set('dest', '-1257786');
  apiUrl.searchParams.set('spp', '30');
  apiUrl.searchParams.set('nm', productId);
  const response = await fetchWithTimeout(apiUrl);
  if (!response.ok) throw new Error(`wildberries_api_${response.status}`);
  const data = await response.json();
  const product = data?.products?.[0] || data?.data?.products?.[0];
  if (!product) throw new Error('wildberries_product_not_found');
  return wildberriesProductPreview(product, productId);
}

async function searchWildberriesProduct(productId) {
  const apiUrl = new URL('https://search.wb.ru/exactmatch/ru/common/v18/search');
  apiUrl.searchParams.set('appType', '1');
  apiUrl.searchParams.set('curr', 'rub');
  apiUrl.searchParams.set('dest', '-1257786');
  apiUrl.searchParams.set('page', '1');
  apiUrl.searchParams.set('query', productId);
  apiUrl.searchParams.set('resultset', 'catalog');
  apiUrl.searchParams.set('sort', 'popular');
  apiUrl.searchParams.set('spp', '30');
  const response = await fetchWithTimeout(apiUrl);
  if (!response.ok) throw new Error(`wildberries_search_${response.status}`);
  const data = await response.json();
  const products = data?.data?.products || data?.products || [];
  const product = products.find(item => String(item?.id) === String(productId)) || products[0];
  if (!product) throw new Error('wildberries_search_not_found');
  return wildberriesProductPreview(product, productId);
}

function metaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["'][^>]*>`, 'i')
  ];
  return decodeHtml(patterns.map(pattern => html.match(pattern)?.[1]).find(Boolean) || '');
}

function parsePriceValue(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  const text = decodeHtml(String(value)).replace(/\u00a0/g, ' ');
  const explicit = text.match(/(\d[\d\s.,]{0,12})\s*(?:₽|руб|р\.?)/i)?.[1];
  const plain = text.match(/^\s*(\d[\d\s.,]{0,12})\s*$/)?.[1];
  const candidate = explicit || plain || '';
  const normalized = candidate.replace(/\s/g, '').replace(',', '.');
  const price = Number(normalized);
  return Number.isFinite(price) && price > 0 ? Math.round(price) : 0;
}

function resolveUrlMaybe(value, baseUrl) {
  const raw = decodeHtml(String(value || '')).replace(/\\\//g, '/').trim();
  if (!raw) return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return '';
  }
}

function imageFromStructuredValue(value, baseUrl) {
  if (!value) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const image = imageFromStructuredValue(item, baseUrl);
      if (image) return image;
    }
    return '';
  }
  if (typeof value === 'object') {
    return imageFromStructuredValue(value.url || value.contentUrl || value.src || value.image, baseUrl);
  }
  const url = resolveUrlMaybe(value, baseUrl);
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const looksLikeImage = /\.(?:jpg|jpeg|png|webp)(?:[?#].*)?$/i.test(url)
      || host.endsWith('.wbbasket.ru')
      || host === 'ir.ozone.ru'
      || host.endsWith('.ozone.ru') && path.includes('/s3/')
      || host.includes('ozon') && /(?:image|multimedia|photo|img)/i.test(path)
      || host === 'catalog-cdn.detmir.st'
      || host === 'img.detmir.st'
      || host.endsWith('.detmir.st') && /(?:media|images|img)/i.test(path);
    return looksLikeImage ? url : '';
  } catch {
    return '';
  }
}

function firstProductSchema(value) {
  const stack = [value];
  const seen = new Set();
  while (stack.length) {
    const item = stack.shift();
    if (!item || typeof item !== 'object') continue;
    if (seen.has(item)) continue;
    seen.add(item);
    const type = item['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.some(entry => String(entry || '').toLowerCase() === 'product')) return item;
    if (Array.isArray(item)) {
      stack.push(...item);
    } else {
      stack.push(...Object.values(item));
    }
  }
  return null;
}

function priceFromOffer(offer) {
  if (!offer) return 0;
  if (Array.isArray(offer)) {
    for (const item of offer) {
      const price = priceFromOffer(item);
      if (price) return price;
    }
    return 0;
  }
  if (typeof offer !== 'object') return parsePriceValue(offer);
  return parsePriceValue(offer.price)
    || parsePriceValue(offer.lowPrice)
    || parsePriceValue(offer.highPrice)
    || parsePriceValue(offer.priceSpecification?.price)
    || parsePriceValue(offer.priceSpecification?.minPrice);
}

function productSchemaPreview(value, baseUrl) {
  const product = firstProductSchema(value);
  if (!product) return {};
  return {
    title: decodeHtml(product.name || product.title || ''),
    price: priceFromOffer(product.offers || product.price),
    image: imageFromStructuredValue(product.image || product.images || product.photo, baseUrl),
    description: decodeHtml(product.description || '')
  };
}

function jsonLdPreview(html, baseUrl) {
  const scripts = html.matchAll(/<script[^>]+type=["'][^"']*application\/ld\+json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    const text = decodeHtml(script[1] || '').replace(/^\s*<!--|-->\s*$/g, '').trim();
    if (!text) continue;
    try {
      const preview = productSchemaPreview(JSON.parse(text), baseUrl);
      if (preview.title || preview.image || preview.price) return preview;
    } catch {
      continue;
    }
  }
  return {};
}

function priceFromHtml(html) {
  const candidates = [
    html.match(/"price"\s*:\s*"?(\d{2,8})(?:[.,]\d+)?/i)?.[1],
    html.match(/"finalPrice"\s*:\s*"?(\d{2,8})(?:[.,]\d+)?/i)?.[1],
    html.match(/(\d[\d\s.,]{1,12})\s*₽/i)?.[1]
  ];
  return candidates.map(parsePriceValue).find(Boolean) || 0;
}

function cleanMarketplaceTitle(title) {
  return decodeHtml(title)
    .replace(/\s*\|\s*Wildberries.*$/i, '')
    .replace(/\s*\|\s*Ozon.*$/i, '')
    .replace(/\s*\|\s*OZON.*$/i, '')
    .replace(/\s*[—-]\s*купить.*$/i, '')
    .trim();
}

function textFromHtmlFragment(value) {
  return decodeHtml(String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function parseNestedJson(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || !['{', '['].includes(text[0])) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectOzonJsonPreview(data, baseUrl) {
  const schema = productSchemaPreview(data, baseUrl);
  const result = { ...schema };
  const titles = [];
  const prices = [];
  const images = [];
  const stack = [data];
  const seen = new Set();
  while (stack.length) {
    const item = stack.shift();
    if (!item) continue;
    if (typeof item === 'string') {
      const nested = parseNestedJson(item);
      if (nested) stack.push(nested);
      if (!result.image && /(?:ozone|ozon).*?\.(?:jpg|jpeg|png|webp)/i.test(item)) {
        const image = imageFromStructuredValue(item, baseUrl);
        if (image) images.push(image);
      }
      if (/[₽]|руб/i.test(item)) {
        const price = parsePriceValue(item);
        if (price) prices.push(price);
      }
      continue;
    }
    if (typeof item !== 'object') continue;
    if (seen.has(item)) continue;
    seen.add(item);
    for (const [key, value] of Object.entries(item)) {
      const name = key.toLowerCase();
      if ((name === 'title' || name === 'name' || name === 'productname') && typeof value === 'string') {
        const title = cleanMarketplaceTitle(value);
        if (title.length >= 4 && title.length <= 180 && !/^ozon$/i.test(title)) titles.push(title);
      }
      if (name.includes('image') || name === 'src' || name === 'url') {
        const image = imageFromStructuredValue(value, baseUrl);
        if (image) images.push(image);
      }
      if (name.includes('price')) {
        const price = parsePriceValue(value);
        if (price) prices.push(price);
      }
      stack.push(value);
    }
  }
  return {
    title: result.title || titles.find(Boolean) || '',
    price: result.price || prices.find(Boolean) || 0,
    image: result.image || images.find(Boolean) || '',
    description: result.description || ''
  };
}

function ozonPreviewBlockedError() {
  const error = new Error('ozon_preview_blocked');
  error.status = 422;
  return error;
}

function isOzonChallengePayload(data) {
  return Boolean(data?.challengeURL || data?.incidentId || data?.blockURL);
}

function isOzonChallengeTitle(title) {
  return /captcha|капч|нет соединения|подтвердите|включите javascript/i.test(String(title || ''));
}

function isOzonChallengeImage(image) {
  return /abt-challenge|captcha|challenge|warn\.png/i.test(String(image || ''));
}

function giftPreviewProxyRequestUrl(proxyUrl, productUrl) {
  const template = String(proxyUrl || '').trim();
  if (!template) return '';
  if (template.includes('{url}')) return template.replaceAll('{url}', encodeURIComponent(productUrl.href));
  const requestUrl = new URL(template);
  if (!requestUrl.searchParams.has('url')) requestUrl.searchParams.set('url', productUrl.href);
  return requestUrl.href;
}

function normalizeExternalGiftPreview(data, productUrl, source) {
  const payload = data?.preview || data?.product || data?.result || data?.data || data || {};
  const nestedImage = payload.image?.url || payload.imageUrl || payload.picture || payload.photo || payload.thumbnail;
  const listImage = Array.isArray(payload.images) ? payload.images.map(item => item?.url || item).find(Boolean) : '';
  const title = cleanMarketplaceTitle(payload.title || payload.name || payload.productName || payload.heading || '');
  const price = parsePriceValue(payload.price || payload.priceValue || payload.amount || payload.offers?.price || payload.offer?.price);
  const image = imageFromStructuredValue(nestedImage || listImage, productUrl.href);
  return {
    source,
    title,
    price,
    image,
    description: decodeHtml(payload.description || payload.subtitle || ''),
    url: productUrl.href
  };
}

async function fetchExternalGiftPreview(proxyUrl, productUrl, source = 'external-preview') {
  const requestUrl = giftPreviewProxyRequestUrl(proxyUrl, productUrl);
  if (!requestUrl) throw new Error('gift_preview_proxy_not_configured');
  const response = await fetchWithTimeout(requestUrl, {
    headers: { accept: 'application/json,text/plain;q=0.9,*/*;q=0.8' }
  }, 50000);
  if (!response.ok) throw new Error(`gift_preview_proxy_${response.status}`);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  const preview = data
    ? normalizeExternalGiftPreview(data, productUrl, source)
    : previewFromHtml(text, productUrl, source);
  if (isOzonHost(productUrl.hostname) && (isOzonChallengeTitle(preview.title) || isOzonChallengeImage(preview.image))) {
    throw ozonPreviewBlockedError();
  }
  if (!preview.title && !preview.image && !preview.price) {
    const error = new Error('gift_preview_proxy_empty');
    error.status = 422;
    throw error;
  }
  return preview;
}

function ozonScrapingProviderUrls(productUrl) {
  const urls = [];
  if (scrapingBeeApiKey) {
    const url = new URL('https://app.scrapingbee.com/api/v1/');
    url.searchParams.set('api_key', scrapingBeeApiKey);
    url.searchParams.set('url', productUrl.href);
    url.searchParams.set('render_js', 'false');
    url.searchParams.set('stealth_proxy', 'true');
    url.searchParams.set('country_code', 'ru');
    url.searchParams.set('block_resources', 'false');
    urls.push({ url: url.href, source: 'scrapingbee' });
  }
  if (zenRowsApiKey) {
    const url = new URL('https://api.zenrows.com/v1/');
    url.searchParams.set('apikey', zenRowsApiKey);
    url.searchParams.set('url', productUrl.href);
    url.searchParams.set('js_render', 'true');
    url.searchParams.set('premium_proxy', 'true');
    url.searchParams.set('proxy_country', 'ru');
    urls.push({ url: url.href, source: 'zenrows' });
  }
  if (scraperApiKey) {
    const url = new URL('https://api.scraperapi.com/');
    url.searchParams.set('api_key', scraperApiKey);
    url.searchParams.set('url', productUrl.href);
    url.searchParams.set('render', 'true');
    url.searchParams.set('premium', 'true');
    url.searchParams.set('country_code', 'ru');
    urls.push({ url: url.href, source: 'scraperapi' });
  }
  return urls;
}

async function fetchOzonScrapingProviderPreview(productUrl) {
  let lastError = null;
  for (const provider of ozonScrapingProviderUrls(productUrl)) {
    try {
      return await fetchExternalGiftPreview(provider.url, productUrl, provider.source);
    } catch (error) {
      lastError = error;
      console.error(`${provider.source}_ozon_preview_failed`, error.message || error);
    }
  }
  if (lastError) throw lastError;
  throw new Error('ozon_scraping_provider_not_configured');
}

function ozonHtmlPreview(html, productUrl, source = 'ozon-html') {
  const titleMatches = [...html.matchAll(/<p[^>]+class=["'][^"']*pdp_eb5[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi)];
  for (const titleMatch of titleMatches) {
    const title = cleanMarketplaceTitle(textFromHtmlFragment(titleMatch[1]));
    if (!title || /^ozon$/i.test(title)) continue;
    const start = Math.max(0, titleMatch.index - 3000);
    const end = Math.min(html.length, titleMatch.index + 3000);
    const block = html.slice(start, end);
    const priceText = textFromHtmlFragment(block.match(/<span[^>]+class=["'][^"']*pdp_eb4[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || '');
    const price = parsePriceValue(priceText) || parsePriceValue(block.match(/\d[\d\s., ]{2,12}\s*(?:₽|руб)/i)?.[0] || '');
    const imageCandidates = [];
    for (const tag of block.matchAll(/<img[^>]+>/gi)) {
      const attrs = tag[0];
      for (const attr of attrs.matchAll(/\b(?:src|srcset)=["']([^"']+)["']/gi)) {
        for (const part of String(attr[1] || '').split(/\s*,\s*/)) {
          const url = part.trim().split(/\s+/)[0];
          const image = imageFromStructuredValue(url, productUrl.href);
          if (image && !/\/cms\/|logo|favicon|sprite/i.test(image)) imageCandidates.push(image);
        }
      }
    }
    const image = imageCandidates.find(item => /\/wc(?:400|500|1000)\//i.test(item))
      || imageCandidates.find(Boolean)
      || '';
    if (title && (price || image)) {
      return {
        source,
        title,
        price: Math.round(price || 0),
        image,
        description: '',
        url: productUrl.href
      };
    }
  }
  return {};
}

function previewFromHtml(html, productUrl, source = 'page-meta') {
  if (isOzonHost(productUrl.hostname)) {
    const ozonPreview = ozonHtmlPreview(html, productUrl, source);
    if (ozonPreview.title || ozonPreview.image || ozonPreview.price) return ozonPreview;
  }
  const structured = jsonLdPreview(html, productUrl.href);
  const title = structured.title
    || metaContent(html, 'og:title')
    || metaContent(html, 'twitter:title')
    || decodeHtml(html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1] || '');
  const image = structured.image || metaContent(html, 'og:image') || metaContent(html, 'twitter:image');
  const price = structured.price
    || parsePriceValue(metaContent(html, 'product:price:amount'))
    || parsePriceValue(metaContent(html, 'og:price:amount'))
    || priceFromHtml(html);
  const preview = {
    source,
    title: cleanMarketplaceTitle(title),
    price: Math.round(price),
    image,
    description: structured.description || metaContent(html, 'og:description') || '',
    url: productUrl.href
  };
  if (isOzonHost(productUrl.hostname) && (isOzonChallengeTitle(preview.title) || isOzonChallengeImage(preview.image))) {
    throw ozonPreviewBlockedError();
  }
  return preview;
}

async function fetchOzonApiPreview(productUrl) {
  const apiUrl = new URL('https://www.ozon.ru/api/entrypoint-api.bx/page/json/v2');
  apiUrl.searchParams.set('url', `${productUrl.pathname}${productUrl.search}`);
  const response = await fetchWithTimeout(apiUrl.href, {
    headers: {
      accept: 'application/json,text/plain,*/*',
      referer: productUrl.href
    }
  }, 12000);
  if ([403, 429, 498].includes(response.status)) throw ozonPreviewBlockedError();
  if (!response.ok) throw new Error(`ozon_api_${response.status}`);
  const data = await response.json();
  if (isOzonChallengePayload(data)) throw ozonPreviewBlockedError();
  const preview = collectOzonJsonPreview(data, productUrl.href);
  if (!preview.title && !preview.image) throw new Error('ozon_api_preview_not_found');
  return {
    source: 'ozon',
    title: cleanMarketplaceTitle(preview.title) || 'Товар Ozon',
    price: preview.price,
    image: preview.image,
    description: '',
    url: productUrl.href
  };
}

async function fetchPageMetadata(productUrl) {
  const response = await fetchWithTimeout(productUrl.href);
  if (!response.ok) throw new Error(`product_page_${response.status}`);
  const html = await response.text();
  return previewFromHtml(html, productUrl, 'page-meta');
}

async function fetchOzonPreview(productUrl) {
  if (ozonPreviewProxyUrl) {
    try {
      return await fetchExternalGiftPreview(ozonPreviewProxyUrl, productUrl, 'ozon-preview-proxy');
    } catch (error) {
      console.error('ozon_proxy_preview_failed', error.message || error);
    }
  }
  if (scrapingBeeApiKey || zenRowsApiKey || scraperApiKey) {
    try {
      return await fetchOzonScrapingProviderPreview(productUrl);
    } catch (error) {
      console.error('ozon_scraping_provider_preview_failed', error.message || error);
    }
  }
  try {
    return await fetchOzonApiPreview(productUrl);
  } catch (error) {
    console.error('ozon_api_preview_failed', error.message || error);
    if (error.status === 422) throw error;
  }
  let preview;
  try {
    preview = await fetchPageMetadata(productUrl);
  } catch (error) {
    if (/product_page_(403|429|498)/.test(error.message || '')) throw ozonPreviewBlockedError();
    if (!error.status) error.status = 422;
    throw error;
  }
  preview.source = 'ozon';
  preview.description = '';
  const title = cleanMarketplaceTitle(preview.title);
  if (isOzonChallengeTitle(title)) throw ozonPreviewBlockedError();
  if (!title && !preview.image) {
    const error = new Error('ozon_preview_not_found');
    error.status = 422;
    throw error;
  }
  preview.title = title || 'Товар Ozon';
  return preview;
}

async function fetchDetmirPreview(productUrl) {
  const preview = await fetchPageMetadata(productUrl);
  preview.source = 'detmir';
  preview.description = '';
  if (!preview.title && !preview.image) {
    const error = new Error('detmir_preview_not_found');
    error.status = 422;
    throw error;
  }
  preview.title = cleanMarketplaceTitle(preview.title)
    .replace(/\s+купить\s+по\s+цене\s+.*$/i, '')
    .replace(/\s+в\s+интернет-магазине\s+Детский\s+мир.*$/i, '')
    .trim() || 'Товар Детский мир';
  return preview;
}

function productStoreFromUrl(productUrl) {
  if (isOzonHost(productUrl.hostname)) return 'ozon';
  if (isWildberriesHost(productUrl.hostname)) return 'wildberries';
  if (isDetmirHost(productUrl.hostname)) return 'detmir';
  return 'page';
}

function cachedProductPreview(entry) {
  const preview = entry?.preview || {};
  if (!preview.title && !preview.image && !preview.price) return null;
  const updatedAt = Date.parse(entry.updatedAt || entry.cachedAt || '');
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > productPreviewCacheTtlMs) return null;
  return { ...preview, cached: true };
}

async function readProductPreviewCache(db, cacheKey) {
  if (!cacheKey) return null;
  if (pgPool) {
    await ensurePgSchema();
    const row = await pgPool.query('select data from povod_product_previews where cache_key = $1', [cacheKey]);
    return cachedProductPreview(row.rows[0]?.data);
  }
  const list = Array.isArray(db?.productPreviews) ? db.productPreviews : [];
  return cachedProductPreview(list.find(item => (item.cacheKey || item.key) === cacheKey));
}

async function writeProductPreviewCache(db, cacheKey, productUrl, preview) {
  if (!cacheKey || (!preview?.title && !preview?.image && !preview?.price)) return;
  const timestamp = now();
  const entry = {
    cacheKey,
    store: productStoreFromUrl(productUrl),
    url: normalizedProductHref(productUrl),
    preview: {
      source: preview.source || productStoreFromUrl(productUrl),
      title: preview.title || '',
      price: Number(preview.price || 0),
      image: preview.image || '',
      description: preview.description || '',
      url: preview.url || productUrl.href
    },
    cachedAt: timestamp,
    updatedAt: timestamp
  };
  if (pgPool) {
    await ensurePgSchema();
    await pgPool.query(
      `insert into povod_product_previews (cache_key, source, data, updated_at)
       values ($1, $2, $3::jsonb, $4)
       on conflict (cache_key) do update set source = excluded.source, data = excluded.data, updated_at = excluded.updated_at`,
      [cacheKey, entry.store, JSON.stringify(entry), timestamp]
    );
    return;
  }
  if (!db) return;
  db.productPreviews = Array.isArray(db.productPreviews) ? db.productPreviews : [];
  const index = db.productPreviews.findIndex(item => (item.cacheKey || item.key) === cacheKey);
  if (index >= 0) db.productPreviews[index] = entry;
  else db.productPreviews.unshift(entry);
  db.productPreviews = db.productPreviews
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, 1000);
  await writeDb(db);
}

async function fetchGiftPreview(rawUrl) {
  const productUrl = parseProductUrl(rawUrl);
  if (!isProbablyProductUrl(productUrl)) {
    const error = new Error('product_url_required');
    error.status = 400;
    throw error;
  }
  if (isOzonHost(productUrl.hostname)) return fetchOzonPreview(productUrl);
  if (isDetmirHost(productUrl.hostname)) return fetchDetmirPreview(productUrl);
  if (!isWildberriesHost(productUrl.hostname)) {
    const error = new Error('unsupported_store');
    error.status = 400;
    throw error;
  }
  const productId = wildberriesProductIdFromUrl(productUrl.href);
  if (productId) {
    try {
      return await fetchWildberriesApi(productId);
    } catch (error) {
      console.error('wildberries_api_preview_failed', error.message || error);
    }
    try {
      return await searchWildberriesProduct(productId);
    } catch (error) {
      console.error('wildberries_search_preview_failed', error.message || error);
    }
  }
  const preview = await fetchPageMetadata(productUrl);
  if (!preview.title && !preview.image) {
    const error = new Error('product_preview_not_found');
    error.status = 404;
    throw error;
  }
  return preview;
}

async function fetchGiftPreviewCached(rawUrl, db) {
  const productUrl = parseProductUrl(rawUrl);
  if (!isProbablyProductUrl(productUrl)) {
    const error = new Error('product_url_required');
    error.status = 400;
    throw error;
  }
  const cacheKey = productPreviewCacheKey(productUrl);
  const cached = await readProductPreviewCache(db, cacheKey);
  if (cached) return cached;
  if (productPreviewInflight.has(cacheKey)) return productPreviewInflight.get(cacheKey);
  const promise = (async () => {
    const preview = await fetchGiftPreview(productUrl.href);
    await writeProductPreviewCache(db, cacheKey, productUrl, preview);
    return preview;
  })();
  productPreviewInflight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    productPreviewInflight.delete(cacheKey);
  }
}

async function giftInputWithPreview(input, db) {
  const url = String(input.url || '').trim();
  let preview = {};
  const needsPreview = url && (input.autofill || !input.title || !input.image || !Number(input.price || 0));
  if (needsPreview) {
    try {
      preview = db ? await fetchGiftPreviewCached(url, db) : await fetchGiftPreview(url);
    } catch (error) {
      if (isSupportedGiftStoreUrlText(url)) {
        const previewError = new Error('gift_preview_failed');
        previewError.status = error.status === 400 ? 400 : 422;
        throw previewError;
      }
    }
  }
  const title = String(input.title || preview.title || '').trim();
  return {
    title: title || (url ? 'Подарок по ссылке' : ''),
    description: String(input.description || preview.description || ''),
    url,
    price: Number(input.price || preview.price || 0),
    image: String(input.image || preview.image || ''),
    category: String(input.category || 'Подарок')
  };
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

  if (path === '/api/auth/telegram-widget') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    try {
      const input = await body(req);
      const telegramUser = validateTelegramWidgetUser(input);
      const user = upsertTelegramUser(db, telegramUser);
      Object.assign(user, {
        consentPersonalDataAt: user.consentPersonalDataAt || now(),
        consentTermsAt: user.consentTermsAt || now(),
        consentAcceptedAt: user.consentAcceptedAt || now()
      });
      const token = uid();
      db.sessions.push({ token, userId: user.id, createdAt: now() });
      await writeDb(db);
      setSessionCookie(res, token);
      return send(res, 200, { user: publicUser(user) });
    } catch (error) {
      return send(res, 401, { error: error.message || 'telegram_widget_auth_failed' });
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
        if (!telegramUser?.id) {
          await telegramApi('sendMessage', {
            chat_id: chatId,
            text: 'Не получилось определить Telegram-профиль. Вернитесь на сайт и нажмите вход ещё раз.'
          }).catch(error => console.error(error));
          return send(res, 200, { ok: true });
        }
        await confirmTelegramLoginToken(db, loginToken, telegramUser, chatId);
        return send(res, 200, { ok: true });
      }
      const telegramId = telegramUser?.id ? String(telegramUser.id) : '';
      const latestUserToken = telegramId ? db.loginTokens
        .filter(item => String(item.telegramId || '') === telegramId && !item.userId && !item.usedAt && new Date(item.expiresAt).getTime() > Date.now())
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] : null;
      if (latestUserToken) {
        await confirmTelegramLoginToken(db, latestUserToken, telegramUser, chatId);
        return send(res, 200, { ok: true });
      }
      const recentAnonymousTokens = db.loginTokens.filter(item => {
        if (item.userId || item.usedAt || new Date(item.expiresAt).getTime() <= Date.now()) return false;
        if (String(item.telegramId || '')) return false;
        return Date.now() - new Date(item.createdAt).getTime() <= 2 * 60 * 1000;
      });
      if (telegramUser?.id && recentAnonymousTokens.length === 1) {
        await confirmTelegramLoginToken(db, recentAnonymousTokens[0], telegramUser, chatId);
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

  if (path === '/api/gift-preview') {
    const user = requireUser(req, res, db);
    if (!user) return;
    if (req.method !== 'POST') return methodNotAllowed(res);
    try {
      const input = await body(req);
      const preview = await fetchGiftPreviewCached(input.url, db);
      return send(res, 200, { preview });
    } catch (error) {
      console.error('gift_preview_failed', error.message || error);
      return send(res, error.status || 422, { error: error.message || 'gift_preview_failed' });
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
    let giftInput;
    try {
      giftInput = await giftInputWithPreview(input, db);
    } catch (error) {
      return send(res, error.status || 422, { error: error.message || 'gift_preview_failed' });
    }
    if (!giftInput.url && !giftInput.title) return send(res, 400, { error: 'gift_url_or_title_required' });
    const gift = {
      id: uid(),
      eventId: event.id,
      title: giftInput.title,
      description: giftInput.description,
      url: giftInput.url,
      price: giftInput.price,
      image: giftInput.image,
      category: giftInput.category,
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
    let giftInput;
    try {
      giftInput = await giftInputWithPreview({ ...gift, ...input, autofill: Boolean(input.url && input.url !== gift.url) }, db);
    } catch (error) {
      return send(res, error.status || 422, { error: error.message || 'gift_preview_failed' });
    }
    Object.assign(gift, {
      title: giftInput.title,
      description: giftInput.description,
      url: giftInput.url,
      image: giftInput.image,
      category: giftInput.category,
      price: giftInput.price
    });
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
