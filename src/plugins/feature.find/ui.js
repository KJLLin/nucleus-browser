/**
 * feature.find —— 页内查找。
 * 高亮由 Chromium 的 findInPage 完成，插件只负责输入条与计数。
 */
import { icon } from 'nucleus://core/lib/icons.js';
import { h } from 'nucleus://core/lib/dom.js';

export async function activate(nucleus) {
  let bar = null;
  let input = null;
  let countEl = null;
  let targetTab = null;

  function ensureBar() {
    if (bar) return bar;

    input = h('input', {
      type: 'text',
      placeholder: '在页面中查找',
      style: {
        width: '170px',
        height: '26px',
        border: 'none',
        outline: 'none',
        background: 'transparent',
        color: 'var(--text)',
        fontSize: '12.5px',
      },
    });

    countEl = h('span', {
      style: { fontSize: '11px', color: 'var(--text-faint)', minWidth: '38px', textAlign: 'center' },
    }, '');

    const btnPrev = h('button', { class: 'icon-btn', title: '上一个（Shift+F3）', html: icon('chevron-up', { size: 13 }) });
    const btnNext = h('button', { class: 'icon-btn', title: '下一个（F3）', html: icon('chevron-down', { size: 13 }) });
    const btnClose = h('button', { class: 'icon-btn', title: '关闭（Esc）', html: icon('x', { size: 13 }) });

    bar = h('div', {
      style: {
        position: 'fixed',
        top: 'calc(var(--topbar-h) + var(--toolbar-h) + 8px)',
        right: '18px',
        zIndex: '920',
        display: 'flex',
        alignItems: 'center',
        gap: '2px',
        padding: '5px 6px 5px 12px',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border-strong)',
        borderRadius: '10px',
        boxShadow: 'var(--shadow-2)',
      },
    }, h('span', { style: { color: 'var(--text-faint)', display: 'flex', marginRight: '4px' }, html: icon('search', { size: 13 }) }),
      input, countEl, btnPrev, btnNext, btnClose);

    btnPrev.addEventListener('click', () => step(-1));
    btnNext.addEventListener('click', () => step(1));
    btnClose.addEventListener('click', close);

    input.addEventListener('input', () => run());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    document.getElementById('overlay').appendChild(bar);
    return bar;
  }

  function currentTabId() {
    const tab = nucleus.tabs.active();
    return tab ? tab.id : null;
  }

  function run() {
    const id = currentTabId();
    if (!id) return;
    targetTab = id;
    const text = input.value;
    if (!text) {
      countEl.textContent = '';
      nucleus.tabs.stopFind(id, 'clearSelection');
      return;
    }
    // Chromium 108 的 <webview> 对「首次查找」（findNext: false）不回报结果，
    // 表现为匹配计数一直空着。统一用 findNext: true：文本变了 Chromium 会自己重开搜索，
    // 文本没变则等同「下一个」，两种情况下计数都能回来。
    nucleus.tabs.find(id, text, { findNext: true, forward: true });
  }

  function step(dir) {
    const id = targetTab || currentTabId();
    if (!id || !input || !input.value) return;
    nucleus.tabs.find(id, input.value, { findNext: true, forward: dir > 0 });
  }

  function open() {
    ensureBar();
    const tab = nucleus.tabs.active();
    targetTab = tab ? tab.id : null;
    bar.style.display = 'flex';
    setTimeout(() => { input.focus(); input.select(); }, 20);
    if (input.value) run();
  }

  function close() {
    if (bar) bar.style.display = 'none';
    const id = targetTab || currentTabId();
    if (id) nucleus.tabs.stopFind(id, 'clearSelection');
    countEl.textContent = '';
  }

  // 查找结果回填
  nucleus.tabs.on('found', ({ id, result }) => {
    if (id !== targetTab) return;
    if (!result) return;
    if (result.matches === 0) countEl.textContent = '0/0';
    else countEl.textContent = `${result.activeMatchOrdinal}/${result.matches}`;
  });

  // 切换标签时关闭查找条，避免误操作旧页面
  nucleus.tabs.on('activated', () => {
    if (bar && bar.style.display !== 'none') close();
  });

  nucleus.commands.register('find.open', {
    title: '在页面中查找',
    icon: 'search',
    keybinding: 'Ctrl+F',
    handler: open,
  });

  nucleus.commands.register('find.next', {
    title: '查找下一个',
    icon: 'chevron-down',
    handler: () => {
      if (!bar || bar.style.display === 'none') open();
      else step(1);
    },
  });

  nucleus.commands.register('find.prev', {
    title: '查找上一个',
    icon: 'chevron-up',
    handler: () => {
      if (!bar || bar.style.display === 'none') open();
      else step(-1);
    },
  });
}
