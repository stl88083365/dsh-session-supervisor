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

    /* ---------------------------------------------------------------- locale */
    const DICT = {
      zh: {
        'nav.label': '会话监督',
        'title': '会话监督面板',
        'subtitle': '执行会话完成后串行送审；监督结论与整改指令的记录都在这里。',
        'pairs': '监督对',
        'pairs.empty': '暂无监督对（在任意会话里调用 supervision_start 创建）。',
        'reports': '审查报告',
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
        'detail.title': '详情',
        'detail.empty': '点击左边的报告条目查看全文。',
        'worker': '执行',
        'supervisor': '监督',
        'running': '运行中',
        'idle': '空闲',
        'state': '状态',
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
      },
      en: {
        'nav.label': 'Supervision',
        'title': 'Session supervision',
        'subtitle': 'Serial reviews after the executor reports done; verdicts and fix instructions live here.',
        'pairs': 'Pairs',
        'pairs.empty': 'No pairs yet (call supervision_start in any session).',
        'reports': 'Review reports',
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
        'detail.title': 'Detail',
        'detail.empty': 'Pick a report to read it.',
        'worker': 'Executor',
        'supervisor': 'Supervisor',
        'running': 'running',
        'idle': 'idle',
        'state': 'State',
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
      },
    };
    function pickLocale(ctx) {
      try {
        const snap = ctx.locale && ctx.locale.getLocale && ctx.locale.getLocale();
        const id = String((snap && (snap.active || snap.id)) || 'en').toLowerCase();
        return id.indexOf('zh') === 0 ? 'zh' : 'en';
      } catch { return 'en'; }
    }

    /* ----------------------------------------------------------------- styles */
    const CSS = `
      .sus-page { padding: 20px 24px 40px; height: 100%; overflow: auto; color: var(--dsw-alias-text, #ddd); background: var(--dsw-alias-bg, transparent); font-size: 13px; }
      .sus-head h1 { font-size: 18px; margin: 0 0 4px; }
      .sus-head p { margin: 0 0 14px; opacity: .65; }
      .sus-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; }
      .sus-chip { border: 1px solid var(--dsw-alias-border, #444); border-radius: 999px; padding: 3px 11px; cursor: pointer; background: transparent; color: inherit; font: inherit; }
      .sus-chip[data-on="1"] { background: var(--dsw-alias-accent, #2563eb); border-color: transparent; color: #fff; }
      .sus-input { flex: 1 1 180px; min-width: 150px; background: var(--dsw-alias-input, rgba(255,255,255,.05)); color: inherit; border: 1px solid var(--dsw-alias-border, #444); border-radius: 8px; padding: 5px 10px; font: inherit; }
      .sus-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; margin-bottom: 18px; }
      .sus-card { border: 1px solid var(--dsw-alias-border, #3a3a3a); border-radius: 10px; padding: 10px 12px; background: var(--dsw-alias-card, rgba(255,255,255,.03)); }
      .sus-card b { display: block; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sus-kv { display: flex; justify-content: space-between; gap: 8px; opacity: .8; line-height: 1.7; }
      .sus-badge { border-radius: 6px; padding: 0 7px; font-size: 12px; }
      .sus-badge[data-k="active"], .sus-badge[data-k="complete"] { background: #14532d; color: #b9f6ca; }
      .sus-badge[data-k="halted"], .sus-badge[data-k="stopped"] { background: #7f1d1d; color: #fecaca; }
      .sus-badge[data-k="reviewing"] { background: #78350f; color: #fde68a; }
      .sus-cols { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 14px; align-items: start; }
      @media (max-width: 900px) { .sus-cols { grid-template-columns: 1fr; } }
      .sus-list { border: 1px solid var(--dsw-alias-border, #3a3a3a); border-radius: 10px; max-height: 62vh; overflow: auto; }
      .sus-item { display: flex; gap: 8px; align-items: baseline; padding: 8px 12px; border-bottom: 1px solid var(--dsw-alias-border, #333); cursor: pointer; }
      .sus-item:last-child { border-bottom: 0; }
      .sus-item:hover, .sus-item[data-sel="1"] { background: var(--dsw-alias-hover, rgba(255,255,255,.06)); }
      .sus-item .t { flex: 0 0 auto; opacity: .55; font-size: 12px; }
      .sus-item .k { flex: 0 0 auto; font-size: 12px; }
      .sus-item .s { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sus-detail { border: 1px solid var(--dsw-alias-border, #3a3a3a); border-radius: 10px; padding: 12px 14px; max-height: 62vh; overflow: auto; background: var(--dsw-alias-card, rgba(255,255,255,.03)); }
      .sus-detail pre { white-space: pre-wrap; word-break: break-word; margin: 4px 0 12px; font-family: inherit; line-height: 1.6; }
      .sus-detail h4 { margin: 0 0 2px; font-size: 12px; opacity: .6; font-weight: 600; }
      .sus-muted { opacity: .55; }
      .sus-spin { opacity: .6; padding: 12px; }
    `;

    const KIND_LABEL = { pair: 'filter.pair', review: 'filter.review', verdict: '', handover: 'filter.handover', halted: 'filter.halted', stopped: 'filter.halted' };

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

      const t = useCallback((key) => (DICT[lang] && DICT[lang][key]) || DICT.zh[key] || key, [lang]);

      useEffect(() => {
        if (!ctx || !ctx.locale || !ctx.locale.subscribe) return;
        return ctx.locale.subscribe(() => setLang(pickLocale(ctx)));
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
          setData(await res.json());
          setError('');
        } catch (e) { setError(String((e && e.message) || e)); }
      }, []);

      useEffect(() => { load(); }, [load, rev]);
      useEffect(() => {
        if (!auto) return undefined;
        const id = window.setInterval(load, 10000);
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
        key, className: 'sus-chip', 'data-on': filter === key ? '1' : '0', onClick: () => setFilter(key),
      }, t(key === 'all' ? 'filter.all' : `filter.${key}`));

      const d = selected ? selected.data || {} : {};
      const selTitle = selected ? `${selected.pairName || ''} · ${fmtTime(selected.at)}` : '';

      return h('div', { className: 'sus-page' },
        h('div', { className: 'sus-head' },
          h('h1', null, t('title')),
          h('p', null, t('subtitle')),
        ),
        h('div', { className: 'sus-bar' },
          chip('all'), chip('pair'), chip('review'), chip('needs_fix'), chip('complete'), chip('halted'), chip('handover'),
          h('input', { className: 'sus-input', placeholder: t('search'), value: text, onChange: (e) => setText(e.target.value) }),
          h('button', { className: 'sus-chip', onClick: () => setAuto((x) => !x), 'data-on': auto ? '1' : '0' }, t('auto')),
          h('button', { className: 'sus-chip', onClick: () => setRev((x) => x + 1) }, t('refresh')),
        ),
        error ? h('div', { className: 'sus-badge', 'data-k': 'halted' }, t('error'), error) : null,
        h('h3', { style: { margin: '4px 0 8px', fontSize: 14 } }, t('pairs'), data ? ` (${(data.pairs || []).length})` : ''),
        h('div', { className: 'sus-grid' },
          !data ? h('div', { className: 'sus-spin' }, t('loading')) : null,
          data && (data.pairs || []).length === 0 ? h('div', { className: 'sus-muted' }, t('pairs.empty')) : null,
          (data ? data.pairs || [] : []).map((p) => h('div', { className: 'sus-card', key: p.pairId },
            h('b', null, p.name || p.pairId),
            h('div', { className: 'sus-kv' }, h('span', null, t('state')), h('span', { className: `sus-badge`, 'data-k': p.state }, p.state)),
            h('div', { className: 'sus-kv' }, h('span', null, t('worker')), h('span', null, p.workerRunning ? t('running') : t('idle'), ' ', kfmt(p.workerTokens))),
            h('div', { className: 'sus-kv' }, h('span', null, t('supervisor')), h('span', null, p.supervisorRunning ? t('running') : t('idle'), ' ', kfmt(p.supervisorTokens))),
            h('div', { className: 'sus-kv' }, h('span', null, t('rounds')), h('span', null, `${p.reviews}/${p.maxReviews} · ${t('fixes')} ${p.fixRounds}/${p.maxFixRounds} · ${t('handovers')} ${p.handovers}/${p.maxHandovers}`)),
          )),
        ),
        h('h3', { style: { margin: '4px 0 8px', fontSize: 14 } }, t('reports'), data ? ` (${reports.length}/${data.total})` : ''),
        h('div', { className: 'sus-cols' },
          h('div', { className: 'sus-list' },
            reports.length === 0 ? h('div', { className: 'sus-spin' }, t('loading')) : null,
            reports.map((ev) => h('div', {
              className: 'sus-item', key: ev.id, 'data-sel': selected && selected.id === ev.id ? '1' : '0',
              onClick: () => setSelected(ev),
            },
              h('span', { className: 't' }, fmtShort(ev.at)),
              h('span', { className: 'k' }, h('span', { className: 'sus-badge', 'data-k': iconKind(ev) }, ev.kind === 'verdict' ? ev.data && ev.data.verdict : ev.kind)),
              h('span', { className: 's' }, `${ev.pairName || ''} ${eventTitle(ev, t)}`),
            )),
          ),
          h('div', { className: 'sus-detail' },
            h('h3', { style: { margin: '0 0 8px', fontSize: 14 } }, t('detail.title')),
            !selected ? h('div', { className: 'sus-muted' }, t('detail.empty')) : h('div', null,
              h('div', { className: 'sus-muted', style: { marginBottom: 8 } }, selTitle),
              d.requirement ? h('div', null, h('h4', null, t('requirement')), h('pre', null, d.requirement)) : null,
              d.trigger ? h('div', null, h('h4', null, t('trigger')), h('pre', null, d.trigger)) : null,
              d.summary ? h('div', null, h('h4', null, t('summary')), h('pre', null, d.summary)) : null,
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

    return {
      inject: ['slots'],
      apply(ctx) {
        if (ctx.slots && ctx.slots.inject) {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist', id: PANEL_ID, order: 30,
            label: () => (DICT[pickLocale(ctx)] || DICT.en)['nav.label'],
          }, PanelIcon));
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main', key: PANEL_ID, order: 30,
          }, (props) => h(React.Fragment, null, h('style', null, CSS), h(Page, { ctx }))));
        }
      },
    };
  },
});
