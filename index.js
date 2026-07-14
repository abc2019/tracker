import express from "express";
import { query, pool } from "./db.js";

const app = express();
app.use(express.json());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PASS_THRESHOLD = 80;
const QUESTIONS_PER_QUIZ = 8;
const CLAUDE_MODEL = "claude-sonnet-4-6";

const MENU = {
  WORD: "📖 So'z ma'nosi",
  PASSAGE: "📝 Parcha ma'nosi",
  QUIZ: "🧠 Test (Quiz)",
};
const BOOK_TYPE = {
  SMALL: "📕 Kichik kitobcha (butun kitob)",
  BIG: "📚 Katta kitob (bob-bob)",
};

const mainMenuKeyboard = {
  keyboard: [[MENU.WORD, MENU.PASSAGE], [MENU.QUIZ]],
  resize_keyboard: true,
};
const bookTypeKeyboard = {
  keyboard: [[BOOK_TYPE.SMALL], [BOOK_TYPE.BIG]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

// ---------- Telegram helpers ----------

async function tg(method, params) {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }
  );
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
  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`
  );
  const buf = await fileRes.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}

// ---------- Claude API helpers ----------

async function callClaude(messages, maxTokens = 1024) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, messages }),
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
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
        { type: "text", text: prompt },
      ],
    },
  ]);
}

async function extractBookInfo(base64Image, mediaType) {
  const prompt =
    'Look at this photo of a book cover. Identify the title and author if visible. Respond ONLY with valid JSON, no markdown fences, no preamble: {"title": "...", "author": "..."} (use empty string for author if not visible/unknown).';
  const raw = await callClaude([
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
        { type: "text", text: prompt },
      ],
    },
  ]);
  const clean = raw.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error("Failed to parse book info JSON:", clean);
    return { title: "Unknown book", author: "" };
  }
}

async function generateQuizFromKnowledge(title, author, page) {
  const prompt = `You are a reading comprehension teacher. A child has been reading the book "${title}"${author ? ` by ${author}` : ""}. They report having read up through page ${page}.

Using your knowledge of this book, write exactly ${QUESTIONS_PER_QUIZ} multiple-choice reading comprehension questions covering that portion of the book. If you are not confident you know this specific book, write general age-appropriate reading comprehension questions consistent with the title/theme, and do not invent specific plot details you are not confident about.

Return ONLY valid JSON, no markdown fences, no preamble, in this exact format:
[
  {"question": "...", "options": {"A": "...", "B": "...", "C": "...", "D": "..."}, "correct": "A"},
  ...
]`;
  const raw = await callClaude([{ role: "user", content: prompt }], 2000);
  const clean = raw.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error("Failed to parse quiz JSON:", clean);
    return null;
  }
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
  await query(
    `UPDATE sessions SET ${setClause} WHERE telegram_user_id = $${keys.length + 1}`,
    [...values, userId]
  );
}

async function getChildren(userId) {
  return query("SELECT * FROM children WHERE telegram_user_id = $1 ORDER BY name", [userId]);
}

async function getActiveChild(session) {
  if (!session.active_child_id) return null;
  const rows = await query("SELECT * FROM children WHERE id = $1", [session.active_child_id]);
  return rows[0] || null;
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
        "📖 So'z ma'nosi — ask what a word means\n" +
        "📝 Parcha ma'nosi — ask what a passage means\n" +
        "🧠 Test — quiz on a book/chapter you've read"
    );
  }

  if (text?.startsWith("/addchild")) {
    const name = text.replace("/addchild", "").trim();
    if (!name) return sendText(chatId, "Usage: /addchild <name>");
    try {
      await query("INSERT INTO children (telegram_user_id, name) VALUES ($1, $2)", [userId, name]);
      const rows = await query(
        "SELECT id FROM children WHERE telegram_user_id=$1 AND name=$2",
        [userId, name]
      );
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
    const rows = await query(
      "SELECT * FROM children WHERE telegram_user_id=$1 AND name=$2",
      [userId, name]
    );
    if (!rows.length) return sendText(chatId, `No child named "${name}". Try /children.`);
    await updateSession(userId, { active_child_id: rows[0].id, mode: "idle" });
    return sendMenu(chatId, `✅ Active child set to "${name}".`);
  }

  const activeChild = await getActiveChild(session);

  if (text?.startsWith("/status")) {
    if (!activeChild) return sendText(chatId, "No active child. Use /use <name> first.");
    const rows = await query(
      "SELECT book_title, chapter_number, score_percent, passed, date FROM chapter_records WHERE child_id=$1 ORDER BY date DESC LIMIT 10",
      [activeChild.id]
    );
    if (!rows.length) return sendText(chatId, `${activeChild.name} has no quiz history yet.`);
    const lines = rows.map((r) => {
      return `${r.book_title} (p.${r.chapter_number}): ${r.score_percent}% ${r.passed ? "✅ Passed" : "❌ Failed"} (${new Date(r.date).toLocaleDateString()})`;
    });
    return sendText(chatId, `📊 Recent progress for ${activeChild.name}:\n` + lines.join("\n"));
  }

  if (text?.startsWith("/report")) {
    const name = text.replace("/report", "").trim() || activeChild?.name;
    const rows = await query(
      "SELECT * FROM children WHERE telegram_user_id=$1 AND name=$2",
      [userId, name]
    );
    const child = rows[0];
    if (!child) return sendText(chatId, "Usage: /report <child name>");
    const records = await query(
      "SELECT book_title, chapter_number, score_percent, passed, date FROM chapter_records WHERE child_id=$1 ORDER BY date",
      [child.id]
    );
    const explains = await query(
      "SELECT query_text, date FROM explain_log WHERE child_id=$1 ORDER BY date DESC LIMIT 15",
      [child.id]
    );
    let out = `📋 Full report for ${child.name}:\n\n📖 Quiz history:\n`;
    out += records.length
      ? records
          .map((r) => `${r.book_title} (p.${r.chapter_number}): ${r.score_percent}% ${r.passed ? "✅" : "❌"} (${new Date(r.date).toLocaleDateString()})`)
          .join("\n")
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
    return sendText(chatId, "Is this a small booklet (whole book) or a big book (chapter by chapter)?", bookTypeKeyboard);
  }

  // ---- State machine ----

  if (session.mode === "awaiting_word" && text) {
    const explanation = await explainText(text, false);
    await query(
      "INSERT INTO explain_log (child_id, content_type, query_text, response_text) VALUES ($1,'text',$2,$3)",
      [activeChild.id, text, explanation]
    );
    await updateSession(userId, { mode: "idle" });
    return sendMenu(chatId, explanation);
  }

  if (session.mode === "awaiting_passage") {
    if (message.photo) {
      const largestPhoto = message.photo[message.photo.length - 1];
      const base64 = await getTelegramFileBase64(largestPhoto.file_id);
      const explanation = await explainImage(base64, "image/jpeg", true);
      await query(
        "INSERT INTO explain_log (child_id, content_type, query_text, response_text) VALUES ($1,'image','[photo passage]',$2)",
        [activeChild.id, explanation]
      );
      await updateSession(userId, { mode: "idle" });
      return sendMenu(chatId, explanation);
    }
    if (text) {
      const explanation = await explainText(text, true);
      await query(
        "INSERT INTO explain_log (child_id, content_type, query_text, response_text) VALUES ($1,'text',$2,$3)",
        [activeChild.id, text, explanation]
      );
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
    await query(
      "INSERT INTO books (child_id, title) VALUES ($1, $2) ON CONFLICT (child_id, title) DO NOTHING",
      [activeChild.id, info.title]
    );
    await updateSession(userId, { mode: "quiz_awaiting_page", quiz_book_title: info.title, quiz_author: info.author || "" });
    return sendText(chatId, `"${info.title}" — what page have you read up to?`);
  }

  if (session.mode === "quiz_awaiting_page" && text) {
    const pageNum = parseInt(text.replace(/[^0-9]/g, ""), 10);
    if (isNaN(pageNum)) return sendText(chatId, "Please send just the page number.");
    await sendText(chatId, "Generating your quiz, one moment...");
    const questions = await generateQuizFromKnowledge(
      session.quiz_book_title,
      session.quiz_author,
      pageNum
    );
    if (!questions || !questions.length) {
      await updateSession(userId, { mode: "idle" });
      return sendMenu(chatId, "Sorry, I couldn't generate a quiz for that book. Please try 🧠 Test again.");
    }
    await updateSession(userId, {
      mode: "quiz",
      quiz_page: pageNum,
      quiz_questions_json: JSON.stringify(questions),
      quiz_current_index: 0,
      quiz_correct_count: 0,
    });
    return askQuizQuestion(chatId, questions, 0);
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
        "SELECT COUNT(*) as c FROM chapter_records WHERE child_id=$1 AND book_title=$2 AND chapter_number=$3",
        [activeChild.id, session.quiz_book_title, session.quiz_page]
      );
      await query(
        "INSERT INTO chapter_records (child_id, book_title, chapter_number, score_percent, passed, attempt_number) VALUES ($1,$2,$3,$4,$5,$6)",
        [activeChild.id, session.quiz_book_title, session.quiz_page, scorePercent, passed, Number(attemptRows[0].c) + 1]
      );
      await updateSession(userId, {
        mode: "idle",
        quiz_questions_json: null,
        quiz_current_index: 0,
        quiz_correct_count: 0,
      });
      const scopeLabel = `up to page ${session.quiz_page}`;
      if (passed) {
        return sendMenu(chatId, `🎉 ${activeChild.name} scored ${scorePercent}%! ✅ Passed "${session.quiz_book_title}" (${scopeLabel}).`);
      } else {
        return sendMenu(chatId, `Score: ${scorePercent}%. ❌ Not quite — please re-read "${session.quiz_book_title}" (${scopeLabel}) and try 🧠 Test again.`);
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
  return sendText(
    chatId,
    `Question ${idx + 1}/${questions.length}:\n${q.question}\n\n${optionsText}\n\nReply with A, B, C, or D.`
  );
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
