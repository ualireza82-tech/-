// ======================================================================
// db.js — لایه سازگاری (Compatibility Adapter) بین کد قدیمی مبتنی بر
// node-postgres (pg.Pool) و Turso (libSQL).
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

function convertPgOnlyFunctions(sql) {
  // تبدیل version() به sqlite_version()، اما اگر قبلاً sqlite_ داشت نادیده بگیر
  return sql
    .replace(/(?<!sqlite_)\bversion\s*\(\s*\)/gi, 'sqlite_version()')
    .replace(/\bcurrent_database\s*\(\s*\)/gi, "'turso'")
    // row_to_json را به JSON_GROUP_ARRAY تبدیل می‌کند (برای SQLite 3.45+)
    .replace(/row_to_json\s*\(/gi, 'json(');
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
  out = convertPgOnlyFunctions(out);
  out = out.replace(/\bILIKE\b/gi, 'LIKE');
  out = out.replace(/::\s*[a-zA-Z_][a-zA-Z0-9_]*(\[\])?/g, '');
  out = out.replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP');
  out = convertDdlTypes(out);
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
      try { val = JSON.parse(val); } catch (e) {}
    }
    if (BOOLEAN_COLUMNS.has(col) && (val === 0 || val === 1)) {
      val = !!val;
    }
    if (typeof val === 'bigint') val = Number(val);
    out[col] = val;
  }
  return out;
}

// ── اصلاح مهم: اطلاعاتی اسکیمای SQLite ──
async function handleInformationSchemaColumns(sql, params) {
  if (!/information_schema\.columns/i.test(sql)) return null;

  // پشتیبانی از پارامترهای متعدد ($1, $2, ...)
  const paramMatches = [...sql.matchAll(/table_name\s*=\s*\$(\d+)/gi)];
  const paramColumnMatches = [...sql.matchAll(/column_name\s*=\s*\$(\d+)/gi)];

  let table = null;
  let column = null;

  if (paramMatches.length > 0 && params) {
    const idx = parseInt(paramMatches[0][1], 10) - 1;
    table = params[idx];
  } else {
    const literalTable = sql.match(/table_name\s*=\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/i);
    if (literalTable) table = literalTable[1];
  }

  if (paramColumnMatches.length > 0 && params) {
    const idx = parseInt(paramColumnMatches[0][1], 10) - 1;
    column = params[idx];
  } else {
    const literalColumn = sql.match(/column_name\s*=\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/i);
    if (literalColumn) column = literalColumn[1];
  }

  if (!table || !column) return null;

  try {
    const info = await client.execute(`PRAGMA table_info(${table})`);
    const exists = info.rows.some(r => r.name === column || r[1] === column);
    return exists ? { rows: [{ column_name: column }], rowCount: 1 } : { rows: [], rowCount: 0 };
  } catch (e) {
    // اگر جدول وجود نداشته باشد، PRAGMA خطا نمی‌دهد، اما اطلاعاتی برنمی‌گرداند
    return { rows: [], rowCount: 0 };
  }
}

async function handleInformationSchemaTables(sql, params) {
  if (!/information_schema\.tables/i.test(sql)) return null;

  let table = null;
  const paramMatch = sql.match(/table_name\s*=\s*\$(\d+)/i);
  if (paramMatch && params) {
    const idx = parseInt(paramMatch[1], 10) - 1;
    table = params[idx];
  } else {
    const literalTable = sql.match(/table_name\s*=\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/i);
    if (literalTable) table = literalTable[1];
  }

  if (!table) return null;

  try {
    const check = await client.execute({
      sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      args: [table],
    });
    const exists = check.rows.length > 0;

    if (/SELECT\s+EXISTS\s*\(/i.test(sql)) {
      return { rows: [{ exists }], rowCount: 1 };
    }
    return exists ? { rows: [{ table_name: table }], rowCount: 1 } : { rows: [], rowCount: 0 };
  } catch (e) {
    return { rows: [{ exists: false }], rowCount: 1 };
  }
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

async function query(textOrConfig, params) {
  let text = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
  let values = typeof textOrConfig === 'string' ? params : textOrConfig.values;

  try {
    const addColResult = await handleAddColumnIfNotExists(text);
    if (addColResult) return addColResult;

    const infoColsResult = await handleInformationSchemaColumns(text, values);
    if (infoColsResult) return infoColsResult;

    const infoTablesResult = await handleInformationSchemaTables(text, values);
    if (infoTablesResult) return infoTablesResult;

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

async function connect() {
  return {
    query,
    release: () => {},
  };
}

const pool = {
  query,
  connect,
  on: (event, cb) => {},
};

module.exports = { pool, client };
