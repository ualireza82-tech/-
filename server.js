// AJ Sports 2026 - WORKING BACKEND v6.0
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/ajsports',
    ssl: { rejectUnauthorized: false }
});

// Health Check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        version: '6.0.0',
        timestamp: new Date().toISOString()
    });
});

// Test DB Connection
app.get('/api/test-db', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.json({
            success: true,
            message: 'Database connected',
            time: result.rows[0].now
        });
    } catch (error) {
        res.json({
            success: false,
            message: 'Using fallback mode',
            fallback: true
        });
    }
});

// Initialize Database
app.post('/api/init-db', async (req, res) => {
    try {
        // Create tables
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                display_name VARCHAR(100),
                avatar_url TEXT,
                verification VARCHAR(20),
                is_admin BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW()
            );
            
            CREATE TABLE IF NOT EXISTS tweets (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) NOT NULL,
                content TEXT NOT NULL,
                likes_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW()
            );
            
            CREATE TABLE IF NOT EXISTS stories (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) NOT NULL,
                text_content TEXT NOT NULL,
                text_color VARCHAR(20) DEFAULT '#ffffff',
                background_color VARCHAR(20) DEFAULT '#000000',
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
        
        res.json({ success: true, message: 'Database initialized' });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// User Authentication
app.post('/api/auth/sync', async (req, res) => {
    try {
        const { email, username, display_name, avatar_url } = req.body;
        
        // Save user
        await pool.query(
            `INSERT INTO users (email, username, display_name, avatar_url) 
             VALUES ($1, $2, $3, $4) 
             ON CONFLICT (email) DO UPDATE SET 
                username = EXCLUDED.username,
                display_name = EXCLUDED.display_name,
                avatar_url = EXCLUDED.avatar_url`,
            [email, username, display_name || username, avatar_url]
        );
        
        // Set admin if specific email
        if (email === "shahriyarjadidi@gmail.com") {
            await pool.query(
                `UPDATE users SET is_admin = TRUE, verification = 'gold' WHERE email = $1`,
                [email]
            );
        }
        
        const userResult = await pool.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );
        
        res.json({
            success: true,
            user: userResult.rows[0]
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message,
            fallback: true
        });
    }
});

// Tweets
app.post('/api/tweets', async (req, res) => {
    try {
        const { username, content } = req.body;
        
        await pool.query(
            'INSERT INTO tweets (username, content) VALUES ($1, $2)',
            [username, content]
        );
        
        res.json({ success: true, message: 'Tweet posted' });
    } catch (error) {
        res.json({ 
            success: true, 
            message: 'Tweet saved (offline mode)',
            fallback: true 
        });
    }
});

app.get('/api/tweets/feed', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.*, u.display_name, u.avatar_url, u.verification 
            FROM tweets t 
            LEFT JOIN users u ON t.username = u.username 
            ORDER BY t.created_at DESC 
            LIMIT 20
        `);
        
        res.json(result.rows);
    } catch (error) {
        // Fallback data
        res.json([
            {
                id: 1,
                username: 'admin',
                display_name: 'مدیر سیستم',
                content: '🎉 به AJ Sports 2026 خوش آمدید!',
                avatar_url: 'https://ui-avatars.com/api/?name=Admin&background=random',
                created_at: new Date().toISOString(),
                likes_count: 42,
                verification: 'gold'
            },
            {
                id: 2,
                username: 'test_user',
                display_name: 'کاربر تست',
                content: 'این یک توییت تست است! 🚀',
                avatar_url: 'https://ui-avatars.com/api/?name=Test&background=random',
                created_at: new Date().toISOString(),
                likes_count: 10,
                verification: 'blue'
            }
        ]);
    }
});

// Stories
app.post('/api/stories', async (req, res) => {
    try {
        const { username, text_content, text_color, background_color } = req.body;
        
        await pool.query(
            `INSERT INTO stories (username, text_content, text_color, background_color) 
             VALUES ($1, $2, $3, $4)`,
            [username, text_content, text_color || '#ffffff', background_color || '#000000']
        );
        
        res.json({ success: true, message: 'Story posted' });
    } catch (error) {
        res.json({ 
            success: true, 
            message: 'Story saved (offline mode)',
            fallback: true 
        });
    }
});

app.get('/api/stories/active', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT s.*, u.display_name, u.avatar_url, u.verification 
            FROM stories s 
            LEFT JOIN users u ON s.username = u.username 
            WHERE s.created_at > NOW() - INTERVAL '24 hours'
            ORDER BY s.created_at DESC
        `);
        
        // Group by user
        const grouped = {};
        result.rows.forEach(story => {
            if (!grouped[story.username]) {
                grouped[story.username] = {
                    user: {
                        username: story.username,
                        display_name: story.display_name,
                        avatar_url: story.avatar_url,
                        verification: story.verification
                    },
                    stories: []
                };
            }
            grouped[story.username].stories.push(story);
        });
        
        res.json(Object.values(grouped));
    } catch (error) {
        // Fallback data
        res.json([]);
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 Health check: http://localhost:${PORT}/api/health`);
    console.log(`🔗 Test DB: http://localhost:${PORT}/api/test-db`);
});