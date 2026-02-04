/**

Pro Server 2026 - Enhanced with Advanced Features

Added: Stories, Tweet Threads, User Restrictions, Admin Panel, and more
*/


require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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

// Create uploads directory if not exists
const uploadsDir = path.join(__dirname, 'uploads');
const storiesDir = path.join(uploadsDir, 'stories');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(storiesDir)) fs.mkdirSync(storiesDir, { recursive: true });

// Multer configuration for file uploads
const storage = multer.diskStorage({
destination: (req, file, cb) => {
cb(null, storiesDir);
},
filename: (req, file, cb) => {
const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
cb(null, 'story-' + uniqueSuffix + path.extname(file.originalname));
}
});

const upload = multer({
storage: storage,
limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
fileFilter: (req, file, cb) => {
const allowedTypes = /jpeg|jpg|png|gif|mp4|mov|avi/;
const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
const mimetype = allowedTypes.test(file.mimetype);

if (extname && mimetype) {  
  return cb(null, true);  
}  
cb(new Error('Only images and videos are allowed'));

}
});

// Middleware
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "PATCH"] }));
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(uploadsDir));

// Add root route handler
app.get('/', (req, res) => {
res.json({
message: 'AJ Sports 2026 Backend API',
version: '2.0.0',
status: 'online',
new_features: [
'24-hour Instagram-like Stories',
'Tweet Threads & Replies',
'User Restrictions System',
'Advanced Admin Panel',
'Media Upload System',
'Reporting System',
'Trending Topics'
],
endpoints: {
auth: '/api/auth/sync',
users: '/api/users/profile/:username',
tweets: '/api/tweets',
stories: '/api/stories',
notifications: '/api/notifications/:username',
dm: '/api/dm/list/:username',
admin: '/api/admin',
reports: '/api/reports',
trending: '/api/trending'
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

// Create new tables if they don't exist  
await client.query(`  
  -- Stories Table  
  CREATE TABLE IF NOT EXISTS stories (  
    id SERIAL PRIMARY KEY,  
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,  
    media_url TEXT NOT NULL,  
    media_type VARCHAR(10) CHECK (media_type IN ('image', 'video')),  
    text_content TEXT,  
    background_color VARCHAR(20),  
    text_color VARCHAR(20),  
    views_count INTEGER DEFAULT 0,  
    expires_at TIMESTAMP NOT NULL,  
    created_at TIMESTAMP DEFAULT NOW(),  
    is_active BOOLEAN DEFAULT true  
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
    can_post_story BOOLEAN DEFAULT false,  
    is_blocked BOOLEAN DEFAULT false,  
    blocked_until TIMESTAMP,  
    warning_count INTEGER DEFAULT 0,  
    restrictions JSONB DEFAULT '{}'  
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
    created_at TIMESTAMP DEFAULT NOW(),  
    resolved_at TIMESTAMP,  
    resolved_by INTEGER REFERENCES users(id)  
  );  

  -- Admin Actions Table  
  CREATE TABLE IF NOT EXISTS admin_actions (  
    id SERIAL PRIMARY KEY,  
    admin_id INTEGER REFERENCES users(id) ON DELETE CASCADE,  
    target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,  
    action_type VARCHAR(50) NOT NULL,  
    details JSONB,  
    created_at TIMESTAMP DEFAULT NOW()  
  );  

  -- Pinned Tweets Table  
  CREATE TABLE IF NOT EXISTS pinned_tweets (  
    id SERIAL PRIMARY KEY,  
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,  
    tweet_id INTEGER REFERENCES tweets(id) ON DELETE CASCADE,  
    pinned_at TIMESTAMP DEFAULT NOW()  
  );  

  -- Trending Topics Table  
  CREATE TABLE IF NOT EXISTS trending_topics (  
    id SERIAL PRIMARY KEY,  
    hashtag VARCHAR(100) UNIQUE NOT NULL,  
    tweet_count INTEGER DEFAULT 1,  
    last_activity TIMESTAMP DEFAULT NOW(),  
    created_at DATE DEFAULT CURRENT_DATE  
  );  
`);  
  
console.log('✅ Database connected successfully - All tables verified');  
client.release();  
  
// Schedule daily tasks  
scheduleDailyTasks();

} catch (err) {
console.error('❌ Database setup failed:', err.message);
}
}

// Schedule daily tasks (reset tweet counts, expire stories, update trends)
function scheduleDailyTasks() {
// Run at midnight every day
const now = new Date();
const midnight = new Date(now);
midnight.setHours(24, 0, 0, 0);
const timeUntilMidnight = midnight - now;

setTimeout(() => {
resetDailyTweetCounts();
expireOldStories();
updateTrendingTopics();

// Schedule next run  
setInterval(() => {  
  resetDailyTweetCounts();  
  expireOldStories();  
  updateTrendingTopics();  
}, 24 * 60 * 60 * 1000); // 24 hours

}, timeUntilMidnight);
}

async function resetDailyTweetCounts() {
try {
await pool.query(  UPDATE user_restrictions    SET tweets_today = 0, last_reset_date = CURRENT_DATE    WHERE last_reset_date < CURRENT_DATE  );
console.log('✅ Daily tweet counts reset');
} catch (error) {
console.error('❌ Error resetting tweet counts:', error);
}
}

async function expireOldStories() {
try {
const result = await pool.query(  UPDATE stories    SET is_active = false    WHERE expires_at < NOW() AND is_active = true   RETURNING id  );

if (result.rows.length > 0) {  
  console.log(`✅ Expired ${result.rows.length} stories`);  
    
  // Delete associated media files  
  result.rows.forEach(async (story) => {  
    try {  
      const mediaRes = await pool.query(  
        'SELECT media_url FROM stories WHERE id = $1',  
        [story.id]  
      );  
        
      if (mediaRes.rows[0]?.media_url) {  
        const filePath = path.join(__dirname, mediaRes.rows[0].media_url);  
        if (fs.existsSync(filePath)) {  
          fs.unlinkSync(filePath);  
        }  
      }  
    } catch (err) {  
      console.error('Error deleting story media:', err);  
    }  
  });  
}

} catch (error) {
console.error('❌ Error expiring stories:', error);
}
}

async function updateTrendingTopics() {
try {
// Remove old trends
await pool.query(  DELETE FROM trending_topics    WHERE created_at < CURRENT_DATE - INTERVAL '7 days'  );

// Update current trends based on hashtags in tweets from last 24 hours  
await pool.query(`  
  INSERT INTO trending_topics (hashtag, tweet_count)  
  SELECT   
    LOWER(hashtag) as hashtag,  
    COUNT(*) as tweet_count  
  FROM (  
    SELECT DISTINCT   
      UNNEST(REGEXP_MATCHES(content, '#([a-zA-Z0-9_\\u0600-\\u06FF]+)', 'g')) as hashtag  
    FROM tweets   
    WHERE created_at > NOW() - INTERVAL '24 hours'  
  ) AS hashtags  
  GROUP BY hashtag  
  ON CONFLICT (hashtag)   
  DO UPDATE SET   
    tweet_count = EXCLUDED.tweet_count + trending_topics.tweet_count,  
    last_activity = NOW()  
  RETURNING hashtag  
`);  
  
console.log('✅ Trending topics updated');

} catch (error) {
console.error('❌ Error updating trends:', error);
}
}

testDatabaseConnection();

// ======================================================
// 2. HELPER FUNCTIONS
// ======================================================

// Check if user can post tweet
async function canUserPostTweet(username) {
try {
const userRes = await pool.query(
SELECT u.id, u.verification, ur.tweet_limit, ur.tweets_today, ur.is_blocked, ur.blocked_until   FROM users u   LEFT JOIN user_restrictions ur ON u.id = ur.user_id   WHERE u.username = $1,
[username]
);

if (userRes.rows.length === 0) return { canPost: false, reason: 'User not found' };  
  
const user = userRes.rows[0];  
  
// Check if user is blocked  
if (user.is_blocked) {  
  if (user.blocked_until && new Date(user.blocked_until) > new Date()) {  
    return { canPost: false, reason: 'Account is temporarily blocked' };  
  }  
  return { canPost: false, reason: 'Account is blocked' };  
}  
  
// Users with blue or gold tick have no limits  
if (user.verification === 'blue' || user.verification === 'gold') {  
  return { canPost: true, limit: null, used: null };  
}  
  
// Regular users: check daily limit  
const tweetLimit = user.tweet_limit || 3;  
const tweetsToday = user.tweets_today || 0;  
  
if (tweetsToday >= tweetLimit) {  
  return { canPost: false, reason: `Daily limit reached (${tweetLimit} tweets per day)`, limit: tweetLimit, used: tweetsToday };  
}  
  
return { canPost: true, limit: tweetLimit, used: tweetsToday };

} catch (error) {
console.error('Error checking tweet permission:', error);
return { canPost: false, reason: 'System error' };
}
}

// Increment user's tweet count
async function incrementTweetCount(userId) {
try {
await pool.query(  INSERT INTO user_restrictions (user_id, tweets_today, last_reset_date)   VALUES ($1, 1, CURRENT_DATE)   ON CONFLICT (user_id) DO UPDATE SET   tweets_today = user_restrictions.tweets_today + 1,   last_reset_date = CASE    WHEN user_restrictions.last_reset_date < CURRENT_DATE THEN CURRENT_DATE    ELSE user_restrictions.last_reset_date    END  , [userId]);
} catch (error) {
console.error('Error incrementing tweet count:', error);
}
}

// Check if user can post story
async function canUserPostStory(username) {
try {
const userRes = await pool.query(
SELECT u.id, u.verification, ur.can_post_story   FROM users u   LEFT JOIN user_restrictions ur ON u.id = ur.user_id   WHERE u.username = $1,
[username]
);

if (userRes.rows.length === 0) return { canPost: false, reason: 'User not found' };  
  
const user = userRes.rows[0];  
  
// Only verified users (blue or gold tick) can post stories  
if (user.verification === 'blue' || user.verification === 'gold' || user.can_post_story) {  
  return { canPost: true };  
}  
  
return { canPost: false, reason: 'Only verified users can post stories' };

} catch (error) {
console.error('Error checking story permission:', error);
return { canPost: false, reason: 'System error' };
}
}

// Check if user is admin
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
// 3. API ROUTES - ENHANCED
// ======================================================

// --- HEALTH CHECK ---
app.get('/api/health', async (req, res) => {
try {
const dbResult = await pool.query('SELECT NOW() as time');
const storiesCount = await pool.query("SELECT COUNT() as active FROM stories WHERE is_active = true");
const trendsCount = await pool.query("SELECT COUNT() as trends FROM trending_topics");

res.json({  
  status: 'healthy',  
  timestamp: new Date().toISOString(),  
  database: {  
    connected: true,  
    time: dbResult.rows[0].time  
  },  
  features: {  
    active_stories: parseInt(storiesCount.rows[0].active),  
    trending_topics: parseInt(trendsCount.rows[0].trends)  
  },  
  server: 'AJ Sports 2026 Backend v2.0'  
});

} catch (error) {
res.status(500).json({
status: 'unhealthy',
error: error.message
});
}
});

// --- AUTH & USER MANAGEMENT (Enhanced) ---

// Sync User (Login/Register) - Enhanced with restrictions
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
  
// Initialize user restrictions  
await pool.query(`  
  INSERT INTO user_restrictions (user_id)  
  VALUES ($1)  
  ON CONFLICT (user_id) DO NOTHING  
`, [user.id]);  
  
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

// Get Profile - Enhanced with tweets and stats
app.get('/api/users/profile/:username', async (req, res) => {
try {
const { username } = req.params;
const requesterUsername = req.query.me;

console.log('📱 Profile request for:', username);  
  
// Get user info  
const userQuery = `  
  SELECT u.id, u.username, u.display_name, u.avatar_url, u.verification, u.bio, u.created_at,  
  (SELECT COUNT(*) FROM follows WHERE following_id = u.id) as followers_count,  
  (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) as following_count,  
  (SELECT COUNT(*) FROM tweets WHERE user_id = u.id AND parent_id IS NULL) as tweets_count,  
  (SELECT COUNT(*) FROM stories WHERE user_id = u.id AND is_active = true) as active_stories_count,  
  ur.tweet_limit, ur.tweets_today, ur.is_blocked,  
  pt.tweet_id as pinned_tweet_id  
  FROM users u  
  LEFT JOIN user_restrictions ur ON u.id = ur.user_id  
  LEFT JOIN pinned_tweets pt ON u.id = pt.user_id  
  WHERE u.username = $1  
`;  
  
const userResult = await pool.query(userQuery, [username]);  
  
if (userResult.rows.length === 0) {  
  return res.status(404).json({ error: "User not found" });  
}  
  
const user = userResult.rows[0];  
let isFollowing = false;  

// Check if requester is following this user  
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

// Get user's tweets  
const tweetsQuery = `  
  SELECT   
    t.id, t.content, t.created_at, t.likes_count, t.user_id, t.parent_id,  
    u.username, u.display_name, u.avatar_url, u.verification,  
    (SELECT COUNT(*) FROM tweets WHERE parent_id = t.id) as reply_count,  
    (SELECT COUNT(*) FROM retweets WHERE tweet_id = t.id) as retweet_count,  
    EXISTS(SELECT 1 FROM likes WHERE tweet_id = t.id AND user_id = $2) as has_liked,  
    EXISTS(SELECT 1 FROM retweets WHERE tweet_id = t.id AND user_id = $2) as has_retweeted,  
    EXISTS(SELECT 1 FROM bookmarks WHERE tweet_id = t.id AND user_id = $2) as has_bookmarked  
  FROM tweets t  
  JOIN users u ON t.user_id = u.id  
  WHERE u.username = $1 AND t.parent_id IS NULL  
  ORDER BY t.created_at DESC  
  LIMIT 20  
`;  
  
const requesterId = requesterUsername ? (await pool.query(  
  "SELECT id FROM users WHERE username = $1",   
  [requesterUsername]  
)).rows[0]?.id : null;  
  
const tweetsResult = await pool.query(tweetsQuery, [username, requesterId]);  

res.json({   
  ...user,   
  is_following: isFollowing,  
  tweets: tweetsResult.rows,  
  can_post_story: user.verification === 'blue' || user.verification === 'gold'  
});

} catch (error) {
console.error("Profile error:", error);
res.status(500).json({ error: 'Internal server error' });
}
});

// --- STORIES SYSTEM ---

// Upload Story
app.post('/api/stories', upload.single('media'), async (req, res) => {
try {
const { username, text_content, background_color, text_color } = req.body;

if (!username) {  
  // Delete uploaded file if validation fails  
  if (req.file) fs.unlinkSync(req.file.path);  
  return res.status(400).json({ error: "نام کاربری الزامی است" });  
}  

// Check if user can post story  
const canPost = await canUserPostStory(username);  
if (!canPost.canPost) {  
  if (req.file) fs.unlinkSync(req.file.path);  
  return res.status(403).json({ error: canPost.reason });  
}  

// Get user  
const userRes = await pool.query(  
  "SELECT id FROM users WHERE username = $1",   
  [username]  
);  
  
if (userRes.rows.length === 0) {  
  if (req.file) fs.unlinkSync(req.file.path);  
  return res.status(404).json({ error: "User not found" });  
}  
  
const userId = userRes.rows[0].id;  

// Determine media type  
let mediaType = 'text';  
let mediaUrl = null;  
  
if (req.file) {  
  mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';  
  mediaUrl = `/uploads/stories/${path.basename(req.file.path)}`;  
} else if (!text_content) {  
  return res.status(400).json({ error: "محتوا یا رسانه الزامی است" });  
}  

// Create story (expires in 24 hours)  
const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);  
  
const query = `  
  INSERT INTO stories (  
    user_id, media_url, media_type, text_content,   
    background_color, text_color, expires_at  
  ) VALUES ($1, $2, $3, $4, $5, $6, $7)  
  RETURNING id, media_url, media_type, text_content,   
            background_color, text_color, views_count,   
            expires_at, created_at  
`;  
  
const result = await pool.query(query, [  
  userId,  
  mediaUrl,  
  mediaType,  
  text_content || null,  
  background_color || '#000000',  
  text_color || '#FFFFFF',  
  expiresAt  
]);  

const story = result.rows[0];  
  
// Broadcast new story to followers  
const followers = await pool.query(  
  "SELECT follower_id FROM follows WHERE following_id = $1",  
  [userId]  
);  
  
followers.rows.forEach(follower => {  
  io.to(`user_${follower.follower_id}`).emit('new_story', {  
    story_id: story.id,  
    user_id: userId,  
    username: username  
  });  
});  

res.json({ success: true, story });

} catch (error) {
console.error("Upload story error:", error);
if (req.file && fs.existsSync(req.file.path)) {
fs.unlinkSync(req.file.path);
}
res.status(500).json({ error: 'Internal server error' });
}
});

// Get Active Stories
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

// Get stories from users that the requester follows  
const query = `  
  SELECT   
    s.id, s.media_url, s.media_type, s.text_content,   
    s.background_color, s.text_color, s.views_count,  
    s.expires_at, s.created_at,  
    u.id as user_id, u.username, u.display_name, u.avatar_url, u.verification,  
    EXISTS(SELECT 1 FROM story_views sv WHERE sv.story_id = s.id AND sv.viewer_id = $1) as has_viewed  
  FROM stories s  
  JOIN users u ON s.user_id = u.id  
  WHERE s.is_active = true   
    AND s.expires_at > NOW()  
    AND ($1 IS NULL OR u.id IN (  
      SELECT following_id FROM follows WHERE follower_id = $1  
    ) OR u.id = $1)  
  ORDER BY u.username, s.created_at DESC  
`;  
  
const result = await pool.query(query, [userId]);  
  
// Group stories by user  
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
  storiesByUser[story.user_id].stories.push({  
    id: story.id,  
    media_url: story.media_url,  
    media_type: story.media_type,  
    text_content: story.text_content,  
    background_color: story.background_color,  
    text_color: story.text_color,  
    views_count: story.views_count,  
    expires_at: story.expires_at,  
    created_at: story.created_at,  
    has_viewed: story.has_viewed  
  });  
});  

res.json(Object.values(storiesByUser));

} catch (error) {
console.error("Get stories error:", error);
res.status(500).json({ error: 'Internal server error' });
}
});

// View Story
app.post('/api/stories/:id/view', async (req, res) => {
try {
const storyId = req.params.id;
const { username } = req.body;

if (!username) {  
  return res.status(400).json({ error: "نام کاربری الزامی است" });  
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

// Check if story exists and is active  
const storyRes = await pool.query(  
  "SELECT user_id FROM stories WHERE id = $1 AND is_active = true AND expires_at > NOW()",  
  [storyId]  
);  
  
if (storyRes.rows.length === 0) {  
  return res.status(404).json({ error: "Story not found or expired" });  
}  
  
const storyUserId = storyRes.rows[0].user_id;  

// Record view if not already viewed  
try {  
  await pool.query(  
    `INSERT INTO story_views (story_id, viewer_id)   
     VALUES ($1, $2)   
     ON CONFLICT (story_id, viewer_id) DO NOTHING`,  
    [storyId, viewerId]  
  );  

  // Update view count  
  await pool.query(  
    "UPDATE stories SET views_count = views_count + 1 WHERE id = $1",  
    [storyId]  
  );  

  // Get updated view count and viewer list  
  const viewsRes = await pool.query(  
    `SELECT COUNT(*) as total_views,  
            (SELECT json_agg(json_build_object(  
              'username', u.username,  
              'display_name', u.display_name,  
              'avatar_url', u.avatar_url,  
              'viewed_at', sv.viewed_at  
            ))  
             FROM story_views sv  
             JOIN users u ON sv.viewer_id = u.id  
             WHERE sv.story_id = $1  
             ORDER BY sv.viewed_at DESC  
             LIMIT 10) as recent_viewers  
     FROM story_views WHERE story_id = $1`,  
    [storyId]  
  );  

  // Notify story owner about new view (if not viewing own story)  
  if (viewerId !== storyUserId) {  
    io.to(`user_${storyUserId}`).emit('story_viewed', {  
      story_id: storyId,  
      viewer: {  
        id: viewerId,  
        username: username  
      },  
      total_views: parseInt(viewsRes.rows[0].total_views)  
    });  
  }  

  res.json({   
    success: true,   
    total_views: parseInt(viewsRes.rows[0].total_views),  
    recent_viewers: viewsRes.rows[0].recent_viewers || []  
  });  
} catch (error) {  
  // Ignore duplicate view errors  
  if (error.code !== '23505') throw error;  
  res.json({ success: true, message: 'Already viewed' });  
}

} catch (error) {
console.error("View story error:", error);
res.status(500).json({ error: 'Internal server error' });
}
});

// Get Story Viewers
app.get('/api/stories/:id/viewers', async (req, res) => {
try {
const storyId = req.params.id;
const { page = 1, limit = 20 } = req.query;
const offset = (page - 1) * limit;

const query = `  
  SELECT   
    u.username, u.display_name, u.avatar_url, u.verification,  
    sv.viewed_at  
  FROM story_views sv  
  JOIN users u ON sv.viewer_id = u.id  
  WHERE sv.story_id = $1  
  ORDER BY sv.viewed_at DESC  
  LIMIT $2 OFFSET $3  
`;  
  
const result = await pool.query(query, [storyId, limit, offset]);  
  
// Get total count  
const countRes = await pool.query(  
  "SELECT COUNT(*) as total FROM story_views WHERE story_id = $1",  
  [storyId]  
);  
  
res.json({  
  viewers: result.rows,  
  pagination: {  
    page: parseInt(page),  
    limit: parseInt(limit),  
    total: parseInt(countRes.rows[0].total),  
    total_pages: Math.ceil(countRes.rows[0].total / limit)  
  }  
});

} catch (error) {
console.error("Get story viewers error:", error);
res.status(500).json({ error: 'Internal server error' });
}
});

// Delete Story
app.delete('/api/stories/:id', async (req, res) => {
try {
const storyId = req.params.id;
const { username } = req.body;

if (!username) {  
  return res.status(400).json({ error: "نام کاربری الزامی است" });  
}  

// Get user and story  
const checkRes = await pool.query(`  
  SELECT s.id, s.media_url  
  FROM stories s  
  JOIN users u ON s.user_id = u.id  
  WHERE s.id = $1 AND u.username = $2  
`, [storyId, username]);  
  
if (checkRes.rows.length === 0) {  
  return res.status(404).json({ error: "Story not found or unauthorized" });  
}  

// Delete media file if exists  
const mediaUrl = checkRes.rows[0].media_url;  
if (mediaUrl) {  
  const filePath = path.join(__dirname, mediaUrl);  
  if (fs.existsSync(filePath)) {  
    fs.unlinkSync(filePath);  
  }  
}  

// Delete story from database  
await pool.query("DELETE FROM stories WHERE id = $1", [storyId]);  
  
// Broadcast deletion  
io.emit('story_deleted', { story_id: storyId });  
  
res.json({ success: true });

} catch (error) {
console.error("Delete story error:", error);
res.status(500).json({ error: 'Internal server error' });
}
});

// --- TWEET SYSTEM (Enhanced) ---

// Create Tweet - Enhanced with daily limits
app.post('/api/tweets', async (req, res) => {
try {
const { username, content, parentId } = req.body;

if (!username || !content || content.trim().length === 0) {  
  return res.status(400).json({ error: "نام کاربری و محتوا الزامی هستند" });  
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
  
// Extract hashtags for trending  
const hashtags = (cleanContent.match(/#[a-zA-Z0-9_\\u0600-\\u06FF]+/g) || [])  
  .map(tag => tag.toLowerCase().substring(1));  
  
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

// Increment user's tweet count (only for non-verified users)  
if (!user.verification) {  
  await incrementTweetCount(user.id);  
}  

// Update trending topics  
if (hashtags.length > 0) {  
  await Promise.all(hashtags.map(async (hashtag) => {  
    try {  
      await pool.query(`  
        INSERT INTO trending_topics (hashtag)   
        VALUES ($1)  
        ON CONFLICT (hashtag)   
        DO UPDATE SET   
          tweet_count = trending_topics.tweet_count + 1,  
          last_activity = NOW()  
      `, [hashtag]);  
    } catch (error) {  
      console.error('Error updating trending topic:', error);  
    }  
  }));  
}  

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

// Get Tweet Thread (Replies)
app.get('/api/tweets/:id/thread', async (req, res) => {
try {
const tweetId = req.params.id;
const username = req.query.me;

let userId = null;  
if (username) {  
  const u = await pool.query(  
    "SELECT id FROM users WHERE username = $1",   
    [username]  
  );  
  if (u.rows.length) userId = u.rows[0].id;  
}  

// Get main tweet  
const mainTweetQuery = `  
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
  WHERE t.id = $1  
`;  
  
const mainTweetRes = await pool.query(mainTweetQuery, userId ? [tweetId, userId] : [tweetId]);  
  
if (mainTweetRes.rows.length === 0) {  
  return res.status(404).json({ error: "Tweet not found" });  
}  
  
const mainTweet = mainTweetRes.rows[0];  

// Get all replies recursively  
const getReplies = async (parentId) => {  
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
    WHERE t.parent_id = $2  
    ORDER BY t.created_at ASC  
  `;  
    
  const replies = await pool.query(query, userId ? [userId, parentId] : [null, parentId]);  
    
  // Recursively get replies for each reply  
  const repliesWithChildren = await Promise.all(  
    replies.rows.map(async (reply) => ({  
      ...reply,  
      replies: await getReplies(reply.id)  
    }))  
  );  
    
  return repliesWithChildren;  
};  

const replies = await getReplies(tweetId);  

res.json({  
  tweet: mainTweet,  
  replies: replies,  
  thread_depth: replies.length  
});

} catch (error) {
console.error("Get tweet thread error:", error);
res.status(500).json({ error: 'Internal server error' });
}
});

// Pin Tweet
app.post('/api/tweets/:id/pin', async (req, res) => {
try {
const tweetId = req.params.id;
const { username } = req.body;

if (!username) {  
  return res.status(400).json({ error: "نام کاربری الزامی است" });  
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

// Check if tweet belongs to user  
const tweetRes = await pool.query(  
  "SELECT id FROM tweets WHERE id = $1 AND user_id = $2",  
  [tweetId, userId]  
);  
  
if (tweetRes.rows.length === 0) {  
  return res.status(403).json({ error: "You can only pin your own tweets" });  
}  

// Unpin any previously pinned tweet  
await pool.query(  
  "DELETE FROM pinned_tweets WHERE user_id = $1",  
  [userId]  
);  

// Pin new tweet  
await pool.query(  
  "INSERT INTO pinned_tweets (user_id, tweet_id) VALUES ($1, $2)",  
  [userId, tweetId]  
);  

res.json({ success: true });

} catch (error) {
console.error("Pin tweet error:", error);
res.status(500).json({ error: 'Internal server error' });
}
});

// Unpin Tweet
app.delete('/api/tweets/pin', async (req, res) => {
try {
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

await pool.query(  
  "DELETE FROM pinned_tweets WHERE user_id = $1",  
  [userId]  
);  

res.json({ success: true });

} catch (error) {
console.error("Unpin tweet error:", error);
res.status(500).json({ error: 'Internal server error' });
}
});

// --- REPORTS SYSTEM ---

// Report Tweet or User
app.post('/api/reports', async (req, res) => {
try {
const { reporterUsername, reportedUsername, reportedTweetId, reportType, description } = req.body;

if (!reporterUsername || !reportType) {  
  return res.status(400).json({ error: "اطلاعات ناقص است" });  
}  

// Get reporter user  
const reporterRes = await pool.query(  
  "SELECT id FROM users WHERE username = $1",   
  [reporterUsername]  
);  
  
if (reporterRes.rows.length === 0) {  
  return res.status(404).json({ error: "Reporter not found" });  
}  
  
const reporterId = reporterRes.rows[0].id;  

let reportedUserId = null;  
if (reportedUsername) {  
  const reportedRes = await pool.query(  
    "SELECT id FROM users WHERE username = $1",   
    [reportedUsername]  
  );  
  if (reportedRes.rows.length > 0) {  
    reportedUserId = reportedRes.rows[0].id;  
  }  
}  

// Create report  
const reportRes = await pool.query(`  
  INSERT INTO reports (  
    reporter_id, reported_user_id, reported_tweet_id,   
    report_type, description  
  ) VALUES ($1, $2, $3, $4, $5)  
  RETURNING id, created_at  
`, [reporterId, reportedUserId, reportedTweetId, reportType, description]);  

// Notify admins  
const admins = await pool.query(  
  "SELECT id FROM users WHERE is_admin = true",  
);  
  
admins.rows.forEach(admin => {  
  io.to(`user_${admin.id}`).emit('new_report', {  
    report_id: reportRes.rows[0].id,  
    reporter_id: reporterId,  
    report_type: reportType,  
    created_at: reportRes.rows[0].created_at  
  });  
});  

res.json({ success: true, report_id: reportRes.rows[0].id });

} catch (error) {
console.error("Report error:", error);
res.status(500).json({ error: 'Internal server error' });
}
});

// Get Reports (Admin only)
app.get('/api/reports', async (req, res) => {
try {
const { username, status, page = 1, limit = 20 } = req.query;

// Check if user is admin  
if (!username || !await isAdmin(username)) {  
  return res.status(403).json({ error: "دسترسی غیرمجاز - فقط ادمین" });  
}  

const offset = (page - 1) * limit;  
let query = `  
  SELECT   
    r.id, r.report_type, r.description, r.status, r.created_at, r.resolved_at,  
    ru.username as reported_username, ru.display_name as reported_display_name,  
    rr.username as reporter_username, rr.display_name as reporter_display_name,  
    rt.content as tweet_content, rt.id as tweet_id,  
    a.username as resolved_by_username  
  FROM reports r  
  LEFT JOIN users ru ON r.reported_user_id = ru.id  
  LEFT JOIN users rr ON r.reporter_id = rr.id  
  LEFT JOIN tweets rt ON r.reported_tweet_id = rt.id  
  LEFT JOIN users a ON r.resolved_by = a.id  
  WHERE 1=1  
`;  
  
const params = [];  
let paramCount = 0;  

if (status) {  
  paramCount++;  
  query += ` AND r.status = $${paramCount}`;  
  params.push(status);  
}  

query += ` ORDER BY r.created_at DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;  
params.push(limit, offset);  

const result = await pool.query(query, params);  

// Get total count  
const countQuery = `SELECT COUNT(*) as total FROM reports ${status ? 'WHERE status = $1' : ''}`;  
const countResult = await pool.query(  
  countQuery,   
  status ? [status] : []  
);  

res.json({  
  reports: result.rows,  
  pagination: {  
    page: parseInt(page),  
    limit: parseInt(limit),  
    total: parseInt(countResult.rows[0].total),  
    total_pages: Math.ceil(countResult.rows[0].total / limit)  
  }  
});

} catch (error) {
console.error("Get reports error:", error);
res.status(500).json({ error: 'Internal server error' });
}
});

// Resolve Report (Admin only)
app.post('/api/reports/:id/resolve', async (req, res) => {
try {
const reportId = req.params.id;
const { username, action_taken, notes } = req.body;

if (!username) {  
  return res.status(400).json({ error: "نام کاربری الزامی است" });  
}  

// Check if user is admin  
if (!await isAdmin(username)) {  
  return res.status(403).json({ error: "دسترسی غیرمجاز - فقط ادمین" });  
}  

// Get admin user  
const adminRes = await pool.query(  
  "SELECT id FROM users WHERE username = $1",   
  [username]  
);  
  
if (adminRes.rows.length === 0) {  
  return res.status(404).json({ error: "Admin not found" });  
}  
  
const adminId = adminRes.rows[0].id;  

// Update report status  
await pool.query(`  
  UPDATE reports   
  SET status = 'resolved', resolved_at = NOW(), resolved_by = $1  
  WHERE id = $2  
`, [adminId, reportId]);  

// Log admin action  
await pool.query(`  
  INSERT INTO admin_actions (admin_id, action_type, details)  
  VALUES ($1, 'REPORT_RESOLVED', $2)  
`, [adminId, JSON.stringify({  
  report_id: reportId,  
  action_taken,  
  notes,  
  resolved_at: new Date().toISOString()  
})]);  

res.json({ success: true });

} catch (error) {
console.error("Resolve report error:", error);
res.status(500).json({ error: 'Internal server error' });
}
});

// --- ADMIN PANEL (Enhanced) ---

// Admin Dashboard Stats
app.get('/api/admin/dashboard', async (req, res) => {
try {
const { username } = req.query;

if (!username || !await isAdmin(username)) {  
  return res.status(403).json({ error: "دسترسی غیرمجاز - فقط ادمین" });  
}  

// Get various stats  
const [  
  usersCount,  
  tweetsCount,  
  storiesCount,  
  reportsCount,  
  trendingTopics,  
  recentActions  
] = await Promise.all([  
  pool.query("SELECT COUNT(*) as count FROM users"),  
  pool.query("SELECT COUNT(*) as count FROM tweets WHERE created_at > NOW() - INTERVAL '24 hours'"),  
  pool.query("SELECT COUNT(*) as count FROM stories WHERE is_active = true"),  
  pool.query("SELECT COUNT(*) as count FROM reports WHERE status = 'pending'"),  
  pool.query(`  
    SELECT hashtag, tweet_count   
    FROM trending_topics   
    ORDER BY tweet_count DESC, last_activity DESC   
    LIMIT 10  
  `),  
  pool.query(`  
    SELECT aa.action_type, aa.details, aa.created_at, u.username as admin_username  
    FROM admin_actions aa  
    JOIN users u ON aa.admin_id = u.id  
    ORDER BY aa.created_at DESC  
    LIMIT 10  
  `)  
]);  

// Get user growth (last 7 days)  
const userGrowth = await pool.query(`  
  SELECT   
    DATE(created_at) as date,  
    COUNT(*) as new_users  
  FROM users   
  WHERE created_at > NOW() - INTERVAL '7 days'  
  GROUP BY DATE(created_at)  
  ORDER BY date  
`);  

res.json({  
  stats: {  
    total_users: parseInt(usersCount.rows[0].count),  
    tweets_today: parseInt(tweetsCount.rows[0].count),  
    active_stories: parseInt(storiesCount.rows[0].count),  
    pending_reports: parseInt(reportsCount.rows[0].count)  
  },  
  trending_topics: trendingTopics.rows,  
  recent_actions: recentActions.rows,  
  user_growth: userGrowth.rows  
});

} catch (error) {
console.error("Admin dashboard error:", error);
res.status(500).json({ error: 'Internal server error' });
}
});

// Admin: Delete User Tweet
app.delete('/api/admin/tweets/:id', async (req, res) => {
try {
const tweetId = req.params.id;
const { adminUsername, reason } = req.body;

if (!adminUsername) {  
  return res.status(400).json({ error: "نام کاربری ادمین الزامی است" });  
}  

// Check if user is admin  
if (!await isAdmin(adminUsername)) {  
  return res.status(403).json({ error: "دسترسی غیرمجاز - فقط ادمین" });  
}  

// Get tweet info  
const tweetRes = await pool.query(`  
  SELECT t.id, t.user_id, t.content, u.username as tweet_owner  
  FROM tweets t  
  JOIN users u ON t.user_id = u.id  
  WHERE t.id = $1  
`, [tweetId]);  
  
if (tweetRes.rows.length === 0) {  
  return res.status(404).json({ error: "Tweet not found" });  
}  
  
const tweet = tweetRes.rows[0];  

// Get admin user  
const adminRes = await pool.query(  
  "SELECT id FROM users WHERE username = $1",   
  [adminUsername]  
);  
  
const adminId = adminRes.rows[0].id;  

// Delete tweet  
await pool.query("DELETE FROM tweets WHERE id = $1", [tweetId]);  

// Log admin action  
await pool.query(`  
  INSERT INTO admin_actions (admin_id, target_user_id, action_type, details)  
  VALUES ($1, $2, 'DELETE_TWEET', $3)  
`, [adminId, tweet.user_id, JSON.stringify({  
  tweet_id: tweetId,  
  tweet_content: tweet.content.substring(0, 200),  
  reason: reason || 'Violation of community guidelines',  
  deleted_at: new Date().toISOString()  
})]);  

// Notify tweet owner  
await pool.query(`  
  INSERT INTO notifications (recipient_id, sender_id, type, content)  
  VALUES ($1, $2, 'ADMIN_ACTION', $3)  
`, [  
  tweet.user_id,  
  adminId,  
  `توییت شما توسط مدیریت حذف شد. دلیل: ${reason || 'تخطی از قوانین'}`  
]);  

// Send realtime notification to tweet owner  
io.to(`user_${tweet.user_id}`).emit('notification_alert', {  
  type: 'ADMIN_ACTION',  
  message: `توییت شما توسط مدیریت حذف شد`,  
  action: 'tweet_deleted',  
  tweet_id: tweetId  
});  

// Broadcast tweet deletion  
io.emit('tweet_deleted', tweetId);  

res.json({   
  success: true,   
  message: "Tweet deleted successfully",  
  tweet_owner: tweet.tweet_owner  
});

} catch (error) {
console.error("Admin delete tweet error:", error);
res.status(500).json({ error: 'Internal server error' });
}
});

// Admin: Restrict User
app.post('/api/admin/users/:username/restrict', async (req, res) => {
try {
const targetUsername = req.params.username;
const { adminUsername, restrictionType, duration, reason } = req.body;

if (!adminUsername || !restrictionType) {  
  return res.status(400).json({ error: "اطلاعات ناقص است" });  
}  

// Check if user is admin  
if (!await isAdmin(adminUsername)) {  
  return res.status(403).json({ error: "دسترسی غیرمجاز - فقط ادمین" });  
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

// Get admin user  
const adminRes = await pool.query(  
  "SELECT id FROM users WHERE username = $1",   
  [adminUsername]  
);  
  
const adminId = adminRes.rows[0].id;  

let blockedUntil = null;  
if (duration) {  
  blockedUntil = new Date(Date.now() + duration * 60 * 60 * 1000); // duration in hours  
}  

// Apply restriction  
const updateData = {};  
switch (restrictionType) {  
  case 'block':  
    updateData.is_blocked = true;  
    if (blockedUntil) updateData.blocked_until = blockedUntil;  
    break;  
  case 'limit_tweets':  
    updateData.tweet_limit = 1;  
    break;  
  case 'warn':  
    await pool.query(`  
      UPDATE user_restrictions   
      SET warning_count = COALESCE(warning_count, 0) + 1  
      WHERE user_id = $1  
    `, [targetUserId]);  
    break;  
  case 'disable_stories':  
    updateData.can_post_story = false;  
    break;  
}  

if (Object.keys(updateData).length > 0) {  
  await pool.query(`  
    INSERT INTO user_restrictions (user_id, ${Object.keys(updateData).join(', ')})  
    VALUES ($1, ${Object.keys(updateData).map((_, i) => `$${i + 2}`).join(', ')})  
    ON CONFLICT (user_id) DO UPDATE SET  
      ${Object.keys(updateData).map(key => `${key} = EXCLUDED.${key}`).join(', ')}  
  `, [targetUserId, ...Object.values(updateData)]);  
}  

// Log admin action  
await pool.query(`  
  INSERT INTO admin_actions (admin_id, target_user_id, action_type, details)  
  VALUES ($1, $2, 'USER_RESTRICTION', $3)  
`, [adminId, targetUserId, JSON.stringify({  
  restriction_type: restrictionType,  
  duration: duration,  
  reason: reason,  
  applied_at: new Date().toISOString(),  
  blocked_until: blockedUntil  
})]);  

// Notify user  
const restrictionMessages = {  
  'block': 'حساب شما به طور موقت مسدود شده است',  
  'limit_tweets': 'محدودیت ارسال توییت برای شما اعمال شده است',  
  'warn': 'هشدار از سوی مدیریت دریافت کردید',  
  'disable_stories': 'امکان ارسال استوری برای شما غیرفعال شد'  
};  

await pool.query(`  
  INSERT INTO notifications (recipient_id, sender_id, type, content)  
  VALUES ($1, $2, 'ADMIN_ACTION', $3)  
`, [  
  targetUserId,  
  adminId,  
  `${restrictionMessages[restrictionType]}. دلیل: ${reason || 'تخطی از قوانین'}`  
]);  

// Send realtime notification  
io.to(`user_${targetUserId}`).emit('notification_alert', {  
  type: 'ADMIN_ACTION',  
  message: restrictionMessages[restrictionType],  
  action: 'user_restricted',  
  restriction_type: restrictionType  
});  

res.json({   
  success: true,   
  message: `User restricted successfully (${restrictionType})`,  
  restriction: restrictionType,  
  duration: duration  
});

} catch (error) {
console.error("Admin restrict user error:", error);
res.status(500).json({ error: 'Internal server error' });
}
});

// Admin: Remove Restriction
app.post('/api/admin/users/:username/unrestrict', async (req, res) => {
try {
const targetUsername = req.params.username;
const { adminUsername } = req.body;

if (!adminUsername) {  
  return res.status(400).json({ error: "نام کاربری ادمین الزامی است" });  
}  

// Check if user is admin  
if (!await isAdmin(adminUsername)) {  
  return res.status(403).json({ error: "دسترسی غیرمجاز - فقط ادمین" });  
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

// Get admin user  
const adminRes = await pool.query(  
  "SELECT id FROM users WHERE username = $1",   
  [adminUsername]  
);  
  
const adminId = adminRes.rows[0].id;  

// Remove restrictions  
await pool.query(`  
  UPDATE user_restrictions   
  SET   
    is_blocked = false,  
    blocked_until = null,  
    tweet_limit = 3,  
    can_post_story = true  
  WHERE user_id = $1  
`, [targetUserId]);  

// Log admin action  
await pool.query(`  
  INSERT INTO admin_actions (admin_id, target_user_id, action_type, details)  
  VALUES ($1, $2, 'USER_UNRESTRICT', $3)  
`, [adminId, targetUserId, JSON.stringify({  
  unrestricted_at: new Date().toISOString()  
})]);  

// Notify user  
await pool.query(`  
  INSERT INTO notifications (recipient_id, sender_id, type, content)  
  VALUES ($1, $2, 'ADMIN_ACTION', 'تمام محدودیت‌های حساب شما برداشته شد.')  
`, [targetUserId, adminId]);  

// Send realtime notification  
io.to(`user_${targetUserId}`).emit('notification_alert', {  
  type: 'ADMIN_ACTION',  
  message: 'تمام محدودیت‌های حساب شما برداشته شد.',  
  action: 'user_unrestricted'  
});  

res.json({   
  success: true,   
  message: "All user restrictions removed successfully"  
});

} catch (error) {
console.error("Admin unrestrict user error:", error);
res.status(500).json({ error: 'Internal server error' });
}
});

// Admin: Grant Story Permission
app.post('/api/admin/users/:username/grant-story', async (req, res) => {
try {
const targetUsername = req.params.username;
const { adminUsername } = req.body;

if (!adminUsername) {  
  return res.status(400).json({ error: "نام کاربری ادمین الزامی است" });  
}  

// Check if user is admin  
if (!await isAdmin(adminUsername)) {  
  return res.status(403).json({ error: "دسترسی غیرمجاز - فقط ادمین" });  
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
  ON CONFLICT (user_id) DO UPDATE SET  
    can_post_story = true  
`, [targetUserId]);  

// Notify user  
await pool.query(`  
  INSERT INTO notifications (recipient_id, sender_id, type, content)  
  VALUES ($1, (SELECT id FROM users WHERE username = $2), 'STORY_PERMISSION', 'امکان ارسال استوری برای شما فعال شد!')  
`, [targetUserId, adminUsername]);  

// Send realtime notification  
io.to(`user_${targetUserId}`).emit('notification_alert', {  
  type: 'STORY_PERMISSION',  
  message: 'امکان ارسال استوری برای شما فعال شد!'  
});  

res.json({   
  success: true,   
  message: "Story permission granted successfully"  
});

} catch (error) {
console.error("Grant story permission error:", error);
res.status(500).json({ error: 'Internal server error' });
}
});

// --- TRENDING TOPICS ---

app.get('/api/trending', async (req, res) => {
try {
const { limit = 10 } = req.query;

const result = await pool.query(`  
  SELECT   
    hashtag,   
    tweet_count,  
    last_activity,  
    (SELECT COUNT(*) FROM tweets   
     WHERE content ILIKE '%#' || hashtag || '%'   
     AND created_at > NOW() - INTERVAL '24 hours') as recent_tweets  
  FROM trending_topics   
  ORDER BY tweet_count DESC, last_activity DESC   
  LIMIT $1  
`, [limit]);  
  
res.json(result.rows);

} catch (error) {
console.error("Trending topics error:", error);
res.status(500).json({ error: 'Internal server error' });
}
});

// --- USER STATS ---

app.get('/api/users/:username/stats', async (req, res) => {
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

const [  
  tweetStats,  
  engagementStats,  
  storyStats  
] = await Promise.all([  
  pool.query(`  
    SELECT   
      COUNT(*) as total_tweets,  
      COUNT(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 END) as tweets_today,  
      COALESCE(SUM(likes_count), 0) as total_likes,  
      AVG(LENGTH(content)) as avg_tweet_length  
    FROM tweets   
    WHERE user_id = $1  
  `, [userId]),  
    
  pool.query(`  
    SELECT   
      (SELECT COUNT(*) FROM likes WHERE user_id = $1) as likes_given,  
      (SELECT COUNT(*) FROM retweets WHERE user_id = $1) as retweets_given,  
      (SELECT COUNT(*) FROM bookmarks WHERE user_id = $1) as bookmarks_made  
  `, [userId]),  
    
  pool.query(`  
    SELECT   
      COUNT(*) as total_stories,  
      COALESCE(SUM(views_count), 0) as total_story_views,  
      AVG(views_count) as avg_story_views  
    FROM stories   
    WHERE user_id = $1 AND is_active = false  
  `, [userId])  
]);  

res.json({  
  tweet_stats: tweetStats.rows[0],  
  engagement_stats: engagementStats.rows[0],  
  story_stats: storyStats.rows[0]  
});

} catch (error) {
console.error("User stats error:", error);
res.status(500).json({ error: 'Internal server error' });
}
});

// ======================================================
// 4. SOCKET.IO LOGIC (Enhanced)
// ======================================================

const userSocketMap = new Map();

io.on('connection', (socket) => {
console.log('🔌 New connection:', socket.id);

// Register user
socket.on('register_user', async (username) => {
try {
if (!username || typeof username !== 'string') return;

const res = await pool.query(  
    "SELECT id, verification FROM users WHERE username = $1",   
    [username]  
  );  
    
  if (res.rows.length > 0) {  
    const userId = res.rows[0].id;  
    socket.join(`user_${userId}`);  
    socket.data.userId = userId;  
    socket.data.username = username;  
    socket.data.verification = res.rows[0].verification;  
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

// Join tweet thread room
socket.on('join_tweet_thread', (tweetId) => {
socket.join(tweet_${tweetId});
console.log(🧵 User joined tweet thread: ${tweetId});
});

// Leave tweet thread room
socket.on('leave_tweet_thread', (tweetId) => {
socket.leave(tweet_${tweetId});
console.log(👋 User left tweet thread: ${tweetId});
});

// Send reply to tweet thread
socket.on('send_tweet_reply', async (data) => {
const { tweetId, username, content } = data;

if (!content || !tweetId || !username) return;  
  
const cleanContent = content.trim();  
if (!cleanContent) return;  

try {  
  const userRes = await pool.query(  
    "SELECT id, display_name, avatar_url, verification FROM users WHERE username = $1",   
    [username]  
  );  
    
  if (userRes.rows.length > 0) {  
    const user = userRes.rows[0];  
      
    // Check if user can post tweet  
    const canPost = await canUserPostTweet(username);  
    if (!canPost.canPost) {  
      socket.emit('tweet_error', {   
        error: canPost.reason,  
        limit: canPost.limit,  
        used: canPost.used  
      });  
      return;  
    }  

    // Insert reply  
    const replyRes = await pool.query(  
      `INSERT INTO tweets (user_id, content, parent_id)   
       VALUES ($1, $2, $3)   
       RETURNING id, content, created_at, likes_count`,  
      [user.id, cleanContent, tweetId]  
    );  

    const reply = {  
      id: replyRes.rows[0].id,  
      username: username,  
      display_name: user.display_name,  
      content: cleanContent,  
      avatar: user.avatar_url,  
      verification: user.verification,  
      created_at: replyRes.rows[0].created_at,  
      likes_count: 0,  
      reply_count: 0,  
      has_liked: false,  
      has_retweeted: false,  
      has_bookmarked: false  
    };  

    // Increment tweet count for non-verified users  
    if (!user.verification) {  
      await incrementTweetCount(user.id);  
    }  

    // Broadcast to tweet thread room  
    io.to(`tweet_${tweetId}`).emit('new_tweet_reply', {  
      tweet_id: tweetId,  
      reply: reply  
    });  
      
    console.log(`💬 Reply sent to tweet ${tweetId} by ${username}`);  
  }  
} catch (err) {   
  console.error("Tweet Reply Socket Error:", err.message);   
  socket.emit('tweet_error', { error: 'خطا در ارسال پاسخ' });  
}

});

// (Previous socket handlers remain the same...)
// ... [rest of the socket handlers from original code]

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
// 5. ERROR HANDLING & SERVER START
// ======================================================

// Global Error Handler
app.use((err, req, res, next) => {
console.error('🔥 Global Error:', err.stack);
res.status(500).json({
error: 'Internal Server Error',
message: err.message
});
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
stories: 'GET /api/stories/active',
tweets: 'GET /api/tweets/feed',
tweet_thread: 'GET /api/tweets/:id/thread',
notifications: 'GET /api/notifications/:username',
dm: 'GET /api/dm/list/:username',
admin: 'GET /api/admin/dashboard',
reports: 'GET /api/reports',
trending: 'GET /api/trending'
}
});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
console.log(🚀 AJ Sports 2026 Backend v2.0 running on Port ${PORT});
console.log(📡 WebSocket ready at ws://localhost:${PORT});
console.log(🌐 API available at http://localhost:${PORT});
console.log(📊 Admin Panel: http://localhost:${PORT}/api/admin/dashboard?username=admin);
console.log(✨ New Features:);
console.log(   • 24-hour Instagram-like Stories);
console.log(   • Tweet Threads & Replies);
console.log(   • User Restrictions System);
console.log(   • Advanced Admin Panel);
console.log(   • Reporting System);
console.log(   • Trending Topics);
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
