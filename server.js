/**
 * AJ Sports 2026 - Ultimate Backend v3.0
 * Complete Backend System with All Features
 * Optimized for Render.com
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

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
            process.env.FRONTEND_URL,
            'https://your-frontend-url.onrender.com',
            'http://127.0.0.1:5500',
            'http://localhost:5500',
            'file://' // Allow file protocol for local testing
        ].filter(Boolean);

        if (!origin || allowedOrigins.includes(origin) || origin.includes('onrender.com') || origin.includes('localhost')) {
            callback(null, true);
        } else {
            console.log('CORS blocked origin:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check endpoint (Render.com needs this)
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'AJ Sports 2026 Backend',
        version: '3.0.0',
        uptime: process.uptime()
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
            users: 'GET /api/users/profile/:username',
            tweets: 'GET /api/tweets/feed',
            stories: 'GET /api/stories/active',
            admin: 'GET /api/admin/dashboard',
            docs: 'GET /api/docs'
        }
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
                connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/ajsports',
                ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
                max: 10,
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
                console.log(`⏳ Retrying in ${RETRY_DELAY / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            } else {
                console.error('💥 Failed to connect to database after maximum retries');
                console.log('⚠️  Starting in limited mode without database');
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
                retweets_count INTEGER DEFAULT 0,
                views_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW()
            );

            -- Stories Table (24-hour Instagram-like stories)
            CREATE TABLE IF NOT EXISTS stories (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                media_url TEXT,
                media_type VARCHAR(10),
                text_content TEXT,
                text_color VARCHAR(20) DEFAULT '#ffffff',
                background_color VARCHAR(20) DEFAULT '#000000',
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

            -- Likes Table
            CREATE TABLE IF NOT EXISTS likes (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                tweet_id INTEGER REFERENCES tweets(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(user_id, tweet_id)
            );

            -- Bookmarks Table
            CREATE TABLE IF NOT EXISTS bookmarks (
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

            -- Direct Messages Table
            CREATE TABLE IF NOT EXISTS direct_messages (
                id SERIAL PRIMARY KEY,
                conversation_id VARCHAR(100) NOT NULL,
                sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW()
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

            -- Rooms Table for Chat
            CREATE TABLE IF NOT EXISTS rooms (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                description TEXT,
                avatar_url TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );

            -- Room Messages Table
            CREATE TABLE IF NOT EXISTS room_messages (
                id SERIAL PRIMARY KEY,
                room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            );

            -- Room Members Table
            CREATE TABLE IF NOT EXISTS room_members (
                id SERIAL PRIMARY KEY,
                room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                joined_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(room_id, user_id)
            );

            -- Create indexes for performance
            CREATE INDEX IF NOT EXISTS idx_tweets_user_id ON tweets(user_id);
            CREATE INDEX IF NOT EXISTS idx_tweets_parent_id ON tweets(parent_id);
            CREATE INDEX IF NOT EXISTS idx_stories_user_id ON stories(user_id);
            CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories(expires_at);
            CREATE INDEX IF NOT EXISTS idx_likes_tweet_id ON likes(tweet_id);
            CREATE INDEX IF NOT EXISTS idx_bookmarks_tweet_id ON bookmarks(tweet_id);
            CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id);
            CREATE INDEX IF NOT EXISTS idx_dm_conversation ON direct_messages(conversation_id);
            CREATE INDEX IF NOT EXISTS idx_room_messages_room ON room_messages(room_id);
        `);

        // Insert default rooms
        await client.query(`
            INSERT INTO rooms (name, description, avatar_url) 
            VALUES 
                ('گروه Ajsports', 'گفتگوی عمومی هواداران ورزشی', 'https://cdn-icons-png.flaticon.com/512/53/53283.png')
            ON CONFLICT DO NOTHING;
        `);

        console.log('✅ Database tables initialized successfully!');
        client.release();

    } catch (error) {
        console.error('❌ Error initializing tables:', error);
    }
}

// Start database initialization
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
                'https://*.onrender.com',
                'http://127.0.0.1:5500',
                'http://localhost:5500',
                'file://'
            ];

            if (!origin || allowedOrigins.some(allowed => origin.startsWith(allowed))) {
                callback(null, true);
            } else {
                console.log('Socket CORS blocked:', origin);
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    path: '/socket.io/',
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

    socket.on('join_conversation', (conversationId) => {
        socket.join(`conversation_${conversationId}`);
    });

    socket.on('join_room', (roomId) => {
        socket.join(`room_${roomId}`);
    });

    socket.on('send_message', async (data) => {
        try {
            const { matchId: roomId, username, content } = data;
            if (!content || !roomId || !username) return;

            // Get user
            const userRes = await pool.query(
                "SELECT id, display_name, avatar_url, verification FROM users WHERE username = $1",
                [username]
            );

            if (userRes.rows.length === 0) return;

            const user = userRes.rows[0];

            // Save to database
            const roomRes = await pool.query(
                "SELECT id FROM rooms WHERE name = $1",
                [roomId]
            );

            if (roomRes.rows.length > 0) {
                const roomIdNum = roomRes.rows[0].id;
                await pool.query(
                    "INSERT INTO room_messages (room_id, user_id, content) VALUES ($1, $2, $3)",
                    [roomIdNum, user.id, content]
                );
            }

            // Broadcast message
            const message = {
                id: Date.now(),
                content: content,
                username: username,
                display_name: user.display_name,
                avatar_url: user.avatar_url,
                verification: user.verification,
                created_at: new Date().toISOString()
            };

            io.to(`room_${roomId}`).emit('receive_message', message);
        } catch (err) {
            console.error("Send message error:", err.message);
        }
    });

    socket.on('send_dm', async (data) => {
        try {
            const { conversationId, senderUsername, content } = data;
            if (!content || !conversationId || !senderUsername) return;

            // Get sender user
            const senderRes = await pool.query(
                "SELECT id, display_name, avatar_url FROM users WHERE username = $1",
                [senderUsername]
            );

            if (senderRes.rows.length === 0) return;

            const sender = senderRes.rows[0];

            // Parse conversation ID to get receiver username
            const usernames = conversationId.split('_');
            const receiverUsername = usernames.find(u => u !== senderUsername);

            if (!receiverUsername) return;

            // Get receiver user
            const receiverRes = await pool.query(
                "SELECT id FROM users WHERE username = $1",
                [receiverUsername]
            );

            if (receiverRes.rows.length === 0) return;

            const receiver = receiverRes.rows[0];

            // Save to database
            await pool.query(
                `INSERT INTO direct_messages (conversation_id, sender_id, receiver_id, content) 
                 VALUES ($1, $2, $3, $4)`,
                [conversationId, sender.id, receiver.id, content]
            );

            // Create notification for receiver
            await createNotification(
                receiver.id,
                sender.id,
                'DM',
                `${sender.display_name || senderUsername} پیامی برای شما ارسال کرد`,
                conversationId
            );

            // Broadcast message
            const message = {
                id: Date.now(),
                content: content,
                username: senderUsername,
                display_name: sender.display_name,
                avatar_url: sender.avatar_url,
                created_at: new Date().toISOString()
            };

            io.to(`conversation_${conversationId}`).emit('receive_dm', message);

            // Notify receiver if online
            const receiverSocketId = Array.from(userSocketMap.entries())
                .find(([id, socketId]) => id === receiver.id)?.[1];
            if (receiverSocketId) {
                io.to(receiverSocketId).emit('notification_alert', {
                    type: 'DM',
                    message: `پیام جدید از ${sender.display_name || senderUsername}`,
                    from: senderUsername
                });
            }

        } catch (err) {
            console.error("Send DM error:", err.message);
        }
    });

    socket.on('send_tweet_reply', async (data) => {
        try {
            const { tweetId, username, content } = data;
            if (!content || !tweetId || !username) return;

            const userRes = await pool.query(
                "SELECT id, display_name, avatar_url, verification FROM users WHERE username = $1",
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
                    avatar_url: user.avatar_url,
                    verification: user.verification,
                    created_at: replyRes.rows[0].created_at
                };

                io.to(`tweet_${tweetId}`).emit('new_tweet_reply', reply);

                // Create notification for tweet owner
                const tweetOwnerRes = await pool.query(
                    "SELECT user_id FROM tweets WHERE id = $1",
                    [tweetId]
                );

                if (tweetOwnerRes.rows.length > 0 && tweetOwnerRes.rows[0].user_id !== user.id) {
                    await createNotification(
                        tweetOwnerRes.rows[0].user_id,
                        user.id,
                        'REPLY',
                        `${user.display_name || username} به توییت شما پاسخ داد`,
                        tweetId
                    );
                }
            }
        } catch (err) {
            console.error("Socket reply error:", err.message);
        }
    });

    socket.on('like_tweet', async (data) => {
        try {
            const { tweetId, username } = data;
            if (!tweetId || !username) return;

            const userRes = await pool.query(
                "SELECT id, display_name FROM users WHERE username = $1",
                [username]
            );

            if (userRes.rows.length === 0) return;

            const user = userRes.rows[0];

            // Check if already liked
            const check = await pool.query(
                "SELECT 1 FROM likes WHERE user_id = $1 AND tweet_id = $2",
                [user.id, tweetId]
            );

            if (check.rows.length === 0) {
                // Like
                await pool.query(
                    "INSERT INTO likes (user_id, tweet_id) VALUES ($1, $2)",
                    [user.id, tweetId]
                );

                await pool.query(
                    "UPDATE tweets SET likes_count = likes_count + 1 WHERE id = $1",
                    [tweetId]
                );

                // Create notification for tweet owner
                const tweetOwnerRes = await pool.query(
                    "SELECT user_id FROM tweets WHERE id = $1",
                    [tweetId]
                );

                if (tweetOwnerRes.rows.length > 0 && tweetOwnerRes.rows[0].user_id !== user.id) {
                    await createNotification(
                        tweetOwnerRes.rows[0].user_id,
                        user.id,
                        'LIKE',
                        `${user.display_name || username} توییت شما را لایک کرد`,
                        tweetId
                    );
                }

                // Emit update
                io.emit('update_tweet_stats', {
                    tweetId,
                    action: 'like_added'
                });
            }

        } catch (err) {
            console.error("Socket like error:", err.message);
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

        // Reset if it's a new day
        if (user.last_reset_date && new Date(user.last_reset_date).toDateString() !== new Date().toDateString()) {
            await pool.query(
                `UPDATE user_restrictions 
                 SET tweets_today = 0, last_reset_date = CURRENT_DATE 
                 WHERE user_id = $1`,
                [user.id]
            );
            return { canPost: true, limit: tweetLimit, used: 0 };
        }

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
            `SELECT u.verification, ur.can_post_story, u.is_admin 
             FROM users u 
             LEFT JOIN user_restrictions ur ON u.id = ur.user_id 
             WHERE u.username = $1`,
            [username]
        );

        if (userRes.rows.length === 0) {
            return { canPost: false, reason: 'User not found' };
        }

        const user = userRes.rows[0];

        // Only verified users and admins can post stories
        if (user.verification === 'blue' || user.verification === 'gold' || user.can_post_story || user.is_admin) {
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

async function createNotification(recipientId, senderId, type, content, referenceId = null) {
    try {
        await pool.query(
            `INSERT INTO notifications (recipient_id, sender_id, type, content, reference_id) 
             VALUES ($1, $2, $3, $4, $5)`,
            [recipientId, senderId, type, content, referenceId]
        );

        // Send real-time notification via socket
        const recipientSocketId = Array.from(userSocketMap.entries())
            .find(([id, socketId]) => id === recipientId)?.[1];
        
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('notification_alert', {
                type,
                message: content,
                from: senderId
            });
        }
    } catch (error) {
        console.error('Error creating notification:', error);
    }
}

// ======================================================
// 5. API ROUTES - COMPLETE IMPLEMENTATION
// ======================================================

// API Health Check
app.get('/api/health', async (req, res) => {
    try {
        const dbResult = await pool.query('SELECT NOW() as time');
        const storiesCount = await pool.query("SELECT COUNT(*) as active FROM stories WHERE is_active = true");
        const usersCount = await pool.query("SELECT COUNT(*) as count FROM users");
        const tweetsCount = await pool.query("SELECT COUNT(*) as count FROM tweets WHERE created_at > NOW() - INTERVAL '24 hours'");

        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development',
            database: {
                connected: true,
                time: dbResult.rows[0].time
            },
            stats: {
                total_users: parseInt(usersCount.rows[0].count || 0),
                tweets_today: parseInt(tweetsCount.rows[0].count || 0),
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
                sync: 'POST /api/auth/sync - Register/Login user',
                verify: 'POST /api/auth/verify-otp - Verify OTP'
            },
            users: {
                profile: 'GET /api/users/profile/:username - Get user profile',
                update: 'PUT /api/users/update - Update profile',
                search: 'GET /api/users/search - Search users',
                limit: 'GET /api/users/:username/limit - Check daily limit'
            },
            tweets: {
                feed: 'GET /api/tweets/feed - Get tweet feed',
                create: 'POST /api/tweets - Create tweet',
                thread: 'GET /api/tweets/:id/thread - Get tweet thread',
                like: 'POST /api/tweets/:id/like - Like tweet',
                delete: 'DELETE /api/tweets/:id - Delete tweet',
                limit: 'GET /api/tweets/limit - Check tweet limit'
            },
            stories: {
                active: 'GET /api/stories/active - Get active stories',
                create: 'POST /api/stories - Create story',
                view: 'POST /api/stories/:id/view - View story',
                permission: 'GET /api/stories/permission - Check story permission'
            },
            notifications: {
                list: 'GET /api/notifications/:username - Get notifications'
            },
            dm: {
                list: 'GET /api/dm/list/:username - Get DM conversations',
                conversation: 'POST /api/dm/conversation - Start conversation'
            },
            bookmarks: {
                list: 'GET /api/bookmarks/:username - Get bookmarks'
            },
            admin: {
                dashboard: 'GET /api/admin/dashboard - Admin dashboard',
                verification: 'POST /api/admin/verification - Grant verification',
                remove_verification: 'POST /api/admin/remove-verification - Remove verification',
                delete_tweet: 'DELETE /api/admin/tweets/:id - Delete user tweet',
                restrict_user: 'POST /api/admin/users/:username/restrict - Restrict user',
                grant_story: 'POST /api/admin/users/:username/grant-story - Grant story permission'
            },
            rooms: {
                messages: 'GET /api/rooms/:id/messages - Get room messages'
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

        // Validate username (English letters, numbers, underscore)
        if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
            return res.status(400).json({ error: "Username must be 3-30 characters and contain only English letters, numbers, and underscore" });
        }

        // Check if username is available
        const usernameCheck = await pool.query(
            "SELECT 1 FROM users WHERE username = $1 AND email != $2",
            [username, email]
        );

        if (usernameCheck.rows.length > 0) {
            return res.status(400).json({ error: "Username already taken" });
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
            avatar_url || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(username) + '&background=random'
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

        // Create welcome notification
        await createNotification(
            user.id,
            1, // System ID
            'WELCOME',
            'به AJ Sports 2026 خوش آمدید!',
            null
        );

        res.json({ success: true, user });

    } catch (error) {
        console.error("Auth sync error:", error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/users/profile/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const me = req.query.me;

        const query = `
            SELECT u.id, u.username, u.display_name, u.avatar_url, u.verification, u.bio, u.created_at,
            (SELECT COUNT(*) FROM follows WHERE following_id = u.id) as followers_count,
            (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) as following_count,
            (SELECT COUNT(*) FROM tweets WHERE user_id = u.id AND parent_id IS NULL) as tweets_count,
            (SELECT COUNT(*) FROM stories WHERE user_id = u.id AND is_active = true AND expires_at > NOW()) as active_stories_count
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
            SELECT t.*, u.username, u.display_name, u.avatar_url, u.verification,
            (SELECT COUNT(*) FROM likes WHERE tweet_id = t.id) as likes_count,
            (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count,
            EXISTS(SELECT 1 FROM likes WHERE tweet_id = t.id AND user_id = (SELECT id FROM users WHERE username = $2)) as has_liked,
            EXISTS(SELECT 1 FROM bookmarks WHERE tweet_id = t.id AND user_id = (SELECT id FROM users WHERE username = $2)) as has_bookmarked
            FROM tweets t
            JOIN users u ON t.user_id = u.id
            WHERE u.username = $1 AND t.parent_id IS NULL
            ORDER BY t.created_at DESC
            LIMIT 20
        `;

        const tweetsResult = await pool.query(tweetsQuery, [username, me || '']);

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

app.get('/api/users/search', async (req, res) => {
    try {
        const { q } = req.query;

        if (!q || q.length < 2) {
            return res.json([]);
        }

        const query = `
            SELECT id, username, display_name, avatar_url, verification, bio
            FROM users 
            WHERE username ILIKE $1 OR display_name ILIKE $1
            ORDER BY 
                CASE 
                    WHEN username ILIKE $1 THEN 1
                    WHEN display_name ILIKE $1 THEN 2
                END,
                username
            LIMIT 20
        `;

        const result = await pool.query(query, [`%${q}%`]);
        res.json(result.rows);

    } catch (error) {
        console.error("Search error:", error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/users/:username/limit', async (req, res) => {
    try {
        const { username } = req.params;

        const query = `
            SELECT 
                u.username,
                u.verification,
                ur.tweet_limit as "limit",
                ur.tweets_today as used,
                ur.last_reset_date,
                ur.is_blocked
            FROM users u
            LEFT JOIN user_restrictions ur ON u.id = ur.user_id
            WHERE u.username = $1
        `;

        const result = await pool.query(query, [username]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const data = result.rows[0];

        // Check if blocked
        if (data.is_blocked) {
            return res.json({
                canPost: false,
                reason: 'حساب شما مسدود شده است',
                limit: data.limit || 3,
                used: data.used || 0,
                verification: data.verification
            });
        }

        // Verified users have no limits
        if (data.verification === 'blue' || data.verification === 'gold') {
            return res.json({
                canPost: true,
                limit: null,
                used: null,
                verification: data.verification
            });
        }

        // Check if we need to reset daily count
        const today = new Date().toISOString().split('T')[0];
        const lastReset = data.last_reset_date ? new Date(data.last_reset_date).toISOString().split('T')[0] : null;

        if (!lastReset || lastReset !== today) {
            // Reset count
            await pool.query(`
                UPDATE user_restrictions 
                SET tweets_today = 0, last_reset_date = CURRENT_DATE
                WHERE user_id = (SELECT id FROM users WHERE username = $1)
            `, [username]);

            return res.json({
                canPost: true,
                limit: data.limit || 3,
                used: 0,
                verification: data.verification
            });
        }

        res.json({
            canPost: data.used < (data.limit || 3),
            limit: data.limit || 3,
            used: data.used || 0,
            verification: data.verification
        });

    } catch (error) {
        console.error("Limit check error:", error);
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
                t.id, t.content, t.created_at, t.likes_count, t.retweets_count, t.views_count,
                t.user_id, t.parent_id,
                u.username, u.display_name, u.avatar_url, u.verification,
                (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count,
                ${userId ? `EXISTS(SELECT 1 FROM likes WHERE tweet_id = t.id AND user_id = ${userId}) as has_liked,` : ''}
                ${userId ? `EXISTS(SELECT 1 FROM bookmarks WHERE tweet_id = t.id AND user_id = ${userId}) as has_bookmarked,` : ''}
                (SELECT COUNT(*) FROM likes WHERE tweet_id = t.id) as likes_count
            FROM tweets t
            JOIN users u ON t.user_id = u.id
            WHERE t.parent_id IS NULL
            ORDER BY t.created_at DESC
            LIMIT 50
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
             RETURNING id, content, created_at, likes_count, retweets_count, views_count`,
            [user.id, cleanContent, parentId || null]
        );

        const newTweet = {
            ...insertRes.rows[0],
            username: user.username,
            display_name: user.display_name,
            avatar_url: user.avatar_url,
            verification: user.verification,
            reply_count: 0,
            has_liked: false,
            has_bookmarked: false
        };

        // Update user's tweet count (for non-verified users)
        if (!user.verification) {
            await pool.query(`
                INSERT INTO user_restrictions (user_id, tweets_today, last_reset_date)
                VALUES ($1, 1, CURRENT_DATE)
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
            
            // Create notifications for mentioned users
            const mentionRegex = /@([a-zA-Z0-9_]+)/g;
            let match;
            while ((match = mentionRegex.exec(cleanContent)) !== null) {
                const mentionedUsername = match[1];
                const mentionedUserRes = await pool.query(
                    "SELECT id FROM users WHERE username = $1",
                    [mentionedUsername]
                );
                
                if (mentionedUserRes.rows.length > 0 && mentionedUserRes.rows[0].id !== user.id) {
                    await createNotification(
                        mentionedUserRes.rows[0].id,
                        user.id,
                        'MENTION',
                        `${user.display_name || username} شما را در توییتی نام برد`,
                        newTweet.id
                    );
                }
            }
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
        const me = req.query.me;

        // Get main tweet
        const mainTweetQuery = `
            SELECT 
                t.id, t.content, t.created_at, t.likes_count, t.retweets_count, t.views_count,
                t.user_id, t.parent_id,
                u.username, u.display_name, u.avatar_url, u.verification,
                (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count,
                ${me ? `EXISTS(SELECT 1 FROM likes WHERE tweet_id = t.id AND user_id = (SELECT id FROM users WHERE username = '${me}')) as has_liked,` : ''}
                (SELECT COUNT(*) FROM likes WHERE tweet_id = t.id) as likes_count
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
                t.id, t.content, t.created_at, t.likes_count, t.retweets_count, t.views_count,
                t.user_id, t.parent_id,
                u.username, u.display_name, u.avatar_url, u.verification,
                (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count,
                ${me ? `EXISTS(SELECT 1 FROM likes WHERE tweet_id = t.id AND user_id = (SELECT id FROM users WHERE username = '${me}')) as has_liked,` : ''}
                (SELECT COUNT(*) FROM likes WHERE tweet_id = t.id) as likes_count
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
            "SELECT id, display_name FROM users WHERE username = $1",
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
            const tweetOwnerRes = await pool.query(
                "SELECT user_id FROM tweets WHERE id = $1",
                [tweetId]
            );

            if (tweetOwnerRes.rows.length > 0 && tweetOwnerRes.rows[0].user_id !== userId) {
                await createNotification(
                    tweetOwnerRes.rows[0].user_id,
                    userId,
                    'LIKE',
                    `${user.rows[0].display_name || username} توییت شما را لایک کرد`,
                    tweetId
                );
            }

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
            // Check if admin
            const isUserAdmin = await isAdmin(username);
            if (!isUserAdmin) {
                return res.status(403).json({ error: "Unauthorized" });
            }
        }

        await pool.query("DELETE FROM tweets WHERE id = $1", [tweetId]);
        io.emit('tweet_deleted', tweetId);
        res.json({ success: true });

    } catch (error) {
        console.error("Delete tweet error:", error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/tweets/limit', async (req, res) => {
    try {
        const { username } = req.query;

        if (!username) {
            return res.status(400).json({ error: 'Username is required' });
        }

        const result = await canUserPostTweet(username);
        res.json(result);

    } catch (error) {
        console.error("Tweet limit error:", error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- STORIES ---

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

        // Get active stories from all users
        const query = `
            SELECT 
                s.id, s.media_url, s.media_type, s.text_content, s.text_color, s.background_color, 
                s.views_count, s.expires_at, s.created_at,
                u.id as user_id, u.username, u.display_name, u.avatar_url, u.verification,
                ${userId ? `EXISTS(SELECT 1 FROM story_views WHERE story_id = s.id AND viewer_id = ${userId}) as has_viewed` : 'false as has_viewed'}
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

app.post('/api/stories', async (req, res) => {
    try {
        const { username, text_content, media_url, text_color, background_color } = req.body;

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
                user_id, media_url, media_type, text_content, text_color, background_color, expires_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id, media_url, media_type, text_content, text_color, background_color, 
                      views_count, expires_at, created_at
        `;

        const result = await pool.query(query, [
            userId,
            media_url || null,
            mediaType,
            text_content || null,
            text_color || '#ffffff',
            background_color || '#000000',
            expiresAt
        ]);

        const story = result.rows[0];

        // Notify all users
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
            "SELECT user_id FROM stories WHERE id = $1 AND is_active = true AND expires_at > NOW()",
            [storyId]
        );

        if (storyRes.rows.length === 0) {
            return res.status(404).json({ error: "Story not found or expired" });
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

app.get('/api/stories/permission', async (req, res) => {
    try {
        const { username } = req.query;

        if (!username) {
            return res.status(400).json({ error: 'Username is required' });
        }

        const result = await canUserPostStory(username);
        res.json(result);

    } catch (error) {
        console.error("Story permission error:", error);
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
                u.username as sender_username, u.avatar_url as sender_avatar,
                u.display_name as sender_display_name, u.verification as sender_verification
            FROM notifications n
            JOIN users u ON n.sender_id = u.id
            WHERE n.recipient_id = $1
            ORDER BY n.created_at DESC
            LIMIT 50
        `;

        const result = await pool.query(query, [userId]);

        // Mark as read
        await pool.query(
            "UPDATE notifications SET read = true WHERE recipient_id = $1 AND read = false",
            [userId]
        );

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

        const userId = user.rows[0].id;

        // Get all conversations for this user
        const query = `
            SELECT DISTINCT ON (conversation_id)
                dm.conversation_id,
                dm.content as last_message,
                dm.created_at as updated_at,
                dm.read,
                CASE 
                    WHEN dm.sender_id = $1 THEN dm.receiver_id
                    ELSE dm.sender_id
                END as other_user_id,
                other.username as other_user,
                other.display_name as other_display_name,
                other.avatar_url as other_avatar,
                (SELECT COUNT(*) FROM direct_messages 
                 WHERE conversation_id = dm.conversation_id 
                 AND receiver_id = $1 
                 AND read = false) as unread_count
            FROM direct_messages dm
            JOIN users other ON 
                (CASE 
                    WHEN dm.sender_id = $1 THEN dm.receiver_id
                    ELSE dm.sender_id
                END) = other.id
            WHERE dm.sender_id = $1 OR dm.receiver_id = $1
            ORDER BY dm.conversation_id, dm.created_at DESC
        `;

        const result = await pool.query(query, [userId]);
        res.json(result.rows);

    } catch (error) {
        console.error("DM list error:", error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/dm/conversation', async (req, res) => {
    try {
        const { username1, username2 } = req.body;

        if (!username1 || !username2) {
            return res.status(400).json({ error: "Both usernames are required" });
        }

        // Get users
        const user1Res = await pool.query(
            "SELECT id, display_name, avatar_url, verification FROM users WHERE username = $1",
            [username1]
        );

        const user2Res = await pool.query(
            "SELECT id, display_name, avatar_url, verification FROM users WHERE username = $1",
            [username2]
        );

        if (user1Res.rows.length === 0 || user2Res.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user1 = user1Res.rows[0];
        const user2 = user2Res.rows[0];

        // Create conversation ID (sorted usernames)
        const usernames = [username1, username2].sort();
        const conversationId = usernames.join('_');

        // Get existing messages
        const messagesQuery = `
            SELECT dm.*, 
                   sender.username as sender_username,
                   sender.display_name as sender_display_name,
                   sender.avatar_url as sender_avatar,
                   sender.verification as sender_verification
            FROM direct_messages dm
            JOIN users sender ON dm.sender_id = sender.id
            WHERE dm.conversation_id = $1
            ORDER BY dm.created_at ASC
            LIMIT 100
        `;

        const messages = await pool.query(messagesQuery, [conversationId]);

        // Mark messages as read
        await pool.query(`
            UPDATE direct_messages 
            SET read = true 
            WHERE conversation_id = $1 
            AND receiver_id = $2
        `, [conversationId, user1.id]);

        res.json({
            conversation: {
                id: conversationId,
                other_user: username2,
                other_display_name: user2.display_name,
                other_avatar: user2.avatar_url,
                other_verification: user2.verification,
                updated_at: new Date().toISOString()
            },
            messages: messages.rows
        });

    } catch (error) {
        console.error("DM conversation error:", error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- BOOKMARKS ---

app.get('/api/bookmarks/:username', async (req, res) => {
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
                t.*,
                u.username, u.display_name, u.avatar_url, u.verification,
                (SELECT COUNT(*) FROM likes WHERE tweet_id = t.id) as likes_count,
                (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count,
                EXISTS(SELECT 1 FROM likes WHERE tweet_id = t.id AND user_id = $1) as has_liked,
                true as has_bookmarked
            FROM tweets t
            JOIN users u ON t.user_id = u.id
            JOIN bookmarks b ON t.id = b.tweet_id
            WHERE b.user_id = $1 AND t.parent_id IS NULL
            ORDER BY b.created_at DESC
            LIMIT 50
        `;

        const result = await pool.query(query, [userId]);
        res.json(result.rows);

    } catch (error) {
        console.error("Bookmarks error:", error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- ROOMS ---

app.get('/api/rooms/:id/messages', async (req, res) => {
    try {
        const roomId = req.params.id;

        const query = `
            SELECT 
                rm.*,
                u.username, u.display_name, u.avatar_url, u.verification
            FROM room_messages rm
            JOIN users u ON rm.user_id = u.id
            WHERE rm.room_id = (SELECT id FROM rooms WHERE name = $1)
            ORDER BY rm.created_at ASC
            LIMIT 100
        `;

        const result = await pool.query(query, [roomId]);
        res.json(result.rows);

    } catch (error) {
        console.error("Room messages error:", error);
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
            reportsCount,
            activeUsers
        ] = await Promise.all([
            pool.query("SELECT COUNT(*) as count FROM users"),
            pool.query("SELECT COUNT(*) as count FROM tweets WHERE created_at > NOW() - INTERVAL '24 hours'"),
            pool.query("SELECT COUNT(*) as count FROM stories WHERE is_active = true"),
            pool.query("SELECT COUNT(*) as count FROM reports WHERE status = 'pending'"),
            pool.query("SELECT COUNT(*) as count FROM users WHERE last_active > NOW() - INTERVAL '1 hour'")
        ]);

        res.json({
            stats: {
                total_users: parseInt(usersCount.rows[0].count || 0),
                tweets_today: parseInt(tweetsCount.rows[0].count || 0),
                active_stories: parseInt(storiesCount.rows[0].count || 0),
                pending_reports: parseInt(reportsCount.rows[0].count || 0),
                active_users: parseInt(activeUsers.rows[0].count || 0)
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

app.post('/api/admin/verification', async (req, res) => {
    try {
        const { adminUsername, targetUsername, type } = req.body;

        if (!adminUsername || !await isAdmin(adminUsername)) {
            return res.status(403).json({ error: "Unauthorized - Admin only" });
        }

        if (!['blue', 'gold'].includes(type)) {
            return res.status(400).json({ error: "Invalid verification type" });
        }

        const query = `
            UPDATE users 
            SET verification = $1
            WHERE username = $2
            RETURNING username, display_name, verification
        `;

        const result = await pool.query(query, [type, targetUsername]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        // Create notification for user
        const targetUserRes = await pool.query(
            "SELECT id FROM users WHERE username = $1",
            [targetUsername]
        );

        if (targetUserRes.rows.length > 0) {
            const adminUserRes = await pool.query(
                "SELECT id, display_name FROM users WHERE username = $1",
                [adminUsername]
            );

            if (adminUserRes.rows.length > 0) {
                await createNotification(
                    targetUserRes.rows[0].id,
                    adminUserRes.rows[0].id,
                    'VERIFICATION',
                    `تبریک! شما تیک ${type === 'blue' ? 'آبی' : 'طلایی'} دریافت کردید.`,
                    null
                );
            }
        }

        res.json({
            success: true,
            user: result.rows[0]
        });

    } catch (error) {
        console.error("Admin verification error:", error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/admin/remove-verification', async (req, res) => {
    try {
        const { adminUsername, targetUsername } = req.body;

        if (!adminUsername || !await isAdmin(adminUsername)) {
            return res.status(403).json({ error: "Unauthorized - Admin only" });
        }

        const query = `
            UPDATE users 
            SET verification = NULL
            WHERE username = $1
            RETURNING username, display_name, verification
        `;

        const result = await pool.query(query, [targetUsername]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        res.json({
            success: true,
            user: result.rows[0]
        });

    } catch (error) {
        console.error("Remove verification error:", error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/admin/users/:username/grant-story', async (req, res) => {
    try {
        const targetUsername = req.params.username;
        const { adminUsername } = req.body;

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

        // Grant story permission
        await pool.query(`
            INSERT INTO user_restrictions (user_id, can_post_story)
            VALUES ($1, true)
            ON CONFLICT (user_id) DO UPDATE SET can_post_story = true
        `, [targetUserId]);

        res.json({ success: true });

    } catch (error) {
        console.error("Grant story permission error:", error);
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
    console.log(`📡 WebSocket: ws://localhost:${PORT}/socket.io/`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log(`📊 API Documentation: http://localhost:${PORT}/api/docs`);
    console.log(`💾 Database: ${pool ? 'Connected' : 'Not connected'}`);
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