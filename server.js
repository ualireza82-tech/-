/**
 * AJ Sports 2026 - Ultimate Edition
 * PRO SERVER v2.5.0 - با پشتیبانی کامل از هشتگ و لینک
 * 
 * ⚠️ IMPORTANT: 
 * - فقط بخش هشتگ و لینک اضافه شده
 * - سایر بخش‌ها دقیقاً مثل قبل هستند
 * - کاملاً backward compatible
 * - تضمین عدم آسیب به سایر متدها
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { Readable } = require('stream');

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

// Middleware
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "PATCH"] }));
app.use(express.json({ limit: '50mb' }));

// Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Supabase Setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Cloudinary Setup
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Multer Setup for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
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

// Test database connection
async function testDatabaseConnection() {
  try {
    const client = await pool.connect();
    console.log('✅ Database connected successfully');
    client.release();
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
  }
}
testDatabaseConnection();

// ======================================================
// 2. ROOT ENDPOINT
// ======================================================

app.get('/', (req, res) => {
  res.json({ 
    message: 'AJ Sports 2026 Backend API', 
    version: '2.5.0',
    status: 'online',
    endpoints: {
      auth: '/api/auth/*',
      users: '/api/users/*',
      tweets: '/api/tweets/*',
      hashtags: '/api/tweets/hashtag/*',
      stories: '/api/stories/*',
      dms: '/api/dm/*',
      notifications: '/api/notifications/*',
      bookmarks: '/api/bookmarks/*',
      blocks: '/api/blocks/*',
      admin: '/api/admin/*',
      rooms: '/api/rooms/*',
      settings: '/api/settings/*',
      upload: '/api/upload/*'
    }
  });
});

// ======================================================
// 3. HEALTH CHECK
// ======================================================

app.get('/api/health', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT NOW() as time');
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: { connected: true, time: dbResult.rows[0].time },
      server: 'AJ Sports 2026 Backend v2.5.0'
    });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

// ======================================================
// 4. ✅ UPLOAD SYSTEM - آپلود مستقیم فایل
// ======================================================

// آپلود با FormData (برای همه موارد)
app.post('/api/upload/image', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'فایلی ارسال نشده است' });
    }

    // آپلود به Cloudinary
    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'ajsports',
          public_id: `img_${Date.now()}`,
          resource_type: 'auto'
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      
      const readableStream = new Readable();
      readableStream.push(req.file.buffer);
      readableStream.push(null);
      readableStream.pipe(uploadStream);
    });

    res.json({ 
      success: true, 
      url: result.secure_url,
      public_id: result.public_id 
    });
    
  } catch (error) {
    console.error("❌ Upload error:", error);
    res.status(500).json({ error: 'خطا در آپلود عکس' });
  }
});

// ======================================================
// 5. AUTH & USER MANAGEMENT
// ======================================================

// Check Account
app.post('/api/auth/check-account', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "ایمیل الزامی است" });

    const result = await pool.query(
      "SELECT id, username, display_name, avatar_url, header_url, verification, bio, is_admin FROM users WHERE email = $1",
      [email]
    );
    
    if (result.rows.length > 0) {
      const user = result.rows[0];
      return res.json({ 
        exists: true, 
        has_profile: true,
        user: {
          id: user.id,
          email: email,
          username: user.username,
          display_name: user.display_name,
          avatar_url: user.avatar_url,
          header_url: user.header_url,
          verification: user.verification,
          bio: user.bio,
          is_admin: user.is_admin
        }
      });
    } else {
      return res.json({ exists: false, has_profile: false });
    }
  } catch (error) {
    console.error("Check account error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send OTP
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: "ایمیل الزامی است" });
    }

    const { error } = await supabase.auth.signInWithOtp({ email });
    
    if (error) throw error;
    
    res.json({ success: true, message: "کد تأیید ارسال شد" });
    
  } catch (error) {
    console.error("❌ Send OTP error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Verify OTP
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, token } = req.body;
    
    if (!email || !token) {
      return res.status(400).json({ error: "ایمیل و کد الزامی هستند" });
    }

    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token,
      type: 'email'
    });

    if (error) throw error;
    
    res.json({ success: true, message: "کد صحیح است" });
    
  } catch (error) {
    console.error("❌ Verify OTP error:", error);
    res.status(400).json({ error: "کد نامعتبر است" });
  }
});

// Sync User
app.post('/api/auth/sync', async (req, res) => {
  try {
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
      RETURNING id, email, username, display_name, avatar_url, header_url, verification, bio, is_admin;
    `;
    
    const result = await pool.query(query, [
      email, 
      username, 
      display_name || username,
      avatar_url || 'https://via.placeholder.com/150'
    ]);
    
    const user = result.rows[0];
    
    if (email === "Shahriyarjadidi@gmail.com") {
      await pool.query(
        "UPDATE users SET is_admin = true, verification = 'gold' WHERE email = $1", 
        [email]
      );
      user.is_admin = true;
      user.verification = 'gold';
    }
    
    console.log('✅ User synced:', user.username);
    res.json({ success: true, user });
  } catch (error) {
    console.error("Auth sync error:", error);
    if (error.code === '23505') {
      return res.status(400).json({ error: "نام کاربری یا ایمیل قبلاً ثبت شده است" });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Profile
app.get('/api/users/profile/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const requesterUsername = req.query.me;
    
    const query = `
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.header_url, u.verification, u.bio, u.created_at,
      (SELECT COUNT(*) FROM follows WHERE following_id = u.id) as followers_count,
      (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) as following_count,
      (SELECT COUNT(*) FROM tweets WHERE user_id = u.id) as tweets_count
      FROM users u
      WHERE u.username = $1
    `;
    
    const result = await pool.query(query, [username]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const user = result.rows[0];
    let isFollowing = false;

    if (requesterUsername) {
      const reqUser = await pool.query(
        "SELECT id FROM users WHERE username = $1", 
        [requesterUsername]
      );
      if (reqUser.rows.length > 0) {
        const check = await pool.query(
          "SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2", 
          [reqUser.rows[0].id, user.id]
        );
        isFollowing = check.rows.length > 0;
      }
    }

    res.json({ ...user, is_following: isFollowing });
  } catch (error) {
    console.error("Profile error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get User's Tweets
app.get('/api/users/:username/tweets', async (req, res) => {
  try {
    const { username } = req.params;
    const requesterUsername = req.query.me;
    
    const userRes = await pool.query(
      "SELECT id FROM users WHERE username = $1", 
      [username]
    );
    
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const userId = userRes.rows[0].id;
    let requesterId = null;
    
    if (requesterUsername) {
      const reqRes = await pool.query(
        "SELECT id FROM users WHERE username = $1", 
        [requesterUsername]
      );
      if (reqRes.rows.length > 0) {
        requesterId = reqRes.rows[0].id;
      }
    }
    
    const query = `
      SELECT 
        t.id, t.content, t.created_at, t.likes_count, t.user_id, t.parent_id, t.media_url,
        u.username, u.display_name, u.avatar_url, u.verification,
        (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count,
        (SELECT COUNT(*) FROM retweets WHERE tweet_id = t.id) as retweet_count,
        ${requesterId ? `
          EXISTS(SELECT 1 FROM likes WHERE tweet_id = t.id AND user_id = $2) as has_liked,
          EXISTS(SELECT 1 FROM retweets WHERE tweet_id = t.id AND user_id = $2) as has_retweeted,
          EXISTS(SELECT 1 FROM bookmarks WHERE tweet_id = t.id AND user_id = $2) as has_bookmarked
        ` : `
          false as has_liked, false as has_retweeted, false as has_bookmarked
        `}
      FROM tweets t
      JOIN users u ON t.user_id = u.id
      WHERE t.user_id = $1 AND t.parent_id IS NULL
      ORDER BY t.created_at DESC
      LIMIT 50
    `;
    
    const params = requesterId ? [userId, requesterId] : [userId];
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error("User tweets error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update Profile
app.put('/api/users/update', async (req, res) => {
  try {
    const { username, display_name, bio, avatar_url, header_url } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: "نام کاربری الزامی است" });
    }

    const query = `
      UPDATE users 
      SET display_name = COALESCE($1, display_name), 
          bio = COALESCE($2, bio), 
          avatar_url = COALESCE($3, avatar_url),
          header_url = COALESCE($4, header_url),
          last_active = NOW()
      WHERE username = $5
      RETURNING id, username, display_name, bio, avatar_url, header_url, verification;
    `;
    
    const result = await pool.query(query, [
      display_name || null,
      bio || null,
      avatar_url || null,
      header_url || null,
      username
    ]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Search Users
app.get('/api/users/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    
    const result = await pool.query(
      `SELECT username, display_name, avatar_url, header_url, verification 
       FROM users 
       WHERE username ILIKE $1 OR display_name ILIKE $1 
       ORDER BY 
         CASE WHEN username ILIKE $2 THEN 1 
              WHEN display_name ILIKE $2 THEN 2 
              ELSE 3 END
       LIMIT 15`,
      [`%${q}%`, `${q}%`]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======================================================
// 6. STORY SYSTEM - بدون تغییر
// ======================================================

// Create Story
app.post('/api/stories', async (req, res) => {
  try {
    const { username, type, media_url, text, text_color } = req.body;
    
    if (!username || !type) {
      return res.status(400).json({ error: "اطلاعات ناقص است" });
    }

    const user = await pool.query(
      "SELECT id, display_name, avatar_url, header_url FROM users WHERE username = $1", 
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "کاربر یافت نشد" });
    }
    
    const userId = user.rows[0].id;

    await pool.query(
      "DELETE FROM stories WHERE user_id = $1 AND created_at < NOW() - INTERVAL '24 hours'",
      [userId]
    );

    const result = await pool.query(
      `INSERT INTO stories (user_id, type, media_url, text, text_color) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, type, media_url, text, text_color, created_at`,
      [userId, type, media_url || null, text || null, text_color || null]
    );

    const story = {
      ...result.rows[0],
      username: username,
      display_name: user.rows[0].display_name || username,
      avatar_url: user.rows[0].avatar_url || 'https://via.placeholder.com/150'
    };

    io.emit('new_story', story);
    res.json({ success: true, story });
  } catch (error) {
    console.error("❌ Create story error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Stories for Following Users
app.get('/api/stories/following/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    const user = await pool.query(
      "SELECT id, display_name, avatar_url, header_url FROM users WHERE username = $1", 
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "کاربر یافت نشد" });
    }

    const query = `
      SELECT 
        s.id, s.type, s.media_url, s.text, s.text_color, s.created_at,
        u.id as user_id, u.username, u.display_name, u.avatar_url, u.header_url
      FROM stories s
      JOIN users u ON s.user_id = u.id
      WHERE s.created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY s.created_at DESC
    `;
    
    const result = await pool.query(query);
    const storiesByUser = {};
    
    result.rows.forEach(story => {
      const userKey = story.username;
      if (!storiesByUser[userKey]) {
        storiesByUser[userKey] = {
          username: story.username,
          display_name: story.display_name,
          avatar_url: story.avatar_url,
          header_url: story.header_url,
          stories: []
        };
      }
      storiesByUser[userKey].stories.push({
        id: story.id,
        type: story.type,
        media_url: story.media_url,
        text: story.text,
        text_color: story.text_color,
        created_at: story.created_at
      });
    });

    let response = Object.values(storiesByUser);
    if (!storiesByUser[username]) {
      response.unshift({
        username: username,
        display_name: user.rows[0].display_name || username,
        avatar_url: user.rows[0].avatar_url || 'https://via.placeholder.com/150',
        header_url: user.rows[0].header_url || null,
        stories: []
      });
    }

    res.json(response);
  } catch (error) {
    console.error("❌ Get stories error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get User Stories
app.get('/api/stories/user/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    const user = await pool.query(
      "SELECT id, display_name, avatar_url, header_url FROM users WHERE username = $1", 
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "کاربر یافت نشد" });
    }
    
    const userId = user.rows[0].id;

    const storiesRes = await pool.query(
      `SELECT id, type, media_url, text, text_color, created_at 
       FROM stories 
       WHERE user_id = $1 
       AND created_at >= NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json({
      user: {
        username: username,
        display_name: user.rows[0].display_name || username,
        avatar_url: user.rows[0].avatar_url || 'https://via.placeholder.com/150',
        header_url: user.rows[0].header_url || null
      },
      stories: storiesRes.rows
    });
  } catch (error) {
    console.error("❌ Get user stories error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete Story
app.delete('/api/stories/:storyId', async (req, res) => {
  try {
    const { storyId } = req.params;
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: "نام کاربری الزامی است" });
    }

    const check = await pool.query(`
      SELECT s.id FROM stories s
      JOIN users u ON s.user_id = u.id
      WHERE s.id = $1 AND u.username = $2
    `, [storyId, username]);

    if (check.rows.length === 0) {
      return res.status(403).json({ error: "دسترسی غیرمجاز" });
    }

    await pool.query("DELETE FROM stories WHERE id = $1", [storyId]);
    io.emit('story_deleted', storyId);
    res.json({ success: true });
  } catch (error) {
    console.error("❌ Delete story error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======================================================
// 7. TWEET SYSTEM - ✅ اصلاح شده برای media_url
// ======================================================

// Feed
app.get('/api/tweets/feed', async (req, res) => {
  try {
    const username = req.query.username;
    
    let userId = null;
    if (username) {
      const u = await pool.query(
        "SELECT id FROM users WHERE username = $1", 
        [username]
      );
      if (u.rows.length) userId = u.rows[0].id;
    }

    const query = `
      SELECT 
        t.id, t.content, t.created_at, t.likes_count, t.user_id, t.parent_id, t.media_url,
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
  } catch (error) {
    console.error("Feed error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======================================================
// ✅ 7.5 HASHTAG SYSTEM - اضافه شده بدون آسیب به سایر بخش‌ها
// ======================================================

/**
 * تابع کمکی برای استخراج هشتگ‌ها از متن
 */
function extractHashtags(content) {
  if (!content) return [];
  const hashtagRegex = /#([\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFFa-zA-Z0-9_]+)/g;
  const matches = content.match(hashtagRegex);
  if (!matches) return [];
  return [...new Set(matches.map(tag => tag.substring(1)))];
}

/**
 * GET /api/tweets/hashtag/:hashtag
 * جستجوی توییت‌ها بر اساس هشتگ
 */
app.get('/api/tweets/hashtag/:hashtag', async (req, res) => {
  try {
    const { hashtag } = req.params;
    const requesterUsername = req.query.username;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    
    if (!hashtag || hashtag.trim() === '') {
      return res.status(400).json({ 
        success: false,
        error: "هشتگ نمی‌تواند خالی باشد" 
      });
    }

    const cleanHashtag = hashtag.replace(/[#@!$%^&*()]/g, '').trim();
    
    if (cleanHashtag.length === 0 || cleanHashtag.length > 50) {
      return res.status(400).json({ 
        success: false,
        error: "هشتگ نامعتبر است (حداکثر ۵۰ کاراکتر)" 
      });
    }

    console.log(`🔍 Hashtag search: #${cleanHashtag} by ${requesterUsername || 'anonymous'}`);

    let requesterId = null;
    if (requesterUsername) {
      const userRes = await pool.query(
        "SELECT id FROM users WHERE username = $1",
        [requesterUsername]
      );
      if (userRes.rows.length > 0) {
        requesterId = userRes.rows[0].id;
      }
    }

    const searchPattern = `%#${cleanHashtag}%`;
    
    const query = `
      SELECT 
        t.id, 
        t.content, 
        t.created_at, 
        t.likes_count, 
        t.user_id, 
        t.parent_id, 
        t.media_url,
        u.username, 
        u.display_name, 
        u.avatar_url, 
        u.verification,
        u.bio,
        (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count,
        ${requesterId ? `
          EXISTS(SELECT 1 FROM likes WHERE tweet_id = t.id AND user_id = $2) as has_liked,
          EXISTS(SELECT 1 FROM bookmarks WHERE tweet_id = t.id AND user_id = $2) as has_bookmarked
        ` : `
          false as has_liked,
          false as has_bookmarked
        `}
      FROM tweets t
      JOIN users u ON t.user_id = u.id
      WHERE 
        t.content ILIKE $1 
        AND t.parent_id IS NULL
        ${requesterId ? `
          AND NOT EXISTS (
            SELECT 1 FROM blocks b 
            WHERE (b.blocker_id = u.id AND b.blocked_id = $2)
            OR (b.blocker_id = $2 AND b.blocked_id = u.id)
          )
        ` : ''}
      ORDER BY 
        CASE 
          WHEN t.content ILIKE '#${cleanHashtag} %' THEN 1
          WHEN t.content ILIKE '% #${cleanHashtag} %' THEN 2
          WHEN t.content ILIKE '% #${cleanHashtag}' THEN 3
          ELSE 4
        END,
        t.created_at DESC
      LIMIT $3 OFFSET $4
    `;

    const params = requesterId 
      ? [searchPattern, requesterId, limit, offset]
      : [searchPattern, limit, offset];

    const result = await pool.query(query, params);

    const countQuery = `
      SELECT COUNT(*) as total
      FROM tweets t
      JOIN users u ON t.user_id = u.id
      WHERE t.content ILIKE $1 
      AND t.parent_id IS NULL
      ${requesterId ? `
        AND NOT EXISTS (
          SELECT 1 FROM blocks b 
          WHERE (b.blocker_id = u.id AND b.blocked_id = $2)
          OR (b.blocker_id = $2 AND b.blocked_id = u.id)
        )
      ` : ''}
    `;
    
    const countParams = requesterId 
      ? [searchPattern, requesterId]
      : [searchPattern];
      
    const countResult = await pool.query(countQuery, countParams);
    const totalCount = parseInt(countResult.rows[0]?.total || 0);

    const tweets = result.rows.map(tweet => ({
      ...tweet,
      media_type: tweet.media_url?.includes('.mp4') ? 'gif' : 'image',
      has_liked: tweet.has_liked || false,
      has_bookmarked: tweet.has_bookmarked || false,
      hashtags: extractHashtags(tweet.content)
    }));

    res.json({
      success: true,
      hashtag: cleanHashtag,
      total: totalCount,
      returned: tweets.length,
      offset: offset,
      limit: limit,
      has_more: offset + tweets.length < totalCount,
      tweets: tweets
    });

  } catch (error) {
    console.error("❌ Hashtag search error:", {
      message: error.message,
      stack: error.stack,
      code: error.code
    });
    
    res.status(500).json({ 
      success: false,
      error: "خطای داخلی سرور",
      message: error.message
    });
  }
});

/**
 * GET /api/tweets/hashtag/:hashtag/more
 * بارگذاری بیشتر برای اینفینیت اسکرول
 */
app.get('/api/tweets/hashtag/:hashtag/more', async (req, res) => {
  try {
    const { hashtag } = req.params;
    const { username, offset, limit = 10 } = req.query;
    
    const cleanHashtag = hashtag.replace(/[#]/g, '').trim();
    const offsetNum = parseInt(offset) || 0;
    const limitNum = Math.min(parseInt(limit) || 10, 20);
    
    let requesterId = null;
    if (username) {
      const userRes = await pool.query(
        "SELECT id FROM users WHERE username = $1",
        [username]
      );
      if (userRes.rows.length > 0) {
        requesterId = userRes.rows[0].id;
      }
    }

    const searchPattern = `%#${cleanHashtag}%`;
    
    const query = `
      SELECT 
        t.id, 
        t.content, 
        t.created_at, 
        t.likes_count, 
        t.user_id, 
        t.media_url,
        u.username, 
        u.display_name, 
        u.avatar_url, 
        u.verification,
        (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count,
        ${requesterId ? `
          EXISTS(SELECT 1 FROM likes WHERE tweet_id = t.id AND user_id = $2) as has_liked
        ` : 'false as has_liked'}
      FROM tweets t
      JOIN users u ON t.user_id = u.id
      WHERE 
        t.content ILIKE $1 
        AND t.parent_id IS NULL
      ORDER BY t.created_at DESC
      LIMIT $3 OFFSET $4
    `;

    const params = requesterId 
      ? [searchPattern, requesterId, limitNum, offsetNum]
      : [searchPattern, limitNum, offsetNum];

    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      tweets: result.rows,
      has_more: result.rows.length === limitNum
    });

  } catch (error) {
    console.error("❌ Load more hashtag tweets error:", error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

console.log('✅ Hashtag System v1.0 loaded successfully');

// ======================================================
// ✅ 7.6 LINK METADATA FUNCTION - حل مشکل fetch metadata
// ======================================================

// ============================================================================
// ✅ تابع دریافت متادیتای لینک - نسخه جهانی و ضد خطا
// ============================================================================
// ======================================================
// 1. CONFIGURATION & SETUP
// ======================================================

const fetch = require('node-fetch');  // ✅ این خط رو اضافه کن
global.Headers = fetch.Headers;       // ✅ این خط رو هم اضافه کن
async function fetchLinkMetadata(url) {
  try {
    // 1. پاکسازی و نرمال‌سازی URL
    let fullUrl = url.trim();
    
    // حذف فاصله‌های اضافی
    fullUrl = fullUrl.replace(/\s+/g, '');
    
    // اگه با www شروع شد
    if (fullUrl.startsWith('www.')) {
      fullUrl = 'https://' + fullUrl;
    }
    // اگه هیچ پروتکلی نداشت
    else if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
      fullUrl = 'https://' + fullUrl;
    }
    
    console.log(`🔍 Fetching metadata for: ${fullUrl}`);

    // 2. بررسی اعتبار URL با try/catch
    try {
      new URL(fullUrl);
    } catch (e) {
      console.log('⚠️ Invalid URL format, using fallback');
      return {
        url: url,
        title: url,
        description: '',
        image: null,
        siteName: 'لینک',
        fromCache: true
      };
    }

    // 3. درخواست با timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(fullUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      redirect: 'follow'
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const html = await response.text();
    
    // 4. توابع استخراج با پشتیبانی از همه فرمت‌ها
    const getMeta = (name) => {
      // Open Graph
      const ogRegex = new RegExp(`<meta[^>]*property=["']og:${name}["'][^>]*content=["']([^"']+)["']`, 'i');
      const ogMatch = html.match(ogRegex);
      if (ogMatch) return ogMatch[1];
      
      // Twitter
      const twitterRegex = new RegExp(`<meta[^>]*name=["']twitter:${name}["'][^>]*content=["']([^"']+)["']`, 'i');
      const twitterMatch = html.match(twitterRegex);
      if (twitterMatch) return twitterMatch[1];
      
      // Standard
      if (name === 'title') {
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch) return titleMatch[1].trim();
      }
      if (name === 'description') {
        const descRegex = /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i;
        const descMatch = html.match(descRegex);
        if (descMatch) return descMatch[1];
      }
      
      return null;
    };

    // 5. استخراج اطلاعات
    const title = getMeta('title') || fullUrl;
    const description = getMeta('description') || '';
    const image = getMeta('image') || null;
    
    // استخراج siteName با try/catch
    let siteName = getMeta('site_name');
    if (!siteName) {
      try {
        const urlObj = new URL(fullUrl);
        siteName = urlObj.hostname.replace('www.', '');
      } catch (e) {
        siteName = 'لینک';
      }
    }

    return {
      url: fullUrl,
      title: title.substring(0, 200),
      description: description.substring(0, 300),
      image: image,
      siteName: siteName,
      success: true
    };

  } catch (error) {
    console.error('❌ Error in fetchLinkMetadata:', error.message);
    
    // 6. برگرداندن اطلاعات پایه در صورت هرگونه خطا
    try {
      // تلاش برای استخراج hostname حتی با URL نامعتبر
      let siteName = 'لینک';
      try {
        const urlObj = new URL(url.startsWith('http') ? url : 'https://' + url);
        siteName = urlObj.hostname.replace('www.', '');
      } catch (e) {}
      
      return {
        url: url,
        title: url,
        description: '',
        image: null,
        siteName: siteName,
        success: false,
        error: error.message
      };
    } catch (e) {
      // نهایتاً ساده‌ترین حالت
      return {
        url: url,
        title: url,
        description: '',
        image: null,
        siteName: 'لینک',
        success: false
      };
    }
  }
}

// ======================================================
// ✅ 7.7 CREATE TWEET - نسخه نهایی با پشتیبانی کامل از لینک و هشتگ
// ======================================================

// Create Tweet با پشتیبانی کامل از لینک کارت و هشتگ
app.post('/api/tweets', async (req, res) => {
  try {
    const { username, content, parentId, media_url } = req.body;
    
    if (!username || (!content && !media_url)) {
      return res.status(400).json({ error: "نام کاربری و محتوا یا عکس الزامی هستند" });
    }

    const cleanContent = content ? content.trim() : '';
    
    const userRes = await pool.query(
      "SELECT id, username, display_name, avatar_url, verification FROM users WHERE username = $1", 
      [username]
    );
    
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const user = userRes.rows[0];

    // استخراج هشتگ‌ها
    const hashtags = extractHashtags(cleanContent);

    // بررسی وجود لینک در متن برای کارت لینک
    let linkCard = null;
    if (cleanContent && !media_url) { // فقط اگر عکس نداشت
      const urlRegex = /(https?:\/\/[^\s]+)|(?:^|\s)(([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s]*)?)(?=\s|$)/g;
      const urlMatch = cleanContent.match(urlRegex);
      
      if (urlMatch && urlMatch.length > 0) {
        const firstUrl = urlMatch[0].trim();
        try {
          linkCard = await fetchLinkMetadata(firstUrl);
          console.log('✅ Link card created for:', firstUrl);
        } catch (e) {
          console.error('❌ Link card creation failed:', e);
        }
      }
    }

    // درج توییت در دیتابیس
    const insertRes = await pool.query(
      `INSERT INTO tweets (user_id, content, parent_id, media_url, link_card, hashtags) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING id, content, created_at, likes_count, media_url, link_card, hashtags`,
      [
        user.id, 
        cleanContent, 
        parentId || null, 
        media_url || null,
        linkCard ? JSON.stringify(linkCard) : null,
        hashtags
      ]
    );

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
      has_bookmarked: false,
      media_url: media_url || null,
      link_card: linkCard,
      hashtags: hashtags,
      link_card_processed: !!linkCard
    };

    // ارسال به سوکت
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
            `${user.username} به توییت شما پاسخ داد`
          ]
        );
        
        io.to(`user_${parentTweet.rows[0].user_id}`).emit('notification_alert', { 
          type: 'REPLY', 
          message: `${user.username} به توییت شما پاسخ داد`,
          reference_id: insertRes.rows[0].id
        });
      }
      
      io.emit(`new_reply_${parentId}`, newTweet);
    } else {
      io.emit('new_tweet', newTweet);
    }
    
    res.json({ success: true, tweet: newTweet, link_card_created: !!linkCard });
    
  } catch (error) {
    console.error("❌ Create tweet error:", error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// ======================================================
// 8. NOTIFICATIONS SYSTEM - بدون تغییر
// ======================================================

// Get Notifications
app.get('/api/notifications/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    const user = await pool.query(
      "SELECT id FROM users WHERE username = $1", 
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
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
  } catch (error) {
    console.error("Notifications error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Unread Count
app.get('/api/notifications/:username/unread-count', async (req, res) => {
  try {
    const { username } = req.params;
    
    const user = await pool.query(
      "SELECT id FROM users WHERE username = $1", 
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const userId = user.rows[0].id;

    const query = "SELECT COUNT(*) as count FROM notifications WHERE recipient_id = $1 AND read = false";
    const result = await pool.query(query, [userId]);
    
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (error) {
    console.error("Unread count error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark as Read
app.post('/api/notifications/:username/mark-read', async (req, res) => {
  try {
    const { username } = req.params;
    
    const user = await pool.query(
      "SELECT id FROM users WHERE username = $1", 
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const userId = user.rows[0].id;

    await pool.query(
      "UPDATE notifications SET read = true WHERE recipient_id = $1", 
      [userId]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error("Mark read error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======================================================
// 9. DIRECT MESSAGES - بدون تغییر
// ======================================================

// Get Conversations List
app.get('/api/dm/list/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    const user = await pool.query(
      "SELECT id FROM users WHERE username = $1", 
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
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
  } catch (error) {
    console.error("DM list error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start Conversation
app.post('/api/dm/conversation', async (req, res) => {
  try {
    const { username1, username2 } = req.body;
    
    if (!username1 || !username2) {
      return res.status(400).json({ error: "نام‌های کاربری الزامی هستند" });
    }

    const [u1, u2] = await Promise.all([
      pool.query("SELECT id, username, display_name, avatar_url, header_url, verification FROM users WHERE username = $1", [username1]),
      pool.query("SELECT id, username, display_name, avatar_url, header_url, verification FROM users WHERE username = $1", [username2])
    ]);
    
    if (u1.rows.length === 0 || u2.rows.length === 0) {
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
    
    const requesterId = u1.rows[0].id;
    const unreadCount = await pool.query(`
      SELECT COUNT(*) as count FROM direct_messages 
      WHERE conversation_id = $1 AND sender_id != $2 AND read = false
    `, [conversation.id, requesterId]);

    const messages = await pool.query(`
      SELECT dm.*, u.username, u.display_name, u.avatar_url, u.verification
      FROM direct_messages dm
      JOIN users u ON dm.sender_id = u.id
      WHERE conversation_id = $1 
      ORDER BY created_at ASC LIMIT 100
    `, [conversation.id]);

    const otherUser = username1 === username2 ? u1.rows[0] : 
                     (username1 === u1.rows[0].username ? u2.rows[0] : u1.rows[0]);

    res.json({ 
      conversation: { 
        ...conversation, 
        unread_count: parseInt(unreadCount.rows[0].count),
        other_user: otherUser.username,
        other_display_name: otherUser.display_name,
        other_avatar: otherUser.avatar_url,
        other_verification: otherUser.verification
      }, 
      messages: messages.rows 
    });
  } catch (error) {
    console.error("Start conversation error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete Message
app.delete('/api/dm/:messageId', async (req, res) => {
  try {
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
  } catch (error) {
    console.error("Delete DM error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark DM as Read
app.post('/api/dm/conversation/:conversationId/mark-read', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: "نام کاربری الزامی است" });
    }

    const user = await pool.query(
      "SELECT id FROM users WHERE username = $1", 
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const userId = user.rows[0].id;

    const conv = await pool.query(
      "SELECT user1_id, user2_id FROM conversations WHERE id = $1", 
      [conversationId]
    );
    
    if (conv.rows.length === 0) {
      return res.status(404).json({ error: "Conversation not found" });
    }

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
  } catch (error) {
    console.error("Mark DM read error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======================================================
// 10. ADMIN MANAGEMENT - بدون تغییر
// ======================================================

// Grant Verification
app.post('/api/admin/verification', async (req, res) => {
  try {
    const { adminUsername, targetUsername, type } = req.body;
    
    if (!adminUsername || !targetUsername || !type) {
      return res.status(400).json({ error: "اطلاعات ناقص است" });
    }

    if (!['gold', 'blue'].includes(type)) {
      return res.status(400).json({ error: "نوع تیک نامعتبر است" });
    }

    const adminUser = await pool.query(
      "SELECT id, is_admin FROM users WHERE username = $1", 
      [adminUsername]
    );
    
    if (!adminUser.rows.length || !adminUser.rows[0].is_admin) {
      return res.status(403).json({ error: "دسترسی غیرمجاز - فقط ادمین" });
    }

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

    await pool.query(
      `INSERT INTO notifications (recipient_id, sender_id, type, content) 
       VALUES ($1, $2, 'VERIFICATION', $3)`,
      [
        targetUser.id, 
        adminUser.rows[0].id, 
        `تیک ${type === 'gold' ? 'طلایی' : 'آبی'} به شما اعطا شد!`
      ]
    );
    
    io.to(`user_${targetUser.id}`).emit('notification_alert', { 
      type: 'VERIFICATION', 
      message: `تیک ${type === 'gold' ? 'طلایی' : 'آبی'} به شما اعطا شد!`,
      verification_type: type
    });

    io.emit('user_verification_updated', {
      username: targetUsername,
      verification: type
    });

    res.json({ 
      success: true, 
      message: `تیک ${type === 'gold' ? 'طلایی' : 'آبی'} با موفقیت اعطا شد`,
      user: targetUser
    });
  } catch (error) {
    console.error("Grant verification error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove Verification
app.post('/api/admin/remove-verification', async (req, res) => {
  try {
    const { adminUsername, targetUsername } = req.body;
    
    if (!adminUsername || !targetUsername) {
      return res.status(400).json({ error: "اطلاعات ناقص است" });
    }

    const adminUser = await pool.query(
      "SELECT id, is_admin FROM users WHERE username = $1", 
      [adminUsername]
    );
    
    if (!adminUser.rows.length || !adminUser.rows[0].is_admin) {
      return res.status(403).json({ error: "دسترسی غیرمجاز - فقط ادمین" });
    }

    const result = await pool.query(
      `UPDATE users SET verification = NULL 
       WHERE username = $1 
       RETURNING id, username, display_name`,
      [targetUsername]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "کاربر یافت نشد" });
    }

    io.emit('user_verification_updated', {
      username: targetUsername,
      verification: null
    });

    res.json({ 
      success: true, 
      message: "تیک با موفقیت حذف شد",
      user: result.rows[0]
    });
  } catch (error) {
    console.error("Remove verification error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======================================================
// 11. BLOCK SYSTEM
// ======================================================

// Block User
app.post('/api/blocks/block', async (req, res) => {
  try {
    const { blockerUsername, blockedUsername } = req.body;
    
    if (!blockerUsername || !blockedUsername) {
      return res.status(400).json({ error: "نام کاربری الزامی است" });
    }

    if (blockerUsername === blockedUsername) {
      return res.status(400).json({ error: "نمی‌توانید خودتان را بلاک کنید" });
    }

    const blockerQuery = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [blockerUsername]
    );
    
    const blockedQuery = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [blockedUsername]
    );

    if (blockerQuery.rows.length === 0) {
      return res.status(404).json({ error: "کاربر بلاک‌کننده یافت نشد" });
    }
    
    if (blockedQuery.rows.length === 0) {
      return res.status(404).json({ error: "کاربر مورد نظر برای بلاک یافت نشد" });
    }

    const blockerId = blockerQuery.rows[0].id;
    const blockedId = blockedQuery.rows[0].id;

    const existing = await pool.query(
      "SELECT id FROM blocks WHERE blocker_id = $1 AND blocked_id = $2",
      [blockerId, blockedId]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "کاربر قبلاً بلاک شده است" });
    }

    await pool.query(
      "INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)",
      [blockerId, blockedId]
    );

    await pool.query(
      "DELETE FROM follows WHERE (follower_id = $1 AND following_id = $2) OR (follower_id = $2 AND following_id = $1)",
      [blockerId, blockedId]
    ).catch(() => {});

    console.log(`🚫 [BLOCK] ${blockerUsername} -> ${blockedUsername}`);
    
    res.json({ 
      success: true, 
      message: "کاربر با موفقیت بلاک شد",
      data: { 
        blocker: blockerUsername, 
        blocked: blockedUsername 
      }
    });

  } catch (error) {
    console.error("❌ Block error:", error);
    res.status(500).json({ error: "خطای داخلی سرور" });
  }
});

// Unblock User
app.post('/api/blocks/unblock', async (req, res) => {
  try {
    const { blockerUsername, blockedUsername } = req.body;

    if (!blockerUsername || !blockedUsername) {
      return res.status(400).json({ error: "نام کاربری الزامی است" });
    }

    const blockerQuery = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [blockerUsername]
    );
    
    const blockedQuery = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [blockedUsername]
    );

    if (blockerQuery.rows.length === 0) {
      return res.status(404).json({ error: "کاربر آنبلاک‌کننده یافت نشد" });
    }
    
    if (blockedQuery.rows.length === 0) {
      return res.status(404).json({ error: "کاربر مورد نظر برای آنبلاک یافت نشد" });
    }

    const blockerId = blockerQuery.rows[0].id;
    const blockedId = blockedQuery.rows[0].id;

    const result = await pool.query(
      "DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2 RETURNING id",
      [blockerId, blockedId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "کاربر بلاک نشده بود" });
    }

    console.log(`✅ [UNBLOCK] ${blockerUsername} -> ${blockedUsername}`);
    
    res.json({ 
      success: true, 
      message: "کاربر با موفقیت آنبلاک شد",
      data: { 
        blocker: blockerUsername, 
        blocked: blockedUsername 
      }
    });

  } catch (error) {
    console.error("❌ Unblock error:", error);
    res.status(500).json({ error: "خطای داخلی سرور" });
  }
});

// Check Block Status
app.get('/api/blocks/status', async (req, res) => {
  try {
    const { user1, user2 } = req.query;

    if (!user1 || !user2) {
      return res.status(400).json({ error: "نام کاربری الزامی است" });
    }

    const user1Query = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [user1]
    );
    
    const user2Query = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [user2]
    );

    if (user1Query.rows.length === 0 || user2Query.rows.length === 0) {
      return res.json({ 
        is_blocked: false,
        blocked_by: null,
        blocked_user: null,
        message: "یکی از کاربران وجود ندارد" 
      });
    }

    const userId1 = user1Query.rows[0].id;
    const userId2 = user2Query.rows[0].id;

    const [user1BlocksUser2, user2BlocksUser1] = await Promise.all([
      pool.query(
        "SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2",
        [userId1, userId2]
      ),
      pool.query(
        "SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2",
        [userId2, userId1]
      )
    ]);

    let blockedBy = null;
    let blockedUser = null;
    
    if (user1BlocksUser2.rows.length > 0) {
      blockedBy = user1;
      blockedUser = user2;
    } else if (user2BlocksUser1.rows.length > 0) {
      blockedBy = user2;
      blockedUser = user1;
    }

    res.json({
      is_blocked: user1BlocksUser2.rows.length > 0 || user2BlocksUser1.rows.length > 0,
      blocked_by: blockedBy,
      blocked_user: blockedUser,
      blocked_by_me: blockedBy === user1,
      blocked_me: blockedBy === user2
    });

  } catch (error) {
    console.error("❌ Block status error:", error);
    res.status(500).json({ error: "خطای داخلی سرور" });
  }
});

// Get Blocked Users List
app.get('/api/blocks/:username', async (req, res) => {
  try {
    const { username } = req.params;

    const userQuery = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );

    if (userQuery.rows.length === 0) {
      return res.status(404).json({ error: "کاربر یافت نشد" });
    }

    const userId = userQuery.rows[0].id;

    const result = await pool.query(`
      SELECT 
        u.username,
        u.display_name,
        u.avatar_url,
        u.verification,
        b.created_at
      FROM blocks b
      JOIN users u ON b.blocked_id = u.id
      WHERE b.blocker_id = $1
      ORDER BY b.created_at DESC
    `, [userId]);

    res.json({
      success: true,
      count: result.rows.length,
      blocks: result.rows
    });

  } catch (error) {
    console.error("❌ Get blocks error:", error);
    res.status(500).json({ error: "خطای داخلی سرور" });
  }
});

// Batch Check Blocks
app.post('/api/blocks/batch-check', async (req, res) => {
  try {
    const { blockerUsername, usernames } = req.body;

    if (!blockerUsername || !usernames || !Array.isArray(usernames)) {
      return res.status(400).json({ error: "ورودی نامعتبر" });
    }

    if (usernames.length === 0) {
      return res.json({ results: {} });
    }

    const blockerQuery = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [blockerUsername]
    );

    if (blockerQuery.rows.length === 0) {
      return res.status(404).json({ error: "کاربر یافت نشد" });
    }

    const blockerId = blockerQuery.rows[0].id;

    const placeholders = usernames.map((_, i) => `$${i + 2}`).join(',');
    const query = `
      SELECT u.username, 
             EXISTS(SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = u.id) as is_blocked
      FROM users u
      WHERE u.username IN (${placeholders})
    `;

    const result = await pool.query(query, [blockerId, ...usernames]);

    const blockStatus = {};
    result.rows.forEach(row => {
      blockStatus[row.username] = row.is_blocked;
    });

    usernames.forEach(username => {
      if (blockStatus[username] === undefined) {
        blockStatus[username] = false;
      }
    });

    res.json({ results: blockStatus });

  } catch (error) {
    console.error("❌ Batch check error:", error);
    res.status(500).json({ error: "خطای داخلی سرور" });
  }
});

// ======================================================
// 12. ADMIN TWEET DELETE - بدون تغییر
// ======================================================
app.delete('/api/admin/tweets/:tweetId', async (req, res) => {
  try {
    const { tweetId } = req.params;
    const { adminUsername } = req.body;

    if (!adminUsername) {
      return res.status(400).json({ error: "نام کاربری ادمین الزامی است" });
    }

    const admin = await pool.query(
      "SELECT id FROM users WHERE username = $1 AND is_admin = true",
      [adminUsername]
    );

    if (admin.rows.length === 0) {
      return res.status(403).json({ error: "دسترسی غیرمجاز - فقط ادمین" });
    }

    const tweet = await pool.query(`
      SELECT t.id, t.user_id, u.username 
      FROM tweets t
      JOIN users u ON t.user_id = u.id
      WHERE t.id = $1
    `, [tweetId]);

    await pool.query("DELETE FROM tweets WHERE id = $1", [tweetId]);

    if (tweet.rows.length > 0) {
      const tweetOwnerId = tweet.rows[0].user_id;
      const tweetOwnerUsername = tweet.rows[0].username;

      await pool.query(
        `INSERT INTO notifications (recipient_id, sender_id, type, content, reference_id) 
         VALUES ($1, $2, 'ADMIN', $3, $4)`,
        [
          tweetOwnerId,
          admin.rows[0].id,
          `توییت شما توسط ادمین به دلیل نقض قوانین حذف شد.`,
          tweetId
        ]
      );

      io.to(`user_${tweetOwnerId}`).emit('notification_alert', {
        type: 'ADMIN',
        message: 'توییت شما توسط ادمین حذف شد',
        tweet_id: tweetId
      });

      console.log(`🗑️ Admin ${adminUsername} deleted tweet ${tweetId} from ${tweetOwnerUsername}`);
    }

    io.emit('tweet_deleted', tweetId);

    res.json({ 
      success: true, 
      message: "توییت با موفقیت حذف شد",
      deleted_by: adminUsername,
      tweet_id: tweetId
    });

  } catch (error) {
    console.error("❌ Admin delete tweet error:", error);
    res.status(500).json({ error: "خطای داخلی سرور" });
  }
});

// ======================================================
// 13. LIVE MATCHES & ROOMS - بدون تغییر
// ======================================================

app.get('/api/rooms/live', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM match_rooms WHERE status = 'LIVE' ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error("Live rooms error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/rooms/:matchId/messages', async (req, res) => {
  try {
    const { matchId } = req.params;
    const query = `
      SELECT m.id, m.content, m.created_at, 
             u.username, u.display_name, u.avatar_url, u.verification
      FROM messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.match_id = $1
      ORDER BY m.created_at ASC
    `;
    
    const result = await pool.query(query, [matchId]);
    res.json(result.rows);
  } catch (error) {
    console.error("Room messages error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======================================================
// 14. ACCOUNT SETTINGS & SESSIONS
// ======================================================

// ثبت و به‌روزرسانی کشور کاربر
app.post('/api/settings/country', async (req, res) => {
  try {
    const { username, ip_address } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: "نام کاربری الزامی است" });
    }

    const user = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "کاربر یافت نشد" });
    }
    
    const userId = user.rows[0].id;
    
    let countryData = {
      country_code: 'IR',
      country_name: 'Iran',
      city: 'Tehran'
    };
    
    if (ip_address && ip_address !== '::1' && ip_address !== '127.0.0.1') {
      try {
        const response = await fetch(`http://ip-api.com/json/${ip_address}`);
        if (response.ok) {
          const data = await response.json();
          if (data.status === 'success') {
            countryData = {
              country_code: data.countryCode,
              country_name: data.country,
              city: data.city
            };
          }
        }
      } catch (ipError) {
        console.error("IP geolocation error:", ipError);
      }
    }

    await pool.query(`
      INSERT INTO user_country (user_id, country_code, country_name, ip_address, last_seen)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id) 
      DO UPDATE SET 
        country_code = EXCLUDED.country_code,
        country_name = EXCLUDED.country_name,
        ip_address = EXCLUDED.ip_address,
        last_seen = NOW()
    `, [userId, countryData.country_code, countryData.country_name, ip_address]);

    res.json({ 
      success: true, 
      country: countryData 
    });

  } catch (error) {
    console.error("❌ Country update error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// دریافت اطلاعات حساب کاربری
app.get('/api/settings/account/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    const result = await pool.query(`
      SELECT 
        u.id,
        u.username,
        u.email,
        u.display_name,
        u.avatar_url,
        u.created_at,
        u.last_active,
        u.is_admin,
        u.verification,
        uc.country_code,
        uc.country_name,
        uc.ip_address as registered_ip
      FROM users u
      LEFT JOIN user_country uc ON u.id = uc.user_id
      WHERE u.username = $1
    `, [username]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.rows[0];
    
    res.json({
      username: user.username,
      email: user.email,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      created_at: user.created_at,
      last_active: user.last_active,
      country_code: user.country_code || 'IR',
      country_name: user.country_name || 'Iran',
      registered_ip: user.registered_ip || 'Unknown',
      is_admin: user.is_admin,
      verification: user.verification
    });

  } catch (error) {
    console.error("❌ Get account info error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// دریافت تمام نشست‌های فعال کاربر
app.get('/api/settings/sessions/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    const user = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const userId = user.rows[0].id;

    const sessions = await pool.query(`
      SELECT 
        id,
        device_info,
        ip_address,
        country_code,
        country_name,
        city,
        is_active,
        last_activity,
        created_at,
        CASE 
          WHEN id = (SELECT session_id FROM users WHERE id = $1) THEN true ELSE false 
        END as is_current_session
      FROM user_sessions
      WHERE user_id = $1 AND is_active = true
      ORDER BY last_activity DESC
    `, [userId]);

    res.json({ 
      success: true, 
      sessions: sessions.rows 
    });

  } catch (error) {
    console.error("❌ Get sessions error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ثبت نشست جدید
app.post('/api/settings/sessions/register', async (req, res) => {
  try {
    const { username, device_info, ip_address, session_token } = req.body;
    
    if (!username || !session_token) {
      return res.status(400).json({ error: "اطلاعات ناقص است" });
    }

    const user = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const userId = user.rows[0].id;

    let countryData = {
      country_code: 'IR',
      country_name: 'Iran',
      city: 'Tehran'
    };
    
    if (ip_address && ip_address !== '::1' && ip_address !== '127.0.0.1') {
      try {
        const response = await fetch(`http://ip-api.com/json/${ip_address}`);
        if (response.ok) {
          const data = await response.json();
          if (data.status === 'success') {
            countryData = {
              country_code: data.countryCode,
              country_name: data.country,
              city: data.city
            };
          }
        }
      } catch (ipError) {
        console.error("IP geolocation error:", ipError);
      }
    }

    await pool.query(
      "UPDATE user_sessions SET is_active = false WHERE session_token = $1",
      [session_token]
    );

    const result = await pool.query(`
      INSERT INTO user_sessions (
        user_id, session_token, device_info, ip_address, 
        country_code, country_name, city, is_active, last_activity
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, NOW())
      RETURNING id
    `, [
      userId, 
      session_token, 
      JSON.stringify(device_info || {}), 
      ip_address,
      countryData.country_code,
      countryData.country_name,
      countryData.city
    ]);

    await pool.query(`
      INSERT INTO user_country (user_id, country_code, country_name, ip_address, last_seen)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id) 
      DO UPDATE SET 
        country_code = EXCLUDED.country_code,
        country_name = EXCLUDED.country_name,
        ip_address = EXCLUDED.ip_address,
        last_seen = NOW()
    `, [userId, countryData.country_code, countryData.country_name, ip_address]);

    await pool.query(
      "UPDATE users SET session_id = $1 WHERE id = $2",
      [result.rows[0].id, userId]
    );

    res.json({ 
      success: true, 
      session_id: result.rows[0].id 
    });

  } catch (error) {
    console.error("❌ Register session error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// خروج از یک نشست خاص
app.post('/api/settings/sessions/terminate', async (req, res) => {
  try {
    const { username, session_id } = req.body;
    
    if (!username || !session_id) {
      return res.status(400).json({ error: "اطلاعات ناقص است" });
    }

    const user = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const userId = user.rows[0].id;

    const session = await pool.query(
      "SELECT id FROM user_sessions WHERE id = $1 AND user_id = $2",
      [session_id, userId]
    );

    if (session.rows.length === 0) {
      return res.status(403).json({ error: "دسترسی غیرمجاز" });
    }

    await pool.query(
      "UPDATE user_sessions SET is_active = false WHERE id = $1",
      [session_id]
    );

    const currentSession = await pool.query(
      "SELECT session_id FROM users WHERE id = $1",
      [userId]
    );

    const isCurrentSession = currentSession.rows[0]?.session_id === parseInt(session_id);

    res.json({ 
      success: true, 
      terminated: true,
      is_current_session: isCurrentSession
    });

  } catch (error) {
    console.error("❌ Terminate session error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// خروج از تمام نشست‌ها به جز نشست جاری
app.post('/api/settings/sessions/terminate-all', async (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: "نام کاربری الزامی است" });
    }

    const user = await pool.query(
      "SELECT id, session_id FROM users WHERE username = $1",
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const userId = user.rows[0].id;
    const currentSessionId = user.rows[0].session_id;

    await pool.query(`
      UPDATE user_sessions 
      SET is_active = false 
      WHERE user_id = $1 AND id != $2
    `, [userId, currentSessionId || 0]);

    res.json({ 
      success: true, 
      message: "تمام نشست‌های دیگر با موفقیت پایان یافتند" 
    });

  } catch (error) {
    console.error("❌ Terminate all sessions error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ارسال OTP برای تأیید حذف حساب
app.post('/api/settings/deactivation/send-otp', async (req, res) => {
  try {
    const { username, email } = req.body;
    
    if (!username || !email) {
      return res.status(400).json({ error: "اطلاعات ناقص است" });
    }

    const user = await pool.query(
      "SELECT id, email FROM users WHERE username = $1 AND email = $2",
      [username, email]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "کاربر یافت نشد" });
    }
    
    const userId = user.rows[0].id;

    await pool.query(
      "DELETE FROM account_deactivation_requests WHERE user_id = $1",
      [userId]
    );

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(Date.now() + 10 * 60000);

    await pool.query(`
      INSERT INTO account_deactivation_requests 
        (user_id, username, email, otp_code, otp_expires_at, status)
      VALUES ($1, $2, $3, $4, $5, 'pending')
    `, [userId, username, email, otp, otpExpires]);

    console.log(`📧 OTP for ${username}: ${otp}`);

    res.json({ 
      success: true, 
      message: "کد تأیید به ایمیل شما ارسال شد",
      expires_in: 600
    });

  } catch (error) {
    console.error("❌ Send deactivation OTP error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// تأیید OTP و غیرفعال‌سازی حساب
app.post('/api/settings/deactivation/verify', async (req, res) => {
  try {
    const { username, otp } = req.body;
    
    if (!username || !otp) {
      return res.status(400).json({ error: "اطلاعات ناقص است" });
    }

    const user = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "کاربر یافت نشد" });
    }
    
    const userId = user.rows[0].id;

    const request = await pool.query(`
      SELECT id, otp_code, otp_expires_at 
      FROM account_deactivation_requests 
      WHERE user_id = $1 AND status = 'pending'
      ORDER BY requested_at DESC LIMIT 1
    `, [userId]);

    if (request.rows.length === 0) {
      return res.status(400).json({ error: "درخواست غیرفعال‌سازی یافت نشد" });
    }

    const reqData = request.rows[0];

    if (new Date(reqData.otp_expires_at) < new Date()) {
      return res.status(400).json({ error: "کد منقضی شده است" });
    }

    if (reqData.otp_code !== otp) {
      return res.status(400).json({ error: "کد نامعتبر است" });
    }

    const now = new Date();
    const permanentDeleteDate = new Date(now);
    permanentDeleteDate.setDate(permanentDeleteDate.getDate() + 30);

    await pool.query(`
      UPDATE account_deactivation_requests 
      SET otp_verified = true, 
          status = 'verified',
          deactivation_date = $1,
          permanent_delete_date = $2
      WHERE id = $3
    `, [now, permanentDeleteDate, reqData.id]);

    await pool.query(
      "UPDATE user_sessions SET is_active = false WHERE user_id = $1",
      [userId]
    );

    res.json({ 
      success: true, 
      message: "حساب کاربری با موفقیت غیرفعال شد",
      deactivation_date: now,
      permanent_delete_date: permanentDeleteDate
    });

  } catch (error) {
    console.error("❌ Verify deactivation OTP error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// لغو درخواست غیرفعال‌سازی
app.post('/api/settings/deactivation/cancel', async (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: "نام کاربری الزامی است" });
    }

    const user = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "کاربر یافت نشد" });
    }
    
    const userId = user.rows[0].id;

    await pool.query(`
      UPDATE account_deactivation_requests 
      SET status = 'cancelled', cancelled_at = NOW()
      WHERE user_id = $1 AND status IN ('pending', 'verified')
    `, [userId]);

    res.json({ 
      success: true, 
      message: "درخواست غیرفعال‌سازی لغو شد" 
    });

  } catch (error) {
    console.error("❌ Cancel deactivation error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// بررسی وضعیت درخواست غیرفعال‌سازی
app.get('/api/settings/deactivation/status/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    const user = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "کاربر یافت نشد" });
    }
    
    const userId = user.rows[0].id;

    const request = await pool.query(`
      SELECT status, deactivation_date, permanent_delete_date
      FROM account_deactivation_requests 
      WHERE user_id = $1 AND status IN ('pending', 'verified')
      ORDER BY requested_at DESC LIMIT 1
    `, [userId]);

    if (request.rows.length === 0) {
      return res.json({ status: 'none' });
    }

    res.json(request.rows[0]);

  } catch (error) {
    console.error("❌ Deactivation status error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======================================================
// 15. CRON JOB FOR AUTO DELETE EXPIRED ACCOUNTS
// ======================================================

cron.schedule('0 3 * * *', async () => {
  console.log('🧹 Running account cleanup cron job...');
  
  try {
    const expiredUsers = await pool.query(`
      SELECT 
        adr.user_id,
        u.username,
        u.email
      FROM account_deactivation_requests adr
      JOIN users u ON adr.user_id = u.id
      WHERE adr.status = 'verified' 
      AND adr.permanent_delete_date <= NOW()
      AND u.last_active < adr.deactivation_date
    `);

    console.log(`📊 Found ${expiredUsers.rows.length} expired accounts to delete`);

    for (const user of expiredUsers.rows) {
      await pool.query("DELETE FROM tweets WHERE user_id = $1", [user.user_id]);
      await pool.query("DELETE FROM stories WHERE user_id = $1", [user.user_id]);
      await pool.query("DELETE FROM likes WHERE user_id = $1", [user.user_id]);
      await pool.query("DELETE FROM bookmarks WHERE user_id = $1", [user.user_id]);
      await pool.query("DELETE FROM follows WHERE follower_id = $1 OR following_id = $1", [user.user_id]);
      await pool.query("DELETE FROM notifications WHERE recipient_id = $1 OR sender_id = $1", [user.user_id]);
      await pool.query("DELETE FROM direct_messages WHERE sender_id = $1", [user.user_id]);
      await pool.query("DELETE FROM conversations WHERE user1_id = $1 OR user2_id = $1", [user.user_id]);
      await pool.query("DELETE FROM user_sessions WHERE user_id = $1", [user.user_id]);
      await pool.query("DELETE FROM user_country WHERE user_id = $1", [user.user_id]);
      await pool.query("DELETE FROM blocks WHERE blocker_id = $1 OR blocked_id = $1", [user.user_id]);
      
      await pool.query("DELETE FROM users WHERE id = $1", [user.user_id]);
      
      console.log(`✅ Deleted user: ${user.username} (${user.user_id})`);
    }

    await pool.query(`
      UPDATE account_deactivation_requests 
      SET status = 'deleted' 
      WHERE status = 'verified' 
      AND permanent_delete_date <= NOW()
    `);

    console.log('🧹 Cleanup completed');

  } catch (error) {
    console.error('❌ Cron job error:', error);
  }
});

// ======================================================
// 16. SOCKET.IO LOGIC - بدون تغییر
// ======================================================

const userSocketMap = new Map();

io.on('connection', (socket) => {
  console.log('🔌 New connection:', socket.id);
  
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

  socket.on('join_room', (matchId) => {
    socket.join(matchId);
  });

  socket.on('leave_room', (matchId) => {
    socket.leave(matchId);
  });

  socket.on('send_message', async (data) => {
    const { matchId, username, content } = data;
    
    if (!content || !matchId || !username) return;
    
    const cleanContent = content.trim();
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

        io.to(matchId).emit('receive_message', message);
      }
    } catch (err) { 
      console.error("Chat Socket Error:", err.message); 
      socket.emit('message_error', { error: 'خطا در ارسال پیام' });
    }
  });

  socket.on('join_conversation', (conversationId) => {
    socket.join(`conv_${conversationId}`);
  });

  socket.on('send_dm', async ({ conversationId, senderUsername, content }) => {
    if (!content || !conversationId || !senderUsername) return;
    
    const cleanContent = content.trim();
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
        
        const messageRes = await pool.query(
          `INSERT INTO direct_messages (conversation_id, sender_id, content) 
           VALUES ($1, $2, $3) 
           RETURNING id, created_at`,
          [conversationId, senderId, cleanContent]
        );

        const convRes = await pool.query(
          "SELECT user1_id, user2_id FROM conversations WHERE id = $1",
          [conversationId]
        );

        if (convRes.rows.length > 0) {
          const { user1_id, user2_id } = convRes.rows[0];
          const recipientId = senderId === user1_id ? user2_id : user1_id;

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

          io.to(`conv_${conversationId}`).emit('receive_dm', message);
          
          const recipientRes = await pool.query(
            "SELECT username FROM users WHERE id = $1", 
            [recipientId]
          );
          
          if (recipientRes.rows.length > 0) {
            const socketsInConv = await io.in(`conv_${conversationId}`).fetchSockets();
            const recipientInConv = socketsInConv.some(s => 
              s.data.userId === recipientId
            );

            if (!recipientInConv) {
              io.to(`user_${recipientId}`).emit('notification_alert', {
                type: 'DM',
                message: `${senderUsername} پیام جدید برای شما ارسال کرد`,
                conversation_id: conversationId,
                sender: senderUsername
              });
            }
          }
        }
      }
    } catch (e) { 
      console.error("DM Error", e); 
      socket.emit('dm_error', { error: 'خطا در ارسال پیام خصوصی' });
    }
  });

  socket.on('story_viewed', ({ storyId, viewerId }) => {
    console.log(`👁️ Story ${storyId} viewed by user ${viewerId}`);
  });

  socket.on('disconnect', () => {
    if (socket.data.userId) {
      userSocketMap.delete(socket.data.userId);
    }
    console.log(`❌ Disconnected: ${socket.id}`);
  });
});

// ======================================================
// 17. GLOBAL ERROR HANDLER
// ======================================================

app.use((err, req, res, next) => {
  console.error('🔥 Global Error:', err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

// ======================================================
// 18. 404 HANDLER
// ======================================================

app.use((req, res) => {
  console.log('🔍 404 Not Found:', req.method, req.url);
  res.status(404).json({ 
    error: 'Route not found',
    requested: req.url,
    method: req.method,
    available_endpoints: {
      root: 'GET /',
      health: 'GET /api/health',
      auth_check: 'POST /api/auth/check-account',
      auth_send_otp: 'POST /api/auth/send-otp',
      auth_verify_otp: 'POST /api/auth/verify-otp',
      auth_sync: 'POST /api/auth/sync',
      upload_image: 'POST /api/upload/image',
      profile: 'GET /api/users/profile/:username',
      user_tweets: 'GET /api/users/:username/tweets',
      user_update: 'PUT /api/users/update',
      user_search: 'GET /api/users/search',
      create_story: 'POST /api/stories',
      stories_following: 'GET /api/stories/following/:username',
      user_stories: 'GET /api/stories/user/:username',
      delete_story: 'DELETE /api/stories/:storyId',
      get_notifications: 'GET /api/notifications/:username',
      unread_count: 'GET /api/notifications/:username/unread-count',
      mark_read: 'POST /api/notifications/:username/mark-read',
      dm_list: 'GET /api/dm/list/:username',
      dm_conversation: 'POST /api/dm/conversation',
      dm_delete: 'DELETE /api/dm/:messageId',
      dm_mark_read: 'POST /api/dm/conversation/:conversationId/mark-read',
      feed: 'GET /api/tweets/feed',
      create_tweet: 'POST /api/tweets',
      like_tweet: 'POST /api/tweets/:id/like',
      delete_tweet: 'DELETE /api/tweets/:id',
      bookmark: 'POST /api/tweets/:id/bookmark',
      bookmarks: 'GET /api/bookmarks/:username',
      hashtag_search: 'GET /api/tweets/hashtag/:hashtag',
      hashtag_more: 'GET /api/tweets/hashtag/:hashtag/more',
      grant_verification: 'POST /api/admin/verification',
      remove_verification: 'POST /api/admin/remove-verification',
      admin_delete_tweet: 'DELETE /api/admin/tweets/:tweetId',
      block_user: 'POST /api/blocks/block',
      unblock_user: 'POST /api/blocks/unblock',
      block_status: 'GET /api/blocks/status',
      get_blocks: 'GET /api/blocks/:username',
      batch_check: 'POST /api/blocks/batch-check',
      live_rooms: 'GET /api/rooms/live',
      room_messages: 'GET /api/rooms/:matchId/messages',
      update_country: 'POST /api/settings/country',
      get_account: 'GET /api/settings/account/:username',
      get_sessions: 'GET /api/settings/sessions/:username',
      register_session: 'POST /api/settings/sessions/register',
      terminate_session: 'POST /api/settings/sessions/terminate',
      terminate_all_sessions: 'POST /api/settings/sessions/terminate-all',
      deactivation_send_otp: 'POST /api/settings/deactivation/send-otp',
      deactivation_verify: 'POST /api/settings/deactivation/verify',
      deactivation_cancel: 'POST /api/settings/deactivation/cancel',
      deactivation_status: 'GET /api/settings/deactivation/status/:username'
    }
  });
});

// ======================================================
// 19. SERVER START
// ======================================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 AJ Sports 2026 Backend v2.5.0');
  console.log('='.repeat(60));
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
  console.log(`✅ Health: http://localhost:${PORT}/api/health`);
  console.log('\n📦 Core Modules:');
  console.log('  • Auth & Users    ✅');
  console.log('  • Stories         ✅');
  console.log('  • Tweets          ✅');
  console.log('  • Hashtag System   ✅');
  console.log('  • Link Card System ✅ (رفع مشکل fetch metadata)');
  console.log('  • Notifications   ✅');
  console.log('  • DMs             ✅');
  console.log('  • Admin           ✅');
  console.log('  • Block System    ✅');
  console.log('  • Settings        ✅');
  console.log('='.repeat(60) + '\n');
});

// ======================================================
// 20. GRACEFUL SHUTDOWN
// ======================================================

process.on('SIGTERM', () => {
  console.log('SIGTERM received: closing server...');
  server.close(() => {
    pool.end(() => {
      console.log('Server closed & DB pool ended');
      process.exit(0);
    });
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received: closing server...');
  server.close(() => {
    pool.end(() => {
      console.log('Server closed & DB pool ended');
      process.exit(0);
    });
  });
});

module.exports = { app, server, pool, io };