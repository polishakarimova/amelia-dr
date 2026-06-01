import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

function loadEnvFile() {
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    let value = rest.join('=').trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

const dataDir = process.env.DATA_DIR || join(root, 'data');
const dbFile = join(dataDir, 'db.json');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const cookieName = 'povod_session';
const appUrl = (process.env.APP_URL || `http://${host}:${port}`).replace(/\/$/, '');
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
let telegramBotInfo = null;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
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
  const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(`telegram_${method}_failed`);
  return data.result;
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

async function readDb() {
  try {
    return JSON.parse(await readFile(dbFile, 'utf8'));
  } catch {
    return { users: [], sessions: [], events: [], gifts: [] };
  }
}

async function writeDb(db) {
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

async function api(req, res, url) {
  const db = await readDb();
  const path = url.pathname;

  if (path === '/api/auth/me') {
    if (req.method !== 'GET') return methodNotAllowed(res);
    return send(res, 200, { user: publicUser(currentUser(req, db)) });
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
      const token = uid();
      db.sessions.push({ token, userId: user.id, createdAt: now() });
      await writeDb(db);
      setSessionCookie(res, token);
      return send(res, 200, { user: publicUser(user) });
    } catch (error) {
      return send(res, 401, { error: error.message || 'telegram_auth_failed' });
    }
  }

  if (path === '/api/auth/telegram/start' || path === '/api/auth/telegram/callback') {
    if (req.method !== 'POST') return methodNotAllowed(res);
    const input = await body(req);
    const username = String(input.username || input.name || '').replace(/^@/, '').trim();
    if (!username) return send(res, 400, { error: 'telegram_username_required' });
    const email = `telegram:${slugify(username)}`;
    let user = db.users.find(item => item.email === email);
    if (!user) {
      user = {
        id: uid(),
        email,
        name: username,
        authProvider: 'telegram',
        telegramUsername: `@${username}`,
        telegramId: createHash('sha256').update(username).digest('hex').slice(0, 16),
        createdAt: now()
      };
      db.users.push(user);
    }
    const token = uid();
    db.sessions.push({ token, userId: user.id, createdAt: now() });
    await writeDb(db);
    setSessionCookie(res, token);
    return send(res, 200, { user: publicUser(user) });
  }

  if (path === '/api/telegram/config') {
    if (req.method !== 'GET') return methodNotAllowed(res);
    try {
      const bot = telegramBotToken ? await getTelegramBotInfo() : null;
      return send(res, 200, {
        appUrl,
        botUsername: bot?.username || '',
        botLink: bot?.username ? `https://t.me/${bot.username}?startapp=povod` : '',
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
    const message = update.message || update.edited_message;
    const chatId = message?.chat?.id;
    const text = String(message?.text || '');
    if (chatId && text.startsWith('/start')) {
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
        allowed_updates: ['message', 'edited_message']
      });
      await telegramApi('setChatMenuButton', {
        menu_button: {
          type: 'web_app',
          text: 'Открыть Повод',
          web_app: { url: `${appUrl}/login` }
        }
      }).catch(() => null);
      const webhook = await telegramApi('getWebhookInfo');
      return send(res, 200, { ok: true, webhook });
    } catch (error) {
      return send(res, 500, { error: error.message || 'telegram_setup_failed' });
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
