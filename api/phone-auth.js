// ======================================================================
// phone-auth.js — احراز هویت شماره تلفن از طریق ربات تلگرام
// ======================================================================
// ماژول کاملاً مستقل و «افزودنی» (additive). هیچ تابع یا مسیر موجود در
// server.js را تغییر نمی‌دهد؛ فقط با ۲ خط در server.js نصب می‌شود:
//
//   const { initPhoneAuth } = require('./phone-auth');
//   initPhoneAuth({ app, io, pool });
//
// نیازمندی جدید (باید نصب شود):
//   npm install node-telegram-bot-api
//
// متغیر محیطی جدید در .env:
//   TELEGRAM_BOT_TOKEN=xxxxxxxxxx:yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
//
// روش اتصال به تلگرام: Long Polling (طبق درخواست صریح — بدون نیاز به
// دامنه یا Webhook، برای شروع/تست مناسب است؛ برای پروداکشن پرترافیک
// بعداً می‌توان به Webhook مهاجرت کرد).
// ======================================================================

const TelegramBot = require('node-telegram-bot-api');

// ----------------------------------------------------------------------
// جلسات موقت تایید شماره — در حافظه (in-memory). هر جلسه ۱۰ دقیقه اعتبار
// دارد. برای دیپلوی چند-اینستنسی (چند سرور) باید این Map به Redis منتقل
// شود؛ اما برای یک اینستنس Node.js (حالت فعلی پروژه) کاملاً کافی است.
// ----------------------------------------------------------------------
const sessions = new Map(); // sessionToken -> { phone, createdAt, chatId?, result? }
const SESSION_TTL_MS = 10 * 60 * 1000;
// 🔧 مدت نگه‌داریِ «نتیجه‌ی» یک جلسه‌ی تمام‌شده (موفق یا ناموفق) پس از اتمام،
// پیش از حذف قطعی. دلیل وجودش: اگر مرورگر کاربر هنگام دریافت رویداد سوکت
// در پس‌زمینه بوده باشد (مثلاً چون کاربر داخل اپ تلگرام است)، ممکن است اتصال
// Socket.io قطع/از روم خارج شده باشد و رویداد emit شده هرگز به او نرسد. با
// نگه‌داشتن نتیجه برای چند دقیقه، endpoint استعلام وضعیت (status) می‌تواند
// وقتی کاربر به سایت برمی‌گردد، نتیجه را مستقیم و قابل‌اتکا برگرداند —
// مستقل از این‌که رویداد لحظه‌ای سوکت رسیده باشد یا نه.
const RESULT_RETENTION_MS = 3 * 60 * 1000;

function scheduleSessionCleanup(token, delayMs) {
  setTimeout(() => { sessions.delete(token); }, delayMs).unref?.();
}

function makeToken() {
  return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function cleanupSessions() {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(token);
  }
}
setInterval(cleanupSessions, 60 * 1000).unref?.();

// فقط ارقام یک رشته‌ی خام را برمی‌گرداند (بدون +، فاصله، خط تیره و...).
function digitsOnly(raw) {
  return raw ? String(raw).replace(/[^\d]/g, '') : '';
}

// نرمال‌سازی یک شماره‌ی بین‌المللیِ کامل و آماده (مثلاً phone_number خروجی
// تلگرام، یا شماره‌ای که از قبل در دیتابیس با فرمت کامل ذخیره شده) به فرمت
// فقط-رقم. صفرِ ابتدایی در این سطح بی‌معناست چون هیچ کدکشوری با صفر شروع
// نمی‌شود، پس حذفش هم بی‌خطر است.
function normalizePhone(raw) {
  return digitsOnly(raw).replace(/^0+/, '');
}

// 🔧 نقطه‌ی اصلی رفع باگِ «عدم تطابق شماره‌ی یکسان»:
// کدکشور و شماره‌ی محلیِ واردشده در سایت را ترکیب می‌کند. نکته‌ی حیاتی این
// است که صفرِ ابتداییِ رایج در شماره‌های محلی (مثلاً ۰۹۱۲... در ایران) باید
// فقط از خودِ بخش محلی و *پیش از* چسباندن به کدکشور حذف شود؛ اگر ابتدا
// چسبانده و بعد نرمال شود (روش قبلی: normalizePhone(dialCode + phone))،
// آن صفر به‌جای حذف، وسط شماره باقی می‌ماند (مثلاً "98" + "0912..." →
// "980912..." به‌جای "98912...") و هرگز با شماره‌ی بین‌المللیِ برگشتی از
// تلگرام (که هرگز صفر ابتدایی ندارد) یکی نمی‌شود — even اگر دو شماره از نظر
// ظاهری برای کاربر کاملاً یکسان به نظر برسند.
function composeFullPhone(dialCode, localNumber) {
  const dial = digitsOnly(dialCode);
  const local = digitsOnly(localNumber).replace(/^0+/, '');
  return dial + local;
}

function initPhoneAuth({ app, io, pool }) {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN تنظیم نشده در .env — احراز هویت شماره تلفن غیرفعال است.');
    return;
  }

  // ---- 1) مهاجرت افزایشی دیتابیس (idempotent — امن برای اجرای مکرر) ----
  (async () => {
    try {
      await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20)");
      await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_phone_verified BOOLEAN DEFAULT false");
      console.log('✅ phone-auth: ستون‌های phone_number / is_phone_verified آماده‌اند.');
    } catch (e) {
      console.error('⚠️ phone-auth: مهاجرت دیتابیس ناموفق (غیر بحرانی):', e.message);
    }
  })();

  // ---- 2) راه‌اندازی ربات (Long Polling) ----
  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || ''; // مثلاً AJSportsVerifyBot (بدون @)

  const MSG = {
    fa: {
      start: (name) => `سلام ${name || ''}! 👋\nبرای تایید شماره تلفن در AJ Sports، لطفاً دکمه زیر را بزنید تا شماره حساب تلگرام شما به‌صورت امن ارسال شود.`,
      button: '📲 تایید و ارسال شماره تلفن',
      mismatch: '❌ خطای احراز هویت\nشماره ارسالی با شماره‌ای که در پلتفرم AJ Sports وارد کرده‌اید تطابق ندارد.\nبرای حفظ امنیت حساب کاربری، لطفاً مجدداً با شماره صحیح اقدام نمایید.',
      success: '✅ احراز هویت با موفقیت انجام شد\nحساب کاربری شما در سیستم یکپارچه AJ Sports با موفقیت تایید و ایمن‌سازی شد.\n\n🌐 اکنون می‌توانید به مرورگر (وب‌سایت) بازگردید.',
      expired: '⏱️ این درخواست منقضی شده است. لطفاً از سایت دوباره اقدام کنید.',
      invalidStart: 'این لینک نامعتبر است. لطفاً از داخل سایت AJ Sports دوباره اقدام کنید.',
    },
    en: {
      start: (name) => `Hi ${name || ''}! 👋\nTo verify your phone number on AJ Sports, please tap the button below to securely share your Telegram account's phone number.`,
      button: '📲 Verify & Share Phone Number',
      mismatch: '❌ Verification failed\nThe number you shared does not match the number you entered on AJ Sports.\nPlease try again with the correct number.',
      success: '✅ Verification successful\nYour AJ Sports account has been verified and secured.\n\n🌐 You can now return to your browser.',
      expired: '⏱️ This request has expired. Please start again from the website.',
      invalidStart: 'This link is invalid. Please start again from the AJ Sports website.',
    }
  };
  function tFor(langCode) {
    return (langCode || '').toLowerCase().startsWith('fa') ? MSG.fa : MSG.en;
  }

  // /start <sessionToken>[_LANG]
  bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const lang = tFor(msg.from && msg.from.language_code);
    const raw = (match && match[1] || '').trim();
    if (!raw) {
      bot.sendMessage(chatId, lang.invalidStart);
      return;
    }
    const [sessionToken] = raw.split('_LANG_');
    const session = sessions.get(sessionToken);
    if (!session) {
      bot.sendMessage(chatId, lang.expired);
      return;
    }
    session.chatId = chatId;
    session.lang = lang === MSG.fa ? 'fa' : 'en';

    bot.sendMessage(chatId, lang.start(msg.from && msg.from.first_name), {
      reply_markup: {
        keyboard: [[{ text: lang.button, request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      }
    });
  });

  bot.on('contact', async (msg) => {
    const chatId = msg.chat.id;
    // 🔧 رفع باگِ «مقایسه با جلسه‌ی کهنه»: اگر کاربر بیش از یک‌بار تلاش کرده
    // باشد (مثلاً تلاش اول ناموفق بوده)، ممکن است چند جلسه با همین chatId
    // در حافظه باقی مانده باشند. باید همیشه *جدیدترین* جلسه‌ی هنوز-درجریان
    // (بیشترین createdAt در میان جلسه‌های بدون result) انتخاب شود، نه اولین
    // موردی که در ترتیب درج به آن برمی‌خوریم؛ وگرنه تلاشِ تازه‌ی کاربر با
    // داده‌ی یک تلاشِ قدیمی و نامرتبط مقایسه می‌شود و even شماره‌ی کاملاً
    // درست هم «عدم تطابق» نشان داده می‌شود. جلسه‌هایی که از قبل result
    // دارند (یعنی قبلاً پردازش شده‌اند و فقط برای استعلام REST نگه داشته
    // شده‌اند) عمداً نادیده گرفته می‌شوند تا دوباره پردازش نشوند.
    let sessionToken = null, session = null;
    for (const [token, s] of sessions) {
      if (s.chatId === chatId && !s.result && (!session || s.createdAt > session.createdAt)) {
        sessionToken = token; session = s;
      }
    }
    const lang = (session && session.lang === 'fa') ? MSG.fa : tFor(msg.from && msg.from.language_code);
    if (!session) {
      bot.sendMessage(chatId, lang.expired);
      return;
    }

    // 🔒 جلوگیری از جعل شماره: فقط شماره‌ای که خودِ کاربر از دکمه‌ی
    // request_contact فرستاده (و متعلق به همان اکانت تلگرام است) پذیرفته
    // می‌شود؛ contact.user_id باید با فرستنده پیام یکی باشد.
    if (!msg.contact || msg.contact.user_id !== msg.from.id) {
      bot.sendMessage(chatId, lang.mismatch);
      // 🔧 به‌جای حذف فوری، نتیجه را روی جلسه ثبت می‌کنیم (برای استعلام
      // وضعیت از REST) و حذف قطعی را چند دقیقه به تعویق می‌اندازیم. به لطفِ
      // اصلاح انتخاب «جدیدترین جلسه» در بالا، این تأخیر باعث آلودگیِ تلاش
      // بعدیِ کاربر نمی‌شود.
      session.result = { ok: false, message: 'mismatch' };
      io.to(sessionToken).emit('phone_auth:error', { message: 'mismatch' });
      scheduleSessionCleanup(sessionToken, RESULT_RETENTION_MS);
      return;
    }

    const telegramPhone = normalizePhone(msg.contact.phone_number);
    const sitePhone = normalizePhone(session.phone);

    if (!telegramPhone || telegramPhone !== sitePhone) {
      bot.sendMessage(chatId, lang.mismatch);
      session.result = { ok: false, message: 'mismatch' };
      io.to(sessionToken).emit('phone_auth:error', { message: 'mismatch' });
      // 🔧 پاک‌سازی با تأخیر (نه فوری): تا endpoint استعلام وضعیت بتواند
      // این نتیجه را حتی اگر رویداد سوکت گم شده باشد برگرداند. به لطفِ
      // اصلاح «انتخاب جدیدترین جلسه»، این تأخیر تلاش بعدی را آلوده نمی‌کند.
      scheduleSessionCleanup(sessionToken, RESULT_RETENTION_MS);
      return;
    }

    try {
      const existing = await pool.query(
        "SELECT id, username, display_name, avatar_url, header_url, verification, bio, is_admin FROM users WHERE phone_number = $1",
        [sitePhone]
      );

      bot.sendMessage(chatId, lang.success);

      if (existing.rows.length > 0) {
        const u = existing.rows[0];
        await pool.query("UPDATE users SET is_phone_verified = true WHERE id = $1", [u.id]);
        const payload = { is_new_user: false, phone_number: sitePhone, user: u };
        session.result = { ok: true, ...payload };
        io.to(sessionToken).emit('phone_auth:success', payload);
      } else {
        // کاربر جدید یا کاربر ایمیلیِ موجود که می‌خواهد شماره اضافه کند —
        // تصمیم نهایی (ساخت اکانت تازه یا لینک کردن به اکانت فعلی) روی
        // فرانت‌اند/endpoint تکمیل پروفایل گذاشته می‌شود.
        const payload = { is_new_user: true, phone_number: sitePhone };
        session.result = { ok: true, ...payload };
        io.to(sessionToken).emit('phone_auth:success', payload);
      }
    } catch (e) {
      console.error('phone-auth contact handler error:', e);
      session.result = { ok: false, message: 'server_error' };
      io.to(sessionToken).emit('phone_auth:error', { message: 'server_error' });
    } finally {
      // 🔧 حذف با تأخیر (نه فوری): تا endpoint استعلام وضعیت بتواند نتیجه
      // را حتی اگر رویداد سوکت به‌خاطر قطعیِ موقتِ اتصال (پس‌زمینه رفتن
      // مرورگر هنگام بودن کاربر در اپ تلگرام) گم شده باشد، برگرداند.
      scheduleSessionCleanup(sessionToken, RESULT_RETENTION_MS);
    }
  });

  bot.on('polling_error', (err) => console.error('Telegram polling error:', err.message));

  // ---- 3) سوکت: عضویت مرورگر در روم مخصوص این جلسه ----
  io.on('connection', (socket) => {
    socket.on('phone_auth:join', (sessionToken) => {
      if (sessionToken && sessions.has(sessionToken)) socket.join(sessionToken);
    });
  });

  // ---- 3.۵) REST: استعلام وضعیت جلسه (راه‌حل قطعیِ گم‌شدنِ رویداد سوکت) ----
  // وقتی مرورگر کاربر به دلیل رفتن به اپ تلگرام در پس‌زمینه قرار می‌گیرد،
  // ممکن است اتصال Socket.io موقتاً قطع شود و رویدادِ emit‌شده‌ی سرور
  // (phone_auth:success/error) هرگز به او نرسد — چون در لحظه‌ی ارسال، هیچ
  // سوکتی در روم مربوطه حضور نداشته. این endpoint به فرانت‌اند اجازه می‌دهد
  // با بازگشت به سایت (visibilitychange)، مستقیماً و بدون وابستگی به سوکت،
  // وضعیت واقعی جلسه را از حافظه‌ی سرور بپرسد.
  app.get('/api/auth/phone/status/:token', (req, res) => {
    try {
      const { token } = req.params;
      const session = sessions.get(token);
      if (!session) {
        // یا هرگز وجود نداشته، یا کامل شده و پنجره‌ی نگهداری‌اش تمام شده،
        // یا منقضی شده (۱۰ دقیقه بدون فعالیت).
        return res.json({ pending: false, expired: true });
      }
      if (!session.result) {
        return res.json({ pending: true });
      }
      return res.json({ pending: false, ...session.result });
    } catch (e) {
      console.error('phone/status error:', e);
      res.status(500).json({ error: 'خطای سرور' });
    }
  });

  // ---- 4) REST: شروع جلسه‌ی تایید شماره ----
  // بدنه: { phone: "9123456789", dialCode: "+98", lang: "fa" }
  app.post('/api/auth/phone/start', (req, res) => {
    try {
      const { phone, dialCode, lang } = req.body || {};
      if (!phone || !dialCode) {
        return res.status(400).json({ error: 'شماره تلفن و کد کشور الزامی است' });
      }
      const full = composeFullPhone(dialCode, phone);
      const sessionToken = makeToken();
      sessions.set(sessionToken, { phone: full, createdAt: Date.now(), lang: lang === 'fa' ? 'fa' : 'en' });

      const startParam = `${sessionToken}${lang === 'fa' ? '_LANG_fa' : ''}`;
      const botLink = BOT_USERNAME
        ? `https://t.me/${BOT_USERNAME}?start=${startParam}`
        : null;

      res.json({ success: true, sessionToken, botLink });
    } catch (e) {
      console.error('phone/start error:', e);
      res.status(500).json({ error: 'خطای سرور' });
    }
  });

  // ---- 5) REST: آیا این شماره از قبل اکانت دارد؟ (مثل check-account ایمیل) ----
  app.post('/api/auth/phone/check-account', async (req, res) => {
    try {
      const { phone, dialCode } = req.body || {};
      if (!phone || !dialCode) return res.status(400).json({ error: 'شماره تلفن الزامی است' });
      const full = composeFullPhone(dialCode, phone);

      const result = await pool.query(
        "SELECT id, username, display_name, avatar_url, header_url, verification, bio, is_admin, is_phone_verified FROM users WHERE phone_number = $1",
        [full]
      );
      if (result.rows.length > 0) {
        return res.json({ exists: true, has_profile: true, user: result.rows[0] });
      }
      return res.json({ exists: false, has_profile: false });
    } catch (e) {
      console.error('phone/check-account error:', e);
      res.status(500).json({ error: 'خطای سرور' });
    }
  });

  // ---- 6) REST: افزودن/تایید شماره برای کاربر ایمیلیِ از قبل لاگین‌شده ----
  // بدنه: { userId, phone, dialCode }  → همان جریان بات را اجرا می‌کند؛
  // نتیجه از طریق همان سوکت phone_auth:success با فیلد link_to_user_id می‌آید.
  app.post('/api/auth/phone/attach', async (req, res) => {
    try {
      const { userId, phone, dialCode, lang } = req.body || {};
      if (!userId || !phone || !dialCode) {
        return res.status(400).json({ error: 'اطلاعات ناقص است' });
      }
      const full = composeFullPhone(dialCode, phone);

      const dup = await pool.query("SELECT id FROM users WHERE phone_number = $1 AND id != $2", [full, userId]);
      if (dup.rows.length > 0) {
        return res.status(409).json({ error: 'این شماره قبلاً برای حساب دیگری ثبت شده است' });
      }

      const sessionToken = makeToken();
      sessions.set(sessionToken, { phone: full, createdAt: Date.now(), lang: lang === 'fa' ? 'fa' : 'en', attachUserId: userId });

      const startParam = `${sessionToken}${lang === 'fa' ? '_LANG_fa' : ''}`;
      const botLink = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=${startParam}` : null;

      // ثبت اولیه‌ی شماره (هنوز تایید نشده) روی رکورد کاربر، تا وبهوک contact
      // بتواند بعد از تایید مستقیماً is_phone_verified را true کند.
      await pool.query("UPDATE users SET phone_number = $1, is_phone_verified = false WHERE id = $2", [full, userId]);

      res.json({ success: true, sessionToken, botLink });
    } catch (e) {
      console.error('phone/attach error:', e);
      res.status(500).json({ error: 'خطای سرور' });
    }
  });

  console.log('✅ phone-auth: ماژول احراز هویت شماره تلفن با موفقیت راه‌اندازی شد.');
}

module.exports = { initPhoneAuth };
