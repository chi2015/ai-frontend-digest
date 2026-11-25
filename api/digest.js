// AI × Frontend Weekly Digest — a single Vercel Function, zero npm dependencies.
//
// Pipeline:  RSS/Atom feeds  →  keyword filter + dedupe  →  Claude (curation + live web search)
//            →  HTML email  →  Resend
//
// Triggered weekly by Vercel Cron (see vercel.json). Can also be opened manually:
//   /api/digest?secret=YOUR_CRON_SECRET&preview=1   → shows the email in the browser, sends nothing
//   /api/digest?secret=YOUR_CRON_SECRET             → builds and sends the email now

const DAYS_BACK = Number(process.env.DAYS_BACK || 7);
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const WEB_SEARCH = process.env.ENABLE_WEB_SEARCH !== 'false';
const MAX_CANDIDATES = 140;

// ---------------------------------------------------------------------------
// 1. Sources. `need` = which keyword filter an item must pass:
//    'ai'  → general frontend feed, keep only AI-related items
//    'fe'  → general AI feed, keep only frontend/web-related items
//    null  → feed is already on-topic, keep everything
//    Feeds that fail or time out are skipped, so adding/removing is safe.
// ---------------------------------------------------------------------------
const SOURCES = [
  // Frontend portals & newsletters
  { name: 'Smashing Magazine', url: 'https://www.smashingmagazine.com/feed/', need: 'ai' },
  { name: 'CSS-Tricks', url: 'https://css-tricks.com/feed/', need: 'ai' },
  { name: 'JavaScript Weekly', url: 'https://javascriptweekly.com/rss', need: 'ai' },
  { name: 'Frontend Focus', url: 'https://frontendfoc.us/rss', need: 'ai' },
  { name: 'web.dev', url: 'https://web.dev/feed.xml', need: 'ai' },
  { name: 'Chrome for Developers', url: 'https://developer.chrome.com/static/blog/feed.xml', need: 'ai' },
  { name: 'Vercel Blog', url: 'https://vercel.com/atom', need: null },
  { name: 'Netlify Blog', url: 'https://www.netlify.com/blog/index.xml', need: 'ai' },

  // Community
  { name: 'dev.to #ai', url: 'https://dev.to/feed/tag/ai', need: 'fe' },
  { name: 'dev.to #frontend', url: 'https://dev.to/feed/tag/frontend', need: 'ai' },
  { name: 'dev.to #react', url: 'https://dev.to/feed/tag/react', need: 'ai' },
  { name: 'Hacker News (AI + frontend)', url: 'https://hnrss.org/newest?q=AI+frontend+OR+LLM+React+OR+AI+CSS+OR+AI+browser&points=20', need: null },
  { name: 'Hacker News (agents/MCP)', url: 'https://hnrss.org/newest?q=MCP+OR+coding+agent+OR+Cursor+OR+Claude+Code&points=40', need: null },
  { name: 'r/Frontend (top week)', url: 'https://www.reddit.com/r/Frontend/top/.rss?t=week', need: 'ai' },
  { name: 'r/webdev (top week)', url: 'https://www.reddit.com/r/webdev/top/.rss?t=week', need: 'ai' },

  // AI engineering
  { name: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/', need: null },
  { name: 'Latent Space', url: 'https://www.latent.space/feed', need: null },
  { name: 'Hugging Face Blog', url: 'https://huggingface.co/blog/feed.xml', need: 'fe' },
  { name: 'OpenAI News', url: 'https://openai.com/news/rss.xml', need: null },
  { name: 'Google Developers Blog', url: 'https://developers.googleblog.com/feeds/posts/default', need: 'ai' },

  // Releases of AI-for-frontend libraries
  { name: 'Vercel AI SDK releases', url: 'https://github.com/vercel/ai/releases.atom', need: null },
  { name: 'MCP TypeScript SDK releases', url: 'https://github.com/modelcontextprotocol/typescript-sdk/releases.atom', need: null },
  { name: 'Transformers.js releases', url: 'https://github.com/huggingface/transformers.js/releases.atom', need: null },
];

const AI_RE = /\b(ai|a\.i\.|llms?|gpt[-\w]*|claude|gemini|openai|anthropic|mistral|llama|agents?|agentic|mcp|copilot|cursor|windsurf|rag|embeddings?|prompts?|genai|generative|machine learning|vibe[- ]coding|v0|bolt\.new|lovable|webllm|webnn|transformers\.js|inference|chatbot|ai sdk)\b/i;
const FE_RE = /\b(front[- ]?end|react|vue|svelte|angular|solid|next\.?js|nuxt|astro|remix|css|html|javascript|typescript|browser|web ?apps?|ui|ux|components?|tailwind|vite|dom|webgpu|wasm|webassembly|chrome|safari|firefox|design systems?|accessibility|a11y|figma)\b/i;

// ---------------------------------------------------------------------------
// 2. Tiny RSS/Atom parser (good enough for real-world feeds, no deps)
// ---------------------------------------------------------------------------
function getTag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

function cleanText(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ') // second pass: tags that were entity-escaped in the feed
    .replace(/\s+/g, ' ')
    .trim();
}

function getLink(block) {
  const rss = cleanText(getTag(block, 'link'));
  if (rss.startsWith('http')) return rss;
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const pick = links.find((a) => /rel=["']alternate["']/.test(a)) || links.find((a) => !/rel=/.test(a)) || links[0];
  const href = pick && pick.match(/href=["']([^"']+)["']/);
  return href ? href[1].replace(/&amp;/g, '&') : cleanText(getTag(block, 'guid'));
}

function parseFeed(xml, source) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    const dateStr = getTag(b, 'pubDate') || getTag(b, 'published') || getTag(b, 'updated') || getTag(b, 'dc:date');
    return {
      source: source.name,
      need: source.need,
      title: cleanText(getTag(b, 'title')),
      url: getLink(b),
      date: dateStr ? new Date(cleanText(dateStr)) : null,
      summary: cleanText(getTag(b, 'description') || getTag(b, 'summary') || getTag(b, 'content')).slice(0, 280),
    };
  });
}

async function fetchFeed(source) {
  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': 'ai-frontend-digest/1.0 (personal newsletter bot)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { source: source.name, items: parseFeed(await res.text(), source) };
  } catch (err) {
    return { source: source.name, items: [], error: String(err.message || err) };
  }
}

async function collectCandidates() {
  const cutoff = Date.now() - DAYS_BACK * 864e5;
  const results = await Promise.all(SOURCES.map(fetchFeed));
  const seen = new Set();
  const items = [];

  for (const r of results) {
    let perSource = 0;
    const fresh = r.items
      .filter((i) => i.title && i.url && i.date && !isNaN(i.date) && i.date.getTime() >= cutoff)
      .sort((a, b) => b.date - a.date);
    for (const i of fresh) {
      const text = `${i.title} ${i.summary}`;
      if (i.need === 'ai' && !AI_RE.test(text)) continue;
      if (i.need === 'fe' && !FE_RE.test(text)) continue;
      const key = i.url.replace(/[?#].*$/, '').replace(/\/$/, '') + '|' + i.title.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(i);
      if (++perSource >= 15) break; // keep one noisy feed from dominating
    }
  }

  items.sort((a, b) => b.date - a.date);
  const report = results.map((r) => ({ source: r.source, fetched: r.items.length, error: r.error }));
  return { items: items.slice(0, MAX_CANDIDATES), report };
}

// ---------------------------------------------------------------------------
// 3. Claude: curate, group, summarise, and search the web for anything missed
// ---------------------------------------------------------------------------
function buildPrompt(items) {
  const today = new Date().toISOString().slice(0, 10);
  const list = items
    .map((i, n) => `[${n + 1}] ${i.title}\n    ${i.url}\n    ${i.source} · ${i.date.toISOString().slice(0, 10)}${i.summary ? `\n    ${i.summary}` : ''}`)
    .join('\n');

  return `You are the editor of a weekly newsletter for a frontend developer who builds browser apps and games and wants to stay on top of AI engineering as it affects the frontend world.

Today is ${today}. Cover the last ${DAYS_BACK} days.

Below are ${items.length} candidate items collected from RSS feeds (portals, blogs, Hacker News, Reddit, dev.to, GitHub releases).
${WEB_SEARCH ? `You also have a web_search tool. Use it (a few searches) to find important news from this week that the feeds missed: new AI models or APIs relevant to web devs, AI coding tools (Cursor, Claude Code, Copilot, v0, etc.), browser-side AI (WebGPU, WebNN, Chrome built-in AI), AI SDK/framework releases, notable articles.` : ''}

Editorial rules:
- Topic = the intersection of AI engineering and frontend/web development. Skip generic AI business news and generic frontend news with no AI angle, unless it is truly big.
- Pick the 12–20 most useful items. Prefer primary sources, releases, and substantive technical articles over hype and listicles. Merge duplicates about the same story.
- Use ONLY URLs that appear in the candidate list or in your web search results. Never invent URLs.
- For each item write a 1–2 sentence "why it matters" for a frontend dev, in plain English.

Reply with ONLY a JSON object, no markdown fences, in exactly this shape:
{
  "subject": "short email subject line, max 70 chars",
  "tldr": ["3 to 5 one-line bullet takeaways of the week"],
  "sections": [
    { "title": "e.g. Releases & APIs | AI Coding Tools | Browser & On-device AI | Articles & Tutorials | Worth a Look",
      "items": [ { "title": "...", "url": "https://...", "source": "...", "why": "..." } ] }
  ],
  "try_this_week": "one concrete thing to try or experiment with this week, 1–2 sentences"
}

CANDIDATES:
${list || '(no feed items this week — rely on web search)'}`;
}

async function callClaude(prompt) {
  const body = {
    model: MODEL,
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  };
  if (WEB_SEARCH) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }];

  // Server-side tools can return stop_reason "pause_turn"; continue the turn until done.
  for (let round = 0; round < 4; round++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.stop_reason === 'pause_turn') {
      body.messages = [...body.messages.slice(0, 1), { role: 'assistant', content: data.content }];
      continue;
    }
    const text = data.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    return parseJson(text);
  }
  throw new Error('Claude did not finish after several rounds');
}

function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('No JSON in Claude reply: ' + text.slice(0, 300));
  return JSON.parse(text.slice(start, end + 1));
}

// ---------------------------------------------------------------------------
// 4. Email HTML (inline styles, works in Gmail / Apple Mail / Outlook)
// ---------------------------------------------------------------------------
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u = '') => (/^https?:\/\//i.test(u) ? esc(u) : '#');

function renderEmail(d, stats) {
  const dateRange = `${new Date(Date.now() - DAYS_BACK * 864e5).toDateString().slice(4)} – ${new Date().toDateString().slice(4)}`;
  const sections = (d.sections || [])
    .map((s) => `
      <h2 style="font-size:16px;margin:28px 0 10px;padding-bottom:6px;border-bottom:2px solid #6d5dfc;color:#1a1a2e;">${esc(s.title)}</h2>
      ${(s.items || []).map((i) => `
        <div style="margin:0 0 16px;">
          <a href="${safeUrl(i.url)}" style="font-size:15px;font-weight:600;color:#3b2fd9;text-decoration:none;">${esc(i.title)}</a>
          <div style="font-size:12px;color:#888;margin:2px 0 4px;">${esc(i.source)}</div>
          <div style="font-size:14px;line-height:1.5;color:#333;">${esc(i.why)}</div>
        </div>`).join('')}`)
    .join('');

  return `<!doctype html><html><body style="margin:0;background:#f4f4f7;">
  <div style="max-width:640px;margin:0 auto;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#fff;">
    <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#6d5dfc;font-weight:700;">AI × Frontend Weekly</div>
    <h1 style="font-size:22px;margin:6px 0 4px;color:#1a1a2e;">${esc(d.subject || 'Your weekly digest')}</h1>
    <div style="font-size:13px;color:#888;margin-bottom:20px;">${esc(dateRange)}</div>
    <div style="background:#f3f1ff;border-radius:8px;padding:14px 18px;">
      <div style="font-weight:700;font-size:14px;margin-bottom:6px;color:#1a1a2e;">TL;DR</div>
      <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.6;color:#333;">${(d.tldr || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    </div>
    ${sections}
    ${d.try_this_week ? `<div style="margin-top:28px;background:#fff8e6;border-left:4px solid #f5a623;padding:12px 16px;font-size:14px;line-height:1.5;color:#333;"><b>Try this week:</b> ${esc(d.try_this_week)}</div>` : ''}
    <div style="margin-top:32px;font-size:11px;color:#aaa;">Curated by Claude from ${stats.candidates} items across ${stats.okSources}/${stats.totalSources} feeds${WEB_SEARCH ? ' + web search' : ''}.</div>
  </div></body></html>`;
}

// ---------------------------------------------------------------------------
// 5. Send via Resend (REST API, no SDK)
// ---------------------------------------------------------------------------
async function sendEmail(subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'AI Frontend Digest <onboarding@resend.dev>',
      to: process.env.EMAIL_TO.split(',').map((s) => s.trim()),
      subject,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}

export { collectCandidates, parseFeed, renderEmail }; // used by scripts/ for local testing

// ---------------------------------------------------------------------------
// 6. HTTP handler (Vercel Web-standard signature)
// ---------------------------------------------------------------------------
export async function GET(request) {
  const url = new URL(request.url);
  const secret = process.env.CRON_SECRET;
  const authorized =
    secret && (request.headers.get('authorization') === `Bearer ${secret}` || url.searchParams.get('secret') === secret);
  if (!authorized) return new Response('Unauthorized', { status: 401 });

  for (const k of ['ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'EMAIL_TO']) {
    if (!process.env[k]) return Response.json({ error: `Missing env var ${k}` }, { status: 500 });
  }

  try {
    const { items, report } = await collectCandidates();
    const digest = await callClaude(buildPrompt(items));
    const stats = { candidates: items.length, okSources: report.filter((r) => !r.error).length, totalSources: report.length };
    const html = renderEmail(digest, stats);
    const subject = `🤖 ${digest.subject || 'AI × Frontend Weekly'}`;

    if (url.searchParams.get('preview')) {
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const sent = await sendEmail(subject, html);
    return Response.json({ ok: true, emailId: sent.id, subject, ...stats, feeds: report });
  } catch (err) {
    console.error(err);
    return Response.json({ ok: false, error: String(err.message || err) }, { status: 500 });
  }
}
