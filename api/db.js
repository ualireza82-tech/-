// ======================================================================
// db.js — لایه سازگاری (Compatibility Adapter) بین کد قدیمی مبتنی بر
// node-postgres (pg.Pool) و Turso (libSQL).
//
// هدف: صفر تغییر در ۹۹٪ کوئری‌های server.js. این ماژول یک شیء `pool`
// برمی‌گرداند که متد query(text, params) آن دقیقاً همان شکل خروجی
// { rows, rowCount } کتابخانه pg را شبیه‌سازی می‌کند، و در پس‌زمینه:
//   1) $1, $2, ... را به ? تبدیل می‌کند (با پشتیبانی از تکرار همان پارامتر)
//   2) عملگرها و توابع مخصوص Postgres را به معادل SQLite/libSQL ترجمه می‌کند
//      (NOW(), INTERVAL, ILIKE, ::cast, EXTRACT, SERIAL, JSONB, version(), ...)
//   3) پارامترهای Array/Object را قبل از bind به JSON رشته تبدیل می‌کند
//   4) ستون‌های شناخته‌شده‌ی JSON/آرایه را هنگام خواندن دوباره parse می‌کند
//   5) خطای UNIQUE constraint را با کد Postgres (23505) شبیه‌سازی می‌کند
//      تا catch(error.code === '23505') در کد قدیمی همچنان کار کند
//   6) دستورهای ALTER TABLE ... ADD COLUMN IF NOT EXISTS را که در SQLite
//      معتبر نیستند به‌صورت idempotent با PRAGMA table_info شبیه‌سازی می‌کند
//   7) اسکریپت‌های چندجمله‌ای CREATE TABLE ...; CREATE INDEX ...; را
//      تفکیک و به‌ترتیب اجرا می‌کند
//   8) کوئری‌های information_schema.columns / information_schema.tables
//      (که در SQLite/Turso وجود ندارند) را به PRAGMA table_info /
//      sqlite_master ترجمه می‌کند
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

// ستون‌هایی که در سوپابیس از نوع jsonb یا آرایه بودند و اکنون به‌صورت
// متن JSON در Turso ذخیره می‌شوند. هنگام خواندن، این ستون‌ها به‌صورت
// خودکار به JS array/object تبدیل می‌شوند تا رفتار قدیمی pg حفظ شود.
const JSON_COLUMNS = new Set([
  'options', 'media_urls', 'link_card', 'location', 'music',
  'hidden_for', 'hashtags', 'detail', 'device_info',
]);

// ستون‌های boolean که در Postgres نوع boolean واقعی داشتند. در SQLite
// به‌صورت 0/1 ذخیره می‌شوند؛ اینجا به true/false واقعی برمی‌گردانیم تا
// هر جای کد (یا فرانت‌اند) که رفتار boolean دقیق انتظار دارد سالم بماند.
const BOOLEAN_COLUMNS = new Set([
  'is_admin', 'is_suspended', 'ai_label', 'read', 'otp_verified',
  'is_active',
]);

// ----------------------------------------------------------------------
// تبدیل مقدار NOW() ± INTERVAL 'n unit'  →  datetime('now', '±n unit')
// SQLite واحد week را نمی‌شناسد، پس به day تبدیل می‌شود.
// ----------------------------------------------------------------------
function convertIntervalExpr(sql) {
  // NOW() - INTERVAL 'n unit(s)'  →  datetime('now','-n unit')
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

  // <col/expr> + INTERVAL 'n unit'  →  datetime(<col/expr>, '+n unit')
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

// ----------------------------------------------------------------------
// EXTRACT(HOUR FROM col) → CAST(strftime('%H', col) AS INTEGER)  (و مشابه)
// ----------------------------------------------------------------------
function convertExtract(sql) {
  const map = { HOUR: '%H', DAY: '%d', MONTH: '%m', YEAR: '%Y', MINUTE: '%M', SECOND: '%S', DOW: '%w' };
  return sql.replace(/EXTRACT\s*\(\s*(HOUR|DAY|MONTH|YEAR|MINUTE|SECOND|DOW)\s+FROM\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s*\)/gi,
    (m, unit, col) => `CAST(strftime('${map[unit.toUpperCase()]}', ${col}) AS INTEGER)`
  );
}

// ----------------------------------------------------------------------
// توابع مخصوص Postgres که معادل مستقیم SQLite دارند
//   version()          → sqlite_version()   (نه sqlite_version() خودش،
//                         با lookbehind منفی از تبدیل مضاعف جلوگیری می‌شود)
//   current_database()  → 'turso' (یک ثابت رشته‌ای، چون SQLite مفهوم
//                         "نام دیتابیس جاری" ندارد)
// ----------------------------------------------------------------------
function convertPgOnlyFunctions(sql) {
  return sql
    .replace(/(?<!sqlite_)\bversion\s*\(\s*\)/gi, 'sqlite_version()')
    .replace(/\bcurrent_database\s*\(\s*\)/gi, "'turso'");
}

// ----------------------------------------------------------------------
// تبدیل‌های نوعی مخصوص DDL (CREATE TABLE / ALTER TABLE)
// ----------------------------------------------------------------------
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

// ----------------------------------------------------------------------
// پیش‌پردازش عمومی متن SQL (برای هر query عادی هم اجرا می‌شود)
// ----------------------------------------------------------------------
function preprocessSql(sql) {
  let out = sql;
  out = convertIntervalExpr(out);
  out = convertExtract(out);
  out = convertPgOnlyFunctions(out);
  out = out.replace(/\bILIKE\b/gi, 'LIKE');
  // strip Postgres cast operator: $1::integer , NULL::jsonb , '{}'::integer[]
  out = out.replace(/::\s*[a-zA-Z_][a-zA-Z0-9_]*(\[\])?/g, '');
  out = out.replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP');
  out = convertDdlTypes(out); // بی‌خطر است حتی روی DML چون فقط کلمات کلیدی DDL را می‌گیرد
  return out;
}

// ----------------------------------------------------------------------
// $1, $2, ... → ? با حفظ ترتیب صحیح پارامترها (حتی اگر یک $N چند بار تکرار شود)
// ----------------------------------------------------------------------
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

// ----------------------------------------------------------------------
// نرمال‌سازی یک مقدار پارامتر قبل از bind به libSQL
// (libSQL فقط null/number/bigint/string/boolean/Uint8Array را می‌پذیرد)
// ----------------------------------------------------------------------
function normalizeParam(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace('Z', '');
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

// ----------------------------------------------------------------------
// تبدیل یک ردیف خام libSQL (که هم index و هم نام ستون دارد) به object ساده
// + parse خودکار ستون‌های JSON + تبدیل ستون‌های boolean شناخته‌شده
// ----------------------------------------------------------------------
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
    if (typeof val === 'bigint') val = Number(val);
    out[col] = val;
  }
  return out;
}

// ----------------------------------------------------------------------
// تشخیص و مدیریت ویژه‌ی: ALTER TABLE <t> ADD COLUMN IF NOT EXISTS <c> <rest>
// SQLite از IF NOT EXISTS برای ADD COLUMN پشتیبانی نمی‌کند، پس به‌صورت
// idempotent با PRAGMA table_info شبیه‌سازی می‌شود.
// ----------------------------------------------------------------------
async function handleAddColumnIfNotExists(sql) {
  const re = /ALTER\s+TABLE\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+([\s\S]+?);?\s*$/i;
  const m = sql.match(re);
  if (!m) return null;
  const [, table, column, rest] = m;
  const info = await client.execute(`PRAGMA table_info(${table})`);
  const exists = info.rows.some(r => r.name === column || r[1] === column);
  if (exists) {
    return { rows: [], rowCount: 0 }; // no-op، ستون از قبل هست
  }
  const convertedRest = convertDdlTypes(rest).replace(/::\s*[a-zA-Z_]+(\[\])?/g, '');
  const alterSql = `ALTER TABLE ${table} ADD COLUMN ${column} ${convertedRest}`;
  await client.execute(alterSql);
  return { rows: [], rowCount: 0 };
}

// ----------------------------------------------------------------------
// تشخیص و مدیریت ویژه‌ی: SELECT ... FROM information_schema.columns
// WHERE table_name = 'x' AND column_name = 'y'
// (چه با لیترال رشته‌ای، چه با پارامتر $1/$2)
// SQLite/Turso چیزی به نام information_schema ندارد؛ معادل آن
// PRAGMA table_info(table) است.
// ----------------------------------------------------------------------
async function handleInformationSchemaColumns(sql, params) {
  if (!/information_schema\.columns/i.test(sql)) return null;

  const literalTable = sql.match(/table_name\s*=\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/i);
  const literalColumn = sql.match(/column_name\s*=\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/i);
  const paramTable = sql.match(/table_name\s*=\s*\$(\d+)/i);
  const paramColumn = sql.match(/column_name\s*=\s*\$(\d+)/i);

  const table = literalTable ? literalTable[1] : (paramTable && params ? params[parseInt(paramTable[1], 10) - 1] : null);
  const column = literalColumn ? literalColumn[1] : (paramColumn && params ? params[parseInt(paramColumn[1], 10) - 1] : null);

  if (!table || !column) return null; // الگو ناشناخته بود؛ به مسیر عادی برگرد (که با خطا مواجه می‌شود ولی حداقل چیزی را خراب نمی‌کنیم)

  const info = await client.execute(`PRAGMA table_info(${table})`);
  const exists = info.rows.some(r => r.name === column || r[1] === column);
  return exists ? { rows: [{ column_name: column }], rowCount: 1 } : { rows: [], rowCount: 0 };
}

// ----------------------------------------------------------------------
// تشخیص و مدیریت ویژه‌ی: SELECT EXISTS (SELECT ... FROM information_schema.tables
// WHERE table_name = 'x')
// معادل SQLite: sqlite_master
// ----------------------------------------------------------------------
async function handleInformationSchemaTables(sql, params) {
  if (!/information_schema\.tables/i.test(sql)) return null;

  const literalTable = sql.match(/table_name\s*=\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/i);
  const paramTable = sql.match(/table_name\s*=\s*\$(\d+)/i);
  const table = literalTable ? literalTable[1] : (paramTable && params ? params[parseInt(paramTable[1], 10) - 1] : null);
  if (!table) return null;

  const check = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [table],
  });
  const exists = check.rows.length > 0;

  // اگر کوئری اصلی با SELECT EXISTS (...) پوشیده شده بود، همان شکل خروجی
  // pg (ستونی به نام exists) را برمی‌گردانیم؛ در غیر این صورت لیست ساده‌ی سطرها.
  if (/SELECT\s+EXISTS\s*\(/i.test(sql)) {
    return { rows: [{ exists }], rowCount: 1 };
  }
  return exists ? { rows: [{ table_name: table }], rowCount: 1 } : { rows: [], rowCount: 0 };
}

// ----------------------------------------------------------------------
// اجرای اسکریپت چندجمله‌ای (چند CREATE/ALTER با ; جدا شده) — بدون پارامتر
// ----------------------------------------------------------------------
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
  // بیش از یک عبارت غیر خالی جدا شده با ; دارد (خودِ query عادی هم ممکن است
  // انتهایش یک ; داشته باشد، پس باید حداقل دو statement غیرخالی معنی‌دار باشد)
  const parts = sql.split(';').map(s => s.trim()).filter(Boolean);
  return parts.length > 1;
}

// ----------------------------------------------------------------------
// شبیه‌سازی خطای Postgres unique_violation (23505) برای سازگاری با
// catch (error.code === '23505') در کد قدیمی
// ----------------------------------------------------------------------
function normalizeError(err) {
  const msg = (err && err.message) || '';
  if (/UNIQUE constraint failed/i.test(msg) || /SQLITE_CONSTRAINT_UNIQUE/i.test(err.code || '') || /SQLITE_CONSTRAINT_PRIMARYKEY/i.test(err.code || '')) {
    const e = new Error(msg);
    e.code = '23505';
    e.original = err;
    return e;
  }
  return err;
}

// ----------------------------------------------------------------------
// متد اصلی query — امضای سازگار با pg: query(text, params) یا query({text, values})
// ----------------------------------------------------------------------
async function query(textOrConfig, params) {
  let text = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
  let values = typeof textOrConfig === 'string' ? params : textOrConfig.values;

  try {
    // مورد خاص: ALTER TABLE ... ADD COLUMN IF NOT EXISTS
    const addColResult = await handleAddColumnIfNotExists(text);
    if (addColResult) return addColResult;

    // مورد خاص: information_schema.columns / information_schema.tables
    // (این‌ها باید قبل از اسکریپت چندجمله‌ای و preprocess عمومی چک شوند)
    const infoColsResult = await handleInformationSchemaColumns(text, values);
    if (infoColsResult) return infoColsResult;

    const infoTablesResult = await handleInformationSchemaTables(text, values);
    if (infoTablesResult) return infoTablesResult;

    // مورد خاص: اسکریپت چندجمله‌ای بدون پارامتر (بلوک‌های CREATE TABLE در راه‌اندازی)
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
      lastInsertRowid: result.lastInsertRowid,
    };
  } catch (err) {
    throw normalizeError(err);
  }
}

// ----------------------------------------------------------------------
// شبیه‌سازی pool.connect() → یک "client" با query/release
// (در server.js فقط در testDatabaseConnection استفاده شده)
// ----------------------------------------------------------------------
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

module.exports = { pool, client };
