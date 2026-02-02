/**
 * Pro Server 2026 - Optimized & Secured - FIXED VERSION
 * All bugs fixed: Notifications, DMs, Verification, Reply
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');

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
app.use(express.json({ limit: '20kb' }));
app.use(morgan('dev'));

// Rate Limiting (DDoS Protection)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." }
});
app.use(limiter);

// Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
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
const ADMIN_SECRET = process.env.ADMIN_SECRET || "AjPowerSecretKey2026";

// ======================================================
// 2. HELPERS & UTILS
// ======================================================

// Wrapper to handle async errors
const catchAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Sanitize input
const sanitize = (text) => {
  if (!text) return text;
  return text.toString()
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
};

// Extract hashtags
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

// Format time
function formatTime(date) {
  const now = new Date();
  const diff = now - date;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (minutes < 1) return 'همین الآن';
  if (minutes < 60) return `${minutes} دقیقه پیش`;
  if (hours < 24) return `${hours} ساعت پیش`;
  if (days < 7) return `${days} روز پیش`;
  return date.toLocaleDateString('fa-IR');
}

// ======================================================
// 3. API ROUTES - FIXED VERSION
// ======================================================

// --- AUTH & USER MANAGEMENT ---

// Sync User (Login/Register) - FIXED
app.post('/api/auth/sync', catchAsync(async (req, res) => {
  const { email, username, display_name, avatar_url } = req.body;
  
  if (!email || !username) {
    return res.status(400).json({ error: "ایمیل و نام کاربری الزامی هستند" });
  }

  const query = `
    INSERT INTO users (email, username, display_name, avatar_url, last_active)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (email) DO UPDATE SET 
      avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url), 
      username = EXCLUDED.username,
      display_name = COALESCE(EXCLUDED.display_name, users.display_name),
      last_active = NOW()
    RETURNING id, email, username, display_name, avatar_url, verification, bio, is_admin;
  `;
  
  try {
    const result = await pool.query(query, [
      email, 
      username, 
      display_name || username,
      avatar_url || 'https://via.placeholder.com/150'
    ]);
    
    // اگر ایمیل خاص هست، ادمین کن
    if (email === "Shahriyarjadidi@gmail.com") {
      await pool.query("UPDATE users SET is_admin = true, verification = 'gold' WHERE email = $1", [email]);
      result.rows[0].is_admin = true;
      result.rows[0].verification = 'gold';
    }
    
    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') { // unique violation
      return res.status(400).json({ error: "نام کاربری یا ایمیل قبلاً ثبت شده است" });
    }
    throw error;
  }
}));

// Get Profile - FIXED
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
      const check = await pool.query(
        "SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2", 
        [reqUser.rows[0].id, user.id]
      );
      isFollowing = check.rows.length > 0;
    }
  }

  res.json({ ...user, is_following: isFollowing });
}));

// Update Profile - FIXED
app.put('/api/users/update', catchAsync(async (req, res) => {
  const { username, display_name, bio, avatar_url } = req.body;
  
  if (!username) {
    return res.status(400).json({ error: "نام کاربری الزامی است" });
  }

  const query = `
    UPDATE users 
    SET display_name = COALESCE($1, display_name), 
        bio = COALESCE($2, bio), 
        avatar_url = COALESCE($3, avatar_url), 
        last_active = NOW()
    WHERE username = $4
    RETURNING id, username, display_name, bio, avatar_url, verification;
  `;
  
  const result = await pool.query(query, [
    sanitize(display_name) || null,
    sanitize(bio) || null,
    avatar_url || null,
    username
  ]);
  
  if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });
  
  res.json({ success: true, user: result.rows[0] });
}));

// Search Users - FIXED
app.get('/api/users/search', catchAsync(async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);
  
  const result = await pool.query(
    `SELECT username, display_name, avatar_url, verification 
     FROM users 
     WHERE username ILIKE $1 OR display_name ILIKE $1 
     ORDER BY 
       CASE WHEN username ILIKE $2 THEN 1 
            WHEN display_name ILIKE $2 THEN 2 
            ELSE 3 END
     LIMIT 15`,
    [`%${sanitize(q)}%`, `${sanitize(q)}%`]
  );
  
  res.json(result.rows);
}));

// Follow / Unfollow - FIXED
app.post('/api/users/follow', catchAsync(async (req, res) => {
  const { followerUsername, targetUsername } = req.body;
  
  if (!followerUsername || !targetUsername) {
    return res.status(400).json({ error: "اطلاعات ناقص است" });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const [fRes, tRes] = await Promise.all([
      client.query("SELECT id FROM users WHERE username = $1", [followerUsername]),
      client.query("SELECT id FROM users WHERE username = $1", [targetUsername])
    ]);
    
    if (!fRes.rows.length || !tRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: "User not found" });
    }
    
    const followerId = fRes.rows[0].id;
    const targetId = tRes.rows[0].id;

    if (followerId === targetId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Cannot follow self" });
    }

    const check = await client.query(
      "SELECT * FROM follows WHERE follower_id = $1 AND following_id = $2", 
      [followerId, targetId]
    );

    if (check.rows.length > 0) {
      // Unfollow
      await client.query(
        "DELETE FROM follows WHERE follower_id = $1 AND following_id = $2", 
        [followerId, targetId]
      );
      await client.query('COMMIT');
      res.json({ status: 'unfollowed' });
    } else {
      // Follow
      await client.query(
        "INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)", 
        [followerId, targetId]
      );
      
      // Create notification
      await client.query(
        `INSERT INTO notifications (recipient_id, sender_id, type, content) 
         VALUES ($1, $2, 'FOLLOW', $3)`,
        [targetId, followerId, `${followerUsername} شما را دنبال کرد`]
      );
      
      await client.query('COMMIT');
      
      // Send realtime notification
      io.to(`user_${targetId}`).emit('notification_alert', { 
        type: 'FOLLOW', 
        message: `${followerUsername} شما را دنبال کرد.`,
        sender: followerUsername
      });
      
      res.json({ status: 'followed' });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Follow error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
}));

// --- TWEET SYSTEM - FIXED ---

// Feed - FIXED
app.get('/api/tweets/feed', catchAsync(async (req, res) => {
  const username = req.query.username;
  
  let userId = null;
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
      ${userId ? `EXISTS(SELECT 1 FROM likes WHERE tweet_id = t.id AND user_id = $1) as has_liked,
      EXISTS(SELECT 1 FROM retweets WHERE tweet_id = t.id AND user_id = $1) as has_retweeted,
      EXISTS(SELECT 1 FROM bookmarks WHERE tweet_id = t.id AND user_id = $1) as has_bookmarked` : `
      false as has_liked, false as has_retweeted, false as has_bookmarked`}
    FROM tweets t
    JOIN users u ON t.user_id = u.id
    WHERE t.parent_id IS NULL
    ORDER BY t.created_at DESC
    LIMIT 20
  `;
  
  const result = await pool.query(query, userId ? [userId] : []);
  res.json(result.rows);
}));

// Create Tweet - FIXED
app.post('/api/tweets', catchAsync(async (req, res) => {
  const { username, content, parentId } = req.body;
  
  if (!username || !content || content.trim().length === 0) {
    return res.status(400).json({ error: "نام کاربری و محتوا الزامی هستند" });
  }

  const cleanContent = sanitize(content.trim());
  
  // Get user
  const userRes = await pool.query(
    "SELECT id, username, display_name, avatar_url, verification FROM users WHERE username = $1", 
    [username]
  );
  
  if (userRes.rows.length === 0) {
    return res.status(404).json({ error: "User not found" });
  }
  
  const user = userRes.rows[0];

  // Insert tweet
  const insertRes = await pool.query(
    `INSERT INTO tweets (user_id, content, parent_id) 
     VALUES ($1, $2, $3) 
     RETURNING id, content, created_at, likes_count`,
    [user.id, cleanContent, parentId || null]
  );

  // Process hashtags async
  processHashtags(cleanContent);

  const newTweet = { 
    ...insertRes.rows[0], 
    username: user.username,
    display_name: user.display_name,
    avatar_url: user.avatar_url, 
    verification: user.verification,
    reply_count: 0,
    retweet_count: 0,
    has_liked: false,
    has_retweeted: false,
    has_bookmarked: false
  };

  // Create notifications if it's a reply
  if (parentId) {
    const parentTweet = await pool.query(
      "SELECT user_id FROM tweets WHERE id = $1", 
      [parentId]
    );
    
    if (parentTweet.rows.length > 0 && parentTweet.rows[0].user_id !== user.id) {
      await pool.query(
        `INSERT INTO notifications (recipient_id, sender_id, type, reference_id, content) 
         VALUES ($1, $2, 'REPLY', $3, $4)`,
        [
          parentTweet.rows[0].user_id, 
          user.id, 
          insertRes.rows[0].id, 
          `${user.username} به توییت شما پاسخ داد: ${cleanContent.substring(0, 100)}`
        ]
      );
      
      // Send realtime notification
      io.to(`user_${parentTweet.rows[0].user_id}`).emit('notification_alert', { 
        type: 'REPLY', 
        message: `${user.username} به توییت شما پاسخ داد`,
        reference_id: insertRes.rows[0].id
      });
    }
    
    // Emit to reply listeners
    io.emit(`new_reply_${parentId}`, newTweet);
  } else {
    // Emit new tweet to all
    io.emit('new_tweet', newTweet);
  }
  
  res.json({ success: true, tweet: newTweet });
}));

// Delete Tweet - FIXED
app.delete('/api/tweets/:id', catchAsync(async (req, res) => {
  const tweetId = req.params.id;
  const { username } = req.body; 

  if (!username) {
    return res.status(400).json({ error: "نام کاربری الزامی است" });
  }

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

// Like Tweet - FIXED
app.post('/api/tweets/:id/like', catchAsync(async (req, res) => {
  const { username } = req.body;
  const tweetId = req.params.id;
  
  if (!username) {
    return res.status(400).json({ error: "نام کاربری الزامی است" });
  }

  const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
  if (!user.rows.length) return res.status(404).json({ error: "User not found" });
  
  const userId = user.rows[0].id;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    const check = await client.query(
      "SELECT 1 FROM likes WHERE user_id = $1 AND tweet_id = $2", 
      [userId, tweetId]
    );
    
    if (check.rows.length === 0) {
      // Like
      await client.query(
        "INSERT INTO likes (user_id, tweet_id) VALUES ($1, $2)", 
        [userId, tweetId]
      );
      
      await client.query(
        "UPDATE tweets SET likes_count = likes_count + 1 WHERE id = $1", 
        [tweetId]
      );
      
      // Get tweet owner for notification
      const tweetOwner = await client.query(
        "SELECT user_id FROM tweets WHERE id = $1", 
        [tweetId]
      );
      
      if (tweetOwner.rows.length && tweetOwner.rows[0].user_id !== userId) {
        await client.query(
          `INSERT INTO notifications (recipient_id, sender_id, type, reference_id, content) 
           VALUES ($1, $2, 'LIKE', $3, $4)`,
          [
            tweetOwner.rows[0].user_id, 
            userId, 
            tweetId, 
            `${username} توییت شما را لایک کرد`
          ]
        );
        
        // Send realtime notification
        io.to(`user_${tweetOwner.rows[0].user_id}`).emit('notification_alert', { 
          type: 'LIKE', 
          message: `${username} توییت شما را لایک کرد`,
          reference_id: tweetId
        });
      }
      
      await client.query("COMMIT");
      io.emit('update_tweet_stats', { tweetId, action: 'like_added' });
      res.json({ success: true, action: 'liked' });
    } else {
      // Unlike
      await client.query(
        "DELETE FROM likes WHERE user_id = $1 AND tweet_id = $2", 
        [userId, tweetId]
      );
      
      await client.query(
        "UPDATE tweets SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = $1", 
        [tweetId]
      );
      
      await client.query("COMMIT");
      io.emit('update_tweet_stats', { tweetId, action: 'like_removed' });
      res.json({ success: true, action: 'unliked' });
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Like error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
}));

// Bookmark Tweet - FIXED
app.post('/api/tweets/:id/bookmark', catchAsync(async (req, res) => {
  const { username } = req.body;
  const tweetId = req.params.id;
  
  if (!username) {
    return res.status(400).json({ error: "نام کاربری الزامی است" });
  }

  const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
  if (!user.rows.length) return res.status(404).json({ error: "User not found" });
  
  const userId = user.rows[0].id;

  const check = await pool.query(
    "SELECT 1 FROM bookmarks WHERE user_id = $1 AND tweet_id = $2", 
    [userId, tweetId]
  );
  
  if (check.rows.length > 0) {
    // Remove bookmark
    await pool.query(
      "DELETE FROM bookmarks WHERE user_id = $1 AND tweet_id = $2", 
      [userId, tweetId]
    );
    res.json({ status: 'removed' });
  } else {
    // Add bookmark
    await pool.query(
      "INSERT INTO bookmarks (user_id, tweet_id) VALUES ($1, $2)", 
      [userId, tweetId]
    );
    res.json({ status: 'added' });
  }
}));

// Get Bookmarks - FIXED
app.get('/api/bookmarks/:username', catchAsync(async (req, res) => {
  const { username } = req.params;
  
  const query = `
    SELECT t.*, u.username, u.display_name, u.avatar_url, u.verification
    FROM bookmarks b
    JOIN tweets t ON b.tweet_id = t.id
    JOIN users u ON t.user_id = u.id
    WHERE b.user_id = (SELECT id FROM users WHERE username = $1)
    ORDER BY b.created_at DESC
  `;
  
  const result = await pool.query(query, [username]);
  res.json(result.rows);
}));

// --- NOTIFICATIONS SYSTEM - FIXED ---

// Get Notifications - FIXED
app.get('/api/notifications/:username', catchAsync(async (req, res) => {
  const { username } = req.params;
  
  const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
  if (!user.rows.length) return res.status(404).json({ error: "User not found" });
  
  const userId = user.rows[0].id;

  const query = `
    SELECT 
      n.id, n.type, n.content, n.reference_id, n.read, n.created_at,
      u.username as sender_username, u.display_name as sender_display_name, u.avatar_url as sender_avatar
    FROM notifications n
    JOIN users u ON n.sender_id = u.id
    WHERE n.recipient_id = $1
    ORDER BY n.created_at DESC
    LIMIT 50
  `;
  
  const result = await pool.query(query, [userId]);
  
  res.json(result.rows);
}));

// Get Unread Count - FIXED
app.get('/api/notifications/:username/unread-count', catchAsync(async (req, res) => {
  const { username } = req.params;
  
  const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
  if (!user.rows.length) return res.status(404).json({ error: "User not found" });
  
  const userId = user.rows[0].id;

  const query = "SELECT COUNT(*) as count FROM notifications WHERE recipient_id = $1 AND read = false";
  const result = await pool.query(query, [userId]);
  
  res.json({ count: parseInt(result.rows[0].count) });
}));

// Mark as Read - FIXED
app.post('/api/notifications/:username/mark-read', catchAsync(async (req, res) => {
  const { username } = req.params;
  
  const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
  if (!user.rows.length) return res.status(404).json({ error: "User not found" });
  
  const userId = user.rows[0].id;

  await pool.query(
    "UPDATE notifications SET read = true WHERE recipient_id = $1", 
    [userId]
  );
  
  res.json({ success: true });
}));

// --- DIRECT MESSAGES - FIXED ---

// Start Conversation - FIXED
app.post('/api/dm/conversation', catchAsync(async (req, res) => {
  const { username1, username2 } = req.body;
  
  if (!username1 || !username2) {
    return res.status(400).json({ error: "نام‌های کاربری الزامی هستند" });
  }

  const [u1, u2] = await Promise.all([
    pool.query("SELECT id, username, display_name, avatar_url, verification FROM users WHERE username = $1", [username1]),
    pool.query("SELECT id, username, display_name, avatar_url, verification FROM users WHERE username = $1", [username2])
  ]);
  
  if (!u1.rows.length || !u2.rows.length) {
    return res.status(404).json({ error: "یکی از کاربران یافت نشد" });
  }

  const id1 = Math.min(u1.rows[0].id, u2.rows[0].id);
  const id2 = Math.max(u1.rows[0].id, u2.rows[0].id);

  let conv = await pool.query(
    "SELECT * FROM conversations WHERE user1_id = $1 AND user2_id = $2", 
    [id1, id2]
  );
  
  if (conv.rows.length === 0) {
    conv = await pool.query(
      "INSERT INTO conversations (user1_id, user2_id) VALUES ($1, $2) RETURNING *", 
      [id1, id2]
    );
  }
  
  const conversation = conv.rows[0];
  
  // Get unread count for user1
  const unreadCount = await pool.query(`
    SELECT COUNT(*) as count FROM direct_messages 
    WHERE conversation_id = $1 AND sender_id != $2 AND read = false
  `, [conversation.id, u1.rows[0].id === id1 ? u1.rows[0].id : u2.rows[0].id]);

  // Get messages
  const messages = await pool.query(`
    SELECT dm.*, u.username, u.display_name, u.avatar_url, u.verification
    FROM direct_messages dm
    JOIN users u ON dm.sender_id = u.id
    WHERE conversation_id = $1 
    ORDER BY created_at ASC LIMIT 100
  `, [conversation.id]);

  res.json({ 
    conversation: { 
      ...conversation, 
      unread_count: parseInt(unreadCount.rows[0].count),
      other_user: username1 === username2 ? username1 : (username1 === u1.rows[0].username ? u2.rows[0].username : u1.rows[0].username),
      other_display_name: username1 === username2 ? u1.rows[0].display_name : (username1 === u1.rows[0].username ? u2.rows[0].display_name : u1.rows[0].display_name),
      other_avatar: username1 === username2 ? u1.rows[0].avatar_url : (username1 === u1.rows[0].username ? u2.rows[0].avatar_url : u1.rows[0].avatar_url),
      other_verification: username1 === username2 ? u1.rows[0].verification : (username1 === u1.rows[0].username ? u2.rows[0].verification : u1.rows[0].verification)
    }, 
    messages: messages.rows 
  });
}));

// Get Conversations List - FIXED
app.get('/api/dm/list/:username', catchAsync(async (req, res) => {
  const { username } = req.params;
  
  const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
  if (!user.rows.length) return res.status(404).json({ error: "User not found" });
  
  const userId = user.rows[0].id;

  const query = `
    SELECT 
      c.id as conversation_id, 
      c.last_message, 
      c.updated_at,
      CASE WHEN c.user1_id = $1 THEN u2.username ELSE u1.username END as other_user,
      CASE WHEN c.user1_id = $1 THEN u2.display_name ELSE u1.display_name END as other_display_name,
      CASE WHEN c.user1_id = $1 THEN u2.avatar_url ELSE u1.avatar_url END as other_avatar,
      CASE WHEN c.user1_id = $1 THEN u2.verification ELSE u1.verification END as other_verification,
      (SELECT COUNT(*) FROM direct_messages dm 
       WHERE dm.conversation_id = c.id 
       AND dm.sender_id != $1 
       AND dm.read = false) as unread_count
    FROM conversations c
    JOIN users u1 ON c.user1_id = u1.id
    JOIN users u2 ON c.user2_id = u2.id
    WHERE c.user1_id = $1 OR c.user2_id = $1
    ORDER BY c.updated_at DESC
  `;
  
  const result = await pool.query(query, [userId]);
  res.json(result.rows);
}));

// Delete Message - FIXED
app.delete('/api/dm/:messageId', catchAsync(async (req, res) => {
  const { username } = req.body;
  const messageId = req.params.messageId;
  
  if (!username) {
    return res.status(400).json({ error: "نام کاربری الزامی است" });
  }

  const checkSender = await pool.query(`
    SELECT dm.id, dm.conversation_id FROM direct_messages dm
    JOIN users u ON dm.sender_id = u.id
    WHERE dm.id = $1 AND u.username = $2
  `, [messageId, username]);

  if (checkSender.rows.length === 0) {
    return res.status(403).json({ error: "Unauthorized or message not found" });
  }

  await pool.query("DELETE FROM direct_messages WHERE id = $1", [messageId]);
  
  const conversationId = checkSender.rows[0].conversation_id;
  io.to(`conv_${conversationId}`).emit('dm_deleted', messageId);

  res.json({ success: true });
}));

// Mark DM as Read - FIXED
app.post('/api/dm/conversation/:conversationId/mark-read', catchAsync(async (req, res) => {
  const { conversationId } = req.params;
  const { username } = req.body;
  
  if (!username) {
    return res.status(400).json({ error: "نام کاربری الزامی است" });
  }

  const user = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
  if (!user.rows.length) return res.status(404).json({ error: "User not found" });
  
  const userId = user.rows[0].id;

  const conv = await pool.query(
    "SELECT user1_id, user2_id FROM conversations WHERE id = $1", 
    [conversationId]
  );
  
  if (!conv.rows.length) return res.status(404).json({ error: "Conversation not found" });

  const { user1_id, user2_id } = conv.rows[0];
  const otherUserId = userId === user1_id ? user2_id : user1_id;

  await pool.query(`
    UPDATE direct_messages 
    SET read = true 
    WHERE conversation_id = $1 
    AND sender_id = $2
    AND read = false
  `, [conversationId, otherUserId]);

  res.json({ success: true });
}));

// --- ADMIN MANAGEMENT - FIXED ---

// Grant Verification - FIXED
app.post('/api/admin/verification', catchAsync(async (req, res) => {
  const { adminUsername, targetUsername, type } = req.body;
  
  if (!adminUsername || !targetUsername || !type) {
    return res.status(400).json({ error: "اطلاعات ناقص است" });
  }

  if (!['gold', 'blue'].includes(type)) {
    return res.status(400).json({ error: "نوع تیک نامعتبر است" });
  }

  // Check if admin
  const adminUser = await pool.query(
    "SELECT id, is_admin FROM users WHERE username = $1", 
    [adminUsername]
  );
  
  if (!adminUser.rows.length || !adminUser.rows[0].is_admin) {
    return res.status(403).json({ error: "دسترسی غیرمجاز - فقط ادمین" });
  }

  // Update verification
  const result = await pool.query(
    `UPDATE users SET verification = $1 
     WHERE username = $2 
     RETURNING id, username, display_name, verification`,
    [type, targetUsername]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "کاربر یافت نشد" });
  }

  const targetUser = result.rows[0];

  // Create notification
  await pool.query(
    `INSERT INTO notifications (recipient_id, sender_id, type, content) 
     VALUES ($1, $2, 'VERIFICATION', $3)`,
    [
      targetUser.id, 
      adminUser.rows[0].id, 
      `تیک ${type === 'gold' ? 'طلایی' : 'آبی'} به شما اعطا شد!`
    ]
  );
  
  // Send realtime notification
  io.to(`user_${targetUser.id}`).emit('notification_alert', { 
    type: 'VERIFICATION', 
    message: `تیک ${type === 'gold' ? 'طلایی' : 'آبی'} به شما اعطا شد!`,
    verification_type: type
  });

  // Broadcast update
  io.emit('user_verification_updated', {
    username: targetUsername,
    verification: type
  });

  res.json({ 
    success: true, 
    message: `تیک ${type === 'gold' ? 'طلایی' : 'آبی'} با موفقیت اعطا شد`,
    user: targetUser
  });
}));

// Remove Verification - FIXED
app.post('/api/admin/remove-verification', catchAsync(async (req, res) => {
  const { adminUsername, targetUsername } = req.body;
  
  if (!adminUsername || !targetUsername) {
    return res.status(400).json({ error: "اطلاعات ناقص است" });
  }

  // Check if admin
  const adminUser = await pool.query(
    "SELECT id, is_admin FROM users WHERE username = $1", 
    [adminUsername]
  );
  
  if (!adminUser.rows.length || !adminUser.rows[0].is_admin) {
    return res.status(403).json({ error: "دسترسی غیرمجاز - فقط ادمین" });
  }

  // Remove verification
  const result = await pool.query(
    `UPDATE users SET verification = NULL 
     WHERE username = $1 
     RETURNING id, username, display_name`,
    [targetUsername]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: "کاربر یافت نشد" });
  }

  const targetUser = result.rows[0];

  // Broadcast update
  io.emit('user_verification_updated', {
    username: targetUsername,
    verification: null
  });

  res.json({ 
    success: true, 
    message: "تیک با موفقیت حذف شد",
    user: targetUser
  });
}));

// --- LIVE MATCHES & ROOMS - FIXED ---

app.get('/api/rooms/live', catchAsync(async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM match_rooms WHERE status = 'LIVE' ORDER BY created_at DESC"
  );
  res.json(result.rows);
}));

app.get('/api/rooms/:matchId/messages', catchAsync(async (req, res) => {
  const query = `
    SELECT m.id, m.content, m.created_at, 
           u.username, u.display_name, u.avatar_url, u.verification
    FROM messages m
    JOIN users u ON m.user_id = u.id
    WHERE m.match_id = $1
    ORDER BY m.created_at ASC
  `;
  
  const result = await pool.query(query, [req.params.matchId]);
  res.json(result.rows);
}));

// ======================================================
// 4. SOCKET.IO LOGIC - FIXED
// ======================================================

const roomOnlineUsers = new Map();
const userSocketMap = new Map();

io.on('connection', (socket) => {
  console.log('🔌 New connection:', socket.id);
  
  // Register user
  socket.on('register_user', async (username) => {
    try {
      if (!username || typeof username !== 'string') return;
      
      const res = await pool.query(
        "SELECT id FROM users WHERE username = $1", 
        [username]
      );
      
      if (res.rows.length > 0) {
        const userId = res.rows[0].id;
        socket.join(`user_${userId}`);
        socket.data.userId = userId;
        socket.data.username = username;
        userSocketMap.set(userId, socket.id);
        
        // Update last active
        await pool.query(
          "UPDATE users SET last_active = NOW() WHERE id = $1", 
          [userId]
        );
        
        console.log(`✅ User registered: ${username} (${userId})`);
      }
    } catch (err) { 
      console.error("Socket Auth Error", err); 
    }
  });

  // Join room
  socket.on('join_room', (matchId) => {
    socket.join(matchId);
    const count = (roomOnlineUsers.get(matchId) || 0) + 1;
    roomOnlineUsers.set(matchId, count);
    io.to(matchId).emit('room_users_count', count);
    console.log(`👥 User joined room: ${matchId}, Count: ${count}`);
  });

  // Leave room
  socket.on('leave_room', (matchId) => {
    socket.leave(matchId);
    const count = Math.max(0, (roomOnlineUsers.get(matchId) || 1) - 1);
    roomOnlineUsers.set(matchId, count);
    io.to(matchId).emit('room_users_count', count);
    console.log(`👋 User left room: ${matchId}, Count: ${count}`);
  });

  // Typing indicator
  socket.on('typing', ({ matchId, isTyping, username }) => {
    if(matchId && username) {
      socket.to(matchId).emit('user_typing', { username, isTyping });
    }
  });

  // Send message to room
  socket.on('send_message', async (data) => {
    const { matchId, username, content } = data;
    
    if (!content || !matchId || !username) return;
    
    const cleanContent = sanitize(content.trim());
    if (!cleanContent) return;

    try {
      const userRes = await pool.query(
        "SELECT id, display_name, avatar_url, verification FROM users WHERE username = $1", 
        [username]
      );
      
      if (userRes.rows.length > 0) {
        const user = userRes.rows[0];
        
        const messageRes = await pool.query(
          `INSERT INTO messages (content, user_id, match_id) 
           VALUES ($1, $2, $3) 
           RETURNING id, created_at`,
          [cleanContent, user.id, matchId]
        );

        const message = {
          id: messageRes.rows[0].id,
          username: username,
          display_name: user.display_name,
          content: cleanContent,
          avatar: user.avatar_url,
          verification: user.verification,
          created_at: messageRes.rows[0].created_at,
          time: new Date(messageRes.rows[0].created_at).toISOString()
        };

        // Broadcast to room
        io.to(matchId).emit('receive_message', message);
        console.log(`💬 Message sent to room ${matchId} by ${username}`);
      }
    } catch (err) { 
      console.error("Chat Socket Error:", err.message); 
      socket.emit('message_error', { error: 'خطا در ارسال پیام' });
    }
  });

  // Join conversation
  socket.on('join_conversation', (conversationId) => {
    socket.join(`conv_${conversationId}`);
    console.log(`🤝 User joined conversation: ${conversationId}`);
  });

  // Send DM
  socket.on('send_dm', async ({ conversationId, senderUsername, content }) => {
    if (!content || !conversationId || !senderUsername) return;
    
    const cleanContent = sanitize(content.trim());
    if (!cleanContent) return;
    
    try {
      const userRes = await pool.query(
        "SELECT id, display_name, avatar_url, verification FROM users WHERE username = $1", 
        [senderUsername]
      );
      
      if (userRes.rows.length > 0) {
        const senderId = userRes.rows[0].id;
        const senderName = userRes.rows[0].display_name || senderUsername;
        const senderAvatar = userRes.rows[0].avatar_url;
        const senderVerification = userRes.rows[0].verification;
        
        // Save message
        const messageRes = await pool.query(
          `INSERT INTO direct_messages (conversation_id, sender_id, content) 
           VALUES ($1, $2, $3) 
           RETURNING id, created_at`,
          [conversationId, senderId, cleanContent]
        );

        // Get conversation info
        const convRes = await pool.query(
          "SELECT user1_id, user2_id FROM conversations WHERE id = $1",
          [conversationId]
        );

        if (convRes.rows.length > 0) {
          const { user1_id, user2_id } = convRes.rows[0];
          const recipientId = senderId === user1_id ? user2_id : user1_id;

          // Update conversation last message
          await pool.query(
            "UPDATE conversations SET last_message = $1, updated_at = NOW() WHERE id = $2",
            [cleanContent.substring(0, 100), conversationId]
          );

          const message = {
            id: messageRes.rows[0].id,
            sender: senderUsername,
            sender_display_name: senderName,
            sender_avatar: senderAvatar,
            sender_verification: senderVerification,
            content: cleanContent,
            created_at: messageRes.rows[0].created_at,
            conversation_id: conversationId
          };

          // Send to conversation
          io.to(`conv_${conversationId}`).emit('receive_dm', message);

          // Get recipient username
          const recipientRes = await pool.query(
            "SELECT username FROM users WHERE id = $1", 
            [recipientId]
          );
          
          if (recipientRes.rows.length > 0) {
            const recipientUsername = recipientRes.rows[0].username;
            
            // Send notification if recipient not in conversation
            const socketsInConv = await io.in(`conv_${conversationId}`).fetchSockets();
            const recipientInConv = socketsInConv.some(s => 
              s.data.userId === recipientId
            );

            if (!recipientInConv) {
              io.to(`user_${recipientId}`).emit('notification_alert', {
                type: 'DM',
                message: `${senderUsername} پیام جدید برای شما ارسال کرد: ${cleanContent.substring(0, 50)}...`,
                conversation_id: conversationId,
                sender: senderUsername
              });
            }
          }
          
          console.log(`✉️ DM sent in conversation ${conversationId} from ${senderUsername}`);
        }
      }
    } catch (e) { 
      console.error("DM Error", e); 
      socket.emit('dm_error', { error: 'خطا در ارسال پیام خصوصی' });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    // Remove from user map
    if (socket.data.userId) {
      userSocketMap.delete(socket.data.userId);
    }
    
    // Update room counts
    for (const room of socket.rooms) {
      if (roomOnlineUsers.has(room)) {
        const count = Math.max(0, roomOnlineUsers.get(room) - 1);
        roomOnlineUsers.set(room, count);
        io.to(room).emit('room_users_count', count);
      }
    }
    
    console.log(`❌ Disconnected: ${socket.id}`);
  });
});

// ======================================================
// 5. ERROR HANDLING & SERVER START
// ======================================================

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('🔥 Global Error:', err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Pro Server 2026 FIXED VERSION Running on Port ${PORT}`);
  console.log(`📡 WebSocket ready at ws://localhost:${PORT}`);
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

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    pool.end(() => {
      console.log('HTTP server closed & DB pool ended');
      process.exit(0);
    });
  });
});