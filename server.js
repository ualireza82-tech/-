require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cron = require('node-cron');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

// --- تنظیمات سرور ---
const app = express();
const server = http.createServer(app);

// لایه‌های امنیتی و پرفورمنس
app.use(helmet()); // محافظت از هدرهای HTTP
app.use(compression()); // فشرده‌سازی پاسخ‌ها برای سرعت بیشتر
app.use(cors({ origin: "*" })); // تنظیمات CORS
app.use(express.json());

// محدود کننده درخواست (جلوگیری از اسپم و حملات)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقیقه
  max: 1000 // حداکثر 1000 درخواست برای هر IP
});
app.use(limiter);

// تنظیمات Socket.io
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// اتصال به دیتابیس نئون
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// متغیرهای سیستم
let API_FOOTBALL_TOKEN = "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "AjPowerSecretKey2026";

// لود کردن تنظیمات
async function loadSystemConfig() {
  try {
    const res = await pool.query("SELECT value FROM system_config WHERE key = 'football_api_token'");
    if (res.rows.length > 0) API_FOOTBALL_TOKEN = res.rows[0].value;
    console.log('✅ System Config Loaded.');
  } catch (err) {
    console.error('❌ DB Error (Config):', err.message);
  }
}
loadSystemConfig();

// ======================================================
// 1. مدیریت کاربران (Auth & Search)
// ======================================================

// سینک اطلاعات کاربر (لاگین)
app.post('/api/auth/sync', async (req, res) => {
  const { email, username, avatar_url } = req.body;
  if (!email || !username) return res.status(400).json({ error: "Missing fields" });

  try {
    // اگر کاربر هست آپدیت کن، اگر نیست بساز
    const query = `
      INSERT INTO users (email, username, avatar_url)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) 
      DO UPDATE SET avatar_url = EXCLUDED.avatar_url, username = EXCLUDED.username
      RETURNING *;
    `;
    const result = await pool.query(query, [email, username, avatar_url]);
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error("Auth Sync Error:", err);
    res.status(500).json({ error: "Database sync failed" });
  }
});

// چک کردن نام کاربری (برای ثبت نام)
app.get('/api/users/check/:username', async (req, res) => {
  try {
    const result = await pool.query("SELECT id FROM users WHERE username = $1", [req.params.username]);
    res.json({ available: result.rows.length === 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// جستجوی کاربران (Search Engine)
app.get('/api/users/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  try {
    const result = await pool.query(
      "SELECT username, avatar_url, verification FROM users WHERE username ILIKE $1 LIMIT 10",
      [`%${q}%`]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// 2. سیستم تویت‌ها (Feed, Post, Like)
// ======================================================

// دریافت فید تویت‌ها (حل مشکل رفرش)
app.get('/api/tweets', async (req, res) => {
  try {
    const query = `
      SELECT t.*, u.username, u.avatar_url, u.verification,
      (SELECT COUNT(*) FROM likes WHERE tweet_id = t.id) as real_likes
      FROM tweets t
      JOIN users u ON t.user_id = u.id
      ORDER BY t.created_at DESC LIMIT 50
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ارسال تویت جدید
app.post('/api/tweets', async (req, res) => {
  const { username, content } = req.body;
  try {
    // 1. پیدا کردن ID کاربر از روی نام کاربری (جلوگیری از خطای کلید خارجی)
    const userRes = await pool.query("SELECT id, username, avatar_url, verification FROM users WHERE username = $1", [username]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: "User not found" });
    const user = userRes.rows[0];

    // 2. ذخیره تویت
    const insertRes = await pool.query(
      "INSERT INTO tweets (user_id, content) VALUES ($1, $2) RETURNING *",
      [user.id, content]
    );

    const newTweet = { 
      ...insertRes.rows[0], 
      username: user.username, 
      avatar_url: user.avatar_url, 
      verification: user.verification,
      real_likes: 0 
    };

    // 3. پخش زنده برای همه
    io.emit('new_tweet', newTweet);
    res.json({ success: true, tweet: newTweet });

  } catch (err) {
    console.error("Tweet Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// لایک کردن
app.post('/api/tweets/:id/like', async (req, res) => {
  const { username } = req.body;
  const tweetId = req.params.id;

  try {
    const userRes = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: "User not found" });
    const userId = userRes.rows[0].id;

    // پیدا کردن صاحب تویت
    const tweetRes = await pool.query("SELECT user_id FROM tweets WHERE id = $1", [tweetId]);
    if (tweetRes.rows.length === 0) return res.status(404).json({ error: "Tweet not found" });
    const ownerId = tweetRes.rows[0].user_id;

    // ثبت لایک
    await pool.query("INSERT INTO likes (user_id, tweet_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, tweetId]);
    
    // آپدیت شمارنده
    await pool.query("UPDATE tweets SET likes_count = likes_count + 1 WHERE id = $1", [tweetId]);

    // نوتیفیکیشن
    if (userId !== ownerId) {
      await pool.query(
        "INSERT INTO notifications (recipient_id, sender_id, type, reference_id) VALUES ($1, $2, 'LIKE', $3)",
        [ownerId, userId, tweetId]
      );
      io.to(`user_${ownerId}`).emit('notification_alert', { type: 'LIKE', message: `${username} liked your tweet!` });
    }

    io.emit('update_tweet_stats', { tweetId, action: 'like_added' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// 3. چت روم‌ها (Real-time & History)
// ======================================================

// دریافت تاریخچه پیام‌ها (برای زمانی که کاربر وارد روم می‌شود)
app.get('/api/rooms/:matchId/messages', async (req, res) => {
  try {
    const query = `
      SELECT m.content, m.created_at, u.username, u.avatar_url, u.verification
      FROM messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.match_id = $1
      ORDER BY m.created_at ASC
    `;
    const result = await pool.query(query, [req.params.matchId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// کرون جاب آپدیت روم‌ها
async function updateMatchRooms() {
  if (!API_FOOTBALL_TOKEN) return;
  try {
    // منطق آپدیت روم‌ها (بدون تغییر)
    const url = `https://apiv3.apifootball.com/?action=get_events&match_live=1&APIkey=${API_FOOTBALL_TOKEN}`;
    const response = await axios.get(url);
    if (Array.isArray(response.data)) {
      const liveMatches = response.data;
      const liveIds = liveMatches.map(m => m.match_id);
      
      for (const match of liveMatches) {
        await pool.query(`
          INSERT INTO match_rooms (match_id, home_team, away_team, status)
          VALUES ($1, $2, $3, 'LIVE')
          ON CONFLICT (match_id) DO UPDATE SET status = 'LIVE'`,
          [match.match_id, match.match_hometeam_name, match.match_awayteam_name]
        );
      }
      // بستن بازی‌های تمام شده
      if (liveIds.length > 0) {
        await pool.query("UPDATE match_rooms SET status = 'FINISHED' WHERE status = 'LIVE' AND match_id <> ALL($1::text[])", [liveIds]);
      } else {
        await pool.query("UPDATE match_rooms SET status = 'FINISHED' WHERE status = 'LIVE'");
      }
    }
  } catch (err) { console.error('Cron Update Error:', err.message); }
}
cron.schedule('*/3 * * * *', updateMatchRooms);

// لیست روم‌های زنده
app.get('/api/rooms/live', async (req, res) => {
  const result = await pool.query("SELECT * FROM match_rooms WHERE status = 'LIVE' ORDER BY created_at DESC");
  res.json(result.rows);
});

// ======================================================
// 4. سوکت‌ها (Chat & Notifications)
// ======================================================
io.on('connection', (socket) => {
  console.log(`Socket Connected: ${socket.id}`);

  // کانال اختصاصی نوتیفیکیشن کاربر
  socket.on('register_user', async (username) => {
    try {
      const res = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
      if (res.rows.length > 0) {
        socket.join(`user_${res.rows[0].id}`);
      }
    } catch (err) { console.error(err); }
  });

  // ورود به روم بازی
  socket.on('join_room', (matchId) => {
    socket.join(matchId);
  });

  // ارسال پیام
  socket.on('send_message', async (data) => {
    const { matchId, username, content } = data;
    try {
      // 1. اول پیدا کردن ID کاربر (مهم برای رفع ارور SQL)
      const userRes = await pool.query("SELECT id, avatar_url, verification FROM users WHERE username = $1", [username]);
      
      if (userRes.rows.length > 0) {
        const user = userRes.rows[0];

        // 2. ذخیره در دیتابیس
        await pool.query(
          "INSERT INTO messages (content, user_id, match_id) VALUES ($1, $2, $3)",
          [content, user.id, matchId]
        );

        // 3. ارسال به کلاینت‌ها
        io.to(matchId).emit('receive_message', {
          id: Date.now(),
          username: username,
          content: content,
          avatar: user.avatar_url,
          verification: user.verification,
          time: new Date().toISOString()
        });
      }
    } catch (err) {
      console.error("Chat Socket Error:", err.message);
    }
  });
});

// استارت
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Pro Server Running on Port ${PORT}`);
});
