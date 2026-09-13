// ══════════════════════════════════════════════════════════════════════
// test-oxapay-live.js
// این اسکریپت را روی سرور واقعی (جایی که .env با OXAPAY_MERCHANT_API_KEY
// و OXAPAY_CALLBACK_URL واقعی ست شده) اجرا کن:
//
//     node test-oxapay-live.js
//
// کاری که می‌کند:
//   ۱. یک فاکتور واقعی ۱ دلاری تستی از OxaPay White-Label API می‌گیرد
//   ۲. کل پاسخ خام JSON را چاپ می‌کند — این دقیق‌ترین راه برای دیدن
//      نام واقعی فیلدها (track_id/trackId، address، amount و…) است
//   ۳. بررسی می‌کند که extractOxapayFields() در payments-oxapay.js این
//      فیلدها را درست پیدا می‌کند یا نه — اگر «✅ استخراج موفق» دیدی،
//      یعنی هیچ اصلاحی لازم نیست. اگر «❌» دیدی، دقیقاً می‌گوید کدام
//      فیلد پیدا نشد تا در extractOxapayFields() اصلاحش کنی.
//
// هیچ پولی واقعا برداشت نمی‌شود — فقط یک آدرس پرداخت ساخته می‌شود که
// اگر کسی بهش واریز نکند، بعد از انقضا (اینجا ۱۵ دقیقه) خودبه‌خود بی‌اثر می‌ماند.
// ══════════════════════════════════════════════════════════════════════

require('dotenv').config();
const fetch = require('node-fetch');
const { extractOxapayFields } = require('./payments-oxapay');

const MERCHANT_API_KEY = process.env.OXAPAY_MERCHANT_API_KEY;
const CALLBACK_URL = process.env.OXAPAY_CALLBACK_URL;

async function main() {
  if (!MERCHANT_API_KEY || !CALLBACK_URL) {
    console.error('❌ OXAPAY_MERCHANT_API_KEY یا OXAPAY_CALLBACK_URL در .env تنظیم نشده. اول اینها را ست کن.');
    process.exit(1);
  }

  console.log('▶ در حال ساخت یک فاکتور تستی ۱ دلاری (USDT / TRC20)...\n');

  const body = {
    pay_currency: 'USDT',
    network: 'TRC20',
    amount: 1,
    currency: 'USD',
    to_currency: 'USDT',
    auto_withdrawal: false,
    lifetime: 15,
    callback_url: CALLBACK_URL,
    order_id: `TEST-${Date.now()}`,
    description: 'AJ Premium — تست اتصال زنده (این یک فاکتور واقعی نیست، فقط تست ساختار پاسخ است)',
  };

  const res = await fetch('https://api.oxapay.com/v1/payment/white-label', {
    method: 'POST',
    headers: { merchant_api_key: MERCHANT_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();
  console.log(`▶ کد وضعیت HTTP: ${res.status}\n`);
  console.log('▶ پاسخ خام کامل OxaPay:');
  console.log(rawText);
  console.log('');

  let json;
  try { json = JSON.parse(rawText); } catch {
    console.error('❌ پاسخ JSON معتبر نبود — احتمالاً کلید Merchant API اشتباه است یا حساب هنوز فعال نشده.');
    process.exit(1);
  }

  console.log(`▶ status داخلی پاکت OxaPay: ${json.status}`);
  console.log(`▶ message: ${json.message}`);
  if (json.error && Object.keys(json.error).length > 0) {
    console.log('▶ ⚠️ آبجکت error پر است (یعنی درخواست رد شده):', json.error);
  }

  const fields = extractOxapayFields(json);
  console.log('▶ فیلدهای استخراج‌شده توسط extractOxapayFields():');
  console.log(fields);

  if (fields.trackId && fields.address && fields.payAmount) {
    console.log('\n✅ استخراج موفق بود — payments-oxapay.js بدون هیچ تغییری با پاسخ واقعی OxaPay کار می‌کند.');
  } else {
    console.log('\n❌ یک یا چند فیلد پیدا نشد. بالا را نگاه کن ببین اسم واقعی فیلد track_id/address/amount توی پاسخ خام چیست،');
    console.log('   بعد در payments-oxapay.js تابع extractOxapayFields() را با همان اسم دقیق فیلد اصلاح کن (فقط همان یک تابع).');
  }
}

main().catch(err => {
  console.error('❌ خطای غیرمنتظره:', err);
  process.exit(1);
});
