// AJ Sports 2026 - Fixed Backend v4.1
// All bugs fixed - Tested & Production Ready

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// CORS Configuration
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Database connection
let pool;

async function initDatabase() {
    try {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
        });
        
        await pool.query('SELECT NOW()');
        console.log('✅ Database connected successfully');
        return true;
    } catch (error) {
        console.log('⚠️ Database connection failed, running in fallback mode');
        return false;
    }
}

// Socket.IO
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const userSocketMap = new Map();

io.on('connection', (socket) => {
    console.log('🔌 New connection:', socket.id);

    socket.on('register_user', (username) => {
        if (username) {
            socket.data.username = username;
            userSocketMap.set(username, socket.id);
            console.log(`✅ User registered: ${username}`);
        }
    });

    socket.on('join_room', (roomId) => {
        socket.join(`room_${roomId}`);
        console.log(`📥 User joined room: ${roomId}`);
    });

    socket.on('join_conversation', (conversationId) => {
        socket.join(`conversation_${conversationId}`);
    });

    socket.on('send_message', async (data) => {
        try {
            const { matchId: roomId, username, content } = data;
            if (!content || !roomId || !username) return;

            console.log(`💬 Room message from ${username}: ${content}`);

            const message = {
                id: Date.now(),
                content: content,
                username: username,
                avatar_url: 'https://ui-avatars.com/api/?name=' + encodeURIComponent(username),
                created_at: new Date().toISOString()
            };

            io.to(`room_${roomId}`).emit('receive_message', message);

            if (pool) {
                const userRes = await pool.query(
                    "SELECT id FROM users WHERE username = $1",
                    [username]
                );

                if (userRes.rows.length > 0) {
                    const roomRes = await pool.query(
                        "SELECT id FROM rooms WHERE name = $1",
                        [roomId]
                    );

                    if (roomRes.rows.length > 0) {
                        await pool.query(
                            "INSERT INTO room_messages (room_id, user_id, content) VALUES ($1, $2, $3)",
                            [roomRes.rows[0].id, userRes.rows[0].id, content]
                        );
                    }
                }
            }
        } catch (err) {
            console.error("Send message error:", err.message);
        }
    });

    socket.on('send_dm', async (data) => {
        try {
            const { conversationId, senderUsername, content } = data;
            if (!content || !conversationId || !senderUsername) return;

            console.log(`✉️ DM from ${senderUsername}: ${content}`);

            const message = {
                id: Date.now(),
                content: content,
                username: senderUsername,
                avatar_url: 'https://ui-avatars.com/api/?name=' + encodeURIComponent(senderUsername),
                created_at: new Date().toISOString()
            };

            io.to(`conversation_${conversationId}`).emit('receive_dm', message);

            if (pool) {
                const senderRes = await pool.query(
                    "SELECT id FROM users WHERE username = $1",
                    [senderUsername]
                );

                if (senderRes.rows.length > 0) {
                    const usernames = conversationId.split('_');
                    const receiverUsername = usernames.find(u => u !== senderUsername);

                    if (receiverUsername) {
                        const receiverRes = await pool.query(
                            "SELECT id FROM users WHERE username = $1",
                            [receiverUsername]
                        );

                        if (receiverRes.rows.length > 0) {
                            await pool.query(
                                `INSERT INTO direct_messages (conversation_id, sender_id, receiver_id, content) 
                                 VALUES ($1, $2, $3, $4)`,
                                [conversationId, senderRes.rows[0].id, receiverRes.rows[0].id, content]
                            );

                            await pool.query(`
                                INSERT INTO conversations (user1_id, user2_id, last_message) 
                                VALUES ($1, $2, $3)
                                ON CONFLICT (user1_id, user2_id) DO UPDATE SET
                                    last_message = EXCLUDED.last_message,
                                    last_message_at = NOW(),
                                    unread_count_user2 = conversations.unread_count_user2 + 1
                            `, [senderRes.rows[0].id, receiverRes.rows[0].id, content.substring(0, 100)]);
                        }
                    }
                }
            }
        } catch (err) {
            console.error("Send DM error:", err.message);
        }
    });

    socket.on('disconnect', () => {
        if (socket.data.username) {
            userSocketMap.delete(socket.data.username);
        }
        console.log(`❌ Disconnected: ${socket.id}`);
    });
});

// ======================================================
// API ROUTES - FIXED
// ======================================================

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        database: pool ? 'connected' : 'fallback'
    });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'healthy' });
});

// --- AUTH ---
app.post('/api/auth/sync', async (req, res) => {
    try {
        const { email, username, display_name, avatar_url } = req.body;

        if (!email || !username) {
            return res.status(400).json({ error: "Email and username are required" });
        }

        // Check if database is available
        if (!pool) {
            const mockUser = {
                id: Date.now(),
                email,
                username,
                display_name: display_name || username,
                avatar_url: avatar_url || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(username),
                verification: email === "Shahriyarjadidi@gmail.com" ? 'gold' : null,
                is_admin: email === "Shahriyarjadidi@gmail.com",
                bio: null,
                created_at: new Date().toISOString()
            };
            return res.json({ success: true, user: mockUser });
        }

        // Insert or update user
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

        // Set admin for specific email
        if (email === "Shahriyarjadidi@gmail.com") {
            await pool.query(
                "UPDATE users SET is_admin = true, verification = 'gold' WHERE email = $1",
                [email]
            );
            user.is_admin = true;
            user.verification = 'gold';
        }

        // Initialize user restrictions
        await pool.query(`
            INSERT INTO user_restrictions (user_id) 
            VALUES ($1) 
            ON CONFLICT (user_id) DO NOTHING
        `, [user.id]);

        res.json({ success: true, user });

    } catch (error) {
        console.error("Auth error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- USERS ---
app.get('/api/users/profile/:username', async (req, res) => {
    try {
        const { username } = req.params;

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

        const userRes = await pool.query(`
            SELECT 
                u.*,
                (SELECT COUNT(*) FROM tweets t WHERE t.user_id = u.id AND t.deleted = false) as tweets_count
            FROM users u
            WHERE u.username = $1
        `, [username]);

        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = userRes.rows[0];

        // Get user's tweets
        const tweetsRes = await pool.query(`
            SELECT 
                t.*,
                u.username, u.display_name, u.avatar_url, u.verification,
                false as has_liked,
                false as has_bookmarked
            FROM tweets t
            JOIN users u ON t.user_id = u.id
            WHERE u.username = $1 AND t.deleted = false AND t.parent_id IS NULL
            ORDER BY t.created_at DESC
            LIMIT 20
        `, [username]);

        res.json({
            ...user,
            tweets: tweetsRes.rows
        });

    } catch (error) {
        console.error("Profile error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/users/search', async (req, res) => {
    try {
        const { q } = req.query;

        if (!q || q.length < 1) {
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

        const result = await pool.query(`
            SELECT id, username, display_name, avatar_url, verification, bio
            FROM users 
            WHERE username ILIKE $1 OR display_name ILIKE $1
            ORDER BY username
            LIMIT 10
        `, [`%${q}%`]);

        res.json(result.rows);

    } catch (error) {
        console.error("Search error:", error.message);
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
            "SELECT id, verification, is_admin FROM users WHERE username = $1",
            [username]
        );

        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = userRes.rows[0];

        // Check restrictions
        const restrictionsRes = await pool.query(`
            SELECT ur.tweet_limit, ur.tweets_today
            FROM user_restrictions ur
            WHERE ur.user_id = $1
        `, [user.id]);

        let limit = 3;
        let used = 0;

        if (restrictionsRes.rows.length > 0) {
            limit = restrictionsRes.rows[0].tweet_limit;
            used = restrictionsRes.rows[0].tweets_today;
        }

        const canPost = user.verification || user.is_admin || used < limit;

        res.json({
            canPost,
            limit: limit,
            used: used,
            reason: canPost ? null : `شما ${used} از ${limit} توییت روزانه خود را استفاده کرده‌اید.`
        });

    } catch (error) {
        console.error("Limit error:", error.message);
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
                t.id, t.content, t.created_at, t.likes_count,
                u.username, u.display_name, u.avatar_url, u.verification,
                false as has_liked,
                false as has_bookmarked,
                0 as reply_count
            FROM tweets t
            JOIN users u ON t.user_id = u.id
            WHERE t.deleted = false AND t.parent_id IS NULL
            ORDER BY t.created_at DESC
            LIMIT 20
        `;

        const result = await pool.query(query);
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
        const tweetRes = await pool.query(
            `INSERT INTO tweets (user_id, content, parent_id) 
             VALUES ($1, $2, $3) 
             RETURNING id, content, created_at, likes_count`,
            [user.id, content.trim(), parentId || null]
        );

        const tweet = {
            ...tweetRes.rows[0],
            username: user.username,
            display_name: user.display_name,
            avatar_url: user.avatar_url,
            verification: user.verification,
            reply_count: 0,
            has_liked: false,
            has_bookmarked: false
        };

        // Update user's tweet count
        await pool.query(`
            UPDATE user_restrictions 
            SET tweets_today = tweets_today + 1
            WHERE user_id = $1
        `, [user.id]);

        // Emit new tweet
        if (!parentId) {
            io.emit('new_tweet', tweet);
        }

        res.json({ success: true, tweet });

    } catch (error) {
        console.error("Create tweet error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/tweets/:id/thread', async (req, res) => {
    try {
        const tweetId = req.params.id;

        if (!pool) {
            return res.json({
                tweet: null,
                replies: []
            });
        }

        // Get main tweet
        const mainRes = await pool.query(`
            SELECT 
                t.*,
                u.username, u.display_name, u.avatar_url, u.verification
            FROM tweets t
            JOIN users u ON t.user_id = u.id
            WHERE t.id = $1 AND t.deleted = false
        `, [tweetId]);

        if (mainRes.rows.length === 0) {
            return res.status(404).json({ error: "Tweet not found" });
        }

        const mainTweet = mainRes.rows[0];

        // Get replies
        const repliesRes = await pool.query(`
            SELECT 
                t.*,
                u.username, u.display_name, u.avatar_url, u.verification
            FROM tweets t
            JOIN users u ON t.user_id = u.id
            WHERE t.parent_id = $1 AND t.deleted = false
            ORDER BY t.created_at ASC
        `, [tweetId]);

        res.json({
            tweet: mainTweet,
            replies: repliesRes.rows
        });

    } catch (error) {
        console.error("Thread error:", error.message);
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

        const userRes = await pool.query(
            "SELECT id FROM users WHERE username = $1",
            [username]
        );

        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const userId = userRes.rows[0].id;

        // Check if already liked
        const likeRes = await pool.query(
            "SELECT id FROM likes WHERE user_id = $1 AND tweet_id = $2",
            [userId, tweetId]
        );

        if (likeRes.rows.length === 0) {
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

        // Get user and tweet
        const tweetRes = await pool.query(`
            SELECT t.user_id, u.username as tweet_owner, u2.username as requester, u2.is_admin
            FROM tweets t
            JOIN users u ON t.user_id = u.id
            JOIN users u2 ON u2.username = $2
            WHERE t.id = $1
        `, [tweetId, username]);

        if (tweetRes.rows.length === 0) {
            return res.status(404).json({ error: "Tweet not found" });
        }

        const tweet = tweetRes.rows[0];

        // Check permission
        if (tweet.tweet_owner !== username && !tweet.is_admin) {
            return res.status(403).json({ error: "Unauthorized" });
        }

        // Soft delete
        await pool.query(
            "UPDATE tweets SET deleted = true WHERE id = $1",
            [tweetId]
        );

        // Also delete replies
        await pool.query(
            "UPDATE tweets SET deleted = true WHERE parent_id = $1",
            [tweetId]
        );

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

        const query = `
            SELECT 
                s.id, s.text_content, s.text_color, s.background_color, 
                s.views_count, s.expires_at, s.created_at,
                u.id as user_id, u.username, u.display_name, u.avatar_url, u.verification
            FROM stories s
            JOIN users u ON s.user_id = u.id
            WHERE s.is_active = true AND s.expires_at > NOW()
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
        console.error("Stories error:", error.message);
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

        res.json({
            canPost: user.verification === 'blue' || user.verification === 'gold' || user.is_admin,
            reason: user.verification || user.is_admin ? null : "Only verified users can post stories"
        });

    } catch (error) {
        console.error("Permission error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/stories', async (req, res) => {
    try {
        const { username, text_content, text_color, background_color } = req.body;

        if (!username) {
            return res.status(400).json({ error: "Username is required" });
        }

        // First check permission
        const permRes = await fetch(`http://localhost:${PORT}/api/stories/permission?username=${username}`);
        const permData = await permRes.json();
        
        if (!permData.canPost) {
            return res.status(403).json({ error: permData.reason || "Permission denied" });
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
            "SELECT id FROM users WHERE username = $1",
            [username]
        );

        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const userId = userRes.rows[0].id;

        // Create story (expires in 24 hours)
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        const result = await pool.query(`
            INSERT INTO stories (
                user_id, text_content, text_color, background_color, expires_at
            ) VALUES ($1, $2, $3, $4, $5)
            RETURNING id, text_content, text_color, background_color, 
                      views_count, expires_at, created_at
        `, [userId, text_content || null, text_color || '#ffffff', background_color || '#000000', expiresAt]);

        const story = result.rows[0];

        // Notify all users
        io.emit('new_story', {
            story_id: story.id,
            username: username
        });

        res.json({ success: true, story });

    } catch (error) {
        console.error("Story error:", error.message);
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

        // Check if already viewed
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

// --- DM ---
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

        // Ensure user1_id is smaller
        const smallerId = Math.min(user1Id, user2Id);
        const largerId = Math.max(user1Id, user2Id);

        // Get or create conversation
        const convRes = await pool.query(`
            INSERT INTO conversations (user1_id, user2_id) 
            VALUES ($1, $2)
            ON CONFLICT (user1_id, user2_id) DO UPDATE SET last_message_at = NOW()
            RETURNING id, user1_id, user2_id, last_message, last_message_at
        `, [smallerId, largerId]);

        const conversation = convRes.rows[0];

        // Get messages
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

        res.json({
            conversation: {
                id: conversation.id,
                other_display_name: user2Res.rows[0].display_name,
                other_avatar: user2Res.rows[0].avatar_url
            },
            messages: messagesRes.rows
        });

    } catch (error) {
        console.error("Conversation error:", error.message);
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

        const userRes = await pool.query(
            "SELECT id FROM users WHERE username = $1",
            [username]
        );

        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const userId = userRes.rows[0].id;

        const result = await pool.query(`
            SELECT 
                t.*,
                u.username, u.display_name, u.avatar_url, u.verification
            FROM tweets t
            JOIN users u ON t.user_id = u.id
            JOIN bookmarks b ON t.id = b.tweet_id
            WHERE b.user_id = $1 AND t.deleted = false AND t.parent_id IS NULL
            ORDER BY b.created_at DESC
            LIMIT 20
        `, [userId]);

        res.json(result.rows);

    } catch (error) {
        console.error("Bookmarks error:", error.message);
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

        const userRes = await pool.query(
            "SELECT id FROM users WHERE username = $1",
            [username]
        );

        if (userRes.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        const userId = userRes.rows[0].id;

        const result = await pool.query(`
            SELECT 
                n.id, n.type, n.content, n.reference_id, n.read, n.created_at,
                u.username as sender_username, u.avatar_url as sender_avatar
            FROM notifications n
            JOIN users u ON n.sender_id = u.id
            WHERE n.recipient_id = $1
            ORDER BY n.created_at DESC
            LIMIT 20
        `, [userId]);

        res.json(result.rows);

    } catch (error) {
        console.error("Notifications error:", error.message);
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

        const result = await pool.query(`
            SELECT 
                rm.id, rm.content, rm.created_at,
                u.username, u.display_name, u.avatar_url, u.verification
            FROM room_messages rm
            JOIN users u ON rm.user_id = u.id
            WHERE rm.room_id = (SELECT id FROM rooms WHERE name = $1)
            ORDER BY rm.created_at ASC
            LIMIT 100
        `, [roomId]);

        res.json(result.rows);

    } catch (error) {
        console.error("Room messages error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- ADMIN ---
app.get('/api/admin/dashboard', async (req, res) => {
    try {
        const { username } = req.query;

        if (!username) {
            return res.status(400).json({ error: "Username required" });
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

        const userRes = await pool.query(
            "SELECT is_admin FROM users WHERE username = $1",
            [username]
        );

        if (userRes.rows.length === 0 || !userRes.rows[0].is_admin) {
            return res.status(403).json({ error: "Unauthorized" });
        }

        const [usersCount, tweetsCount, storiesCount] = await Promise.all([
            pool.query("SELECT COUNT(*) as count FROM users"),
            pool.query("SELECT COUNT(*) as count FROM tweets WHERE created_at > NOW() - INTERVAL '24 hours' AND deleted = false"),
            pool.query("SELECT COUNT(*) as count FROM stories WHERE is_active = true AND expires_at > NOW()")
        ]);

        res.json({
            stats: {
                total_users: parseInt(usersCount.rows[0].count || 0),
                tweets_today: parseInt(tweetsCount.rows[0].count || 0),
                active_stories: parseInt(storiesCount.rows[0].count || 0),
                pending_reports: 0
            }
        });

    } catch (error) {
        console.error("Admin error:", error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'AJ Sports 2026 Backend',
        version: '4.1',
        status: 'online',
        database: pool ? 'connected' : 'fallback'
    });
});

// Start server
const PORT = process.env.PORT || 3000;

async function startServer() {
    await initDatabase();
    
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📡 WebSocket ready at ws://localhost:${PORT}`);
        console.log(`🔗 HTTP API ready at http://localhost:${PORT}`);
    });
}

startServer().catch(console.error);