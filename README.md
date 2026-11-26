# AI × Frontend Weekly — email digest on Vercel

Every Thursday it collects the week's AI-for-frontend news from about 27 feeds (Smashing, CSS-Tricks, Frontend Masters, JS Weekly, Frontend Focus, The New Stack, web.dev, Chrome devs, Vercel, Netlify, Builder.io, Addy Osmani, dev.to, Hacker News, Reddit, and GitHub releases of the AI SDK, Transformers.js, WebLLM, CopilotKit, assistant-ui, Chrome DevTools MCP and Playwright MCP). It then has Claude **search the web** for anything the feeds missed, picks the best 12–20 items, writes a "why it matters" note for each one, and emails you the digest.

No framework and no npm dependencies: one function file, `api/digest.js`.

```
Vercel Cron (Mon 04:00 UTC = 09:00 Almaty)
   → /api/digest
      → fetch all RSS/Atom feeds in parallel, keep the last 7 days
      → keyword filter (AI ∩ frontend) + dedupe
      → Claude API (curation + web_search tool) → JSON
      → HTML email → Resend → your inbox
```

## Setup (about 15 minutes)

### 1. Get the API keys
| Service | What to do | Cost |
|---|---|---|
| **Anthropic** | console.anthropic.com → API Keys → create a key, add a few $ of credit | roughly a few cents per digest (plus web search fees) |
| **Resend** | resend.com → sign up → API Keys → create a key | free: 3,000 emails/month |

> Resend without your own domain sends from `onboarding@resend.dev`, and **only to the email address you signed up with**. That's fine for a personal digest. To send to other people, verify a domain in Resend and set `EMAIL_FROM`.

### 2. Push the project to GitHub
```bash
cd ai-frontend-digest
git init && git add . && git commit -m "AI frontend digest"
gh repo create ai-frontend-digest --private --source=. --push   # or create the repo on github.com
```

### 3. Import it into Vercel
vercel.com → **Add New → Project** → pick the repo → Framework Preset: **Other** → before you deploy, open **Environment Variables** and add:

| Name | Value |
|---|---|
| `CRON_SECRET` | a long random string (`openssl rand -hex 32`) |
| `ANTHROPIC_API_KEY` | `sk-ant-…` |
| `RESEND_API_KEY` | `re_…` |
| `EMAIL_TO` | your email |

Click **Deploy**. Vercel reads `vercel.json` and registers the weekly cron job automatically. You'll see it under **Project → Settings → Cron Jobs**.

### 4. Test it right away (don't wait for Thursday)
- **Preview in the browser, no email sent:**
  `https://YOUR-PROJECT.vercel.app/api/digest?secret=YOUR_CRON_SECRET&preview=1`
- **Send now:** open the same URL without `&preview=1`, or click **Run** next to the job in Settings → Cron Jobs.
- Logs: Project → **Logs** (filter by `/api/digest`).

A run takes about 30–120 seconds because of the web searches, so the first load is slow.

## Customising
- **Schedule:** change `"schedule"` in `vercel.json`. It uses UTC; `0 4 * * 4` is Thursday 09:00 at UTC+5. On the Hobby plan, cron can run at most once a day and fires at some point within the scheduled hour.
- **Sources:** edit the `SOURCES` array. `need: 'ai'` keeps only AI-related posts from a general frontend feed, `need: 'fe'` keeps only web-related posts from a general AI feed, and `need: null` keeps everything. Broken feeds are skipped automatically.
- **Topic/tone:** edit the prompt in `buildPrompt()`.
- **Env options:** `ANTHROPIC_MODEL`, `ENABLE_WEB_SEARCH=false` (cheaper, feeds only), `DAYS_BACK`, `EMAIL_FROM`.

## Local testing
```bash
npm run feeds        # which feeds respond + what passed the filters (no keys needed)
cp .env.example .env # fill it in
npm run preview      # writes preview.html
npm run send         # actually sends
```
Requires Node 20+.

## Troubleshooting
- **401 Unauthorized:** the `secret` in the URL doesn't match `CRON_SECRET`, or you added the variable after deploying. Redeploy after you change env vars.
- **Resend 403 "only send testing emails to your own address":** `EMAIL_TO` must be your Resend signup email, or you need to verify a domain.
- **Anthropic error about the `web_search` tool:** enable web search for your org in the Anthropic Console, or set `ENABLE_WEB_SEARCH=false`.
- **Timeout:** remove a few feeds or lower `max_uses` in `callClaude()`.
