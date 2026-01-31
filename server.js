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
const morgan = require('morgan'); // لاگ‌برداری درخواست‌ها
const xss = require('xss'); // جلوگیری از XSS در متن‌ها
const { z } = require('zod'); // اعتبارسنجی داده‌ها

// --- تنظیمات سرور ---
const app = express();
const server = http.createServer(app);

// لایه‌های امنیتی و پرفورمنس
app.use(helmet()); 
app.use(compression()); 
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }));
app.use(express.json({ limit: '10kb' })); // محدودیت سایز بادی برای امنیت
app.use(morgan('tiny')); // لاگ درخواست‌های HTTP

// محدود کننده درخواست (Rate Limiting)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// تنظیمات Socket.io با پرفورمنس بالا
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000, // پایداری اتصال
  transports: ['websocket', 'polling']
});

// اتصال به دیتابیس نئون با تنظیمات Pool بهینه
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20, // حداکثر کانکشن همزمان
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// هندلینگ خطای اتصال دیتابیس
pool.on('error', (err) => {
  console.error('❌ Unexpected Error on Idle Client', err);
  process.exit(-1);
});

// متغیرهای سیستم
let API_FOOTBALL_TOKEN = "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "AjPowerSecretKey2026";

// لود کردن تنظیمات سیستم
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
// Helper: Schemas (Zod Validation)
// ======================================================
const UserSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(30),
  avatar_url: z.string().url().optional().or(z.literal(''))
});

const TweetSchema = z.object({
  username: z.string(),
  content: z.string().min(1).max(500)
});

// ======================================================
// 1. مدیریت کاربران (Auth, Search, Follow)
// ======================================================

// سینک اطلاعات کاربر
app.post('/api/auth/sync', async (req, res) => {
  try {
    const { email, username, avatar_url } = UserSchema.parse(req.body);
    
    const query = `
      INSERT INTO users (email, username, avatar_url, last_active)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (email) 
      DO UPDATE SET 
        avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url), 
        username = EXCLUDED.username,
        last_active = NOW()
      RETURNING *;
    `;
    const result = await pool.query(query, [email, username, avatar_url]);
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    console.error("Auth Sync Error:", err);
    res.status(500).json({ error: "Database sync failed" });
  }
});

// پروفایل کاربر (شامل تعداد فالوور/فالویینگ) - جدید
app.get('/api/users/profile/:username', async (req, res) => {
  try {
    const query = `
      SELECT u.id, u.username, u.avatar_url, u.verification, u.bio,
      (SELECT COUNT(*) FROM follows WHERE following_id = u.id) as followers_count,
      (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) as following_count,
      (SELECT COUNT(*) FROM tweets WHERE user_id = u.id) as tweets_count
      FROM users u
      WHERE u.username = $1
    `;
    const result = await pool.query(query, [req.params.username]);
    if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// چک کردن نام کاربری
app.get('/api/users/check/:username', async (req, res) => {
  try {
    const result = await pool.query("SELECT id FROM users WHERE username = $1", [req.params.username]);
    res.json({ available: result.rows.length === 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// جستجوی کاربران
app.get('/api/users/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  try {
    const result = await pool.query(
      "SELECT username, avatar_url, verification FROM users WHERE username ILIKE $1 LIMIT 10",
      [`%${xss(q)}%`] // Sanitize input
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// فالو کردن / آنفالو کردن - جدید
app.post('/api/users/follow', async (req, res) => {
  const { followerUsername, targetUsername } = req.body;
  try {
    const followerRes = await pool.query("SELECT id FROM users WHERE username = $1", [followerUsername]);
    const targetRes = await pool.query("SELECT id FROM users WHERE username = $1", [targetUsername]);

    if (!followerRes.rows.length || !targetRes.rows.length) return res.status(404).json({ error: "User not found" });

    const followerId = followerRes.rows[0].id;
    const targetId = targetRes.rows[0].id;

    if (followerId === targetId) return res.status(400).json({ error: "Cannot follow yourself" });

    // بررسی وضعیت فعلی
    const check = await pool.query("SELECT * FROM follows WHERE follower_id = $1 AND following_id = $2", [followerId, targetId]);

    if (check.rows.length > 0) {
      // Unfollow
      await pool.query("DELETE FROM follows WHERE follower_id = $1 AND following_id = $2", [followerId, targetId]);
      res.json({ status: 'unfollowed' });
    } else {
      // Follow
      await pool.query("INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)", [followerId, targetId]);
      
      // نوتیفیکیشن
      await pool.query(
        "INSERT INTO notifications (recipient_id, sender_id, type) VALUES ($1, $2, 'FOLLOW')",
        [targetId, followerId]
      );
      io.to(`user_${targetId}`).emit('notification_alert', { type: 'FOLLOW', message: `${followerUsername} started following you.` });
      
      res.json({ status: 'followed' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// 2. سیستم تویت‌ها (Feed, Reply, Like)
// ======================================================

// دریافت فید تویت‌ها (با پشتیبانی از Pagination و شمارش ریپلای)
app.get('/api/tweets', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 50;
  const offset = (page - 1) * limit;

  try {
    const query = `
      SELECT t.*, u.username, u.avatar_url, u.verification,
      (SELECT COUNT(*) FROM likes WHERE tweet_id = t.id) as real_likes,
      (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count
      FROM tweets t
      JOIN users u ON t.user_id = u.id
      WHERE t.parent_id IS NULL -- فقط تویت‌های اصلی را بیار (نه ریپلای‌ها)
      ORDER BY t.created_at DESC 
      LIMIT $1 OFFSET $2
    `;
    const result = await pool.query(query, [limit, offset]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// دریافت جزئیات یک تویت و ریپلای‌های آن - جدید
app.get('/api/tweets/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // خود تویت
    const tweetQuery = `
      SELECT t.*, u.username, u.avatar_url, u.verification,
      (SELECT COUNT(*) FROM likes WHERE tweet_id = t.id) as real_likes
      FROM tweets t
      JOIN users u ON t.user_id = u.id
      WHERE t.id = $1
    `;
    const tweetRes = await pool.query(tweetQuery, [id]);
    if (tweetRes.rows.length === 0) return res.status(404).json({ error: "Tweet not found" });

    // ریپلای‌ها
    const repliesQuery = `
      SELECT t.*, u.username, u.avatar_url, u.verification,
      (SELECT COUNT(*) FROM likes WHERE tweet_id = t.id) as real_likes
      FROM tweets t
      JOIN users u ON t.user_id = u.id
      WHERE t.parent_id = $1
      ORDER BY t.created_at ASC
    `;
    const repliesRes = await pool.query(repliesQuery, [id]);

    res.json({ tweet: tweetRes.rows[0], replies: repliesRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ارسال تویت جدید یا ریپلای
app.post('/api/tweets', async (req, res) => {
  try {
    const { username, content, parentId } = req.body; // parentId اختیاری برای ریپلای
    
    // اعتبارسنجی
    TweetSchema.parse({ username, content });
    const cleanContent = xss(content);

    const userRes = await pool.query("SELECT id, username, avatar_url, verification FROM users WHERE username = $1", [username]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: "User not found" });
    const user = userRes.rows[0];

    const insertRes = await pool.query(
      "INSERT INTO tweets (user_id, content, parent_id) VALUES ($1, $2, $3) RETURNING *",
      [user.id, cleanContent, parentId || null]
    );

    const newTweet = { 
      ...insertRes.rows[0], 
      username: user.username, 
      avatar_url: user.avatar_url, 
      verification: user.verification,
      real_likes: 0,
      reply_count: 0
    };

    if (parentId) {
      // اگر ریپلای بود، به صاحب تویت اصلی خبر بده
      const parentTweet = await pool.query("SELECT user_id FROM tweets WHERE id = $1", [parentId]);
      if (parentTweet.rows.length > 0 && parentTweet.rows[0].user_id !== user.id) {
         await pool.query(
          "INSERT INTO notifications (recipient_id, sender_id, type, reference_id) VALUES ($1, $2, 'REPLY', $3)",
          [parentTweet.rows[0].user_id, user.id, insertRes.rows[0].id]
        );
        io.to(`user_${parentTweet.rows[0].user_id}`).emit('notification_alert', { type: 'REPLY', message: `${user.username} replied to you!` });
      }
      // ارسال ایونت ریپلای
      io.emit(`new_reply_${parentId}`, newTweet);
    } else {
      // تویت معمولی
      io.emit('new_tweet', newTweet);
    }
    
    res.json({ success: true, tweet: newTweet });

  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
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

    const tweetRes = await pool.query("SELECT user_id FROM tweets WHERE id = $1", [tweetId]);
    if (tweetRes.rows.length === 0) return res.status(404).json({ error: "Tweet not found" });
    const ownerId = tweetRes.rows[0].user_id;

    // استفاده از تراکنش برای اطمینان از صحت داده‌ها
    await pool.query("BEGIN");
    
    const likeCheck = await pool.query("SELECT * FROM likes WHERE user_id = $1 AND tweet_id = $2", [userId, tweetId]);
    
    if (likeCheck.rows.length === 0) {
      // لایک جدید
      await pool.query("INSERT INTO likes (user_id, tweet_id) VALUES ($1, $2)", [userId, tweetId]);
      await pool.query("UPDATE tweets SET likes_count = likes_count + 1 WHERE id = $1", [tweetId]);
      
      if (userId !== ownerId) {
        await pool.query(
          "INSERT INTO notifications (recipient_id, sender_id, type, reference_id) VALUES ($1, $2, 'LIKE', $3)",
          [ownerId, userId, tweetId]
        );
        io.to(`user_${ownerId}`).emit('notification_alert', { type: 'LIKE', message: `${username} liked your tweet!` });
      }
      io.emit('update_tweet_stats', { tweetId, action: 'like_added' });
    } else {
      // آنلایک (اختیاری - اگر بخواهید اضافه کنید)
    }

    await pool.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await pool.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// 3. چت روم‌ها (Real-time & History)
// ======================================================

// دریافت تاریخچه پیام‌ها
app.get('/api/rooms/:matchId/messages', async (req, res) => {
  try {
    const query = `
      SELECT m.id, m.content, m.created_at, u.username, u.avatar_url, u.verification
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
    const url = `https://apiv3.apifootball.com/?action=get_events&match_live=1&APIkey=${API_FOOTBALL_TOKEN}`;
    const response = await axios.get(url);
    if (Array.isArray(response.data)) {
      const liveMatches = response.data;
      const liveIds = liveMatches.map(m => m.match_id);
      
      for (const match of liveMatches) {
        await pool.query(`
          INSERT INTO match_rooms (match_id, home_team, away_team, status, last_updated)
          VALUES ($1, $2, $3, 'LIVE', NOW())
          ON CONFLICT (match_id) DO UPDATE SET status = 'LIVE', last_updated = NOW()`,
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
// 4. سوکت‌ها (Chat, Stats, Notifications)
// ======================================================

// نگهداری وضعیت آنلاین‌ها در حافظه (سریع‌تر از دیتابیس برای کارهای لحظه‌ای)
const roomOnlineUsers = new Map();

io.on('connection', (socket) => {
  // console.log(`Socket Connected: ${socket.id}`); // لاگ زیاد در پروداکشن خوب نیست

  // رجیستر کاربر
  socket.on('register_user', async (username) => {
    try {
      const res = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
      if (res.rows.length > 0) {
        const userId = res.rows[0].id;
        socket.join(`user_${userId}`);
        socket.data.userId = userId;
        socket.data.username = username;
      }
    } catch (err) { console.error(err); }
  });

  // ورود به روم بازی
  socket.on('join_room', (matchId) => {
    socket.join(matchId);
    
    // آپدیت تعداد آنلاین‌ها
    const count = (roomOnlineUsers.get(matchId) || 0) + 1;
    roomOnlineUsers.set(matchId, count);
    io.to(matchId).emit('room_users_count', count);
  });

  // خروج از روم
  socket.on('leave_room', (matchId) => {
    socket.leave(matchId);
    const count = Math.max(0, (roomOnlineUsers.get(matchId) || 1) - 1);
    roomOnlineUsers.set(matchId, count);
    io.to(matchId).emit('room_users_count', count);
  });

  // وضعیت تایپ کردن
  socket.on('typing', ({ matchId, isTyping, username }) => {
    socket.to(matchId).emit('user_typing', { username, isTyping });
  });

  // ارسال پیام
  socket.on('send_message', async (data) => {
    const { matchId, username, content } = data;
    // Sanitization
    const cleanContent = xss(content);
    
    if (!cleanContent.trim()) return;

    try {
      const userRes = await pool.query("SELECT id, avatar_url, verification FROM users WHERE username = $1", [username]);
      
      if (userRes.rows.length > 0) {
        const user = userRes.rows[0];

        // ذخیره آسنکرون (Non-blocking)
        pool.query(
          "INSERT INTO messages (content, user_id, match_id) VALUES ($1, $2, $3)",
          [cleanContent, user.id, matchId]
        );

        io.to(matchId).emit('receive_message', {
          id: Date.now(), // ID موقت برای کلاینت
          username: username,
          content: cleanContent,
          avatar: user.avatar_url,
          verification: user.verification,
          time: new Date().toISOString()
        });
      }
    } catch (err) {
      console.error("Chat Socket Error:", err.message);
    }
  });
  
  // هندل قطع اتصال برای شمارنده آنلاین
  socket.on('disconnecting', () => {
    for (const room of socket.rooms) {
       if (roomOnlineUsers.has(room)) {
          const count = Math.max(0, roomOnlineUsers.get(room) - 1);
          roomOnlineUsers.set(room, count);
          io.to(room).emit('room_users_count', count);
       }
    }
  });
});

// ======================================================
// Global Error Handler (پایان پایپ لاین)
// ======================================================
app.use((err, req, res, next) => {
  console.error('🔥 Global Error:', err.stack);
  res.status(500).json({ 
    error: 'Internal Server Error', 
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong' 
  });
});

// استارت و خاموشی امن (Graceful Shutdown)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Pro Server 2026 Running on Port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    pool.end(() => {
      console.log('Database pool closed');
      process.exit(0);
    });
  });
});
