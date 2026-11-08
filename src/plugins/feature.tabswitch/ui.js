/**
 * feature.tabswitch —— 标签切换器。
 *
 * 目标不是「再做一个标签条」，而是解决标签条解决不了的问题：
 * 开了 20 个标签之后，用眼睛在 20 个 12px 的字里找一个标题，比打字慢得多。
 *
 * 排序用 MRU（最近使用优先），因为切换标签时用户想去的通常是「刚才那个」。
 * 数据全部来自 nucleus.tabs 的公开 API，没有任何特权通道。
 */
import { icon } from 'nucleus://core/lib/icons.js';
import { h } from 'nucleus://core/lib/dom.js';

export async function activate(nucleus) {
  /** 最近使用顺序（tabId 数组，最前 = 最近） */
  let mru = [];
  let overlay = null;
  let inputEl = null;
  let listEl = null;
  let rows = [];
  let index = 0;
  let closing = false;

  const touch = (id) => {
    if (!id) return;
    mru = [id, ...mru.filter((x) => x !== id)];
  };

  const active = nucleus.tabs.active();
  if (active) touch(active.id);

  for (const evt of ['activated', 'created']) {
    nucleus.tabs.on(evt, (tab) => { if (tab && tab.id) touch(tab.id); });
  }
  // 'removing' 带的是完整对象，比 'removed' 更适合维护索引
  nucleus.tabs.on('removing', (tab) => {
    if (tab && tab.id) mru = mru.filter((x) => x !== tab.id);
  });

  function ordered() {
    const list = nucleus.tabs.list();
    const byId = new Map(list.map((t) => [t.id, t]));
    const out = [];
    for (const id of mru) {
      const t = byId.get(id);
      if (t) { out.push(t); byId.delete(id); }
    }
    for (const t of byId.values()) out.push(t);
    return out;
  }

  /**
   * 子序列打分：输入 "ghb" 也能命中 "GitHub"。
   * 连续命中的权重更高，所以 "git" 会排在 "Great Italian Tools" 前面。
   */
  function score(text, query) {
    const s = String(text || '').toLowerCase();
    const q = String(query || '').toLowerCase();
    if (!q) return 1;
    let i = 0;
    let sc = 0;
    let streak = 0;
    for (let k = 0; k < s.length && i < q.length; k += 1) {
      if (s[k] === q[i]) {
        i += 1;
        streak += 1;
        sc += 2 + streak;
      } else {
        streak = 0;
      }
    }
    return i === q.length ? sc : 0;
  }

  function hostOf(url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '');
    } catch (_) {
      if (String(url).startsWith('nucleus://')) return '浏览器内部页面';
      return '';
    }
  }

  function paintFavicon(el, tab) {
    el.innerHTML = '';
    if (tab.favicon) {
      const img = document.createElement('img');
      img.src = tab.favicon;
      img.alt = '';
      img.addEventListener('error', () => {
        el.innerHTML = icon(tab.internal ? 'layers' : 'globe', { size: 15 });
      }, { once: true });
      el.appendChild(img);
      return;
    }
    el.innerHTML = icon(tab.internal ? 'layers' : 'globe', { size: 15 });
  }

  function filtered() {
    const all = ordered();
    const q = inputEl.value.trim();
    if (!q) return all;
    return all
      .map((t) => {
        const title = score(t.title, q) * 2;
        const url = score(t.url, q);
        return { t, s: Math.max(title, url) };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.t);
  }

  function paint() {
    rows = filtered();
    if (index >= rows.length) index = Math.max(0, rows.length - 1);
    if (index < 0) index = 0;

    if (!rows.length) {
      listEl.replaceChildren(h('div', { class: 'ts-empty' }, '没有匹配的标签页'));
      return;
    }

    listEl.replaceChildren(...rows.map((tab, i) => {
      const fav = h('span', { class: 'ts-fav' });
      paintFavicon(fav, tab);
      const row = h('div', {
        class: `ts-row ${i === index ? 'active' : ''}`,
        dataset: { id: tab.id },
      },
        fav,
        h('span', { class: 'ts-title' }, tab.title || '新标签页'),
        tab.active ? h('span', { class: 'ts-badge' }, '当前') : null,
        h('span', { class: 'ts-host' }, hostOf(tab.url)),
        h('button', { class: 'ts-close', title: '关闭标签页', html: icon('x', { size: 9 }) })
      );

      row.addEventListener('mousemove', () => {
        if (index === i) return;
        index = i;
        markActive();
      });
      row.addEventListener('mousedown', (e) => {
        if (e.target.closest('.ts-close')) return;
        e.preventDefault();
        choose(tab.id);
      });
      row.querySelector('.ts-close').addEventListener('click', (e) => {
        e.stopPropagation();
        nucleus.tabs.close(tab.id);
        // 关掉之后列表要重新算，但不要因为空列表把浮层关了
        paint();
      });
      return row;
    }));
  }

  function markActive() {
    const nodes = listEl.querySelectorAll('.ts-row');
    nodes.forEach((n, i) => n.classList.toggle('active', i === index));
    nodes[index]?.scrollIntoView({ block: 'nearest' });
  }

  function choose(id) {
    close();
    if (id) nucleus.tabs.activate(id);
  }

  function onKey(e) {
    if (!overlay) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (rows.length) { index = Math.min(index + 1, rows.length - 1); markActive(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length) { index = Math.max(index - 1, 0); markActive(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const tab = rows[index];
      if (tab) choose(tab.id);
    } else if (e.key === 'Delete' || (e.key === 'w' && e.ctrlKey)) {
      e.preventDefault();
      const tab = rows[index];
      if (tab) {
        nucleus.tabs.close(tab.id);
        paint();
      }
    }
  }

  function open() {
    if (overlay) {
      inputEl.focus();
      inputEl.select();
      return;
    }
    closing = false;
    index = 1; // 默认「上一个标签」，Enter 就是快速回跳

    inputEl = h('input', {
      class: 'ts-input',
      type: 'text',
      placeholder: '搜索标签页…',
      spellcheck: 'false',
      autocomplete: 'off',
    });
    listEl = h('div', { class: 'ts-list' });

    const panel = h('div', { class: 'ts-panel' },
      h('div', { class: 'ts-head' },
        h('span', { class: 'ts-head-icon', html: icon('layers', { size: 15 }) }),
        inputEl,
        h('span', { class: 'ts-count' })
      ),
      listEl,
      h('div', { class: 'ts-foot' },
        h('span', {}, '↑↓ 选择'),
        h('span', {}, 'Enter 切换'),
        h('span', {}, 'Del 关闭'),
        h('span', {}, 'Esc 退出')
      )
    );

    overlay = h('div', { class: 'ts-backdrop' }, panel);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });

    inputEl.addEventListener('input', () => { index = 0; paint(); });
    inputEl.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    paint();
    const count = overlay.querySelector('.ts-count');
    if (count) count.textContent = `${nucleus.tabs.list().length} 个标签`;
    requestAnimationFrame(() => {
      inputEl.focus();
      inputEl.select();
    });
  }

  function close() {
    if (!overlay || closing) return;
    closing = true;
    const el = overlay;
    overlay = null;
    el.classList.add('closing');
    setTimeout(() => el.remove(), 200);
  }

  nucleus.commands.register('tabs.switch', {
    title: '切换标签页（搜索）',
    icon: 'layers',
    keybinding: 'Ctrl+Shift+A',
    handler: open,
  });
}
