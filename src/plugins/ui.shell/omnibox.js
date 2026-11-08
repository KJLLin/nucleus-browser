/**
 * ui.shell / 地址栏模块。
 *
 * 智能地址解析、搜索、历史补全、缩放控制。
 * 补全数据来自 `history.suggest` 命令 —— 插件之间只走命令，不共享内部状态。
 */
import { icon } from 'nucleus://core/lib/icons.js';
import { h, debounce } from 'nucleus://core/lib/dom.js';

const ENGINES = {
  bing: { name: 'Bing', url: 'https://cn.bing.com/search?q=' },
  baidu: { name: '百度', url: 'https://www.baidu.com/s?wd=' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  ddg: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
};

/** 把地址栏输入解析成可导航的 URL */
export function resolveInput(raw, engineKey = 'bing', newTabUrl = null) {
  const text = String(raw || '').trim();
  if (!text) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  if (/^about:blank$/i.test(text)) return 'about:blank';
  if (/^about:/i.test(text)) return newTabUrl || 'about:blank';
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(text)) return `http://${text}`;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#]|$)/.test(text)) return `http://${text}`;

  if (/^[^\s/?#:]+\.[^\s/?#:]{2,}(:\d+)?([/?#]|$)/.test(text) && !text.includes(' ')) {
    return `https://${text}`;
  }
  if (/^[a-zA-Z]:\\/.test(text)) return `file:///${text.replace(/\\/g, '/')}`;

  const engine = ENGINES[engineKey] || ENGINES.bing;
  return engine.url + encodeURIComponent(text);
}

export function displayUrl(url) {
  if (!url) return '';
  const m = String(url).match(/^nucleus:\/\/([^/]+)\/(.*)$/);
  if (m) return `nucleus://${m[1]}/${m[2]}`;
  if (url === 'about:blank') return '';
  return url;
}

export function initOmnibox(nucleus) {
  const left = nucleus.regions.el('nav-left');
  const center = nucleus.regions.el('nav-center');
  if (!left || !center) throw new Error('找不到导航区域');

  const newTabUrl = nucleus.env.newTabUrl || 'nucleus://ui.shell/newtab/index.html';
  const engineKey = () => nucleus.settings.get('searchEngine', 'bing');

  const activeId = () => {
    const t = nucleus.tabs.active();
    return t ? t.id : null;
  };

  // ---------- 导航按钮 ----------

  const navButton = (iconName, title, onClick) => {
    const b = h('button', { class: 'navbtn', title, html: icon(iconName, { size: 16 }) });
    b.addEventListener('click', onClick);
    return b;
  };

  const btnBack = navButton('arrow-left', '后退（Alt+←）', () => {
    const id = activeId();
    if (id) nucleus.tabs.goBack(id);
  });
  const btnFwd = navButton('arrow-right', '前进（Alt+→）', () => {
    const id = activeId();
    if (id) nucleus.tabs.goForward(id);
  });
  const btnReload = navButton('rotate-cw', '重新加载（F5）', () => {
    const id = activeId();
    if (!id) return;
    const tab = nucleus.tabs.get(id);
    if (tab && tab.loading) nucleus.tabs.stop(id);
    else nucleus.tabs.reload(id);
  });

  nucleus.regions.mount('nav-left', h('div', { class: 'nav-cluster' }, btnBack, btnFwd, btnReload), { order: 5 });

  // ---------- 地址栏 ----------

  const schemeIcon = h('span', { class: 'scheme-icon', html: icon('globe', { size: 13 }) });
  const input = h('input', {
    type: 'text',
    placeholder: '搜索，或输入网址',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const box = h('div', { class: 'omnibox' }, schemeIcon, input);
  const wrap = h('div', { class: 'omnibox-wrap' }, box);

  // 先把地址栏注册进 region.nav-center —— 顺序不能反：
  // 声明子空位时，校验要看「这个插件是不是真的在这一区域渲染东西」。
  nucleus.regions.mount('nav-center', wrap, { order: 10 });

  // 地址栏内部的扩展点。以前别的插件只能挂到 nav-right（地址栏外面），
  // 现在它们可以真正「放进地址栏里」—— 这是嵌套槽位最直接的收益。
  nucleus.slots.declare({
    name: 'shell.omnibox.actions',
    parent: 'region.nav-center',
    cardinality: 'list',
    scope: 'tab-maybe',
    description: '地址栏右侧的动作位',
    policy: { restricted: false },
  });

  const actions = nucleus.slots.outlet('shell.omnibox.actions', { tab: nucleus.tabs.active() });
  actions.classList.add('omni-actions');
  box.appendChild(actions);

  let suggestEl = null;
  let suggestItems = [];
  let suggestIndex = -1;
  let lastEditValue = '';
  let editing = false;
  let lastTabUrl = null;

  // ---------- 安全标识 ----------

  let lastPainted = null;

  function paintScheme(url) {
    if (url === lastPainted) return;
    lastPainted = url;
    if (!url) {
      schemeIcon.className = 'scheme-icon';
      schemeIcon.innerHTML = icon('search', { size: 13 });
      schemeIcon.title = '';
      return;
    }
    if (url.startsWith('https://')) {
      schemeIcon.className = 'scheme-icon secure';
      schemeIcon.innerHTML = icon('lock', { size: 13 });
      schemeIcon.title = '连接已加密（HTTPS）';
    } else if (url.startsWith('http://')) {
      schemeIcon.className = 'scheme-icon insecure';
      schemeIcon.innerHTML = icon('alert-triangle', { size: 13 });
      schemeIcon.title = '此页面未加密（HTTP）';
    } else if (url.startsWith('nucleus://')) {
      schemeIcon.className = 'scheme-icon';
      schemeIcon.innerHTML = icon('layers', { size: 13 });
      schemeIcon.title = '浏览器内部页面';
    } else if (url.startsWith('file://')) {
      schemeIcon.className = 'scheme-icon';
      schemeIcon.innerHTML = icon('folder', { size: 13 });
      schemeIcon.title = '本地文件';
    } else {
      schemeIcon.className = 'scheme-icon';
      schemeIcon.innerHTML = icon('globe', { size: 13 });
      schemeIcon.title = url;
    }
  }

  // ---------- 状态同步 ----------

  function syncFromTab() {
    const tab = nucleus.tabs.active();
    nucleus.slots.updateOutlet(actions, { tab });

    // 页面真的换了 URL，说明导航已发生，补全层必须失效
    if (tab && tab.url !== lastTabUrl) {
      lastTabUrl = tab.url;
      closeSuggest();
      editing = false;
    }

    btnBack.disabled = !(tab && tab.canGoBack);
    btnFwd.disabled = !(tab && tab.canGoForward);
    btnReload.innerHTML = icon(tab && tab.loading ? 'x' : 'rotate-cw', { size: 16 });
    btnReload.title = tab && tab.loading ? '停止加载（Esc）' : '重新加载（F5）';
    paintScheme(tab ? tab.url : '');

    if (!editing) {
      closeSuggest();
      if (tab) {
        input.value = displayUrl(tab.url);
        input.title = tab.url || '';
      }
    }
  }

  for (const evt of ['activated', 'updated', 'created', 'removed', 'error']) {
    nucleus.tabs.on(evt, syncFromTab);
  }

  // ---------- 补全 ----------

  const requestSuggest = debounce(async (query) => {
    // 双重判定：既看内部标志，也看真实焦点，避免提交后又被防抖回调弹出来
    if (!editing || document.activeElement !== input) return;
    if (!nucleus.settings.get('showSuggestions', true)) return;
    const q = query.trim();
    if (!q) { closeSuggest(); return; }

    const engine = ENGINES[engineKey()] || ENGINES.bing;
    const items = [];

    const direct = resolveInput(q, engineKey(), newTabUrl);
    const isUrl = direct && /^(https?|file):\/\//.test(direct);

    items.push({
      kind: 'url',
      icon: isUrl ? 'globe' : 'search',
      title: isUrl ? q : `搜索「${q}」`,
      hint: isUrl ? '打开网址' : engine.name,
      url: direct,
    });

    if (!isUrl) {
      try {
        const historyItems = await nucleus.commands.execute('history.suggest', q, 6);
        if (Array.isArray(historyItems)) {
          for (const it of historyItems) {
            if (items.length >= 8) break;
            items.push({
              kind: 'history',
              icon: 'clock',
              title: it.title || it.url,
              hint: it.url,
              url: it.url,
            });
          }
        }
      } catch (_) {
        // 历史插件未启用：静默降级，只用搜索引擎
      }
    }

    renderSuggest(items);
  }, 110);

  function renderSuggest(items) {
    if (document.activeElement !== input) return;
    closeSuggest();
    if (!items.length) return;
    suggestItems = items;
    suggestIndex = 0;

    suggestEl = h('div', { class: 'suggest' });
    items.forEach((item, idx) => {
      const row = h('div', { class: `suggest-item ${idx === 0 ? 'active' : ''}` },
        h('span', { class: 's-icon', html: icon(item.icon, { size: 14 }) }),
        h('span', { class: 's-main' }, item.title),
        h('span', { class: 's-hint ellipsis' }, item.hint || '')
      );
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        commit(item.url);
      });
      row.addEventListener('mousemove', () => setSuggestIndex(idx));
      suggestEl.appendChild(row);
    });
    wrap.appendChild(suggestEl);
  }

  function setSuggestIndex(idx) {
    suggestIndex = idx;
    if (!suggestEl) return;
    [...suggestEl.children].forEach((c, i) => c.classList.toggle('active', i === idx));
  }

  function closeSuggest() {
    if (suggestEl) {
      suggestEl.remove();
      suggestEl = null;
    }
    suggestItems = [];
    suggestIndex = -1;
  }

  // ---------- 提交 ----------

  function commit(url) {
    if (!url) return;
    editing = false;
    closeSuggest();

    const id = activeId();
    const isSearch = Object.values(ENGINES).some((e) => url.startsWith(e.url));
    const forceNew = nucleus.settings.get('openInNewTab', false) && isSearch;

    input.blur();

    if (!id || forceNew) {
      nucleus.tabs.create({ url, active: true });
      return;
    }
    nucleus.tabs.navigate(id, url);
    input.value = displayUrl(url);
  }

  input.addEventListener('focus', () => {
    editing = true;
    lastEditValue = input.value;
    setTimeout(() => input.select(), 0);
  });

  input.addEventListener('blur', () => {
    editing = false;
    setTimeout(() => {
      if (!suggestEl) syncFromTab();
    }, 120);
  });

  input.addEventListener('input', () => {
    lastEditValue = input.value;
    requestSuggest(input.value);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const picked = suggestIndex >= 0 ? suggestItems[suggestIndex] : null;
      const url = picked ? picked.url : resolveInput(input.value, engineKey(), newTabUrl);
      commit(url);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (suggestItems.length) setSuggestIndex(Math.min(suggestIndex + 1, suggestItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (suggestItems.length) setSuggestIndex(Math.max(suggestIndex - 1, 0));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (suggestEl) {
        closeSuggest();
        input.value = lastEditValue;
      } else {
        input.blur();
        syncFromTab();
      }
    }
  });

  // 点安全图标看站点信息
  schemeIcon.addEventListener('click', () => {
    const tab = nucleus.tabs.active();
    if (!tab) return;
    let host = '';
    try { host = new URL(tab.url).hostname; } catch (_) { /* 内部页面没有 host */ }
    nucleus.ui.modal({
      title: '站点信息',
      body: h('div', { class: 'vstack' },
        h('div', { class: 'row' },
          h('span', { class: 'dim' }, '地址'),
          h('span', { class: 'grow selectable mono', style: { fontSize: '11.5px', wordBreak: 'break-all' } }, tab.url)
        ),
        host ? h('div', { class: 'row' }, h('span', { class: 'dim' }, '主机'), h('span', { class: 'grow selectable' }, host)) : null,
        h('div', { class: 'row' },
          h('span', { class: 'dim' }, '状态'),
          h('span', { class: 'grow' }, tab.url.startsWith('https://') ? '已加密传输' : '未加密')
        )
      ),
      actions: [{ label: '知道了', value: true, primary: true }],
    });
  });

  // ---------- 命令 ----------

  const T = () => nucleus.tabs.active();

  nucleus.commands.register('nav.back', {
    title: '后退', icon: 'arrow-left',
    handler: () => { const t = T(); if (t) nucleus.tabs.goBack(t.id); },
  });

  nucleus.commands.register('nav.forward', {
    title: '前进', icon: 'arrow-right',
    handler: () => { const t = T(); if (t) nucleus.tabs.goForward(t.id); },
  });

  nucleus.commands.register('nav.reload', {
    title: '重新加载', icon: 'rotate-cw',
    handler: () => { const t = T(); if (t) nucleus.tabs.reload(t.id); },
  });

  nucleus.commands.register('nav.hardReload', {
    title: '忽略缓存重新加载', icon: 'rotate-cw',
    handler: () => { const t = T(); if (t) nucleus.tabs.reload(t.id, true); },
  });

  nucleus.commands.register('nav.stop', {
    title: '停止加载', icon: 'x',
    handler: () => { const t = T(); if (t) nucleus.tabs.stop(t.id); },
  });

  nucleus.commands.register('nav.home', {
    title: '打开新标签页',
    icon: 'home',
    handler: () => nucleus.tabs.create({ url: newTabUrl }),
  });

  nucleus.commands.register('nav.focus', {
    title: '聚焦地址栏',
    icon: 'search',
    keybinding: 'Ctrl+L',
    handler: () => {
      input.focus();
      setTimeout(() => input.select(), 0);
    },
  });

  nucleus.commands.register('zoom.in', {
    title: '放大页面',
    icon: 'zoom-in',
    handler: () => {
      const t = T();
      if (t) nucleus.tabs.setZoom(t.id, Math.min(5, (t.zoom || 1) + 0.1));
      syncFromTab();
    },
  });

  nucleus.commands.register('zoom.out', {
    title: '缩小页面',
    icon: 'zoom-out',
    handler: () => {
      const t = T();
      if (t) nucleus.tabs.setZoom(t.id, Math.max(0.25, (t.zoom || 1) - 0.1));
      syncFromTab();
    },
  });

  nucleus.commands.register('zoom.reset', {
    title: '恢复默认缩放',
    icon: 'maximize-2',
    handler: () => {
      const t = T();
      if (t) nucleus.tabs.setZoom(t.id, 1);
      syncFromTab();
    },
  });

  syncFromTab();
}
