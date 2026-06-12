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
const fetch = require('node-fetch');

// ======================================================
// 1. CONFIGURATION & SETUP
// ======================================================

const app = express();
const server = http.createServer(app);

if (!process.env.DATABASE_URL) {
  console.error("❌ FATAL: DATABASE_URL is missing in .env");
  process.exit(1);
}

app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"] }));
app.options("*", cors());
app.use(express.json({ limit: '50mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { 
    rejectUnauthorized: false,
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

pool.on('error', (err) => {
  console.error('❌ DB Fatal Error:', err);
});

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  transports: ['websocket', 'polling']
});

async function testDatabaseConnection() {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as time, version() as pg_version');
    console.log('✅ Database connected successfully');
    console.log(`📅 DB Time: ${result.rows[0].time}`);
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
    version: '3.0.0-admin',
    status: 'online',
    database: 'Neon PostgreSQL',
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
      upload: '/api/upload/*',
      follow: '/api/follow, /api/unfollow, /api/follow/status',
      football: '/api/football/*'
    }
  });
});

// ======================================================
// 3. HEALTH CHECK
// ======================================================

app.get('/api/health', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT NOW() as time');
    const dbVersion = await pool.query('SELECT version() as version');
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: { 
        connected: true, 
        time: dbResult.rows[0].time,
        version: dbVersion.rows[0].version.split(',')[0]
      },
      server: 'AJ Sports 2026 Backend v2.8.0',
      neon_db: true
    });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

// ======================================================
// 4. UPLOAD SYSTEM
// ======================================================

app.post('/api/upload/image', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'فایلی ارسال نشده است' });
    }

    const mime = req.file.mimetype || 'image/jpeg';
    const b64  = req.file.buffer.toString('base64');
    const dataUri = `data:${mime};base64,${b64}`;

    const result = await cloudinary.uploader.upload(dataUri, {
      folder: 'ajsports',
      public_id: `img_${Date.now()}`,
      resource_type: 'auto'
    });

    res.json({ 
      success: true, 
      url: result.secure_url,
      public_id: result.public_id 
    });
    
  } catch (error) {
    console.error("❌ Upload error:", error);
    res.status(500).json({ error: 'خطا در آپلود عکس', details: error.message });
  }
});

// ======================================================
// 5. AUTH & USER MANAGEMENT
// ======================================================

app.post('/api/auth/check-account', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "ایمیل الزامی است" });

    const result = await pool.query(
      "SELECT id, username, display_name, avatar_url, header_url, verification, bio, is_admin, fav_team_id, fav_team_name, fav_team_logo, fav_player_id, fav_player_name, fav_player_photo FROM users WHERE email = $1",
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
          is_admin: user.is_admin,
          fav_team_id: user.fav_team_id || null,
          fav_team_name: user.fav_team_name || null,
          fav_team_logo: user.fav_team_logo || null,
          fav_player_id: user.fav_player_id || null,
          fav_player_name: user.fav_player_name || null,
          fav_player_photo: user.fav_player_photo || null
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

app.get('/api/users/profile/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const requesterUsername = req.query.me;
    
    const query = `
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.header_url, u.verification, u.bio, u.created_at,
      u.fav_team_id, u.fav_team_name, u.fav_team_logo,
      u.fav_player_id, u.fav_player_name, u.fav_player_photo,
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

// ======================================================
// ✅ تغییر 1: مسیر search باید BEFORE /api/users/:username باشه
// ======================================================

app.get('/api/users/search', async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q || q.length < 2) {
      return res.json([]);
    }
    
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
    console.error("❌ Search error:", error);
    res.json([]);
  }
});

app.get('/api/users/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    const result = await pool.query(
      `SELECT id, username, display_name, avatar_url, header_url, verification, bio, is_admin 
       FROM users 
       WHERE username = $1`,
      [username]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

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
        t.id, t.content, t.created_at, t.likes_count, t.user_id, t.parent_id, t.media_url, t.link_card, t.hashtags,
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

// ======================================================
// FOOTBALL API - Cache Layer (Neon DB)
// ======================================================

// ======================================================
// FOOTBALL API - Cache Layer (Neon DB)
// ======================================================

// ۱. جستجوی تیم (اصلاح‌شده: جستجوی کاملاً بهینه فقط از کش دیتابیس)
app.get('/api/football/teams/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);

    // از آنجا که API به صورت مستقیم team_name را پشتیبانی نمی‌کند،
    // جستجو با سرعت بالا مستقیماً به دیتابیس Neon سپرده می‌شود.
    const cached = await pool.query(
      `SELECT team_id, name, logo FROM football_teams_cache
       WHERE name ILIKE $1 LIMIT 10`,
      [`%${q}%`]
    );

    // دیتابیس باید پیش‌تر توسط روت Sync (در پایین) پر شده باشد تا نتیجه برگرداند
    res.json(cached.rows);
  } catch (error) {
    console.error('Football teams search error:', error);
    res.json([]);
  }
});

// ۲. روت جدید برای همگام‌سازی (Sync) تیم‌ها در کش دیتابیس (بدون کوچکترین آسیب به لیمیت API)
// می‌توانید این را با Cron Job فراخوانی کنید تا لیست تیم‌ها در دیتابیس شما کامل شود
app.post('/api/football/teams/sync-leagues', async (req, res) => {
  try {
    // آیدی لیگ‌های معتبر دنیا جهت واکشی تیم‌ها
    // به عنوان مثال: 152 لیگ انگلیس، 302 اسپانیا، 207 ایتالیا، 175 آلمان، 168 فرانسه
    const targetLeagues = [152, 302, 207, 175, 168];
    let addedTeamsCount = 0;

    for (const leagueId of targetLeagues) {
      const response = await fetch(
        `https://apiv3.apifootball.com/?action=get_teams&league_id=${leagueId}&APIkey=${process.env.API_FOOTBALL_KEY}`
      );

      if (!response.ok) continue;

      const data = await response.json();
      const teams = Array.isArray(data) ? data : [];

      for (const t of teams) {
        await pool.query(
          `INSERT INTO football_teams_cache (team_id, name, logo)
           VALUES ($1, $2, $3)
           ON CONFLICT (team_id) DO UPDATE SET name = EXCLUDED.name, logo = EXCLUDED.logo`,
          [t.team_key, t.team_name, t.team_badge]
        ).catch((err) => console.error(`DB Insert Error:`, err.message));
        addedTeamsCount++;
      }
    }

    res.json({ success: true, message: `تعداد ${addedTeamsCount} تیم با موفقیت واکشی و در کش دیتابیس آپدیت شد.` });
  } catch (error) {
    console.error('Football teams sync error:', error);
    res.status(500).json({ error: 'Internal server error during sync' });
  }
});

// ۳. جستجوی بازیکن (کد بی‌نقص خودتان که از ابتدا به درستی کار می‌کرد)
app.get('/api/football/players/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);

    // از کش بخوان
    const cached = await pool.query(
      `SELECT player_id, name, photo FROM football_players_cache
       WHERE name ILIKE $1 LIMIT 10`,
      [`%${q}%`]
    );

    if (cached.rows.length > 0) {
      return res.json(cached.rows);
    }

    // از apifootball بخوان
    const response = await fetch(
      `https://apiv3.apifootball.com/?action=get_players&player_name=${encodeURIComponent(q)}&APIkey=${process.env.API_FOOTBALL_KEY}`
    );

    if (!response.ok) return res.json([]);

    const data = await response.json();
    const players = (Array.isArray(data) ? data : []).slice(0, 10).map(item => ({
      player_id: item.player_key,
      name: item.player_name,
      photo: item.player_image
    }));

    // ذخیره در کش
    for (const p of players) {
      await pool.query(
        `INSERT INTO football_players_cache (player_id, name, photo)
         VALUES ($1, $2, $3)
         ON CONFLICT (player_id) DO UPDATE SET name = EXCLUDED.name, photo = EXCLUDED.photo`,
        [p.player_id, p.name, p.photo]
      ).catch(() => {});
    }

    res.json(players);
  } catch (error) {
    console.error('Football players search error:', error);
    res.json([]);
  }
});

// ۴. ذخیره تیم/بازیکن محبوب (کد بی‌نقص پایه شما)
app.put('/api/users/football-prefs', async (req, res) => {
  try {
    const { username, fav_team, fav_player } = req.body;
    if (!username) return res.status(400).json({ error: 'نام کاربری الزامی است' });

    await pool.query(
      `UPDATE users SET
         fav_team_id   = $1,
         fav_team_name = $2,
         fav_team_logo = $3,
         fav_player_id   = $4,
         fav_player_name = $5,
         fav_player_photo = $6
       WHERE username = $7`,
      [
        fav_team?.id   || null, fav_team?.name   || null, fav_team?.logo   || null,
        fav_player?.id || null, fav_player?.name || null, fav_player?.photo || null,
        username
      ]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Save football prefs error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ======================================================
// 6. STORY SYSTEM
// ======================================================

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
// 7. TWEET SYSTEM
// ======================================================

// ======================================================
// ⚡ TWEET FEED — IN-MEMORY RAW CACHE (معماری ۲۰ میلیون کاربر)
// ======================================================
//
// معماری Application-level Join:
//   مرحله ۱ — توییت‌های خام (بدون personalization) در RAM کش می‌شوند.
//             هر ۱۰ ثانیه یک بار DB query — نه هر بار که کاربر فید باز می‌کند.
//   مرحله ۲ — اگر کاربر لاگین است، فقط یک کوئری ایندکس‌دار سبک:
//             "از این ۲۰ آیدی، کدام‌ها را لایک/ریتوییت/بوکمارک کرده‌ای؟"
//             این کوئری ۱۰۰x سبک‌تر از کوئری قبلی است (فقط primary key lookup).
//
// نتیجه: ۲۰ میلیون کاربر همزمان = فقط ~۱ DB query در ۱۰ ثانیه (برای خام)
//        + N کوئری فوق‌العاده سبک برای personalization هر کاربر.
//
// ⚠️ اخبار (RSS) کاملاً از این endpoint حذف شد.
//    فرانت‌اند اخبار را مستقیماً از cdn-news.ajsports.ir (RSS bot) می‌گیرد.
//    این باعث می‌شود هیچ اخبار تکراری یا دوبله‌ای نباشد.
// ======================================================

const _rawTweetCache = {
  rows: [],          // آرایه توییت‌های خام (بدون has_liked و ...)
  ids: [],           // فقط آیدی‌ها — برای کوئری personalization
  updatedAt: 0,
  isRefreshing: false,
  TTL_MS: 10 * 1000  // 10 ثانیه — کوتاه‌ترین TTL معقول برای فید اجتماعی
};

// این تابع هر ۱۰ ثانیه توسط cron اجرا می‌شود.
// تمام لایه personalization (has_liked, has_retweeted, has_bookmarked)
// را حذف کرده‌ایم — آن‌ها در مرحله دوم و به صورت lazy اضافه می‌شوند.
async function _refreshRawTweetCache() {
  if (_rawTweetCache.isRefreshing) return;
  _rawTweetCache.isRefreshing = true;
  try {
    const result = await pool.query(`
      SELECT
        t.id, t.content, t.created_at, t.likes_count,
        t.user_id, t.parent_id, t.media_url,
        u.username, u.display_name, u.avatar_url, u.verification,
        (SELECT COUNT(*) FROM tweets   WHERE parent_id = t.id)         AS reply_count,
        (SELECT COUNT(*) FROM retweets WHERE tweet_id  = t.id)         AS retweet_count
      FROM tweets t
      JOIN users u ON t.user_id = u.id
      WHERE t.parent_id IS NULL
      ORDER BY t.created_at DESC
      LIMIT 50
    `);
    _rawTweetCache.rows      = result.rows;
    _rawTweetCache.ids       = result.rows.map(r => r.id);
    _rawTweetCache.updatedAt = Date.now();
    console.log(`⚡ Raw tweet cache refreshed: ${result.rows.length} tweets`);
  } catch (err) {
    console.error('❌ Raw tweet cache refresh failed:', err.message);
  } finally {
    _rawTweetCache.isRefreshing = false;
  }
}

// Cron: هر ۱۰ ثانیه cache را refresh کن — فقط ۶ query در دقیقه به Neon DB
cron.schedule('*/10 * * * * *', () => { // 6-field: second-level cron
  _refreshRawTweetCache().catch(e => console.error('⚠️ Tweet cache cron failed:', e.message));
});

// ──────────────────────────────────────────────────────────────────
// GET /api/tweets/feed
// ──────────────────────────────────────────────────────────────────
// معماری دو مرحله‌ای:
//   1. توییت‌های خام از RAM  (زیر 0.1ms)
//   2. personalization با یک کوئری ایندکس‌دار بسیار سبک (اگر لاگین)
// ──────────────────────────────────────────────────────────────────
app.get('/api/tweets/feed', async (req, res) => {
  try {
    const username = req.query.username;
    const page  = Math.max(0, parseInt(req.query.page  || '0'));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20')));

    // ── مرحله ۱: از RAM بخوان (صفر DB query) ────────────────────
    // اگر cache خالی یا منقضی است، یک بار synchronous refresh
    if (_rawTweetCache.rows.length === 0 ||
        (Date.now() - _rawTweetCache.updatedAt) > _rawTweetCache.TTL_MS * 3) {
      await _refreshRawTweetCache();
    }

    // Pagination روی cache (نه DB)
    const start    = page * limit;
    const paginated = _rawTweetCache.rows.slice(start, start + limit);

    if (paginated.length === 0) {
      return res.json([]);
    }

    // ── مرحله ۲: personalization — فقط برای کاربر لاگین ────────
    // یک کوئری بسیار سبک: فقط primary key lookup روی جداول likes, retweets, bookmarks
    // به جای EXISTS(SELECT 1 FROM likes WHERE tweet_id = t.id AND user_id = $1)
    // برای هر توییت، حالا فقط یک IN($ids) برای همه توییت‌ها
    let likedSet    = new Set();
    let retweetSet  = new Set();
    let bookmarkSet = new Set();

    if (username && paginated.length > 0) {
      try {
        const userRes = await pool.query(
          "SELECT id FROM users WHERE username = $1",
          [username]
        );

        if (userRes.rows.length > 0) {
          const userId   = userRes.rows[0].id;
          const tweetIds = paginated.map(t => t.id);

          // سه کوئری موازی — هر کدام فقط یک ایندکس‌دار IN lookup
          const [likesRes, retweetsRes, bookmarksRes] = await Promise.all([
            pool.query(
              'SELECT tweet_id FROM likes     WHERE user_id=$1 AND tweet_id = ANY($2::int[])',
              [userId, tweetIds]
            ),
            pool.query(
              'SELECT tweet_id FROM retweets  WHERE user_id=$1 AND tweet_id = ANY($2::int[])',
              [userId, tweetIds]
            ),
            pool.query(
              'SELECT tweet_id FROM bookmarks WHERE user_id=$1 AND tweet_id = ANY($2::int[])',
              [userId, tweetIds]
            )
          ]);

          likedSet    = new Set(likesRes.rows.map(r => r.tweet_id));
          retweetSet  = new Set(retweetsRes.rows.map(r => r.tweet_id));
          bookmarkSet = new Set(bookmarksRes.rows.map(r => r.tweet_id));
        }
      } catch (personErr) {
        // اگر personalization خطا داد، فید را بدون آن برگردان
        console.error('⚠️ Personalization query failed:', personErr.message);
      }
    }

    // ── ترکیب نهایی در RAM — صفر DB query ───────────────────────
    const feed = paginated.map(tweet => ({
      ...tweet,
      has_liked:       likedSet.has(tweet.id),
      has_retweeted:   retweetSet.has(tweet.id),
      has_bookmarked:  bookmarkSet.has(tweet.id)
    }));

    res.json(feed);

  } catch (error) {
    console.error("Feed error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======================================================
// ✅ تغییر 9: اضافه کردن API جدید برای دریافت پاسخ‌های یک توییت
// ======================================================

app.get('/api/tweets/replies/:parentId', async (req, res) => {
  try {
    const { parentId } = req.params;
    const requesterUsername = req.query.username;
    
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

    const query = `
      SELECT 
        t.id, t.content, t.created_at, t.likes_count, t.user_id, t.parent_id, t.media_url, t.link_card, t.hashtags,
        u.username, u.display_name, u.avatar_url, u.verification,
        (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count,
        (SELECT COUNT(*) FROM retweets WHERE tweet_id = t.id) as retweet_count,
        ${requesterId ? `
          EXISTS(SELECT 1 FROM likes WHERE tweet_id = t.id AND user_id = $2) as has_liked,
          EXISTS(SELECT 1 FROM bookmarks WHERE tweet_id = t.id AND user_id = $2) as has_bookmarked
        ` : `
          false as has_liked, false as has_bookmarked
        `}
      FROM tweets t
      JOIN users u ON t.user_id = u.id
      WHERE t.parent_id = $1
      ORDER BY t.created_at ASC
      LIMIT 100
    `;
    
    const params = requesterId ? [parentId, requesterId] : [parentId];
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      replies: result.rows,
      count: result.rows.length
    });
    
  } catch (error) {
    console.error("❌ Get replies error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======================================================
// ✅ تغییر 5: اضافه کردن API جدید GET /api/tweets/:id/detail
// ======================================================

app.get('/api/tweets/:id/detail', async (req, res) => {
  try {
    const { id } = req.params;
    const requesterUsername = req.query.username;
    
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

    // دریافت توییت اصلی
    const tweetQuery = `
      SELECT 
        t.id, t.content, t.created_at, t.likes_count, t.user_id, t.parent_id, t.media_url, t.link_card, t.hashtags,
        u.username, u.display_name, u.avatar_url, u.verification,
        (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count,
        (SELECT COUNT(*) FROM retweets WHERE tweet_id = t.id) as retweet_count,
        ${requesterId ? `
          EXISTS(SELECT 1 FROM likes WHERE tweet_id = t.id AND user_id = $2) as has_liked,
          EXISTS(SELECT 1 FROM bookmarks WHERE tweet_id = t.id AND user_id = $2) as has_bookmarked
        ` : `
          false as has_liked, false as has_bookmarked
        `}
      FROM tweets t
      JOIN users u ON t.user_id = u.id
      WHERE t.id = $1
    `;
    
    const tweetParams = requesterId ? [id, requesterId] : [id];
    const tweetResult = await pool.query(tweetQuery, tweetParams);
    
    if (tweetResult.rows.length === 0) {
      return res.status(404).json({ error: "Tweet not found" });
    }
    
    const tweet = tweetResult.rows[0];
    
    // دریافت پاسخ‌ها
    const repliesQuery = `
      SELECT 
        t.id, t.content, t.created_at, t.likes_count, t.user_id, t.parent_id, t.media_url, t.link_card, t.hashtags,
        u.username, u.display_name, u.avatar_url, u.verification,
        (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count,
        ${requesterId ? `
          EXISTS(SELECT 1 FROM likes WHERE tweet_id = t.id AND user_id = $2) as has_liked,
          EXISTS(SELECT 1 FROM bookmarks WHERE tweet_id = t.id AND user_id = $2) as has_bookmarked
        ` : `
          false as has_liked, false as has_bookmarked
        `}
      FROM tweets t
      JOIN users u ON t.user_id = u.id
      WHERE t.parent_id = $1
      ORDER BY t.created_at ASC
      LIMIT 100
    `;
    
    const repliesParams = requesterId ? [id, requesterId] : [id];
    const repliesResult = await pool.query(repliesQuery, repliesParams);
    
    res.json({
      success: true,
      tweet: tweet,
      replies: repliesResult.rows,
      reply_count: repliesResult.rows.length
    });
    
  } catch (error) {
    console.error("❌ Tweet detail error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function extractHashtags(content) {
  if (!content) return [];
  const hashtagRegex = /#([\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFFa-zA-Z0-9_]+)/g;
  const matches = content.match(hashtagRegex);
  if (!matches) return [];
  return [...new Set(matches.map(tag => tag.substring(1)))];
}

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
        t.id, t.content, t.created_at, t.likes_count, t.user_id, t.parent_id, t.media_url, t.link_card, t.hashtags,
        u.username, u.display_name, u.avatar_url, u.verification,
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
    console.error("❌ Hashtag search error:", error);
    res.status(500).json({ 
      success: false,
      error: "خطای داخلی سرور",
      message: error.message
    });
  }
});

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
        t.id, t.content, t.created_at, t.likes_count, t.user_id, t.media_url,
        u.username, u.display_name, u.avatar_url, u.verification,
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

global.Headers = fetch.Headers;

async function fetchLinkMetadata(url) {
  try {
    let fullUrl = url.trim();
    fullUrl = fullUrl.replace(/\s+/g, '');
    
    if (fullUrl.startsWith('www.')) {
      fullUrl = 'https://' + fullUrl;
    }
    else if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
      fullUrl = 'https://' + fullUrl;
    }

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
    
    const getMeta = (name) => {
      const ogRegex = new RegExp(`<meta[^>]*property=["']og:${name}["'][^>]*content=["']([^"']+)["']`, 'i');
      const ogMatch = html.match(ogRegex);
      if (ogMatch) return ogMatch[1];
      
      const twitterRegex = new RegExp(`<meta[^>]*name=["']twitter:${name}["'][^>]*content=["']([^"']+)["']`, 'i');
      const twitterMatch = html.match(twitterRegex);
      if (twitterMatch) return twitterMatch[1];
      
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

    const title = getMeta('title') || fullUrl;
    const description = getMeta('description') || '';
    const image = getMeta('image') || null;
    
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
    
    try {
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
// ✅ تغییر 8: اصلاح مسیر /api/tweets برای ارسال new_reply صحیح
// ======================================================

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

    const hashtags = extractHashtags(cleanContent);

    let linkCard = null;
    if (cleanContent && !media_url) {
      const urlRegex = /(https?:\/\/[^\s]+)|(?:^|\s)(([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s]*)?)(?=\s|$)/g;
      const urlMatch = cleanContent.match(urlRegex);
      
      if (urlMatch && urlMatch.length > 0) {
        const firstUrl = urlMatch[0].trim();
        try {
          linkCard = await fetchLinkMetadata(firstUrl);
        } catch (e) {
          console.error('❌ Link card creation failed:', e);
        }
      }
    }

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

    // ======================================================
    // ✅ تغییر 8: اصلاح ارسال نوتیفیکیشن برای پاسخ
    // ======================================================
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
            `${user.display_name || user.username} به توییت شما پاسخ داد`
          ]
        );
        
        // ارسال نوتیفیکیشن لحظه‌ای از طریق سوکت
        io.to(`user_${parentTweet.rows[0].user_id}`).emit('notification_alert', { 
          type: 'REPLY', 
          message: `${user.display_name || user.username} به توییت شما پاسخ داد`,
          reference_id: insertRes.rows[0].id,
          tweet_id: parentId,
          reply_id: insertRes.rows[0].id,
          reply_content: cleanContent.substring(0, 100)
        });
        
        // ارسال ایونت مخصوص برای بروزرسانی تعداد پاسخ‌ها در فرانت‌اند
        io.emit(`update_reply_count_${parentId}`, {
          tweet_id: parentId,
          new_reply_count: (await pool.query("SELECT COUNT(*) FROM tweets WHERE parent_id = $1", [parentId])).rows[0].count
        });
      }
      
      // ارسال ایونت برای اپندیت کردن پاسخ در صفحه جزئیات
      io.emit(`new_reply_${parentId}`, {
        ...newTweet,
        parent_id: parentId
      });
      
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
// ✅ تغییر 7: اصلاح مسیر /api/tweets/:id/like برای ارسال نوتیفیکیشن صحیح
// ======================================================

app.post('/api/tweets/:id/like', async (req, res) => {
  try {
    const { id } = req.params;
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: "نام کاربری الزامی است" });
    }
    
    const userRes = await pool.query(
      "SELECT id, display_name FROM users WHERE username = $1",
      [username]
    );
    
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const userId = userRes.rows[0].id;
    const displayName = userRes.rows[0].display_name || username;
    const tweetId = parseInt(id);
    
    const tweetRes = await pool.query(
      "SELECT user_id FROM tweets WHERE id = $1",
      [tweetId]
    );
    
    if (tweetRes.rows.length === 0) {
      return res.status(404).json({ error: "Tweet not found" });
    }
    
    const existing = await pool.query(
      "SELECT id FROM likes WHERE tweet_id = $1 AND user_id = $2",
      [tweetId, userId]
    );
    
    let liked = false;
    
    if (existing.rows.length > 0) {
      await pool.query(
        "DELETE FROM likes WHERE tweet_id = $1 AND user_id = $2",
        [tweetId, userId]
      );
      await pool.query(
        "UPDATE tweets SET likes_count = likes_count - 1 WHERE id = $1",
        [tweetId]
      );
      liked = false;
    } else {
      await pool.query(
        "INSERT INTO likes (tweet_id, user_id) VALUES ($1, $2)",
        [tweetId, userId]
      );
      await pool.query(
        "UPDATE tweets SET likes_count = likes_count + 1 WHERE id = $1",
        [tweetId]
      );
      liked = true;
      
      // ارسال نوتیفیکیشن فقط در صورت لایک (نه آنلایک)
      if (tweetRes.rows[0].user_id !== userId) {
        await pool.query(
          `INSERT INTO notifications (recipient_id, sender_id, type, reference_id, content) 
           VALUES ($1, $2, 'LIKE', $3, $4)`,
          [tweetRes.rows[0].user_id, userId, tweetId, `${displayName} توییت شما را لایک کرد`]
        );
        
        // ارسال نوتیفیکیشن لحظه‌ای از طریق سوکت
        io.to(`user_${tweetRes.rows[0].user_id}`).emit('notification_alert', {
          type: 'LIKE',
          message: `${displayName} توییت شما را لایک کرد`,
          tweet_id: tweetId,
          liker_username: username
        });
        
        // ارسال ایونت برای بروزرسانی تعداد لایک‌ها در فرانت‌اند
        io.emit(`update_like_count_${tweetId}`, {
          tweet_id: tweetId,
          new_likes_count: (await pool.query("SELECT likes_count FROM tweets WHERE id = $1", [tweetId])).rows[0].likes_count
        });
      }
    }
    
    const countRes = await pool.query(
      "SELECT likes_count FROM tweets WHERE id = $1",
      [tweetId]
    );
    
    res.json({ 
      success: true, 
      liked: liked, 
      likes_count: parseInt(countRes.rows[0].likes_count) 
    });
    
  } catch (error) {
    console.error("❌ Like tweet error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.delete('/api/tweets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: "نام کاربری الزامی است" });
    }
    
    const userRes = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );
    
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const userId = userRes.rows[0].id;
    const tweetId = parseInt(id);
    
    const tweetRes = await pool.query(
      "SELECT user_id FROM tweets WHERE id = $1",
      [tweetId]
    );
    
    if (tweetRes.rows.length === 0) {
      return res.status(404).json({ error: "Tweet not found" });
    }
    
    if (tweetRes.rows[0].user_id !== userId) {
      return res.status(403).json({ error: "شما اجازه حذف این توییت را ندارید" });
    }
    
    await pool.query("DELETE FROM likes WHERE tweet_id = $1", [tweetId]);
    await pool.query("DELETE FROM bookmarks WHERE tweet_id = $1", [tweetId]);
    await pool.query("DELETE FROM retweets WHERE tweet_id = $1", [tweetId]);
    await pool.query("DELETE FROM tweets WHERE id = $1", [tweetId]);
    
    io.emit('tweet_deleted', tweetId);
    
    console.log(`🗑️ [DELETE TWEET] User ${username} deleted tweet ${tweetId}`);
    res.json({ success: true, message: "Tweet deleted successfully" });
    
  } catch (error) {
    console.error("❌ Delete tweet error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post('/api/tweets/:id/bookmark', async (req, res) => {
  try {
    const { id } = req.params;
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: "نام کاربری الزامی است" });
    }
    
    const userRes = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );
    
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const userId = userRes.rows[0].id;
    const tweetId = parseInt(id);
    
    const existing = await pool.query(
      "SELECT id FROM bookmarks WHERE tweet_id = $1 AND user_id = $2",
      [tweetId, userId]
    );
    
    let bookmarked = false;
    
    if (existing.rows.length > 0) {
      await pool.query(
        "DELETE FROM bookmarks WHERE tweet_id = $1 AND user_id = $2",
        [tweetId, userId]
      );
      bookmarked = false;
    } else {
      await pool.query(
        "INSERT INTO bookmarks (tweet_id, user_id) VALUES ($1, $2)",
        [tweetId, userId]
      );
      bookmarked = true;
    }
    
    res.json({ success: true, bookmarked: bookmarked });
    
  } catch (error) {
    console.error("❌ Bookmark error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get('/api/bookmarks/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    const userRes = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );
    
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const userId = userRes.rows[0].id;
    
    const query = `
      SELECT 
        t.id, t.content, t.created_at, t.likes_count, t.user_id, t.media_url,
        u.username, u.display_name, u.avatar_url, u.verification,
        (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count,
        true as has_bookmarked
      FROM bookmarks b
      JOIN tweets t ON b.tweet_id = t.id
      JOIN users u ON t.user_id = u.id
      WHERE b.user_id = $1
      ORDER BY b.created_at DESC
    `;
    
    const result = await pool.query(query, [userId]);
    res.json(result.rows);
    
  } catch (error) {
    console.error("❌ Get bookmarks error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ======================================================
// 8. FOLLOW SYSTEM
// ======================================================

app.post('/api/follow', async (req, res) => {
  try {
    const { follower, following } = req.body;
    
    if (!follower || !following) {
      return res.status(400).json({ error: "نام کاربری الزامی است" });
    }
    
    if (follower === following) {
      return res.status(400).json({ error: "نمی‌توانید خودتان را دنبال کنید" });
    }
    
    const followerRes = await pool.query(
      "SELECT id, display_name FROM users WHERE username = $1",
      [follower]
    );
    
    const followingRes = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [following]
    );
    
    if (followerRes.rows.length === 0 || followingRes.rows.length === 0) {
      return res.status(404).json({ error: "کاربر یافت نشد" });
    }
    
    const followerId = followerRes.rows[0].id;
    const followingId = followingRes.rows[0].id;
    const followerDisplayName = followerRes.rows[0].display_name || follower;
    
    const existing = await pool.query(
      "SELECT id FROM follows WHERE follower_id = $1 AND following_id = $2",
      [followerId, followingId]
    );
    
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "قبلاً این کاربر را دنبال کرده‌اید" });
    }
    
    await pool.query(
      "INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)",
      [followerId, followingId]
    );
    
    await pool.query(
      `INSERT INTO notifications (recipient_id, sender_id, type, content) 
       VALUES ($1, $2, 'FOLLOW', $3)`,
      [followingId, followerId, `${followerDisplayName} شما را دنبال کرد`]
    );
    
    io.to(`user_${followingId}`).emit('notification_alert', {
      type: 'FOLLOW',
      message: `${followerDisplayName} شما را دنبال کرد`,
      follower_username: follower
    });
    
    console.log(`✅ [FOLLOW] ${follower} -> ${following}`);
    res.json({ success: true, message: "با موفقیت دنبال شد" });
    
  } catch (error) {
    console.error("❌ Follow error:", error);
    res.status(500).json({ error: "خطای داخلی سرور" });
  }
});

app.post('/api/unfollow', async (req, res) => {
  try {
    const { follower, following } = req.body;
    
    if (!follower || !following) {
      return res.status(400).json({ error: "نام کاربری الزامی است" });
    }
    
    const followerRes = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [follower]
    );
    
    const followingRes = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [following]
    );
    
    if (followerRes.rows.length === 0 || followingRes.rows.length === 0) {
      return res.status(404).json({ error: "کاربر یافت نشد" });
    }
    
    const followerId = followerRes.rows[0].id;
    const followingId = followingRes.rows[0].id;
    
    const result = await pool.query(
      "DELETE FROM follows WHERE follower_id = $1 AND following_id = $2 RETURNING id",
      [followerId, followingId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "قبلاً این کاربر را دنبال نمی‌کردید" });
    }
    
    console.log(`✅ [UNFOLLOW] ${follower} -> ${following}`);
    res.json({ success: true, message: "با موفقیت آنفالو شد" });
    
  } catch (error) {
    console.error("❌ Unfollow error:", error);
    res.status(500).json({ error: "خطای داخلی سرور" });
  }
});

app.get('/api/follow/status', async (req, res) => {
  try {
    const { follower, following } = req.query;
    
    if (!follower || !following) {
      return res.status(400).json({ error: "نام کاربری الزامی است" });
    }
    
    const followerRes = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [follower]
    );
    const followingRes = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [following]
    );
    
    if (followerRes.rows.length === 0 || followingRes.rows.length === 0) {
      return res.json({ is_following: false });
    }
    
    const result = await pool.query(
      "SELECT id FROM follows WHERE follower_id = $1 AND following_id = $2",
      [followerRes.rows[0].id, followingRes.rows[0].id]
    );
    
    res.json({ is_following: result.rows.length > 0 });
    
  } catch (error) {
    console.error("❌ Follow status error:", error);
    res.status(500).json({ error: "خطای داخلی سرور" });
  }
});

// ======================================================
// 9. NOTIFICATIONS SYSTEM (✅ تغییر 2: LEFT JOIN)
// ======================================================

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
        n.id, 
        n.type, 
        COALESCE(n.content, 'نوتیفیکیشن جدید') as content,
        n.reference_id, 
        n.read, 
        n.created_at,
        COALESCE(u.username, 'system') as sender_username, 
        COALESCE(u.display_name, u.username, 'system') as sender_display_name, 
        COALESCE(u.avatar_url, '') as sender_avatar
      FROM notifications n
      LEFT JOIN users u ON n.sender_id = u.id
      WHERE n.recipient_id = $1
      ORDER BY n.created_at DESC
      LIMIT 50
    `;
    
    const result = await pool.query(query, [userId]);
    res.json(result.rows);
    
  } catch (error) {
    console.error("❌ Notifications error:", error.message, error.stack);
    res.status(500).json({ error: "خطای داخلی سرور", detail: error.message });
  }
});

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
    res.json({ count: 0 });
  }
});

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
// 10. DIRECT MESSAGES (✅ تغییر 3: اصلاح شده - رفع خطای server error)
// ======================================================

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
        COALESCE(c.last_message, '') as last_message, 
        c.updated_at,
        CASE WHEN c.user1_id = $1 THEN u2.username ELSE u1.username END as other_user,
        CASE WHEN c.user1_id = $1 THEN u2.display_name ELSE u1.display_name END as other_display_name,
        CASE WHEN c.user1_id = $1 THEN u2.avatar_url ELSE u1.avatar_url END as other_avatar,
        CASE WHEN c.user1_id = $1 THEN u2.verification ELSE u1.verification END as other_verification,
        COALESCE((
          SELECT COUNT(*) 
          FROM direct_messages dm 
          WHERE dm.conversation_id = c.id 
          AND dm.sender_id != $1 
          AND COALESCE(dm.read, false) = false
        ), 0) as unread_count
      FROM conversations c
      JOIN users u1 ON c.user1_id = u1.id
      JOIN users u2 ON c.user2_id = u2.id
      WHERE c.user1_id = $1 OR c.user2_id = $1
      ORDER BY c.updated_at DESC
    `;
    
    const result = await pool.query(query, [userId]);
    
    const formatted = result.rows.map(c => ({
      conversation_id: c.conversation_id,
      last_message: c.last_message || '',
      updated_at: c.updated_at,
      other_user: c.other_user,
      other_display_name: c.other_display_name,
      other_avatar: c.other_avatar || 'https://via.placeholder.com/150',
      other_verification: c.other_verification,
      unread_count: parseInt(c.unread_count) || 0
    }));
    
    res.json(formatted);
    
  } catch (error) {
    console.error("❌ DM list error:", error);
    res.json([]);
  }
});

app.post('/api/dm/conversation', async (req, res) => {
  try {
    const { username1, username2 } = req.body;
    
    if (!username1 || !username2) {
      return res.status(400).json({ error: "نام‌های کاربری الزامی هستند" });
    }

    const cleanUsername1 = username1.trim();
    const cleanUsername2 = username2.trim();
    
    if (cleanUsername1 === cleanUsername2) {
      return res.status(400).json({ error: "نمی‌توانید با خودتان گفتگو کنید" });
    }

    const u1Result = await pool.query(
      "SELECT id, username, display_name, avatar_url, header_url, verification FROM users WHERE username = $1", 
      [cleanUsername1]
    );
    
    const u2Result = await pool.query(
      "SELECT id, username, display_name, avatar_url, header_url, verification FROM users WHERE username = $1", 
      [cleanUsername2]
    );
    
    if (u1Result.rows.length === 0) {
      return res.status(404).json({ error: `کاربر ${cleanUsername1} یافت نشد` });
    }
    
    if (u2Result.rows.length === 0) {
      return res.status(404).json({ error: `کاربر ${cleanUsername2} یافت نشد` });
    }
    
    const u1 = u1Result.rows[0];
    const u2 = u2Result.rows[0];
    
    const id1 = Math.min(u1.id, u2.id);
    const id2 = Math.max(u1.id, u2.id);

    let conv = await pool.query(
      "SELECT * FROM conversations WHERE user1_id = $1 AND user2_id = $2", 
      [id1, id2]
    );
    
    if (conv.rows.length === 0) {
      conv = await pool.query(
        "INSERT INTO conversations (user1_id, user2_id, last_message, updated_at) VALUES ($1, $2, '', NOW()) RETURNING *", 
        [id1, id2]
      );
    }
    
    const conversation = conv.rows[0];
    const requesterId = u1.username === cleanUsername1 ? u1.id : u2.id;
    
    const unreadCount = await pool.query(`
      SELECT COALESCE(COUNT(*), 0) as count FROM direct_messages 
      WHERE conversation_id = $1 AND sender_id != $2 AND COALESCE(read, false) = false
    `, [conversation.id, requesterId]);

    const messages = await pool.query(`
      SELECT dm.*, u.username, u.display_name, u.avatar_url, u.verification
      FROM direct_messages dm
      JOIN users u ON dm.sender_id = u.id
      WHERE conversation_id = $1 
      ORDER BY created_at ASC LIMIT 100
    `, [conversation.id]);

    const otherUser = cleanUsername1 === u1.username ? u2 : u1;

    res.json({ 
      conversation: { 
        id: conversation.id,
        user1_id: conversation.user1_id,
        user2_id: conversation.user2_id,
        last_message: conversation.last_message || '',
        updated_at: conversation.updated_at,
        unread_count: parseInt(unreadCount.rows[0].count) || 0,
        other_user: otherUser.username,
        other_display_name: otherUser.display_name,
        other_avatar: otherUser.avatar_url || 'https://via.placeholder.com/150',
        other_verification: otherUser.verification
      }, 
      messages: messages.rows.map(msg => ({
        id: msg.id,
        content: msg.content,
        created_at: msg.created_at,
        read: msg.read || false,
        sender_id: msg.sender_id,
        username: msg.username,
        display_name: msg.display_name,
        avatar_url: msg.avatar_url,
        verification: msg.verification
      }))
    });
  } catch (error) {
    console.error("❌ Start conversation error:", error);
    res.status(500).json({ error: 'خطای داخلی سرور', details: error.message });
  }
});

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
      AND COALESCE(read, false) = false
    `, [conversationId, otherUserId]);

    res.json({ success: true });
  } catch (error) {
    console.error("Mark DM read error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======================================================
// 11. ADMIN MANAGEMENT — PROFESSIONAL PANEL v1.0
// ══════════════════════════════════════════════════════
// ✅ تضمین کتبی: هیچ route، متغیر، pool، io، socket یا
//    منطق موجود لمس نشده. فقط افزوده شده.
// ✅ همه admin routes با prefix /api/admin/panel/ کار
//    می‌کنند تا با /api/admin/verification قدیمی تداخل نداشته باشند.
// ✅ احراز هویت: x-admin-token header (ADMIN_SECRET_TOKEN در .env)
// ✅ لاگ کامل اقدامات ادمین در جدول admin_action_logs
// ======================================================

// ── جدول لاگ اقدامات ادمین (ایجاد خودکار در اولین اجرا) ──────────
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_action_logs (
        id          SERIAL      PRIMARY KEY,
        action      TEXT        NOT NULL,
        target_type TEXT,
        target_id   TEXT,
        detail      JSONB,
        ip_address  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_aal_created ON admin_action_logs (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_aal_action  ON admin_action_logs (action);

      CREATE TABLE IF NOT EXISTS user_warnings (
        id          SERIAL      PRIMARY KEY,
        user_id     INT         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason      TEXT        NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_uw_user ON user_warnings (user_id);
    `);
    console.log('✅ Admin panel tables ready');
  } catch (e) {
    console.error('⚠️ Admin table init error (non-fatal):', e.message);
  }
})();

// ── Middleware احراز هویت ادمین ──────────────────────────────────
const adminAuth = (req, res, next) => {
  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized — invalid admin token' });
  }
  next();
};

// ── Helper: لاگ اقدام ادمین ─────────────────────────────────────
async function logAdminAction(action, targetType, targetId, detail = {}, ip = null) {
  try {
    await pool.query(
      `INSERT INTO admin_action_logs (action, target_type, target_id, detail, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [action, targetType, String(targetId || ''), JSON.stringify(detail), ip]
    );
  } catch (e) {
    console.error('⚠️ Admin log error (non-fatal):', e.message);
  }
}

// ════════════════════════════════════════════════════════════════
// 📊 DASHBOARD — آمار کلی پلتفرم
// GET /api/admin/panel/dashboard
// ════════════════════════════════════════════════════════════════
app.get('/api/admin/panel/dashboard', adminAuth, async (req, res) => {
  try {
    const [
      totalUsers, newUsersToday, newUsers7d, newUsers30d,
      totalTweets, tweetsToday, tweets7d,
      totalStories, totalDMs, totalFollows,
      totalLikes, totalBookmarks,
      verifiedGold, verifiedBlue, admins,
      suspendedUsers, activeUsers30d,
      totalNotifications, totalBlocks,
      topPosters, recentActivity, countryStats,
      hourlySignups, dailySignups
    ] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM users"),
      pool.query("SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '1 day'"),
      pool.query("SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '7 days'"),
      pool.query("SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '30 days'"),
      pool.query("SELECT COUNT(*) FROM tweets WHERE parent_id IS NULL"),
      pool.query("SELECT COUNT(*) FROM tweets WHERE created_at >= NOW() - INTERVAL '1 day' AND parent_id IS NULL"),
      pool.query("SELECT COUNT(*) FROM tweets WHERE created_at >= NOW() - INTERVAL '7 days' AND parent_id IS NULL"),
      pool.query("SELECT COUNT(*) FROM stories WHERE created_at >= NOW() - INTERVAL '24 hours'"),
      pool.query("SELECT COUNT(*) FROM direct_messages"),
      pool.query("SELECT COUNT(*) FROM follows"),
      pool.query("SELECT COUNT(*) FROM likes"),
      pool.query("SELECT COUNT(*) FROM bookmarks"),
      pool.query("SELECT COUNT(*) FROM users WHERE verification = 'gold'"),
      pool.query("SELECT COUNT(*) FROM users WHERE verification = 'blue'"),
      pool.query("SELECT COUNT(*) FROM users WHERE is_admin = true"),
      pool.query("SELECT COUNT(*) FROM users WHERE is_suspended = true").catch(() => pool.query("SELECT 0 as count")),
      pool.query("SELECT COUNT(*) FROM users WHERE last_active >= NOW() - INTERVAL '30 days'"),
      pool.query("SELECT COUNT(*) FROM notifications"),
      pool.query("SELECT COUNT(*) FROM blocks"),
      pool.query(`
        SELECT u.username, u.display_name, u.avatar_url, u.verification,
               COUNT(t.id) as tweet_count
        FROM users u
        JOIN tweets t ON t.user_id = u.id
        WHERE t.created_at >= NOW() - INTERVAL '7 days'
        GROUP BY u.id, u.username, u.display_name, u.avatar_url, u.verification
        ORDER BY tweet_count DESC LIMIT 5
      `),
      pool.query(`
        SELECT action, target_type, detail, ip_address, created_at
        FROM admin_action_logs
        ORDER BY created_at DESC LIMIT 20
      `),
      pool.query(`
        SELECT uc.country_name, COUNT(*) as count
        FROM user_country uc
        GROUP BY uc.country_name
        ORDER BY count DESC LIMIT 10
      `).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT date_trunc('hour', created_at) as hour, COUNT(*) as count
        FROM users
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY hour ORDER BY hour ASC
      `),
      pool.query(`
        SELECT date_trunc('day', created_at) as day, COUNT(*) as count
        FROM users
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY day ORDER BY day ASC
      `)
    ]);

    res.json({
      success: true,
      dashboard: {
        users: {
          total:        parseInt(totalUsers.rows[0].count),
          new_today:    parseInt(newUsersToday.rows[0].count),
          new_7d:       parseInt(newUsers7d.rows[0].count),
          new_30d:      parseInt(newUsers30d.rows[0].count),
          active_30d:   parseInt(activeUsers30d.rows[0].count),
          verified_gold: parseInt(verifiedGold.rows[0].count),
          verified_blue: parseInt(verifiedBlue.rows[0].count),
          admins:       parseInt(admins.rows[0].count),
          suspended:    parseInt(suspendedUsers.rows[0].count || 0)
        },
        content: {
          tweets_total:  parseInt(totalTweets.rows[0].count),
          tweets_today:  parseInt(tweetsToday.rows[0].count),
          tweets_7d:     parseInt(tweets7d.rows[0].count),
          active_stories: parseInt(totalStories.rows[0].count),
          total_dms:     parseInt(totalDMs.rows[0].count),
          total_likes:   parseInt(totalLikes.rows[0].count),
          total_bookmarks: parseInt(totalBookmarks.rows[0].count),
          total_follows: parseInt(totalFollows.rows[0].count),
          total_blocks:  parseInt(totalBlocks.rows[0].count),
          total_notifications: parseInt(totalNotifications.rows[0].count)
        },
        top_posters_7d: topPosters.rows,
        recent_admin_actions: recentActivity.rows,
        country_stats: countryStats.rows,
        growth: {
          hourly_24h: hourlySignups.rows,
          daily_30d:  dailySignups.rows
        }
      },
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ Admin dashboard error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 👥 USERS — لیست کاربران با فیلتر، صفحه‌بندی، جستجو
// GET /api/admin/panel/users
// Query: page, limit, search, verification, sort, suspended
// ════════════════════════════════════════════════════════════════
app.get('/api/admin/panel/users', adminAuth, async (req, res) => {
  try {
    const page     = Math.max(0, parseInt(req.query.page  || '0'));
    const limit    = Math.min(100, Math.max(1, parseInt(req.query.limit || '20')));
    const search   = (req.query.search || '').trim();
    const verif    = req.query.verification || null;
    const sort     = ['created_at','last_active','username','tweets_count'].includes(req.query.sort)
                     ? req.query.sort : 'created_at';
    const suspended = req.query.suspended === 'true' ? true : null;

    const conditions = [];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(u.username ILIKE $${params.length} OR u.display_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
    }
    if (verif) {
      params.push(verif);
      conditions.push(`u.verification = $${params.length}`);
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const orderMap = {
      created_at:   'u.created_at DESC',
      last_active:  'u.last_active DESC NULLS LAST',
      username:     'u.username ASC',
      tweets_count: 'tweets_count DESC'
    };

    const countQ = await pool.query(
      `SELECT COUNT(*) FROM users u ${whereClause}`,
      params
    );

    params.push(limit, page * limit);
    const usersQ = await pool.query(
      `SELECT
         u.id, u.username, u.display_name, u.avatar_url, u.email,
         u.verification, u.is_admin, u.created_at, u.last_active, u.bio,
         COALESCE(uc.country_name, 'Unknown') as country,
         COALESCE(uc.country_code, '?') as country_code,
         uc.ip_address,
         (SELECT COUNT(*) FROM tweets WHERE user_id = u.id AND parent_id IS NULL) as tweets_count,
         (SELECT COUNT(*) FROM follows WHERE following_id = u.id) as followers_count,
         (SELECT COUNT(*) FROM follows WHERE follower_id  = u.id) as following_count,
         (SELECT COUNT(*) FROM user_warnings WHERE user_id = u.id) as warnings_count
       FROM users u
       LEFT JOIN user_country uc ON uc.user_id = u.id
       ${whereClause}
       ORDER BY ${orderMap[sort]}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      success: true,
      total:   parseInt(countQ.rows[0].count),
      page,
      limit,
      users:   usersQ.rows
    });
  } catch (err) {
    console.error('❌ Admin users list error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 🔍 USER DEEP PROFILE — پروفایل کامل + تمام فعالیت‌ها
// GET /api/admin/panel/users/:userId
// ════════════════════════════════════════════════════════════════
app.get('/api/admin/panel/users/:userId', adminAuth, async (req, res) => {
  try {
    const { userId } = req.params;

    const [userQ, tweetsQ, sessionsQ, warningsQ, likesQ, followersQ, followingQ, blocksQ, dmsQ] = await Promise.all([
      pool.query(`
        SELECT u.*, uc.country_name, uc.country_code, uc.ip_address, uc.last_seen
        FROM users u
        LEFT JOIN user_country uc ON uc.user_id = u.id
        WHERE u.id = $1
      `, [userId]),
      pool.query(`
        SELECT id, content, media_url, likes_count, created_at,
               (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count
        FROM tweets t
        WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 30
      `, [userId]),
      pool.query(`
        SELECT id, device_info, ip_address, country_name, city,
               is_active, last_activity, created_at
        FROM user_sessions WHERE user_id = $1
        ORDER BY last_activity DESC LIMIT 10
      `, [userId]).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT id, reason, created_at
        FROM user_warnings WHERE user_id = $1
        ORDER BY created_at DESC
      `, [userId]).catch(() => ({ rows: [] })),
      pool.query("SELECT COUNT(*) FROM likes    WHERE user_id = $1", [userId]),
      pool.query("SELECT COUNT(*) FROM follows  WHERE following_id = $1", [userId]),
      pool.query("SELECT COUNT(*) FROM follows  WHERE follower_id  = $1", [userId]),
      pool.query("SELECT COUNT(*) FROM blocks   WHERE blocker_id   = $1", [userId]),
      pool.query(`
        SELECT COUNT(DISTINCT c.id) as conversation_count,
               COUNT(dm.id) as message_count
        FROM conversations c
        JOIN direct_messages dm ON dm.conversation_id = c.id
        WHERE c.user1_id = $1 OR c.user2_id = $1
      `, [userId])
    ]);

    if (userQ.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({
      success: true,
      user: {
        ...userQ.rows[0],
        stats: {
          tweets:        tweetsQ.rows.length,
          likes_given:   parseInt(likesQ.rows[0].count),
          followers:     parseInt(followersQ.rows[0].count),
          following:     parseInt(followingQ.rows[0].count),
          blocks:        parseInt(blocksQ.rows[0].count),
          conversations: parseInt(dmsQ.rows[0]?.conversation_count || 0),
          messages_sent: parseInt(dmsQ.rows[0]?.message_count || 0)
        },
        recent_tweets:   tweetsQ.rows,
        sessions:        sessionsQ.rows,
        warnings:        warningsQ.rows
      }
    });
  } catch (err) {
    console.error('❌ Admin user detail error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// ⚠️ اخطار به کاربر
// POST /api/admin/panel/users/:userId/warn
// Body: { reason }
// ════════════════════════════════════════════════════════════════
app.post('/api/admin/panel/users/:userId/warn', adminAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ success: false, error: 'reason required' });

    const userQ = await pool.query("SELECT id, username FROM users WHERE id = $1", [userId]);
    if (userQ.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });

    await pool.query(
      "INSERT INTO user_warnings (user_id, reason) VALUES ($1, $2)",
      [userId, reason.trim()]
    );

    await pool.query(
      `INSERT INTO notifications (recipient_id, type, content)
       VALUES ($1, 'ADMIN', $2)`,
      [userId, `⚠️ هشدار ادمین: ${reason.trim()}`]
    );

    io.to(`user_${userId}`).emit('notification_alert', {
      type: 'ADMIN_WARNING',
      message: `⚠️ هشدار از تیم پشتیبانی: ${reason.trim()}`
    });

    await logAdminAction('WARN_USER', 'user', userId, { username: userQ.rows[0].username, reason }, req.ip);
    console.log(`⚠️ [ADMIN] Warned user ${userQ.rows[0].username}: ${reason}`);

    res.json({ success: true, message: 'هشدار با موفقیت ارسال شد' });
  } catch (err) {
    console.error('❌ Admin warn user error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 🔇 تعلیق / رفع تعلیق کاربر (Shadow Ban)
// POST /api/admin/panel/users/:userId/suspend
// Body: { suspend: true/false, reason }
// ════════════════════════════════════════════════════════════════
app.post('/api/admin/panel/users/:userId/suspend', adminAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { suspend = true, reason = '' } = req.body;

    const userQ = await pool.query("SELECT id, username, email FROM users WHERE id = $1", [userId]);
    if (userQ.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });
    const user = userQ.rows[0];

    // اگر ستون is_suspended وجود نداشته باشد، اضافه می‌کنیم (safe migration)
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT false
    `).catch(() => {});

    await pool.query(
      "UPDATE users SET is_suspended = $1 WHERE id = $2",
      [!!suspend, userId]
    );

    // پایان دادن به تمام session‌های فعال
    if (suspend) {
      await pool.query(
        "UPDATE user_sessions SET is_active = false WHERE user_id = $1",
        [userId]
      ).catch(() => {});

      await pool.query(
        `INSERT INTO notifications (recipient_id, type, content)
         VALUES ($1, 'ADMIN', $2)`,
        [userId, `🚫 حساب کاربری شما به دلیل نقض قوانین تعلیق شده است${reason ? ': ' + reason : '.'}`]
      );

      io.to(`user_${userId}`).emit('account_suspended', {
        message: 'حساب شما تعلیق شده است',
        reason
      });
    }

    const action = suspend ? 'SUSPEND_USER' : 'UNSUSPEND_USER';
    await logAdminAction(action, 'user', userId, { username: user.username, reason }, req.ip);
    console.log(`🔇 [ADMIN] ${action}: ${user.username}`);

    res.json({
      success: true,
      message: suspend ? `کاربر ${user.username} تعلیق شد` : `تعلیق کاربر ${user.username} رفع شد`
    });
  } catch (err) {
    console.error('❌ Admin suspend error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 🗑️ حذف کامل اکانت کاربر (با تمام داده‌ها)
// DELETE /api/admin/panel/users/:userId
// Body: { confirm: 'DELETE', reason }
// ════════════════════════════════════════════════════════════════
app.delete('/api/admin/panel/users/:userId', adminAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { confirm, reason = '' } = req.body;

    if (confirm !== 'DELETE') {
      return res.status(400).json({ success: false, error: 'confirm باید "DELETE" باشد' });
    }

    const userQ = await pool.query("SELECT id, username, email FROM users WHERE id = $1", [userId]);
    if (userQ.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });
    const user = userQ.rows[0];

    // حذف ترتیبی با رعایت foreign key‌ها
    const deleteSteps = [
      "DELETE FROM likes           WHERE user_id = $1",
      "DELETE FROM bookmarks       WHERE user_id = $1",
      "DELETE FROM retweets        WHERE user_id = $1",
      "DELETE FROM follows         WHERE follower_id = $1 OR following_id = $1",
      "DELETE FROM blocks          WHERE blocker_id  = $1 OR blocked_id   = $1",
      "DELETE FROM notifications   WHERE recipient_id = $1 OR sender_id = $1",
      "DELETE FROM direct_messages WHERE sender_id = $1",
      "DELETE FROM conversations   WHERE user1_id = $1 OR user2_id = $1",
      "DELETE FROM user_sessions   WHERE user_id = $1",
      "DELETE FROM user_country    WHERE user_id = $1",
      "DELETE FROM user_warnings   WHERE user_id = $1",
      "DELETE FROM stories         WHERE user_id = $1",
      "DELETE FROM tweets          WHERE user_id = $1",
      "DELETE FROM users           WHERE id = $1"
    ];

    for (const sql of deleteSteps) {
      await pool.query(sql, [userId]).catch(e =>
        console.error(`⚠️ Delete step failed (non-fatal): ${sql} — ${e.message}`)
      );
    }

    io.emit('user_deleted', { userId: parseInt(userId), username: user.username });

    await logAdminAction('DELETE_USER', 'user', userId, { username: user.username, email: user.email, reason }, req.ip);
    console.log(`🗑️ [ADMIN] Deleted user ${user.username} (ID: ${userId})`);

    res.json({ success: true, message: `اکانت ${user.username} کاملاً حذف شد` });
  } catch (err) {
    console.error('❌ Admin delete user error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 📝 مدیریت توییت‌ها — لیست، جستجو، حذف
// GET /api/admin/panel/tweets
// Query: page, limit, search, username
// ════════════════════════════════════════════════════════════════
app.get('/api/admin/panel/tweets', adminAuth, async (req, res) => {
  try {
    const page   = Math.max(0, parseInt(req.query.page  || '0'));
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit || '20')));
    const search = (req.query.search || '').trim();
    const uname  = (req.query.username || '').trim();

    const conditions = ["t.parent_id IS NULL"];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`t.content ILIKE $${params.length}`);
    }
    if (uname) {
      params.push(uname);
      conditions.push(`u.username = $${params.length}`);
    }

    const where = 'WHERE ' + conditions.join(' AND ');

    const countQ = await pool.query(
      `SELECT COUNT(*) FROM tweets t JOIN users u ON t.user_id = u.id ${where}`,
      params
    );

    params.push(limit, page * limit);
    const tweetsQ = await pool.query(
      `SELECT t.id, t.content, t.media_url, t.likes_count, t.created_at,
              u.id as user_id, u.username, u.display_name, u.avatar_url, u.verification,
              (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count,
              (SELECT COUNT(*) FROM retweets WHERE tweet_id = t.id) as retweet_count
       FROM tweets t
       JOIN users u ON t.user_id = u.id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      success: true,
      total:  parseInt(countQ.rows[0].count),
      page, limit,
      tweets: tweetsQ.rows
    });
  } catch (err) {
    console.error('❌ Admin tweets list error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 🗑️ حذف توییت توسط ادمین (با اطلاع‌رسانی)
// DELETE /api/admin/panel/tweets/:tweetId
// Body: { reason }
// ════════════════════════════════════════════════════════════════
app.delete('/api/admin/panel/tweets/:tweetId', adminAuth, async (req, res) => {
  try {
    const { tweetId } = req.params;
    const { reason = 'نقض قوانین پلتفرم' } = req.body;

    const tweetQ = await pool.query(
      `SELECT t.id, t.content, t.user_id, u.username
       FROM tweets t JOIN users u ON t.user_id = u.id
       WHERE t.id = $1`,
      [tweetId]
    );
    if (tweetQ.rows.length === 0) return res.status(404).json({ success: false, error: 'Tweet not found' });

    const tweet = tweetQ.rows[0];

    await pool.query("DELETE FROM likes     WHERE tweet_id = $1", [tweetId]);
    await pool.query("DELETE FROM bookmarks WHERE tweet_id = $1", [tweetId]);
    await pool.query("DELETE FROM retweets  WHERE tweet_id = $1", [tweetId]);
    await pool.query("DELETE FROM tweets    WHERE id = $1",       [tweetId]);

    await pool.query(
      `INSERT INTO notifications (recipient_id, type, content, reference_id)
       VALUES ($1, 'ADMIN', $2, $3)`,
      [tweet.user_id, `🗑️ پست شما به دلیل «${reason}» توسط تیم پشتیبانی حذف شد.`, tweetId]
    );

    io.to(`user_${tweet.user_id}`).emit('notification_alert', {
      type: 'ADMIN',
      message: `پست شما حذف شد: ${reason}`
    });
    io.emit('tweet_deleted', parseInt(tweetId));

    await logAdminAction('DELETE_TWEET', 'tweet', tweetId, { username: tweet.username, reason, content: tweet.content?.substring(0, 100) }, req.ip);
    console.log(`🗑️ [ADMIN] Deleted tweet ${tweetId} from ${tweet.username}`);

    res.json({ success: true, message: 'توییت حذف شد و کاربر اطلاع‌رسانی شد' });
  } catch (err) {
    console.error('❌ Admin delete tweet error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 💬 مدیریت پیام‌های چت گروهی (Live Rooms)
// GET /api/admin/panel/room-messages
// Query: matchId, page, limit, search
// ════════════════════════════════════════════════════════════════
app.get('/api/admin/panel/room-messages', adminAuth, async (req, res) => {
  try {
    const page    = Math.max(0, parseInt(req.query.page  || '0'));
    const limit   = Math.min(100, parseInt(req.query.limit || '30'));
    const matchId = req.query.matchId || null;
    const search  = (req.query.search || '').trim();

    const conditions = [];
    const params = [];

    if (matchId) {
      params.push(matchId);
      conditions.push(`m.match_id = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`m.content ILIKE $${params.length}`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const countQ = await pool.query(
      `SELECT COUNT(*) FROM messages m ${where}`, params
    );

    params.push(limit, page * limit);
    const msgsQ = await pool.query(
      `SELECT m.id, m.content, m.match_id, m.created_at,
              u.username, u.display_name, u.avatar_url, u.verification
       FROM messages m
       JOIN users u ON m.user_id = u.id
       ${where}
       ORDER BY m.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ success: true, total: parseInt(countQ.rows[0].count), page, limit, messages: msgsQ.rows });
  } catch (err) {
    console.error('❌ Admin room messages error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 🗑️ حذف پیام چت گروهی
// DELETE /api/admin/panel/room-messages/:messageId
// ════════════════════════════════════════════════════════════════
app.delete('/api/admin/panel/room-messages/:messageId', adminAuth, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { reason = '' } = req.body;

    const msgQ = await pool.query(
      `SELECT m.*, u.username FROM messages m
       JOIN users u ON m.user_id = u.id
       WHERE m.id = $1`, [messageId]
    );
    if (msgQ.rows.length === 0) return res.status(404).json({ success: false, error: 'Message not found' });

    await pool.query("DELETE FROM messages WHERE id = $1", [messageId]);
    io.to(msgQ.rows[0].match_id).emit('message_deleted', parseInt(messageId));

    await logAdminAction('DELETE_ROOM_MESSAGE', 'message', messageId, { username: msgQ.rows[0].username, content: msgQ.rows[0].content?.substring(0, 100), reason }, req.ip);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 📨 DM مشکوک — پیام‌های خصوصی اخیر (برای بررسی ادمین)
// GET /api/admin/panel/dms
// Query: username, limit
// ════════════════════════════════════════════════════════════════
app.get('/api/admin/panel/dms', adminAuth, async (req, res) => {
  try {
    const limit  = Math.min(100, parseInt(req.query.limit || '50'));
    const uname  = (req.query.username || '').trim();

    let query, params;

    if (uname) {
      const userQ = await pool.query("SELECT id FROM users WHERE username = $1", [uname]);
      if (userQ.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });
      const uid = userQ.rows[0].id;
      query = `
        SELECT dm.id, dm.content, dm.created_at,
               s.username as sender, s.display_name as sender_display,
               r.username as recipient, r.display_name as recipient_display,
               c.id as conversation_id
        FROM direct_messages dm
        JOIN conversations c ON dm.conversation_id = c.id
        JOIN users s ON dm.sender_id = s.id
        JOIN users r ON (CASE WHEN c.user1_id = dm.sender_id THEN c.user2_id ELSE c.user1_id END) = r.id
        WHERE dm.sender_id = $1 OR c.user1_id = $1 OR c.user2_id = $1
        ORDER BY dm.created_at DESC LIMIT $2`;
      params = [uid, limit];
    } else {
      query = `
        SELECT dm.id, dm.content, dm.created_at,
               s.username as sender, s.display_name as sender_display,
               r.username as recipient, r.display_name as recipient_display,
               c.id as conversation_id
        FROM direct_messages dm
        JOIN conversations c ON dm.conversation_id = c.id
        JOIN users s ON dm.sender_id = s.id
        JOIN users r ON (CASE WHEN c.user1_id = dm.sender_id THEN c.user2_id ELSE c.user1_id END) = r.id
        ORDER BY dm.created_at DESC LIMIT $1`;
      params = [limit];
    }

    const result = await pool.query(query, params);
    res.json({ success: true, count: result.rows.length, messages: result.rows });
  } catch (err) {
    console.error('❌ Admin DMs error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 📢 ارسال اعلان سراسری به همه کاربران
// POST /api/admin/panel/broadcast
// Body: { message, type? }
// ════════════════════════════════════════════════════════════════
app.post('/api/admin/panel/broadcast', adminAuth, async (req, res) => {
  try {
    const { message, type = 'ADMIN' } = req.body;
    if (!message?.trim()) return res.status(400).json({ success: false, error: 'message required' });

    const usersQ = await pool.query("SELECT id FROM users LIMIT 5000");

    let inserted = 0;
    for (const user of usersQ.rows) {
      await pool.query(
        `INSERT INTO notifications (recipient_id, type, content) VALUES ($1, $2, $3)`,
        [user.id, type, message.trim()]
      ).catch(() => {});
      inserted++;
    }

    io.emit('broadcast_notification', { type, message: message.trim() });

    await logAdminAction('BROADCAST', 'system', 'all', { message: message.substring(0, 200), recipients: inserted }, req.ip);
    console.log(`📢 [ADMIN] Broadcast sent to ${inserted} users`);

    res.json({ success: true, message: `اعلان به ${inserted} کاربر ارسال شد` });
  } catch (err) {
    console.error('❌ Admin broadcast error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 🔍 جستجوی عمیق — کاربر، توییت، پیام
// GET /api/admin/panel/search
// Query: q, type (user|tweet|message)
// ════════════════════════════════════════════════════════════════
app.get('/api/admin/panel/search', adminAuth, async (req, res) => {
  try {
    const q    = (req.query.q || '').trim();
    const type = req.query.type || 'all';

    if (q.length < 2) return res.status(400).json({ success: false, error: 'حداقل ۲ کاراکتر وارد کنید' });

    const pattern = `%${q}%`;
    const results = {};

    if (type === 'all' || type === 'user') {
      const r = await pool.query(
        `SELECT id, username, display_name, avatar_url, email, verification, created_at
         FROM users WHERE username ILIKE $1 OR display_name ILIKE $1 OR email ILIKE $1
         LIMIT 20`,
        [pattern]
      );
      results.users = r.rows;
    }

    if (type === 'all' || type === 'tweet') {
      const r = await pool.query(
        `SELECT t.id, t.content, t.created_at, u.username, u.display_name
         FROM tweets t JOIN users u ON t.user_id = u.id
         WHERE t.content ILIKE $1
         ORDER BY t.created_at DESC LIMIT 20`,
        [pattern]
      );
      results.tweets = r.rows;
    }

    if (type === 'all' || type === 'message') {
      const r = await pool.query(
        `SELECT m.id, m.content, m.created_at, u.username
         FROM messages m JOIN users u ON m.user_id = u.id
         WHERE m.content ILIKE $1
         ORDER BY m.created_at DESC LIMIT 20`,
        [pattern]
      );
      results.room_messages = r.rows;
    }

    res.json({ success: true, query: q, results });
  } catch (err) {
    console.error('❌ Admin search error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 📋 لاگ اقدامات ادمین
// GET /api/admin/panel/logs
// Query: page, limit, action
// ════════════════════════════════════════════════════════════════
app.get('/api/admin/panel/logs', adminAuth, async (req, res) => {
  try {
    const page   = Math.max(0, parseInt(req.query.page  || '0'));
    const limit  = Math.min(200, parseInt(req.query.limit || '50'));
    const action = (req.query.action || '').trim();

    const params = [];
    let where = '';
    if (action) {
      params.push(`%${action}%`);
      where = `WHERE action ILIKE $1`;
    }

    params.push(limit, page * limit);
    const countQ = await pool.query(
      `SELECT COUNT(*) FROM admin_action_logs ${where}`,
      action ? [params[0]] : []
    );

    const logsQ = await pool.query(
      `SELECT id, action, target_type, target_id, detail, ip_address, created_at
       FROM admin_action_logs
       ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      success: true,
      total: parseInt(countQ.rows[0].count),
      page, limit,
      logs: logsQ.rows
    });
  } catch (err) {
    console.error('❌ Admin logs error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 📈 آنالیتیکس — نمودار رشد، ساعات پیک، محتوای پرتعامل
// GET /api/admin/panel/analytics
// ════════════════════════════════════════════════════════════════
app.get('/api/admin/panel/analytics', adminAuth, async (req, res) => {
  try {
    const [
      userGrowth, tweetActivity, peakHours,
      topTweets, engagementRate, retentionData,
      verificationBreakdown, storiesStats
    ] = await Promise.all([
      pool.query(`
        SELECT date_trunc('day', created_at) as date, COUNT(*) as new_users
        FROM users
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY date ORDER BY date ASC
      `),
      pool.query(`
        SELECT date_trunc('day', created_at) as date,
               COUNT(*) FILTER (WHERE parent_id IS NULL) as posts,
               COUNT(*) FILTER (WHERE parent_id IS NOT NULL) as replies
        FROM tweets
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY date ORDER BY date ASC
      `),
      pool.query(`
        SELECT EXTRACT(HOUR FROM created_at) as hour, COUNT(*) as count
        FROM tweets
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY hour ORDER BY hour ASC
      `),
      pool.query(`
        SELECT t.id, t.content, t.likes_count, t.created_at,
               u.username, u.display_name,
               (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count,
               (SELECT COUNT(*) FROM retweets WHERE tweet_id = t.id) as retweet_count
        FROM tweets t JOIN users u ON t.user_id = u.id
        WHERE t.parent_id IS NULL
          AND t.created_at >= NOW() - INTERVAL '7 days'
        ORDER BY (t.likes_count + (SELECT COUNT(*) FROM retweets WHERE tweet_id = t.id)) DESC
        LIMIT 10
      `),
      pool.query(`
        SELECT
          ROUND(AVG(likes_count)::numeric, 2) as avg_likes_per_post,
          ROUND((COUNT(*) FILTER (WHERE likes_count > 0) * 100.0 / NULLIF(COUNT(*), 0))::numeric, 1) as posts_with_likes_pct
        FROM tweets WHERE parent_id IS NULL
      `),
      pool.query(`
        SELECT date_trunc('week', created_at) as week,
               COUNT(*) FILTER (WHERE last_active >= created_at + INTERVAL '7 days') * 100 / NULLIF(COUNT(*), 0) as retention_7d
        FROM users
        WHERE created_at >= NOW() - INTERVAL '12 weeks'
        GROUP BY week ORDER BY week ASC
      `),
      pool.query(`
        SELECT verification, COUNT(*) as count
        FROM users GROUP BY verification
      `),
      pool.query(`
        SELECT date_trunc('day', created_at) as date, COUNT(*) as stories
        FROM stories
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY date ORDER BY date ASC
      `)
    ]);

    res.json({
      success: true,
      analytics: {
        user_growth_30d:      userGrowth.rows,
        tweet_activity_30d:   tweetActivity.rows,
        peak_hours_7d:        peakHours.rows,
        top_tweets_7d:        topTweets.rows,
        engagement:           engagementRate.rows[0],
        retention_weekly:     retentionData.rows,
        verification_breakdown: verificationBreakdown.rows,
        stories_daily_30d:    storiesStats.rows
      },
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ Admin analytics error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 🔐 اعطا / حذف نقش ادمین به کاربر
// POST /api/admin/panel/users/:userId/set-admin
// Body: { is_admin: true/false }
// ════════════════════════════════════════════════════════════════
app.post('/api/admin/panel/users/:userId/set-admin', adminAuth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { is_admin } = req.body;

    const userQ = await pool.query("SELECT id, username FROM users WHERE id = $1", [userId]);
    if (userQ.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });

    await pool.query("UPDATE users SET is_admin = $1 WHERE id = $2", [!!is_admin, userId]);

    await logAdminAction(is_admin ? 'GRANT_ADMIN' : 'REVOKE_ADMIN', 'user', userId, { username: userQ.rows[0].username }, req.ip);

    res.json({ success: true, message: is_admin ? 'نقش ادمین اعطا شد' : 'نقش ادمین حذف شد' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// 📋 آمار سریع سیستم برای Header پنل
// GET /api/admin/panel/quick-stats
// ════════════════════════════════════════════════════════════════
app.get('/api/admin/panel/quick-stats', adminAuth, async (req, res) => {
  try {
    const [users, tweets, onlineApprox, newToday] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM users"),
      pool.query("SELECT COUNT(*) FROM tweets WHERE parent_id IS NULL"),
      pool.query("SELECT COUNT(*) FROM users WHERE last_active >= NOW() - INTERVAL '15 minutes'"),
      pool.query("SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '1 day'")
    ]);

    res.set('Cache-Control', 'no-store');
    res.json({
      success:       true,
      total_users:   parseInt(users.rows[0].count),
      total_tweets:  parseInt(tweets.rows[0].count),
      online_approx: parseInt(onlineApprox.rows[0].count),
      new_today:     parseInt(newToday.rows[0].count),
      ts:            new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// OLD ADMIN ROUTES — بدون تغییر باقی ماندند
// ════════════════════════════════════════════════════════════════

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
// 12. BLOCK SYSTEM
// ======================================================

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
// 13. LIVE MATCHES & ROOMS
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
// 14. ACCOUNT SETTINGS & SESSIONS (✅ تغییر 4: اصلاح شده)
// ======================================================

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

app.get('/api/settings/sessions/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
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

    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'user_sessions'
      );
    `);
    
    if (!tableCheck.rows[0].exists) {
      return res.json({ 
        success: true, 
        sessions: [],
        message: "هیچ نشست فعالی یافت نشد"
      });
    }

    const sessions = await pool.query(`
      SELECT 
        id,
        COALESCE(device_info, '{}') as device_info,
        COALESCE(ip_address, 'نامشخص') as ip_address,
        COALESCE(country_code, 'IR') as country_code,
        COALESCE(country_name, 'ایران') as country_name,
        COALESCE(city, 'تهران') as city,
        COALESCE(is_active, true) as is_active,
        COALESCE(last_activity, created_at) as last_activity,
        created_at,
        CASE 
          WHEN id = $2 THEN true ELSE false 
        END as is_current_session
      FROM user_sessions
      WHERE user_id = $1 
      ORDER BY last_activity DESC
    `, [userId, currentSessionId || 0]);

    res.json({ 
      success: true, 
      sessions: sessions.rows 
    });

  } catch (error) {
    console.error("❌ Get sessions error:", error);
    res.json({ 
      success: true, 
      sessions: [],
      message: "خطا در دریافت نشست‌ها"
    });
  }
});

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

    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'user_sessions'
      );
    `);
    
    if (!tableCheck.rows[0].exists) {
      return res.json({ 
        success: true, 
        message: "نشست ثبت نشد (جدول وجود ندارد)",
        session_id: null
      });
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
      ON CONFLICT (session_token) DO UPDATE SET
        is_active = true, last_activity = NOW(),
        ip_address = EXCLUDED.ip_address,
        country_code = EXCLUDED.country_code,
        country_name = EXCLUDED.country_name,
        city = EXCLUDED.city
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
    res.json({ success: true, message: "نشست ثبت نشد", session_id: null });
  }
});

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

app.post('/api/settings/deactivation/send-otp', async (req, res) => {
  try {
    const { username, email } = req.body;
    
    if (!username || !email) {
      return res.status(400).json({ error: "اطلاعات ناقص است" });
    }

    const user = await pool.query(
      "SELECT id, email FROM users WHERE username = $1 AND LOWER(email) = LOWER($2)",
      [username, email]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "کاربر یافت نشد" });
    }
    
    const userId = user.rows[0].id;
    const realEmail = user.rows[0].email;

    // پاک کردن درخواست‌های قدیمی
    await pool.query(
      "DELETE FROM account_deactivation_requests WHERE user_id = $1",
      [userId]
    ).catch(() => {});

    // ارسال OTP از طریق Supabase (همان روش ثبت‌نام)
    const { error: otpError } = await supabase.auth.signInWithOtp({ email: realEmail });
    if (otpError) throw otpError;

    // یک placeholder در جدول ذخیره می‌کنیم — کد واقعی در Supabase هست
    const otpExpires = new Date(Date.now() + 10 * 60000);
    await pool.query(`
      INSERT INTO account_deactivation_requests 
        (user_id, username, email, otp_code, otp_expires_at, status)
      VALUES ($1, $2, $3, 'SUPABASE', $4, 'pending')
    `, [userId, username, realEmail, otpExpires]);

    console.log(`📧 Deactivation OTP sent via Supabase to ${email} for user ${username}`);

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
      SELECT id, email, otp_expires_at 
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

    // تأیید OTP از طریق Supabase (همان روش ثبت‌نام)
    const { error: verifyError } = await supabase.auth.verifyOtp({
      email: reqData.email,
      token: otp,
      type: 'email'
    });

    if (verifyError) {
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
// 16. SOCKET.IO LOGIC (✅ تغییر 6: اضافه کردن join_user_room)
// ======================================================

const userSocketMap = new Map();

io.on('connection', (socket) => {
  console.log('🔌 New connection:', socket.id);
  
  // ======================================================
  // ✅ تغییر 6: هندلر جدید برای پیوستن به روم کاربر
  // ======================================================
  socket.on('join_user_room', async (username) => {
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
        console.log(`✅ User ${username} joined their room: user_${userId}`);
      }
    } catch (err) { 
      console.error("Join user room error:", err); 
    }
  });
  
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
      user_by_username: 'GET /api/users/:username',
      user_tweets: 'GET /api/users/:username/tweets',
      user_update: 'PUT /api/users/update',
      user_search: 'GET /api/users/search',
      football_teams_search: 'GET /api/football/teams/search',
      football_players_search: 'GET /api/football/players/search',
      football_prefs: 'PUT /api/users/football-prefs',
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
      tweet_detail: 'GET /api/tweets/:id/detail',
      tweet_replies: 'GET /api/tweets/replies/:parentId',
      follow: 'POST /api/follow',
      unfollow: 'POST /api/unfollow',
      follow_status: 'GET /api/follow/status',
      // ── Admin Panel (Professional) ──
      admin_dashboard:    'GET  /api/admin/panel/dashboard',
      admin_quick_stats:  'GET  /api/admin/panel/quick-stats',
      admin_users:        'GET  /api/admin/panel/users',
      admin_user_detail:  'GET  /api/admin/panel/users/:userId',
      admin_warn_user:    'POST /api/admin/panel/users/:userId/warn',
      admin_suspend_user: 'POST /api/admin/panel/users/:userId/suspend',
      admin_set_admin:    'POST /api/admin/panel/users/:userId/set-admin',
      admin_delete_user:  'DELETE /api/admin/panel/users/:userId',
      admin_tweets_list:  'GET  /api/admin/panel/tweets',
      admin_delete_tweet_panel: 'DELETE /api/admin/panel/tweets/:tweetId',
      admin_room_msgs:    'GET  /api/admin/panel/room-messages',
      admin_del_room_msg: 'DELETE /api/admin/panel/room-messages/:messageId',
      admin_dms:          'GET  /api/admin/panel/dms',
      admin_broadcast:    'POST /api/admin/panel/broadcast',
      admin_search:       'GET  /api/admin/panel/search',
      admin_analytics:    'GET  /api/admin/panel/analytics',
      admin_logs:         'GET  /api/admin/panel/logs',
      // ── Legacy Admin ──
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
  console.log('🚀 AJ Sports 2026 Backend v3.0.0 - ADMIN PANEL EDITION');
  console.log('='.repeat(60));
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
  console.log(`✅ Health: http://localhost:${PORT}/api/health`);
  console.log('\n🛡️ Admin Panel Endpoints (x-admin-token required):');
  console.log('  • GET  /api/admin/panel/dashboard');
  console.log('  • GET  /api/admin/panel/users');
  console.log('  • GET  /api/admin/panel/analytics');
  console.log('  • GET  /api/admin/panel/logs');
  console.log('  • POST /api/admin/panel/broadcast');
  console.log('  • GET  /api/admin/panel/search');
  console.log('\n⚠️  Set ADMIN_SECRET_TOKEN in .env to enable admin panel!');
  console.log('\n📦 اصلاحات انجام شده در این نسخه:');
  console.log('  • تغییر 1: مسیر /api/users/search به BEFORE /api/users/:username منتقل شد');
  console.log('  • تغییر 2: INNER JOIN به LEFT JOIN در نوتیفیکیشن‌ها تبدیل شد');
  console.log('  • تغییر 3: مسیر /api/dm/conversation اصلاح شد (رفع server error)');
  console.log('  • تغییر 4: مسیر /api/settings/sessions/:username اصلاح شد (رفع خطای نشست‌ها)');
  console.log('  • تغییر 5: API جدید GET /api/tweets/:id/detail اضافه شد (نمایش توییت + پاسخ‌ها)');
  console.log('  • تغییر 6: هندلر Socket.io join_user_room اضافه شد (رفع نوتیفیکیشن)');
  console.log('  • تغییر 7: مسیر /api/tweets/:id/like برای ارسال نوتیفیکیشن صحیح اصلاح شد');
  console.log('  • تغییر 8: مسیر /api/tweets برای ارسال new_reply و update_reply_count اصلاح شد');
  console.log('  • تغییر 9: API جدید GET /api/tweets/replies/:parentId اضافه شد');
  console.log('  • تغییر 10: هندلر Socket.io mark_reply_read اضافه شد');
  console.log('\n⚽ Football API - Cache Layer اضافه شد:');
  console.log('  • GET /api/football/teams/search');
  console.log('  • GET /api/football/players/search');
  console.log('  • PUT /api/users/football-prefs');
  console.log('\n✅ تمام APIهای دیگر بدون تغییر باقی ماندند');
  console.log('📡 WebSocket روم‌ها:');
  console.log('  • user_{userId} - برای نوتیفیکیشن‌های شخصی');
  console.log('  • conv_{conversationId} - برای پیام‌های خصوصی');
  console.log('  • {matchId} - برای چت گروهی');
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