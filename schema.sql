-- Reading Tracker Bot - Postgres Schema (Railway)

CREATE TABLE IF NOT EXISTS children (
  id SERIAL PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(telegram_user_id, name)
);

CREATE TABLE IF NOT EXISTS sessions (
  telegram_user_id TEXT PRIMARY KEY,
  active_child_id INTEGER,
  mode TEXT DEFAULT 'idle',
  quiz_book_title TEXT,
  quiz_chapter INTEGER,
  quiz_questions_json TEXT,
  quiz_current_index INTEGER DEFAULT 0,
  quiz_correct_count INTEGER DEFAULT 0,
  quiz_answers_json TEXT
);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS quiz_book_type TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS quiz_author TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS quiz_page INTEGER;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS quiz_found BOOLEAN;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS quiz_page_range TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS quiz_photos_json TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pending_action TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pending_message TEXT;

CREATE TABLE IF NOT EXISTS books (
  id SERIAL PRIMARY KEY,
  child_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT DEFAULT 'in_progress',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(child_id, title)
);

ALTER TABLE books ADD COLUMN IF NOT EXISTS last_page_range TEXT;
ALTER TABLE books ADD COLUMN IF NOT EXISTS last_page INTEGER;
ALTER TABLE books ADD COLUMN IF NOT EXISTS author TEXT;
ALTER TABLE books ADD COLUMN IF NOT EXISTS found_online BOOLEAN;
ALTER TABLE books ADD COLUMN IF NOT EXISTS book_type TEXT;
ALTER TABLE books ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE books ADD COLUMN IF NOT EXISTS total_pages INTEGER;

CREATE TABLE IF NOT EXISTS chapter_records (
  id SERIAL PRIMARY KEY,
  child_id INTEGER NOT NULL,
  book_title TEXT NOT NULL,
  chapter_number INTEGER NOT NULL,
  score_percent INTEGER NOT NULL,
  passed BOOLEAN NOT NULL,
  attempt_number INTEGER DEFAULT 1,
  date TIMESTAMP DEFAULT NOW()
);

ALTER TABLE chapter_records ADD COLUMN IF NOT EXISTS questions_json TEXT;

CREATE TABLE IF NOT EXISTS explain_log (
  id SERIAL PRIMARY KEY,
  child_id INTEGER,
  content_type TEXT,
  query_text TEXT,
  response_text TEXT,
  date TIMESTAMP DEFAULT NOW()
);
