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
const morgan = require('morgan');
const xss = require('xss');
const { z } = require('zod');

// --- تنظیمات سرور ---
const app = express();
const server = http.createServer(app);

// پیکربندی امنیتی و پرفورمنس
app.use(helmet());
app.use(compression());
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE"] }));
app.use(express.json({ limit: '10kb' }));
app.use(morgan('tiny'));

// محدودیت نرخ درخواست (عمومی)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// سوکت با بافر و تنظیمات بهینه
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  transports: ['websocket', 'polling']
});

// اتصال دیتابیس
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('❌ DB Fatal Error:', err);
  process.exit(-1);
});

// متغیرهای سیستمی
let API_FOOTBALL_TOKEN = "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "AjPowerSecretKey2026";

async function loadSystemConfig() {
  try {
    const res = await pool.query("SELECT value FROM system_config WHERE key = 'football_api_token'");
    if (res.rows.length > 0) API_FOOTBALL_TOKEN = res.rows[0].value;
    console.log('✅ System Config Loaded.');
  } catch (err) { console.error('⚠️ DB Config warning (Non-fatal)'); }
}
loadSystemConfig();

// ======================================================
// Helper Functions & Zod Schemas
// ======================================================

const UserSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, "Only letters, numbers and _ allowed"),
  avatar_url: z.string().url().optional().or(z.literal(''))
});

const ProfileUpdateSchema = z.object({
  username: z.string(), // برای شناسایی کاربر
  display_name: z.string().max(50).optional(),
  bio: z.string().max(160).optional(),
  avatar_url: z.string().url().optional().or(z.literal(''))
});

const TweetSchema = z.object({
  username: z.string(),
  content: z.string().min(1).max(500)
});

// استخراج هشتگ‌ها از متن
const extractHashtags = (text) => {
  const regex = /#(\w+)/g;
  const matches = text.match(regex);
  return matches ? matches.map(tag => tag.substring(1)) : [];
};

// پردازش هشتگ‌ها به صورت Async
async function processHashtags(content) {
  const tags = extractHashtags(content);
  if (tags.length === 0) return;
  
  const client = await pool.connect();
  try {
    for (const tag of tags) {
      await client.query(`
        INSERT INTO hashtags (tag, usage_count, last_used)
        VALUES ($1, 1, NOW())
        ON CONFLICT (tag) DO UPDATE SET 
        usage_count = hashtags.usage_count + 1,
        last_used = NOW()
      `, [tag.toLowerCase()]);
    }
  } catch (e) { console.error("Hashtag Error", e); } 
  finally { client.release(); }
}

// ======================================================
// 1. مدیریت کاربران (Auth, Profile, Update)
// ======================================================

// سینک اطلاعات اولیه (لاگین/ثبت‌نام)
app.post('/api/auth/sync', async (req, res) => {
  try {
    const { email, username, avatar_url } = UserSchema.parse(req.body);
    const query = `
      INSERT INTO users (email, username, avatar_url, last_active)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (email) DO UPDATE SET 
        avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url), 
        username = EXCLUDED.username,
        last_active = NOW()
      RETURNING *;
    `;
    const result = await pool.query(query, [email, username, avatar_url]);
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: "Auth failed" });
  }
});

// دریافت پروفایل کامل
app.get('/api/users/profile/:username', async (req, res) => {
  try {
    const requesterUsername = req.query.me;
    let isFollowing = false;

    const query = `
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.verification, u.bio, u.created_at,
      (SELECT COUNT(*) FROM follows WHERE following_id = u.id) as followers_count,
      (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) as following_count,
      (SELECT COUNT(*) FROM tweets WHERE user_id = u.id) as tweets_count
      FROM users u
      WHERE u.username = $1
    `;
    const result = await pool.query(query, [req.params.username]);
    if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });

    const user = result.rows[0];

    if (requesterUsername) {
      const requesterRes = await pool.query("SELECT id FROM users WHERE username = $1", [requesterUsername]);
      if (requesterRes.rows.length > 0) {
        const check = await pool.query("SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2", [requesterRes.rows[0].id, user.id]);
        isFollowing = check.rows.length > 0;
      }
    }

    res.json({ ...user, is_following: isFollowing });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// [NEW] ویرایش پروفایل (نام نمایشی، بیو، آواتار)
app.put('/api/users/update', async (req, res) => {
  try {
    const { username, display_name, bio, avatar_url } = ProfileUpdateSchema.parse(req.body);
    
    // پاکسازی ورودی‌ها از کدهای مخرب
    const cleanBio = bio ? xss(bio) : null;
    const cleanName = display_name ? xss(display_name) : null;

    const query = `
      UPDATE users 
      SET display_name = COALESCE($1, display_name), 
          bio = COALESCE($2, bio), 
          avatar_url = COALESCE($3, avatar_url), 
          last_active = NOW()
      WHERE username = $4
      RETURNING id, username, display_name, bio, avatar_url
    `;
    const result = await pool.query(query, [cleanName, cleanBio, avatar_url, username]);
    
    if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: err.message });
  }
});

// [NEW] تغییر نام کاربری (Change Username)
app.put('/api/users/change-username', async (req, res) => {
  const { oldUsername, newUsername } = req.body;
  
  // اعتبارسنجی
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(newUsername)) {
    return res.status(400).json({ error: "Invalid username format (Letters, numbers, _ only)" });
  }

  try {
    // بررسی تکراری نبودن
    const check = await pool.query("SELECT id FROM users WHERE username = $1", [newUsername]);
    if (check.rows.length > 0) return res.status(400).json({ error: "Username already taken" });

    const result = await pool.query(
      "UPDATE users SET username = $1 WHERE username = $2 RETURNING id, username",
      [newUsername, oldUsername]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });
    
    res.json({ success: true, newUsername: result.rows[0].username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// فالو / آنفالو
app.post('/api/users/follow', async (req, res) => {
  const { followerUsername, targetUsername } = req.body;
  try {
    const followerRes = await pool.query("SELECT id FROM users WHERE username = $1", [followerUsername]);
    const targetRes = await pool.query("SELECT id FROM users WHERE username = $1", [targetUsername]);
    
    if (!followerRes.rows.length || !targetRes.rows.length) return res.status(404).json({ error: "User not found" });

    const followerId = followerRes.rows[0].id;
    const targetId = targetRes.rows[0].id;
    if (followerId === targetId) return res.status(400).json({ error: "Self follow error" });

    const check = await pool.query("SELECT * FROM follows WHERE follower_id = $1 AND following_id = $2", [followerId, targetId]);

    if (check.rows.length > 0) {
      await pool.query("DELETE FROM follows WHERE follower_id = $1 AND following_id = $2", [followerId, targetId]);
      res.json({ status: 'unfollowed' });
    } else {
      await pool.query("INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)", [followerId, targetId]);
      await pool.query("INSERT INTO notifications (recipient_id, sender_id, type) VALUES ($1, $2, 'FOLLOW')", [targetId, followerId]);
      io.to(`user_${targetId}`).emit('notification_alert', { type: 'FOLLOW', message: `${followerUsername} started following you.` });
      res.json({ status: 'followed' });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// جستجوی کاربران
app.get('/api/users/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  try {
    const result = await pool.query(
      "SELECT username, display_name, avatar_url, verification FROM users WHERE username ILIKE $1 OR display_name ILIKE $1 LIMIT 10",
      [`%${xss(q)}%`]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ======================================================
// 2. سیستم تویت (Feed, Delete, Retweet, Bookmark)
// ======================================================

// فید ترکیبی
app.get('/api/tweets/feed', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const username = req.query.username;
  const limit = 20;
  const offset = (page - 1) * limit;

  try {
    let userId = 0;
    if (username) {
      const u = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
      if (u.rows.length) userId = u.rows[0].id;
    }

    const query = `
      SELECT 
        t.id, t.content, t.created_at, t.likes_count, t.user_id,
        u.username, u.display_name, u.avatar_url, u.verification,
        (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count,
        (SELECT COUNT(*) FROM retweets WHERE tweet_id = t.id) as retweet_count,
        EXISTS(SELECT 1 FROM likes WHERE tweet_id = t.id AND user_id = $3) as has_liked,
        EXISTS(SELECT 1 FROM retweets WHERE tweet_id = t.id AND user_id = $3) as has_retweeted,
        EXISTS(SELECT 1 FROM bookmarks WHERE tweet_id = t.id AND user_id = $3) as has_bookmarked
      FROM tweets t
      JOIN users u ON t.user_id = u.id
      WHERE t.parent_id IS NULL
      ORDER BY t.created_at DESC
      LIMIT $1 OFFSET $2
    `;
    const result = await pool.query(query, [limit, offset, userId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ارسال تویت
app.post('/api/tweets', async (req, res) => {
  try {
    const { username, content, parentId } = req.body;
    TweetSchema.parse({ username, content });
    const cleanContent = xss(content);

    const userRes = await pool.query("SELECT id, username, display_name, avatar_url, verification FROM users WHERE username = $1", [username]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: "User not found" });
    const user = userRes.rows[0];

    const insertRes = await pool.query(
      "INSERT INTO tweets (user_id, content, parent_id) VALUES ($1, $2, $3) RETURNING *",
      [user.id, cleanContent, parentId || null]
    );

    processHashtags(cleanContent);

    const newTweet = { 
      ...insertRes.rows[0], 
      username: user.username,
      display_name: user.display_name,
      avatar_url: user.avatar_url, 
      verification: user.verification,
      reply_count: 0,
      retweet_count: 0,
      has_liked: false
    };

    if (parentId) {
      const parentTweet = await pool.query("SELECT user_id FROM tweets WHERE id = $1", [parentId]);
      if (parentTweet.rows.length > 0 && parentTweet.rows[0].user_id !== user.id) {
         await pool.query("INSERT INTO notifications (recipient_id, sender_id, type, reference_id) VALUES ($1, $2, 'REPLY', $3)",
          [parentTweet.rows[0].user_id, user.id, insertRes.rows[0].id]);
        io.to(`user_${parentTweet.rows[0].user_id}`).emit('notification_alert', { type: 'REPLY', message: `${user.username} replied to you!` });
      }
      io.emit(`new_reply_${parentId}`, newTweet);
    } else {
      io.emit('new_tweet', newTweet);
    }
    
    res.json({ success: true, tweet: newTweet });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.errors });
    res.status(500).json({ error: err.message });
  }
});

// [NEW] حذف تویت
app.delete('/api/tweets/:id', async (req, res) => {
  const tweetId = req.params.id;
  const { username } = req.body; 

  try {
    const checkOwner = await pool.query(`
      SELECT t.id FROM tweets t 
      JOIN users u ON t.user_id = u.id 
      WHERE t.id = $1 AND u.username = $2
    `, [tweetId, username]);

    if (checkOwner.rows.length === 0) {
      return res.status(403).json({ error: "Unauthorized or Tweet not found" });
    }

    await pool.query("DELETE FROM tweets WHERE id = $1", [tweetId]);
    
    // اطلاع‌رسانی به کلاینت‌ها برای حذف آنی
    io.emit('tweet_deleted', tweetId);
    
    res.json({ success: true, message: "Tweet deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// لایک
app.post('/api/tweets/:id/like', async (req, res) => {
  const { username } = req.body;
  const tweetId = req.params.id;
  try {
    const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
    if (!user.rows.length) return res.status(404).json({error: "User not found"});
    const userId = user.rows[0].id;

    // تراکنش امن
    await pool.query("BEGIN");
    const check = await pool.query("SELECT 1 FROM likes WHERE user_id = $1 AND tweet_id = $2", [userId, tweetId]);
    
    if (check.rows.length === 0) {
      await pool.query("INSERT INTO likes (user_id, tweet_id) VALUES ($1, $2)", [userId, tweetId]);
      await pool.query("UPDATE tweets SET likes_count = likes_count + 1 WHERE id = $1", [tweetId]);
      // نوتیفیکیشن
      const tweet = await pool.query("SELECT user_id FROM tweets WHERE id = $1", [tweetId]);
      if(tweet.rows.length && tweet.rows[0].user_id !== userId){
        await pool.query("INSERT INTO notifications (recipient_id, sender_id, type, reference_id) VALUES ($1, $2, 'LIKE', $3)",
          [tweet.rows[0].user_id, userId, tweetId]);
        io.to(`user_${tweet.rows[0].user_id}`).emit('notification_alert', { type: 'LIKE', message: `${username} liked your tweet.` });
      }
      io.emit('update_tweet_stats', { tweetId, action: 'like_added' });
    }
    await pool.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await pool.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  }
});

// بازنشر (Retweet)
app.post('/api/tweets/:id/retweet', async (req, res) => {
  const { username } = req.body;
  const tweetId = req.params.id;

  try {
    const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
    if (!user.rows.length) return res.status(404).json({error: "User not found"});
    const userId = user.rows[0].id;

    const check = await pool.query("SELECT * FROM retweets WHERE user_id = $1 AND tweet_id = $2", [userId, tweetId]);
    
    if (check.rows.length > 0) {
      await pool.query("DELETE FROM retweets WHERE user_id = $1 AND tweet_id = $2", [userId, tweetId]);
      res.json({ status: 'removed' });
      io.emit('update_tweet_stats', { tweetId, action: 'retweet_removed' });
    } else {
      await pool.query("INSERT INTO retweets (user_id, tweet_id) VALUES ($1, $2)", [userId, tweetId]);
      res.json({ status: 'added' });
      io.emit('update_tweet_stats', { tweetId, action: 'retweet_added' });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// بوک‌مارک (Bookmark)
app.post('/api/tweets/:id/bookmark', async (req, res) => {
  const { username } = req.body;
  const tweetId = req.params.id;
  try {
    const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
    if (!user.rows.length) return res.status(404).json({error: "User not found"});
    const userId = user.rows[0].id;

    const check = await pool.query("SELECT * FROM bookmarks WHERE user_id = $1 AND tweet_id = $2", [userId, tweetId]);
    if (check.rows.length > 0) {
      await pool.query("DELETE FROM bookmarks WHERE user_id = $1 AND tweet_id = $2", [userId, tweetId]);
      res.json({ status: 'removed' });
    } else {
      await pool.query("INSERT INTO bookmarks (user_id, tweet_id) VALUES ($1, $2)", [userId, tweetId]);
      res.json({ status: 'added' });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// [NEW] دریافت لیست بوک‌مارک‌ها
app.get('/api/bookmarks/:username', async (req, res) => {
  try {
    const query = `
      SELECT t.*, u.username, u.display_name, u.avatar_url, u.verification
      FROM bookmarks b
      JOIN tweets t ON b.tweet_id = t.id
      JOIN users u ON t.user_id = u.id
      WHERE b.user_id = (SELECT id FROM users WHERE username = $1)
      ORDER BY b.created_at DESC
    `;
    const result = await pool.query(query, [req.params.username]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ترندها
app.get('/api/trends', async (req, res) => {
  try {
    const query = `SELECT tag, usage_count FROM hashtags WHERE last_used > NOW() - INTERVAL '24 HOURS' ORDER BY usage_count DESC LIMIT 10`;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// گزارش تخلف
app.post('/api/report', async (req, res) => {
  const { reporterUsername, targetId, type, reason } = req.body;
  try {
    const user = await pool.query("SELECT id FROM users WHERE username = $1", [reporterUsername]);
    if (!user.rows.length) return res.status(404).json({error: "User not found"});
    
    await pool.query("INSERT INTO reports (reporter_id, target_id, type, reason) VALUES ($1, $2, $3, $4)",
      [user.rows[0].id, targetId, type, reason]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ======================================================
// 3. سیستم Direct Messages (Chat, List, Delete)
// ======================================================

app.post('/api/dm/conversation', async (req, res) => {
  const { username1, username2 } = req.body;
  try {
    const u1 = await pool.query("SELECT id FROM users WHERE username = $1", [username1]);
    const u2 = await pool.query("SELECT id FROM users WHERE username = $1", [username2]);
    if (!u1.rows.length || !u2.rows.length) return res.status(404).json({error: "User not found"});

    const id1 = Math.min(u1.rows[0].id, u2.rows[0].id);
    const id2 = Math.max(u1.rows[0].id, u2.rows[0].id);

    let conv = await pool.query("SELECT * FROM conversations WHERE user1_id = $1 AND user2_id = $2", [id1, id2]);
    if (conv.rows.length === 0) {
      conv = await pool.query("INSERT INTO conversations (user1_id, user2_id) VALUES ($1, $2) RETURNING *", [id1, id2]);
    }
    
    const messages = await pool.query(`
      SELECT dm.*, u.username, u.avatar_url 
      FROM direct_messages dm
      JOIN users u ON dm.sender_id = u.id
      WHERE conversation_id = $1 
      ORDER BY created_at ASC LIMIT 50`, [conv.rows[0].id]);

    res.json({ conversation: conv.rows[0], messages: messages.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dm/list/:username', async (req, res) => {
  try {
    const user = await pool.query("SELECT id FROM users WHERE username = $1", [req.params.username]);
    if (!user.rows.length) return res.status(404).json({error: "User not found"});
    const userId = user.rows[0].id;

    const query = `
      SELECT c.id as conversation_id, c.last_message, c.updated_at,
      CASE WHEN c.user1_id = $1 THEN u2.username ELSE u1.username END as other_user,
      CASE WHEN c.user1_id = $1 THEN u2.display_name ELSE u1.display_name END as other_display_name,
      CASE WHEN c.user1_id = $1 THEN u2.avatar_url ELSE u1.avatar_url END as other_avatar
      FROM conversations c
      JOIN users u1 ON c.user1_id = u1.id
      JOIN users u2 ON c.user2_id = u2.id
      WHERE c.user1_id = $1 OR c.user2_id = $1
      ORDER BY c.updated_at DESC
    `;
    const result = await pool.query(query, [userId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// [NEW] حذف پیام دایرکت
app.delete('/api/dm/:messageId', async (req, res) => {
  const { username } = req.body;
  const messageId = req.params.messageId;
  
  try {
    const checkSender = await pool.query(`
      SELECT dm.id, dm.conversation_id FROM direct_messages dm
      JOIN users u ON dm.sender_id = u.id
      WHERE dm.id = $1 AND u.username = $2
    `, [messageId, username]);

    if (checkSender.rows.length === 0) return res.status(403).json({ error: "Unauthorized" });

    await pool.query("DELETE FROM direct_messages WHERE id = $1", [messageId]);
    
    // اطلاع به طرف مقابل
    const conversationId = checkSender.rows[0].conversation_id;
    io.to(`conv_${conversationId}`).emit('dm_deleted', messageId);

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ======================================================
// 4. Live Match Rooms
// ======================================================

app.get('/api/rooms/:matchId/messages', async (req, res) => {
  try {
    const query = `
      SELECT m.id, m.content, m.created_at, u.username, u.display_name, u.avatar_url, u.verification
      FROM messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.match_id = $1
      ORDER BY m.created_at ASC
    `;
    const result = await pool.query(query, [req.params.matchId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

cron.schedule('*/3 * * * *', async () => {
  if (!API_FOOTBALL_TOKEN) return;
  try {
    const response = await axios.get(`https://apiv3.apifootball.com/?action=get_events&match_live=1&APIkey=${API_FOOTBALL_TOKEN}`);
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
      if (liveIds.length > 0) {
        await pool.query("UPDATE match_rooms SET status = 'FINISHED' WHERE status = 'LIVE' AND match_id <> ALL($1::text[])", [liveIds]);
      } else {
        await pool.query("UPDATE match_rooms SET status = 'FINISHED' WHERE status = 'LIVE'");
      }
    }
  } catch (err) { console.error('Cron Error:', err.message); }
});

app.get('/api/rooms/live', async (req, res) => {
  const result = await pool.query("SELECT * FROM match_rooms WHERE status = 'LIVE' ORDER BY created_at DESC");
  res.json(result.rows);
});

// ======================================================
// 5. Advanced Socket.io (Global, Chat, DM)
// ======================================================

const roomOnlineUsers = new Map();

io.on('connection', (socket) => {
  
  // A. User Auth Socket
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

  // B. Live Match Socket
  socket.on('join_room', (matchId) => {
    socket.join(matchId);
    const count = (roomOnlineUsers.get(matchId) || 0) + 1;
    roomOnlineUsers.set(matchId, count);
    io.to(matchId).emit('room_users_count', count);
  });

  socket.on('leave_room', (matchId) => {
    socket.leave(matchId);
    const count = Math.max(0, (roomOnlineUsers.get(matchId) || 1) - 1);
    roomOnlineUsers.set(matchId, count);
    io.to(matchId).emit('room_users_count', count);
  });

  socket.on('typing', ({ matchId, isTyping, username }) => {
    socket.to(matchId).emit('user_typing', { username, isTyping });
  });

  socket.on('send_message', async (data) => {
    const { matchId, username, content } = data;
    const cleanContent = xss(content);
    if (!cleanContent.trim()) return;

    try {
      const userRes = await pool.query("SELECT id, display_name, avatar_url, verification FROM users WHERE username = $1", [username]);
      if (userRes.rows.length > 0) {
        const user = userRes.rows[0];
        pool.query("INSERT INTO messages (content, user_id, match_id) VALUES ($1, $2, $3)", [cleanContent, user.id, matchId]);

        io.to(matchId).emit('receive_message', {
          id: Date.now(),
          username: username,
          display_name: user.display_name,
          content: cleanContent,
          avatar: user.avatar_url,
          verification: user.verification,
          time: new Date().toISOString()
        });
      }
    } catch (err) { console.error("Chat Socket Error:", err.message); }
  });

  // C. DM Socket
  socket.on('join_conversation', (conversationId) => {
    socket.join(`conv_${conversationId}`);
  });

  socket.on('send_dm', async ({ conversationId, senderUsername, content }) => {
    const cleanContent = xss(content);
    if (!cleanContent.trim()) return;
    
    try {
      const userRes = await pool.query("SELECT id FROM users WHERE username = $1", [senderUsername]);
      if (userRes.rows.length > 0) {
        const senderId = userRes.rows[0].id;
        
        await pool.query("INSERT INTO direct_messages (conversation_id, sender_id, content) VALUES ($1, $2, $3)", 
          [conversationId, senderId, cleanContent]);
        
        await pool.query("UPDATE conversations SET last_message = $1, updated_at = NOW() WHERE id = $2", 
          [cleanContent.substring(0, 30), conversationId]);

        io.to(`conv_${conversationId}`).emit('receive_dm', {
          sender: senderUsername,
          content: cleanContent,
          created_at: new Date().toISOString()
        });
      }
    } catch (e) { console.error("DM Error", e); }
  });

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

app.use((err, req, res, next) => {
  console.error('🔥 Global Error:', err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Pro Server 2026 (Final Integrated) Running on Port ${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => {
    pool.end(() => process.exit(0));
  });
});
