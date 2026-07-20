import "dotenv/config";
import express from "express";
import { query, pool } from "./db.js";

const app = express();
app.use(express.json());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

for (const [name, val] of [
  ["TELEGRAM_BOT_TOKEN", TELEGRAM_BOT_TOKEN],
  ["ANTHROPIC_API_KEY", ANTHROPIC_API_KEY],
  ["DATABASE_URL", process.env.DATABASE_URL],
]) {
  console.log(val ? `✅ ${name} is set` : `❌ ${name} is MISSING — check your .env file or environment variables`);
}

// Safety nets: log and keep running instead of letting the whole bot crash or hang on a
// transient/unexpected error (e.g. a rejected promise nobody awaited).
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (handled, not crashing):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (handled, not crashing):", err);
});

const PASS_THRESHOLD = 70;
const TARGET_AGE = "10-11 years old (roughly grade 5-6)";
const QUESTIONS_PER_QUIZ = 10;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const MIN_PAGES_BIG_BOOK = 5;
const RESUME_PAGE_INCREMENT = 5;

const MENU = {
  WORD: "📖 Word Meaning",
  PASSAGE: "📝 Passage Meaning",
  QUIZ: "🧠 Quiz",
};
const RESUME = {
  YES: "✅ Yes, quiz me",
  NOT_YET: "📖 Not yet",
  FINISHED: "🏁 I finished this book",
};
const FINISHED = {
  YES: "✅ Yes, I finished it",
  NO: "📖 No, still reading",
};

// Fixed set of children — pre-registered on /start, selected via buttons.
const CHILD_NAMES = ["Hanifa", "Ismail"];

const mainMenuKeyboard = { keyboard: [[MENU.WORD, MENU.PASSAGE], [MENU.QUIZ]], resize_keyboard: true };
const resumeKeyboard = { keyboard: [[RESUME.YES], [RESUME.NOT_YET], [RESUME.FINISHED]], resize_keyboard: true, one_time_keyboard: true };
const childKeyboard = { keyboard: [CHILD_NAMES], resize_keyboard: true, one_time_keyboard: true };
const finishedKeyboard = { keyboard: [[FINISHED.YES], [FINISHED.NO]], resize_keyboard: true, one_time_keyboard: true };

// ---------- Telegram helpers ----------

// Generic timeout wrapper — ANY outbound network call in this bot must go through
// something like this. A stalled connection (Telegram, Claude, anything) must never be
// able to hang the whole bot indefinitely.
async function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function tg(method, params) {
  let res;
  try {
    res = await fetchWithTimeout(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
  } catch (err) {
    console.error(`Telegram API call to ${method} failed/timed out:`, err.message);
    return { ok: false, error: err.message };
  }
  const data = await res.json();
  if (!data.ok) {
    console.error(`Telegram API error on ${method}:`, JSON.stringify(data), "params:", JSON.stringify(params));
  }
  return data;
}

function sendText(chatId, text, replyMarkup) {
  const params = { chat_id: chatId, text };
  if (replyMarkup) params.reply_markup = replyMarkup;
  return tg("sendMessage", params);
}

function sendMenu(chatId, text) {
  return sendText(chatId, text, mainMenuKeyboard);
}

async function getTelegramFileBase64(fileId) {
  const fileInfo = await tg("getFile", { file_id: fileId });
  const filePath = fileInfo?.result?.file_path;
  if (!filePath) throw new Error("Could not get file path from Telegram");
  const fileRes = await fetchWithTimeout(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`, {}, 25000);
  const buf = await fileRes.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}

// Telegram sends each photo as several sizes, smallest to largest. The largest is often
// much bigger than needed for reading text and slows down/risks-timing-out the Claude call
// (especially with several page photos in one request) — the second-largest is still very
// legible for OCR-style reading while being significantly smaller.
function pickPhotoSize(photoArray) {
  if (photoArray.length >= 2) return photoArray[photoArray.length - 2];
  return photoArray[photoArray.length - 1];
}

// ---------- Claude API helpers ----------

async function callClaude(messages, maxTokens = 1024, tools = null, attempt = 1) {
  const body = { model: CLAUDE_MODEL, max_tokens: maxTokens, messages };
  if (tools) body.tools = tools;

  const controller = new AbortController();
  const timeoutMs = 75000; // hard cap — a stalled connection must not hang the bot forever
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err.name === "AbortError";
    console.error(`Claude API ${isTimeout ? "TIMED OUT" : "network error"} (attempt ${attempt}):`, err.message);
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      return callClaude(messages, maxTokens, tools, attempt + 1);
    }
    return null;
  }
  clearTimeout(timeoutId);

  const data = await res.json();
  if (data.content) {
    return data.content.map((b) => b.text || "").join("\n").trim();
  }

  const errorType = data.error?.type || "unknown_error";
  const errorMessage = data.error?.message || JSON.stringify(data);
  console.error(`Claude API error (attempt ${attempt}, status ${res.status}): [${errorType}] ${errorMessage}`);

  // Retry once on transient errors (overload / rate limit / server-side 5xx).
  const retriable = ["overloaded_error", "rate_limit_error", "api_error"].includes(errorType) || res.status >= 500;
  if (retriable && attempt < 3) {
    await new Promise((r) => setTimeout(r, 1500 * attempt));
    return callClaude(messages, maxTokens, tools, attempt + 1);
  }

  return null;
}

async function explainText(text, isPassage) {
  const kind = isPassage ? "passage" : "word";
  const prompt = `You are a friendly reading tutor for a child who is ${TARGET_AGE}. Explain the meaning of the following ${kind} in simple, age-appropriate English for that age group — everyday vocabulary they'd already know, short sentences. Keep it short (2-5 sentences), use an example if helpful.\n\nText: "${text}"`;
  return callClaude([{ role: "user", content: prompt }]);
}

async function explainImage(base64Image, mediaType, isPassage) {
  const kind = isPassage ? "passage" : "word";
  const prompt = `You are a friendly reading tutor for a child who is ${TARGET_AGE}. Look at this image (a ${kind} from a book). Explain its meaning in simple, age-appropriate English for that age group in 2-5 sentences.`;
  return callClaude([
    { role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
      { type: "text", text: prompt },
    ]},
  ]);
}

async function checkImageReadable(base64Image, mediaType, context) {
  const prompt = `Look at this photo${context ? ` (${context})` : ""}. Judge only image quality — is the text in it clearly legible (in focus, well lit, not cut off, not too small/blurry to read)? This is NOT about whether the content makes sense, only whether a human could read the words. Respond ONLY with valid JSON, no markdown fences, no preamble: {"readable": true, "reason": ""} or {"readable": false, "reason": "short child-friendly reason, e.g. 'the photo is too blurry' or 'it's too dark to read'"}.`;
  const raw = await callClaude([
    { role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
      { type: "text", text: prompt },
    ]},
  ], 300);
  if (!raw) return { readable: true, reason: "" }; // fail open — don't block a real photo on an API hiccup
  const clean = raw.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(clean);
    return { readable: parsed.readable !== false, reason: parsed.reason || "" };
  } catch (e) {
    console.error("Failed to parse readability JSON:", clean);
    return { readable: true, reason: "" }; // fail open so a parsing hiccup doesn't block a real photo
  }
}

async function extractBookInfo(base64Image, mediaType) {
  const prompt = 'Look at this photo of a book cover. Identify the title and author if visible. Respond ONLY with valid JSON, no markdown fences, no preamble: {"title": "...", "author": "..."} (use empty string for author if not visible/unknown).';
  const raw = await callClaude([
    { role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
      { type: "text", text: prompt },
    ]},
  ]);
  if (!raw) return { title: "Unknown book", author: "" };
  const clean = raw.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); } catch (e) {
    console.error("Failed to parse book info JSON:", clean);
    return { title: "Unknown book", author: "" };
  }
}

async function searchBookOnline(title, author) {
  const prompt = `Search the web for a real, identifiable, published book titled "${title}"${author ? ` by ${author}` : ""}.

This check has a strict purpose: I need to generate quiz questions about SPECIFIC content (facts, events, details) from particular pages of this book. Only say "found: true" if BOTH of these are true:
1. You can confirm via search that this specific book genuinely exists (not just a similar-sounding topic).
2. You are confident you know enough of its actual specific content — not just the general subject area — to write accurate, non-generic quiz questions about particular pages of it, without guessing or inventing plausible-sounding facts.

Many real books (especially children's non-fiction, workbooks, textbooks, self-published, or regional titles) exist but have little to no content indexed online — for these, you should say "found: false" even though the book itself is real, because you cannot reliably quiz on their specific content. When in doubt, prefer "found: false" — a false negative just means the child sends photos instead, which is safe; a false positive means the quiz could contain made-up facts, which is worse.

Respond ONLY with valid JSON, no markdown fences, no preamble: {"found": true, "title": "confirmed title", "author": "confirmed author or empty string"}`;
  const raw = await callClaude([{ role: "user", content: prompt }], 1500, [{ type: "web_search_20250305", name: "web_search" }]);
  if (!raw) return { found: false, title, author };
  const clean = raw.replace(/```json|```/g, "").trim();
  try {
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : clean);
  } catch (e) {
    console.error("Failed to parse book search JSON:", clean);
    return { found: false, title, author };
  }
}

async function getPreviousQuestions(childId, bookTitle) {
  const rows = await query(
    "SELECT questions_json FROM chapter_records WHERE child_id=$1 AND book_title=$2 ORDER BY date DESC LIMIT 1",
    [childId, bookTitle]
  );
  if (rows.length && rows[0].questions_json) {
    try { return JSON.parse(rows[0].questions_json); } catch (e) { return null; }
  }
  return null;
}

function avoidanceClause(previousQuestions) {
  if (!previousQuestions || !previousQuestions.length) return "";
  const list = previousQuestions.map((q) => `- ${q.question}`).join("\n");
  return `\n\nIMPORTANT: The child failed a previous attempt. Write a COMPLETELY DIFFERENT set of questions than these previously-asked ones (different angles, different details, do not just reword them):\n${list}`;
}

function difficultyClause(difficulty) {
  if (difficulty === "easy") {
    return `\n\nIMPORTANT — difficulty level: EASY, below the typical reading level for ${TARGET_AGE} (use this for a child who is still finding quizzes hard). Use very simple, short sentences for both questions and answer options. Ask only about clear, literal, directly-stated facts (who, what, where, simple sequence of events) — avoid inference, "why," theme, or "what does this suggest" style questions. Make the correct answer clearly distinguishable from the wrong options rather than subtly different.`;
  }
  if (difficulty === "hard") {
    return `\n\nIMPORTANT — difficulty level: HARD, above the typical reading level for ${TARGET_AGE} (use this for a child who is consistently acing quizzes at the normal level). Include some questions that require inference, connecting ideas across the passage, or understanding theme/motivation, not just literal recall — but keep the vocabulary itself still readable for this age, only the thinking should be harder.`;
  }
  return ""; // medium = the normal difficulty for this age group, no special instruction beyond the base prompt
}

async function generateQuizFromKnowledge(title, author, pageRange, previousQuestions, difficulty) {
  const scopeText = pageRange
    ? `They report having read: ${pageRange}.`
    : `They did not specify exact pages, so cover general content from the book.`;
  const prompt = `You are a reading comprehension teacher for a child who is ${TARGET_AGE}. They have been reading the book "${title}"${author ? ` by ${author}` : ""}. ${scopeText}

Using your knowledge of this book, write exactly ${QUESTIONS_PER_QUIZ} multiple-choice reading comprehension questions covering that portion of the book. Every question and its correct answer must be based on content you actually, specifically know from this book — never invent, guess, or generalize plausible-sounding plot details, facts, or figures. Phrase every question and answer option in vocabulary and sentence length natural for a ${TARGET_AGE} reader — no advanced or adult-level words where a simpler one works just as well.

If, being honest, you do not have specific enough knowledge of this book's actual content (this is common for children's non-fiction, workbooks, textbooks, or lesser-known titles even when the book itself is real) — do NOT invent a quiz. Instead respond with exactly: {"insufficient_knowledge": true}${avoidanceClause(previousQuestions)}${difficultyClause(difficulty)}

Otherwise, return ONLY valid JSON, no markdown fences, no preamble, in this exact format:
[
  {"question": "...", "options": {"A": "...", "B": "...", "C": "...", "D": "..."}, "correct": "A"},
  ...
]`;
  const raw = await callClaude([{ role: "user", content: prompt }], 2000);
  if (!raw) return null;
  const clean = raw.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(clean);
    if (parsed && parsed.insufficient_knowledge) return "INSUFFICIENT_KNOWLEDGE";
    return parsed;
  } catch (e) {
    console.error("Failed to parse quiz JSON:", clean);
    return null;
  }
}

async function generateQuizFromPagePhotos(images, title, previousQuestions, difficulty) {
  const content = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.base64 },
  }));
  content.push({
    type: "text",
    text: `These are photos of pages from the book "${title}" that a child who is ${TARGET_AGE} has read. Based ONLY on the actual text visible in these photos, write exactly ${QUESTIONS_PER_QUIZ} multiple-choice reading comprehension questions covering this content. If some text is unclear, focus questions on what is clearly readable. Phrase every question and answer option in vocabulary and sentence length natural for that age — no advanced or adult-level words where a simpler one works just as well.${avoidanceClause(previousQuestions)}${difficultyClause(difficulty)}

Return ONLY valid JSON, no markdown fences, no preamble, in this exact format:
[
  {"question": "...", "options": {"A": "...", "B": "...", "C": "...", "D": "..."}, "correct": "A"},
  ...
]`,
  });
  const raw = await callClaude([{ role: "user", content }], 3000);
  if (!raw) return null;
  const clean = raw.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); } catch (e) {
    console.error("Failed to parse quiz-from-photos JSON:", clean);
    return null;
  }
}

// ---------- Page range parsing ----------

function parsePageRange(text) {
  const m = text.match(/(\d+)\s*-\s*(\d+)/);
  if (m) {
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    if (!isNaN(start) && !isNaN(end) && end >= start) {
      return { start, end, span: end - start + 1 };
    }
  }
  const single = text.match(/(\d+)/);
  if (single) {
    const end = parseInt(single[1], 10);
    return { start: null, end, span: null };
  }
  return null;
}

// ---------- DB helpers ----------

async function getOrCreateSession(userId) {
  let rows = await query("SELECT * FROM sessions WHERE telegram_user_id = $1", [userId]);
  if (!rows.length) {
    await query("INSERT INTO sessions (telegram_user_id, mode) VALUES ($1, 'idle')", [userId]);
    rows = await query("SELECT * FROM sessions WHERE telegram_user_id = $1", [userId]);
  }
  return rows[0];
}

async function updateSession(userId, fields) {
  const keys = Object.keys(fields);
  const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const values = keys.map((k) => fields[k]);
  await query(`UPDATE sessions SET ${setClause} WHERE telegram_user_id = $${keys.length + 1}`, [...values, userId]);
}

async function getChildren(userId) {
  return query("SELECT * FROM children WHERE telegram_user_id = $1 ORDER BY name", [userId]);
}

// Registers the fixed set of children (Hanifa, Ismail) for this telegram user if not already present.
async function ensureChildren(userId) {
  for (const name of CHILD_NAMES) {
    await query(
      `INSERT INTO children (telegram_user_id, name) VALUES ($1, $2)
       ON CONFLICT (telegram_user_id, name) DO NOTHING`,
      [userId, name]
    );
  }
}

async function getChildByName(userId, name) {
  const rows = await query("SELECT * FROM children WHERE telegram_user_id=$1 AND name=$2", [userId, name]);
  return rows[0] || null;
}

// If the child has a book in progress, prompts them to confirm they've read the next chunk
// and puts the session into resume_check mode. Returns true if that prompt was sent.
async function checkResumeOrPrompt(chatId, userId, child) {
  const inProgress = await getInProgressBook(child.id);
  if (inProgress) {
    const rawNextEnd = (inProgress.last_page || 0) + RESUME_PAGE_INCREMENT;
    const nextEnd = inProgress.total_pages ? Math.min(rawNextEnd, inProgress.total_pages) : rawNextEnd;
    await updateSession(userId, { mode: "resume_check", quiz_book_title: inProgress.title });
    await sendText(
      chatId,
      `Welcome back, ${child.name}! You're at page ${inProgress.last_page || 0} of "${inProgress.title}". Have you read up to page ${nextEnd}? If you've finished the whole book already, tap "I finished this book" below.`,
      resumeKeyboard
    );
    return true;
  }
  return false;
}

async function getActiveChild(session) {
  if (!session.active_child_id) return null;
  const rows = await query("SELECT * FROM children WHERE id = $1", [session.active_child_id]);
  return rows[0] || null;
}

async function getInProgressBook(childId) {
  const rows = await query(
    "SELECT * FROM books WHERE child_id=$1 AND status='in_progress' ORDER BY updated_at DESC LIMIT 1",
    [childId]
  );
  return rows[0] || null;
}

async function upsertBookProgress(childId, title, { author, foundOnline, bookType, pageRangeText, lastPage, totalPages, lastPhotosJson } = {}) {
  const rows = await query(
    `INSERT INTO books (child_id, title, author, found_online, book_type, last_page_range, last_page, total_pages, last_photos_json, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (child_id, title) DO UPDATE SET
       author = COALESCE(EXCLUDED.author, books.author),
       found_online = COALESCE(EXCLUDED.found_online, books.found_online),
       book_type = COALESCE(EXCLUDED.book_type, books.book_type),
       last_page_range = COALESCE(EXCLUDED.last_page_range, books.last_page_range),
       last_page = COALESCE(EXCLUDED.last_page, books.last_page),
       total_pages = COALESCE(EXCLUDED.total_pages, books.total_pages),
       last_photos_json = CASE WHEN $9 IS NOT NULL OR $10 THEN $9 ELSE books.last_photos_json END,
       status = CASE
         WHEN COALESCE(EXCLUDED.total_pages, books.total_pages) IS NOT NULL
              AND COALESCE(EXCLUDED.last_page, books.last_page) >= COALESCE(EXCLUDED.total_pages, books.total_pages)
         THEN 'finished'
         ELSE books.status
       END,
       updated_at = NOW()
     RETURNING status`,
    [
      childId,
      title,
      author || null,
      foundOnline ?? null,
      bookType || null,
      pageRangeText || null,
      lastPage ?? null,
      totalPages ?? null,
      lastPhotosJson === undefined ? null : lastPhotosJson,
      lastPhotosJson === null, // explicit-clear flag: true only when caller passed null on purpose
    ]
  );
  return rows[0]?.status || "in_progress";
}

// ---------- Webhook route ----------

app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // ack Telegram immediately so it doesn't retry/duplicate the update
  try {
    await handleUpdate(req.body);
  } catch (err) {
    console.error("Error handling update:", err);
  }
});

app.get("/", (req, res) => res.send("Reading Tracker Bot is running."));

async function startQuizFromKnownBook(chatId, userId, activeChild, book) {
  await sendText(chatId, "Great! Generating your quiz, one moment...");
  const previousQuestions = await getPreviousQuestions(activeChild.id, book.title);
  const totalPages = book.total_pages || null;
  const priorLastPage = book.last_page || 0;

  if (book.found_online) {
    const rawNextEnd = priorLastPage + RESUME_PAGE_INCREMENT;
    const nextEnd = totalPages ? Math.min(rawNextEnd, totalPages) : rawNextEnd;
    const pageRange = `${priorLastPage + 1}-${nextEnd}`;
    const questions = await generateQuizFromKnowledge(book.title, book.author, pageRange, previousQuestions, activeChild.difficulty);

    if (questions === "INSUFFICIENT_KNOWLEDGE") {
      // Downgrade permanently — future sessions for this book skip straight to photos.
      await query("UPDATE books SET found_online=false WHERE id=$1", [book.id]);
      const requiredPhotos = totalPages ? Math.max(1, Math.min(MIN_PAGES_BIG_BOOK, totalPages - priorLastPage)) : MIN_PAGES_BIG_BOOK;
      await updateSession(userId, { mode: "quiz_collecting_photos", quiz_book_title: book.title, quiz_photos_json: "[]" });
      return sendText(
        chatId,
        `I don't know this book's specific content well enough, so I won't guess. Please send photos of the next pages you've read (at least ${requiredPhotos} page${requiredPhotos > 1 ? "s" : ""}). Type "done" when finished.`
      );
    }
    if (!questions || !questions.length) {
      await updateSession(userId, { mode: "idle" });
      return sendMenu(chatId, "Sorry, I couldn't generate a quiz right now. Please try 🧠 Quiz again.");
    }
    await updateSession(userId, {
      mode: "quiz",
      quiz_book_title: book.title,
      quiz_page_range: pageRange,
      quiz_pending_last_page: nextEnd,
      quiz_questions_json: JSON.stringify(questions),
      quiz_current_index: 0,
      quiz_correct_count: 0,
    });
    return askQuizQuestion(chatId, questions, 0);
  } else {
    const storedPhotos = book.last_photos_json ? JSON.parse(book.last_photos_json) : null;
    if (storedPhotos && storedPhotos.length) {
      // This page range was attempted before but not passed — regenerate fresh questions
      // from the SAME photos rather than asking the child to re-photograph the pages.
      const startPage = priorLastPage + 1;
      const endPage = totalPages ? Math.min(priorLastPage + storedPhotos.length, totalPages) : priorLastPage + storedPhotos.length;
      const pageRangeText = `${startPage}-${endPage}`;
      const questions = await generateQuizFromPagePhotos(storedPhotos, book.title, previousQuestions, activeChild.difficulty);
      if (!questions || !questions.length) {
        await updateSession(userId, { mode: "idle" });
        return sendMenu(chatId, "Sorry, I couldn't generate a quiz right now. Please try 🧠 Quiz again.");
      }
      await updateSession(userId, {
        mode: "quiz",
        quiz_book_title: book.title,
        quiz_page_range: pageRangeText,
        quiz_pending_last_page: endPage,
        quiz_questions_json: JSON.stringify(questions),
        quiz_current_index: 0,
        quiz_correct_count: 0,
      });
      return askQuizQuestion(chatId, questions, 0);
    }
    const requiredPhotos = totalPages ? Math.max(1, Math.min(MIN_PAGES_BIG_BOOK, totalPages - priorLastPage)) : MIN_PAGES_BIG_BOOK;
    await updateSession(userId, {
      mode: "quiz_collecting_photos",
      quiz_book_title: book.title,
      quiz_photos_json: "[]",
    });
    return sendText(
      chatId,
      `Please send photos of the next pages you've read, one by one (at least ${requiredPhotos} page${requiredPhotos > 1 ? "s" : ""}). Type "done" when finished.`
    );
  }
}

async function proceedPastTotalPages(chatId, userId, childId, bookTitle, found) {
  const rows = await query("SELECT total_pages FROM books WHERE child_id=$1 AND title=$2", [childId, bookTitle]);
  const totalPages = rows[0]?.total_pages || null;
  if (found) {
    await updateSession(userId, { mode: "quiz_awaiting_pages" });
    const hint = totalPages ? ` (this book has ${totalPages} pages total)` : "";
    return sendText(chatId, `"${bookTitle}" — which pages have you read?${hint}`);
  } else {
    const requiredPhotos = totalPages ? Math.min(MIN_PAGES_BIG_BOOK, totalPages) : MIN_PAGES_BIG_BOOK;
    await updateSession(userId, { mode: "quiz_collecting_photos", quiz_photos_json: "[]" });
    return sendText(
      chatId,
      `Now send photos of the pages you've read, one by one (at least ${requiredPhotos} page${requiredPhotos > 1 ? "s" : ""}). Type "done" when finished.`
    );
  }
}

// Verifies the child has actually passed quizzes covering the whole book (based on the
// total page count recorded when the book was added) before marking it finished.
async function confirmBookFinished(chatId, userId, activeChild, bookTitle) {
  const rows = await query("SELECT * FROM books WHERE child_id=$1 AND title=$2", [activeChild.id, bookTitle]);
  const book = rows[0];
  await updateSession(userId, { mode: "idle", pending_message: null });
  if (!book) {
    return sendMenu(chatId, "Hmm, I lost track of that book. Please use 🧠 Quiz to start again.");
  }
  const lastPage = book.last_page || 0;
  if (book.total_pages && lastPage < book.total_pages) {
    return sendMenu(
      chatId,
      `Not quite yet — ${activeChild.name} has only passed quizzes up through page ${lastPage} of ${book.total_pages} total pages in "${bookTitle}". Let's finish quizzing the rest first — tap 🧠 Quiz to continue from where you left off.`
    );
  }
  await query("UPDATE books SET status='finished', updated_at=NOW() WHERE id=$1", [book.id]);
  return sendMenu(chatId, `🏁 "${bookTitle}" marked as finished. Great job, ${activeChild.name}! 🎉`);
}

async function finishPhotoQuiz(chatId, userId, activeChild, session, photos) {
  const books = await query("SELECT total_pages, last_page FROM books WHERE child_id=$1 AND title=$2", [activeChild.id, session.quiz_book_title]);
  const book = books[0];
  const totalPages = book?.total_pages || null;
  const priorLastPage = book?.last_page || 0;
  const startPage = priorLastPage + 1;
  const endPage = totalPages ? Math.min(priorLastPage + photos.length, totalPages) : priorLastPage + photos.length;
  const pageRangeText = `${startPage}-${endPage}`;

  await sendText(chatId, "Got all the pages — generating your quiz now, one moment...");
  const previousQuestions = await getPreviousQuestions(activeChild.id, session.quiz_book_title);
  const questions = await generateQuizFromPagePhotos(photos, session.quiz_book_title, previousQuestions, activeChild.difficulty);
  if (!questions || !questions.length) {
    await updateSession(userId, { mode: "idle", quiz_photos_json: null });
    return sendMenu(chatId, "Sorry, I couldn't generate a quiz from those photos. Please try 🧠 Quiz again.");
  }
  // Save the photos on the book itself (not just the session) — if the child fails this
  // quiz, we can regenerate fresh questions from the SAME photos without re-asking for them.
  await upsertBookProgress(activeChild.id, session.quiz_book_title, { lastPhotosJson: JSON.stringify(photos) });
  await updateSession(userId, {
    mode: "quiz",
    quiz_page_range: pageRangeText,
    quiz_pending_last_page: endPage,
    quiz_questions_json: JSON.stringify(questions),
    quiz_current_index: 0,
    quiz_correct_count: 0,
    quiz_photos_json: null,
  });
  return askQuizQuestion(chatId, questions, 0);
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message) return;
  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const session = await getOrCreateSession(userId);
  const text = message.text?.trim();
  console.log(`[update] userId=${userId} text=${JSON.stringify(text)} session.mode=${session.mode} active_child_id=${session.active_child_id}`);

  if (text?.startsWith("/start")) {
    await ensureChildren(userId);
    await updateSession(userId, { mode: "awaiting_child_select", pending_action: null });
    return sendText(
      chatId,
      "📚 Welcome to the Reading Tracker Bot!\n\nWho are we working with?",
      childKeyboard
    );
  }

  if (text?.startsWith("/addchild")) {
    const name = text.replace("/addchild", "").trim();
    if (!name) return sendText(chatId, "Usage: /addchild <name>");
    try {
      await query("INSERT INTO children (telegram_user_id, name) VALUES ($1, $2)", [userId, name]);
      const rows = await query("SELECT id FROM children WHERE telegram_user_id=$1 AND name=$2", [userId, name]);
      await updateSession(userId, { active_child_id: rows[0].id, mode: "idle" });
      return sendMenu(chatId, `✅ Added child "${name}" and set as active.`);
    } catch (e) {
      return sendText(chatId, `Could not add (maybe "${name}" already exists?).`);
    }
  }

  if (text?.startsWith("/children")) {
    const kids = await getChildren(userId);
    if (!kids.length) return sendText(chatId, "No children added yet. Use /addchild <name>.");
    return sendText(chatId, "👨‍👩‍👧‍👦 Children:\n" + kids.map((k) => `- ${k.name}`).join("\n"));
  }

  if (text?.startsWith("/use")) {
    const name = text.replace("/use", "").trim();
    const rows = await query("SELECT * FROM children WHERE telegram_user_id=$1 AND name=$2", [userId, name]);
    if (!rows.length) return sendText(chatId, `No child named "${name}". Try /children.`);
    const child = rows[0];
    await updateSession(userId, { active_child_id: child.id, mode: "idle" });

    if (!(await checkResumeOrPrompt(chatId, userId, child))) {
      return sendMenu(chatId, `✅ Active child set to "${name}".`);
    }
    return;
  }

  const activeChild = await getActiveChild(session);

  if (text?.startsWith("/setlevel")) {
    const level = text.replace("/setlevel", "").trim().toLowerCase();
    if (!["easy", "medium", "hard"].includes(level)) {
      return sendText(chatId, 'Usage: /setlevel easy | medium | hard (applies to the currently active child)');
    }
    if (!activeChild) return sendText(chatId, "No active child selected. Tap a child's name first (or /use <name>), then try again.");
    await query("UPDATE children SET difficulty=$1 WHERE id=$2", [level, activeChild.id]);
    return sendMenu(chatId, `✅ Quiz difficulty for ${activeChild.name} set to "${level}". This applies to their next quiz.`);
  }

  if (text?.startsWith("/status")) {
    if (!activeChild) return sendText(chatId, "No active child. Use /use <name> first.");
    const books = await query("SELECT title, last_page, last_page_range, total_pages, status FROM books WHERE child_id=$1 ORDER BY updated_at DESC", [activeChild.id]);
    const rows = await query(
      "SELECT book_title, score_percent, passed, date FROM chapter_records WHERE child_id=$1 ORDER BY date DESC LIMIT 10",
      [activeChild.id]
    );
    let out = `📚 Books for ${activeChild.name}:\n`;
    out += books.length
      ? books.map((b) => `${b.status === "finished" ? "✅" : "📖"} ${b.title}${b.last_page ? ` (at page ${b.last_page}${b.total_pages ? `/${b.total_pages}` : ""})` : ""}`).join("\n")
      : "None yet.";
    out += `\n\n📊 Recent quiz scores:\n`;
    out += rows.length
      ? rows.map((r) => `${r.book_title}: ${r.score_percent}% ${r.passed ? "✅ Passed" : "❌ Failed"} (${new Date(r.date).toLocaleDateString()})`).join("\n")
      : "None yet.";
    return sendText(chatId, out);
  }

  if (text?.startsWith("/report")) {
    const name = text.replace("/report", "").trim() || activeChild?.name;
    const rows = await query("SELECT * FROM children WHERE telegram_user_id=$1 AND name=$2", [userId, name]);
    const child = rows[0];
    if (!child) return sendText(chatId, "Usage: /report <child name>");
    const books = await query("SELECT title, last_page, total_pages, status FROM books WHERE child_id=$1 ORDER BY created_at", [child.id]);
    const records = await query(
      "SELECT book_title, score_percent, passed, date FROM chapter_records WHERE child_id=$1 ORDER BY date",
      [child.id]
    );
    const explains = await query(
      "SELECT query_text, date FROM explain_log WHERE child_id=$1 ORDER BY date DESC LIMIT 15",
      [child.id]
    );
    let out = `📋 Full report for ${child.name}:\n\n📚 Books read:\n`;
    out += books.length
      ? books.map((b) => `${b.status === "finished" ? "✅" : "📖"} ${b.title}${b.last_page ? ` (at page ${b.last_page}${b.total_pages ? `/${b.total_pages}` : ""})` : ""}`).join("\n")
      : "None yet.";
    out += "\n\n📖 Quiz history:\n";
    out += records.length
      ? records.map((r) => `${r.book_title}: ${r.score_percent}% ${r.passed ? "✅" : "❌"} (${new Date(r.date).toLocaleDateString()})`).join("\n")
      : "None yet.";
    out += "\n\n🔍 Recent words/passages asked:\n";
    out += explains.length
      ? explains.map((e) => `- "${e.query_text}" (${new Date(e.date).toLocaleDateString()})`).join("\n")
      : "None yet.";
    return sendText(chatId, out);
  }

  if (!activeChild) {
    if (text === MENU.WORD || text === MENU.PASSAGE || text === MENU.QUIZ) {
      await updateSession(userId, { mode: "awaiting_child_select", pending_action: text });
      return sendText(chatId, "Who are we working with?", childKeyboard);
    }

    if (session.mode === "awaiting_child_select" && text && CHILD_NAMES.includes(text)) {
      await ensureChildren(userId);
      const child = await getChildByName(userId, text);
      const pending = session.pending_action;
      await updateSession(userId, { active_child_id: child.id, pending_action: null, mode: "idle" });

      if (pending === MENU.QUIZ) {
        if (!(await checkResumeOrPrompt(chatId, userId, child))) {
          await updateSession(userId, { mode: "quiz_awaiting_cover" });
          await sendText(chatId, "📷 Send a photo of the book's cover.", { remove_keyboard: true });
        }
        return;
      }
      if (pending === MENU.WORD) {
        await updateSession(userId, { mode: "awaiting_word" });
        return sendText(chatId, "Type the word you'd like explained:");
      }
      if (pending === MENU.PASSAGE) {
        await updateSession(userId, { mode: "awaiting_passage" });
        return sendText(chatId, "Send the passage as text, or a photo of it:");
      }
      return sendMenu(chatId, `✅ "${child.name}" selected.`);
    }

    await ensureChildren(userId);
    return sendText(chatId, "Please choose one of the buttons below:", childKeyboard);
  }

  // ---- Resume check ----

  if (session.mode === "resume_check") {
    if (text === RESUME.YES) {
      const books = await query("SELECT * FROM books WHERE child_id=$1 AND title=$2", [activeChild.id, session.quiz_book_title]);
      const book = books[0];
      if (!book) {
        await updateSession(userId, { mode: "idle" });
        return sendMenu(chatId, "Hmm, I lost track of that book. Please use 🧠 Quiz to start again.");
      }
      return startQuizFromKnownBook(chatId, userId, activeChild, book);
    }
    if (text === RESUME.NOT_YET) {
      await updateSession(userId, { mode: "idle" });
      return sendMenu(chatId, "No problem — keep reading! Come back when you're ready. 📖");
    }
    if (text === RESUME.FINISHED) {
      return confirmBookFinished(chatId, userId, activeChild, session.quiz_book_title);
    }
    return sendText(chatId, "Please tap one of the options above.", resumeKeyboard);
  }

  // ---- Menu button taps ----

  if (text === MENU.WORD) {
    await updateSession(userId, { mode: "awaiting_word" });
    return sendText(chatId, "Type the word you'd like explained:");
  }

  if (text === MENU.PASSAGE) {
    await updateSession(userId, { mode: "awaiting_passage" });
    return sendText(chatId, "Send the passage as text, or a photo of it:");
  }

  if (text === MENU.QUIZ) {
    await updateSession(userId, { mode: "quiz_awaiting_name" });
    return sendText(chatId, "Who's taking the quiz?", childKeyboard);
  }

  // ---- State machine ----

  if (session.mode === "awaiting_word" && text) {
    const explanation = await explainText(text, false);
    if (!explanation) {
      await updateSession(userId, { mode: "idle" });
      return sendMenu(chatId, "Sorry, I couldn't look that up right now — please try again in a moment.");
    }
    await query("INSERT INTO explain_log (child_id, content_type, query_text, response_text) VALUES ($1,'text',$2,$3)", [activeChild.id, text, explanation]);
    await updateSession(userId, { mode: "idle" });
    return sendMenu(chatId, explanation);
  }

  if (session.mode === "awaiting_passage") {
    if (message.photo) {
      const selectedPhoto = pickPhotoSize(message.photo);
      const base64 = await getTelegramFileBase64(selectedPhoto.file_id);
      const quality = await checkImageReadable(base64, "image/jpeg", "a passage from a book");
      if (!quality.readable) {
        return sendText(chatId, `📷 That photo isn't clear enough to read${quality.reason ? ` (${quality.reason})` : ""}. Please retake it and send again.`);
      }
      const explanation = await explainImage(base64, "image/jpeg", true);
      if (!explanation) {
        await updateSession(userId, { mode: "idle" });
        return sendMenu(chatId, "Sorry, I couldn't process that right now — please try again in a moment.");
      }
      await query("INSERT INTO explain_log (child_id, content_type, query_text, response_text) VALUES ($1,'image','[photo passage]',$2)", [activeChild.id, explanation]);
      await updateSession(userId, { mode: "idle" });
      return sendMenu(chatId, explanation);
    }
    if (text) {
      const explanation = await explainText(text, true);
      if (!explanation) {
        await updateSession(userId, { mode: "idle" });
        return sendMenu(chatId, "Sorry, I couldn't process that right now — please try again in a moment.");
      }
      await query("INSERT INTO explain_log (child_id, content_type, query_text, response_text) VALUES ($1,'text',$2,$3)", [activeChild.id, text, explanation]);
      await updateSession(userId, { mode: "idle" });
      return sendMenu(chatId, explanation);
    }
    return sendText(chatId, "Please send the passage as text, or a photo of it.");
  }

  if (session.mode === "quiz_awaiting_name" && text) {
    if (!CHILD_NAMES.includes(text)) {
      return sendText(chatId, "Please choose one of the buttons below:", childKeyboard);
    }
    await ensureChildren(userId);
    const quizChild = await getChildByName(userId, text);
    await updateSession(userId, { active_child_id: quizChild.id, mode: "idle" });

    if (!(await checkResumeOrPrompt(chatId, userId, quizChild))) {
      await updateSession(userId, { mode: "quiz_awaiting_cover" });
      return sendText(chatId, "📷 Send a photo of the book's cover.", { remove_keyboard: true });
    }
    return;
  }

  if (session.mode === "quiz_awaiting_cover" && message.photo) {
    const selectedPhoto = pickPhotoSize(message.photo);
    const base64 = await getTelegramFileBase64(selectedPhoto.file_id);
    const quality = await checkImageReadable(base64, "image/jpeg", "a book cover");
    if (!quality.readable) {
      return sendText(chatId, `📷 That photo isn't clear enough to read${quality.reason ? ` (${quality.reason})` : ""}. Please retake it in good light and send again.`);
    }
    const info = await extractBookInfo(base64, "image/jpeg");

    // Reuse a prior found/not-found decision for this child+book if we've seen it before,
    // instead of re-searching every time (search results can vary between calls).
    const existing = await query(
      "SELECT * FROM books WHERE child_id=$1 AND title ILIKE $2 LIMIT 1",
      [activeChild.id, info.title]
    );

    let finalTitle, finalAuthor, found;
    if (existing[0]) {
      finalTitle = existing[0].title;
      finalAuthor = existing[0].author || "";
      found = existing[0].found_online === true;
      await sendText(chatId, `Found this book in ${activeChild.name}'s history already — using saved info for "${finalTitle}".`);
    } else {
      await sendText(chatId, `Looking up "${info.title}"...`);
      const searchResult = await searchBookOnline(info.title, info.author);
      finalTitle = searchResult.title || info.title;
      finalAuthor = searchResult.author || info.author || "";
      found = searchResult.found === true;
    }

    await updateSession(userId, {
      quiz_book_title: finalTitle,
      quiz_author: finalAuthor,
      quiz_found: found,
    });

    if (existing[0]?.total_pages) {
      // Already know the page count from a previous session — skip straight ahead.
      return proceedPastTotalPages(chatId, userId, activeChild.id, finalTitle, found);
    }
    await updateSession(userId, { mode: "quiz_awaiting_total_pages" });
    return sendText(chatId, `How many pages does "${finalTitle}" have in total? (So I can track progress and know when it's really finished.)`);
  }

  if (session.mode === "quiz_awaiting_total_pages" && text) {
    const totalPages = parseInt(text.replace(/\D/g, ""), 10);
    if (!totalPages || totalPages <= 0) {
      return sendText(chatId, "Please enter the total number of pages as a number (e.g. 120).");
    }
    await upsertBookProgress(activeChild.id, session.quiz_book_title, {
      author: session.quiz_author,
      foundOnline: session.quiz_found,
      totalPages,
    });
    return proceedPastTotalPages(chatId, userId, activeChild.id, session.quiz_book_title, session.quiz_found);
  }

  if (session.mode === "quiz_awaiting_pages" && text) {
    const bookRows = await query("SELECT total_pages, last_page FROM books WHERE child_id=$1 AND title=$2", [activeChild.id, session.quiz_book_title]);
    const totalPages = bookRows[0]?.total_pages || null;
    const priorLastPage = bookRows[0]?.last_page || 0;
    const remaining = totalPages ? totalPages - priorLastPage : null;
    const requiredSpan = remaining !== null ? Math.max(1, Math.min(MIN_PAGES_BIG_BOOK, remaining)) : MIN_PAGES_BIG_BOOK;

    const range = parsePageRange(text);
    if (!range || range.span === null) {
      return sendText(chatId, `Please enter a page range like "10-20"${requiredSpan > 1 ? ` — at least ${requiredSpan} pages` : ""}.`);
    }
    if (range.span < requiredSpan) {
      return sendText(chatId, `That's only ${range.span} page(s). Please read and enter at least ${requiredSpan} pages (e.g. "10-20").`);
    }
    if (totalPages && range.end > totalPages) {
      return sendText(chatId, `"${session.quiz_book_title}" only has ${totalPages} pages total — please enter a range up to page ${totalPages}.`);
    }
    const pageRange = text;
    const lastPage = range.end;

    await upsertBookProgress(activeChild.id, session.quiz_book_title, {
      author: session.quiz_author,
      foundOnline: true,
    });

    await sendText(chatId, "Generating your quiz, one moment...");
    const previousQuestions = await getPreviousQuestions(activeChild.id, session.quiz_book_title);
    const questions = await generateQuizFromKnowledge(session.quiz_book_title, session.quiz_author, pageRange, previousQuestions, activeChild.difficulty);

    if (questions === "INSUFFICIENT_KNOWLEDGE") {
      await query("UPDATE books SET found_online=false WHERE child_id=$1 AND title=$2", [activeChild.id, session.quiz_book_title]);
      await sendText(chatId, `I don't know this book's specific content well enough, so I won't guess.`);
      return proceedPastTotalPages(chatId, userId, activeChild.id, session.quiz_book_title, false);
    }
    if (!questions || !questions.length) {
      await updateSession(userId, { mode: "idle" });
      return sendMenu(chatId, "Sorry, I couldn't generate a quiz for that book. Please try 🧠 Quiz again.");
    }
    await updateSession(userId, {
      mode: "quiz",
      quiz_page_range: pageRange,
      quiz_pending_last_page: lastPage,
      quiz_questions_json: JSON.stringify(questions),
      quiz_current_index: 0,
      quiz_correct_count: 0,
    });
    return askQuizQuestion(chatId, questions, 0);
  }

  if (session.mode === "quiz_collecting_photos") {
    if (message.photo) {
      const selectedPhoto = pickPhotoSize(message.photo);
      const base64 = await getTelegramFileBase64(selectedPhoto.file_id);
      const quality = await checkImageReadable(base64, "image/jpeg", "a page from a book");
      if (!quality.readable) {
        return sendText(chatId, `📷 That page isn't clear enough to read${quality.reason ? ` (${quality.reason})` : ""}. Please retake the photo (good light, hold steady, fill the frame) and send it again.`);
      }
      const photos = JSON.parse(session.quiz_photos_json || "[]");
      photos.push({ base64, mediaType: "image/jpeg" });
      await updateSession(userId, { quiz_photos_json: JSON.stringify(photos) });

      const books = await query("SELECT total_pages, last_page FROM books WHERE child_id=$1 AND title=$2", [activeChild.id, session.quiz_book_title]);
      const book = books[0];
      const totalPages = book?.total_pages || null;
      const priorLastPage = book?.last_page || 0;
      const remaining = totalPages ? totalPages - priorLastPage : null;
      const requiredPhotos = remaining !== null ? Math.max(1, Math.min(MIN_PAGES_BIG_BOOK, remaining)) : MIN_PAGES_BIG_BOOK;

      if (photos.length >= requiredPhotos) {
        // Got exactly what's needed for this round — start generating right away,
        // no need to wait for the child to type "done".
        return finishPhotoQuiz(chatId, userId, activeChild, session, photos);
      }
      return sendText(chatId, `Got it (${photos.length}/${requiredPhotos} pages). Send ${requiredPhotos - photos.length} more.`);
    }
    if (text && text.toLowerCase() === "done") {
      const photos = JSON.parse(session.quiz_photos_json || "[]");
      const books = await query("SELECT total_pages, last_page FROM books WHERE child_id=$1 AND title=$2", [activeChild.id, session.quiz_book_title]);
      const book = books[0];
      const totalPages = book?.total_pages || null;
      const priorLastPage = book?.last_page || 0;
      const remaining = totalPages ? totalPages - priorLastPage : null;
      const requiredPhotos = remaining !== null ? Math.max(1, Math.min(MIN_PAGES_BIG_BOOK, remaining)) : MIN_PAGES_BIG_BOOK;

      if (photos.length < requiredPhotos) {
        return sendText(
          chatId,
          `At least ${requiredPhotos} page photo${requiredPhotos > 1 ? "s are" : " is"} needed (you've sent ${photos.length} so far). Please send more.`
        );
      }
      return finishPhotoQuiz(chatId, userId, activeChild, session, photos);
    }
    return sendText(chatId, `Send a page photo, or type 'done' when finished (at least ${MIN_PAGES_BIG_BOOK} pages usually needed).`);
  }

  if (session.mode === "quiz" && text) {
    const questions = JSON.parse(session.quiz_questions_json);
    const idx = session.quiz_current_index;
    const answer = text.toUpperCase().replace(/[^A-D]/g, "");
    if (!["A", "B", "C", "D"].includes(answer)) {
      return sendText(chatId, "Please reply with A, B, C, or D.");
    }
    const correct = questions[idx].correct.toUpperCase() === answer;
    const newCorrectCount = session.quiz_correct_count + (correct ? 1 : 0);
    const nextIdx = idx + 1;

    if (nextIdx >= questions.length) {
      const scorePercent = Math.round((newCorrectCount / questions.length) * 100);
      const passed = scorePercent >= PASS_THRESHOLD;
      const currentDifficulty = activeChild.difficulty || "medium";
      const attemptRows = await query(
        "SELECT COUNT(*) as c FROM chapter_records WHERE child_id=$1 AND book_title=$2",
        [activeChild.id, session.quiz_book_title]
      );
      await query(
        "INSERT INTO chapter_records (child_id, book_title, chapter_number, score_percent, passed, attempt_number, questions_json, difficulty) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [activeChild.id, session.quiz_book_title, 0, scorePercent, passed, Number(attemptRows[0].c) + 1, JSON.stringify(questions), currentDifficulty]
      );
      // Only advance the child's recorded page position if they actually passed —
      // otherwise the next resume prompt should offer the SAME range again, not skip ahead.
      if (passed && session.quiz_pending_last_page) {
        await upsertBookProgress(activeChild.id, session.quiz_book_title, {
          lastPage: session.quiz_pending_last_page,
          pageRangeText: session.quiz_page_range,
          lastPhotosJson: null, // this range is done — next attempt (if any) needs fresh photos
        });
      }

      // Auto level-up: if the last few attempts at the current difficulty were all
      // strong passes (regardless of which book), bump difficulty up automatically.
      let levelUpNote = "";
      const LEVELS = ["easy", "medium", "hard"];
      const currentIdx = LEVELS.indexOf(currentDifficulty);
      if (currentIdx !== -1 && currentIdx < LEVELS.length - 1) {
        const AUTO_LEVEL_UP_STREAK = 3;
        const AUTO_LEVEL_UP_SCORE = 90;
        const recent = await query(
          "SELECT score_percent FROM chapter_records WHERE child_id=$1 AND difficulty=$2 ORDER BY date DESC LIMIT $3",
          [activeChild.id, currentDifficulty, AUTO_LEVEL_UP_STREAK]
        );
        const strongStreak = recent.length === AUTO_LEVEL_UP_STREAK && recent.every((r) => r.score_percent >= AUTO_LEVEL_UP_SCORE);
        if (strongStreak) {
          const newLevel = LEVELS[currentIdx + 1];
          await query("UPDATE children SET difficulty=$1 WHERE id=$2", [newLevel, activeChild.id]);
          levelUpNote = `\n\n⬆️ ${activeChild.name} has scored ${AUTO_LEVEL_UP_SCORE}%+ on ${AUTO_LEVEL_UP_STREAK} quizzes in a row — difficulty automatically raised to "${newLevel}"! 🌟`;
        }
      }

      const scopeLabel = session.quiz_page_range ? `pages ${session.quiz_page_range}` : "the book";
      const resultMessage =
        (passed
          ? `🎉 ${activeChild.name} scored ${scorePercent}%! ✅ Passed "${session.quiz_book_title}" (${scopeLabel}).`
          : `Score: ${scorePercent}%. ❌ Not quite — please re-read "${session.quiz_book_title}" (${scopeLabel}) and try 🧠 Quiz again. (Next attempt will have different questions.)`) +
        levelUpNote;
      await updateSession(userId, {
        mode: "book_finished_check",
        quiz_questions_json: null,
        quiz_current_index: 0,
        quiz_correct_count: 0,
        quiz_pending_last_page: null,
        pending_message: resultMessage,
      });
      return sendText(chatId, `${resultMessage}\n\nDid you finish "${session.quiz_book_title}" completely?`, finishedKeyboard);
    } else {
      await updateSession(userId, { quiz_current_index: nextIdx, quiz_correct_count: newCorrectCount });
      return askQuizQuestion(chatId, questions, nextIdx);
    }
  }

  if (session.mode === "book_finished_check") {
    if (text === FINISHED.YES) {
      return confirmBookFinished(chatId, userId, activeChild, session.quiz_book_title);
    }
    if (text === FINISHED.NO) {
      await query("UPDATE books SET status='in_progress', updated_at=NOW() WHERE child_id=$1 AND title=$2", [activeChild.id, session.quiz_book_title]);
      await updateSession(userId, { mode: "idle", pending_message: null });
      return sendMenu(chatId, "Great, keep going! 📖");
    }
    return sendText(chatId, "Please choose one of the buttons below:", finishedKeyboard);
  }

  if (session.mode === "idle") {
    return sendMenu(chatId, "Please choose an option below 👇");
  }

  // Safety net: no branch matched (e.g. a stale/unknown session mode) — never fail silently.
  console.log(`[unmatched state] userId=${userId} mode=${session.mode} text=${JSON.stringify(text)}`);
  await updateSession(userId, { mode: "idle" });
  return sendMenu(chatId, "Let's start fresh — please choose an option below 👇");
}

async function askQuizQuestion(chatId, questions, idx) {
  const q = questions[idx];
  const optionsText = Object.entries(q.options).map(([k, v]) => `${k}) ${v}`).join("\n");
  return sendText(chatId, `Question ${idx + 1}/${questions.length}:\n${q.question}\n\n${optionsText}\n\nReply with A, B, C, or D.`);
}

// ---------- Startup: ensure schema exists ----------

async function ensureSchema() {
  const fs = await import("fs");
  const schemaSql = fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
  await pool.query(schemaSql);
  console.log("Schema ensured.");
}

const PORT = process.env.PORT || 3000;
ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Bot server listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to ensure schema:", err);
    app.listen(PORT, () => console.log(`Bot server listening on port ${PORT} (schema check failed)`));
  });
