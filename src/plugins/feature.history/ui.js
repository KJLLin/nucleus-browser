/**
 * feature.history —— 浏览历史。
 *
 * 订阅标签页的 URL 变化来记录；同时通过 `history.suggest` 命令向地址栏
 * 提供补全数据 —— 这是插件之间唯一的协作方式：命令，而不是共享内存。
 */
import { icon } from 'nucleus://core/lib/icons.js';
import { h, hostOf, timeAgo } from 'nucleus://core/lib/dom.js';

const MAX_TITLE = 160;

export async function activate(nucleus) {
  await nucleus.storage.load();

  let entries = nucleus.storage.get('entries', []);
  if (!Array.isArray(entries)) entries = [];

  const lastSeen = new Map(); // tabId -> url
  let flushTimer = null;

  const persist = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const max = nucleus.settings.get('maxEntries', 2000);
      entries.sort((a, b) => b.lastVisit - a.lastVisit);
      if (entries.length > max) entries.length = max;
      nucleus.storage.set('entries', entries.slice());
    }, 1500);
  };

  function shouldRecord(url) {
    if (!url) return false;
    if (!nucleus.settings.get('enabled', true)) return false;
    if (url === nucleus.env.newTabUrl) return false; // 空白新标签页不值得记
    if (nucleus.settings.get('excludeInternal', true) && url.startsWith('nucleus://')) return false;
    return /^(https?|file):/i.test(url);
  }

  function record(tab) {
    if (!tab || !shouldRecord(tab.url)) return;
    if (lastSeen.get(tab.id) === tab.url) return;
    lastSeen.set(tab.id, tab.url);

    const title = (tab.title || hostOf(tab.url) || tab.url).slice(0, MAX_TITLE);
    const idx = entries.findIndex((x) => x.url === tab.url);
    if (idx >= 0) {
      entries[idx].lastVisit = Date.now();
      entries[idx].visits = (entries[idx].visits || 1) + 1;
      if (title && title !== '新标签页') entries[idx].title = title;
    } else {
      entries.push({ url: tab.url, title, lastVisit: Date.now(), visits: 1 });
    }
    persist();
  }

  nucleus.tabs.on('updated', (tab) => {
    if (tab && tab.url) record(tab);
  });

  nucleus.tabs.on('removed', ({ id }) => lastSeen.delete(id));

  // ---------- 补全 ----------

  nucleus.commands.register('history.suggest', {
    title: '历史补全',
    hidden: true,
    handler: (query, limit = 6) => {
      const q = String(query || '').trim().toLowerCase();
      if (!q) return [];
      return entries
        .filter((x) => x.url.toLowerCase().includes(q) || (x.title || '').toLowerCase().includes(q))
        .sort((a, b) => b.lastVisit - a.lastVisit)
        .slice(0, limit)
        .map((x) => ({ url: x.url, title: x.title }));
    },
  });

  // ---------- 面板 ----------

  function buildPanel() {
    let query = '';
    const body = h('div', { class: 'panel-body' });

    const search = h('input', {
      class: 'input',
      placeholder: '搜索历史记录…',
      style: { height: '28px', margin: '8px 10px' },
    });
    search.addEventListener('input', () => {
      query = search.value.trim().toLowerCase();
      paint();
    });

    const panel = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('span', { class: 'grow' }, '历史记录'),
        h('button', {
          class: 'icon-btn',
          title: '清空历史',
          html: icon('trash', { size: 14 }),
          onclick: async () => {
            const ok = await nucleus.ui.confirm('清空历史记录', '所有浏览历史将被删除，且不可恢复。', { danger: true });
            if (!ok) return;
            entries = [];
            nucleus.storage.set('entries', []);
            paint();
            nucleus.ui.toast('历史记录已清空');
          },
        }),
        h('button', {
          class: 'icon-btn',
          title: '关闭',
          html: icon('x', { size: 14 }),
          onclick: () => nucleus.sidebar.hide(),
        })
      ),
      search,
      body
    );

    function paint() {
      body.innerHTML = '';
      const list = entries
        .filter((x) => !query || x.url.toLowerCase().includes(query) || (x.title || '').toLowerCase().includes(query))
        .sort((a, b) => b.lastVisit - a.lastVisit)
        .slice(0, 400);

      if (!list.length) {
        body.appendChild(h('div', { class: 'empty' },
          h('span', { html: icon('clock', { size: 26 }) }),
          h('div', {}, entries.length ? '没有匹配的历史记录' : '还没有浏览记录')
        ));
        return;
      }

      // 按「今天 / 昨天 / 更早」分组
      const groups = new Map();
      for (const item of list) {
        const day = new Date(item.lastVisit).toDateString();
        if (!groups.has(day)) groups.set(day, []);
        groups.get(day).push(item);
      }

      const today = new Date().toDateString();
      const yesterday = new Date(Date.now() - 86400_000).toDateString();

      for (const [day, groupItems] of groups) {
        const label = day === today ? '今天' : day === yesterday ? '昨天' : new Date(day).toLocaleDateString('zh-CN');
        body.appendChild(h('div', {
          style: { padding: '8px 12px 4px', fontSize: '10.5px', color: 'var(--text-faint)', letterSpacing: '0.5px' },
        }, label));

        for (const item of groupItems) {
          const row = h('div', { class: 'list-item' },
            h('span', { style: { color: 'var(--text-faint)', display: 'flex' }, html: icon('globe', { size: 13 }) }),
            h('div', { class: 'grow' },
              h('div', { class: 'ellipsis' }, item.title || hostOf(item.url)),
              h('div', { class: 'sub ellipsis' }, `${hostOf(item.url)} · ${timeAgo(item.lastVisit)}`)
            )
          );
          row.addEventListener('click', () => {
            const tab = nucleus.tabs.active();
            if (tab) nucleus.tabs.navigate(tab.id, item.url);
            else nucleus.tabs.create({ url: item.url });
          });
          row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            nucleus.ui.menu([
              { label: '在新标签页打开', icon: 'external-link', onClick: () => nucleus.tabs.create({ url: item.url }) },
              { label: '复制链接', icon: 'copy', onClick: () => navigator.clipboard?.writeText(item.url) },
              { separator: true },
              { label: '从历史中删除', icon: 'trash', danger: true, onClick: () => {
                entries = entries.filter((x) => x.url !== item.url);
                nucleus.storage.set('entries', entries.slice());
                paint();
              } },
            ], { x: e.clientX, y: e.clientY });
          });
          body.appendChild(row);
        }
      }
    }

    paint();
    return panel;
  }

  nucleus.commands.register('history.panel', {
    title: '打开历史记录',
    icon: 'clock',
    keybinding: 'Ctrl+H',
    handler: () => nucleus.sidebar.toggle('feature.history', buildPanel, { side: 'left', width: 320 }),
  });

  nucleus.commands.register('history.clear', {
    title: '清空历史记录',
    icon: 'trash',
    handler: () => {
      entries = [];
      nucleus.storage.set('entries', []);
      nucleus.ui.toast('历史记录已清空');
    },
  });
}
