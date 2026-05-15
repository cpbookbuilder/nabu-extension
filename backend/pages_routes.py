from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter()

# ── Shared styles ──────────────────────────────────────────────────────────

BASE_CSS = """
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0f1117;
    color: #e2e8f0;
    line-height: 1.6;
  }
  a { color: #f6c344; text-decoration: none; }
  a:hover { text-decoration: underline; }

  .nav {
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 32px; border-bottom: 1px solid #1e2330;
    position: sticky; top: 0; background: #0f1117; z-index: 10;
  }
  .nav-logo { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; color: #f6c344; }
  .nav-logo img { width: 32px; height: 32px; border-radius: 6px; }
  .nav-links { display: flex; gap: 24px; font-size: 14px; }

  .hero {
    text-align: center;
    padding: 80px 24px 60px;
    max-width: 700px;
    margin: 0 auto;
  }
  .hero img { width: 96px; height: 96px; border-radius: 22px; margin-bottom: 24px; box-shadow: 0 8px 32px rgba(246,195,68,.2); }
  .hero h1 { font-size: 48px; font-weight: 800; color: #fff; margin-bottom: 16px; }
  .hero h1 span { color: #f6c344; }
  .hero p { font-size: 18px; color: #94a3b8; max-width: 520px; margin: 0 auto 32px; }

  .btn-download {
    display: inline-flex; align-items: center; gap: 8px;
    background: #f6c344; color: #0f1117; font-weight: 700;
    font-size: 16px; padding: 14px 32px; border-radius: 12px;
    transition: opacity .15s;
  }
  .btn-download:hover { opacity: .85; text-decoration: none; }
  .btn-secondary {
    display: inline-flex; align-items: center; gap: 8px;
    border: 1px solid #2d3748; color: #94a3b8;
    font-size: 14px; padding: 10px 20px; border-radius: 10px;
    margin-left: 12px; transition: border-color .15s;
  }
  .btn-secondary:hover { border-color: #f6c344; color: #f6c344; text-decoration: none; }

  /* Screenshots */
  .screenshots {
    max-width: 960px; margin: 0 auto 20px; padding: 0 24px;
  }
  .screenshots h2 {
    text-align: center; font-size: 22px; font-weight: 700;
    color: #fff; margin-bottom: 24px;
  }
  .screenshot-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
    gap: 16px;
  }
  .screenshot-item {
    border-radius: 12px; overflow: hidden;
    border: 1px solid #1e2330;
    box-shadow: 0 4px 24px rgba(0,0,0,.4);
  }
  .screenshot-item img {
    width: 100%; height: auto; display: block;
  }
  .screenshot-caption {
    background: #141720; padding: 10px 14px;
    font-size: 12px; color: #64748b;
  }

  .features {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 20px; max-width: 900px; margin: 60px auto; padding: 0 24px;
  }
  .feature {
    background: #141720; border: 1px solid #1e2330;
    border-radius: 14px; padding: 24px;
  }
  .feature-icon { font-size: 28px; margin-bottom: 12px; }
  .feature h3 { font-size: 15px; color: #fff; margin-bottom: 6px; }
  .feature p { font-size: 13px; color: #64748b; }

  .install {
    max-width: 640px; margin: 0 auto 80px; padding: 0 24px;
  }
  .install h2 { font-size: 24px; font-weight: 700; color: #fff; margin-bottom: 24px; text-align: center; }
  .step {
    display: flex; gap: 16px; align-items: flex-start;
    margin-bottom: 20px; background: #141720;
    border: 1px solid #1e2330; border-radius: 12px; padding: 18px;
  }
  .step-num {
    width: 32px; height: 32px; border-radius: 50%;
    background: #f6c344; color: #0f1117; font-weight: 800;
    font-size: 14px; display: flex; align-items: center;
    justify-content: center; flex-shrink: 0;
  }
  .step-body h4 { font-size: 14px; color: #fff; margin-bottom: 4px; }
  .step-body p { font-size: 13px; color: #64748b; }
  .step-body code {
    background: #1e2330; padding: 2px 6px; border-radius: 4px;
    font-size: 12px; color: #f6c344; font-family: monospace;
  }

  footer {
    border-top: 1px solid #1e2330; text-align: center;
    padding: 24px; font-size: 12px; color: #475569;
  }
  footer a { color: #64748b; }

  /* Privacy */
  .prose {
    max-width: 720px; margin: 60px auto 80px; padding: 0 24px;
  }
  .prose h1 { font-size: 32px; font-weight: 800; color: #fff; margin-bottom: 8px; }
  .prose .subtitle { color: #64748b; font-size: 14px; margin-bottom: 40px; }
  .prose h2 { font-size: 18px; font-weight: 700; color: #fff; margin: 32px 0 12px; }
  .prose p { color: #94a3b8; margin-bottom: 14px; font-size: 15px; }
  .prose ul { color: #94a3b8; padding-left: 20px; margin-bottom: 14px; font-size: 15px; }
  .prose li { margin-bottom: 6px; }
  .prose strong { color: #e2e8f0; }
"""

NAV = """
<nav class="nav">
  <div class="nav-logo">
    <img src="/static/icon128.png" alt="Nabu"> Nabu
  </div>
  <div class="nav-links">
    <a href="/">Home</a>
    <a href="/privacy">Privacy</a>
    <a href="mailto:nabu.extension@gmail.com">Support</a>
  </div>
</nav>
"""

FOOTER = """
<footer>
  <p>© 2026 Nabu · <a href="/privacy">Privacy Policy</a> · <a href="mailto:nabu.extension@gmail.com">nabu.extension@gmail.com</a></p>
</footer>
"""


# ── Landing page ───────────────────────────────────────────────────────────

@router.get("/", response_class=HTMLResponse)
async def landing():
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nabu — AI threads for anything you read</title>
  <meta name="description" content="Anchor AI conversation threads to any text on the web. Ask questions, save insights, never lose context.">
  <style>{BASE_CSS}</style>
</head>
<body>
  {NAV}

  <section class="hero">
    <img src="/static/icon128.png" alt="Nabu icon">
    <h1>Read deeper with <span>Nabu</span></h1>
    <p>Anchor AI threads to anything you read. Ask questions, save insights, never lose context — on any page.</p>
    <a class="btn-download" href="/static/nabu.zip" download>
      ⬇ Download Extension
    </a>
    <a class="btn-secondary" href="#install">How to install</a>
    <p style="margin-top:16px; font-size:12px; color:#475569;">
      Direct link: <a href="/static/nabu.zip" download>nabu-extension-production.up.railway.app/static/nabu.zip</a>
    </p>
  </section>

  <div class="screenshots">
    <h2>See it in action</h2>
    <div class="screenshot-grid">
      <div class="screenshot-item">
        <img src="/static/screenshots/screenshot-1.png" alt="Nabu thread card anchored to selected text">
        <div class="screenshot-caption">Thread card anchored to selected text with AI response</div>
      </div>
      <div class="screenshot-item">
        <img src="/static/screenshots/screenshot-2.png" alt="Nabu quick action popover on text selection">
        <div class="screenshot-caption">Quick actions — Ask, What does this mean?, Explain more, Todo, Remind</div>
      </div>
    </div>
  </div>

  <div class="features">
    <div class="feature">
      <div class="feature-icon">🧵</div>
      <h3>Inline threads</h3>
      <p>Select any text and a thread card anchors right there. Ask follow-ups without losing your place.</p>
    </div>
    <div class="feature">
      <div class="feature-icon">💾</div>
      <h3>Threads persist</h3>
      <p>Come back to the same page and your threads are still there, exactly where you left them.</p>
    </div>
    <div class="feature">
      <div class="feature-icon">⚡</div>
      <h3>Quick actions</h3>
      <p>Select text and instantly ask "What does this mean?" or "Explain more" with one click.</p>
    </div>
    <div class="feature">
      <div class="feature-icon">📋</div>
      <h3>Todos & reminders</h3>
      <p>Save any selection as a todo or reminder. All organized in your history panel.</p>
    </div>
    <div class="feature">
      <div class="feature-icon">🔒</div>
      <h3>Private by design</h3>
      <p>Your threads stay in your browser. We never store your reading content or conversations.</p>
    </div>
    <div class="feature">
      <div class="feature-icon">🌐</div>
      <h3>Works everywhere</h3>
      <p>Any webpage — articles, research papers, docs, LLM outputs. One extension for everything.</p>
    </div>
  </div>

  <div class="install" id="install">
    <h2>How to install</h2>
    <div class="step">
      <div class="step-num">1</div>
      <div class="step-body">
        <h4>Download the extension</h4>
        <p>Click the download button above to get <code>nabu.zip</code></p>
      </div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div class="step-body">
        <h4>Unzip the file</h4>
        <p>Extract the <code>chrome-extension</code> folder anywhere on your computer.</p>
      </div>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <div class="step-body">
        <h4>Open Chrome Extensions</h4>
        <p>Go to <code>chrome://extensions</code> and enable <strong>Developer mode</strong> (top right toggle).</p>
      </div>
    </div>
    <div class="step">
      <div class="step-num">4</div>
      <div class="step-body">
        <h4>Load the extension</h4>
        <p>Click <strong>Load unpacked</strong> and select the <code>chrome-extension</code> folder.</p>
      </div>
    </div>
    <div class="step">
      <div class="step-num">5</div>
      <div class="step-body">
        <h4>Start reading</h4>
        <p>Visit any webpage, select text, and click <strong>Ask ✦</strong> to start your first thread.</p>
      </div>
    </div>
    <div class="step">
      <div class="step-num">6</div>
      <div class="step-body">
        <h4>Ask, follow up, and save</h4>
        <p>Type your question and hit Enter. The AI responds inline, anchored to your selection. Ask follow-ups in the same thread. Use <strong>What does this mean?</strong> or <strong>Explain more</strong> for instant answers. Save anything as a <strong>Todo</strong> or <strong>Reminder</strong> from the same popover. Click the extension icon to see your full history.</p>
      </div>
    </div>
  </div>

  {FOOTER}
</body>
</html>"""


# ── Privacy policy ─────────────────────────────────────────────────────────

@router.get("/privacy", response_class=HTMLResponse)
async def privacy():
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Privacy Policy — Nabu</title>
  <style>{BASE_CSS}</style>
</head>
<body>
  {NAV}

  <div class="prose">
    <h1>Privacy Policy</h1>
    <p class="subtitle">Last updated: May 2026</p>

    <h2>What Nabu is</h2>
    <p>Nabu is a Chrome extension that lets you anchor AI conversation threads to text on any webpage. Questions and responses are generated using OpenAI's API.</p>

    <h2>What data we collect</h2>
    <ul>
      <li><strong>Device ID</strong> — a randomly generated ID created when you install the extension. Used only to track your free question quota and subscription status. Never linked to your identity.</li>
      <li><strong>Usage count</strong> — the number of questions you've asked today. Reset every day at midnight UTC.</li>
      <li><strong>Email address</strong> — collected only if you upgrade to Pro (via Stripe checkout). Used solely to restore your subscription if you reinstall the extension. Never used for marketing.</li>
    </ul>

    <h2>What data we do NOT collect</h2>
    <ul>
      <li>The text you select or highlight on webpages</li>
      <li>The questions you ask or the AI responses you receive</li>
      <li>The URLs or pages you visit</li>
      <li>Your browsing history</li>
      <li>Any personally identifiable information beyond email (Pro users only)</li>
    </ul>

    <h2>How your data flows</h2>
    <p>When you ask a question, your selected text and question are sent directly to <strong>OpenAI's API</strong> to generate a response. This is the only time your content leaves your browser. Nabu's servers never see the content of your questions or answers.</p>
    <p>Your threads, history, and saved annotations are stored <strong>locally in your browser</strong> using Chrome's storage API and are never transmitted to our servers.</p>

    <h2>Third-party services</h2>
    <ul>
      <li><strong>OpenAI</strong> — processes your questions to generate AI responses. Subject to <a href="https://openai.com/policies/privacy-policy" target="_blank">OpenAI's Privacy Policy</a>.</li>
      <li><strong>Stripe</strong> — handles payment processing for Pro subscriptions. Subject to <a href="https://stripe.com/privacy" target="_blank">Stripe's Privacy Policy</a>. We never see your card details.</li>
    </ul>

    <h2>Data retention</h2>
    <p>Device IDs and usage counts are retained for 30 days of inactivity, then deleted. Email addresses for Pro subscribers are retained for the duration of the subscription and deleted within 30 days of cancellation.</p>

    <h2>Your rights</h2>
    <p>You can request deletion of your data at any time by emailing us. We will delete your device ID, usage history, and email address within 7 days.</p>

    <h2>Contact</h2>
    <p>Questions about this policy? Email us at <a href="mailto:nabu.extension@gmail.com">nabu.extension@gmail.com</a></p>
  </div>

  {FOOTER}
</body>
</html>"""
