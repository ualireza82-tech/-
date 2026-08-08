// ======================================================================
// ensure-schema.js — اجرای خودکار schema.sql در هر بار بالا آمدن سرور.
//
// این فایل عمداً کاملاً مستقل و بی‌ضرر طراحی شده:
//   • اگر schema.sql کنارش پیدا نشود (مثلاً بعداً از گیت‌هاب حذفش کردید)،
//     فقط یک لاگ اطلاعاتی می‌زند و ادامه می‌دهد — سرور بالا نمی‌آید که
//     کرش کند.
//   • هر CREATE TABLE/INDEX را جدا و در try/catch خودش اجرا می‌کند، پس
//     اگر یکی از دستورها به هر دلیلی خطا داد (مثلاً جدولی با تعریف متفاوت
//     از قبل وجود داشت)، بقیه‌ی دستورها همچنان اجرا می‌شوند.
//   • idempotent است: چون همه‌ی دستورهای schema.sql با IF NOT EXISTS
//     نوشته شده‌اند، اجرای مکررش (هر بار ری‌استارت سرور) کاملاً بی‌خطر است.
//
// استفاده در server.js (فقط همین ۲ خط، همان اول فایل بعد از require('./db')):
//
//   const { ensureSchema } = require('./ensure-schema');
//   ensureSchema(); // بدون await هم مشکلی نیست؛ چون خودش idempotent و
//                    // fire-and-forget امن است — اما اگر می‌خواهید مطمئن
//                    // شوید قبل از app.listen تمام شده، از
//                    // await ensureSchema() داخل یک (async () => {...})()
//                    // در بالای فایل استفاده کنید.
// ======================================================================

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function ensureSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');

  if (!fs.existsSync(schemaPath)) {
    console.log('ℹ️  schema.sql پیدا نشد — از ensure-schema صرف‌نظر شد (این طبیعی است اگر عمداً حذفش کرده‌اید).');
    return;
  }

  let sql;
  try {
    sql = fs.readFileSync(schemaPath, 'utf8');
  } catch (e) {
    console.error('⚠️  خواندن schema.sql ناموفق بود:', e.message);
    return;
  }

  // حذف کامنت‌های تک‌خطی (-- ...) قبل از تفکیک با ; تا کامنت‌هایی که
  // خودشان شامل ; نیستند مشکلی ایجاد نکنند
  const withoutComments = sql
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');

  const statements = withoutComments
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);

  let ok = 0, failed = 0;
  for (const stmt of statements) {
    try {
      await pool.query(stmt);
      ok++;
    } catch (e) {
      failed++;
      console.error(`⚠️  schema.sql statement failed (نادیده گرفته شد و ادامه داده شد): ${e.message}\n    → ${stmt.slice(0, 90)}...`);
    }
  }

  console.log(`✅ ensure-schema: ${ok} دستور اجرا شد، ${failed} مورد نادیده گرفته شد (از قبل موجود بودند یا خطای جزئی داشتند).`);
}

module.exports = { ensureSchema };
