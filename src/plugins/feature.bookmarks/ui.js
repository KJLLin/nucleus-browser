/**
 * feature.bookmarks —— 书签。
 *
 * 一个插件同时贡献了：工具栏星标按钮、两个命令与快捷键、一个侧边栏面板。
 * 这就是「一切皆插件」的实际形状 —— 功能横跨多个 UI 位置，但只有一份代码。
 */
import { icon } from 'nucleus://core/lib/icons.js';
import { h, hostOf } from 'nucleus://core/lib/dom.js';

export async function activate(nucleus) {
  await nucleus.storage.load();

  let items = nucleus.storage.get('items', []);
  if (!Array.isArray(items)) items = [];

  const save = () => nucleus.storage.set('items', items.slice());

  const findIndex = (url) => items.findIndex((x) => x.url === url);

  function currentTab() {
    return nucleus.tabs.active();
  }

  function isBookmarked(url) {
    return !!url && findIndex(url) >= 0;
  }

  // ---------- 工具栏星标 ----------

  const starBtn = h('button', {
    class: 'navbtn',
    title: '收藏此页（Ctrl+D）',
    html: icon('star', { size: 16 }),
  });
  starBtn.style.display = nucleus.settings.get('showStar', true) ? '' : 'none';

  function paintStar() {
    const tab = currentTab();
    const on = tab && isBookmarked(tab.url);
    starBtn.classList.toggle('on', !!on);
    const svg = starBtn.querySelector('svg');
    if (svg) svg.style.fill = on ? 'currentColor' : 'none';
  }

  starBtn.addEventListener('click', () => toggle());

  // 星标放在地址栏内部右侧（嵌套槽位），而不是工具栏外面。
  // when 让它在非网页页面自动消失 —— 条件渲染由槽位系统负责，插件不用自己管显示。
  nucleus.slots.inject('shell.omnibox.actions', ({ register }) => {
    return register({
      id: 'bookmarks:star',
      order: 10,
      when: (p) => nucleus.settings.get('showStar', true)
        && !!p.tab && /^https?:/i.test(p.tab.url || ''),
      render: () => starBtn,
    });
  });

  for (const evt of ['activated', 'updated', 'created', 'removed']) {
    nucleus.tabs.on(evt, paintStar);
  }

  // ---------- 增删 ----------

  async function toggle() {
    const tab = currentTab();
    // 空白页与内部页面都没有收藏价值；地址由 ui.shell 这类插件决定，不能写死
    if (!tab || !tab.url || tab.url === 'about:blank' || tab.url === nucleus.env.newTabUrl) {
      nucleus.ui.toast('当前页面无法收藏');
      return;
    }
    const idx = findIndex(tab.url);
    if (idx >= 0) {
      items = items.filter((_, i) => i !== idx);
      save();
      nucleus.ui.toast('已取消收藏');
    } else {
      let title = tab.title;
      if (!title || title === '新标签页') {
        const input = await nucleus.ui.prompt('收藏此页', { value: hostOf(tab.url), label: '书签名称' });
        if (input === null) return;
        title = input || hostOf(tab.url);
      }
      items.push({
        id: `bm_${Date.now().toString(36)}`,
        title,
        url: tab.url,
        addedAt: Date.now(),
      });
      save();
      nucleus.ui.toast('已加入书签', { type: 'success' });
    }
    paintStar();
    if (nucleus.sidebar.current === 'feature.bookmarks') renderPanel();
  }

  // ---------- 面板 ----------

  let panelEl = null;
  let query = '';

  function buildPanel() {
    query = '';
    const list = h('div', { class: 'panel-body' });
    const search = h('input', {
      class: 'input',
      placeholder: '搜索书签…',
      style: { height: '28px', margin: '8px 10px' },
    });
    search.addEventListener('input', () => {
      query = search.value.trim().toLowerCase();
      paintList(list);
    });

    const panel = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('span', { class: 'grow' }, '书签'),
        h('button', {
          class: 'icon-btn',
          title: '添加当前页',
          html: icon('plus', { size: 14 }),
          onclick: () => toggle(),
        }),
        h('button', {
          class: 'icon-btn',
          title: '关闭',
          html: icon('x', { size: 14 }),
          onclick: () => nucleus.sidebar.hide(),
        })
      ),
      search,
      list
    );

    panelEl = panel;
    paintList(list);
    return panel;
  }

  function paintList(container) {
    container.innerHTML = '';
    const filtered = items
      .filter((x) => !query || x.title.toLowerCase().includes(query) || x.url.toLowerCase().includes(query))
      .sort((a, b) => b.addedAt - a.addedAt);

    if (!filtered.length) {
      container.appendChild(h('div', { class: 'empty' },
        h('span', { html: icon('bookmark', { size: 26 }) }),
        h('div', {}, items.length ? '没有匹配的书签' : '还没有书签，按 Ctrl+D 收藏当前页面')
      ));
      return;
    }

    for (const item of filtered) {
      const row = h('div', { class: 'list-item' },
        h('span', { class: 's-icon', style: { color: 'var(--text-faint)' }, html: icon('bookmark', { size: 13 }) }),
        h('div', { class: 'grow' },
          h('div', { class: 'ellipsis' }, item.title),
          h('div', { class: 'sub ellipsis' }, hostOf(item.url) || item.url)
        )
      );
      row.addEventListener('click', () => {
        const newTab = nucleus.settings.get('openInNewTab', false);
        const tab = currentTab();
        if (newTab || !tab) nucleus.tabs.create({ url: item.url });
        else nucleus.tabs.navigate(tab.id, item.url);
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        nucleus.ui.menu([
          { label: '在新标签页打开', icon: 'external-link', onClick: () => nucleus.tabs.create({ url: item.url }) },
          { label: '复制链接', icon: 'copy', onClick: () => navigator.clipboard?.writeText(item.url) },
          { label: '重命名', icon: 'type', onClick: async () => {
            const name = await nucleus.ui.prompt('重命名书签', { value: item.title });
            if (name === null) return;
            item.title = name || item.title;
            save();
            paintList(container);
          } },
          { separator: true },
          { label: '删除', icon: 'trash', danger: true, onClick: () => {
            items = items.filter((x) => x.id !== item.id);
            save();
            paintList(container);
            paintStar();
          } },
        ], { x: e.clientX, y: e.clientY });
      });
      container.appendChild(row);
    }
  }

  function renderPanel() {
    if (nucleus.sidebar.current === 'feature.bookmarks') {
      nucleus.sidebar.show('feature.bookmarks', buildPanel(), { side: 'left', width: 300 });
    }
  }

  // ---------- 命令 ----------

  nucleus.commands.register('bookmarks.toggle', {
    title: '收藏 / 取消收藏当前页面',
    icon: 'star',
    keybinding: 'Ctrl+D',
    handler: toggle,
  });

  nucleus.commands.register('bookmarks.panel', {
    title: '打开书签面板',
    icon: 'panel-left',
    keybinding: 'Ctrl+Shift+O',
    handler: () => {
      nucleus.sidebar.toggle('feature.bookmarks', buildPanel, { side: 'left', width: 300 });
    },
  });

  nucleus.commands.register('bookmarks.manage', {
    title: '管理全部书签',
    icon: 'bookmark',
    handler: () => {
      nucleus.sidebar.show('feature.bookmarks', buildPanel(), { side: 'left', width: 300 });
    },
  });

  paintStar();
}
