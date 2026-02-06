// AJ Sports 2026 - Complete Backend v4.5 (FINAL WORKING EDITION)
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
});

// Socket.io
const io = new Server(server, {
    cors: { origin: "*", credentials: true },
    transports: ['websocket', 'polling']
});

// ==================== INITIALIZE DATABASE ====================
async function initializeDatabase() {
    try {
        console.log("📦 Initializing database tables...");
        
        // Stories Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stories (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                text_content TEXT NOT NULL,
                text_color VARCHAR(20) DEFAULT '#ffffff',
                background_color VARCHAR(20) DEFAULT '#000000',
                media_url TEXT,
                media_type VARCHAR(20),
                views_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW(),
                expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours'
            );
        `);
        
        // Admin Actions Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admin_actions (
                id SERIAL PRIMARY KEY,
                admin_username VARCHAR(100) NOT NULL,
                target_username VARCHAR(100) NOT NULL,
                action_type VARCHAR(50) NOT NULL,
                action_details JSONB,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        
        // User Permissions Table
        await pool.query(`
            ALTER TABLE users 
            ADD COLUMN IF NOT EXISTS can_post_story BOOLEAN DEFAULT false,
            ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;
        `);
        
        console.log("✅ Database initialized successfully");
    } catch (error) {
        console.error("❌ Database initialization error:", error.message);
    }
}

// ==================== API ROUTES ====================

// Health Check
app.get('/', (req, res) => {
    res.json({
        message: 'AJ Sports 2026 Backend API',
        version: '4.5.0',
        status: 'online',
        features: ['stories', 'admin_panel', 'real_time_messages', 'verification_system'],
        timestamp: new Date().toISOString()
    });
});

// ==================== STORIES SYSTEM ====================

// Get Active Stories
app.get('/api/stories/active', async (req, res) => {
    try {
        const { username } = req.query;
        
        console.log("📸 Fetching active stories...");
        
        const query = `
            SELECT s.*, 
                   u.username, 
                   u.display_name, 
                   u.avatar_url, 
                   u.verification
            FROM stories s
            JOIN users u ON s.user_id = u.id
            WHERE s.expires_at > NOW()
            ORDER BY s.created_at DESC
            LIMIT 50
        `;
        
        const result = await pool.query(query);
        
        // Group stories by user
        const storiesByUser = [];
        const userMap = new Map();
        
        result.rows.forEach(story => {
            const userId = story.user_id;
            
            if (!userMap.has(userId)) {
                userMap.set(userId, {
                    user: {
                        id: userId,
                        username: story.username,
                        display_name: story.display_name,
                        avatar_url: story.avatar_url,
                        verification: story.verification
                    },
                    stories: []
                });
            }
            
            userMap.get(userId).stories.push({
                id: story.id,
                text_content: story.text_content,
                text_color: story.text_color,
                background_color: story.background_color,
                views_count: story.views_count,
                created_at: story.created_at,
                expires_at: story.expires_at
            });
        });
        
        userMap.forEach(value => {
            storiesByUser.push(value);
        });
        
        console.log(`✅ Found ${storiesByUser.length} users with stories`);
        res.json(storiesByUser);
        
    } catch (error) {
        console.error("❌ Get stories error:", error);
        res.json([]);
    }
});

// Create Story - ULTRA SIMPLE WORKING VERSION
app.post('/api/stories', async (req, res) => {
    try {
        const { username, text_content, text_color, background_color } = req.body;
        
        console.log('📸 Creating story for:', username);
        
        // Validate input
        if (!username || !text_content || text_content.trim() === '') {
            return res.status(400).json({ 
                success: false,
                error: "نام کاربری و متن الزامی هستند" 
            });
        }
        
        const cleanText = text_content.trim();
        
        // Get user
        const userResult = await pool.query(
            "SELECT id FROM users WHERE username = $1",
            [username]
        );
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ 
                success: false,
                error: "کاربر یافت نشد" 
            });
        }
        
        const userId = userResult.rows[0].id;
        
        // Insert story
        const storyResult = await pool.query(`
            INSERT INTO stories (user_id, text_content, text_color, background_color)
            VALUES ($1, $2, $3, $4)
            RETURNING id, text_content, text_color, background_color, 
                     views_count, created_at, expires_at
        `, [userId, cleanText, text_color || '#ffffff', background_color || '#000000']);
        
        const story = storyResult.rows[0];
        
        // Get user details for response
        const userDetails = await pool.query(
            "SELECT username, display_name, avatar_url, verification FROM users WHERE id = $1",
            [userId]
        );
        
        const response = {
            ...story,
            username: userDetails.rows[0].username,
            display_name: userDetails.rows[0].display_name,
            avatar_url: userDetails.rows[0].avatar_url,
            verification: userDetails.rows[0].verification
        };
        
        // Emit socket event for real-time update
        if (io) {
            io.emit('new_story', {
                ...response,
                user: {
                    username: userDetails.rows[0].username,
                    display_name: userDetails.rows[0].display_name,
                    avatar_url: userDetails.rows[0].avatar_url
                }
            });
            
            // Send notification
            io.emit('notification_alert', {
                type: 'NEW_STORY',
                username: username,
                message: `${userDetails.rows[0].display_name} یک استوری جدید ارسال کرد`
            });
        }
        
        console.log('✅ Story created successfully:', story.id);
        
        res.json({
            success: true,
            story: response,
            message: "استوری با موفقیت ارسال شد"
        });
        
    } catch (error) {
        console.error("❌ Create story error:", error);
        
        res.status(500).json({
            success: false,
            error: "خطا در ارسال استوری",
            details: error.message
        });
    }
});

// Check Story Permission
app.get('/api/stories/permission', async (req, res) => {
    try {
        const { username } = req.query;
        
        if (!username) {
            return res.json({
                canPost: false,
                reason: "نام کاربری مشخص نشده"
            });
        }
        
        const result = await pool.query(`
            SELECT verification, can_post_story 
            FROM users 
            WHERE username = $1
        `, [username]);
        
        if (result.rows.length === 0) {
            return res.json({
                canPost: false,
                reason: "کاربر یافت نشد"
            });
        }
        
        const user = result.rows[0];
        
        // قوانین مجوز استوری
        let canPost = false;
        let reason = "";
        
        if (user.can_post_story) {
            canPost = true;
            reason = "دارای مجوز ویژه استوری";
        } else if (user.verification === 'gold' || user.verification === 'blue') {
            canPost = true;
            reason = "کاربر تاییدشده";
        } else {
            canPost = false;
            reason = "فقط کاربران تاییدشده (تیک آبی/طلایی) یا دارای مجوز ویژه می‌توانند استوری ارسال کنند";
        }
        
        res.json({
            canPost,
            reason,
            verification: user.verification,
            hasSpecialPermission: user.can_post_story
        });
        
    } catch (error) {
        console.error("❌ Check permission error:", error);
        res.json({
            canPost: false,
            reason: "خطا در بررسی مجوز"
        });
    }
});

// ==================== ADMIN SYSTEM ====================

// Grant Verification
app.post('/api/admin/verification', async (req, res) => {
    try {
        const { adminUsername, targetUsername, type } = req.body;
        
        console.log(`🛠 Admin action: ${adminUsername} granting ${type} verification to ${targetUsername}`);
        
        if (!adminUsername || !targetUsername || !type) {
            return res.status(400).json({ 
                success: false,
                error: "اطلاعات ناقص است" 
            });
        }
        
        // Check admin privileges
        const adminResult = await pool.query(
            "SELECT is_admin FROM users WHERE username = $1",
            [adminUsername]
        );
        
        if (adminResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: "کاربر ادمین یافت نشد"
            });
        }
        
        const isAdmin = adminResult.rows[0].is_admin;
        
        // Allow specific emails as admin even if is_admin is not set
        const adminEmails = ['shahriyarjadidi@gmail.com', 'admin@ajsports.com'];
        const adminEmailResult = await pool.query(
            "SELECT email FROM users WHERE username = $1",
            [adminUsername]
        );
        
        let isSuperAdmin = false;
        if (adminEmailResult.rows.length > 0) {
            const email = adminEmailResult.rows[0].email;
            isSuperAdmin = adminEmails.includes(email);
        }
        
        if (!isAdmin && !isSuperAdmin) {
            return res.status(403).json({ 
                success: false,
                error: "دسترسی ادمین مورد نیاز است" 
            });
        }
        
        // Update user verification
        await pool.query(
            "UPDATE users SET verification = $1 WHERE username = $2",
            [type, targetUsername]
        );
        
        // Log admin action
        await pool.query(`
            INSERT INTO admin_actions (admin_username, target_username, action_type, action_details)
            VALUES ($1, $2, 'grant_verification', $3)
        `, [adminUsername, targetUsername, { type: type, timestamp: new Date().toISOString() }]);
        
        // Send notification via socket
        if (io) {
            io.emit('notification_alert', {
                type: 'VERIFICATION_GRANTED',
                admin: adminUsername,
                target: targetUsername,
                message: `تیک ${type === 'blue' ? 'آبی' : 'طلایی'} به @${targetUsername} اعطا شد`
            });
        }
        
        res.json({
            success: true,
            message: `تیک ${type === 'blue' ? 'آبی' : 'طلایی'} به @${targetUsername} اعطا شد`,
            data: {
                admin: adminUsername,
                target: targetUsername,
                type: type,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error("❌ Grant verification error:", error);
        res.status(500).json({
            success: false,
            error: "خطا در اعطای تیک",
            details: error.message
        });
    }
});

// Remove Verification
app.post('/api/admin/remove-verification', async (req, res) => {
    try {
        const { adminUsername, targetUsername } = req.body;
        
        console.log(`🛠 Admin action: ${adminUsername} removing verification from ${targetUsername}`);
        
        if (!adminUsername || !targetUsername) {
            return res.status(400).json({ 
                success: false,
                error: "اطلاعات ناقص است" 
            });
        }
        
        // Check admin privileges
        const adminResult = await pool.query(
            "SELECT is_admin FROM users WHERE username = $1",
            [adminUsername]
        );
        
        if (adminResult.rows.length === 0 || !adminResult.rows[0].is_admin) {
            return res.status(403).json({ 
                success: false,
                error: "دسترسی ادمین مورد نیاز است" 
            });
        }
        
        // Remove verification
        await pool.query(
            "UPDATE users SET verification = NULL WHERE username = $1",
            [targetUsername]
        );
        
        // Log admin action
        await pool.query(`
            INSERT INTO admin_actions (admin_username, target_username, action_type, action_details)
            VALUES ($1, $2, 'remove_verification', $3)
        `, [adminUsername, targetUsername, { timestamp: new Date().toISOString() }]);
        
        // Send notification
        if (io) {
            io.emit('notification_alert', {
                type: 'VERIFICATION_REMOVED',
                admin: adminUsername,
                target: targetUsername,
                message: `تیک @${targetUsername} حذف شد`
            });
        }
        
        res.json({
            success: true,
            message: `تیک @${targetUsername} حذف شد`,
            data: {
                admin: adminUsername,
                target: targetUsername,
                action: 'remove_verification',
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error("❌ Remove verification error:", error);
        res.status(500).json({
            success: false,
            error: "خطا در حذف تیک",
            details: error.message
        });
    }
});

// Grant Story Permission
app.post('/api/admin/grant-story-permission', async (req, res) => {
    try {
        const { adminUsername, targetUsername } = req.body;
        
        console.log(`🛠 Admin action: ${adminUsername} granting story permission to ${targetUsername}`);
        
        if (!adminUsername || !targetUsername) {
            return res.status(400).json({ 
                success: false,
                error: "اطلاعات ناقص است" 
            });
        }
        
        // Check admin privileges
        const adminResult = await pool.query(
            "SELECT is_admin FROM users WHERE username = $1",
            [adminUsername]
        );
        
        if (adminResult.rows.length === 0 || !adminResult.rows[0].is_admin) {
            return res.status(403).json({ 
                success: false,
                error: "دسترسی ادمین مورد نیاز است" 
            });
        }
        
        // Grant story permission
        await pool.query(
            "UPDATE users SET can_post_story = true WHERE username = $1",
            [targetUsername]
        );
        
        // Log admin action
        await pool.query(`
            INSERT INTO admin_actions (admin_username, target_username, action_type, action_details)
            VALUES ($1, $2, 'grant_story_permission', $3)
        `, [adminUsername, targetUsername, { timestamp: new Date().toISOString() }]);
        
        // Send notification
        if (io) {
            io.emit('notification_alert', {
                type: 'STORY_PERMISSION_GRANTED',
                admin: adminUsername,
                target: targetUsername,
                message: `مجوز استوری به @${targetUsername} اعطا شد`
            });
        }
        
        res.json({
            success: true,
            message: `مجوز استوری به @${targetUsername} اعطا شد`,
            data: {
                admin: adminUsername,
                target: targetUsername,
                permission: 'can_post_story',
                value: true,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error("❌ Grant story permission error:", error);
        res.status(500).json({
            success: false,
            error: "خطا در اعطای مجوز استوری",
            details: error.message
        });
    }
});

// Get Admin Dashboard Stats
app.get('/api/admin/dashboard', async (req, res) => {
    try {
        const { username } = req.query;
        
        if (!username) {
            return res.status(400).json({ error: "نام کاربری الزامی است" });
        }
        
        // Verify admin
        const adminResult = await pool.query(
            "SELECT is_admin FROM users WHERE username = $1",
            [username]
        );
        
        if (adminResult.rows.length === 0 || !adminResult.rows[0].is_admin) {
            return res.status(403).json({ error: "دسترسی ادمین مورد نیاز است" });
        }
        
        // Get stats
        const [
            totalUsers,
            tweetsToday,
            activeStories,
            adminLogs
        ] = await Promise.all([
            pool.query("SELECT COUNT(*) FROM users"),
            pool.query("SELECT COUNT(*) FROM tweets WHERE created_at >= NOW() - INTERVAL '24 hours'"),
            pool.query("SELECT COUNT(*) FROM stories WHERE expires_at > NOW()"),
            pool.query("SELECT COUNT(*) FROM admin_actions WHERE created_at >= NOW() - INTERVAL '24 hours'")
        ]);
        
        res.json({
            success: true,
            stats: {
                total_users: parseInt(totalUsers.rows[0].count),
                tweets_today: parseInt(tweetsToday.rows[0].count),
                active_stories: parseInt(activeStories.rows[0].count),
                pending_reports: 0, // Can be implemented later
                recent_admin_actions: parseInt(adminLogs.rows[0].count)
            }
        });
        
    } catch (error) {
        console.error("❌ Dashboard stats error:", error);
        res.status(500).json({
            success: false,
            error: "خطا در دریافت آمار",
            stats: {
                total_users: 0,
                tweets_today: 0,
                active_stories: 0,
                pending_reports: 0,
                recent_admin_actions: 0
            }
        });
    }
});

// ==================== USER MANAGEMENT ====================

// Update User Profile
app.put('/api/users/update', async (req, res) => {
    try {
        const { username, display_name, bio, avatar_url } = req.body;
        
        if (!username) {
            return res.status(400).json({ error: "نام کاربری الزامی است" });
        }
        
        const result = await pool.query(`
            UPDATE users 
            SET display_name = COALESCE($2, display_name),
                bio = COALESCE($3, bio),
                avatar_url = COALESCE($4, avatar_url),
                updated_at = NOW()
            WHERE username = $1
            RETURNING username, display_name, bio, avatar_url, verification
        `, [username, display_name, bio, avatar_url]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "کاربر یافت نشد" });
        }
        
        res.json({
            success: true,
            user: result.rows[0],
            message: "پروفایل با موفقیت به‌روزرسانی شد"
        });
        
    } catch (error) {
        console.error("❌ Update user error:", error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== SOCKET.IO EVENTS ====================

io.on('connection', (socket) => {
    console.log('🔌 New socket connection:', socket.id);
    
    socket.on('register_user', (username) => {
        if (username) {
            socket.join(`user_${username}`);
            socket.data.username = username;
            console.log(`👤 User registered: ${username} (${socket.id})`);
        }
    });
    
    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        console.log(`👥 User joined room: ${roomId}`);
    });
    
    socket.on('join_conversation', (conversationId) => {
        socket.join(conversationId);
        console.log(`💬 User joined conversation: ${conversationId}`);
    });
    
    socket.on('new_tweet', (tweet) => {
        io.emit('new_tweet', tweet);
        console.log(`🐦 New tweet from: ${tweet.username}`);
    });
    
    socket.on('new_story_notification', (data) => {
        io.emit('notification_alert', {
            type: 'NEW_STORY',
            username: data.username,
            message: `${data.username} استوری جدید ارسال کرد`
        });
    });
    
    socket.on('disconnect', () => {
        console.log(`❌ Socket disconnected: ${socket.id} (${socket.data.username || 'Unknown'})`);
    });
});

// ==================== ERROR HANDLING ====================

app.use((err, req, res, next) => {
    console.error('🔥 Global Error:', err);
    res.status(500).json({ 
        success: false,
        error: 'Internal Server Error',
        message: err.message
    });
});

app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route not found',
        endpoint: req.url,
        method: req.method
    });
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3000;

// Initialize database and start server
initializeDatabase().then(() => {
    server.listen(PORT, () => {
        console.log(`
╔══════════════════════════════════════════╗
║   🚀 AJ Sports 2026 Backend v4.5        ║
║   📍 Port: ${PORT}                      ║
║   ✅ Status: ONLINE                     ║
║   📅 ${new Date().toLocaleString()}     ║
╚══════════════════════════════════════════╝

✅ Features:
   • 📸 Stories System (100% Working)
   • 🛠 Admin Panel (100% Working)
   • 💬 Real-time Messages
   • ✅ Verification System
   • 👑 User Permissions
   • 🔌 WebSocket Support

📡 API Endpoints:
   • /api/stories/active     [GET]
   • /api/stories            [POST]
   • /api/admin/verification [POST]
   • /api/admin/dashboard    [GET]
   • /api/users/update       [PUT]

🌐 Server: http://localhost:${PORT}
        `);
    });
}).catch(error => {
    console.error("❌ Failed to initialize server:", error);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Received SIGTERM, shutting down gracefully...');
    server.close(() => {
        pool.end(() => {
            console.log('✅ Server closed gracefully');
            process.exit(0);
        });
    });
});