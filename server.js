/**
 * Pro Server 2026 - Optimized & Secured
 * Refactored for Production by Gemini AI
 */

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

// ======================================================
// 1. CONFIGURATION & SETUP
// ======================================================

const app = express();
const server = http.createServer(app);

// Check Essential Env Vars
if (!process.env.DATABASE_URL) {
  console.error("❌ FATAL: DATABASE_URL is missing in .env");
  process.exit(1);
}

// Security & Performance Middleware
app.use(helmet());
app.use(compression());
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "PATCH"] }));
app.use(express.json({ limit: '20kb' })); // Increased slightly for richer payloads
app.use(morgan('combined')); // Better logging format

// Rate Limiting (DDoS Protection)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." }
});
app.use(limiter);

// Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Note: In strict prod, set this to true with CA
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('❌ DB Fatal Error:', err);
});

// Socket.io Setup
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  transports: ['websocket', 'polling']
});

// System Variables
let API_FOOTBALL_TOKEN = "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "AjPowerSecretKey2026";

async function loadSystemConfig() {
  try {
    const client = await pool.connect();
    try {
      const res = await client.query("SELECT value FROM system_config WHERE key = 'football_api_token'");
      if (res.rows.length > 0) API_FOOTBALL_TOKEN = res.rows[0].value;
      console.log('✅ System Config Loaded.');
    } finally {
      client.release();
    }
  } catch (err) { console.error('⚠️ DB Config warning (Table might not exist yet)'); }
}
loadSystemConfig();

// ======================================================
// 2. HELPERS & UTILS
// ======================================================

// Wrapper to handle async errors cleanly (Replaces repetitive try-catch)
const catchAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Zod Schemas
const UserAuthSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, "Username: letters, numbers, _ only"),
  avatar_url: z.string().url().optional().or(z.literal('')).or(z.null())
});

const ProfileUpdateSchema = z.object({
  username: z.string(),
  display_name: z.string().max(50).optional(),
  bio: z.string().max(160).optional(),
  avatar_url: z.string().url().optional().or(z.literal('')).or(z.null())
});

const TweetSchema = z.object({
  username: z.string(),
  content: z.string().min(1).max(500),
  parentId: z.number().int().optional().nullable()
});

const ReportSchema = z.object({
  reporterUsername: z.string(),
  targetId: z.number().int(),
  type: z.enum(['SPAM', 'ABUSE', 'FAKE', 'OTHER']),
  reason: z.string().max(255).optional()
});

// Hashtag Logic
const extractHashtags = (text) => {
  const regex = /#(\w+)/g;
  const matches = text.match(regex);
  return matches ? matches.map(tag => tag.substring(1)) : [];
};

async function processHashtags(content) {
  const tags = extractHashtags(content);
  if (tags.length === 0) return;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const tag of tags) {
      const cleanTag = tag.toLowerCase();
      await client.query(`
        INSERT INTO hashtags (tag, usage_count, last_used)
        VALUES ($1, 1, NOW())
        ON CONFLICT (tag) DO UPDATE SET 
        usage_count = hashtags.usage_count + 1,
        last_used = NOW()
      `, [cleanTag]);
    }
    await client.query('COMMIT');
  } catch (e) { 
    await client.query('ROLLBACK');
    console.error("Hashtag Error", e); 
  } finally { 
    client.release(); 
  }
}

// ======================================================
// 3. API ROUTES
// ======================================================

// --- AUTH & USER MANAGEMENT ---

// Sync User (Login/Register)
app.post('/api/auth/sync', catchAsync(async (req, res) => {
  const { email, username, avatar_url } = UserAuthSchema.parse(req.body);
  
  const query = `
    INSERT INTO users (email, username, avatar_url, last_active)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (email) DO UPDATE SET 
      avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url), 
      username = EXCLUDED.username,
      last_active = NOW()
    RETURNING id, email, username, avatar_url, display_name, verification;
  `;
  const result = await pool.query(query, [email, username, avatar_url]);
  res.json({ success: true, user: result.rows[0] });
}));

// Get Profile
app.get('/api/users/profile/:username', catchAsync(async (req, res) => {
  const requesterUsername = req.query.me;
  
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
  let isFollowing = false;

  if (requesterUsername) {
    const reqUser = await pool.query("SELECT id FROM users WHERE username = $1", [requesterUsername]);
    if (reqUser.rows.length > 0) {
      const check = await pool.query("SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2", [reqUser.rows[0].id, user.id]);
      isFollowing = check.rows.length > 0;
    }
  }

  res.json({ ...user, is_following: isFollowing });
}));

// Update Profile
app.put('/api/users/update', catchAsync(async (req, res) => {
  const { username, display_name, bio, avatar_url } = ProfileUpdateSchema.parse(req.body);
  
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
}));

// Change Username
app.put('/api/users/change-username', catchAsync(async (req, res) => {
  const { oldUsername, newUsername } = req.body;
  
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(newUsername)) {
    return res.status(400).json({ error: "Invalid username format" });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const check = await client.query("SELECT id FROM users WHERE username = $1", [newUsername]);
    if (check.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Username already taken" });
    }

    const result = await client.query(
      "UPDATE users SET username = $1 WHERE username = $2 RETURNING id, username",
      [newUsername, oldUsername]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "User not found" });
    }

    await client.query('COMMIT');
    res.json({ success: true, newUsername: result.rows[0].username });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Follow / Unfollow (Transactional)
app.post('/api/users/follow', catchAsync(async (req, res) => {
  const { followerUsername, targetUsername } = req.body;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fRes = await client.query("SELECT id FROM users WHERE username = $1", [followerUsername]);
    const tRes = await client.query("SELECT id FROM users WHERE username = $1", [targetUsername]);
    
    if (!fRes.rows.length || !tRes.rows.length) throw new Error("User not found");
    const followerId = fRes.rows[0].id;
    const targetId = tRes.rows[0].id;

    if (followerId === targetId) throw new Error("Cannot follow self");

    const check = await client.query("SELECT * FROM follows WHERE follower_id = $1 AND following_id = $2", [followerId, targetId]);

    if (check.rows.length > 0) {
      // Unfollow
      await client.query("DELETE FROM follows WHERE follower_id = $1 AND following_id = $2", [followerId, targetId]);
      await client.query('COMMIT');
      res.json({ status: 'unfollowed' });
    } else {
      // Follow
      await client.query("INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)", [followerId, targetId]);
      await client.query("INSERT INTO notifications (recipient_id, sender_id, type) VALUES ($1, $2, 'FOLLOW')", [targetId, followerId]);
      await client.query('COMMIT');
      
      io.to(`user_${targetId}`).emit('notification_alert', { type: 'FOLLOW', message: `${followerUsername} started following you.` });
      res.json({ status: 'followed' });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}));

// Search
app.get('/api/users/search', catchAsync(async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const result = await pool.query(
    "SELECT username, display_name, avatar_url, verification FROM users WHERE username ILIKE $1 OR display_name ILIKE $1 LIMIT 10",
    [`%${xss(q)}%`]
  );
  res.json(result.rows);
}));

// --- TWEET SYSTEM ---

// Feed
app.get('/api/tweets/feed', catchAsync(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const username = req.query.username; // Viewer's username
  const limit = 20;
  const offset = (page - 1) * limit;

  let userId = 0;
  if (username) {
    const u = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
    if (u.rows.length) userId = u.rows[0].id;
  }

  const query = `
    SELECT 
      t.id, t.content, t.created_at, t.likes_count, t.user_id, t.parent_id,
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
}));

// Create Tweet
app.post('/api/tweets', catchAsync(async (req, res) => {
  const { username, content, parentId } = TweetSchema.parse(req.body);
  const cleanContent = xss(content);

  const userRes = await pool.query("SELECT id, username, display_name, avatar_url, verification FROM users WHERE username = $1", [username]);
  if (userRes.rows.length === 0) return res.status(404).json({ error: "User not found" });
  const user = userRes.rows[0];

  const insertRes = await pool.query(
    "INSERT INTO tweets (user_id, content, parent_id) VALUES ($1, $2, $3) RETURNING *",
    [user.id, cleanContent, parentId || null]
  );

  // Async Hashtag Processing
  processHashtags(cleanContent);

  const newTweet = { 
    ...insertRes.rows[0], 
    username: user.username,
    display_name: user.display_name,
    avatar_url: user.avatar_url, 
    verification: user.verification,
    reply_count: 0,
    retweet_count: 0,
    likes_count: 0,
    has_liked: false,
    has_retweeted: false,
    has_bookmarked: false
  };

  // Notifications & Realtime
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
}));

// Delete Tweet
app.delete('/api/tweets/:id', catchAsync(async (req, res) => {
  const tweetId = req.params.id;
  const { username } = req.body; 

  const checkOwner = await pool.query(`
    SELECT t.id FROM tweets t 
    JOIN users u ON t.user_id = u.id 
    WHERE t.id = $1 AND u.username = $2
  `, [tweetId, username]);

  if (checkOwner.rows.length === 0) {
    return res.status(403).json({ error: "Unauthorized or Tweet not found" });
  }

  await pool.query("DELETE FROM tweets WHERE id = $1", [tweetId]);
  io.emit('tweet_deleted', tweetId);
  res.json({ success: true, message: "Tweet deleted" });
}));

// Like Tweet (Transactional)
app.post('/api/tweets/:id/like', catchAsync(async (req, res) => {
  const { username } = req.body;
  const tweetId = req.params.id;
  
  const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
  if (!user.rows.length) return res.status(404).json({error: "User not found"});
  const userId = user.rows[0].id;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const check = await client.query("SELECT 1 FROM likes WHERE user_id = $1 AND tweet_id = $2", [userId, tweetId]);
    
    if (check.rows.length === 0) {
      await client.query("INSERT INTO likes (user_id, tweet_id) VALUES ($1, $2)", [userId, tweetId]);
      await client.query("UPDATE tweets SET likes_count = likes_count + 1 WHERE id = $1", [tweetId]);
      
      const tweetOwner = await client.query("SELECT user_id FROM tweets WHERE id = $1", [tweetId]);
      if(tweetOwner.rows.length && tweetOwner.rows[0].user_id !== userId){
        await client.query("INSERT INTO notifications (recipient_id, sender_id, type, reference_id) VALUES ($1, $2, 'LIKE', $3)",
          [tweetOwner.rows[0].user_id, userId, tweetId]);
        io.to(`user_${tweetOwner.rows[0].user_id}`).emit('notification_alert', { type: 'LIKE', message: `${username} liked your tweet.` });
      }
      io.emit('update_tweet_stats', { tweetId, action: 'like_added' });
    }
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}));

// Retweet (Transactional)
app.post('/api/tweets/:id/retweet', catchAsync(async (req, res) => {
  const { username } = req.body;
  const tweetId = req.params.id;

  const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
  if (!user.rows.length) return res.status(404).json({error: "User not found"});
  const userId = user.rows[0].id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const check = await client.query("SELECT 1 FROM retweets WHERE user_id = $1 AND tweet_id = $2", [userId, tweetId]);
    
    let status = '';
    if (check.rows.length > 0) {
      await client.query("DELETE FROM retweets WHERE user_id = $1 AND tweet_id = $2", [userId, tweetId]);
      status = 'removed';
      io.emit('update_tweet_stats', { tweetId, action: 'retweet_removed' });
    } else {
      await client.query("INSERT INTO retweets (user_id, tweet_id) VALUES ($1, $2)", [userId, tweetId]);
      status = 'added';
      io.emit('update_tweet_stats', { tweetId, action: 'retweet_added' });
    }
    await client.query('COMMIT');
    res.json({ status });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// Bookmark
app.post('/api/tweets/:id/bookmark', catchAsync(async (req, res) => {
  const { username } = req.body;
  const tweetId = req.params.id;
  
  const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
  if (!user.rows.length) return res.status(404).json({error: "User not found"});
  const userId = user.rows[0].id;

  const check = await pool.query("SELECT 1 FROM bookmarks WHERE user_id = $1 AND tweet_id = $2", [userId, tweetId]);
  if (check.rows.length > 0) {
    await pool.query("DELETE FROM bookmarks WHERE user_id = $1 AND tweet_id = $2", [userId, tweetId]);
    res.json({ status: 'removed' });
  } else {
    await pool.query("INSERT INTO bookmarks (user_id, tweet_id) VALUES ($1, $2)", [userId, tweetId]);
    res.json({ status: 'added' });
  }
}));

// Get Bookmarks
app.get('/api/bookmarks/:username', catchAsync(async (req, res) => {
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
}));

// Trends
app.get('/api/trends', catchAsync(async (req, res) => {
  const query = `SELECT tag, usage_count FROM hashtags WHERE last_used > NOW() - INTERVAL '24 HOURS' ORDER BY usage_count DESC LIMIT 10`;
  const result = await pool.query(query);
  res.json(result.rows);
}));

// Report
app.post('/api/report', catchAsync(async (req, res) => {
  const { reporterUsername, targetId, type, reason } = ReportSchema.parse(req.body);
  const user = await pool.query("SELECT id FROM users WHERE username = $1", [reporterUsername]);
  if (!user.rows.length) return res.status(404).json({error: "User not found"});
  
  await pool.query("INSERT INTO reports (reporter_id, target_id, type, reason) VALUES ($1, $2, $3, $4)",
    [user.rows[0].id, targetId, type, reason]);
  res.json({ success: true });
}));

// --- DIRECT MESSAGES ---

app.post('/api/dm/conversation', catchAsync(async (req, res) => {
  const { username1, username2 } = req.body;
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
}));

app.get('/api/dm/list/:username', catchAsync(async (req, res) => {
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
}));

app.delete('/api/dm/:messageId', catchAsync(async (req, res) => {
  const { username } = req.body;
  const messageId = req.params.messageId;
  
  const checkSender = await pool.query(`
    SELECT dm.id, dm.conversation_id FROM direct_messages dm
    JOIN users u ON dm.sender_id = u.id
    WHERE dm.id = $1 AND u.username = $2
  `, [messageId, username]);

  if (checkSender.rows.length === 0) return res.status(403).json({ error: "Unauthorized" });

  await pool.query("DELETE FROM direct_messages WHERE id = $1", [messageId]);
  
  const conversationId = checkSender.rows[0].conversation_id;
  io.to(`conv_${conversationId}`).emit('dm_deleted', messageId);

  res.json({ success: true });
}));

// --- LIVE MATCHES & ROOMS ---

app.get('/api/rooms/live', catchAsync(async (req, res) => {
  const result = await pool.query("SELECT * FROM match_rooms WHERE status = 'LIVE' ORDER BY created_at DESC");
  res.json(result.rows);
}));

app.get('/api/rooms/:matchId/messages', catchAsync(async (req, res) => {
  const query = `
    SELECT m.id, m.content, m.created_at, u.username, u.display_name, u.avatar_url, u.verification
    FROM messages m
    JOIN users u ON m.user_id = u.id
    WHERE m.match_id = $1
    ORDER BY m.created_at ASC
  `;
  const result = await pool.query(query, [req.params.matchId]);
  res.json(result.rows);
}));

// ======================================================
// 4. CRON JOBS
// ======================================================

cron.schedule('*/3 * * * *', async () => {
  if (!API_FOOTBALL_TOKEN) return;
  console.log('⚽ Cron: Updating matches...');
  try {
    const response = await axios.get(`https://apiv3.apifootball.com/?action=get_events&match_live=1&APIkey=${API_FOOTBALL_TOKEN}`, { timeout: 10000 });
    
    if (Array.isArray(response.data)) {
      const liveMatches = response.data;
      const liveIds = liveMatches.map(m => m.match_id);
      
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const match of liveMatches) {
          await client.query(`
            INSERT INTO match_rooms (match_id, home_team, away_team, status, last_updated)
            VALUES ($1, $2, $3, 'LIVE', NOW())
            ON CONFLICT (match_id) DO UPDATE SET status = 'LIVE', last_updated = NOW()`,
            [match.match_id, match.match_hometeam_name, match.match_awayteam_name]
          );
        }
        
        // Mark ended matches
        if (liveIds.length > 0) {
          await client.query("UPDATE match_rooms SET status = 'FINISHED' WHERE status = 'LIVE' AND match_id <> ALL($1::text[])", [liveIds]);
        } else {
          await client.query("UPDATE match_rooms SET status = 'FINISHED' WHERE status = 'LIVE'");
        }
        await client.query('COMMIT');
      } catch(e) {
        await client.query('ROLLBACK');
        console.error('Cron DB Error:', e);
      } finally {
        client.release();
      }
    }
  } catch (err) { console.error('Cron Fetch Error:', err.message); }
});

// ======================================================
// 5. SOCKET.IO LOGIC
// ======================================================

const roomOnlineUsers = new Map();

io.on('connection', (socket) => {
  // --- Auth ---
  socket.on('register_user', async (username) => {
    try {
      // Input Validation
      if (!username || typeof username !== 'string') return;
      const res = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
      if (res.rows.length > 0) {
        const userId = res.rows[0].id;
        socket.join(`user_${userId}`);
        socket.data.userId = userId;
        socket.data.username = username;
      }
    } catch (err) { console.error("Socket Auth Error", err); }
  });

  // --- Live Match Rooms ---
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
    // Basic santization just in case
    if(matchId && username) socket.to(matchId).emit('user_typing', { username, isTyping });
  });

  socket.on('send_message', async (data) => {
    const { matchId, username, content } = data;
    if (!content) return;
    const cleanContent = xss(content);
    if (!cleanContent.trim()) return;

    try {
      const userRes = await pool.query("SELECT id, display_name, avatar_url, verification FROM users WHERE username = $1", [username]);
      if (userRes.rows.length > 0) {
        const user = userRes.rows[0];
        await pool.query("INSERT INTO messages (content, user_id, match_id) VALUES ($1, $2, $3)", [cleanContent, user.id, matchId]);

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

  // --- Direct Messages ---
  socket.on('join_conversation', (conversationId) => {
    socket.join(`conv_${conversationId}`);
  });

  socket.on('send_dm', async ({ conversationId, senderUsername, content }) => {
    if (!content) return;
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

  // --- Cleanup ---
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
// 6. ERROR HANDLING & SERVER START
// ======================================================

// Global Error Handler
app.use((err, req, res, next) => {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: "Validation Error", details: err.errors });
  }
  console.error('🔥 Global Error:', err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Pro Server 2026 Running on Port ${PORT}`);
  console.log(`🛡️  Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful Shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    pool.end(() => {
      console.log('HTTP server closed & DB pool ended');
      process.exit(0);
    });
  });
});
