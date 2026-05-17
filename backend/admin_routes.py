"""Admin dashboard — basic-auth gated metrics overview.

Set ADMIN_PASSWORD in env vars. Visit /admin in a browser; username is "admin".
The dashboard fetches /admin/stats which returns JSON, then renders Chart.js.

Intentionally narrow: only metrics derivable from the existing schema
(extension_users + extension_daily_usage). No event log, no PII.
"""
from __future__ import annotations
import os
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from db import get_db

router = APIRouter(prefix="/admin")
security = HTTPBasic()

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
# gpt-5-nano: $0.05/1M input + $0.40/1M output, assume ~1k in + 500 out per question
COST_PER_QUESTION = 0.05 / 1_000_000 * 1000 + 0.40 / 1_000_000 * 500


def check_auth(creds: HTTPBasicCredentials = Depends(security)):
    if not ADMIN_PASSWORD:
        raise HTTPException(
            status_code=503,
            detail="Admin disabled (set ADMIN_PASSWORD env var).",
        )
    ok = (
        secrets.compare_digest(creds.username, "admin")
        and secrets.compare_digest(creds.password, ADMIN_PASSWORD)
    )
    if not ok:
        raise HTTPException(
            status_code=401,
            detail="Unauthorized",
            headers={"WWW-Authenticate": "Basic"},
        )
    return True


@router.get("/stats")
async def stats(_: bool = Depends(check_auth), db: AsyncSession = Depends(get_db)):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    user_stats = (await db.execute(text("""
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE subscribed)               AS pro,
          COUNT(*) FILTER (WHERE cancelled_at IS NOT NULL) AS cancelled
        FROM extension_users
    """))).first()

    active_7d = (await db.execute(text("""
        SELECT COUNT(DISTINCT user_id) FROM extension_daily_usage
        WHERE date >= TO_CHAR(NOW() - INTERVAL '7 days', 'YYYY-MM-DD')
    """))).scalar()

    active_today = (await db.execute(text(
        "SELECT COUNT(DISTINCT user_id) FROM extension_daily_usage WHERE date = :d"
    ), {"d": today})).scalar()

    today_questions = (await db.execute(text(
        "SELECT COALESCE(SUM(count), 0) FROM extension_daily_usage WHERE date = :d"
    ), {"d": today})).scalar()

    hit_limit_today = (await db.execute(text(
        "SELECT COUNT(*) FROM extension_daily_usage WHERE date = :d AND count >= 10"
    ), {"d": today})).scalar()

    dau_30d = (await db.execute(text("""
        SELECT date, COUNT(DISTINCT user_id) AS dau
        FROM extension_daily_usage
        WHERE date >= TO_CHAR(NOW() - INTERVAL '30 days', 'YYYY-MM-DD')
        GROUP BY date ORDER BY date
    """))).all()

    questions_30d = (await db.execute(text("""
        SELECT date, SUM(count) AS questions
        FROM extension_daily_usage
        WHERE date >= TO_CHAR(NOW() - INTERVAL '30 days', 'YYYY-MM-DD')
        GROUP BY date ORDER BY date
    """))).all()

    installs_30d = (await db.execute(text("""
        SELECT TO_CHAR(created_at::date, 'YYYY-MM-DD') AS date, COUNT(*) AS installs
        FROM extension_users
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY TO_CHAR(created_at::date, 'YYYY-MM-DD')
        ORDER BY date
    """))).all()

    distribution_today = (await db.execute(text("""
        SELECT count AS bucket, COUNT(*) AS users
        FROM extension_daily_usage
        WHERE date = :d
        GROUP BY count ORDER BY count
    """), {"d": today})).all()

    total = user_stats[0] or 0
    pro = user_stats[1] or 0
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "kpis": {
            "total_users": total,
            "pro_users": pro,
            "cancelled_in_grace": user_stats[2] or 0,
            "active_today": active_today or 0,
            "active_7d": active_7d or 0,
            "questions_today": int(today_questions or 0),
            "hit_limit_today": hit_limit_today or 0,
            "estimated_today_cost_usd": round((today_questions or 0) * COST_PER_QUESTION, 4),
            "conversion_pct": round(100 * pro / max(total, 1), 2),
        },
        "dau_30d":       [{"date": r[0], "value": r[1]} for r in dau_30d],
        "questions_30d": [{"date": r[0], "value": int(r[1])} for r in questions_30d],
        "installs_30d":  [{"date": r[0], "value": r[1]} for r in installs_30d],
        "distribution_today": [{"bucket": r[0], "users": r[1]} for r in distribution_today],
    }


@router.get("", response_class=HTMLResponse)
async def admin_page(_: bool = Depends(check_auth)):
    return _DASHBOARD_HTML


_DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nabu — Admin</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e2e8f0; min-height: 100vh; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 14px 32px; border-bottom: 1px solid #1e2330; }
    header h1 { font-size: 18px; font-weight: 700; }
    header h1 span { color: #f6c344; }
    header .stamp { font-size: 11px; color: #64748b; }
    main { max-width: 1280px; margin: 0 auto; padding: 24px 32px 60px; }

    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 28px; }
    .kpi { background: #141720; border: 1px solid #1e2330; border-radius: 12px; padding: 16px; }
    .kpi-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 8px; }
    .kpi-value { font-size: 28px; font-weight: 700; color: #fff; line-height: 1.1; }
    .kpi-sub { font-size: 11px; color: #94a3b8; margin-top: 4px; }
    .kpi.accent .kpi-value { color: #f6c344; }
    .kpi.good   .kpi-value { color: #81c995; }
    .kpi.warn   .kpi-value { color: #fbbc04; }

    .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 28px; }
    .chart-card { background: #141720; border: 1px solid #1e2330; border-radius: 12px; padding: 18px; }
    .chart-title { font-size: 13px; font-weight: 600; color: #cbd5e1; margin-bottom: 12px; }
    .chart-wrap { position: relative; height: 240px; }
    .empty { text-align: center; color: #64748b; padding: 80px 0; font-size: 13px; }
    @media (max-width: 800px) { .charts { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <h1><span>Nabu</span> · Admin</h1>
    <span class="stamp" id="stamp">loading…</span>
  </header>
  <main id="root">
    <div class="empty">Loading metrics…</div>
  </main>

  <script>
  const fmt = n => (n ?? 0).toLocaleString();
  const fmtUSD = n => '$' + (n ?? 0).toFixed(2);

  async function load() {
    const res = await fetch('/admin/stats', { credentials: 'same-origin' });
    if (!res.ok) {
      document.getElementById('root').innerHTML = `<div class="empty">Failed to load: HTTP ${res.status}</div>`;
      return;
    }
    const d = await res.json();
    document.getElementById('stamp').textContent = 'as of ' + new Date(d.generated_at).toLocaleString();

    const k = d.kpis;
    const kpis = [
      ['Active (today)',   fmt(k.active_today),     null,                'good'],
      ['Active (7d)',      fmt(k.active_7d),        'unique devices',    'accent'],
      ['Total installs',   fmt(k.total_users),      null,                ''],
      ['Pro subscribers',  fmt(k.pro_users),        `${k.conversion_pct}% of installs`, 'accent'],
      ['Questions today',  fmt(k.questions_today),  `~${fmtUSD(k.estimated_today_cost_usd)} OpenAI`, ''],
      ['Hit limit today',  fmt(k.hit_limit_today),  k.active_today ? `${Math.round(100*k.hit_limit_today/k.active_today)}% of active` : '', 'warn'],
      ['Cancelled (grace)', fmt(k.cancelled_in_grace), 'in 30-day window', ''],
    ];

    document.getElementById('root').innerHTML = `
      <div class="kpis">
        ${kpis.map(([label, value, sub, cls]) => `
          <div class="kpi ${cls}">
            <div class="kpi-label">${label}</div>
            <div class="kpi-value">${value}</div>
            ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
          </div>
        `).join('')}
      </div>

      <div class="charts">
        <div class="chart-card">
          <div class="chart-title">Daily active users — last 30 days</div>
          <div class="chart-wrap"><canvas id="c-dau"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="chart-title">Questions per day — last 30 days</div>
          <div class="chart-wrap"><canvas id="c-q"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="chart-title">New installs per day — last 30 days</div>
          <div class="chart-wrap"><canvas id="c-inst"></canvas></div>
        </div>
        <div class="chart-card">
          <div class="chart-title">Questions-per-user today (distribution)</div>
          <div class="chart-wrap"><canvas id="c-dist"></canvas></div>
        </div>
      </div>
    `;

    const baseOpts = (yLabel) => ({
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#64748b', maxRotation: 0, autoSkipPadding: 16 }, grid: { color: '#1e2330' } },
        y: { ticks: { color: '#64748b' }, grid: { color: '#1e2330' }, beginAtZero: true,
             title: { display: !!yLabel, text: yLabel, color: '#64748b', font: { size: 11 } } },
      },
    });

    const line = (id, data, color) => new Chart(document.getElementById(id), {
      type: 'line',
      data: { labels: data.map(r => r.date.slice(5)), datasets: [{
        data: data.map(r => r.value),
        borderColor: color, backgroundColor: color + '33',
        fill: true, tension: 0.25, pointRadius: 2, borderWidth: 2,
      }]},
      options: baseOpts(),
    });
    const bar = (id, data, color, xKey='date', yKey='value', xFormat=v=>v.slice(5)) => new Chart(document.getElementById(id), {
      type: 'bar',
      data: { labels: data.map(r => xFormat(String(r[xKey]))), datasets: [{
        data: data.map(r => r[yKey]),
        backgroundColor: color,
      }]},
      options: baseOpts(),
    });

    if (d.dau_30d.length)        line('c-dau',  d.dau_30d,        '#8ab4f8'); else emptyChart('c-dau');
    if (d.questions_30d.length)  line('c-q',    d.questions_30d,  '#f6c344'); else emptyChart('c-q');
    if (d.installs_30d.length)   bar('c-inst',  d.installs_30d,   '#81c995'); else emptyChart('c-inst');
    if (d.distribution_today.length) {
      bar('c-dist', d.distribution_today, '#fdd663', 'bucket', 'users', v => v);
    } else emptyChart('c-dist');
  }

  function emptyChart(id) {
    const c = document.getElementById(id);
    c.parentElement.innerHTML = '<div class="empty">No data yet.</div>';
  }

  load();
  </script>
</body>
</html>
"""
