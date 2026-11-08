/**
 * 自省页。
 *
 * 数据全部来自 window.__nucleus.rpc('inspect.snapshot')，
 * 由本插件的主进程侧转发给核的 ctx.plugins.inspect()。
 * 页面本身不做任何推断 —— 它只把运行时如实摊开。
 */
const rpc = (method, payload) => window.__nucleus.rpc(method, payload);

const content = document.getElementById('content');
const stampEl = document.getElementById('stamp');
const profileEl = document.getElementById('profile');

let state = null;
let view = 'overview';
let timer = 0;
let failures = 0;

// ---------------------------------------------------------------- 工具

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'title') el.title = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number'
      ? document.createTextNode(String(c))
      : c);
  }
  return el;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function clock(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function ago(ts) {
  if (!ts) return '—';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec} 秒前`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟前`;
  return `${Math.round(sec / 3600)} 小时前`;
}

// ---------------------------------------------------------------- 概览

function viewOverview(d) {
  const plugins = d.plugins || [];
  const enabled = plugins.filter((p) => p.enabled).length;
  const effects = plugins.reduce((n, p) => n + (p.effects || 0), 0);
  const failed = plugins.filter((p) => p.status === 'error').length;
  const slots = d.slots || { slots: [], entries: 0, total: 0 };
  const rpcInfo = d.rpc || { coverage: 0, typed: 0, total: 0, channels: [] };
  const calls = (rpcInfo.channels || []).reduce((n, c) => n + c.calls, 0);
  const rpcFails = (rpcInfo.channels || []).reduce((n, c) => n + c.failed, 0);

  const kpi = (label, value, sub, tone) => h('div', { class: `kpi ${tone || ''}` },
    h('div', { class: 'k-label' }, label),
    h('div', { class: 'k-value' }, value),
    sub ? h('div', { class: 'k-sub' }, sub) : null
  );

  return [
    h('h2', {}, '概览'),
    h('div', { class: 'kpis' },
      kpi('启用插件', `${enabled}/${plugins.length}`, failed ? `${failed} 个异常` : '全部正常', failed ? 'red' : 'green'),
      kpi('Cordis 副作用', effects, '当前登记在案的可逆副作用', 'accent'),
      kpi('槽位', `${slots.total}`, `${slots.entries} 个注册条目`, ''),
      kpi('RPC 契约覆盖', `${rpcInfo.coverage}%`, `${rpcInfo.typed}/${rpcInfo.total} 条通道已声明`, rpcInfo.coverage >= 70 ? 'green' : 'amber'),
      kpi('RPC 调用', calls, rpcFails ? `${rpcFails} 次失败` : '无失败', rpcFails ? 'red' : ''),
      kpi('内存 · 运行时长', `${d.app.memoryMB.rss} MB`, `${Math.floor(d.app.uptimeSec / 60)} 分 ${d.app.uptimeSec % 60} 秒`, '')
    ),

    h('h3', {}, '配置层叠'),
    h('div', { class: 'layers' }, ...(d.config?.layers || []).map((l) => h('div', { class: `layer ${l.exists ? '' : 'missing'}` },
      h('div', { class: 'l-name' }, l.name),
      h('div', { class: 'l-path', title: l.path }, l.path),
      h('div', { class: 'l-count' }, l.exists ? `${l.plugins} 插件项 · ${l.settings} 设置项` : '未创建'),
      h('span', { class: `tag ${l.exists ? 'typed' : 'untyped'}` }, l.exists ? '生效' : '跳过')
    ))),
    h('div', { class: 'faint', style: 'margin-top:8px;font-size:11.5px' },
      `当前 profile：${d.config?.profile || d.profile || '—'} · 启用名单 ${d.config?.plugins?.enable?.length || 0} 项 · 禁用名单 ${d.config?.plugins?.disable?.length || 0} 项`),

    h('h3', {}, '运行环境'),
    h('table', {},
      h('tbody', {},
        row('Chromium', d.app.chrome),
        row('Electron', d.app.electron),
        row('Node（主进程）', d.app.node),
        row('Cordis', d.app.cordis),
        row('平台', `${d.app.platform} ${d.app.arch}`),
        row('用户数据', d.app.userData || '—', true)
      )
    )
  ];
}

function row(k, v, mono) {
  return h('tr', {},
    h('td', { style: 'width:160px;color:var(--text-dim)' }, k),
    h('td', { class: mono ? 'mono' : '' }, v)
  );
}

// ---------------------------------------------------------------- 插件

function viewPlugins(d) {
  const plugins = (d.plugins || []).slice().sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  return [
    h('h2', {}, `插件与 fiber（${plugins.length}）`),
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '状态'),
        h('th', {}, '插件'),
        h('th', {}, '版本'),
        h('th', { class: 'num' }, '副作用'),
        h('th', {}, '权限'),
        h('th', {}, '槽位'),
        h('th', { class: 'num' }, '命令')
      )),
      h('tbody', {}, ...plugins.map((p) => h('tr', {},
        h('td', {},
          h('span', { class: `dot ${p.status === 'error' ? 'err' : p.enabled ? 'ok' : 'off'}` }),
          h('span', { class: 'dim' }, p.status === 'error' ? '异常' : p.enabled ? '启用' : '停用')
        ),
        h('td', {},
          h('div', {}, h('b', {}, p.name)),
          h('div', { class: 'mono faint' }, p.id + (p.builtin ? ' · 内置' : ' · 用户')),
          p.error ? h('div', { style: 'color:var(--red);font-size:11px' }, p.error) : null
        ),
        h('td', { class: 'mono dim' }, p.version || '—'),
        h('td', { class: 'num' }, String(p.effects || 0)),
        h('td', {}, ...(p.permissions.length
          ? p.permissions.map((x) => h('span', { class: 'tag perm' }, x))
          : [h('span', { class: 'faint' }, '—')])),
        h('td', {}, ...(p.slots.length
          ? p.slots.map((x) => h('span', { class: 'tag slot' }, x))
          : [h('span', { class: 'faint' }, '—')])),
        h('td', { class: 'num' }, String(p.commands || 0))
      )))
    ),
    h('div', { class: 'faint', style: 'margin-top:10px;font-size:11.5px' },
      '「副作用」是 Cordis fiber 当前登记的可逆副作用条数。禁用插件后应当归零；再启用后条数不应翻倍。'),

    h('h3', {}, `服务（${(d.services || []).length}）`),
    h('div', {}, ...(d.services || []).map((s) => h('span', { class: 'tag' }, s.name)))
  ];
}

// ---------------------------------------------------------------- 槽位

function viewSlots(d) {
  const snap = d.slots || { slots: [], rejections: [] };
  const nodes = snap.slots || [];
  const out = [h('h2', {}, `槽位树（${snap.total} 个空位 · ${snap.entries} 个条目）`)];

  if (snap.rejections && snap.rejections.length) {
    out.push(h('div', { class: 'rejections' },
      h('b', {}, `有 ${snap.rejections.length} 次注册被拒绝`),
      h('ul', {}, ...snap.rejections.slice(0, 8).map((r) => h('li', {},
        `${r.pluginId} → ${r.name}：${r.reason}`)))
    ));
  }

  out.push(h('div', { class: 'faint', style: 'margin-bottom:12px;font-size:11.5px' },
    '空位由拥有渲染位置的插件声明，子空位可以嵌套。注册者必须在 manifest 的 contributes.slots 里声明过，或获得 owner 的策略放行。'));

  for (const node of nodes) {
    const indent = node.depth * 18;
    out.push(h('div', {
      class: `slot-row ${node.name === 'root' ? 'root' : ''}`,
      style: `margin-left:${indent}px`,
    },
      h('span', { class: 'slot-name' }, node.name),
      h('span', { class: 'tag' }, node.cardinality),
      h('span', { class: 'tag' }, node.scope),
      h('span', { class: 'slot-owner' }, `owner: ${node.owner}`),
      node.restricted ? h('span', { class: 'tag untyped' }, '受限') : null,
      h('span', { class: 'faint', style: 'font-size:10.5px;margin-left:auto' },
        `${node.entries.length} 条目 · ${node.outlets} 容器`)
    ));

    if (node.entries.length) {
      out.push(h('div', { class: 'slot-entries', style: `margin-left:${indent + 26}px` },
        ...node.entries.map((e) => h('div', { class: `entry ${e.active ? '' : 'inactive'}` },
          h('span', { class: 'e-id' }, e.id),
          h('span', { class: 'e-from' }, e.pluginId),
          h('span', { class: 'e-flag' }, node.cardinality === 'list' ? `order ${e.order}` : `priority ${e.priority}`),
          e.key ? h('span', { class: 'e-flag' }, `key=${e.key}`) : null,
          e.hasWhen ? h('span', { class: 'tag' }, 'when') : null,
          e.hasSelect ? h('span', { class: 'tag' }, 'select') : null,
          e.active ? h('span', { class: 'tag typed' }, '渲染中') : h('span', { class: 'tag' }, '条件未满足')
        ))
      ));
    }
  }

  out.push(h('div', { class: 'faint', style: 'margin-top:16px;font-size:11.5px' },
    '槽位树由渲染层每 400ms 节流上报一次。这里显示的是最近一次快照。'));
  return out;
}

// ---------------------------------------------------------------- RPC

function viewRpc(d) {
  const info = d.rpc || { channels: [], coverage: 0, typed: 0, total: 0 };
  const channels = (info.channels || []).slice().sort((a, b) => b.calls - a.calls || a.channel.localeCompare(b.channel));

  return [
    h('h2', {}, 'RPC 契约'),
    h('div', { class: 'coverage' },
      h('div', { class: 'bar' }, h('i', { style: `width:${info.coverage}%` })),
      h('div', { class: 'dim', style: 'font-size:11.5px;white-space:nowrap' },
        `${info.typed} / ${info.total} 条已声明（${info.coverage}%）`)
    ),
    h('div', { class: 'faint', style: 'margin-bottom:12px;font-size:11.5px' },
      '已声明的通道在进入处理器前校验参数、返回前校验结果；未声明的照常工作，但故障只能靠日志发现。'),
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '通道'),
        h('th', {}, '契约'),
        h('th', { class: 'num' }, '调用'),
        h('th', { class: 'num' }, '失败'),
        h('th', { class: 'num' }, '平均'),
        h('th', {}, '参数')
      )),
      h('tbody', {}, ...channels.map((c) => h('tr', {},
        h('td', { class: 'mono' }, c.channel),
        h('td', {}, h('span', { class: `tag ${c.typed ? 'typed' : 'untyped'}` }, c.typed ? 'typed' : 'untyped')),
        h('td', { class: 'num' }, String(c.calls)),
        h('td', { class: 'num', style: c.failed ? 'color:var(--red)' : '' }, String(c.failed)),
        h('td', { class: 'num' }, c.avgMs ? `${c.avgMs}ms` : '—'),
        h('td', {}, h('div', { class: 'sig', title: c.params || '' }, c.params || '—'),
          c.lastError ? h('div', { style: 'color:var(--red);font-size:10.5px;margin-top:2px' },
            `${ago(c.lastError.at)} · ${c.lastError.message}`) : null
        )
      )))
    )
  ];
}

// ---------------------------------------------------------------- 事件

function viewEvents(d) {
  const ev = d.events || { recent: [], stats: [] };
  return [
    h('h2', {}, '事件流'),
    h('div', { class: 'faint', style: 'margin-bottom:12px;font-size:11.5px' },
      '只记录事件名与来源，不记录负载 —— 负载可能很大，也可能含隐私内容。'),
    h('div', { style: 'margin-bottom:18px' },
      ...(ev.stats || []).slice(0, 14).map((s) => h('span', { class: 'tag' }, `${s.event} ×${s.count}`))
    ),
    ev.recent && ev.recent.length
      ? h('div', {}, ...ev.recent.map((e) => h('div', { class: 'event' },
        h('span', { class: 'e-time' }, clock(e.at)),
        h('span', { class: 'e-name' }, e.event),
        e.owner ? h('span', { class: 'e-owner' }, '← ' + e.owner) : null
      )))
      : h('div', { class: 'empty' }, '暂无事件')
  ];
}

// ---------------------------------------------------------------- 内核健康

let health = null;
let repairing = false;

const LEVEL_TEXT = { ok: '正常', warn: '注意', error: '异常' };

function viewHealth() {
  if (!health) {
    return [h('div', { class: 'empty' }, '正在读取健康检查结果…')];
  }
  if (health.error) {
    return [h('div', { class: 'empty' }, h('div', { style: 'color:var(--red)' }, '健康检查失败'), h('div', { class: 'mono' }, health.error))];
  }

  const s = health.summary || {};
  const verdict = s.errors ? '发现问题' : (s.warns ? '基本正常' : '全部正常');
  const tone = s.errors ? 'var(--red)' : (s.warns ? 'var(--amber)' : 'var(--green)');

  const head = h('div', { class: 'health-head' },
    h('div', { style: `font-size:20px;font-weight:600;color:${tone}` }, verdict),
    h('div', { class: 'health-sub' },
      `${s.checks || 0} 项检查 · ${s.errors || 0} 项异常 · ${s.warns || 0} 项注意 · `
      + `${s.active || 0}/${s.plugins || 0} 个插件已激活 · ${s.effects || 0} 条副作用在账`)
  );

  const cards = (health.checks || []).map((c) => {
    const color = c.level === 'error' ? 'var(--red)' : c.level === 'warn' ? 'var(--amber)' : 'var(--green)';
    return h('div', { class: 'health-card' },
      h('div', { class: 'health-card-head' },
        h('span', { class: 'health-dot', style: `background:${color}` }),
        h('span', { class: 'health-title' }, c.title),
        h('span', { class: 'health-badge', style: `color:${color};border-color:${color}` }, LEVEL_TEXT[c.level] || c.level),
        h('span', { class: 'health-detail' }, c.detail)
      ),
      c.items && c.items.length
        ? h('div', { class: 'health-items' }, ...c.items.map((it) => h('div', { class: 'health-item' },
          h('span', { class: 'health-plugin mono' }, it.plugin),
          h('span', {}, it.text))))
        : null
    );
  });

  const btn = h('button', {
    class: 'btn',
    disabled: repairing || !(s.errors || s.warns),
    onclick: async () => {
      repairing = true;
      render();
      try {
        const res = await rpc('inspect.repair');
        const okCount = (res.actions || []).filter((a) => a.ok).length;
        health = await rpc('inspect.health');
        health.notice = `修复完成：${okCount}/${(res.actions || []).length} 项成功`;
      } catch (err) {
        health.notice = `修复失败：${err.message}`;
      } finally {
        repairing = false;
        render();
      }
    },
  }, repairing ? '正在回收…' : '回收泄漏 / 清理孤儿槽位');

  const note = health.notice ? h('div', { class: 'health-note' }, health.notice) : null;

  return [head, h('div', { class: 'health-actions' }, btn, note), ...cards];
}

async function loadHealth() {
  try {
    health = await rpc('inspect.health');
  } catch (err) {
    health = { error: String(err && err.message ? err.message : err) };
  }
}

// ---------------------------------------------------------------- 渲染

function render() {
  if (!state) return;
  const scroll = content.scrollTop;
  const map = {
    overview: viewOverview,
    plugins: viewPlugins,
    slots: viewSlots,
    rpc: viewRpc,
    events: viewEvents,
    health: viewHealth,
  };
  const fn = map[view] || viewOverview;
  content.replaceChildren(...fn(state).flat().filter(Boolean));
  content.scrollTop = scroll;
}

async function load() {
  try {
    const data = await rpc('inspect.snapshot');
    state = data;
    failures = 0;
    profileEl.textContent = data.config?.profile ? `profile: ${data.config.profile}` : '';
    stampEl.textContent = `更新于 ${clock(Date.now())}`;
    render();
  } catch (err) {
    failures += 1;
    stampEl.textContent = `读取失败（${failures}）`;
    if (failures === 1) {
      content.replaceChildren(h('div', { class: 'empty' },
        h('div', { style: 'color:var(--red);margin-bottom:8px' }, '无法读取运行时快照'),
        h('div', { class: 'mono' }, String(err && err.message ? err.message : err))));
    }
  }
}

document.getElementById('nav').addEventListener('click', async (e) => {
  const btn = e.target.closest('.nav-item');
  if (!btn) return;
  view = btn.dataset.view;
  for (const el of document.querySelectorAll('.nav-item')) {
    el.classList.toggle('active', el === btn);
  }
  content.scrollTop = 0;
  // 健康数据不参与 2 秒轮询（要读进程句柄），切过来时现取一次
  if (view === 'health') {
    health = null;
    render();
    await loadHealth();
  }
  render();
});

document.getElementById('refresh').addEventListener('click', load);

// 页面不可见时暂停轮询，避免在后台白烧 CPU
function tick() {
  clearTimeout(timer);
  if (!document.hidden) load();
  timer = setTimeout(tick, 2000);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load();
});

load();
timer = setTimeout(tick, 2000);
