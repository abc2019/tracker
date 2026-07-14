import express from "express";
import { query, pool } from "./db.js";

const app = express();
app.use(express.json());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PASS_THRESHOLD = 80;
const QUESTIONS_PER_QUIZ = 8;
const CLAUDE_MODEL = "claude-sonnet-4-6";
const MIN_PAGES_BIG_BOOK = 5;
const RESUME_PAGE_INCREMENT = 10;

const MENU = {
  WORD: "📖 Word Meaning",
  PASSAGE: "📝 Passage Meaning",
  QUIZ: "🧠 Quiz",
};
const BOOK_TYPE = {
  SMALL: "📕 Small booklet (whole book)",
  BIG: "📚 Big book (specific pages)",
};
const RESUME = {
  YES: "✅ Yes, quiz me",
  NOT_YET: "📖 Not yet",
};

const mainMenuKeyboard = { keyboard: [[MENU.WORD, MENU.PASSAGE], [MENU.QUIZ]], resize_keyboard: true };
const bookTypeKeyboard = { keyboard: [[BOOK_TYPE.SMALL], [BOOK_TYPE.BIG]], resize_keyboard: true, one_time_keyboard: true };
const resumeKeyboard = { keyboard: [[RESUME.YES], [RESUME.NOT_YET]], resize_keyboard: true, one_time_keyboard: true };

// ---------- Telegram helpers ----------

async function tg(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
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
  const filePath = fileInfo.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`);
  const buf = await fileRes.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}

// ---------- Claude API helpers ----------

async function callClaude(messages, maxTokens = 1024, tools = null) {
  const body = { model: CLAUDE_MODEL, max_tokens: maxTokens, messages };
  if (tools) body.tools = tools;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.content) {
    return data.content.map((b) => b.text || "").join("\n").trim();
  }
  console.error("Claude API error:", JSON.stringify(data));
  return "Sorry, I couldn't process that right now.";
}

async function explainText(text, isPassage) {
  const kind = isPassage ? "passage" : "word";
  const prompt = `You are a friendly reading tutor for a child. Explain the meaning of the following ${kind} in simple, age-appropriate English. Keep it short (2-5 sentences), use an example if helpful.\n\nText: "${text}"`;
  return callClaude([{ role: "user", content: prompt }]);
}

async function explainImage(base64Image, mediaType, isPassage) {
  const kind = isPassage ? "passage" : "word";
  const prompt = `You are a friendly reading tutor for a child. Look at this image (a ${kind} from a book). Explain its meaning in simple, age-appropriate English in 2-5 sentences.`;
  return callClaude([
    { role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
      { type: "text", text: prompt },
    ]},
  ]);
}

async function extractBookInfo(base64Image, mediaType) {
  const prompt = 'Look at this photo of a book cover. Identify the title and author if visible. Respond ONLY with valid JSON, no markdown fences, no preamble: {"title": "...", "author": "..."} (use empty string for author if not visible/unknown).';
  const raw = await callClaude([
    { role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
      { type: "text", text: prompt },
    ]},
  ]);
  const clean = raw.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); } catch (e) {
    console.error("Failed to parse book info JSON:", clean);
    return { title: "Unknown book", author: "" };
  }
}

async function searchBookOnline(title, author) {
  const prompt = `Search the web to check whether a real, identifiable, published book titled "${title}"${author ? ` by ${author}` : ""} exists. After searching, respond ONLY with valid JSON, no markdown fences, no preamble, in this exact format: {"found": true, "title": "confirmed title", "author": "confirmed author or empty string"} — set "found" to false if you cannot confidently identify this specific book.`;
  const raw = await callClaude([{ role: "user", content: prompt }], 1500, [{ type: "web_search_20250305", name: "web_search" }]);
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

async function generateQuizFromKnowledge(title, author, pageRange, previousQuestions) {
  const scopeText = pageRange
    ? `They report having read: ${pageRange}.`
    : `They did not specify exact pages, so cover general content from the book.`;
  const prompt = `You are a reading comprehension teacher. A child has been reading the book "${title}"${author ? ` by ${author}` : ""}. ${scopeText}

Using your knowledge of this book, write exactly ${QUESTIONS_PER_QUIZ} multiple-choice reading comprehension questions covering that portion of the book. Do not invent specific plot details you are not confident about.${avoidanceClause(previousQuestions)}

Return ONLY valid JSON, no markdown fences, no preamble, in this exact format:
[
  {"question": "...", "options": {"A": "...", "B": "...", "C": "...", "D": "..."}, "correct": "A"},
  ...
]`;
  const raw = await callClaude([{ role: "user", content: prompt }], 2000);
  const clean = raw.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); } catch (e) {
    console.error("Failed to parse quiz JSON:", clean);
    return null;
  }
}

async function generateQuizFromPagePhotos(images, title, previousQuestions) {
  const content = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.base64 },
  }));
  content.push({
    type: "text",
    text: `These are photos of pages from the book "${title}" that a child has read. Based ONLY on the actual text visible in these photos, write exactly ${QUESTIONS_PER_QUIZ} multiple-choice reading comprehension questions covering this content. If some text is unclear, focus questions on what is clearly readable.${avoidanceClause(previousQuestions)}

Return ONLY valid JSON, no markdown fences, no preamble, in this exact format:
[
  {"question": "...", "options": {"A": "...", "B": "...", "C": "...", "D": "..."}, "correct": "A"},
  ...
]`,
  });
  const raw = await callClaude([{ role: "user", content }], 3000);
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

async function getActiveChild(session) {
  if (!session.active_child_id) return null;
  const rows = await query("SELECT * FROM children WHERE id = $1", [session.active_child_id]);
  return rows[0] || null;
}

async function getInProgressBook(childId) {
  const rows = await query(
    "SELECT * FROM books WHERE child_id=$1 AND status='in_progress' AND last_page IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
    [childId]
  );
  return rows[0] || null;
}

async function upsertBookProgress(childId, title, { author, foundOnline, bookType, pageRangeText, lastPage } = {}) {
  await query(
    `INSERT INTO books (child_id, title, author, found_online, book_type, last_page_range, last_page, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (child_id, title) DO UPDATE SET
       author = COALESCE(EXCLUDED.author, books.author),
       found_online = COALESCE(EXCLUDED.found_online, books.found_online),
       book_type = COALESCE(EXCLUDED.book_type, books.book_type),
       last_page_range = COALESCE(EXCLUDED.last_page_range, books.last_page_range),
       last_page = COALESCE(EXCLUDED.last_page, books.last_page),
       updated_at = NOW()`,
    [childId, title, author || null, foundOnline ?? null, bookType || null, pageRangeText || null, lastPage ?? null]
  );
}

// ---------- Webhook route ----------

app.post("/webhook", async (req, res) => {
  try {
    await handleUpdate(req.body);
  } catch (err) {
    console.error("Error handling update:", err);
  }
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("Reading Tracker Bot is running."));

async function startQuizFromKnownBook(chatId, userId, activeChild, book) {
  const nextEnd = (book.last_page || 0) + RESUME_PAGE_INCREMENT;
  const pageRange = `${(book.last_page || 0) + 1}-${nextEnd}`;
  await sendText(chatId, "Great! Generating your quiz, one moment...");
  const previousQuestions = await getPreviousQuestions(activeChild.id, book.title);

  if (book.found_online) {
    const questions = await generateQuizFromKnowledge(book.title, book.author, pageRange, previousQuestions);
    if (!questions || !questions.length) {
      await updateSession(userId, { mode: "idle" });
      return sendMenu(chatId, "Sorry, I couldn't generate a quiz right now. Please try 🧠 Quiz again.");
    }
    await upsertBookProgress(activeChild.id, book.title, { pageRangeText: pageRange, lastPage: nextEnd });
    await updateSession(userId, {
      mode: "quiz",
      quiz_book_title: book.title,
      quiz_page_range: pageRange,
      quiz_questions_json: JSON.stringify(questions),
      quiz_current_index: 0,
      quiz_correct_count: 0,
    });
    return askQuizQuestion(chatId, questions, 0);
  } else {
    await updateSession(userId, {
      mode: "quiz_collecting_photos",
      quiz_book_title: book.title,
      quiz_page_range: pageRange,
      quiz_photos_json: "[]",
    });
    return sendText(chatId, `Please send photos of pages ${pageRange}. Type 'done' when finished.`);
  }
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message) return;
  const chatId = message.chat.id;
  const userId = String(message.from.id);
  const session = await getOrCreateSession(userId);
  const text = message.text?.trim();

  if (text?.startsWith("/start")) {
    return sendMenu(
      chatId,
      "📚 Welcome to the Reading Tracker Bot!\n\n" +
        "First: /addchild <name> then /use <name>.\n\n" +
        "Then pick what you need below:\n" +
        "📖 Word Meaning — ask what a word means\n" +
        "📝 Passage Meaning — ask what a passage means\n" +
        "🧠 Quiz — test on a book you've been reading"
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

    const inProgress = await getInProgressBook(child.id);
    if (inProgress) {
      const nextEnd = (inProgress.last_page || 0) + RESUME_PAGE_INCREMENT;
      await updateSession(userId, { mode: "resume_check", quiz_book_title: inProgress.title });
      return sendText(
        chatId,
        `Welcome back, ${child.name}! You're at page ${inProgress.last_page} of "${inProgress.title}". Have you read up to page ${nextEnd} (the next ${RESUME_PAGE_INCREMENT} pages)?`,
        resumeKeyboard
      );
    }
    return sendMenu(chatId, `✅ Active child set to "${name}".`);
  }

  const activeChild = await getActiveChild(session);

  if (text?.startsWith("/status")) {
    if (!activeChild) return sendText(chatId, "No active child. Use /use <name> first.");
    const books = await query("SELECT title, last_page, last_page_range, status FROM books WHERE child_id=$1 ORDER BY updated_at DESC", [activeChild.id]);
    const rows = await query(
      "SELECT book_title, score_percent, passed, date FROM chapter_records WHERE child_id=$1 ORDER BY date DESC LIMIT 10",
      [activeChild.id]
    );
    let out = `📚 Books for ${activeChild.name}:\n`;
    out += books.length
      ? books.map((b) => `- ${b.title}${b.last_page ? ` (at page ${b.last_page})` : ""}`).join("\n")
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
    const books = await query("SELECT title, last_page FROM books WHERE child_id=$1 ORDER BY created_at", [child.id]);
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
      ? books.map((b) => `- ${b.title}${b.last_page ? ` (at page ${b.last_page})` : ""}`).join("\n")
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
    return sendText(chatId, "Please set an active child first: /use <name> (or /addchild <name>).");
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
    await updateSession(userId, { mode: "quiz_choose_type" });
    return sendText(chatId, "Is this a small booklet (whole book) or a big book (specific pages)?", bookTypeKeyboard);
  }

  // ---- State machine ----

  if (session.mode === "awaiting_word" && text) {
    const explanation = await explainText(text, false);
    await query("INSERT INTO explain_log (child_id, content_type, query_text, response_text) VALUES ($1,'text',$2,$3)", [activeChild.id, text, explanation]);
    await updateSession(userId, { mode: "idle" });
    return sendMenu(chatId, explanation);
  }

  if (session.mode === "awaiting_passage") {
    if (message.photo) {
      const largestPhoto = message.photo[message.photo.length - 1];
      const base64 = await getTelegramFileBase64(largestPhoto.file_id);
      const explanation = await explainImage(base64, "image/jpeg", true);
      await query("INSERT INTO explain_log (child_id, content_type, query_text, response_text) VALUES ($1,'image','[photo passage]',$2)", [activeChild.id, explanation]);
      await updateSession(userId, { mode: "idle" });
      return sendMenu(chatId, explanation);
    }
    if (text) {
      const explanation = await explainText(text, true);
      await query("INSERT INTO explain_log (child_id, content_type, query_text, response_text) VALUES ($1,'text',$2,$3)", [activeChild.id, text, explanation]);
      await updateSession(userId, { mode: "idle" });
      return sendMenu(chatId, explanation);
    }
  }

  if (session.mode === "quiz_choose_type") {
    if (text === BOOK_TYPE.SMALL || text === BOOK_TYPE.BIG) {
      const bookType = text === BOOK_TYPE.SMALL ? "small" : "big";
      await updateSession(userId, { mode: "quiz_awaiting_cover", quiz_book_type: bookType });
      return sendText(chatId, "📷 Send a photo of the book's cover.", { remove_keyboard: true });
    }
    return sendText(chatId, "Please tap one of the two options above.", bookTypeKeyboard);
  }

  if (session.mode === "quiz_awaiting_cover" && message.photo) {
    const largestPhoto = message.photo[message.photo.length - 1];
    const base64 = await getTelegramFileBase64(largestPhoto.file_id);
    const info = await extractBookInfo(base64, "image/jpeg");
    await sendText(chatId, `Looking up "${info.title}"...`);
    const searchResult = await searchBookOnline(info.title, info.author);
    const finalTitle = searchResult.title || info.title;
    const finalAuthor = searchResult.author || info.author || "";
    await updateSession(userId, {
      mode: "quiz_awaiting_pages",
      quiz_book_title: finalTitle,
      quiz_author: finalAuthor,
      quiz_found: searchResult.found === true,
    });
    const hint = session.quiz_book_type === "big" ? ` (please read at least ${MIN_PAGES_BIG_BOOK} pages, e.g. "10-20")` : "";
    return sendText(chatId, `"${finalTitle}" — which pages have you read?${hint}`);
  }

  if (session.mode === "quiz_awaiting_pages" && text) {
    const range = parsePageRange(text);
    let pageRange = null;
    let lastPage = null;

    if (session.quiz_book_type === "big") {
      if (!range || range.span === null) {
        return sendText(chatId, `Please enter a page range like "10-20" — at least ${MIN_PAGES_BIG_BOOK} pages.`);
      }
      if (range.span < MIN_PAGES_BIG_BOOK) {
        return sendText(chatId, `That's only ${range.span} page(s). For a big book, please read and enter at least ${MIN_PAGES_BIG_BOOK} pages (e.g. "10-20").`);
      }
      pageRange = text;
      lastPage = range.end;
    } else {
      if (!range) {
        await sendText(chatId, "That doesn't look like a valid page number — skipping that and quizzing on the book generally.");
      } else {
        pageRange = text;
        lastPage = range.end;
      }
    }

    await upsertBookProgress(activeChild.id, session.quiz_book_title, {
      author: session.quiz_author,
      foundOnline: session.quiz_found,
      bookType: session.quiz_book_type,
      pageRangeText: pageRange,
      lastPage,
    });

    if (session.quiz_found) {
      await sendText(chatId, "Generating your quiz, one moment...");
      const previousQuestions = await getPreviousQuestions(activeChild.id, session.quiz_book_title);
      const questions = await generateQuizFromKnowledge(session.quiz_book_title, session.quiz_author, pageRange, previousQuestions);
      if (!questions || !questions.length) {
        await updateSession(userId, { mode: "idle" });
        return sendMenu(chatId, "Sorry, I couldn't generate a quiz for that book. Please try 🧠 Quiz again.");
      }
      await updateSession(userId, {
        mode: "quiz",
        quiz_page_range: pageRange,
        quiz_questions_json: JSON.stringify(questions),
        quiz_current_index: 0,
        quiz_correct_count: 0,
      });
      return askQuizQuestion(chatId, questions, 0);
    } else {
      await updateSession(userId, { mode: "quiz_collecting_photos", quiz_page_range: pageRange, quiz_photos_json: "[]" });
      const instructions =
        session.quiz_book_type === "small"
          ? "I couldn't find this book online. Please send photos of all the pages you've read. Type 'done' when finished."
          : `I couldn't find this book online. Please send photos of the pages you've read${pageRange ? ` (${pageRange})` : ""}. Type 'done' when finished.`;
      return sendText(chatId, instructions);
    }
  }

  if (session.mode === "quiz_collecting_photos") {
    if (message.photo) {
      const largestPhoto = message.photo[message.photo.length - 1];
      const base64 = await getTelegramFileBase64(largestPhoto.file_id);
      const photos = JSON.parse(session.quiz_photos_json || "[]");
      photos.push({ base64, mediaType: "image/jpeg" });
      await updateSession(userId, { quiz_photos_json: JSON.stringify(photos) });
      return sendText(chatId, `Got it (${photos.length} page${photos.length > 1 ? "s" : ""} so far). Send more, or type 'done'.`);
    }
    if (text && text.toLowerCase() === "done") {
      const photos = JSON.parse(session.quiz_photos_json || "[]");
      if (!photos.length) {
        return sendText(chatId, "Please send at least one page photo first, then type 'done'.");
      }
      await sendText(chatId, "Generating your quiz from those pages, one moment...");
      const previousQuestions = await getPreviousQuestions(activeChild.id, session.quiz_book_title);
      const questions = await generateQuizFromPagePhotos(photos, session.quiz_book_title, previousQuestions);
      if (!questions || !questions.length) {
        await updateSession(userId, { mode: "idle", quiz_photos_json: null });
        return sendMenu(chatId, "Sorry, I couldn't generate a quiz from those photos. Please try 🧠 Quiz again.");
      }
      await updateSession(userId, {
        mode: "quiz",
        quiz_questions_json: JSON.stringify(questions),
        quiz_current_index: 0,
        quiz_correct_count: 0,
        quiz_photos_json: null,
      });
      return askQuizQuestion(chatId, questions, 0);
    }
    return sendText(chatId, "Send a page photo, or type 'done' when finished.");
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
      const attemptRows = await query(
        "SELECT COUNT(*) as c FROM chapter_records WHERE child_id=$1 AND book_title=$2",
        [activeChild.id, session.quiz_book_title]
      );
      await query(
        "INSERT INTO chapter_records (child_id, book_title, chapter_number, score_percent, passed, attempt_number, questions_json) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [activeChild.id, session.quiz_book_title, 0, scorePercent, passed, Number(attemptRows[0].c) + 1, JSON.stringify(questions)]
      );
      await updateSession(userId, { mode: "idle", quiz_questions_json: null, quiz_current_index: 0, quiz_correct_count: 0 });
      const scopeLabel = session.quiz_page_range ? `pages ${session.quiz_page_range}` : "the book";
      if (passed) {
        return sendMenu(chatId, `🎉 ${activeChild.name} scored ${scorePercent}%! ✅ Passed "${session.quiz_book_title}" (${scopeLabel}).`);
      } else {
        return sendMenu(chatId, `Score: ${scorePercent}%. ❌ Not quite — please re-read "${session.quiz_book_title}" (${scopeLabel}) and try 🧠 Quiz again. (Next attempt will have different questions.)`);
      }
    } else {
      await updateSession(userId, { quiz_current_index: nextIdx, quiz_correct_count: newCorrectCount });
      return askQuizQuestion(chatId, questions, nextIdx);
    }
  }

  if (session.mode === "idle") {
    return sendMenu(chatId, "Please choose an option below 👇");
  }
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
