// ======================================================================
// db.js — لایه سازگاری (Compatibility Adapter) بین کد قدیمی مبتنی بر
// node-postgres (pg.Pool) و Turso (libSQL).
//
// این نسخه شامل یک پچ حیاتی است (بخش 6 پایین) — به CHANGELOG مراجعه کنید.
// ======================================================================

const { createClient } = require('@libsql/client');

if (!process.env.TURSO_DATABASE_URL) {
  console.error('❌ FATAL: TURSO_DATABASE_URL تنظیم نشده در .env');
  process.exit(1);
}
if (!process.env.TURSO_AUTH_TOKEN) {
  console.error('❌ FATAL: TURSO_AUTH_TOKEN تنظیم نشده در .env');
  process.exit(1);
}

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const JSON_COLUMNS = new Set([
  'options', 'media_urls', 'link_card', 'location', 'music',
  'hidden_for', 'hashtags', 'detail', 'device_info',
]);

const BOOLEAN_COLUMNS = new Set([
  'is_admin', 'is_suspended', 'ai_label', 'read', 'otp_verified',
  'is_active',
]);

const TIMESTAMP_COLUMNS = new Set([
  'created_at', 'updated_at', 'last_active', 'last_activity', 'last_seen',
  'last_updated', 'expires_at', 'requested_at', 'deactivation_date',
  'permanent_delete_date', 'cancelled_at', 'resolved_at', 'otp_expires_at',
]);
const SQLITE_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
function toIsoUtc(val) {
  if (typeof val === 'string' && SQLITE_TS_RE.test(val)) {
    return val.replace(' ', 'T') + '.000Z';
  }
  return val;
}

function convertIntervalExpr(sql) {
  sql = sql.replace(
    /NOW\(\)\s*([+-])\s*INTERVAL\s*'([\d.]+)\s*(second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)'/gi,
    (m, sign, num, unit) => {
      let n = parseFloat(num);
      let u = unit.toLowerCase();
      if (u.startsWith('week')) { n = n * 7; u = 'days'; }
      if (!u.endsWith('s')) u += 's';
      return `datetime('now', '${sign}${n} ${u}')`;
    }
  );
  sql = sql.replace(
    /([a-zA-Z_][a-zA-Z0-9_.]*)\s*([+-])\s*INTERVAL\s*'([\d.]+)\s*(second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)'/gi,
    (m, col, sign, num, unit) => {
      let n = parseFloat(num);
      let u = unit.toLowerCase();
      if (u.startsWith('week')) { n = n * 7; u = 'days'; }
      if (!u.endsWith('s')) u += 's';
      return `datetime(${col}, '${sign}${n} ${u}')`;
    }
  );
  return sql;
}

function convertExtract(sql) {
  const map = { HOUR: '%H', DAY: '%d', MONTH: '%m', YEAR: '%Y', MINUTE: '%M', SECOND: '%S', DOW: '%w' };
  return sql.replace(/EXTRACT\s*\(\s*(HOUR|DAY|MONTH|YEAR|MINUTE|SECOND|DOW)\s+FROM\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s*\)/gi,
    (m, unit, col) => `CAST(strftime('${map[unit.toUpperCase()]}', ${col}) AS INTEGER)`
  );
}

function convertDdlTypes(sql) {
  return sql
    .replace(/\bSERIAL\s+PRIMARY\s+KEY\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT')
    .replace(/\bBIGSERIAL\s+PRIMARY\s+KEY\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT')
    .replace(/\bJSONB\b/gi, 'TEXT')
    .replace(/\bJSON\b/gi, 'TEXT')
    .replace(/\bTIMESTAMPTZ\b/gi, 'TEXT')
    .replace(/\bTIMESTAMP\s+WITH\s+TIME\s+ZONE\b/gi, 'TEXT')
    .replace(/\bTIMESTAMP\b/gi, 'TEXT')
    .replace(/\bBOOLEAN\s+DEFAULT\s+false\b/gi, 'INTEGER DEFAULT 0')
    .replace(/\bBOOLEAN\s+DEFAULT\s+true\b/gi, 'INTEGER DEFAULT 1')
    .replace(/\bBOOLEAN\b/gi, 'INTEGER')
    .replace(/\bINT(EGER)?\[\]/gi, 'TEXT')
    .replace(/\bTEXT\[\]/gi, 'TEXT')
    .replace(/\bCHARACTER VARYING\[\]/gi, 'TEXT')
    .replace(/DEFAULT\s+'\{\}'/gi, "DEFAULT '[]'")
    .replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP');
}

function preprocessSql(sql) {
  let out = sql;
  out = convertIntervalExpr(out);
  out = convertExtract(out);
  out = out.replace(/\bILIKE\b/gi, 'LIKE');
  out = out.replace(/::\s*[a-zA-Z_][a-zA-Z0-9_]*(\[\])?/g, '');
  out = out.replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP');
  if (/^\s*(CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(out)) {
    out = convertDdlTypes(out);
  }
  return out;
}

function convertPlaceholders(sql, params) {
  if (!params || params.length === 0) {
    return { text: sql.replace(/\$\d+/g, '?'), values: [] };
  }
  const newValues = [];
  const text = sql.replace(/\$(\d+)/g, (m, n) => {
    const idx = parseInt(n, 10) - 1;
    newValues.push(params[idx]);
    return '?';
  });
  return { text, values: newValues };
}

function normalizeParam(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace('Z', '');
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function normalizeRow(row, columns) {
  const out = {};
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    let val = row[i];
    if (JSON_COLUMNS.has(col) && typeof val === 'string') {
      try { val = JSON.parse(val); } catch (e) { /* رشته معمولی بود، دست‌نخورده می‌ماند */ }
    }
    if (BOOLEAN_COLUMNS.has(col) && (val === 0 || val === 1)) {
      val = !!val;
    }
    if (TIMESTAMP_COLUMNS.has(col)) {
      val = toIsoUtc(val);
    }
    if (typeof val === 'bigint') val = Number(val);
    out[col] = val;
  }
  return out;
}

async function handleAddColumnIfNotExists(sql) {
  const re = /ALTER\s+TABLE\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+([\s\S]+?);?\s*$/i;
  const m = sql.match(re);
  if (!m) return null;
  const [, table, column, rest] = m;
  const info = await client.execute(`PRAGMA table_info(${table})`);
  const exists = info.rows.some(r => r.name === column || r[1] === column);
  if (exists) {
    return { rows: [], rowCount: 0 };
  }
  const convertedRest = convertDdlTypes(rest).replace(/::\s*[a-zA-Z_]+(\[\])?/g, '');
  const alterSql = `ALTER TABLE ${table} ADD COLUMN ${column} ${convertedRest}`;
  await client.execute(alterSql);
  return { rows: [], rowCount: 0 };
}

// ----------------------------------------------------------------------
// ✅ جدید: بررسی سازگار با SQLite/Turso از وجود یک ستون در یک جدول —
// جایگزین `SELECT 1 FROM information_schema.columns` که در Postgres کار
// می‌کند اما در SQLite/libSQL اصلاً وجود ندارد (چنین کوئری‌ای همیشه با
// خطای "no such table: information_schema" شکست می‌خورد و نتیجه‌اش این
// بود که پس از هر شکست موقتی/ناموفق ALTER، فلگ‌های *ColumnReady برای
// همیشه false می‌ماندند).
//
// استفاده در server.js به‌جای بلوک‌های information_schema:
//   const { columnExists } = require('./db');
//   const ready = await columnExists('tweets', 'quote_tweet_id');
// ----------------------------------------------------------------------
async function columnExists(table, column) {
  try {
    const info = await client.execute(`PRAGMA table_info(${table})`);
    return info.rows.some(r => (r.name === column) || (r[1] === column));
  } catch (e) {
    return false;
  }
}

async function executeMultiStatement(sql) {
  const converted = preprocessSql(sql);
  const statements = converted
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await client.execute(stmt);
  }
  return { rows: [], rowCount: 0 };
}

function looksLikeMultiStatement(sql) {
  const parts = sql.split(';').map(s => s.trim()).filter(Boolean);
  return parts.length > 1;
}

// ----------------------------------------------------------------------
// ✅✅✅ پچ حیاتی (ریشه‌ی باگ گزارش‌شده) ✅✅✅
//
// server.js هنگام ساخت پست جدید (و چند جای دیگر مشابه) دقیقاً همین منطق
// را دارد:
//
//     try {
//       insertRes = await pool.query(q.text, q.values);   // شامل ستون‌های
//                                                          // تازه‌اضافه‌شده
//     } catch (insertErr) {
//       if (insertErr.code !== '42703') throw insertErr;  // 42703 = کد
//                                                          // Postgres برای
//                                                          // "undefined_column"
//       // fallback: دوباره INSERT کن ولی بدون آن ستون‌ها
//       insertRes = await pool.query(q2.text, q2.values);
//     }
//
// این منطق کاملاً درست است، اما فقط وقتی کار می‌کند که `insertErr.code`
// واقعاً برابر رشته‌ی پستگرسیِ '42703' باشد. مشکل این بود که db.js (قبل
// از این پچ) فقط خطای UNIQUE را نرمال‌سازی می‌کرد (به 23505) و خطای
// "ستون یافت نشد" را دست‌نخورده از libSQL عبور می‌داد. پیام واقعی libSQL
// چیزی شبیه این است:
//
//     "table tweets has no column named quote_tweet_id"
//
// و کدش هرگز '42703' نبود. در نتیجه شرط `if (insertErr.code !== '42703')`
// همیشه true می‌شد → همیشه `throw insertErr` اجرا می‌شد → مسیر fallback
// هرگز فعال نمی‌شد → کاربر با خطای 500 خام روبه‌رو می‌شد، دقیقاً هر بار
// که یکی از ستون‌های تازه‌مهاجرت‌شده (quote_tweet_id، media_urls،
// ai_label، location، music) در دیتابیس واقعی Turso هنوز درست ساخته
// نشده بود یا فلگ *ColumnReady به اشتباه true مانده بود.
//
// این تابع پایین همان کاری را برای 42703 انجام می‌دهد که از قبل برای
// 23505 انجام می‌شد: پیام خطای متنی SQLite را تشخیص می‌دهد و کد Postgres
// معادلش را روی خطای نرمال‌شده می‌گذارد — بدون این‌که حتی یک خط از
// server.js نیاز به تغییر داشته باشد.
// ----------------------------------------------------------------------
const MISSING_COLUMN_RE = /no such column|has no column named/i;

function normalizeError(err) {
  const msg = (err && err.message) || '';
  if (/UNIQUE constraint failed/i.test(msg) || /SQLITE_CONSTRAINT_UNIQUE/i.test(err.code || '') || /SQLITE_CONSTRAINT_PRIMARYKEY/i.test(err.code || '')) {
    const e = new Error(msg);
    e.code = '23505';
    e.original = err;
    return e;
  }
  if (MISSING_COLUMN_RE.test(msg)) {
    const e = new Error(msg);
    e.code = '42703'; // undefined_column — همان کد Postgres
    e.original = err;
    return e;
  }
  return err;
}

async function query(textOrConfig, params) {
  let text = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
  let values = typeof textOrConfig === 'string' ? params : textOrConfig.values;

  try {
    const addColResult = await handleAddColumnIfNotExists(text);
    if (addColResult) return addColResult;

    if (!values && looksLikeMultiStatement(text)) {
      return await executeMultiStatement(text);
    }

    const preprocessed = preprocessSql(text);
    const { text: finalText, values: reorderedValues } =
      convertPlaceholders(preprocessed, values || []);
    const boundValues = reorderedValues.map(normalizeParam);

    const result = await client.execute({ sql: finalText, args: boundValues });

    const columns = result.columns || [];
    const rows = (result.rows || []).map(r => normalizeRow(r, columns));

    return {
      rows,
      rowCount: result.rowsAffected !== undefined && result.rowsAffected > 0
        ? result.rowsAffected
        : rows.length,
      lastInsertRowid: typeof result.lastInsertRowid === 'bigint'
        ? Number(result.lastInsertRowid)
        : result.lastInsertRowid,
    };
  } catch (err) {
    throw normalizeError(err);
  }
}

async function connect() {
  return {
    query,
    release: () => {},
  };
}

const pool = {
  query,
  connect,
  on: (event, cb) => { /* libSQL اتصال سرورمحور ندارد؛ فقط برای سازگاری */ },
};

module.exports = { pool, client, columnExists };
