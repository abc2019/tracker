# Reading Tracker Bot — GitHub + Railway Setup

## Steps

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Reading tracker bot"
   git remote add origin https://github.com/<you>/reading-tracker-bot.git
   git push -u origin main
   ```

2. **Create Telegram bot**: message @BotFather → `/newbot` → save the token

3. **Railway → New Project → Deploy from GitHub repo** → select this repo

4. **Add Postgres**: in the Railway project, click **+ New → Database → PostgreSQL**
   (Railway auto-injects `DATABASE_URL` into your service — no manual copying needed)

5. **Set variables** on your service (Settings → Variables):
   - `TELEGRAM_BOT_TOKEN` = token from BotFather
   - `ANTHROPIC_API_KEY` = your Claude API key

6. **Deploy** — Railway builds automatically. Copy the generated public URL
   (Settings → Networking → Generate Domain), e.g. `https://reading-tracker-bot-production.up.railway.app`

7. **Set Telegram webhook**:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-railway-domain>/webhook"
   ```
   Confirm `{"ok":true,...}`

8. **Test**: message your bot → `/start` → `/addchild Aziz` → `/use Aziz` → send a word

The app auto-creates all Postgres tables on first boot (`schema.sql` runs on startup).

## Notes
- `PASS_THRESHOLD` (80%) and `CLAUDE_MODEL` are constants at the top of `index.js`
- Quiz flow: `/quiz Book Title | Chapter#` → paste chapter text → bot asks 8 questions one at a time
- `/status` and `/report <name>` = your monitoring view (scores + every word/passage asked)
- Multiple children share one Telegram account; switch with `/use <name>`
