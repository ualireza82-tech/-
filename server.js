/**
 * Pro Server 2026 - Ultimate Edition
 * با قابلیت کامل نمایش توییت‌ها در پروفایل کاربر
 * ✅ اضافه شدن سیستم استوری 24 ساعته مشابه اینستاگرام
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');

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
app.use(express.json({ limit: '20kb' }));

// Add root route handler
app.get('/', (req, res) => {
  res.json({ 
    message: 'AJ Sports 2026 Backend API', 
    version: '1.0.0',
    status: 'online',
    endpoints: {
      auth: '/api/auth/sync',
      users: '/api/users/profile/:username',
      users_tweets: '/api/users/:username/tweets',
      stories: '/api/stories', // ✅ استوری اضافه شد
      stories_following: '/api/stories/following/:username', // ✅ استوری اضافه شد
      tweets: '/api/tweets',
      notifications: '/api/notifications/:username',
      dm: '/api/dm/list/:username',
      admin: '/api/admin/verification'
    }
  });
});

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
// 2. API ROUTES - COMPLETELY FIXED
// ======================================================

// --- HEALTH CHECK ---
app.get('/api/health', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT NOW() as time');
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: {
        connected: true,
        time: dbResult.rows[0].time
      },
      server: 'AJ Sports 2026 Backend'
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// --- AUTH & USER MANAGEMENT ---

// Sync User (Login/Register)
app.post('/api/auth/sync', async (req, res) => {
  try {
    console.log('📝 Auth sync request:', req.body);
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
    
    const result = await pool.query(query, [
      email, 
      username, 
      display_name || username,
      avatar_url || 'https://via.placeholder.com/150'
    ]);
    
    const user = result.rows[0];
    
    // اگر ایمیل خاص هست، ادمین کن
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
    
    console.log('📱 Profile request for:', username);
    
    const query = `
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.verification, u.bio, u.created_at,
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

// Get User's Tweets (برای نمایش در پروفایل کاربر) ✅ API جدید
app.get('/api/users/:username/tweets', async (req, res) => {
  try {
    const { username } = req.params;
    const requesterUsername = req.query.me;
    
    console.log('📄 Fetching user tweets for:', username);
    
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
        t.id, t.content, t.created_at, t.likes_count, t.user_id, t.parent_id,
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
    
    console.log(`✅ Found ${result.rows.length} tweets for ${username}`);
    res.json(result.rows);
  } catch (error) {
    console.error("User tweets error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update Profile
app.put('/api/users/update', async (req, res) => {
  try {
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
      display_name || null,
      bio || null,
      avatar_url || null,
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
      `SELECT username, display_name, avatar_url, verification 
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
// 3. STORY SYSTEM API ROUTES (جدید اضافه شده) ✅
// ======================================================

// Create Story - POST /api/stories
app.post('/api/stories', async (req, res) => {
  try {
    const { username, type, media_url, text, text_color } = req.body;
    
    console.log('📸 Create story request:', { username, type });
    
    if (!username || !type) {
      return res.status(400).json({ error: "اطلاعات ناقص است" });
    }

    // Get user
    const user = await pool.query(
      "SELECT id, display_name, avatar_url FROM users WHERE username = $1", 
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "کاربر یافت نشد" });
    }
    
    const userId = user.rows[0].id;

    // Delete stories older than 24 hours for this user
    await pool.query(
      "DELETE FROM stories WHERE user_id = $1 AND created_at < NOW() - INTERVAL '24 hours'",
      [userId]
    );

    // Insert new story
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

    console.log('✅ Story created:', story.id);
    
    // Broadcast new story via Socket.io
    if (io) {
      io.emit('new_story', story);
    }

    res.json({ success: true, story });
  } catch (error) {
    console.error("❌ Create story error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Stories for Following Users - GET /api/stories/following/:username
// ✅ اصلاح شده: استوری‌های همه کاربران را برمی‌گرداند
app.get('/api/stories/following/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    console.log('📱 Get stories request for:', username);
    
    // Get user
    const user = await pool.query(
      "SELECT id, display_name, avatar_url FROM users WHERE username = $1", 
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "کاربر یافت نشد" });
    }
    
    const userId = user.rows[0].id;

    // ✅ تغییر: دریافت استوری‌های همه کاربران (نه فقط فالوینگ)
    const query = `
      SELECT 
        s.id, s.type, s.media_url, s.text, s.text_color, s.created_at,
        u.id as user_id, u.username, u.display_name, u.avatar_url
      FROM stories s
      JOIN users u ON s.user_id = u.id
      WHERE s.created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY s.created_at DESC
    `;
    
    const result = await pool.query(query);

    // ✅ تغییر: گروه‌بندی استوری‌ها بر اساس کاربر
    const storiesByUser = {};
    
    result.rows.forEach(story => {
      const userKey = story.username;
      
      if (!storiesByUser[userKey]) {
        storiesByUser[userKey] = {
          username: story.username,
          display_name: story.display_name,
          avatar_url: story.avatar_url,
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

    // تبدیل object به array و اضافه کردن کاربر جاری اگر استوری ندارد
    let response = Object.values(storiesByUser);
    
    // اگر کاربر جاری در لیست نیست، اضافه کن (حتی اگر استوری نداشته باشد)
    if (!storiesByUser[username]) {
      response.unshift({
        username: username,
        display_name: user.rows[0].display_name || username,
        avatar_url: user.rows[0].avatar_url || 'https://via.placeholder.com/150',
        stories: []
      });
    }

    console.log(`✅ Found stories from ${response.length} users for ${username}`);
    res.json(response);
  } catch (error) {
    console.error("❌ Get stories error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ✅ API جدید: دریافت استوری‌های یک کاربر خاص
app.get('/api/stories/user/:targetUsername', async (req, res) => {
  try {
    const { targetUsername } = req.params;
    const viewerUsername = req.query.viewer || req.query.viewerUsername;
    
    console.log('📱 Get specific user stories for:', targetUsername, 'viewer:', viewerUsername);
    
    // Get target user
    const targetUser = await pool.query(
      "SELECT id, display_name, avatar_url FROM users WHERE username = $1", 
      [targetUsername]
    );
    
    if (targetUser.rows.length === 0) {
      return res.status(404).json({ error: "کاربر یافت نشد" });
    }
    
    const targetUserId = targetUser.rows[0].id;

    // دریافت استوری‌های کاربر هدف
    const storiesRes = await pool.query(
      `SELECT id, type, media_url, text, text_color, created_at 
       FROM stories 
       WHERE user_id = $1 
       AND created_at >= NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC`,
      [targetUserId]
    );

    const response = {
      user: {
        username: targetUsername,
        display_name: targetUser.rows[0].display_name || targetUsername,
        avatar_url: targetUser.rows[0].avatar_url || 'https://via.placeholder.com/150'
      },
      stories: storiesRes.rows,
      can_view: true // همه می‌توانند استوری ببینند (بدون محدودیت)
    };

    console.log(`✅ Found ${storiesRes.rows.length} stories for user ${targetUsername}`);
    res.json(response);
  } catch (error) {
    console.error("❌ Get specific user stories error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get User Stories - GET /api/stories/user/:username (برای سازگاری)
app.get('/api/stories/user/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    console.log('📱 Get user stories request for:', username);
    
    // Get user
    const user = await pool.query(
      "SELECT id, display_name, avatar_url FROM users WHERE username = $1", 
      [username]
    );
    
    if (user.rows.length === 0) {
      return res.status(404).json({ error: "کاربر یافت نشد" });
    }
    
    const userId = user.rows[0].id;

    // Get stories from database
    const storiesRes = await pool.query(
      `SELECT id, type, media_url, text, text_color, created_at 
       FROM stories 
       WHERE user_id = $1 
       AND created_at >= NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC`,
      [userId]
    );

    const response = {
      user: {
        username: username,
        display_name: user.rows[0].display_name || username,
        avatar_url: user.rows[0].avatar_url || 'https://via.placeholder.com/150'
      },
      stories: storiesRes.rows
    };

    console.log(`✅ Found ${storiesRes.rows.length} stories for user ${username}`);
    res.json(response);
  } catch (error) {
    console.error("❌ Get user stories error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete Story - DELETE /api/stories/:storyId
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

    // Broadcast deletion via Socket.io
    if (io) {
      io.emit('story_deleted', storyId);
    }

    console.log(`✅ Story ${storyId} deleted`);
    res.json({ success: true });
  } catch (error) {
    console.error("❌ Delete story error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======================================================
// 4. NOTIFICATIONS SYSTEM
// ======================================================

// Get Notifications - FIXED
app.get('/api/notifications/:username', async (req, res) => {
  try {
    const { username } = req.params;
    console.log('🔔 Notifications request for:', username);
    
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
    console.log(`✅ Found ${result.rows.length} notifications for ${username}`);
    
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
// 5. DIRECT MESSAGES
// ======================================================

// Get Conversations List - FIXED
app.get('/api/dm/list/:username', async (req, res) => {
  try {
    const { username } = req.params;
    console.log('💬 DM list request for:', username);
    
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
    console.log(`✅ Found ${result.rows.length} conversations for ${username}`);
    
    res.json(result.rows);
  } catch (error) {
    console.error("DM list error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start Conversation - FIXED
app.post('/api/dm/conversation', async (req, res) => {
  try {
    const { username1, username2 } = req.body;
    console.log('💬 Start conversation:', username1, 'with', username2);
    
    if (!username1 || !username2) {
      return res.status(400).json({ error: "نام‌های کاربری الزامی هستند" });
    }

    // Get user IDs
    const [u1, u2] = await Promise.all([
      pool.query("SELECT id, username, display_name, avatar_url, verification FROM users WHERE username = $1", [username1]),
      pool.query("SELECT id, username, display_name, avatar_url, verification FROM users WHERE username = $1", [username2])
    ]);
    
    if (u1.rows.length === 0 || u2.rows.length === 0) {
      return res.status(404).json({ error: "یکی از کاربران یافت نشد" });
    }

    const id1 = Math.min(u1.rows[0].id, u2.rows[0].id);
    const id2 = Math.max(u1.rows[0].id, u2.rows[0].id);

    // Find or create conversation
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
    
    // Get unread count for the requester
    const requesterId = u1.rows[0].id;
    const unreadCount = await pool.query(`
      SELECT COUNT(*) as count FROM direct_messages 
      WHERE conversation_id = $1 AND sender_id != $2 AND read = false
    `, [conversation.id, requesterId]);

    // Get messages
    const messages = await pool.query(`
      SELECT dm.*, u.username, u.display_name, u.avatar_url, u.verification
      FROM direct_messages dm
      JOIN users u ON dm.sender_id = u.id
      WHERE conversation_id = $1 
      ORDER BY created_at ASC LIMIT 100
    `, [conversation.id]);

    // Determine which user is the other user
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
// 6. TWEET SYSTEM
// ======================================================

// Feed (صفحه اصلی)
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
  } catch (error) {
    console.error("Feed error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create Tweet
app.post('/api/tweets', async (req, res) => {
  try {
    const { username, content, parentId } = req.body;
    
    if (!username || !content || content.trim().length === 0) {
      return res.status(400).json({ error: "نام کاربری و محتوا الزامی هستند" });
    }

    const cleanContent = content.trim();
    
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
  } catch (error) {
    console.error("Create tweet error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Like Tweet
app.post('/api/tweets/:id/like', async (req, res) => {
  try {
    const { username } = req.body;
    const tweetId = req.params.id;
    
    if (!username) {
      return res.status(400).json({ error: "نام کاربری الزامی است" });
    }

    const user = await pool.query(
      "SELECT id FROM users WHERE username = $1", 
      [username]
    );
    
    if (!user.rows.length) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const userId = user.rows[0].id;

    const check = await pool.query(
      "SELECT 1 FROM likes WHERE user_id = $1 AND tweet_id = $2", 
      [userId, tweetId]
    );
    
    if (check.rows.length === 0) {
      // Like
      await pool.query(
        "INSERT INTO likes (user_id, tweet_id) VALUES ($1, $2)", 
        [userId, tweetId]
      );
      
      await pool.query(
        "UPDATE tweets SET likes_count = likes_count + 1 WHERE id = $1", 
        [tweetId]
      );
      
      // Get tweet owner for notification
      const tweetOwner = await pool.query(
        "SELECT user_id FROM tweets WHERE id = $1", 
        [tweetId]
      );
      
      if (tweetOwner.rows.length && tweetOwner.rows[0].user_id !== userId) {
        await pool.query(
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
      
      io.emit('update_tweet_stats', { tweetId, action: 'like_added' });
      res.json({ success: true, action: 'liked' });
    } else {
      // Unlike
      await pool.query(
        "DELETE FROM likes WHERE user_id = $1 AND tweet_id = $2", 
        [userId, tweetId]
      );
      
      await pool.query(
        "UPDATE tweets SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = $1", 
        [tweetId]
      );
      
      io.emit('update_tweet_stats', { tweetId, action: 'like_removed' });
      res.json({ success: true, action: 'unliked' });
    }
  } catch (error) {
    console.error("Like error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete Tweet
app.delete('/api/tweets/:id', async (req, res) => {
  try {
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
  } catch (error) {
    console.error("Delete tweet error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Bookmark Tweet
app.post('/api/tweets/:id/bookmark', async (req, res) => {
  try {
    const { username } = req.body;
    const tweetId = req.params.id;
    
    if (!username) {
      return res.status(400).json({ error: "نام کاربری الزامی است" });
    }

    const user = await pool.query(
      "SELECT id FROM users WHERE username = $1", 
      [username]
    );
    
    if (!user.rows.length) {
      return res.status(404).json({ error: "User not found" });
    }
    
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
  } catch (error) {
    console.error("Bookmark error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Bookmarks
app.get('/api/bookmarks/:username', async (req, res) => {
  try {
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
  } catch (error) {
    console.error("Bookmarks error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======================================================
// 7. ADMIN MANAGEMENT
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
  } catch (error) {
    console.error("Remove verification error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======================================================
// 8. LIVE MATCHES & ROOMS
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
// 9. SOCKET.IO LOGIC - با قابلیت‌های استوری ✅
// ======================================================

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
    console.log(`👥 User joined room: ${matchId}`);
  });

  // Leave room
  socket.on('leave_room', (matchId) => {
    socket.leave(matchId);
    console.log(`👋 User left room: ${matchId}`);
  });

  // Send message to room
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

  // Listen for story view events
  socket.on('story_viewed', ({ storyId, viewerId }) => {
    console.log(`👁️ Story ${storyId} viewed by user ${viewerId}`);
    // می‌توانید اینجا view count را آپدیت کنید
  });

  // Disconnect
  socket.on('disconnect', () => {
    // Remove from user map
    if (socket.data.userId) {
      userSocketMap.delete(socket.data.userId);
    }
    
    console.log(`❌ Disconnected: ${socket.id}`);
  });
});

// ======================================================
// 10. ERROR HANDLING & SERVER START
// ======================================================

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('🔥 Global Error:', err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

// 404 Handler (should be last)
app.use((req, res) => {
  console.log('🔍 404 Not Found:', req.method, req.url);
  res.status(404).json({ 
    error: 'Route not found',
    requested: req.url,
    method: req.method,
    available_endpoints: {
      root: 'GET /',
      health: 'GET /api/health',
      auth: 'POST /api/auth/sync',
      profile: 'GET /api/users/profile/:username',
      user_tweets: 'GET /api/users/:username/tweets',
      stories: 'POST /api/stories', // ✅ اضافه شد
      stories_following: 'GET /api/stories/following/:username', // ✅ اضافه شد
      notifications: 'GET /api/notifications/:username',
      dm: 'GET /api/dm/list/:username',
      tweets: 'GET /api/tweets/feed',
      bookmarks: 'GET /api/bookmarks/:username',
      admin: 'POST /api/admin/verification'
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 AJ Sports 2026 Backend running on Port ${PORT}`);
  console.log(`📡 WebSocket ready at ws://localhost:${PORT}`);
  console.log(`🌐 API available at http://localhost:${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
  console.log(`✅ User tweets API: http://localhost:${PORT}/api/users/:username/tweets`);
  console.log(`📸 Story API: http://localhost:${PORT}/api/stories/following/:username`); // ✅ اضافه شد
  console.log(`👁️ Specific user stories API: http://localhost:${PORT}/api/stories/user/:username`); // ✅ اضافه شد
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