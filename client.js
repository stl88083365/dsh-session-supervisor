/**
 * Session supervisor Client panel: a sidebar entry + full page with live pair
 * cards and the durable review-report journal (filter, search, detail).
 * Plain React.createElement (no JSX), host theme tokens only, own controls.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-supervisor',
  factory(require) {
    const React = require('react');
    const { useState, useEffect, useCallback } = React;
    const h = React.createElement;
    const PANEL_ID = 'session-supervisor';
    const API = '/api/session-supervisor';
    const NS = 'session-supervisor';
    const THEME_KEY = 'session-supervisor:ios-theme';

    /* ---------------------------------------------------------------- locale */
    const DICT = {
      zh: {
        'nav.label': '会话监督',
        'title': '会话监督面板',
        'subtitle': '执行会话完成后串行送审；监督结论与整改指令的记录都在这里。',
        'pairs': '监督对',
        'pairs.empty': '暂无监督对（在任意会话里调用 supervision_start 创建）。',
        'reports': '审查报告',
        'reports.empty': '没有符合筛选条件的报告记录。',
        'refresh': '刷新',
        'auto': '自动刷新',
        'search': '搜索摘要/指令/需求…',
        'filter.all': '全部',
        'filter.pair': '建对',
        'filter.review': '评审',
        'filter.needs_fix': '整改',
        'filter.complete': '通过',
        'filter.halted': '熔断',
        'filter.handover': '接力',
  'filter.pairing': '配对',
  'pairing': '配对',
  'pairing.ok': '1 执行↔1 监督',
  'pairing.conflict': '发现重复对',
  'retired': '已接力老会话',
      'filter.client-error': '浏览器错误',
      'filter.user-review': '客户反馈',
      'filter.requirement': '验收标准',
        'detail.title': '详情',
        'detail.empty': '点击左边的报告条目查看全文。',
        'worker': '执行',
        'supervisor': '监督',
        'running': '运行中',
        'idle': '空闲',
        'state': '状态',
        'phase': '阶段',
        'pending-report': '等整改上报',
        'pending-done': '等完成上报',
        'reported': '已上报',
        'auto-tag': '自动纳入',
        'checklist': '逐项核验',
        'rounds': '评审',
        'fixes': '修复',
        'handovers': '接力',
        'context': '上下文',
        'trigger': '触发',
        'summary': '结论摘要',
        'fix': '整改指令',
        'reason': '原因',
        'requirement': '需求',
        'prev': '旧会话',
        'new': '新会话',
        'sid': '会话',
        'loading': '读取中…',
        'error': '读取失败：',
        'feedback.placeholder': '把问题反馈给评审（作为硬证据，下一轮评审必须处理）…',
        'feedback.send': '反馈给评审',
        'feedback.ok': '已送入监督评审回路',
        'feedback.fail': '反馈失败：',
        'diag.title': '浏览器错误上报（最近）',
        'diag.empty': '暂无浏览器错误上报记录',
        'theme.auto': '自动',
        'theme.light': '浅色',
        'theme.dark': '深色',
      },
      en: {
        'nav.label': 'Supervision',
        'title': 'Session supervision',
        'subtitle': 'Serial reviews after the executor reports done; verdicts and fix instructions live here.',
        'pairs': 'Pairs',
        'pairs.empty': 'No pairs yet (call supervision_start in any session).',
        'reports': 'Review reports',
        'reports.empty': 'No reports match this filter.',
        'refresh': 'Refresh',
        'auto': 'Auto',
        'search': 'Search summaries / instructions…',
        'filter.all': 'All',
        'filter.pair': 'Pair',
        'filter.review': 'Review',
        'filter.needs_fix': 'Fix',
        'filter.complete': 'Done',
        'filter.halted': 'Halt',
        'filter.handover': 'Relay',
  'filter.pairing': 'Pairing',
  'pairing': 'Pairing',
  'pairing.ok': '1 executor ↔ 1 supervisor',
  'pairing.conflict': 'duplicate pair(s)',
  'retired': 'relayed-out sessions',
      'filter.client-error': 'UI errors',
      'filter.user-review': 'Feedback',
      'filter.requirement': 'Acceptance',
        'detail.title': 'Detail',
        'detail.empty': 'Pick a report to read it.',
        'worker': 'Executor',
        'supervisor': 'Supervisor',
        'running': 'running',
        'idle': 'idle',
        'state': 'State',
        'phase': 'Phase',
        'pending-report': 'awaiting fix report',
        'pending-done': 'awaiting done report',
        'reported': 'reported',
        'auto-tag': 'auto',
        'checklist': 'Checklist',
        'rounds': 'Reviews',
        'fixes': 'Fixes',
        'handovers': 'Relays',
        'context': 'Context',
        'trigger': 'Trigger',
        'summary': 'Summary',
        'fix': 'Fix instructions',
        'reason': 'Reason',
        'requirement': 'Requirement',
        'prev': 'Old session',
        'new': 'New session',
        'sid': 'Session',
        'loading': 'Loading…',
        'error': 'Load failed: ',
        'feedback.placeholder': 'Report a problem to the review loop (hard evidence)…',
        'feedback.send': 'Send to review',
        'feedback.ok': 'Sent into supervision review loop',
        'feedback.fail': 'Feedback failed: ',
        'diag.title': 'Browser error uploads (recent)',
        'diag.empty': 'No browser errors reported',
        'theme.auto': 'Auto',
        'theme.light': 'Light',
        'theme.dark': 'Dark',
      },
    };
    function pickLocale(ctx) {
      try {
        const snap = ctx.locale && ctx.locale.getLocale && ctx.locale.getLocale();
        const id = String((snap && (snap.active || snap.id)) || 'en').toLowerCase();
        return id.indexOf('zh') === 0 ? 'zh' : 'en';
      } catch { return 'en'; }
    }

    /* ----------------------------------------------------------------- styles
       iOS / SwiftUI grouped style. Every colour is explicit and paired
       (text on background), so nothing depends on host theme tokens. */
    const CSS = `
      .sus-page {
        --ios-bg:#f2f2f7; --ios-card:#ffffff; --ios-tint:#007aff;
        --ios-sep:rgba(60,60,67,.16); --ios-veil:rgba(120,120,128,.12);
        --ios-t1:#1c1c1e; --ios-t2:#6c6c71;
        --ios-green:#207b36; --ios-red:#c0322b; --ios-orange:#9a5b00; --ios-blue:#005ec4;
        --ios-sel-bg:rgba(0,122,255,.14); --ios-sel-ink:#005ec4; --ios-sel-ring:rgba(0,122,255,.42);
        color-scheme: light;
        font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','SF Pro Display','Segoe UI Variable Text','Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif;
        -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
        font-size:14px; line-height:1.45; letter-spacing:-0.01em;
        box-sizing:border-box; min-height:100%;
        padding:22px 24px 44px;
        background:var(--ios-bg); color:var(--ios-t1);
      }
      .sus-page *, .sus-page *::before, .sus-page *::after { box-sizing:border-box; }
      @media (prefers-reduced-motion: reduce) {
        .sus-page, .sus-page * { transition:none !important; animation:none !important; }
      }
      body[data-ds-dark-theme] .sus-page:not([data-ios]),
      .sus-page[data-ios="dark"] {
        --ios-bg:#000000; --ios-card:#1c1c1e; --ios-tint:#0a84ff;
        --ios-sep:rgba(84,84,88,.56); --ios-veil:rgba(120,120,128,.24);
        --ios-t1:#ffffff; --ios-t2:rgba(235,235,245,.72);
        --ios-green:#30d158; --ios-red:#ff6961; --ios-orange:#ffd60a; --ios-blue:#47a3ff;
        --ios-sel-bg:rgba(10,132,255,.26); --ios-sel-ink:#47a3ff; --ios-sel-ring:rgba(10,132,255,.6);
        color-scheme: dark;
      }
      .sus-page[data-ios="light"] {
        --ios-bg:#f2f2f7; --ios-card:#ffffff; --ios-tint:#007aff;
        --ios-sep:rgba(60,60,67,.16); --ios-veil:rgba(120,120,128,.12);
        --ios-t1:#1c1c1e; --ios-t2:#6c6c71;
        --ios-green:#207b36; --ios-red:#c0322b; --ios-orange:#9a5b00; --ios-blue:#005ec4;
        --ios-sel-bg:rgba(0,122,255,.14); --ios-sel-ink:#005ec4; --ios-sel-ring:rgba(0,122,255,.42);
        color-scheme: light;
      }

      .sus-head { display:flex; flex-wrap:wrap; align-items:flex-start; justify-content:space-between; gap:12px 18px; margin-bottom:18px; }
      .sus-head h1 { margin:0 0 5px; font-size:26px; line-height:1.18; font-weight:700; letter-spacing:-0.026em; color:var(--ios-t1); }
      .sus-head p { margin:0; font-size:13px; line-height:1.5; color:var(--ios-t2); max-width:760px; }
      .sus-page h3 { margin:22px 0 10px; font-size:19px; line-height:1.25; font-weight:700; letter-spacing:-0.022em; color:var(--ios-t1); }
      .sus-page h4 { margin:0 0 4px; font-size:11px; line-height:1.3; font-weight:600; letter-spacing:.05em; text-transform:uppercase; color:var(--ios-t2); }

      .sus-bar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:14px; }

      .sus-chip {
        appearance:none; -webkit-appearance:none; font:inherit; font-size:13px; font-weight:500;
        line-height:1; padding:8px 14px; border-radius:999px; cursor:pointer;
        -webkit-tap-highlight-color:transparent;
        background:var(--ios-card); color:var(--ios-t1); border:1px solid var(--ios-sep);
        box-shadow:0 0.5px 1px rgba(0,0,0,.05); transition:transform .12s ease, background .15s ease, border-color .15s ease;
      }
      .sus-chip:hover { background:var(--ios-veil); border-color:var(--ios-t2); }
      .sus-chip:active { transform:scale(.96); }
      .sus-chip[data-on="1"] { background:var(--ios-sel-bg); border-color:var(--ios-sel-ring); color:var(--ios-sel-ink); font-weight:600; }
      .sus-chip[data-on="1"]:hover { background:var(--ios-sel-bg); border-color:var(--ios-sel-ink); }
      .sus-page :is(.sus-chip, .sus-seg > button, .sus-item, .sus-input):focus-visible {
        outline:none; box-shadow:0 0 0 3px var(--ios-sel-ring); border-radius:10px;
      }

      .sus-seg { display:inline-flex; padding:2px; gap:2px; border-radius:10px; background:var(--ios-veil); }
      .sus-seg > button { appearance:none; border:0; font:inherit; font-size:12.5px; font-weight:500; line-height:1;
        padding:6px 12px; border-radius:8px; background:transparent; color:var(--ios-t1); cursor:pointer;
        transition:background .15s ease, box-shadow .15s ease; }
      .sus-seg > button[data-on="1"] { background:var(--ios-card); color:var(--ios-t1); font-weight:600;
        box-shadow:0 1px 3px rgba(0,0,0,.14), 0 0 0.5px rgba(0,0,0,.1); }

      .sus-page ::-webkit-scrollbar { width:9px; height:9px; }
      .sus-page ::-webkit-scrollbar-track { background:transparent; }
      .sus-page ::-webkit-scrollbar-thumb { background:rgba(120,120,128,.35); border-radius:99px; }
      .sus-page ::-webkit-scrollbar-thumb:hover { background:rgba(120,120,128,.55); }

      .sus-input {
        flex:1 1 220px; min-width:170px; font:inherit; font-size:14px;
        padding:9px 13px; border-radius:11px; border:1px solid transparent; outline:none;
        background:var(--ios-veil); color:var(--ios-t1);
        transition:border-color .15s ease, box-shadow .15s ease;
      }
      .sus-input::placeholder { color:var(--ios-t2); opacity:1; }
      .sus-input:focus { background:var(--ios-card); border-color:var(--ios-tint); box-shadow:0 0 0 3.5px rgba(0,122,255,.22); }

      .sus-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(270px,1fr)); gap:12px; margin-bottom:6px; }
      .sus-card {
        border-radius:16px; padding:14px 16px; border:1px solid var(--ios-sep);
        background:var(--ios-card); box-shadow:0 1px 2px rgba(0,0,0,.04);
      }
      .sus-card > b { display:block; margin-bottom:8px; font-size:15px; font-weight:600; letter-spacing:-0.02em;
        color:var(--ios-t1); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .sus-kv { display:flex; justify-content:space-between; align-items:center; gap:12px; font-size:13px; line-height:1.9; }
      .sus-kv > span:first-child { color:var(--ios-t2); flex:0 0 auto; }
      .sus-kv > span:last-child { color:var(--ios-t1); text-align:right; }

      .sus-badge { display:inline-block; border-radius:999px; padding:3px 9px; font-size:11.5px; font-weight:600;
        letter-spacing:.01em; background:var(--ios-veil); color:var(--ios-t1); }
      .sus-badge[data-k="active"], .sus-badge[data-k="complete"] { background:rgba(52,199,89,.18); color:var(--ios-green); }
      .sus-badge[data-k="halted"], .sus-badge[data-k="stopped"], .sus-badge[data-k="client-error"] { background:rgba(255,59,48,.16); color:var(--ios-red); }
      .sus-badge[data-k="reviewing"], .sus-badge[data-k="needs_fix"], .sus-badge[data-k="review"] { background:rgba(255,149,0,.20); color:var(--ios-orange); }
      .sus-badge[data-k="pair"], .sus-badge[data-k="handover"], .sus-badge[data-k="requirement"], .sus-badge[data-k="user-review"] { background:var(--ios-sel-bg); color:var(--ios-blue); }

      .sus-cols { display:grid; grid-template-columns:minmax(0,1.1fr) minmax(0,1fr); gap:14px; align-items:start; }
      @media (max-width:900px) { .sus-cols { grid-template-columns:1fr; } }

      .sus-list { border-radius:16px; overflow:hidden auto; overscroll-behavior:contain;
        border:1px solid var(--ios-sep); background:var(--ios-card); max-height:62vh; }
      .sus-item { display:flex; gap:9px; align-items:baseline; padding:11px 14px; cursor:pointer;
        -webkit-tap-highlight-color:transparent; outline:none;
        border-bottom:1px solid var(--ios-sep); color:var(--ios-t1); }
      .sus-item:last-child { border-bottom:0; }
      .sus-item:hover { background:var(--ios-veil); }
      .sus-item[data-sel="1"] { background:var(--ios-sel-bg); box-shadow:inset 3px 0 0 var(--ios-sel-ink); }
      .sus-item .t { flex:0 0 auto; font-size:12px; font-variant-numeric:tabular-nums; color:var(--ios-t2); }
      .sus-item .k { flex:0 0 auto; font-size:11.5px; }
      .sus-item .s { flex:1 1 auto; min-width:0; font-size:13.5px; color:var(--ios-t1);
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

      .sus-detail { border-radius:16px; padding:16px 18px; border:1px solid var(--ios-sep);
        background:var(--ios-card); max-height:62vh; overflow:hidden auto; overscroll-behavior:contain;
        box-shadow:0 1px 2px rgba(0,0,0,.04); }
      .sus-detail h3 { margin:0 0 10px; font-size:17px; }
      .sus-detail pre { white-space:pre-wrap; word-break:break-word; margin:0 0 14px; padding:10px 12px;
        font-family:ui-monospace,SFMono-Regular,'SF Mono','Cascadia Code',Consolas,monospace;
        font-size:12.5px; line-height:1.6; color:var(--ios-t1);
        background:var(--ios-veil); border-radius:10px; }

      .sus-muted { color:var(--ios-t2); }
      .sus-spin { padding:14px; color:var(--ios-t2); }
      .sus-err { color:var(--ios-red); }
      .sus-ok { color:var(--ios-green); }
    `;

    const KIND_LABEL = { pair: 'filter.pair', review: 'filter.review', verdict: '', handover: 'filter.handover', pairing: 'filter.pairing', halted: 'filter.halted', stopped: 'filter.halted' };

    function fmtTime(ts) { try { return new Date(ts).toLocaleString(); } catch { return String(ts); } }
    function fmtShort(ts) { try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }
    function kfmt(v) { return typeof v === 'number' && isFinite(v) ? `${Math.round(v / 1000)}k` : '—'; }

    function eventTitle(ev, t) {
      const d = ev.data || {};
      if (ev.kind === 'pair') return `${t('requirement')}: ${d.requirement || ''}`;
      if (ev.kind === 'review') return `${t('trigger')}: ${d.trigger || ''}`;
      if (ev.kind === 'verdict') return `[${d.verdict}] ${d.summary || ''}`;
      if (ev.kind === 'handover') return `${ev.pairName || ev.pairId} · ${d.side === 'worker' ? t('worker') : t('supervisor')} → ${t('new')} ${(d.newId || '').slice(8, 16)}`;
      if (ev.kind === 'halted') return d.reason || '';
      if (ev.kind === 'client-error') return `UI: ${d.message || ''}`;
      if (ev.kind === 'user-review') return `客户: ${d.text || ''}`;
      if (ev.kind === 'requirement') return `验收: ${(d.acceptance || []).join(' / ') || d.note || ''}`;
      if (ev.kind === 'pairing') { const d2 = ev.data || {}; return `${d2.action || ''}${d2.dropped ? ' → ' + (Array.isArray(d2.dropped) ? d2.dropped.join('/') : d2.dropped) : ''}${d2.kept ? '（保留 ' + d2.kept + '）' : ''}${d2.count ? '（复原 ' + d2.count + ' 对' + (d2.dormant ? '，休眠 ' + d2.dormant : '') + '）' : ''}`; }
    if (ev.kind === 'stopped') return `${ev.pairId} stopped`;
      return ev.kind;
    }

    function iconKind(ev) {
      const d = ev.data || {};
      if (ev.kind === 'verdict') return d.verdict === 'complete' ? 'complete' : 'needs_fix';
      return ev.kind;
    }

    function PanelIcon(props) {
      return h('svg', {
        viewBox: '0 0 64 64', width: props.size || 18, height: props.size || 18, 'aria-hidden': true,
        style: { display: 'block', opacity: props.active ? 1 : 0.72 },
        fill: 'none', stroke: 'currentColor', strokeWidth: 5,
      },
        h('circle', { cx: 32, cy: 24, r: 9 }),
        h('path', { d: 'M24 36 C16 39 16 48 24 51', strokeLinecap: 'round' }),
        h('path', { d: 'M40 36 C48 39 48 48 40 51', strokeLinecap: 'round' }),
        h('line', { x1: 32, y1: 39, x2: 32, y2: 47, strokeLinecap: 'round' }),
        h('line', { x1: 27, y1: 43, x2: 37, y2: 43, strokeLinecap: 'round' }),
      );
    }

    function Page(props) {
      const ctx = props.ctx;
      const [lang, setLang] = useState(() => pickLocale(ctx));
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const [filter, setFilter] = useState('all');
      const [text, setText] = useState('');
      const [selected, setSelected] = useState(null);
      const [auto, setAuto] = useState(true);
      const [rev, setRev] = useState(0);
      const [feedback, setFeedback] = useState('');
      const [feedbackMsg, setFeedbackMsg] = useState('');
      const [theme, setTheme] = useState(() => {
        try { return window.localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; }
      });

      useEffect(() => {
        try { window.localStorage.setItem(THEME_KEY, theme); } catch {}
      }, [theme]);

      const t = useCallback((key) => (DICT[lang] && DICT[lang][key]) || DICT.zh[key] || key, [lang]);

      const sendFeedback = useCallback(async () => {
        const value = feedback.trim();
        if (!value) return;
        try {
          const res = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'ui-review', text: value }),
          });
          if (!res.ok) throw new Error(String(res.status));
          setFeedback('');
          setFeedbackMsg(t('feedback.ok'));
          setRev((x) => x + 1);
        } catch (e) { setFeedbackMsg(t('feedback.fail') + String((e && e.message) || e)); }
      }, [feedback, t]);

      useEffect(() => {
        try {
          if (!ctx || !ctx.locale || !ctx.locale.subscribe) return undefined;
          return ctx.locale.subscribe(() => setLang(pickLocale(ctx)));
        } catch { return undefined; }
      }, [ctx]);

      useEffect(() => {
        try {
          const d = [];
          d.push(ctx.locale.register(NS, 'zh-CN', DICT.zh));
          d.push(ctx.locale.register(NS, 'en-US', DICT.en));
          return () => d.forEach((x) => { try { x(); } catch {} });
        } catch { return undefined; }
      }, [ctx]);

      const load = useCallback(async () => {
        try {
          const res = await fetch(`${API}?limit=400`, { headers: { accept: 'application/json' } });
          if (!res.ok) throw new Error(String(res.status));
          const payload = await res.json();
          // client-error rows already live in the same journal; no second request per poll
          const errors = (payload.reports || []).filter((ev) => ev && ev.kind === 'client-error').slice(0, 50);
          setData({ ...payload, errors });
          setError('');
        } catch (e) { setError(String((e && e.message) || e)); }
      }, []);

      useEffect(() => { load(); }, [load, rev]);
      useEffect(() => {
        if (!auto) return undefined;
        const id = window.setInterval(() => { if (!document.hidden) load(); }, 10000);
        return () => window.clearInterval(id);
      }, [auto, load]);

      const reports = (data && data.reports ? data.reports : []).filter((ev) => {
        const k = iconKind(ev);
        if (filter === 'needs_fix' && !(ev.kind === 'verdict' && k === 'needs_fix')) return false;
        if (filter === 'complete' && !(ev.kind === 'verdict' && k === 'complete')) return false;
        if (filter !== 'all' && filter !== 'needs_fix' && filter !== 'complete' && ev.kind !== filter) return false;
        if (text && !JSON.stringify(ev).toLowerCase().includes(text.toLowerCase())) return false;
        return true;
      });

      const chip = (key) => h('button', {
        key, className: 'sus-chip', type: 'button',
        'data-on': filter === key ? '1' : '0', 'aria-pressed': filter === key ? 'true' : 'false',
        onClick: () => setFilter(key),
      }, t(key === 'all' ? 'filter.all' : `filter.${key}`));

      const d = selected ? selected.data || {} : {};
      const selTitle = selected ? `${selected.pairName || ''} · ${fmtTime(selected.at)}` : '';

      const themeBtn = (key) => h('button', {
        key, type: 'button', 'data-on': theme === key ? '1' : '0', onClick: () => setTheme(key),
      }, t(`theme.${key}`));

      return h('div', { className: 'sus-page', 'data-ios': theme === 'auto' ? undefined : theme },
        h('div', { className: 'sus-head' },
          h('div', null,
            h('h1', null, t('title')),
            h('p', null, t('subtitle')),
          ),
          h('div', { className: 'sus-seg', role: 'group', 'aria-label': 'appearance' },
            themeBtn('auto'), themeBtn('light'), themeBtn('dark'),
          ),
        ),
        h('div', { className: 'sus-bar' },
          chip('all'), chip('pair'), chip('review'), chip('needs_fix'), chip('complete'), chip('halted'), chip('handover'), chip('client-error'), chip('user-review'), chip('requirement'),
          h('input', {
            className: 'sus-input', type: 'search', 'aria-label': t('search'), placeholder: t('search'), value: text,
            onChange: (e) => setText(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Escape') setText(''); },
          }),
          h('button', { className: 'sus-chip', type: 'button', onClick: () => setAuto((x) => !x), 'data-on': auto ? '1' : '0', 'aria-pressed': auto ? 'true' : 'false' }, t('auto')),
          h('button', { className: 'sus-chip', type: 'button', onClick: () => setRev((x) => x + 1) }, t('refresh')),
        ),
        error ? h('div', { className: 'sus-badge', 'data-k': 'halted', role: 'alert' }, t('error'), error) : null,
        h('div', { className: 'sus-bar' },
          h('input', {
            className: 'sus-input', 'aria-label': t('feedback.placeholder'), placeholder: t('feedback.placeholder'), value: feedback,
            onChange: (e) => setFeedback(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') sendFeedback(); },
          }),
          h('button', { className: 'sus-chip', type: 'button', onClick: sendFeedback }, t('feedback.send')),
          feedbackMsg ? h('span', { className: 'sus-muted', role: 'status', 'aria-live': 'polite' }, feedbackMsg) : null,
        ),
        h('div', { className: 'sus-card', style: { marginBottom: 14 } },
          h('b', null, t('diag.title')),
          !data ? h('div', { className: 'sus-muted' }, t('loading')) : null,
          data && (!data.errors || data.errors.length === 0) ? h('div', { className: 'sus-muted' }, t('diag.empty')) : null,
          data && (data.errors || []).slice(0, 6).map((ev) => h('div', { className: 'sus-kv', key: ev.id },
            h('span', { className: 'sus-muted' }, fmtTime(ev.at)),
            h('span', { className: 'sus-err', style: { marginLeft: 8 } }, `${ev.pairId ? `[${ev.pairId}] ` : ''}${(ev.data && ev.data.message) || ''}`),
          )),
        ),
        h('h3', null, t('pairs'), data ? ` (${(data.pairs || []).length})` : ''),
        h('div', { className: 'sus-grid' },
          !data ? h('div', { className: 'sus-spin' }, t('loading')) : null,
          data && (data.pairs || []).length === 0 ? h('div', { className: 'sus-muted' }, t('pairs.empty')) : null,
          (data ? data.pairs || [] : []).map((p) => h('div', { className: 'sus-card', key: p.pairId },
            h('b', null, `${p.name || p.pairId}${p.auto ? ` · ${t('auto-tag')}` : ''}`),
            h('div', { className: 'sus-kv' }, h('span', null, t('state')), h('span', { className: `sus-badge`, 'data-k': p.state }, p.state)),
            h('div', { className: 'sus-kv' }, h('span', null, t('phase')), h('span', null, `${p.phase || ''}${p.reportPending === 'fix' ? ` · ${t('pending-report')}` : p.reportPending === 'done' ? ` · ${t('pending-done')}` : ''}`)),
            h('div', { className: 'sus-kv' }, h('span', null, t('worker')), h('span', null, p.workerRunning ? t('running') : t('idle'), ' ', kfmt(p.workerTokens))),
            h('div', { className: 'sus-kv' }, h('span', null, t('supervisor')), h('span', null, p.supervisorRunning ? t('running') : t('idle'), ' ', kfmt(p.supervisorTokens))),
            h('div', { className: 'sus-kv' }, h('span', null, t('rounds')), h('span', null, `${p.reviews}/${p.maxReviews} · ${t('fixes')} ${p.fixRounds}/${p.maxFixRounds} · ${t('handovers')} ${p.handovers}/${p.maxHandovers}`)),
            h('div', { className: 'sus-kv' }, h('span', null, t('pairing')), h('span', { className: (p.pairing && p.pairing.oneToOne === false) ? 'sus-err' : 'sus-ok' }, (p.pairing && p.pairing.oneToOne === false) ? `${t('pairing.conflict')}：${(p.pairing.conflicts || []).map((c) => c.kind).join('/')}` : t('pairing.ok'), (p.retiredSessions || []).length ? ` · ${t('retired')} ${p.retiredSessions.length}` : '')),
          )),
        ),
        h('h3', null, t('reports'), data ? ` (${reports.length}/${data.total})` : ''),
        h('div', { className: 'sus-cols' },
          h('div', { className: 'sus-list', role: 'listbox', 'aria-label': t('reports') },
            reports.length === 0 ? h('div', { className: 'sus-spin' }, data ? t('reports.empty') : t('loading')) : null,
            reports.map((ev) => h('div', {
              className: 'sus-item', key: ev.id, role: 'option', tabIndex: 0,
              'data-sel': selected && selected.id === ev.id ? '1' : '0',
              'aria-selected': selected && selected.id === ev.id ? 'true' : 'false',
              onClick: () => setSelected(ev),
              onKeyDown: (e) => {
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); setSelected(ev); return; }
                if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                const nodes = Array.prototype.slice.call(e.currentTarget.parentElement.querySelectorAll('.sus-item'));
                const target = nodes[nodes.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)];
                if (target) { e.preventDefault(); target.focus(); }
              },
            },
              h('span', { className: 't' }, fmtShort(ev.at)),
              h('span', { className: 'k' }, h('span', { className: 'sus-badge', 'data-k': iconKind(ev) }, ev.kind === 'verdict' ? ev.data && ev.data.verdict : ev.kind)),
              h('span', { className: 's' }, `${ev.pairName || ''} ${eventTitle(ev, t)}`),
            )),
          ),
          h('div', { className: 'sus-detail' },
            h('h3', null, t('detail.title')),
            !selected ? h('div', { className: 'sus-muted' }, t('detail.empty')) : h('div', null,
              h('div', { className: 'sus-muted', style: { marginBottom: 8 } }, selTitle),
              d.message ? h('div', null, h('h4', null, 'error'), h('pre', null, `${d.message}\n${d.stack || ''}`), d.pageUrl ? h('pre', null, d.pageUrl) : null) : null,
              d.text ? h('div', null, h('h4', null, t('summary')), h('pre', null, d.text)) : null,
              d.acceptance ? h('div', null, h('h4', null, t('requirement')), h('pre', null, (d.acceptance || []).join('\n') + (d.note ? `\n${d.note}` : ''))) : null,
              d.requirement ? h('div', null, h('h4', null, t('requirement')), h('pre', null, d.requirement)) : null,
              d.trigger ? h('div', null, h('h4', null, t('trigger')), h('pre', null, d.trigger)) : null,
              d.summary ? h('div', null, h('h4', null, t('summary')), h('pre', null, d.summary)) : null,
              d.checklist ? h('div', null, h('h4', null, t('checklist')), h('pre', null, d.checklist)) : null,
              d.fixInstructions ? h('div', null, h('h4', null, t('fix')), h('pre', null, d.fixInstructions)) : null,
              d.reason ? h('div', null, h('h4', null, t('reason')), h('pre', null, d.reason)) : null,
              d.previousId ? h('div', null, h('h4', null, t('prev')), h('pre', null, d.previousId), h('h4', null, t('new')), h('pre', null, d.newId)) : null,
              selected.kind === 'pair' && (d.workerId || d.supervisorId) ? h('div', null,
                h('h4', null, `${t('worker')} ${t('sid')}`), h('pre', null, d.workerId || ''),
                h('h4', null, `${t('supervisor')} ${t('sid')}`), h('pre', null, d.supervisorId || ''),
              ) : null,
              h('div', { className: 'sus-muted' }, `#${selected.id} · ${selected.pairId || ''} · ${fmtTime(selected.at)}`),
            ),
          ),
        ),
      );
    }

    // ---- browser-side error capture: page crashes become review-loop evidence ----
    let lastErrAt = 0; let lastErr = '';
    function uploadError(message, stack, extra) {
      try {
        const now = Date.now();
        if (message === lastErr && now - lastErrAt < 30000) return;
        lastErr = message; lastErrAt = now;
        const payload = JSON.stringify({
          type: 'ui-error', message: String(message || 'unknown').slice(0, 800),
          stack: String(stack || '').slice(0, 3000), pageUrl: String(location.href).slice(0, 300), extra: extra ? String(extra).slice(0, 300) : '',
        });
        if (navigator.sendBeacon) navigator.sendBeacon(API, new Blob([payload], { type: 'text/plain' }));
        else fetch(API, { method: 'POST', body: payload, keepalive: true }).catch(() => {});
      } catch {}
    }
    window.addEventListener('error', (e) => {
      const msg = (e && e.message) || '';
      if (msg.indexOf('/api/session-supervisor') >= 0) return; // don't loop on our own fetch failures
      uploadError(msg, e && e.error && e.error.stack);
    });
    window.addEventListener('unhandledrejection', (e) => {
      const r = e && e.reason;
      uploadError(`unhandled rejection: ${(r && r.message) || String(r)}`, r && r.stack);
    });

    // Error boundary: a render failure shows the message in-panel AND uploads it.
    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null }; }
      static getDerivedStateFromError(error) { return { error }; }
      componentDidCatch(error, info) { uploadError(`panel render: ${(error && error.message) || error}`, (error && error.stack) || '', info && info.componentStack); }
      render() {
        if (this.state.error) {
          return h('div', { className: 'sus-page', style: { padding: 24 } },
            h('div', { className: 'sus-err', style: { fontWeight: 600, marginBottom: 8 } },
              '面板渲染失败：', String((this.state.error && this.state.error.message) || this.state.error)),
            h('pre', { style: { whiteSpace: 'pre-wrap', color: 'var(--ios-t2)', fontFamily: 'ui-monospace,SFMono-Regular,Consolas,monospace', fontSize: 12 } },
              String((this.state.error && this.state.error.stack) || '')));
        }
        return this.props.children;
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        if (ctx.slots && ctx.slots.inject) {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist', id: PANEL_ID, order: 30,
            label: () => (DICT[pickLocale(ctx)] || DICT.en)['nav.label'],
          }, PanelIcon));
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main', key: PANEL_ID, order: 30,
          }, () => h(React.Fragment, null, h('style', null, CSS), h(Boundary, null, h(Page, { ctx })))));
        }
      },
    };
  },
});
