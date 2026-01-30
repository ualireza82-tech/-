require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cron = require('node-cron');
const axios = require('axios');
const cors = require('cors');

// --- پیکربندی اولیه ---
const app = express();
const server = http.createServer(app);

// تنظیمات CORS برای اجازه دسترسی اپلیکیشن به سرور
app.use(cors({ origin: "*" }));
app.use(express.json());

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- اتصال قدرتمند به نئون (Neon DB) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // ضروری برای اتصال امن به نئون
});

// متغیرهای گلوبال
let API_FOOTBALL_TOKEN = "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "AjPowerSecretKey2026"; // کلید امنیتی شما

// --- لود کردن توکن از دیتابیس (تابع خودکار) ---
async function loadSystemConfig() {
  try {
    const res = await pool.query("SELECT value FROM system_config WHERE key = 'football_api_token'");
    if (res.rows.length > 0) {
      API_FOOTBALL_TOKEN = res.rows[0].value;
      console.log('✅ System Config Loaded. Active Token:', API_FOOTBALL_TOKEN.substring(0, 10) + "...");
    } else {
      console.warn('⚠️ No token found in DB. Using fallback.');
    }
  } catch (err) {
    console.error('❌ Database connection error:', err.message);
  }
}
// اجرای اولیه
loadSystemConfig();

// ======================================================
// 1. همگام‌سازی کاربر (Supabase به Neon)
// ======================================================
// وقتی کاربر در فرانت لاگین کرد، اطلاعاتش اینجا ذخیره/آپدیت می‌شود
app.post('/api/auth/sync', async (req, res) => {
  const { email, username, avatar_url } = req.body;

  if (!email || !username) return res.status(400).json({ error: "Missing fields" });

  try {
    const query = `
      INSERT INTO users (email, username, avatar_url)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) 
      DO UPDATE SET 
        avatar_url = EXCLUDED.avatar_url, 
        username = EXCLUDED.username
      RETURNING *;
    `;
    const result = await pool.query(query, [email, username, avatar_url]);
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error("Sync Error:", err);
    res.status(500).json({ error: "Database sync failed" });
  }
});

// دریافت اطلاعات یک کاربر (برای نمایش پروفایل)
app.get('/api/users/:username', async (req, res) => {
  try {
    const result = await pool.query("SELECT username, avatar_url, verification, role FROM users WHERE username = $1", [req.params.username]);
    if (result.rows.length === 0) return res.status(404).json({ error: "User not found" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// 2. مدیریت اتوماتیک روم‌ها (Auto-Room Engine)
// ======================================================
async function updateMatchRooms() {
  if (!API_FOOTBALL_TOKEN) return;

  console.log('⚽ Checking for live matches...');
  try {
    // گرفتن بازی‌های زنده
    const url = `https://apiv3.apifootball.com/?action=get_events&match_live=1&APIkey=${API_FOOTBALL_TOKEN}`;
    const response = await axios.get(url);

    if (Array.isArray(response.data)) {
      const liveMatches = response.data;
      const liveMatchIds = liveMatches.map(m => m.match_id);

      // 1. افزودن بازی‌های جدید یا آپدیت موجودها
      for (const match of liveMatches) {
        await pool.query(`
          INSERT INTO match_rooms (match_id, home_team, away_team, status)
          VALUES ($1, $2, $3, 'LIVE')
          ON CONFLICT (match_id) DO UPDATE SET status = 'LIVE'`,
          [match.match_id, match.match_hometeam_name, match.match_awayteam_name]
        );
      }

      // 2. بستن روم‌هایی که بازی آن‌ها تمام شده
      // هر رومی که الان LIVE است ولی در لیست جدید API نیست، یعنی تمام شده.
      if (liveMatchIds.length > 0) {
        await pool.query(`
          UPDATE match_rooms 
          SET status = 'FINISHED' 
          WHERE status = 'LIVE' AND match_id <> ALL($1::text[])
        `, [liveMatchIds]);
      } else {
        // اگر کلا هیچ بازی زنده‌ای نیست، همه لایوها را ببند
        await pool.query("UPDATE match_rooms SET status = 'FINISHED' WHERE status = 'LIVE'");
      }
      
      console.log(`✅ Rooms updated. Live games count: ${liveMatchIds.length}`);
    } else {
        // گاهی API ارور می‌دهد یا آبجکت خالی می‌فرستد
        if(response.data.error) console.error("API Football Error:", response.data.error);
    }
  } catch (err) {
    console.error('❌ Error in Cron Job:', err.message);
  }
}

// اجرا هر 3 دقیقه (برای بهینه بودن مصرف توکن و سرعت آپدیت)
cron.schedule('*/3 * * * *', updateMatchRooms);

// دریافت لیست روم‌های زنده برای فرانت‌اند
app.get('/api/rooms/live', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM match_rooms WHERE status = 'LIVE' ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// 3. پنل ادمین (Reqbin Controller)
// ======================================================
app.post('/api/admin/command', async (req, res) => {
  const { action, payload } = req.body;
  const secret = req.headers['x-admin-secret'];

  // بررسی امنیت
  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: "⛔ Access Denied: Wrong Secret" });
  }

  try {
    // فرمان ۱: تغییر توکن API
    if (action === 'update_token') {
      const newToken = payload.token;
      await pool.query("UPDATE system_config SET value = $1 WHERE key = 'football_api_token'", [newToken]);
      API_FOOTBALL_TOKEN = newToken; // آپدیت لحظه‌ای در حافظه
      updateMatchRooms(); // تست فوری
      return res.json({ success: true, message: "API Token Updated & Tested" });
    }

    // فرمان ۲: وریفای کاربر (تیک آبی/زرد)
    if (action === 'verify_user') {
      const { username, tier } = payload; // tier: BLUE, YELLOW, NONE
      const result = await pool.query(
        "UPDATE users SET verification = $1 WHERE username = $2 RETURNING username, verification",
        [tier, username]
      );
      
      if (result.rowCount === 0) return res.status(404).json({ error: "User not found" });
      return res.json({ success: true, user: result.rows[0] });
    }

    res.status(400).json({ error: "Unknown action" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// 4. سوکت چت (Real-time)
// ======================================================
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on('join_room', (matchId) => {
    socket.join(matchId);
  });

  socket.on('send_message', async (data) => {
    // data: { matchId, username, content }
    const { matchId, username, content } = data;

    try {
      // پیدا کردن کاربر برای گرفتن عکس و تیک آپدیت شده
      const userRes = await pool.query("SELECT id, avatar_url, verification FROM users WHERE username = $1", [username]);
      
      if (userRes.rows.length > 0) {
        const user = userRes.rows[0];

        // ذخیره در دیتابیس
        await pool.query(
          "INSERT INTO messages (content, user_id, match_id) VALUES ($1, $2, $3)",
          [content, user.id, matchId]
        );

        // ارسال به روم (شامل تیک و عکس)
        io.to(matchId).emit('receive_message', {
          id: Date.now(), // آی‌دی موقت برای فرانت
          username: username,
          content: content,
          avatar: user.avatar_url,
          verification: user.verification, // مهم: فرانت بر اساس این تیک را نشان می‌دهد
          time: new Date().toISOString()
        });
      }
    } catch (err) {
      console.error("Chat Error:", err.message);
    }
  });
});

// --- استارت سرور ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
