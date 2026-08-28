// ======================================================================
// wallet.js — ماژول کیف‌پول غیرکاستودیال + فروشگاه درون‌برنامه‌ای (AJ Sports)
// ======================================================================
// معماری:
//   1) کیف‌پول کاربر (متامسک/TrustWallet) فقط READ-ONLY خونده می‌شه —
//      پلتفرم هیچ‌وقت دارایی واقعی کاربر رو نگه نمی‌داره (غیرکاستودیال).
//   2) AJP (AJ Points) یک امتیاز داخلی و غیرقابل‌تبدیل به پول واقعیه —
//      دقیقاً هم‌خانواده‌ی total_xp موجود در جدول user_gamification.
//      روی جدول user_gamification یک ستون ajp_balance اضافه می‌شه؛
//      هیچ جدول یا منطق موجود دست‌نخورده باقی می‌مونه.
//   3) خرید تیک آبی/طلایی و آیتم‌های فروشگاه با دو روش:
//        الف) AJP داخلی → کسر فوری، بدون بلاکچین
//        ب) USDT (شبکه BEP20) → کاربر مستقیم به آدرس پلتفرم واریز می‌کنه،
//           بک‌اند با BscScan API (رایگان) تراکنش رو روی زنجیره تایید می‌کنه
//   نکته‌ی امنیتی حیاتی: هر tx_hash فقط یک‌بار قابل استفاده‌ست
//   (UNIQUE constraint) تا از حمله‌ی «استفاده‌ی مجدد از یک تراکنش» جلوگیری شه.
// ======================================================================

const USDT_BEP20_CONTRACT = '0x55d398326f99059ff775485246999027b3197955'; // آدرس رسمی USDT روی BSC
const BSCSCAN_API = 'https://api.bscscan.com/api';

// آدرس کیف‌پول دریافتی پلتفرم — باید در .env ست بشه (PLATFORM_WALLET_ADDRESS)
// این آدرس رو خودتون با متامسک/هر کیف‌پول امنی می‌سازید و کلید خصوصی‌اش
// را هرگز روی سرور قرار نمی‌دهید — فقط آدرس عمومی برای دریافت لازم است.

// ----------------------------------------------------------------------
// فروشگاه — قیمت‌ها به AJP و به USDT (قابل تغییر بدون دیپلوی مجدد چون از DB میاد)
// ----------------------------------------------------------------------
const DEFAULT_SHOP_ITEMS = [
  { item_key: 'blue_tick',   title_fa: 'تیک آبی',        category: 'verification', price_ajp: 500,  price_usdt: 5,  effect_type: 'verification', effect_value: 'blue' },
  { item_key: 'gold_tick',   title_fa: 'تیک طلایی',      category: 'verification', price_ajp: 2000, price_usdt: 20, effect_type: 'verification', effect_value: 'gold' },
  { item_key: 'name_color_gold', title_fa: 'رنگ نام طلایی', category: 'cosmetic', price_ajp: 100, price_usdt: 1, effect_type: 'name_color', effect_value: '#f4c430' },
  { item_key: 'name_color_red',  title_fa: 'رنگ نام قرمز',  category: 'cosmetic', price_ajp: 100, price_usdt: 1, effect_type: 'name_color', effect_value: '#f4212e' },
];

// کش ساده‌ی درون‌حافظه‌ای برای قیمت‌ها (رایگان، بدون نیاز به Redis)
let _priceCache = { data: null, ts: 0 };
const PRICE_CACHE_TTL_MS = 30_000;

async function fetchLivePrices() {
  if (_priceCache.data && Date.now() - _priceCache.ts < PRICE_CACHE_TTL_MS) {
    return _priceCache.data;
  }
  const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbols=["BTCUSDT","ETHUSDT","BNBUSDT"]');
  const rows = await res.json();
  const prices = { USDT: 1 };
  for (const r of rows) {
    prices[r.symbol.replace('USDT', '')] = parseFloat(r.price);
  }
  _priceCache = { data: prices, ts: Date.now() };
  return prices;
}

async function fetchBscBalance(address, contract) {
  const key = process.env.BSCSCAN_API_KEY || '';
  const url = `${BSCSCAN_API}?module=account&action=tokenbalance&contractaddress=${contract}&address=${address}&tag=latest&apikey=${key}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== '1') return 0;
  return Number(data.result) / 1e18;
}

async function fetchBnbBalance(address) {
  const key = process.env.BSCSCAN_API_KEY || '';
  const url = `${BSCSCAN_API}?module=account&action=balance&address=${address}&tag=latest&apikey=${key}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== '1') return 0;
  return Number(data.result) / 1e18;
}

// ----------------------------------------------------------------------
// اتصال یک تراکنش واریزی روی زنجیره برای تایید خرید
// ----------------------------------------------------------------------
async function fetchBscTxByHash(txHash) {
  const key = process.env.BSCSCAN_API_KEY || '';
  const url = `${BSCSCAN_API}?module=proxy&action=eth_getTransactionReceipt&txhash=${txHash}&apikey=${key}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.result || null;
}

// ======================================================================
// ensureWalletSchema — هم‌سبک با ensureQuoteTweetColumn موجود در server.js
// کاملاً idempotent، فقط ستون/جدول اضافه می‌کند، هیچ داده‌ای حذف نمی‌شود
// ======================================================================
async function ensureWalletSchema(pool) {
  try {
    await pool.query(`ALTER TABLE user_gamification ADD COLUMN IF NOT EXISTS ajp_balance INTEGER NOT NULL DEFAULT 0`);
  } catch (e) { /* بی‌خطر — یعنی ستون از قبل بوده */ }

  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name_color VARCHAR(16)`);
  } catch (e) {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_wallets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE,
      address VARCHAR(64) NOT NULL,
      chain VARCHAR(16) NOT NULL DEFAULT 'bsc',
      connected_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_items (
      id SERIAL PRIMARY KEY,
      item_key VARCHAR(64) NOT NULL UNIQUE,
      title_fa VARCHAR(128) NOT NULL,
      category VARCHAR(32) NOT NULL,
      price_ajp INTEGER NOT NULL DEFAULT 0,
      price_usdt REAL NOT NULL DEFAULT 0,
      effect_type VARCHAR(32) NOT NULL,
      effect_value VARCHAR(64) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      item_key VARCHAR(64) NOT NULL,
      method VARCHAR(16) NOT NULL,          -- 'ajp' | 'usdt_bep20'
      amount REAL NOT NULL,
      tx_hash VARCHAR(128) UNIQUE,          -- فقط برای usdt_bep20 — یکتا، ضد سوءاستفاده
      status VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending | confirmed | failed
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMP
    )
  `);

  // بذر اولیه‌ی فروشگاه — فقط اگر خالی باشه
  const existing = await pool.query(`SELECT COUNT(*) as c FROM shop_items`);
  if (parseInt(existing.rows[0].c) === 0) {
    for (const it of DEFAULT_SHOP_ITEMS) {
      await pool.query(
        `INSERT INTO shop_items (item_key, title_fa, category, price_ajp, price_usdt, effect_type, effect_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [it.item_key, it.title_fa, it.category, it.price_ajp, it.price_usdt, it.effect_type, it.effect_value]
      );
    }
  }
}

// اعمال اثر خرید روی حساب کاربر (تیک، رنگ نام و ...)
async function applyPurchaseEffect(pool, userId, item) {
  if (item.effect_type === 'verification') {
    await pool.query(`UPDATE users SET verification = $1 WHERE id = $2`, [item.effect_value, userId]);
  } else if (item.effect_type === 'name_color') {
    await pool.query(`UPDATE users SET name_color = $1 WHERE id = $2`, [item.effect_value, userId]);
  }
}

function initWalletModule({ app, pool, io }) {
  // این پرامیس رو نگه می‌داریم تا هر route قبل از اجرا صبر کنه جدول‌ها ساخته شده باشن —
  // جلوگیری از race condition در لحظه‌ی cold start (اولین درخواست‌ها بعد از استارت سرور)
  // که می‌تونست باعث خطای «no such table» بشه حتی وقتی خودِ کوئری‌ها درست بودن.
  const schemaReady = ensureWalletSchema(pool).catch(e => {
    console.error('Wallet schema ensure failed:', e.message);
    throw e;
  });

  // ── اتصال آدرس کیف‌پول (فقط ثبت آدرس عمومی، هیچ کلیدی رد و بدل نمی‌شود) ──
  app.post('/api/wallet/connect', async (req, res) => {
    try {
      await schemaReady;
      const { user_id, address, chain } = req.body;
      if (!user_id || !address) return res.status(400).json({ success: false, error: 'user_id و address الزامی است' });

      await pool.query(
        `INSERT INTO user_wallets (user_id, address, chain, connected_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (user_id) DO UPDATE SET address = $2, chain = $3, connected_at = NOW()`,
        [user_id, address, chain || 'bsc']
      );
      res.json({ success: true });
    } catch (err) {
      console.error('wallet/connect error:', err);
      res.status(500).json({ success: false, error: 'خطای سرور' });
    }
  });

  // ── نمای کامل کیف‌پول: آدرس متصل + موجودی واقعی on-chain + AJP داخلی ──
  app.get('/api/wallet/:userId', async (req, res) => {
    try {
      await schemaReady;
      const { userId } = req.params;

      const [walletRow, gamRow] = await Promise.all([
        pool.query(`SELECT address, chain FROM user_wallets WHERE user_id = $1`, [userId]),
        pool.query(`SELECT ajp_balance FROM user_gamification WHERE user_id = $1`, [userId]),
      ]);

      const ajpBalance = gamRow.rows[0]?.ajp_balance || 0;
      const wallet = walletRow.rows[0] || null;

      let assets = [];
      let totalUsd = 0;

      if (wallet) {
        const prices = await fetchLivePrices();
        const [bnb, usdt] = await Promise.all([
          fetchBnbBalance(wallet.address),
          fetchBscBalance(wallet.address, USDT_BEP20_CONTRACT),
        ]);
        const bnbUsd = bnb * (prices.BNB || 0);
        const usdtUsd = usdt * 1;
        totalUsd = bnbUsd + usdtUsd;
        assets = [
          { symbol: 'BNB', balance: bnb, usd_value: bnbUsd },
          { symbol: 'USDT', balance: usdt, usd_value: usdtUsd },
        ];
      }

      res.json({
        success: true,
        connected: !!wallet,
        address: wallet?.address || null,
        chain: wallet?.chain || null,
        ajp_balance: ajpBalance,
        total_usd_value: totalUsd,
        assets,
        platform_deposit_address: process.env.PLATFORM_WALLET_ADDRESS || null,
      });
    } catch (err) {
      console.error('wallet/get error:', err);
      res.status(500).json({ success: false, error: 'خطای دریافت موجودی' });
    }
  });

  // ── فروشگاه ──
  app.get('/api/wallet/shop', async (req, res) => {
    try {
      await schemaReady;
      const items = await pool.query(`SELECT * FROM shop_items WHERE is_active = true ORDER BY id ASC`);
      res.json({ success: true, items: items.rows });
    } catch (err) {
      res.status(500).json({ success: false, error: 'خطای سرور' });
    }
  });

  // ── مرحله ۱ خرید: شروع سفارش ──
  app.post('/api/wallet/purchase/initiate', async (req, res) => {
    try {
      await schemaReady;
      const { user_id, item_key, method } = req.body;
      const itemRes = await pool.query(`SELECT * FROM shop_items WHERE item_key = $1 AND is_active = true`, [item_key]);
      const item = itemRes.rows[0];
      if (!item) return res.status(404).json({ success: false, error: 'آیتم یافت نشد' });

      if (method === 'ajp') {
        const gamRes = await pool.query(`SELECT ajp_balance FROM user_gamification WHERE user_id = $1`, [user_id]);
        const balance = gamRes.rows[0]?.ajp_balance || 0;
        if (balance < item.price_ajp) {
          return res.status(400).json({ success: false, error: 'موجودی AJP کافی نیست', required: item.price_ajp, balance });
        }
        await pool.query(`UPDATE user_gamification SET ajp_balance = ajp_balance - $1 WHERE user_id = $2`, [item.price_ajp, user_id]);
        await pool.query(
          `INSERT INTO wallet_transactions (user_id, item_key, method, amount, status, confirmed_at) VALUES ($1,$2,'ajp',$3,'confirmed',NOW())`,
          [user_id, item_key, item.price_ajp]
        );
        await applyPurchaseEffect(pool, user_id, item);
        io?.to(`user_${user_id}`)?.emit('wallet:purchase_confirmed', { item_key });
        return res.json({ success: true, status: 'confirmed', method: 'ajp' });
      }

      if (method === 'usdt_bep20') {
        if (!process.env.PLATFORM_WALLET_ADDRESS) {
          return res.status(500).json({ success: false, error: 'آدرس دریافتی پلتفرم تنظیم نشده است' });
        }
        await pool.query(
          `INSERT INTO wallet_transactions (user_id, item_key, method, amount, status) VALUES ($1,$2,'usdt_bep20',$3,'pending')`,
          [user_id, item_key, item.price_usdt]
        );
        return res.json({
          success: true,
          status: 'awaiting_payment',
          deposit_address: process.env.PLATFORM_WALLET_ADDRESS,
          chain: 'BEP20',
          token: 'USDT',
          amount: item.price_usdt,
        });
      }

      res.status(400).json({ success: false, error: 'روش پرداخت نامعتبر' });
    } catch (err) {
      console.error('wallet/purchase/initiate error:', err);
      res.status(500).json({ success: false, error: 'خطای سرور' });
    }
  });

  // ── مرحله ۲ خرید (فقط برای USDT): تایید on-chain با tx_hash ──
  app.post('/api/wallet/purchase/confirm', async (req, res) => {
    try {
      await schemaReady;
      const { user_id, item_key, tx_hash } = req.body;
      if (!tx_hash) return res.status(400).json({ success: false, error: 'tx_hash الزامی است' });

      const pending = await pool.query(
        `SELECT * FROM wallet_transactions WHERE user_id = $1 AND item_key = $2 AND status = 'pending' ORDER BY id DESC LIMIT 1`,
        [user_id, item_key]
      );
      const txRow = pending.rows[0];
      if (!txRow) return res.status(404).json({ success: false, error: 'سفارش در انتظاری یافت نشد' });

      // جلوگیری از استفاده‌ی مجدد از یک تراکنش برای دو خرید
      const already = await pool.query(`SELECT id FROM wallet_transactions WHERE tx_hash = $1`, [tx_hash]);
      if (already.rows.length > 0) {
        return res.status(400).json({ success: false, error: 'این تراکنش قبلاً استفاده شده است' });
      }

      const receipt = await fetchBscTxByHash(tx_hash);
      if (!receipt || receipt.status !== '0x1') {
        return res.status(400).json({ success: false, error: 'تراکنش روی زنجیره تایید نشد یا هنوز maining نشده' });
      }

      const platformAddr = (process.env.PLATFORM_WALLET_ADDRESS || '').toLowerCase();
      const usdtTransferLog = (receipt.logs || []).find(
        l => l.address?.toLowerCase() === USDT_BEP20_CONTRACT.toLowerCase() &&
             '0x' + l.topics?.[2]?.slice(-40) === '0x' + platformAddr.slice(2)
      );
      if (!usdtTransferLog) {
        return res.status(400).json({ success: false, error: 'واریز به آدرس پلتفرم پیدا نشد' });
      }
      const transferredAmount = parseInt(usdtTransferLog.data, 16) / 1e18;
      if (transferredAmount < txRow.amount * 0.98) { // ۲٪ تلورانس نوسان/دقت اعشار
        return res.status(400).json({ success: false, error: 'مبلغ واریزی کمتر از مبلغ لازم است' });
      }

      const itemRes = await pool.query(`SELECT * FROM shop_items WHERE item_key = $1`, [item_key]);
      const item = itemRes.rows[0];

      await pool.query(
        `UPDATE wallet_transactions SET status = 'confirmed', tx_hash = $1, confirmed_at = NOW() WHERE id = $2`,
        [tx_hash, txRow.id]
      );
      await applyPurchaseEffect(pool, user_id, item);
      io?.to(`user_${user_id}`)?.emit('wallet:purchase_confirmed', { item_key });

      res.json({ success: true, status: 'confirmed' });
    } catch (err) {
      console.error('wallet/purchase/confirm error:', err);
      res.status(500).json({ success: false, error: 'خطای تایید تراکنش' });
    }
  });

  // ── تاریخچه ──
  app.get('/api/wallet/:userId/history', async (req, res) => {
    try {
      await schemaReady;
      const rows = await pool.query(
        `SELECT item_key, method, amount, status, created_at, confirmed_at
         FROM wallet_transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 50`,
        [req.params.userId]
      );
      res.json({ success: true, history: rows.rows });
    } catch (err) {
      res.status(500).json({ success: false, error: 'خطای سرور' });
    }
  });
}

module.exports = { initWalletModule };
