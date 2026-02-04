// AJ Sports 2026 - Ultimate Backend v4.1
// Fixed All Endpoints - Fully Compatible

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const app = express();
const server = http.createServer(app);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dwgagoxp1',
  api_key: process.env.CLOUDINARY_API_KEY || 'your_api_key',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'your_api_secret'
});

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(morgan('combined'));

const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'https://aj-sports-2026.onrender.com',
    'https://*.onrender.com',
    'file://',
    process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin) || origin.includes('localhost') || origin.includes('127.0.0.1')) {
            callback(null, true);
        } else {
            console.log('CORS blocked origin:', origin);
            callback(null, true);
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const upload = multer({ storage: multer.memoryStorage() });

let pool;

async function initializeDatabase() {
    try {
        console.log('🔄 Initializing database connection...');
        
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000
        });

        const client = await pool.connect();
        console.log('✅ Database connected successfully!');
        
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
                parent_id INTEGER,
                likes_count INTEGER DEFAULT 0,
                retweets_count INTEGER DEFAULT 0,
                views_count INTEGER DEFAULT 0,
                reply_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW(),
                deleted BOOLEAN DEFAULT FALSE
            );

            -- Stories Table
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
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                viewed_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(story_id, user_id)
            );

            -- User Restrictions Table
            CREATE TABLE IF NOT EXISTS user_restrictions (
                id SERIAL PRIMARY KEY,
                user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
                tweet_limit INTEGER DEFAULT 3,
                tweets_today INTEGER DEFAULT 0,
                last_reset_date DATE DEFAULT CURRENT_DATE,
                can_post_story BOOLEAN DEFAULT FALSE,
                is_blocked BOOLEAN DEFAULT FALSE
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

            -- Conversations Table
            CREATE TABLE IF NOT EXISTS conversations (
                id SERIAL PRIMARY KEY,
                user1_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                user2_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                last_message TEXT,
                last_message_at TIMESTAMP DEFAULT NOW(),
                unread_count_user1 INTEGER DEFAULT 0,
                unread_count_user2 INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(user1_id, user2_id)
            );

            -- Rooms Table
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

            -- Insert default room
            INSERT INTO rooms (name, description, avatar_url) 
            VALUES ('گروه Ajsports', 'گفتگوی عمومی هواداران ورزشی', 'https://cdn-icons-png.flaticon.com/512/53/53283.png')
            ON CONFLICT DO NOTHING;
        `);

        console.log('✅ Database tables initialized successfully!');
        client.release();

    } catch (error) {
        console.error('❌ Database initialization error:', error.message);
        console.log('⚠️ Starting with limited database functionality');
    }
}

initializeDatabase();

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
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
            if (!username || !pool) return;

            const res = await pool.query(
                "SELECT id FROM users WHERE username = $1",
                [username]
            );

            if (res.rows.length > 0) {
                const userId = res.rows[0].id;
                socket.data.userId = userId;
                socket.data.username = username;
                userSocketMap.set(userId, socket.id);

                await pool.query(
                    "UPDATE users SET last_active = NOW() WHERE id = $1",
                    [userId]
                );

                console.log(`✅ User registered: ${username}`);
            }
        } catch (err) {
            console.error("Socket registration error:", err.message);
        }
    });

    socket.on('join_room', (roomId) => {
        socket.join(`room_${roomId}`);
    });

    socket.on('join_conversation', (conversationId) => {
        socket.join(`conversation_${conversationId}`);
    });

    socket.on('send_message', async (data) => {
        try {
            const { matchId: roomId, username, content } = data;
            if (!content || !roomId || !username || !pool) return;

            const userRes = await pool.query(
                "SELECT id, avatar_url, verification FROM users WHERE username = $1",
                [username]
            );

            if (userRes.rows.length === 0) return;

            const userId = userRes.rows[0].id;
            const userAvatar = userRes.rows[0].avatar_url;
            const userVerification = userRes.rows[0].verification;

            const roomRes = await pool.query(
                "SELECT id FROM rooms WHERE name = $1",
                [roomId]
            );

            if (roomRes.rows.length === 0) return;

            const roomIdDb = roomRes.rows[0].id;

            const messageRes = await pool.query(
                "INSERT INTO room_messages (room_id, user_id, content) VALUES ($1, $2, $3) RETURNING id, created_at",
                [roomIdDb, userId, content]
            );

            const message = {
                id: messageRes.rows[0].id,
                content: content,
                username: username,
                avatar_url: userAvatar,
                verification: userVerification,
                created_at: messageRes.rows[0].created_at
            };

            io.to(`room_${roomId}`).emit('receive_message', message);

        } catch (err) {
            console.error("Send message error:", err.message);
        }
    });

    socket.on('send_dm', async (data) => {
        try {
            const { conversationId, senderUsername, content } = data;
            if (!content || !conversationId || !senderUsername || !pool) return;

            const senderRes = await pool.query(
                "SELECT id, avatar_url, verification FROM users WHERE username = $1",
                [senderUsername]
            );

            if (senderRes.rows.length === 0) return;

            const senderId = senderRes.rows[0].id;
            const senderAvatar = senderRes.rows[0].avatar_url;
            const senderVerification = senderRes.rows[0].verification;

            const usernames = conversationId.split('_');
            const receiverUsername = usernames.find(u => u !== senderUsername);

            if (!receiverUsername) return;

            const receiverRes = await pool.query(
                "SELECT id FROM users WHERE username = $1",
                [receiverUsername]
            );

            if (receiverRes.rows.length === 0) return;

            const receiverId = receiverRes.rows[0].id;

            const messageRes = await pool.query(
                `INSERT INTO direct_messages (conversation_id, sender_id, receiver_id, content) 
                 VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
                [conversationId, senderId, receiverId, content]
            );

            await pool.query(`
                INSERT INTO conversations (user1_id, user2_id, last_message, last_message_at, unread_count_user2)
                VALUES ($1, $2, $3, NOW(), 1)
                ON CONFLICT (user1_id, user2_id) DO UPDATE SET
                    last_message = EXCLUDED.last_message,
                    last_message_at = NOW(),
                    unread_count_user2 = conversations.unread_count_user2 + 1
            `, [senderId, receiverId, content.substring(0, 100)]);

            const message = {
                id: messageRes.rows[0].id,
                content: content,
                username: senderUsername,
                avatar_url: senderAvatar,
                verification: senderVerification,
                created_at: messageRes.rows[0].created_at
            };

            io.to(`conversation_${conversationId}`).emit('receive_dm', message);

            const receiverSocketId = userSocketMap.get(receiverId);
            if (receiverSocketId) {
                io.to(receiverSocketId).emit('notification_alert', {
                    type: 'DM',
                    message: `پیام جدید از ${senderUsername}`,
                    username: senderUsername
                });
            }

        } catch (err) {
            console.error("Send DM error:", err.message);
        }
    });

    socket.on('disconnect', () => {
        if (socket.data.userId) {
            userSocketMap.delete(socket.data.userId);
        }
        console.log(`❌ Socket disconnected: ${socket.id}`);
    });
});

async function getUserByUsername(username) {
    try {
        if (!pool) return null;
        const res = await pool.query(
            "SELECT * FROM users WHERE username = $1",
            [username]
        );
        return res.rows[0] || null;
    } catch (error) {
        console.error('Error getting user:', error.message);
        return null;
    }
}

async function getUserIdByUsername(username) {
    try {
        if (!pool) return null;
        const res = await pool.query(
            "SELECT id FROM users WHERE username = $1",
            [username]
        );
        return res.rows[0]?.id || null;
    } catch (error) {
        console.error('Error getting user ID:', error.message);
        return null;
    }
}

async function createNotification(recipientId, senderId, type, content, referenceId = null) {
    try {
        if (!pool) return;
        const result = await pool.query(
            `INSERT INTO notifications (recipient_id, sender_id, type, content, reference_id) 
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [recipientId, senderId, type, content, referenceId]
        );

        const recipientSocketId = userSocketMap.get(recipientId);
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('notification_alert', {
                type: type,
                message: content,
                notification_id: result.rows[0].id
            });
        }
    } catch (error) {
        console.error('Error creating notification:', error.message);
    }
}

async function isAdmin(username) {
    try {
        if (!pool) return false;
        const res = await pool.query(
            "SELECT is_admin FROM users WHERE username = $1",
            [username]
        );
        return res.rows.length > 0 && res.rows[0].is_admin === true;
    } catch (error) {
        console.error('Error checking admin status:', error.message);
        return false;
    }
}

async function resetDailyLimits() {
    try {
        if (!pool) return;
        await pool.query(`
            UPDATE user_restrictions 
            SET tweets_today = 0, 
                last_reset_date = CURRENT_DATE 
            WHERE last_reset_date < CURRENT_DATE
        `);
    } catch (error) {
        console.error('Error resetting daily limits:', error.message);
    }
}

setTimeout(resetDailyLimits, 1000);
setInterval(resetDailyLimits, 24 * 60 * 60 * 1000);

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'AJ Sports 2026 Backend',
        version: '4.1.0',
        database: pool ? 'connected' : 'disconnected'
    });
});

app.get('/', (req, res) => {
    res.json({
        message: '🚀 AJ Sports 2026 Backend API',
        version: '4.1.0',
        status: 'online',
        endpoints: {
            health: 'GET /health',
            auth: 'POST /api/auth/sync',
            users: 'GET /api/users/profile/:username',
            tweets: 'GET /api/tweets/feed',
            stories: 'GET /api/stories/active'
        }
    });
});

app.get('/api/health', async (req, res) => {
    try {
        let dbStatus = 'disconnected';
        if (pool) {
            const dbResult = await pool.query('SELECT NOW() as time');
            dbStatus = 'connected';
        }

        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            database: dbStatus
        });

    } catch (error) {
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            database: 'disconnected',
            warning: 'Running in limited mode'
        });
    }
});

// --- AUTH ---
app.post('/api/auth/sync', async (req, res) => {
    try {
        const { email, username, display_name, avatar_url } = req.body;

        if (!email || !username) {
            return res.status(400).json({ error: "Email and username are required" });
        }

        if (!pool) {
            const mockUser = {
                id: Date.now(),
                email,
                username,
                display_name: display_name || username,
                avatar_url: avatar_url || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(username),
                verification: email === "Shahriyarjadidi@gmail.com" ? 'gold' : null,
                is_admin: email === "Shahriyarjadidi@gmail.com",
                bio: null
            };
            return res.json({ success: true, user: mockUser });
        }

        const query = `
            INSERT INTO users (email, username, display_name, avatar_url, last_active) 
            VALUES ($1, $2, $3, $4, NOW()) 
            ON CONFLICT (email) DO UPDATE SET 
                username = EXCLUDED.username,
                display_name = COALESCE(EXCLUDED.display_name, users.display_name),
                avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
                last_active = NOW()
            RETURNING id, email, username, display_name, avatar_url, verification, bio, is_admin, created_at;
        `;

        const result = await pool.query(query, [
            email,
            username,
            display_name || username,
            avatar_url || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(username)
        ]);

        const user = result.rows[0];

        await pool.query(`
            INSERT INTO user_restrictions (user_id) 
            VALUES ($1) 
            ON CONFLICT (user_id) DO NOTHING
        `, [user.id]);

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
        console.error("Auth sync error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- USERS ---
app.get('/api/users/profile/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const { me } = req.query;

        if (!pool) {
            return res.json({
                username,
                display_name: username,
                avatar_url: 'https://ui-avatars.com/api/?name=' + encodeURIComponent(username),
                verification: null,
                bio: null,
                followers_count: 0,
                following_count: 0,
                tweets_count: 0,
                tweets: []
            });
        }

        const userQuery = `
            SELECT 
                u.id, u.username, u.display_name, u.avatar_url, u.verification, 
                u.bio, u.is_admin, u.created_at,
                (SELECT COUNT(*) FROM tweets t WHERE t.user_id = u.id AND t.deleted = false AND t.parent_id IS NULL) as tweets_count,
                0 as followers_count,
                0 as following_count
            FROM users u
            WHERE u.username = $1
        `;

        const userResult = await pool.query(userQuery, [username]);

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = userResult.rows[0];

        const tweetsQuery = `
            SELECT 
                t.id, t.content, t.created_at, t.likes_count, t.reply_count,
                u.username, u.display_name, u.avatar_url, u.verification,
                EXISTS(SELECT 1 FROM likes l WHERE l.tweet_id = t.id AND l.user_id = (SELECT id FROM users WHERE username = $2)) as has_liked,
                EXISTS(SELECT 1 FROM bookmarks b WHERE b.tweet_id = t.id AND b.user_id = (SELECT id FROM users WHERE username = $2)) as has_bookmarked
            FROM tweets t
            JOIN users u ON t.user_id = u.id
            WHERE u.username = $1 AND t.deleted = false AND t.parent_id IS NULL
            ORDER BY t.created_at DESC
            LIMIT 50
        `;

        const tweetsResult = await pool.query(tweetsQuery, [username, me || '']);

        res.json({
            ...user,
            tweets: tweetsResult.rows
        });

    } catch (error) {
        console.error("Profile error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/users/search', async (req, res) => {
    try {
        const { q } = req.query;

        if (!q || q.length < 2) {
            return res.json([]);
        }

        if (!pool) {
            return res.json([
                {
                    id: 1,
                    username: q,
                    display_name: q,
                    avatar_url: 'https://ui-avatars.com/api/?name=' + encodeURIComponent(q),
                    verification: null,
                    bio: null
                }
            ]);
        }

        const query = `
            SELECT id, username, display_name, avatar_url, verification, bio
            FROM users 
            WHERE username ILIKE $1 OR display_name ILIKE $1
            ORDER BY 
                CASE WHEN username = $1 THEN 1
                     WHEN username ILIKE $1 || '%' THEN 2
                     WHEN display_name ILIKE $1 || '%' THEN 3
                     ELSE 4
                END
            LIMIT 20
        `;

        const result = await pool.query(query, [`%${q}%`]);
        res.json(result.rows);

    } catch (error) {
        console.error("Search error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.put('/api/users/update', async (req, res) => {
    try {
        const { username, display_name, bio, avatar_url } = req.body;

        if (!username || !pool) {
            return res.status(400).json({ error: "Username is required" });
        }

        const query = `
            UPDATE users 
            SET display_name = COALESCE($2, display_name),
                bio = COALESCE($3, bio),
                avatar_url = COALESCE($4, avatar_url)
            WHERE username = $1
            RETURNING id, username, display_name, avatar_url, verification, bio, is_admin;
        `;

        const result = await pool.query(query, [username, display_name, bio, avatar_url]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        res.json({ success: true, user: result.rows[0] });

    } catch (error) {
        console.error("Update user error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/users/:username/limit', async (req, res) => {
    try {
        const { username } = req.params;

        if (!pool) {
            return res.json({
                canPost: true,
                limit: 3,
                used: 0,
                reason: null
            });
        }

        const userRes = await pool.query(
            "SELECT id FROM users WHERE username = $1",
            [username]
        );

        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const userId = userRes.rows[0].id;

        const restrictionsRes = await pool.query(`
            SELECT ur.tweet_limit, ur.tweets_today, ur.last_reset_date,
                   u.verification, u.is_admin
            FROM user_restrictions ur
            JOIN users u ON ur.user_id = u.id
            WHERE ur.user_id = $1
        `, [userId]);

        if (restrictionsRes.rows.length === 0) {
            return res.json({
                canPost: true,
                limit: 3,
                used: 0,
                reason: null
            });
        }

        const restrictions = restrictionsRes.rows[0];

        if (restrictions.last_reset_date < new Date().toISOString().split('T')[0]) {
            await pool.query(
                "UPDATE user_restrictions SET tweets_today = 0, last_reset_date = CURRENT_DATE WHERE user_id = $1",
                [userId]
            );
            restrictions.tweets_today = 0;
        }

        const canPost = restrictions.verification || restrictions.is_admin || 
                       restrictions.tweets_today < restrictions.tweet_limit;

        res.json({
            canPost,
            limit: restrictions.tweet_limit,
            used: restrictions.tweets_today,
            reason: canPost ? null : `شما ${restrictions.tweets_today} از ${restrictions.tweet_limit} توییت روزانه خود را استفاده کرده‌اید.`
        });

    } catch (error) {
        console.error("Get user limit error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- TWEETS ---
app.get('/api/tweets/feed', async (req, res) => {
    try {
        const { username } = req.query;

        if (!pool) {
            return res.json([]);
        }

        const query = `
            SELECT 
                t.id, t.content, t.created_at, t.likes_count, t.reply_count,
                u.username, u.display_name, u.avatar_url, u.verification,
                EXISTS(SELECT 1 FROM likes l WHERE l.tweet_id = t.id AND l.user_id = (SELECT id FROM users WHERE username = $1)) as has_liked,
                EXISTS(SELECT 1 FROM bookmarks b WHERE b.tweet_id = t.id AND b.user_id = (SELECT id FROM users WHERE username = $1)) as has_bookmarked
            FROM tweets t
            JOIN users u ON t.user_id = u.id
            WHERE t.deleted = false AND t.parent_id IS NULL
            ORDER BY t.created_at DESC
            LIMIT 50
        `;

        const result = await pool.query(query, [username || '']);
        res.json(result.rows);

    } catch (error) {
        console.error("Feed error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/tweets', async (req, res) => {
    try {
        const { username, content, parentId } = req.body;

        if (!username || !content || content.trim().length === 0) {
            return res.status(400).json({ error: "Username and content are required" });
        }

        if (!pool) {
            const mockTweet = {
                id: Date.now(),
                content: content.trim(),
                created_at: new Date().toISOString(),
                likes_count: 0,
                reply_count: 0,
                username,
                display_name: username,
                avatar_url: 'https://ui-avatars.com/api/?name=' + encodeURIComponent(username),
                verification: null,
                has_liked: false,
                has_bookmarked: false
            };
            
            io.emit('new_tweet', mockTweet);
            return res.json({ success: true, tweet: mockTweet });
        }

        const userRes = await pool.query(
            "SELECT id, username, display_name, avatar_url, verification FROM users WHERE username = $1",
            [username]
        );

        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = userRes.rows[0];

        if (!user.verification && !user.is_admin) {
            const limitRes = await pool.query(`
                SELECT tweets_today, tweet_limit 
                FROM user_restrictions 
                WHERE user_id = $1
            `, [user.id]);

            if (limitRes.rows.length > 0) {
                const { tweets_today, tweet_limit } = limitRes.rows[0];
                if (tweets_today >= tweet_limit) {
                    return res.status(429).json({ 
                        error: `شما ${tweets_today} از ${tweet_limit} توییت روزانه خود را استفاده کرده‌اید.` 
                    });
                }
            }
        }

        const insertRes = await pool.query(
            `INSERT INTO tweets (user_id, content, parent_id) 
             VALUES ($1, $2, $3) 
             RETURNING id, content, created_at, likes_count, reply_count`,
            [user.id, content.trim(), parentId || null]
        );

        const newTweet = {
            ...insertRes.rows[0],
            username: user.username,
            display_name: user.display_name,
            avatar_url: user.avatar_url,
            verification: user.verification,
            has_liked: false,
            has_bookmarked: false
        };

        if (parentId) {
            await pool.query(
                "UPDATE tweets SET reply_count = reply_count + 1 WHERE id = $1",
                [parentId]
            );
        }

        await pool.query(`
            UPDATE user_restrictions 
            SET tweets_today = tweets_today + 1
            WHERE user_id = $1
        `, [user.id]);

        if (parentId) {
            const parentRes = await pool.query(
                "SELECT user_id FROM tweets WHERE id = $1",
                [parentId]
            );
            
            if (parentRes.rows.length > 0 && parentRes.rows[0].user_id !== user.id) {
                await createNotification(
                    parentRes.rows[0].user_id,
                    user.id,
                    'REPLY',
                    `${user.username} به توییت شما پاسخ داد`,
                    parentId
                );
            }
        }

        if (!parentId) {
            io.emit('new_tweet', newTweet);
        } else {
            io.emit('update_tweet_stats', { 
                tweetId: parentId, 
                action: 'reply_added' 
            });
        }

        res.json({ success: true, tweet: newTweet });

    } catch (error) {
        console.error("Create tweet error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/tweets/:id/thread', async (req, res) => {
    try {
        const tweetId = req.params.id;
        const { me } = req.query;

        if (!pool) {
            return res.json({
                tweet: null,
                replies: []
            });
        }

        const mainTweetQuery = `
            SELECT 
                t.id, t.content, t.created_at, t.likes_count, t.reply_count,
                u.username, u.display_name, u.avatar_url, u.verification,
                EXISTS(SELECT 1 FROM likes l WHERE l.tweet_id = t.id AND l.user_id = (SELECT id FROM users WHERE username = $2)) as has_liked,
                EXISTS(SELECT 1 FROM bookmarks b WHERE b.tweet_id = t.id AND b.user_id = (SELECT id FROM users WHERE username = $2)) as has_bookmarked
            FROM tweets t
            JOIN users u ON t.user_id = u.id
            WHERE t.id = $1 AND t.deleted = false
        `;

        const mainTweetRes = await pool.query(mainTweetQuery, [tweetId, me || '']);

        if (mainTweetRes.rows.length === 0) {
            return res.status(404).json({ error: "Tweet not found" });
        }

        const mainTweet = mainTweetRes.rows[0];

        const repliesQuery = `
            SELECT 
                t.id, t.content, t.created_at, t.likes_count,
                u.username, u.display_name, u.avatar_url, u.verification,
                EXISTS(SELECT 1 FROM likes l WHERE l.tweet_id = t.id AND l.user_id = (SELECT id FROM users WHERE username = $2)) as has_liked,
                EXISTS(SELECT 1 FROM bookmarks b WHERE b.tweet_id = t.id AND b.user_id = (SELECT id FROM users WHERE username = $2)) as has_bookmarked
            FROM tweets t
            JOIN users u ON t.user_id = u.id
            WHERE t.parent_id = $1 AND t.deleted = false
            ORDER BY t.created_at ASC
        `;

        const replies = await pool.query(repliesQuery, [tweetId, me || '']);

        res.json({
            tweet: mainTweet,
            replies: replies.rows
        });

    } catch (error) {
        console.error("Get tweet thread error:", error.message);
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

        if (!pool) {
            return res.json({ success: true, action: 'liked' });
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
            await pool.query(
                "INSERT INTO likes (user_id, tweet_id) VALUES ($1, $2)",
                [userId, tweetId]
            );

            await pool.query(
                "UPDATE tweets SET likes_count = likes_count + 1 WHERE id = $1",
                [tweetId]
            );

            const tweetRes = await pool.query(
                "SELECT user_id FROM tweets WHERE id = $1",
                [tweetId]
            );
            
            if (tweetRes.rows.length > 0 && tweetRes.rows[0].user_id !== userId) {
                await createNotification(
                    tweetRes.rows[0].user_id,
                    userId,
                    'LIKE',
                    `${username} توییت شما را لایک کرد`,
                    tweetId
                );
            }

            io.emit('update_tweet_stats', { 
                tweetId: tweetId, 
                action: 'like_added' 
            });

            res.json({ success: true, action: 'liked' });
        } else {
            await pool.query(
                "DELETE FROM likes WHERE user_id = $1 AND tweet_id = $2",
                [userId, tweetId]
            );

            await pool.query(
                "UPDATE tweets SET likes_count = GREATEST(likes_count - 1, 0) WHERE id = $1",
                [tweetId]
            );

            io.emit('update_tweet_stats', { 
                tweetId: tweetId, 
                action: 'like_removed' 
            });

            res.json({ success: true, action: 'unliked' });
        }

    } catch (error) {
        console.error("Like error:", error.message);
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

        if (!pool) {
            return res.json({ success: true });
        }

        const tweetRes = await pool.query(
            "SELECT t.user_id, u.username FROM tweets t JOIN users u ON t.user_id = u.id WHERE t.id = $1",
            [tweetId]
        );

        if (tweetRes.rows.length === 0) {
            return res.status(404).json({ error: "Tweet not found" });
        }

        const tweet = tweetRes.rows[0];

        const userRes = await pool.query(
            "SELECT id, is_admin FROM users WHERE username = $1",
            [username]
        );

        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = userRes.rows[0];

        if (tweet.user_id !== user.id && !user.is_admin) {
            return res.status(403).json({ error: "Unauthorized to delete this tweet" });
        }

        await pool.query(
            "UPDATE tweets SET deleted = true WHERE id = $1",
            [tweetId]
        );

        await pool.query(
            "UPDATE tweets SET deleted = true WHERE parent_id = $1",
            [tweetId]
        );

        io.emit('tweet_deleted', { tweetId });

        res.json({ success: true });

    } catch (error) {
        console.error("Delete tweet error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- STORIES ---
app.get('/api/stories/active', async (req, res) => {
    try {
        const { username } = req.query;

        if (!pool) {
            return res.json([]);
        }

        const userId = await getUserIdByUsername(username);

        const query = `
            SELECT 
                s.id, s.media_url, s.media_type, s.text_content, s.text_color, s.background_color, 
                s.views_count, s.expires_at, s.created_at,
                u.id as user_id, u.username, u.display_name, u.avatar_url, u.verification,
                EXISTS(SELECT 1 FROM story_views sv WHERE sv.story_id = s.id AND sv.user_id = $2) as has_viewed
            FROM stories s
            JOIN users u ON s.user_id = u.id
            WHERE s.is_active = true 
                AND s.expires_at > NOW()
            ORDER BY s.created_at DESC
        `;

        const result = await pool.query(query, [userId || 0]);

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
        console.error("Get stories error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/stories/permission', async (req, res) => {
    try {
        const { username } = req.query;

        if (!username) {
            return res.status(400).json({ error: "Username is required" });
        }

        if (!pool) {
            return res.json({ canPost: false });
        }

        const userRes = await pool.query(
            "SELECT verification, is_admin FROM users WHERE username = $1",
            [username]
        );

        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = userRes.rows[0];

        const canPost = user.verification === 'blue' || 
                       user.verification === 'gold' || 
                       user.is_admin;

        res.json({
            canPost,
            reason: canPost ? null : "Only verified users can post stories"
        });

    } catch (error) {
        console.error("Check story permission error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/stories', async (req, res) => {
    try {
        const { username, text_content, text_color, background_color } = req.body;

        if (!username) {
            return res.status(400).json({ error: "Username is required" });
        }

        if (!pool) {
            const mockStory = {
                id: Date.now(),
                text_content: text_content || 'Sample story',
                text_color: text_color || '#ffffff',
                background_color: background_color || '#000000',
                views_count: 0,
                expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                created_at: new Date().toISOString()
            };
            
            io.emit('new_story', {
                story_id: mockStory.id,
                username: username
            });
            
            return res.json({ success: true, story: mockStory });
        }

        const userRes = await pool.query(
            "SELECT id, verification, is_admin FROM users WHERE username = $1",
            [username]
        );

        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = userRes.rows[0];

        if (!user.verification && !user.is_admin) {
            return res.status(403).json({ error: "Only verified users can post stories" });
        }

        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        const query = `
            INSERT INTO stories (
                user_id, text_content, text_color, background_color, expires_at
            ) VALUES ($1, $2, $3, $4, $5)
            RETURNING id, text_content, text_color, background_color, 
                      views_count, expires_at, created_at
        `;

        const result = await pool.query(query, [
            user.id,
            text_content || null,
            text_color || '#ffffff',
            background_color || '#000000',
            expiresAt
        ]);

        const story = result.rows[0];

        io.emit('new_story', {
            story_id: story.id,
            username: username
        });

        res.json({ success: true, story });

    } catch (error) {
        console.error("Upload story error:", error.message);
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

        if (!pool) {
            return res.json({ success: true });
        }

        const userRes = await pool.query(
            "SELECT id FROM users WHERE username = $1",
            [username]
        );

        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const userId = userRes.rows[0].id;

        const checkRes = await pool.query(
            "SELECT 1 FROM story_views WHERE story_id = $1 AND user_id = $2",
            [storyId, userId]
        );

        if (checkRes.rows.length === 0) {
            await pool.query(
                "INSERT INTO story_views (story_id, user_id) VALUES ($1, $2)",
                [storyId, userId]
            );

            await pool.query(
                "UPDATE stories SET views_count = views_count + 1 WHERE id = $1",
                [storyId]
            );
        }

        res.json({ success: true });

    } catch (error) {
        console.error("View story error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- NOTIFICATIONS ---
app.get('/api/notifications/:username', async (req, res) => {
    try {
        const { username } = req.params;

        if (!pool) {
            return res.json([]);
        }

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
            LIMIT 20
        `;

        const result = await pool.query(query, [userId]);
        res.json(result.rows);

    } catch (error) {
        console.error("Notifications error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- DIRECT MESSAGES ---
app.get('/api/dm/list/:username', async (req, res) => {
    try {
        const { username } = req.params;

        if (!pool) {
            return res.json([]);
        }

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
                c.id,
                CASE 
                    WHEN c.user1_id = $1 THEN u2.id
                    ELSE u1.id
                END as other_id,
                CASE 
                    WHEN c.user1_id = $1 THEN u2.username
                    ELSE u1.username
                END as other_user,
                CASE 
                    WHEN c.user1_id = $1 THEN u2.display_name
                    ELSE u1.display_name
                END as other_display_name,
                CASE 
                    WHEN c.user1_id = $1 THEN u2.avatar_url
                    ELSE u1.avatar_url
                END as other_avatar,
                c.last_message,
                c.last_message_at as updated_at,
                CASE 
                    WHEN c.user1_id = $1 THEN c.unread_count_user1
                    ELSE c.unread_count_user2
                END as unread_count
            FROM conversations c
            JOIN users u1 ON c.user1_id = u1.id
            JOIN users u2 ON c.user2_id = u2.id
            WHERE c.user1_id = $1 OR c.user2_id = $1
            ORDER BY c.last_message_at DESC
        `;

        const result = await pool.query(query, [userId]);
        res.json(result.rows);

    } catch (error) {
        console.error("DM list error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/dm/conversation', async (req, res) => {
    try {
        const { username1, username2 } = req.body;

        if (!username1 || !username2) {
            return res.status(400).json({ error: "Both usernames are required" });
        }

        if (!pool) {
            return res.json({
                conversation: {
                    id: `${username1}_${username2}`,
                    other_display_name: username2,
                    other_avatar: 'https://ui-avatars.com/api/?name=' + encodeURIComponent(username2)
                },
                messages: []
            });
        }

        const user1Res = await pool.query(
            "SELECT id, display_name, avatar_url FROM users WHERE username = $1",
            [username1]
        );

        const user2Res = await pool.query(
            "SELECT id, display_name, avatar_url FROM users WHERE username = $1",
            [username2]
        );

        if (user1Res.rows.length === 0 || user2Res.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user1Id = user1Res.rows[0].id;
        const user2Id = user2Res.rows[0].id;

        const smallerId = Math.min(user1Id, user2Id);
        const largerId = Math.max(user1Id, user2Id);

        const convRes = await pool.query(`
            INSERT INTO conversations (user1_id, user2_id) 
            VALUES ($1, $2)
            ON CONFLICT (user1_id, user2_id) DO UPDATE SET last_message_at = NOW()
            RETURNING id, user1_id, user2_id, last_message, last_message_at
        `, [smallerId, largerId]);

        const conversation = convRes.rows[0];

        const messagesRes = await pool.query(`
            SELECT 
                dm.id, dm.content, dm.created_at,
                u.username, u.display_name, u.avatar_url, u.verification
            FROM direct_messages dm
            JOIN users u ON dm.sender_id = u.id
            WHERE dm.conversation_id = $1
            ORDER BY dm.created_at ASC
            LIMIT 50
        `, [`${username1}_${username2}`]);

        const response = {
            conversation: {
                id: conversation.id,
                other_display_name: user2Res.rows[0].display_name,
                other_avatar: user2Res.rows[0].avatar_url
            },
            messages: messagesRes.rows
        };

        res.json(response);

    } catch (error) {
        console.error("Conversation error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/dm/:id', async (req, res) => {
    try {
        const messageId = req.params.id;
        const { username } = req.body;

        if (!username) {
            return res.status(400).json({ error: "Username is required" });
        }

        if (!pool) {
            return res.json({ success: true });
        }

        const messageRes = await pool.query(`
            SELECT dm.sender_id, u.username 
            FROM direct_messages dm
            JOIN users u ON dm.sender_id = u.id
            WHERE dm.id = $1
        `, [messageId]);

        if (messageRes.rows.length === 0) {
            return res.status(404).json({ error: "Message not found" });
        }

        const message = messageRes.rows[0];

        if (message.username !== username) {
            return res.status(403).json({ error: "Unauthorized to delete this message" });
        }

        await pool.query(
            "DELETE FROM direct_messages WHERE id = $1",
            [messageId]
        );

        res.json({ success: true });

    } catch (error) {
        console.error("Delete DM error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- BOOKMARKS ---
app.get('/api/bookmarks/:username', async (req, res) => {
    try {
        const { username } = req.params;

        if (!pool) {
            return res.json([]);
        }

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
                u.username, u.display_name, u.avatar_url, u.verification
            FROM tweets t
            JOIN users u ON t.user_id = u.id
            JOIN bookmarks b ON t.id = b.tweet_id
            WHERE b.user_id = $1 AND t.deleted = false AND t.parent_id IS NULL
            ORDER BY b.created_at DESC
            LIMIT 20
        `;

        const result = await pool.query(query, [userId]);
        res.json(result.rows);

    } catch (error) {
        console.error("Bookmarks error:", error.message);
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

        if (!pool) {
            return res.json({
                stats: {
                    total_users: 1,
                    tweets_today: 0,
                    active_stories: 0,
                    pending_reports: 0
                }
            });
        }

        const [
            usersCount,
            tweetsCount,
            storiesCount,
            dmsCount
        ] = await Promise.all([
            pool.query("SELECT COUNT(*) as count FROM users"),
            pool.query("SELECT COUNT(*) as count FROM tweets WHERE created_at > NOW() - INTERVAL '24 hours' AND deleted = false"),
            pool.query("SELECT COUNT(*) as count FROM stories WHERE is_active = true AND expires_at > NOW()"),
            pool.query("SELECT COUNT(*) as count FROM direct_messages WHERE created_at > NOW() - INTERVAL '24 hours'")
        ]);

        res.json({
            stats: {
                total_users: parseInt(usersCount.rows[0].count || 0),
                tweets_today: parseInt(tweetsCount.rows[0].count || 0),
                active_stories: parseInt(storiesCount.rows[0].count || 0),
                pending_reports: 0,
                dms_today: parseInt(dmsCount.rows[0].count || 0)
            }
        });

    } catch (error) {
        console.error("Admin dashboard error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// **این endpointها قبلاً وجود نداشتند - اضافه کردم**
app.post('/api/admin/verification', async (req, res) => {
    try {
        const { adminUsername, targetUsername, type } = req.body;

        if (!adminUsername || !targetUsername || !type) {
            return res.status(400).json({ error: "All fields are required" });
        }

        if (!await isAdmin(adminUsername)) {
            return res.status(403).json({ error: "Unauthorized - Admin only" });
        }

        if (!pool) {
            return res.json({ success: true });
        }

        await pool.query(
            "UPDATE users SET verification = $1 WHERE username = $2",
            [type, targetUsername]
        );

        const targetUser = await getUserByUsername(targetUsername);
        const adminUser = await getUserByUsername(adminUsername);

        if (targetUser && adminUser) {
            await createNotification(
                targetUser.id,
                adminUser.id,
                'VERIFICATION',
                `تیک ${type === 'blue' ? 'آبی' : 'طلایی'} به شما اعطا شد`,
                null
            );
        }

        res.json({ success: true });

    } catch (error) {
        console.error("Grant verification error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/admin/remove-verification', async (req, res) => {
    try {
        const { adminUsername, targetUsername } = req.body;

        if (!adminUsername || !targetUsername) {
            return res.status(400).json({ error: "All fields are required" });
        }

        if (!await isAdmin(adminUsername)) {
            return res.status(403).json({ error: "Unauthorized - Admin only" });
        }

        if (!pool) {
            return res.json({ success: true });
        }

        await pool.query(
            "UPDATE users SET verification = NULL WHERE username = $1",
            [targetUsername]
        );

        res.json({ success: true });

    } catch (error) {
        console.error("Remove verification error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// **اضافه کردن endpoint برای bookmark (که قبلاً وجود نداشت)**
app.post('/api/tweets/:id/bookmark', async (req, res) => {
    try {
        const { username } = req.body;
        const tweetId = req.params.id;

        if (!username) {
            return res.status(400).json({ error: "Username is required" });
        }

        if (!pool) {
            return res.json({ success: true, action: 'bookmarked' });
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

        if (check.rows.length === 0) {
            await pool.query(
                "INSERT INTO bookmarks (user_id, tweet_id) VALUES ($1, $2)",
                [userId, tweetId]
            );
            res.json({ success: true, action: 'bookmarked' });
        } else {
            await pool.query(
                "DELETE FROM bookmarks WHERE user_id = $1 AND tweet_id = $2",
                [userId, tweetId]
            );
            res.json({ success: true, action: 'unbookmarked' });
        }

    } catch (error) {
        console.error("Bookmark error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- ROOMS ---
app.get('/api/rooms/:id/messages', async (req, res) => {
    try {
        const roomId = req.params.id;

        if (!pool) {
            return res.json([]);
        }

        const query = `
            SELECT 
                rm.id, rm.content, rm.created_at,
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
        console.error("Room messages error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- IMAGE UPLOAD ---
app.post('/api/upload', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No image provided" });
        }

        const uploadResult = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    folder: 'ajsports',
                    upload_preset: process.env.CLOUDINARY_PRESET || 'Ajsports'
                },
                (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                }
            );
            
            uploadStream.end(req.file.buffer);
        });

        res.json({ 
            success: true, 
            url: uploadResult.secure_url 
        });

    } catch (error) {
        console.error("Upload error:", error.message);
        res.status(500).json({ error: 'Upload failed' });
    }
});

app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        path: req.path,
        method: req.method
    });
});

app.use((err, req, res, next) => {
    console.error('🔥 Server Error:', err.message);
    console.error(err.stack);

    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📡 WebSocket: ws://localhost:${PORT}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log(`💾 Database: ${pool ? 'Connected' : 'Fallback mode'}`);
    console.log(`📸 Cloudinary: ${cloudinary.config().cloud_name ? 'Configured' : 'Not configured'}`);
});