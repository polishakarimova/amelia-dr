import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';

function loadEnvFile() {
  if (!existsSync('.env')) return;
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
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

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing');
  process.exit(1);
}

const parsed = new URL(process.env.DATABASE_URL);
const sslMode = parsed.searchParams.get('sslmode');
let ssl = false;
if (sslMode && sslMode !== 'disable') ssl = { rejectUnauthorized: false };

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 1 });

try {
  const result = await pool.query('select current_database() as db, current_user as "user"');
  console.log(JSON.stringify({ ok: true, db: result.rows[0].db, user: result.rows[0].user }));
} finally {
  await pool.end();
}
