-- ============================================================================
-- schema.sql — تعریف کامل و یکجای همه‌ی جدول‌های مورد نیاز server.js روی
-- Turso (SQLite/libSQL).
--
-- این فایل «منبع واحد حقیقت» (single source of truth) برای جدول‌های
-- غیرِ‌هسته‌ای است. جدول‌های هسته‌ای (users, tweets) از قبل روی Turso شما
-- وجود دارند و اینجا دوباره ساخته نمی‌شوند تا هیچ ریسکی برای داده‌های
-- موجودشان نباشد.
--
-- ✅ ۱۰۰٪ idempotent: هر بار اجرا شود (چه دستی، چه خودکار توسط سرور)،
--    فقط جدول/ایندکس‌های *غایب* را می‌سازد. جدول موجود دست‌نخورده می‌ماند.
-- ✅ اجرای خودکار: server.js با require('./ensure-schema') همین فایل را
--    در هر بار بالا آمدن سرور به‌صورت خودکار اجرا می‌کند — دیگر نیازی به
--    اجرای دستی SQL بعد از هر تغییر نیست.
-- ✅ ایمن برای حذف بعدی: اگر روزی schema.sql و ensure-schema.js را از
--    گیت‌هاب حذف کنید (بعد از این‌که مطمئن شدید همه‌چیز پایدار است)،
--    هیچ اتفاقی نمی‌افتد — چون تا آن موقع همه‌ی جدول‌ها از قبل روی Turso
--    ساخته شده‌اند و db.js/server.js هیچ وابستگی دیگری به این دو فایل
--    ندارند. کافی است همان‌جا خط require را هم از server.js پاک کنید.
--
-- منبع هر جدول: استخراج مو‌به‌مو از تمام INSERT/UPDATE/SELECT های server.js
-- (با grep روی هر ارجاع به هر جدول در کل فایل، نه حدس).
-- ============================================================================

-- ───────────────────────── چت گروهی زنده (رفع مشکل قبلی) ───────────────────
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  content    TEXT NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  match_id   TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_match_id ON messages(match_id);

-- ───────────────────────── چت خصوصی (رفع مشکل قبلی) ─────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user1_id     INTEGER NOT NULL REFERENCES users(id),
  user2_id     INTEGER NOT NULL REFERENCES users(id),
  last_message TEXT DEFAULT '',
  hidden_for   TEXT DEFAULT '[]',
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_conversations_user1 ON conversations(user1_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user2 ON conversations(user2_id);

CREATE TABLE IF NOT EXISTS direct_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  sender_id       INTEGER NOT NULL REFERENCES users(id),
  content         TEXT NOT NULL,
  read            INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dm_conversation_id ON direct_messages(conversation_id);

CREATE TABLE IF NOT EXISTS blocks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_id INTEGER NOT NULL REFERENCES users(id),
  blocked_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ───────────────────────── نشانک‌ها، نوتیفیکیشن، لایک، ریتوییت (رفع مشکل قبلی) ─
CREATE TABLE IF NOT EXISTS bookmarks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  tweet_id   INTEGER NOT NULL REFERENCES tweets(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, tweet_id)
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);

CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id INTEGER NOT NULL REFERENCES users(id),
  sender_id    INTEGER REFERENCES users(id),
  type         TEXT NOT NULL,
  reference_id INTEGER,
  content      TEXT,
  read         INTEGER DEFAULT 0,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id);

CREATE TABLE IF NOT EXISTS likes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id   INTEGER NOT NULL REFERENCES tweets(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tweet_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_tweet ON likes(tweet_id);
CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id);

CREATE TABLE IF NOT EXISTS retweets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id   INTEGER NOT NULL REFERENCES tweets(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tweet_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_retweets_tweet ON retweets(tweet_id);

-- ───────────────────────── فالو ────────────────────────────────────────────
-- منبع: app.post('/api/follow')، شمارش followers_count/following_count
CREATE TABLE IF NOT EXISTS follows (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  follower_id  INTEGER NOT NULL REFERENCES users(id),
  following_id INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(follower_id, following_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);

-- ───────────────────────── استوری‌ها ────────────────────────────────────────
-- منبع: app.post('/api/stories'), app.get('/api/stories/following/:username')
CREATE TABLE IF NOT EXISTS stories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  type       TEXT NOT NULL,
  media_url  TEXT,
  text       TEXT,
  text_color TEXT,
  music      TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_stories_user ON stories(user_id);

-- ───────────────────────── کشور کاربر (برای IP/کشور) ────────────────────────
-- منبع: هندلر ثبت کشور کاربر — از ON CONFLICT (user_id) استفاده می‌کند،
-- پس user_id باید UNIQUE باشد.
CREATE TABLE IF NOT EXISTS user_country (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL UNIQUE REFERENCES users(id),
  country_code TEXT,
  country_name TEXT,
  ip_address   TEXT,
  last_seen    TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ───────────────────────── نشست‌های کاربر (تنظیمات امنیتی/دستگاه‌ها) ────────
-- منبع: هندلرهای session — از ON CONFLICT (session_token) استفاده می‌کند.
CREATE TABLE IF NOT EXISTS user_sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  session_token  TEXT NOT NULL UNIQUE,
  device_info    TEXT DEFAULT '{}',
  ip_address     TEXT,
  country_code   TEXT DEFAULT 'IR',
  country_name   TEXT DEFAULT 'ایران',
  city           TEXT DEFAULT 'تهران',
  is_active      INTEGER DEFAULT 1,
  last_activity  TEXT DEFAULT CURRENT_TIMESTAMP,
  created_at     TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

-- ───────────────────────── غیرفعال‌سازی/حذف حساب ────────────────────────────
CREATE TABLE IF NOT EXISTS account_deactivation_requests (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id),
  username              TEXT,
  email                 TEXT,
  otp_expires_at        TEXT,
  otp_verified          INTEGER DEFAULT 0,
  status                TEXT DEFAULT 'pending',
  deactivation_date     TEXT,
  permanent_delete_date TEXT,
  cancelled_at          TEXT,
  created_at            TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_adr_user ON account_deactivation_requests(user_id);

-- ───────────────────────── کش تیم/بازیکنان فوتبال ───────────────────────────
CREATE TABLE IF NOT EXISTS football_teams_cache (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    TEXT NOT NULL UNIQUE,
  name       TEXT,
  logo       TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS football_players_cache (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id  TEXT NOT NULL UNIQUE,
  name       TEXT,
  photo      TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ───────────────────────── روم‌های مسابقه‌ی زنده ─────────────────────────────
-- ⚠️ نکته: در کل server.js فقط SELECT از این جدول دیده می‌شود (هیچ INSERT
-- ای برایش پیدا نشد)، پس این جدول احتمالاً باید از بیرون (کرون‌جاب/پنل ادمین
-- که کد آن اینجا نیست) پر شود. ستون‌های زیر بر مبنای بهترین برآورد از
-- WHERE status='LIVE' ORDER BY created_at ساخته شده‌اند — اگر پنل ادمین شما
-- ستون‌های دیگری هم لازم دارد (مثلاً home_team/away_team)، با ALTER TABLE
-- ADD COLUMN IF NOT EXISTS اضافه‌شان کنید.
CREATE TABLE IF NOT EXISTS match_rooms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id   TEXT,
  status     TEXT DEFAULT 'LIVE',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ───────────────────────── نظرسنجی‌ها (server.js خودش هم می‌سازد؛ اینجا فقط
-- برای کامل بودن سند تکرار شده — کاملاً بی‌خطر) ──────────────────────────────
CREATE TABLE IF NOT EXISTS polls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id   INTEGER NOT NULL REFERENCES tweets(id) ON DELETE CASCADE,
  question   TEXT NOT NULL,
  options    TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_polls_tweet ON polls(tweet_id);
CREATE INDEX IF NOT EXISTS idx_polls_expires ON polls(expires_at);

CREATE TABLE IF NOT EXISTS poll_votes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id      INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(poll_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id);

-- ───────────────────────── پنل ادمین (server.js خودش هم می‌سازد؛ تکرار
-- بی‌خطر برای کامل بودن سند) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_action_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id    INTEGER,
  action_type TEXT,
  target_type TEXT,
  target_id   TEXT,
  details     TEXT,
  ip_address  TEXT,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_warnings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  admin_id   INTEGER,
  reason     TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id  INTEGER REFERENCES users(id),
  target_type  TEXT,
  target_id    TEXT,
  reason       TEXT,
  status       TEXT DEFAULT 'pending',
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP
);
