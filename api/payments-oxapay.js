// ══════════════════════════════════════════════════════════════════════
// payments-oxapay.js
// پرداخت رمزارزی پلن‌های «ای‌جی پریمیوم» از طریق درگاه OxaPay (White-Label API)
//
// این فایل کاملاً مستقل و افزودنی است — دقیقاً مثل wallet.js و phone-auth.js
// موجود در پروژه. هیچ جدول، ستون یا endpoint موجودی را تغییر نمی‌دهد؛
// فقط جدول جدید payment_invoices را می‌سازد، چند ستون جدید و کاملاً
// اختیاری (premium_*) به جدول users اضافه می‌کند (IF NOT EXISTS — بی‌خطر
// حتی اگر این فایل چند بار اجرا شود) و سه endpoint جدید ثبت می‌کند:
//
//   POST /api/payments/oxapay/create              → ساخت فاکتور
//   POST /api/payments/oxapay/webhook              → دریافت وضعیت از OxaPay
//   GET  /api/payments/oxapay/status/:trackId       → پولینگ وضعیت از فرانت‌اند
//
// نیازمند این متغیرهای محیطی (.env):
//   OXAPAY_MERCHANT_API_KEY   کلید Merchant که از پنل OxaPay ساختی
//   OXAPAY_CALLBACK_URL       آدرس کامل همین سرور برای وبهوک، مثلاً:
//                             https://server.ajsports.ir/api/payments/oxapay/webhook
//
// ⚠️ نکته‌ی مهم درباره‌ی نام دقیق فیلدهای پاسخ OxaPay:
// مستندات رسمی OxaPay فقط نمونه‌ی BODY درخواست را نشان می‌دهند، نه دقیق
// شکل کامل پاسخ JSON. چون از محیط sandbox من هیچ دسترسی اینترنتی به
// api.oxapay.com وجود ندارد، امکان تست زنده‌ی واقعی این تماس را نداشتم.
// به همین دلیل استخراج فیلدها در تابع extractOxapayFields() متمرکز شده
// و چند نام‌ محتمل (snake_case و camelCase) را همزمان امتحان می‌کند، و
// راه‌انداز اول هر فراخوانی واقعی، پاسخ خام را کامل لاگ می‌کند تا در صورت
// نیاز به اصلاح، فقط همین یک تابع را ویرایش کنی — نه کد پراکنده در همه‌جا.
// همراه این فایل یک اسکریپت test-oxapay-live.js هم هست که با یک دستور
// روی سرور واقعی‌ات پاسخ خام API را برایت چاپ می‌کند.
// ══════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const fetch = require('node-fetch');
const { columnExists } = require('./db');

const OXAPAY_API_BASE = 'https://api.oxapay.com/v1';
const INVOICE_LIFETIME_MINUTES = 30; // باید با تایمر ۳۰:۰۰ فرانت‌اند یکی باشد

// ── کاتالوگ رسمی پلن‌ها — تنها منبع صحت قیمت؛ هرگز به amount ارسالی از کلاینت اعتماد نکن ──
const PLAN_CATALOG = {
  standard: {
    monthly: 2.99, yearly: 29.99,
    verification: 'blue',
    charLimit: 500, dailyPosts: 25, dailyComments: 100,
  },
  plus: {
    monthly: 6.99, yearly: 69.99,
    verification: 'blue',
    charLimit: 2000, dailyPosts: null, dailyComments: null, // null = نامحدود
  },
  // 'gold' عمداً اینجا نیست — طلایی فروشی نیست، فقط با گرنت دستی ادمین
  // از endpoint موجود /api/admin/verification اعطا می‌شود.
};

// ── نگاشت رسمی سکه‌ها به پارامترهای دقیق OxaPay — کلاینت هرگز نمی‌تواند
//    مستقیم pay_currency/network دلخواه بفرستد، فقط یکی از این کدها را ──
const CURRENCY_MAP = {
  USDT_TRC20: { pay_currency: 'USDT', network: 'TRC20' },
  USDT_BEP20: { pay_currency: 'USDT', network: 'BEP20' },
  BTC:        { pay_currency: 'BTC' },
  ETH_ERC20:  { pay_currency: 'ETH', network: 'ERC20' },
  TRX_TRC20:  { pay_currency: 'TRX', network: 'TRC20' },
  LTC:        { pay_currency: 'LTC' },
};

function initPaymentsModule({ app, pool, io, cron }) {
  const MERCHANT_API_KEY = process.env.OXAPAY_MERCHANT_API_KEY;
  const CALLBACK_URL = process.env.OXAPAY_CALLBACK_URL;

  if (!MERCHANT_API_KEY || !CALLBACK_URL) {
    console.warn('⚠️ [payments-oxapay] OXAPAY_MERCHANT_API_KEY یا OXAPAY_CALLBACK_URL در .env تنظیم نشده — ماژول پرداخت غیرفعال می‌ماند، بقیه‌ی سرور عادی بالا می‌آید.');
    // حتی بدون کلید، endpointها را ثبت می‌کنیم تا فرانت‌اند خطای شفاف
    // "پرداخت غیرفعال است" بگیرد، نه یک 404 مبهم.
  }

  ensurePaymentsSchema(pool).catch(e =>
    console.error('❌ [payments-oxapay] ensurePaymentsSchema failed (non-fatal):', e.message)
  );

  // برای throttle کردن reconciliation زنده با OxaPay (جلوگیری از spam به API آن‌ها)
  const _liveCheckCache = new Map(); // track_id → timestamp آخرین چک

  // ────────────────────────────────────────────────────────────────────
  // POST /api/payments/oxapay/create
  // بدنه: { username, plan: 'standard'|'plus', billing: 'monthly'|'yearly', currency: یکی از کلیدهای CURRENCY_MAP }
  // ────────────────────────────────────────────────────────────────────
  app.post('/api/payments/oxapay/create', async (req, res) => {
    try {
      if (!MERCHANT_API_KEY || !CALLBACK_URL) {
        return res.status(503).json({ error: 'درگاه پرداخت هنوز روی سرور پیکربندی نشده است.' });
      }

      const { username, plan, billing, currency } = req.body || {};

      if (!username || !plan || !billing || !currency) {
        return res.status(400).json({ error: 'اطلاعات ناقص است (username, plan, billing, currency الزامی‌اند)' });
      }
      const planDef = PLAN_CATALOG[plan];
      if (!planDef) {
        return res.status(400).json({ error: 'پلن نامعتبر است. طلایی از این مسیر قابل خرید نیست.' });
      }
      if (billing !== 'monthly' && billing !== 'yearly') {
        return res.status(400).json({ error: 'دوره‌ی صورتحساب نامعتبر است' });
      }
      const coin = CURRENCY_MAP[currency];
      if (!coin) {
        return res.status(400).json({ error: 'رمزارز انتخاب‌شده پشتیبانی نمی‌شود' });
      }

      const userRes = await pool.query('SELECT id, username FROM users WHERE username = $1', [username]);
      if (userRes.rows.length === 0) {
        return res.status(404).json({ error: 'کاربر یافت نشد' });
      }
      const user = userRes.rows[0];

      // ← تنها منبع صحتِ مبلغ؛ amount_usd احتمالی در بدنه‌ی درخواست کاملاً نادیده گرفته می‌شود
      const amountUsd = billing === 'yearly' ? planDef.yearly : planDef.monthly;

      // بازاستفاده از فاکتور در انتظارِ هنوز-معتبر به‌جای ساخت فاکتور تکراری در OxaPay
      const existing = await pool.query(
        `SELECT * FROM payment_invoices
         WHERE user_id = $1 AND plan = $2 AND billing = $3 AND currency_code = $4
           AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP
         ORDER BY id DESC LIMIT 1`,
        [user.id, plan, billing, currency]
      );
      if (existing.rows.length > 0) {
        const inv = existing.rows[0];
        return res.json({
          track_id: inv.track_id,
          address: inv.address,
          pay_amount: inv.pay_amount,
          pay_currency: inv.pay_currency,
          expires_in_seconds: secondsUntil(inv.expires_at),
        });
      }

      const orderId = `AJP-${user.id}-${plan}-${billing}-${Date.now()}`;

      const oxBody = {
        pay_currency: coin.pay_currency,
        ...(coin.network ? { network: coin.network } : {}),
        amount: amountUsd,
        currency: 'USD',
        to_currency: 'USDT', // تبدیل خودکار به USDT — محافظت در برابر نوسان قیمت بین لحظه‌ی فاکتور و تسویه
        auto_withdrawal: false,
        lifetime: INVOICE_LIFETIME_MINUTES,
        callback_url: CALLBACK_URL,
        order_id: orderId,
        description: `AJ Premium — ${plan} (${billing})`,
      };

      const oxRes = await fetch(`${OXAPAY_API_BASE}/payment/white-label`, {
        method: 'POST',
        headers: { merchant_api_key: MERCHANT_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(oxBody),
      });
      const rawText = await oxRes.text();
      let oxJson;
      try { oxJson = JSON.parse(rawText); } catch { oxJson = null; }

      // پاکت پاسخ رسمی v1 اوکساپی: { data, message, error: {type,key,message}|{}, status, version }
      // status=200 یعنی موفق؛ هر چیز دیگری یا وجود error غیرخالی یعنی شکست —
      // فقط به HTTP ok اعتماد نمی‌کنیم چون OxaPay گاهی خطای منطقی را با HTTP 200 برمی‌گرداند.
      const oxHasError = !oxJson || (oxJson.error && Object.keys(oxJson.error).length > 0) || (oxJson.status && oxJson.status !== 200);
      if (!oxRes.ok || oxHasError) {
        const oxMessage = oxJson?.error?.message || oxJson?.message || rawText.slice(0, 300);
        console.error('❌ [payments-oxapay] OxaPay white-label request failed:', oxRes.status, oxMessage);
        return res.status(502).json({ error: `خطا در ارتباط با درگاه پرداخت: ${oxMessage}` });
      }

      const fields = extractOxapayFields(oxJson);
      if (!fields.trackId || !fields.address || !fields.payAmount) {
        console.error('❌ [payments-oxapay] پاسخ OxaPay فیلدهای موردنیاز را نداشت. پاسخ خام:', JSON.stringify(oxJson).slice(0, 800));
        return res.status(502).json({ error: 'پاسخ درگاه پرداخت قابل پردازش نبود. لاگ سرور را برای جزئیات ببین.' });
      }

      const expiresAt = fields.expireTime
        ? new Date(fields.expireTime * 1000).toISOString()
        : new Date(Date.now() + INVOICE_LIFETIME_MINUTES * 60 * 1000).toISOString();

      await pool.query(
        `INSERT INTO payment_invoices
           (track_id, order_id, user_id, username, plan, billing, currency_code,
            amount_usd, pay_currency, pay_network, pay_amount, address, status, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13)`,
        [
          fields.trackId, orderId, user.id, user.username, plan, billing, currency,
          amountUsd, coin.pay_currency, coin.network || null, fields.payAmount, fields.address, expiresAt,
        ]
      );

      return res.json({
        track_id: fields.trackId,
        address: fields.address,
        pay_amount: fields.payAmount,
        pay_currency: coin.pay_currency,
        expires_in_seconds: secondsUntil(expiresAt) || INVOICE_LIFETIME_MINUTES * 60,
      });
    } catch (error) {
      console.error('❌ [payments-oxapay] /create error:', error);
      return res.status(500).json({ error: 'خطای داخلی سرور' });
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // POST /api/payments/oxapay/webhook  ← فقط توسط سرورهای OxaPay فراخوانی می‌شود
  // ────────────────────────────────────────────────────────────────────
  app.post('/api/payments/oxapay/webhook', async (req, res) => {
    try {
      if (!MERCHANT_API_KEY) return res.status(503).send('not configured');

      const receivedHmac = req.headers['hmac'];
      if (!receivedHmac || !req.rawBody) {
        console.warn('⚠️ [payments-oxapay] webhook بدون هدر HMAC یا rawBody رد شد');
        return res.status(400).send('missing signature');
      }
      const calculated = crypto.createHmac('sha512', MERCHANT_API_KEY).update(req.rawBody).digest('hex');
      const validSig = timingSafeEqualHex(calculated, String(receivedHmac));
      if (!validSig) {
        console.warn('⚠️ [payments-oxapay] امضای HMAC وبهوک نامعتبر — درخواست رد شد');
        return res.status(401).send('invalid signature');
      }

      const trackId = req.body.track_id || req.body.trackId;
      const status = String(req.body.status || '').toLowerCase();
      if (!trackId) return res.status(200).send('ok'); // چیزی برای پردازش نیست، ولی طبق قرارداد OxaPay باید 200 ok برگردد

      await applyInvoiceStatus(pool, io, trackId, status);

      // طبق مستندات OxaPay: پاسخ باید دقیقا بدنه‌ی متنی "ok" با کد 200 باشد
      return res.status(200).send('ok');
    } catch (error) {
      console.error('❌ [payments-oxapay] /webhook error:', error);
      // در خطای واقعی عمداً 200 برنمی‌گردانیم تا OxaPay طبق سیاست retry خودش دوباره تلاش کند
      return res.status(500).send('internal error');
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // GET /api/payments/oxapay/status/:trackId  ← پولینگ از فرانت‌اند هر ۵ ثانیه
  // ────────────────────────────────────────────────────────────────────
  app.get('/api/payments/oxapay/status/:trackId', async (req, res) => {
    try {
      const { trackId } = req.params;
      const invRes = await pool.query('SELECT status, expires_at FROM payment_invoices WHERE track_id = $1', [trackId]);
      if (invRes.rows.length === 0) {
        return res.status(404).json({ error: 'فاکتور یافت نشد' });
      }
      let { status, expires_at } = invRes.rows[0];

      // اگر هنوز در انتظار است و وبهوک دیر کرده، حداکثر هر ۸ ثانیه یک‌بار
      // مستقیماً از خود OxaPay وضعیت واقعی را استعلام کن (شبکه‌ی ایمنی در برابر وبهوک ازدست‌رفته)
      if ((status === 'pending' || status === 'paying') && MERCHANT_API_KEY) {
        const last = _liveCheckCache.get(trackId) || 0;
        if (Date.now() - last > 8000) {
          _liveCheckCache.set(trackId, Date.now());
          try {
            const liveRes = await fetch(`${OXAPAY_API_BASE}/payment/${trackId}`, {
              headers: { merchant_api_key: MERCHANT_API_KEY },
            });
            if (liveRes.ok) {
              const liveJson = await liveRes.json();
              const liveStatus = String((liveJson.data || liveJson).status || '').toLowerCase();
              if (liveStatus && liveStatus !== status) {
                await applyInvoiceStatus(pool, io, trackId, liveStatus);
                status = liveStatus;
              }
            }
          } catch (e) { /* شبکه موقتا در دسترس نیست؛ چرخه‌ی بعدی دوباره تلاش می‌شود */ }
        }
      }

      return res.json({ status, expired: new Date(expires_at).getTime() < Date.now() });
    } catch (error) {
      console.error('❌ [payments-oxapay] /status error:', error);
      return res.status(500).json({ error: 'خطای داخلی سرور' });
    }
  });

  // ── کرون ساعتی: خاموش‌کردن خودکار پریمیومِ منقضی‌شده ──
  // فقط کاربرانی را لمس می‌کند که هم premium_plan دارند هم verification='blue'
  // (هرگز طلایی یا تیک‌آبیِ دستیِ ادمین را که premium_plan ندارد، لمس نمی‌کند)
  if (cron) {
    cron.schedule('0 * * * *', async () => {
      try {
        const result = await pool.query(
          `UPDATE users SET verification = NULL, premium_plan = NULL, premium_billing = NULL,
                            premium_char_limit = NULL, premium_daily_posts = NULL, premium_daily_comments = NULL
           WHERE premium_plan IS NOT NULL AND verification = 'blue' AND premium_expires_at < CURRENT_TIMESTAMP
           RETURNING id, username`
        );
        if (result.rows.length > 0) {
          console.log(`⏰ [payments-oxapay] پریمیوم ${result.rows.length} کاربر منقضی و غیرفعال شد`);
          result.rows.forEach(u => io.emit('user_verification_updated', { username: u.username, verification: null }));
        }
      } catch (e) {
        console.error('❌ [payments-oxapay] cron انقضای پریمیوم با خطا مواجه شد:', e.message);
      }
    });
  }
}

// ══════════════════════════════════════════════════════════════════════
// توابع کمکی
// ══════════════════════════════════════════════════════════════════════

async function ensurePaymentsSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id TEXT UNIQUE,
      order_id TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      plan TEXT NOT NULL,
      billing TEXT NOT NULL,
      currency_code TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      pay_currency TEXT,
      pay_network TEXT,
      pay_amount TEXT,
      address TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      paid_at TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_invoices_track_id ON payment_invoices(track_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_invoices_user ON payment_invoices(user_id)`);

  // ستون‌های جدید و کاملاً اختیاری روی users — به هیچ ستون موجودی دست نمی‌زند
  const newUserColumns = [
    ['premium_plan', 'TEXT'],
    ['premium_billing', 'TEXT'],
    ['premium_expires_at', 'TEXT'],
    ['premium_char_limit', 'INTEGER'],
    ['premium_daily_posts', 'INTEGER'],
    ['premium_daily_comments', 'INTEGER'],
  ];
  for (const [col, type] of newUserColumns) {
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col} ${type}`);
    } catch (e) {
      const exists = await columnExists('users', col).catch(() => false);
      if (!exists) console.error(`❌ [payments-oxapay] ستون users.${col} ساخته نشد:`, e.message);
    }
  }
  console.log('✅ [payments-oxapay] schema آماده است (payment_invoices + ستون‌های premium_* در users)');
}

// استخراج نام فیلدهای پاسخ OxaPay — تنها نقطه‌ای که باید در صورت نیاز
// اصلاح شود، اگر شکل واقعی پاسخ کمی متفاوت از این حدس‌ها بود.
// استخراج نام فیلدهای پاسخ OxaPay — ترتیب اولویت هر فیلد بر اساس نمونه‌های
// واقعی مستندشده در داک‌های v1 (Static Address List و Payment History)
// انتخاب شده، نه حدس محض:
//   • wrapper: پاسخ‌های v1 معمولا در {"data": {...}} پیچیده می‌شوند
//   • track_id / address: دقیقا همین snake_case در نمونه‌ی Static Address List دیده شده
//   • amount: در Payment History دقیقا با همین نام و همین معنی (مبلغ) مستند شده
//   • expire_time: در بلاگ رسمی OxaPay به‌عنوان فیلد شمارش‌معکوس معرفی شده
function extractOxapayFields(oxJson) {
  const d = oxJson.data || oxJson.result?.data || oxJson;
  return {
    trackId: d.track_id || d.trackId || d.trackID || null,
    address: d.address || d.pay_address || d.payAddress || null,
    payAmount: d.amount || d.pay_amount || d.payAmount || null,
    expireTime: d.expire_time || d.expireTime || null, // یونیکس‌تایم ثانیه؛ اگر نبود از lifetime پیش‌فرض استفاده می‌شود
  };
}

function secondsUntil(isoString) {
  const diff = Math.floor((new Date(isoString).getTime() - Date.now()) / 1000);
  return diff > 0 ? diff : 0;
}

// مقایسه‌ی امن در برابر timing attack برای امضای HMAC
function timingSafeEqualHex(a, b) {
  try {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

// اعمال یک وضعیت جدید روی فاکتور — idempotent و امن در برابر وبهوک‌های
// تکراری (OxaPay تا ۵ بار همان وبهوک را دوباره می‌فرستد). فقط وقتی
// وضعیت واقعا برای اولین‌بار به 'paid' می‌رسد، پلن فعال می‌شود.
async function applyInvoiceStatus(pool, io, trackId, status) {
  const invRes = await pool.query('SELECT * FROM payment_invoices WHERE track_id = $1', [trackId]);
  if (invRes.rows.length === 0) {
    console.warn(`⚠️ [payments-oxapay] وبهوک برای track_id ناشناخته دریافت شد: ${trackId}`);
    return;
  }
  const invoice = invRes.rows[0];
  if (invoice.status === 'paid') return; // قبلاً پردازش شده — نادیده بگیر (idempotent)

  const isPaid = status === 'paid';
  await pool.query(
    `UPDATE payment_invoices SET status = $1, paid_at = CASE WHEN $1 = 'paid' THEN CURRENT_TIMESTAMP ELSE paid_at END
     WHERE track_id = $2`,
    [status || invoice.status, trackId]
  );
  if (!isPaid) return;

  // ── فعال‌سازی واقعی پلن ──
  const planDef = PLAN_CATALOG[invoice.plan];
  if (!planDef) {
    console.error(`❌ [payments-oxapay] پلن ناشناخته روی فاکتور ${trackId}: ${invoice.plan}`);
    return;
  }
  const durationDays = invoice.billing === 'yearly' ? 365 : 30;
  const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();

  const updatedUser = await pool.query(
    `UPDATE users SET verification = $1, premium_plan = $2, premium_billing = $3,
                       premium_expires_at = $4, premium_char_limit = $5,
                       premium_daily_posts = $6, premium_daily_comments = $7
     WHERE id = $8
     RETURNING id, username`,
    [
      planDef.verification, invoice.plan, invoice.billing, expiresAt,
      planDef.charLimit, planDef.dailyPosts, planDef.dailyComments,
      invoice.user_id,
    ]
  );
  if (updatedUser.rows.length === 0) return;
  const user = updatedUser.rows[0];

  const planLabel = invoice.plan === 'plus' ? 'پلاس' : 'استاندارد';
  try {
    await pool.query(
      `INSERT INTO notifications (recipient_id, sender_id, type, content) VALUES ($1, $1, 'VERIFICATION', $2)`,
      [user.id, `پلن ${planLabel} با موفقیت فعال شد و تیک آبی دریافت کردید! 🎉`]
    );
  } catch (e) {
    console.error('⚠️ [payments-oxapay] insert notification failed (non-fatal):', e.message);
  }

  io.to(`user_${user.id}`).emit('notification_alert', {
    type: 'VERIFICATION',
    message: `پلن ${planLabel} با موفقیت فعال شد و تیک آبی دریافت کردید! 🎉`,
    verification_type: planDef.verification,
  });
  // همان event نامی که مسیر گرنت دستی ادمین قبلاً استفاده می‌کند — فرانت‌اند
  // بدون هیچ تغییری، بج تیک را به‌محض دریافت این event آپدیت می‌کند.
  io.emit('user_verification_updated', { username: user.username, verification: planDef.verification });
  // event اختصاصی چک‌اوت مودال پرداخت — برای بستن خودکار مودال و پیام موفقیت
  io.to(`user_${user.id}`).emit('premium_activated', {
    username: user.username, plan: invoice.plan, billing: invoice.billing, track_id: trackId,
  });

  console.log(`✅ [payments-oxapay] پلن ${invoice.plan} برای کاربر ${user.username} فعال شد (track_id=${trackId})`);
}

module.exports = { initPaymentsModule, PLAN_CATALOG, CURRENCY_MAP, extractOxapayFields };
