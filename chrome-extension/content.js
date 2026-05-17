(function () {
  'use strict';

  const COLORS = ['#1a73e8', '#0f9d58', '#f29900', '#a142f4'];
  let colorIdx = 0;
  let popoverTimer = null;
  let _saveTimer = null;
  const KATEX_CDN = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist';
  let _katexCss = null;

  async function ensureKaTeX() {
    if (_katexCss) return true;
    try {
      const res = await fetch(`${KATEX_CDN}/katex.min.css`);
      const css = await res.text();
      _katexCss = css.replace(/url\(fonts\//g, `url(${KATEX_CDN}/fonts/`);
    } catch (_) {}
    return !!window.katex;
  }

  function injectKaTeXCSS(shadowRoot) {
    if (!_katexCss || shadowRoot.querySelector('.katex-style')) return;
    const s = document.createElement('style');
    s.className = 'katex-style';
    s.textContent = _katexCss;
    shadowRoot.appendChild(s);
  }
  let _pendingRecords = [];
  let _pendingScrollId = null;
  let _recheckTimer = null;

  const threads = new Map(); // threadId → thread object (thread.p holds the DOM element)

  // ── Storage helpers ────────────────────────────────────────────────────────

  function pageKey() {
    return 'threads:' + location.href.split('#')[0];
  }

  function makeThreadId() {
    return 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  }

  function scheduleSave() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(saveThreads, 800);
  }

  async function saveThreads() {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const records = [...threads.values()]
      .filter(t => t.id && t.messages.length > 0)
      .map(t => ({
        id: t.id,
        anchor: t.anchor,
        color: t.color,
        pageContext: t.pageContext,
        messages: t.messages,
        createdAt: t.createdAt,
        savedAt: Date.now(),
      }))
      .filter(r => r.savedAt > cutoff);

    try {
      await chrome.storage.local.set({ [pageKey()]: records });
    } catch (_) {}

    await updateHistoryIndex(records);
  }

  async function updateHistoryIndex(records) {
    try {
      const { history: existing = [] } = await chrome.storage.local.get('history');
      const url = location.href.split('#')[0];
      const thisPage = records.map(r => ({
        id: r.id,
        url,
        pageTitle: document.title,
        anchor: r.anchor.slice(0, 120),
        surroundingText: (r.pageContext?.surroundingText || '').slice(0, 300),
        firstQuestion: (r.messages.find(m => m.role === 'user')?.content || '').slice(0, 200),
        createdAt: r.createdAt,
        savedAt: r.savedAt,
      }));
      const merged = [...thisPage, ...existing.filter(e => e.url !== url)]
        .sort((a, b) => b.savedAt - a.savedAt || b.createdAt - a.createdAt)
        .slice(0, 200);
      await chrome.storage.local.set({ history: merged });
    } catch (_) {}
  }

  // ── Restore pipeline ───────────────────────────────────────────────────────

  async function restoreThreads() {
    try {
      const { [pageKey()]: records = [] } = await chrome.storage.local.get(pageKey());
      if (!records.length) return;
      _pendingRecords = [...records];
      setTimeout(() => tryRestore(0), 600);
    } catch (_) {}
  }

  function tryRestore(attempt) {
    const still = [];
    for (const rec of _pendingRecords) {
      const p = findAnchorElement(rec.anchor);
      if (p) {
        openThread(p, rec.anchor, rec.pageContext, {
          id: rec.id,
          messages: rec.messages,
          color: rec.color,
          createdAt: rec.createdAt,
          restored: true,
        });
        // If this is the thread we were asked to scroll to, do it now
        if (_pendingScrollId && _pendingScrollId === rec.id) {
          setTimeout(() => { scrollToThreadById(rec.id); _pendingScrollId = null; }, 300);
        }
      } else {
        still.push(rec);
      }
    }
    _pendingRecords = still;
    if (still.length && attempt < 10) {
      setTimeout(() => tryRestore(attempt + 1), 1000);
    }
  }

  function scrollToThreadById(id) {
    const thread = threads.get(id);
    if (!thread) return false;
    const { p, anchor } = thread;
    thread.card.classList.remove('collapsed');
    const liveP = p.isConnected ? p : findAnchorElement(anchor);
    if (liveP) liveP.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const target = thread.highlightSpan?.isConnected ? thread.highlightSpan : (liveP ?? p);
    setTimeout(() => {
      target.style.outline = `2px solid ${thread.color}`;
      target.style.outlineOffset = '3px';
      setTimeout(() => { target.style.outline = ''; target.style.outlineOffset = ''; }, 1500);
    }, 500);
    return true;
  }

  function recheckHighlights() {
    for (const thread of threads.values()) {
      if (thread.highlightSpan && !thread.highlightSpan.isConnected) {
        const liveP = thread.p.isConnected ? thread.p : findAnchorElement(thread.anchor);
        if (liveP) {
          thread.highlightSpan = highlightAnchorText(liveP, thread.anchor, thread.color);
          makeHighlightClickable(thread.highlightSpan, thread);
        }
      }
    }
  }

  function findAnchorElement(anchor) {
    const needle = anchor.slice(0, 80).replace(/\s+/g, ' ').trim();
    for (const p of document.querySelectorAll('[data-a-tagged]')) {
      if (p.textContent.replace(/\s+/g, ' ').includes(needle)) return p;
    }
    return null;
  }

  // ── Session (device ID → JWT, auto-registered on first use) ──────────────

  const BACKEND_URL = 'https://nabu-extension-production.up.railway.app';

  // Retry a fetch-based operation on network errors (not HTTP errors).
  // Handles Railway redeployment windows (~30s downtime).
  async function withRetry(fn, retries = 4, delayMs = 3000) {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn();
      } catch (err) {
        const isNetworkError = err instanceof TypeError; // fetch throws TypeError on network failure
        if (!isNetworkError || i === retries - 1) throw err;
        await new Promise(r => setTimeout(r, delayMs * (i + 1))); // 3s, 6s, 9s, 12s
      }
    }
  }

  async function getSession() {
    let { annotate_jwt, device_id } = await chrome.storage.local.get(['annotate_jwt', 'device_id']);

    // Generate device_id if missing (onInstalled may not have fired yet)
    if (!device_id) {
      device_id = crypto.randomUUID();
      await chrome.storage.local.set({ device_id });
    }

    if (annotate_jwt) return { jwt: annotate_jwt, device_id };

    const res = await withRetry(() => fetch(`${BACKEND_URL}/api/extension/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id }),
    }));
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Registration failed (${res.status})`);
    }
    const { token } = await res.json();
    await chrome.storage.local.set({ annotate_jwt: token });
    return { jwt: token, device_id };
  }

  function isOurShadowDOM(el) {
    const root = el.getRootNode();
    return root !== document && root.host?.classList?.contains('annotate-card');
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  function init() {
    initFloatingBtn();
    watchForResponses();
    document.addEventListener('mouseup', onMouseUp, { capture: true });
    document.addEventListener('scroll', () => requestAnimationFrame(repositionAll), { passive: true, capture: true });
    window.addEventListener('resize', () => requestAnimationFrame(repositionAll), { passive: true });
    // Handle SPA navigation. popstate covers back/forward; pushState/replaceState
    // are patched to fire a synthetic 'nabu:locationchange' so client-side routes
    // (Gemini, Notion, GitHub, etc.) also reload threads.
    let _lastUrl = location.href;
    function _onLocationChange() {
      if (location.href === _lastUrl) return;
      _lastUrl = location.href;
      for (const id of [...threads.keys()]) closeThread(id);
      _pendingRecords = [];
      setTimeout(restoreThreads, 600);
    }
    window.addEventListener('popstate', _onLocationChange);
    window.addEventListener('nabu:locationchange', _onLocationChange);
    for (const fn of ['pushState', 'replaceState']) {
      const original = history[fn];
      history[fn] = function () {
        const ret = original.apply(this, arguments);
        window.dispatchEvent(new Event('nabu:locationchange'));
        return ret;
      };
    }
    restoreThreads();

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type !== 'scrollToThread') return;
      if (!scrollToThreadById(msg.threadId)) {
        // Thread not restored yet — scroll once it is
        _pendingScrollId = msg.threadId;
      }
    });
  }

  // ── DOM observation ────────────────────────────────────────────────────────

  function watchForResponses() {
    document.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6').forEach(attachBtn);

    const obs = new MutationObserver(mutations => {
      let attached = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches?.('p, li, h1, h2, h3, h4, h5, h6')) { attachBtn(node); attached = true; }
          node.querySelectorAll?.('p, li, h1, h2, h3, h4, h5, h6').forEach(el => { attachBtn(el); attached = true; });
        }
      }
      if (attached && _pendingRecords.length) tryRestore(0);
      // Debounced recheck: reapply any highlights that Gemini's re-render removed
      clearTimeout(_recheckTimer);
      _recheckTimer = setTimeout(recheckHighlights, 600);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // Single floating button — avoids inserting into page DOM (breaks React hydration on ChatGPT etc.)
  let _floatingBtn = null;
  let _floatingTarget = null;
  let _floatingHideTimer = null;

  function initFloatingBtn() {
    _floatingBtn = document.createElement('button');
    _floatingBtn.id = 'annotate-floating-btn';
    _floatingBtn.title = 'Start thread';
    _floatingBtn.tabIndex = -1; // never steal focus via tab or click
    _floatingBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor">
      <path d="M2 5a2 2 0 012-2h12a2 2 0 012 2v7a2 2 0 01-2 2H6l-4 4V5z"/>
    </svg>`;
    _floatingBtn.addEventListener('mouseenter', () => clearTimeout(_floatingHideTimer));
    _floatingBtn.addEventListener('mouseleave', () => {
      _floatingHideTimer = setTimeout(_hideFloatingBtn, 300);
    });
    _floatingBtn.addEventListener('mousedown', e => e.preventDefault()); // prevent focus steal
    _floatingBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (_floatingTarget?.isConnected) openThread(_floatingTarget, _floatingTarget.textContent.trim(), getPageContext(_floatingTarget));
      _hideFloatingBtn();
    });
    document.body.appendChild(_floatingBtn);
  }

  function _showFloatingBtn(p) {
    clearTimeout(_floatingHideTimer);
    _floatingTarget = p;
    const rect = p.getBoundingClientRect();
    // position: fixed so no scroll offset needed
    _floatingBtn.style.top = `${rect.top + rect.height / 2}px`;
    _floatingBtn.style.left = `${rect.right + 4}px`;
    _floatingBtn.classList.add('visible');
  }

  function _hideFloatingBtn() {
    _floatingBtn?.classList.remove('visible');
    _floatingTarget = null;
  }

  function attachBtn(p) {
    if (p.dataset.aTagged) return;
    if (isOurShadowDOM(p)) return;
    // Never touch elements inside editable areas — breaks React input on ChatGPT/Claude etc.
    if (p.closest('[contenteditable], textarea, input')) return;
    p.dataset.aTagged = '1';
    p.addEventListener('mouseenter', () => _showFloatingBtn(p));
    p.addEventListener('mouseleave', () => {
      _floatingHideTimer = setTimeout(_hideFloatingBtn, 300);
    });
  }

  function getPageContext(p) {
    const container = p.closest('model-response, message-content, response-container');
    let surroundingText = '';

    try {
      if (container) {
        const blocks = [...container.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6')];
        const idx = blocks.indexOf(p);
        if (idx !== -1) {
          const cleanText = el => el.textContent.trim();
          const nearby = blocks.slice(Math.max(0, idx - 2), idx + 3);
          const lines = nearby.flatMap(el => cleanText(el).split('\n')).map(l => l.trim()).filter(Boolean);
          surroundingText = lines.slice(0, 11).join('\n');
        }
      }
    } catch (_) {}

    if (!surroundingText) surroundingText = p.textContent.trim();
    return { surroundingText };
  }

  // ── Selection popover ──────────────────────────────────────────────────────

  function onMouseUp() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) { removePopover(); return; }

    const text = sel.toString().trim();
    if (!text || text.length < 2) { removePopover(); return; }

    let rect, anchorEl, savedRange;
    try {
      const range = sel.getRangeAt(0);
      savedRange = range.cloneRange(); // clone before selection is cleared
      rect = range.getBoundingClientRect();
      const node = range.commonAncestorContainer;
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      if (!el || isOurShadowDOM(el)) return;
      anchorEl = el.closest('p, li, h1, h2, h3, h4, h5, h6') || el.closest('[class]') || el;
    } catch (_) { return; }

    clearTimeout(popoverTimer);
    popoverTimer = setTimeout(() => {
      removePopover();
      showPopover(text, rect, anchorEl, savedRange);
    }, 50);
  }

  function showPopover(text, rect, anchorEl, savedRange) {
    const div = document.createElement('div');
    div.id = 'annotate-popover';
    div.style.top = `${rect.bottom + window.scrollY + 8}px`;
    div.style.left = `${rect.left + rect.width / 2}px`;
    div.innerHTML = `
      <button id="annotate-ask">Ask ✦</button>
      <button id="annotate-mean">What does this mean?</button>
      <button id="annotate-explain">Explain more</button>
      <button id="annotate-todo">+ Todo</button>
      <button id="annotate-remind">🔖 Save</button>
      <button id="annotate-dashboard" title="Open Nabu dashboard" style="background:#f6c344;color:#202124;font-weight:700;">Nabu ↗</button>
    `;
    document.body.appendChild(div);

    const pRect = anchorEl.getBoundingClientRect();
    const selectionOffset = Math.max(0, rect.top - pRect.top);

    document.getElementById('annotate-ask').addEventListener('click', () => {
      clearTimeout(popoverTimer);
      openThread(anchorEl, text, getPageContext(anchorEl), { savedRange, selectionOffset });
      removePopover();
      window.getSelection()?.removeAllRanges();
    });

    document.getElementById('annotate-mean').addEventListener('click', () => {
      clearTimeout(popoverTimer);
      openThread(anchorEl, text, getPageContext(anchorEl), { savedRange, selectionOffset, question: 'What does this mean?' });
      removePopover();
      window.getSelection()?.removeAllRanges();
    });

    document.getElementById('annotate-explain').addEventListener('click', () => {
      clearTimeout(popoverTimer);
      openThread(anchorEl, text, getPageContext(anchorEl), { savedRange, selectionOffset, question: 'Explain this more.' });
      removePopover();
      window.getSelection()?.removeAllRanges();
    });

    document.getElementById('annotate-todo').addEventListener('click', () => {
      clearTimeout(popoverTimer);
      saveTodoOrReminder('todos', text, anchorEl);
      removePopover();
      window.getSelection()?.removeAllRanges();
    });

    document.getElementById('annotate-remind').addEventListener('click', () => {
      clearTimeout(popoverTimer);
      saveTodoOrReminder('reminders', text, anchorEl);
      removePopover();
      window.getSelection()?.removeAllRanges();
    });

    document.getElementById('annotate-dashboard').addEventListener('click', () => {
      clearTimeout(popoverTimer);
      chrome.runtime.sendMessage({ type: 'openDashboard' });
      removePopover();
      window.getSelection()?.removeAllRanges();
    });
  }

  async function saveTodoOrReminder(type, anchor, anchorEl) {
    const ctx = getPageContext(anchorEl);
    const entry = {
      id: makeThreadId(),
      url: location.href.split('#')[0],
      pageTitle: document.title,
      anchor: anchor.slice(0, 300),
      surroundingText: (ctx.surroundingText || '').slice(0, 500),
      createdAt: Date.now(),
      ...(type === 'todos' ? { done: false } : {}),
    };
    try {
      const existing = (await chrome.storage.local.get(type))[type] || [];
      await chrome.storage.local.set({ [type]: [entry, ...existing].slice(0, 500) });
    } catch (_) {}
    showToast(type === 'todos' ? '✓ Added to todos' : '🔔 Reminder saved');
  }

  function showToast(msg) {
    document.getElementById('annotate-toast')?.remove();
    const el = document.createElement('div');
    el.id = 'annotate-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('annotate-toast-out'), 1800);
    setTimeout(() => el.remove(), 2300);
  }

  function removePopover() {
    document.getElementById('annotate-popover')?.remove();
  }

  // ── Thread cards ───────────────────────────────────────────────────────────

  // Returns any existing thread whose anchor paragraph matches p.
  // Used to avoid duplicate paragraph-button threads (still allow multiple selection threads).
  function getThreadByP(p) {
    for (const t of threads.values()) if (t.p === p) return t;
    return null;
  }

  function openThread(p, anchor, pageContext = {}, opts = {}) {
    // For paragraph-button clicks (full paragraph as anchor), reuse any existing thread on that element
    const isFullParagraph = anchor.length >= p.textContent.replace(/\s+/g, ' ').trim().length * 0.85;
    if (isFullParagraph) {
      const existing = getThreadByP(p);
      if (existing) { existing.card.shadowRoot.getElementById('inp').focus(); return; }
    }

    const color = opts.color || COLORS[colorIdx++ % COLORS.length];
    const id = opts.id || makeThreadId();

    const selectionOffset = opts.selectionOffset ?? 0;
    const highlightSpan = opts.restored ? null : highlightAnchorText(p, anchor, color, opts.savedRange);
    const card = buildCard(anchor, color);
    document.body.appendChild(card);

    const thread = { id, p, card, messages: opts.messages ? [...opts.messages] : [], anchor, pageContext, color, abortCtrl: null, highlightSpan, selectionOffset, createdAt: opts.createdAt || Date.now() };
    threads.set(id, thread);
    makeHighlightClickable(highlightSpan, thread);
    positionCard(thread);
    resolveCollisions();

    if (thread.messages.length) {
      ensureKaTeX().then(() => injectKaTeXCSS(card.shadowRoot));
      for (const msg of thread.messages) addMsg(thread, msg.role, msg.content);
      const assistantCount = thread.messages.filter(m => m.role === 'assistant').length;
      if (assistantCount > 0) card.shadowRoot.getElementById('badge').textContent = assistantCount;
    }

    const root = card.shadowRoot;
    root.getElementById('close').onclick = () => closeThread(id);
    root.getElementById('send').onclick = () => sendMessage(id);
    root.getElementById('collapse').onclick = () => card.classList.toggle('collapsed');
    root.getElementById('snippet').onclick = () => scrollToAnchor(id);
    root.getElementById('inp').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(id); }
    });
    root.getElementById('inp').addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    });

    if (opts.restored) {
      card.classList.add('collapsed');
    } else if (opts.question) {
      setTimeout(() => {
        const inp = root.getElementById('inp');
        inp.value = opts.question;
        sendMessage(id);
      }, 100);
    } else {
      setTimeout(() => root.getElementById('inp').focus(), 100);
    }
  }

  function closeThread(id) {
    const thread = threads.get(id);
    if (!thread) return;
    thread.abortCtrl?.abort();
    thread.card.remove();
    removeHighlight(thread.highlightSpan);
    threads.delete(id);
    scheduleSave();
  }

  function positionCard(thread) {
    const liveP = thread.p.isConnected ? thread.p : findAnchorElement(thread.anchor || '');
    if (liveP) thread.card.style.top = `${liveP.getBoundingClientRect().top + (thread.selectionOffset || 0)}px`;
  }

  // Push overlapping cards apart so they're all accessible.
  function resolveCollisions() {
    const items = [...threads.values()]
      .map(t => ({ t, top: parseFloat(t.card.style.top) || 0 }))
      .sort((a, b) => a.top - b.top);
    for (let i = 1; i < items.length; i++) {
      const gap = items[i].top - items[i - 1].top;
      if (gap < 48) {
        items[i].top = items[i - 1].top + 48;
        items[i].t.card.style.top = `${items[i].top}px`;
      }
    }
  }

  function repositionAll() {
    for (const thread of threads.values()) positionCard(thread);
    resolveCollisions();
  }

  // ── Messaging ──────────────────────────────────────────────────────────────

  async function sendMessage(id) {
    const thread = threads.get(id);
    if (!thread) return;

    const root = thread.card.shadowRoot;
    const inp = root.getElementById('inp');
    const q = inp.value.trim();
    if (!q) return;

    inp.value = '';
    inp.style.height = 'auto';

    let session;
    try {
      session = await getSession();
    } catch (err) {
      addMsg(thread, 'assistant', `⚠️ ${err.message}`);
      return;
    }
    if (!session) {
      addMsg(thread, 'assistant', '⚠️ Could not connect to Nabu servers. Please try again.');
      return;
    }

    thread.messages.push({ role: 'user', content: q });
    addMsg(thread, 'user', q);

    const msgEl = addMsg(thread, 'assistant', '', true);
    thread.abortCtrl?.abort();
    thread.abortCtrl = new AbortController();

    try {
      const text = await streamFromBackend(buildApiMessages(thread), msgEl, thread, session.jwt);
      await ensureKaTeX();
      injectKaTeXCSS(root);
      msgEl.classList.remove('streaming');
      const rendered = renderMarkdown(text);
      if (!msgEl._md) { msgEl._md = true; msgEl.innerHTML = rendered; }
      thread.messages.push({ role: 'assistant', content: text });
      root.getElementById('badge').textContent = root.getElementById('msgs').querySelectorAll('.msg.assistant').length;
      scheduleSave();
    } catch (err) {
      msgEl.classList.remove('streaming');
      if (err.name === 'AbortError') return;
      if (err.isLimitReached) {
        const now = new Date();
        const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
        const hoursLeft = Math.ceil((midnight - now) / 3600000);
        const resetMsg = hoursLeft <= 1 ? 'Resets in less than 1 hour.' : `Resets in ${hoursLeft} hours.`;
        msgEl.innerHTML = `Daily limit reached. ${resetMsg} <span style="color:#1a73e8;text-decoration:underline;cursor:pointer;" id="nabu-upgrade-link">Upgrade for $4.99/mo</span> for unlimited access.`;

        msgEl.style.color = '#c5221f';
        const upgradeLink = msgEl.querySelector('#nabu-upgrade-link');
        upgradeLink.addEventListener('click', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          upgradeLink.textContent = 'Opening checkout…';
          const { annotate_jwt } = await chrome.storage.local.get('annotate_jwt');
          if (!annotate_jwt) {
            upgradeLink.textContent = 'Session error — refresh and try again';
            return;
          }
          try {
            const res = await fetch(`${BACKEND_URL}/api/extension/create-checkout`, {
              method: 'POST', headers: { Authorization: `Bearer ${annotate_jwt}` },
            });
            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              upgradeLink.textContent = `Error: ${err.detail || res.status}`;
              return;
            }
            const { url } = await res.json();
            window.open(url, '_blank');
            upgradeLink.textContent = 'Upgrade for $4.99/mo';
          } catch (err) {
            upgradeLink.textContent = `Error: ${err.message}`;
          }
        });
      } else {
        msgEl.textContent = `Error: ${err.message}`;
        msgEl.style.color = '#c5221f';
      }
    }
  }

  function buildApiMessages(thread) {
    const { anchor, pageContext: { surroundingText = '' } } = thread;

    let contextBlock = '';
    if (surroundingText) contextBlock += `Surrounding context:\n${surroundingText}\n\n`;
    contextBlock += `Specific passage the user is asking about:\n"${anchor}"`;

    const msgs = [
      { role: 'system', content: 'You are a helpful assistant. The user is reading content and wants to ask follow-up questions. Use the provided context to give accurate, focused answers. Be concise.' },
      { role: 'user', content: `${contextBlock}\n\nQuestion: ${thread.messages[0].content}` },
    ];
    for (let i = 1; i < thread.messages.length; i++) msgs.push(thread.messages[i]);
    return msgs;
  }

  function addMsg(thread, role, text, streaming = false) {
    const root = thread.card.shadowRoot;
    const msgs = root.getElementById('msgs');
    const el = document.createElement('div');
    el.className = `msg ${role}${streaming ? ' streaming' : ''}`;
    if (role === 'assistant' && !streaming && text) {
      el._md = true; el.innerHTML = renderMarkdown(text);
    } else {
      el.textContent = text;
    }
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  function renderMarkdown(text) {
    // Extract math regions first (before HTML-escaping) so they survive the pipeline
    const mathMap = {};
    let mi = 0;
    const ph = (html) => { const k = `\x00M${mi++}\x00`; mathMap[k] = html; return k; };
    const renderMath = (src, display) => {
      if (!window.katex) return escapeHtml(src);
      try {
        return window.katex.renderToString(src, { output: 'html', displayMode: display, throwOnError: false });
      } catch (_) { return escapeHtml(src); }
    };

    // Display math: $$...$$ and \[...\]
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => ph(renderMath(m, true)));
    text = text.replace(/\\\[([\s\S]+?)\\\]/g,  (_, m) => ph(renderMath(m, true)));
    // Inline math: $...$ and \(...\) — require non-digit immediately after opening $
    // and non-digit immediately before closing $ to avoid matching prices like "$5 and $10"
    text = text.replace(/\$(?=\S)([^$\n]*?[^\d\s$])\$(?!\d)/g, (_, m) => ph(renderMath(m, false)));
    text = text.replace(/\\\((.+?)\\\)/g,         (_, m) => ph(renderMath(m, false)));

    let html = text
      .split(/(```[\s\S]*?```)/g)
      .map(seg => {
        if (seg.startsWith('```')) {
          const code = seg.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
          return `<pre><code>${escapeHtml(code)}</code></pre>`;
        }
        let h = escapeHtml(seg);
        h = h.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
        h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
        h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
        h = h.replace(/^#{1,3} (.+)/gm, '<strong>$1</strong>');
        h = h.replace(/^[-*] (.+)/gm, '<li>$1</li>');
        h = h.replace(/^\d+\. (.+)/gm, '<li>$1</li>');
        h = h.replace(/(<li>[\s\S]*?<\/li>)(\n<li>[\s\S]*?<\/li>)*/g, m => `<ul>${m}</ul>`);
        h = h.replace(/\n/g, '<br>');
        return h;
      })
      .join('');

    // Restore math HTML (placeholders survived escapeHtml unchanged since they use \x00)
    for (const [k, v] of Object.entries(mathMap)) html = html.replace(k, v);
    return html;
  }

  async function streamFromBackend(messages, el, thread, jwt) {
    let attempt = 0;
    const res = await withRetry(async () => {
      if (attempt++ > 0) el.textContent = `Connecting… (attempt ${attempt})`;
      return fetch(`${BACKEND_URL}/api/extension/annotate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
        signal: thread.abortCtrl.signal,
      });
    });
    if (res.status === 401) {
      await chrome.storage.local.remove('annotate_jwt');
      throw new Error('Session expired — please try again.');
    }
    if (res.status === 429) {
      const err = new Error('limit_reached');
      err.isLimitReached = true;
      throw err;
    }
    if (!res.ok) throw new Error(`Server error ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') return text;
        try {
          const msg = JSON.parse(payload);
          if (msg.delta) { text += msg.delta; el.innerHTML = renderMarkdown(text); }
          if (msg.timing) {
            console.log('[Nabu timing]',
              `total ${msg.timing.total_ms}ms`,
              `(auth+db ${msg.timing.auth_db_ms}ms,`,
              `openai TTFT ${msg.timing.openai_ttft_ms}ms,`,
              `openai gen ${msg.timing.openai_gen_ms}ms)`,
            );
          }
        } catch { /* partial chunk */ }
      }
    }
    return text;
  }

  // ── Text highlight ─────────────────────────────────────────────────────────

  function highlightAnchorText(p, anchor, color, savedRange) {
    const paraText = p.textContent.replace(/\s+/g, ' ').trim();
    // For short elements (headings, short lines) use a tighter threshold so partial selections get highlighted
    const threshold = paraText.length < 60 ? 0.98 : 0.9;
    if (!anchor || anchor.length >= paraText.length * threshold) return null;

    try {
      // Prefer the saved selection range (handles multi-line correctly).
      // Fall back to text search for restored threads.
      let range = null;
      if (savedRange?.commonAncestorContainer?.isConnected) {
        range = savedRange;
      } else {
        range = findTextRange(p, anchor.slice(0, 120));
      }
      if (!range) return null;

      const span = document.createElement('span');
      span.className = 'annotate-highlight';
      span.style.cssText = `background: rgba(255, 214, 0, 0.45); border-radius: 2px; padding: 1px 0;`;

      try {
        range.surroundContents(span);
      } catch (_) {
        span.appendChild(range.extractContents());
        range.insertNode(span);
      }
      return span;
    } catch (_) {
      return null;
    }
  }

  function makeHighlightClickable(span, thread) {
    if (!span) return;
    span.style.cursor = 'pointer';
    span.addEventListener('click', e => {
      e.stopPropagation();
      thread.card.classList.remove('collapsed');
      setTimeout(() => thread.card.shadowRoot.getElementById('inp').focus(), 50);
    });
  }

  function removeHighlight(span) {
    if (!span?.parentNode) return;
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  }

  // ── Anchor navigation ──────────────────────────────────────────────────────

  function scrollToAnchor(id) {
    const thread = threads.get(id);
    if (!thread) return;
    const { p, anchor } = thread;

    const liveP = p.isConnected ? p : findAnchorElement(anchor);
    if (!liveP) return;

    if (!thread.highlightSpan?.isConnected) {
      thread.highlightSpan = highlightAnchorText(liveP, anchor, thread.color);
      makeHighlightClickable(thread.highlightSpan, thread);
    }

    const target = thread.highlightSpan?.isConnected ? thread.highlightSpan : liveP;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const paraText = liveP.textContent.trim();
    if (anchor && anchor.length < paraText.length * 0.95) {
      try {
        const range = findTextRange(liveP, anchor.slice(0, 100));
        if (range) {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          setTimeout(() => sel.removeAllRanges(), 2500);
          return;
        }
      } catch (_) {}
    }

    const origOutline = liveP.style.outline;
    liveP.style.outline = `2px solid ${thread.color || '#f29900'}`;
    liveP.style.outlineOffset = '3px';
    liveP.style.transition = 'outline 0.3s';
    setTimeout(() => { liveP.style.outline = origOutline; }, 1500);
  }

  function findTextRange(el, text) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.textContent.indexOf(text);
      if (idx !== -1) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + text.length);
        return range;
      }
    }
    return null;
  }

  // ── Card builder ───────────────────────────────────────────────────────────

  function buildCard(context, color) {
    const wrap = document.createElement('div');
    wrap.className = 'annotate-card';

    const root = wrap.attachShadow({ mode: 'open' });
    const snippet = context.length > 140 ? context.slice(0, 140) + '…' : context;

    root.innerHTML = `
      <style>
        :host {
          all: initial;
          font-family: 'Google Sans', Roboto, Arial, sans-serif;
          font-size: 13px;
          color: #202124;
          position: fixed;
          right: 16px;
          width: 300px;
          background: #fff;
          border-radius: 8px;
          box-shadow: 0 1px 3px rgba(0,0,0,.2), 0 4px 12px rgba(0,0,0,.12);
          display: flex;
          flex-direction: column;
          z-index: 2147483647;
          max-height: 440px;
          overflow: hidden;
        }
        #header {
          padding: 10px 10px 8px 12px;
          border-bottom: 1px solid #e8eaed;
          display: flex;
          align-items: flex-start;
          gap: 8px;
          flex-shrink: 0;
        }
        #bar {
          width: 3px;
          min-height: 18px;
          border-radius: 2px;
          background: ${color};
          flex-shrink: 0;
          margin-top: 1px;
          align-self: stretch;
        }
        #snippet {
          flex: 1;
          font-size: 11px;
          color: #5f6368;
          line-height: 1.5;
          overflow: hidden;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          cursor: pointer;
        }
        #snippet:hover { color: #1a73e8; }
        #close {
          background: none; border: none; cursor: pointer;
          color: #80868b; font-size: 20px; line-height: 1;
          padding: 0 2px; flex-shrink: 0; margin-top: -1px;
        }
        #close:hover { color: #202124; }
        #msgs {
          flex: 1;
          overflow-y: auto;
          padding: 8px 12px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          min-height: 0;
        }
        #msgs:empty { display: none; }
        .msg {
          padding: 7px 10px;
          border-radius: 8px;
          line-height: 1.55;
          white-space: pre-wrap;
          word-break: break-word;
          font-size: 13px;
        }
        .msg.user {
          background: #e8f0fe;
          color: #174ea6;
          align-self: flex-end;
          max-width: 88%;
          border-radius: 8px 8px 2px 8px;
        }
        .msg.assistant {
          background: #f8f9fa;
          color: #202124;
          border-radius: 8px 8px 8px 2px;
        }
        .msg.streaming::after {
          content: '▋';
          animation: blink 1s step-end infinite;
          color: #9aa0a6;
        }
        @keyframes blink { 50% { opacity: 0; } }
        .msg.assistant strong { font-weight: 600; }
        .msg.assistant em { font-style: italic; }
        .msg.assistant code {
          background: #e8eaed; border-radius: 3px;
          padding: 1px 4px; font-family: monospace; font-size: 12px;
        }
        .msg.assistant pre {
          background: #e8eaed; border-radius: 6px;
          padding: 8px 10px; overflow-x: auto; margin: 4px 0;
        }
        .msg.assistant pre code { background: none; padding: 0; font-size: 12px; }
        .msg.assistant ul { padding-left: 16px; margin: 4px 0; }
        .msg.assistant li { margin: 2px 0; }
        #footer {
          padding: 8px 8px 8px 10px;
          border-top: 1px solid #e8eaed;
          display: flex;
          gap: 6px;
          align-items: flex-end;
          flex-shrink: 0;
        }
        #inp {
          flex: 1;
          background: #f8f9fa;
          border: 1px solid #e8eaed;
          border-radius: 16px;
          padding: 6px 12px;
          color: #202124;
          font-size: 13px;
          font-family: inherit;
          outline: none;
          resize: none;
          line-height: 1.4;
          max-height: 100px;
          overflow-y: auto;
        }
        #inp::placeholder { color: #9aa0a6; }
        #inp:focus { border-color: ${color}; background: #fff; }
        #send {
          background: ${color};
          border: none;
          border-radius: 50%;
          width: 30px;
          height: 30px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          transition: opacity 0.1s;
        }
        #send:hover { opacity: 0.85; }
        #send svg { width: 13px; height: 13px; }
        #collapse {
          background: none; border: none; cursor: pointer;
          color: #80868b; padding: 0 2px; flex-shrink: 0;
          display: flex; align-items: center; margin-top: 1px;
        }
        #collapse:hover { color: #202124; }
        #collapse svg { width: 14px; height: 14px; transition: transform 0.2s; }
        :host(.collapsed) #collapse svg { transform: rotate(-90deg); }
        :host(.collapsed) #msgs,
        :host(.collapsed) #footer { display: none; }
        :host(.collapsed) { max-height: none; }
        #badge {
          display: none;
          font-size: 10px;
          font-weight: 600;
          background: ${color};
          color: #fff;
          border-radius: 10px;
          padding: 1px 6px;
          flex-shrink: 0;
          align-self: center;
        }
        :host(.collapsed) #badge { display: block; }
      </style>
      <div id="header">
        <button id="collapse" title="Collapse">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
        <div id="bar"></div>
        <div id="snippet">${escapeHtml(snippet)}</div>
        <span id="badge">0</span>
        <button id="close">×</button>
      </div>
      <div id="msgs"></div>
      <div id="footer">
        <textarea id="inp" rows="1" placeholder="Ask a follow-up…"></textarea>
        <button id="send">
          <svg viewBox="0 0 24 24" fill="white">
            <path d="M2 21l21-9L2 3v7l15 2-15 2z"/>
          </svg>
        </button>
      </div>
    `;

    return wrap;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  init();
})();
