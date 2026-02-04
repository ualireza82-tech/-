/**
 * AJ Sports 2026 - Ultimate Backend v3.0
 * Optimized for Render.com - Zero Dependencies Issues
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// ======================================================
// 1. INITIALIZATION & CONFIGURATION
// ======================================================

const app = express();
const server = http.createServer(app);

// Strict CORS configuration for production
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:8080',
      'https://aj-sports-2026.onrender.com',
      'https://*.onrender.com',
      process.env.FRONTEND_URL
    ].filter(Boolean);
    
    if (!origin || allowedOrigins.indexOf(origin) !== -1 || origin.includes('onrender.com')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint (Render.com needs this)
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'AJ Sports 2026 Backend',
    version: '3.0.0'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: '🚀 AJ Sports 2026 Backend API',
    version: '3.0.0',
    status: 'online',
    environment: process.env.NODE_ENV || 'development',
    endpoints: {
      health: 'GET /health',
      api_health: 'GET /api/health',
      auth: 'POST /api/auth/sync',
      profile: 'GET /api/users/profile/:username',
      tweets: 'GET /api/tweets/feed',
      stories: 'GET /api/stories/active',
      admin: 'GET /api/admin/dashboard',
      docs: 'GET /api/docs'
    },
    documentation: 'Visit /api/docs for API documentation'
  });
});

// ======================================================
// 2. DATABASE CONNECTION (Render.com Optimized)
// ======================================================

let pool;
const MAX_RETRIES = 5;
const RETRY_DELAY = 3000;

async function initializeDatabase() {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      console.log(`🔄 Attempting database connection (Attempt ${i + 1}/${MAX_RETRIES})...`);
      
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: 10, // Lower connection pool for Render.com free tier
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
      });

      // Test connection
      const client = await pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      
      console.log('✅ Database connected successfully!');
      
      // Initialize tables
      await initializeTables();
      return;
      
    } catch (error) {
      console.error(`❌ Database connection failed (Attempt ${i + 1}):`, error.message);
      
      if (i < MAX_RETRIES - 1) {
        console.log(`⏳ Retrying in ${RETRY_DELAY/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        console.error('💥 Failed to connect to database after maximum retries');
        // Don't crash - continue without DB for health checks
      }
    }
  }
}

async function initializeTables() {
  try {
    const client = await pool.connect();
    
    // Create tables if they don't exist
    await client.query(`
      -- Users Table
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        username VARCHAR(50) UNIQUE NOT NULL,
        display_name VARCHAR(100),
        avatar_url TEXT,
        verification VARCHAR(20),
        bio TEXT,
        is_admin BOOLEAN DEFAULT FALSE,
        last_active TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Tweets Table
      CREATE TABLE IF NOT EXISTS tweets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        parent_id INTEGER REFERENCES tweets(id) ON DELETE CASCADE,
        likes_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Stories Table (24-hour Instagram-like stories)
      CREATE TABLE IF NOT EXISTS stories (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        media_url TEXT,
        media_type VARCHAR(10),
        text_content TEXT,
        views_count INTEGER DEFAULT 0,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        is_active BOOLEAN DEFAULT TRUE
      );

      -- Story Views Table
      CREATE TABLE IF NOT EXISTS story_views (
        id SERIAL PRIMARY KEY,
        story_id INTEGER REFERENCES stories(id) ON DELETE CASCADE,
        viewer_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        viewed_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(story_id, viewer_id)
      );

      -- User Restrictions Table
      CREATE TABLE IF NOT EXISTS user_restrictions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        tweet_limit INTEGER DEFAULT 3,
        tweets_today INTEGER DEFAULT 0,
        last_reset_date DATE DEFAULT CURRENT_DATE,
        can_post_story BOOLEAN DEFAULT FALSE,
        is_blocked BOOLEAN DEFAULT FALSE,
        blocked_until TIMESTAMP,
        warning_count INTEGER DEFAULT 0
      );

      -- Reports Table
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        reporter_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        reported_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        reported_tweet_id INTEGER REFERENCES tweets(id) ON DELETE CASCADE,
        report_type VARCHAR(50) NOT NULL,
        description TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Likes Table
      CREATE TABLE IF NOT EXISTS likes (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        tweet_id INTEGER REFERENCES tweets(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, tweet_id)
      );

      -- Follows Table
      CREATE TABLE IF NOT EXISTS follows (
        id SERIAL PRIMARY KEY,
        follower_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        following_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(follower_id, following_id)
      );

      -- Notifications Table
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        reference_id INTEGER,
        read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    console.log('✅ Database tables initialized successfully!');
    client.release();
    
  } catch (error) {
    console.error('❌ Error initializing tables:', error);
  }
}

// Start database initialization (non-blocking)
initializeDatabase();

// ======================================================
// 3. SOCKET.IO SETUP
// ======================================================

const io = new Server(server, {
  cors: {
    origin: function (origin, callback) {
      const allowedOrigins = [
        'http://localhost:3000',
        'http://localhost:5173',
        'https://aj-sports-2026.onrender.com',
        'https://*.onrender.com'
      ];
      
      if (!origin || allowedOrigins.some(allowed => origin.startsWith(allowed))) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

const userSocketMap = new Map();

io.on('connection', (socket) => {
  console.log('🔌 New Socket.IO connection:', socket.id);

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
        
        console.log(`✅ User registered via socket: ${username}`);
      }
    } catch (err) { 
      console.error("Socket registration error:", err.message); 
    }
  });

  socket.on('join_tweet_thread', (tweetId) => {
    socket.join(`tweet_${tweetId}`);
  });

  socket.on('send_tweet_reply', async (data) => {
    try {
      const { tweetId, username, content } = data;
      if (!content || !tweetId || !username) return;
      
      const userRes = await pool.query(
        "SELECT id, display_name, avatar_url FROM users WHERE username = $1", 
        [username]
      );
      
      if (userRes.rows.length > 0) {
        const user = userRes.rows[0];
        const replyRes = await pool.query(
          `INSERT INTO tweets (user_id, content, parent_id) 
           VALUES ($1, $2, $3) 
           RETURNING id, created_at`,
          [user.id, content.trim(), tweetId]
        );

        const reply = {
          id: replyRes.rows[0].id,
          username: username,
          display_name: user.display_name,
          content: content,
          avatar: user.avatar_url,
          created_at: replyRes.rows[0].created_at
        };

        io.to(`tweet_${tweetId}`).emit('new_tweet_reply', reply);
      }
    } catch (err) { 
      console.error("Socket reply error:", err.message); 
    }
  });

  socket.on('disconnect', () => {
    if (socket.data.userId) {
      userSocketMap.delete(socket.data.userId);
    }
    console.log(`❌ Socket disconnected: ${socket.id}`);
  });
});

// ======================================================
// 4. HELPER FUNCTIONS
// ======================================================

async function canUserPostTweet(username) {
  try {
    const userRes = await pool.query(
      `SELECT u.id, u.verification, ur.tweet_limit, ur.tweets_today, ur.is_blocked
       FROM users u
       LEFT JOIN user_restrictions ur ON u.id = ur.user_id
       WHERE u.username = $1`,
      [username]
    );
    
    if (userRes.rows.length === 0) {
      return { canPost: false, reason: 'User not found' };
    }
    
    const user = userRes.rows[0];
    
    if (user.is_blocked) {
      return { canPost: false, reason: 'Account is blocked' };
    }
    
    // Verified users have no limits
    if (user.verification === 'blue' || user.verification === 'gold') {
      return { canPost: true, limit: null, used: null };
    }
    
    // Regular users: check daily limit
    const tweetLimit = user.tweet_limit || 3;
    const tweetsToday = user.tweets_today || 0;
    
    if (tweetsToday >= tweetLimit) {
      return { 
        canPost: false, 
        reason: `Daily limit reached (${tweetLimit} tweets per day)`, 
        limit: tweetLimit, 
        used: tweetsToday 
      };
    }
    
    return { canPost: true, limit: tweetLimit, used: tweetsToday };
  } catch (error) {
    console.error('Error checking tweet permission:', error);
    return { canPost: false, reason: 'System error' };
  }
}

async function canUserPostStory(username) {
  try {
    const userRes = await pool.query(
      `SELECT u.verification, ur.can_post_story
       FROM users u
       LEFT JOIN user_restrictions ur ON u.id = ur.user_id
       WHERE u.username = $1`,
      [username]
    );
    
    if (userRes.rows.length === 0) {
      return { canPost: false, reason: 'User not found' };
    }
    
    const user = userRes.rows[0];
    
    // Only verified users can post stories
    if (user.verification === 'blue' || user.verification === 'gold' || user.can_post_story) {
      return { canPost: true };
    }
    
    return { canPost: false, reason: 'Only verified users can post stories' };
  } catch (error) {
    console.error('Error checking story permission:', error);
    return { canPost: false, reason: 'System error' };
  }
}

async function isAdmin(username) {
  try {
    const res = await pool.query(
      "SELECT is_admin FROM users WHERE username = $1",
      [username]
    );
    return res.rows.length > 0 && res.rows[0].is_admin === true;
  } catch (error) {
    console.error('Error checking admin status:', error);
    return false;
  }
}

// ======================================================
// 5. API ROUTES - SIMPLIFIED & OPTIMIZED
// ======================================================

// API Health Check
app.get('/api/health', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT NOW() as time');
    const storiesCount = await pool.query("SELECT COUNT(*) as active FROM stories WHERE is_active = true");
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      database: {
        connected: true,
        time: dbResult.rows[0].time
      },
      stats: {
        active_stories: parseInt(storiesCount.rows[0].active || 0)
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      database: { connected: false }
    });
  }
});

// API Documentation
app.get('/api/docs', (req, res) => {
  res.json({
    name: 'AJ Sports 2026 API',
    version: '3.0.0',
    description: 'Complete backend API for AJ Sports social platform',
    endpoints: {
      auth: {
        sync: 'POST /api/auth/sync - Register/Login user'
      },
      users: {
        profile: 'GET /api/users/profile/:username - Get user profile',
        update: 'PUT /api/users/update - Update profile',
        search: 'GET /api/users/search - Search users'
      },
      tweets: {
        feed: 'GET /api/tweets/feed - Get tweet feed',
        create: 'POST /api/tweets - Create tweet',
        thread: 'GET /api/tweets/:id/thread - Get tweet thread',
        like: 'POST /api/tweets/:id/like - Like tweet',
        delete: 'DELETE /api/tweets/:id - Delete tweet'
      },
      stories: {
        active: 'GET /api/stories/active - Get active stories',
        create: 'POST /api/stories - Create story',
        view: 'POST /api/stories/:id/view - View story',
        viewers: 'GET /api/stories/:id/viewers - Get story viewers'
      },
      admin: {
        dashboard: 'GET /api/admin/dashboard - Admin dashboard',
        delete_tweet: 'DELETE /api/admin/tweets/:id - Delete user tweet',
        restrict_user: 'POST /api/admin/users/:username/restrict - Restrict user'
      },
      notifications: {
        list: 'GET /api/notifications/:username - Get notifications',
        mark_read: 'POST /api/notifications/:username/mark-read - Mark as read'
      },
      dm: {
        list: 'GET /api/dm/list/:username - Get DM conversations'
      }
    }
  });
});

// --- AUTH & USER MANAGEMENT ---

app.post('/api/auth/sync', async (req, res) => {
  try {
    const { email, username, display_name, avatar_url } = req.body;
    
    if (!email || !username) {
      return res.status(400).json({ error: "Email and username are required" });
    }

    const query = `
      INSERT INTO users (email, username, display_name, avatar_url, last_active)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (email) DO UPDATE SET 
        username = EXCLUDED.username,
        display_name = COALESCE(EXCLUDED.display_name, users.display_name),
        avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
        last_active = NOW()
      RETURNING id, email, username, display_name, avatar_url, verification, bio, is_admin;
    `;
    
    const result = await pool.query(query, [
      email, 
      username, 
      display_name || username,
      avatar_url || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(username)
    ]);
    
    const user = result.rows[0];
    
    // Initialize user restrictions
    await pool.query(`
      INSERT INTO user_restrictions (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
    `, [user.id]);
    
    // Grant admin privileges to specific email
    if (email === "Shahriyarjadidi@gmail.com") {
      await pool.query(
        "UPDATE users SET is_admin = true, verification = 'gold' WHERE email = $1", 
        [email]
      );
      user.is_admin = true;
      user.verification = 'gold';
    }
    
    res.json({ success: true, user });
  } catch (error) {
    console.error("Auth sync error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/users/profile/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    const query = `
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.verification, u.bio, u.created_at,
      (SELECT COUNT(*) FROM follows WHERE following_id = u.id) as followers_count,
      (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) as following_count,
      (SELECT COUNT(*) FROM tweets WHERE user_id = u.id AND parent_id IS NULL) as tweets_count
      FROM users u
      WHERE u.username = $1
    `;
    
    const result = await pool.query(query, [username]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const user = result.rows[0];
    
    // Get user's tweets
    const tweetsQuery = `
      SELECT t.*, u.username, u.display_name, u.avatar_url, u.verification
      FROM tweets t
      JOIN users u ON t.user_id = u.id
      WHERE u.username = $1 AND t.parent_id IS NULL
      ORDER BY t.created_at DESC
      LIMIT 20
    `;
    
    const tweetsResult = await pool.query(tweetsQuery, [username]);

    res.json({ 
      ...user, 
      tweets: tweetsResult.rows
    });
  } catch (error) {
    console.error("Profile error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/users/update', async (req, res) => {
  try {
    const { username, display_name, bio, avatar_url } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: "Username is required" });
    }

    const query = `
      UPDATE users 
      SET display_name = COALESCE($1, display_name), 
          bio = COALESCE($2, bio), 
          avatar_url = COALESCE($3, avatar_url)
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

// --- TWEETS ---

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
        (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count
      FROM tweets t
      JOIN users u ON t.user_id = u.id
      WHERE t.parent_id IS NULL
      ORDER BY t.created_at DESC
      LIMIT 20
    `;
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error("Feed error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/tweets', async (req, res) => {
  try {
    const { username, content, parentId } = req.body;
    
    if (!username || !content || content.trim().length === 0) {
      return res.status(400).json({ error: "Username and content are required" });
    }

    // Check if user can post tweet
    const canPost = await canUserPostTweet(username);
    if (!canPost.canPost) {
      return res.status(403).json({ 
        error: canPost.reason,
        limit: canPost.limit,
        used: canPost.used
      });
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
      has_liked: false
    };

    // Update user's tweet count (for non-verified users)
    if (!user.verification) {
      await pool.query(`
        INSERT INTO user_restrictions (user_id, tweets_today)
        VALUES ($1, 1)
        ON CONFLICT (user_id) DO UPDATE SET
          tweets_today = user_restrictions.tweets_today + 1,
          last_reset_date = CASE 
            WHEN user_restrictions.last_reset_date < CURRENT_DATE THEN CURRENT_DATE 
            ELSE user_restrictions.last_reset_date 
          END
      `, [user.id]);
    }

    // Emit new tweet
    if (!parentId) {
      io.emit('new_tweet', newTweet);
    } else {
      io.emit(`new_reply_${parentId}`, newTweet);
    }
    
    res.json({ success: true, tweet: newTweet });
  } catch (error) {
    console.error("Create tweet error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/tweets/:id/thread', async (req, res) => {
  try {
    const tweetId = req.params.id;
    
    // Get main tweet
    const mainTweetQuery = `
      SELECT 
        t.id, t.content, t.created_at, t.likes_count, t.user_id, t.parent_id,
        u.username, u.display_name, u.avatar_url, u.verification
      FROM tweets t
      JOIN users u ON t.user_id = u.id
      WHERE t.id = $1
    `;
    
    const mainTweetRes = await pool.query(mainTweetQuery, [tweetId]);
    
    if (mainTweetRes.rows.length === 0) {
      return res.status(404).json({ error: "Tweet not found" });
    }
    
    const mainTweet = mainTweetRes.rows[0];

    // Get replies
    const repliesQuery = `
      SELECT 
        t.id, t.content, t.created_at, t.likes_count, t.user_id, t.parent_id,
        u.username, u.display_name, u.avatar_url, u.verification
      FROM tweets t
      JOIN users u ON t.user_id = u.id
      WHERE t.parent_id = $1
      ORDER BY t.created_at ASC
    `;
    
    const replies = await pool.query(repliesQuery, [tweetId]);

    res.json({
      tweet: mainTweet,
      replies: replies.rows
    });
  } catch (error) {
    console.error("Get tweet thread error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/tweets/:id/like', async (req, res) => {
  try {
    const { username } = req.body;
    const tweetId = req.params.id;
    
    if (!username) {
      return res.status(400).json({ error: "Username is required" });
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
      
      res.json({ success: true, action: 'unliked' });
    }
  } catch (error) {
    console.error("Like error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/tweets/:id', async (req, res) => {
  try {
    const tweetId = req.params.id;
    const { username } = req.body; 

    if (!username) {
      return res.status(400).json({ error: "Username is required" });
    }

    const checkOwner = await pool.query(`
      SELECT t.id FROM tweets t 
      JOIN users u ON t.user_id = u.id 
      WHERE t.id = $1 AND u.username = $2
    `, [tweetId, username]);

    if (checkOwner.rows.length === 0) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    await pool.query("DELETE FROM tweets WHERE id = $1", [tweetId]);
    io.emit('tweet_deleted', tweetId);
    res.json({ success: true });
  } catch (error) {
    console.error("Delete tweet error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- STORIES ---

app.post('/api/stories', async (req, res) => {
  try {
    const { username, text_content, media_url } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: "Username is required" });
    }

    // Check if user can post story
    const canPost = await canUserPostStory(username);
    if (!canPost.canPost) {
      return res.status(403).json({ error: canPost.reason });
    }

    // Get user
    const userRes = await pool.query(
      "SELECT id FROM users WHERE username = $1", 
      [username]
    );
    
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const userId = userRes.rows[0].id;

    // Create story (expires in 24 hours)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const mediaType = media_url ? (media_url.includes('video') ? 'video' : 'image') : 'text';
    
    const query = `
      INSERT INTO stories (
        user_id, media_url, media_type, text_content, expires_at
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING id, media_url, media_type, text_content, views_count, expires_at, created_at
    `;
    
    const result = await pool.query(query, [
      userId,
      media_url || null,
      mediaType,
      text_content || null,
      expiresAt
    ]);

    const story = result.rows[0];
    
    // Notify followers
    io.emit('new_story', {
      story_id: story.id,
      user_id: userId,
      username: username
    });

    res.json({ success: true, story });
  } catch (error) {
    console.error("Upload story error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/stories/active', async (req, res) => {
  try {
    const { username } = req.query;
    
    let userId = null;
    if (username) {
      const userRes = await pool.query(
        "SELECT id FROM users WHERE username = $1", 
        [username]
      );
      if (userRes.rows.length > 0) userId = userRes.rows[0].id;
    }

    // Get active stories from followed users
    const query = `
      SELECT 
        s.id, s.media_url, s.media_type, s.text_content, s.views_count,
        s.expires_at, s.created_at,
        u.id as user_id, u.username, u.display_name, u.avatar_url, u.verification
      FROM stories s
      JOIN users u ON s.user_id = u.id
      WHERE s.is_active = true 
        AND s.expires_at > NOW()
      ORDER BY s.created_at DESC
    `;
    
    const result = await pool.query(query);
    
    // Group by user
    const storiesByUser = {};
    result.rows.forEach(story => {
      if (!storiesByUser[story.user_id]) {
        storiesByUser[story.user_id] = {
          user: {
            id: story.user_id,
            username: story.username,
            display_name: story.display_name,
            avatar_url: story.avatar_url,
            verification: story.verification
          },
          stories: []
        };
      }
      storiesByUser[story.user_id].stories.push(story);
    });

    res.json(Object.values(storiesByUser));
  } catch (error) {
    console.error("Get stories error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/stories/:id/view', async (req, res) => {
  try {
    const storyId = req.params.id;
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: "Username is required" });
    }

    // Get user
    const userRes = await pool.query(
      "SELECT id FROM users WHERE username = $1", 
      [username]
    );
    
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const viewerId = userRes.rows[0].id;

    // Check if story exists
    const storyRes = await pool.query(
      "SELECT user_id FROM stories WHERE id = $1 AND is_active = true",
      [storyId]
    );
    
    if (storyRes.rows.length === 0) {
      return res.status(404).json({ error: "Story not found" });
    }
    
    // Record view
    try {
      await pool.query(
        `INSERT INTO story_views (story_id, viewer_id) 
         VALUES ($1, $2) 
         ON CONFLICT DO NOTHING`,
        [storyId, viewerId]
      );

      // Update view count
      await pool.query(
        "UPDATE stories SET views_count = views_count + 1 WHERE id = $1",
        [storyId]
      );

      res.json({ success: true });
    } catch (error) {
      // Ignore duplicate views
      res.json({ success: true });
    }
  } catch (error) {
    console.error("View story error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- ADMIN ---

app.get('/api/admin/dashboard', async (req, res) => {
  try {
    const { username } = req.query;
    
    if (!username || !await isAdmin(username)) {
      return res.status(403).json({ error: "Unauthorized - Admin only" });
    }

    const [
      usersCount,
      tweetsCount,
      storiesCount,
      reportsCount
    ] = await Promise.all([
      pool.query("SELECT COUNT(*) as count FROM users"),
      pool.query("SELECT COUNT(*) as count FROM tweets WHERE created_at > NOW() - INTERVAL '24 hours'"),
      pool.query("SELECT COUNT(*) as count FROM stories WHERE is_active = true"),
      pool.query("SELECT COUNT(*) as count FROM reports WHERE status = 'pending'")
    ]);

    res.json({
      stats: {
        total_users: parseInt(usersCount.rows[0].count || 0),
        tweets_today: parseInt(tweetsCount.rows[0].count || 0),
        active_stories: parseInt(storiesCount.rows[0].count || 0),
        pending_reports: parseInt(reportsCount.rows[0].count || 0)
      }
    });
  } catch (error) {
    console.error("Admin dashboard error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/admin/tweets/:id', async (req, res) => {
  try {
    const tweetId = req.params.id;
    const { adminUsername } = req.body;
    
    if (!adminUsername || !await isAdmin(adminUsername)) {
      return res.status(403).json({ error: "Unauthorized - Admin only" });
    }

    // Delete tweet
    await pool.query("DELETE FROM tweets WHERE id = $1", [tweetId]);
    
    io.emit('tweet_deleted', tweetId);
    
    res.json({ success: true });
  } catch (error) {
    console.error("Admin delete tweet error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/users/:username/restrict', async (req, res) => {
  try {
    const targetUsername = req.params.username;
    const { adminUsername, restrictionType } = req.body;
    
    if (!adminUsername || !await isAdmin(adminUsername)) {
      return res.status(403).json({ error: "Unauthorized - Admin only" });
    }

    // Get target user
    const targetRes = await pool.query(
      "SELECT id FROM users WHERE username = $1", 
      [targetUsername]
    );
    
    if (targetRes.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const targetUserId = targetRes.rows[0].id;

    // Apply restriction
    switch (restrictionType) {
      case 'block':
        await pool.query(`
          INSERT INTO user_restrictions (user_id, is_blocked)
          VALUES ($1, true)
          ON CONFLICT (user_id) DO UPDATE SET is_blocked = true
        `, [targetUserId]);
        break;
        
      case 'limit_tweets':
        await pool.query(`
          INSERT INTO user_restrictions (user_id, tweet_limit)
          VALUES ($1, 1)
          ON CONFLICT (user_id) DO UPDATE SET tweet_limit = 1
        `, [targetUserId]);
        break;
        
      case 'disable_stories':
        await pool.query(`
          INSERT INTO user_restrictions (user_id, can_post_story)
          VALUES ($1, false)
          ON CONFLICT (user_id) DO UPDATE SET can_post_story = false
        `, [targetUserId]);
        break;
    }

    res.json({ success: true, restriction: restrictionType });
  } catch (error) {
    console.error("Admin restrict user error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- NOTIFICATIONS ---

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
        u.username as sender_username, u.avatar_url as sender_avatar
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

// --- DIRECT MESSAGES ---

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
    
    res.json([]); // Simplified for now
  } catch (error) {
    console.error("DM list error:", error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ======================================================
// 6. ERROR HANDLING & STARTUP
// ======================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    path: req.path,
    method: req.method
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('🔥 Server Error:', err.message);
  console.error(err.stack);
  
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Startup
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`📊 API Documentation: http://localhost:${PORT}/api/docs`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('HTTP server closed');
    if (pool) {
      pool.end(() => {
        console.log('Database pool closed');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => {
    console.log('HTTP server closed');
    if (pool) {
      pool.end(() => {
        console.log('Database pool closed');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });
});