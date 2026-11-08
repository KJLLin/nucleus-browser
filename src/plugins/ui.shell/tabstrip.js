/**
 * ui.shell / 标签栏模块。
 *
 * 创建、切换、关闭、拖拽排序标签页，并维护「撤销关闭」栈。
 * 只通过 nucleus.tabs 的公开 API 工作，没有任何特权通道。
 */
import { icon } from 'nucleus://core/lib/icons.js';
import { h } from 'nucleus://core/lib/dom.js';

export function initTabstrip(nucleus) {
  const strip = nucleus.regions.el('tabstrip');
  if (!strip) throw new Error('找不到 tabstrip 区域');

  // 不直接往区域容器里塞节点：先向 region.tabstrip 注册一个条目，
  // 条目内部用 display:contents 的 host —— 不生成盒子，标签仍直接参与
  // .tabstrip 的 flex 布局，但自省页能看见「这块区域是谁填的」。
  const host = h('div', { class: 'tabstrip-host', style: { display: 'contents' } });
  nucleus.slots.register({
    name: 'region.tabstrip',
    id: 'ui.shell:tabstrip',
    order: 0,
    render: () => host,
  });

  const newTabUrl = nucleus.env.newTabUrl || 'nucleus://ui.shell/newtab/index.html';

  /** id -> {el, titleEl, favEl, closeEl} */
  const views = new Map();
  /** 最近关闭的标签，用于 Ctrl+Shift+T */
  const closed = [];

  // ---------- 视图 ----------

  const newBtn = h('button', {
    class: 'tab-new',
    title: '新建标签页（Ctrl+T）',
    html: icon('plus', { size: 13 }),
  });
  newBtn.addEventListener('click', () => nucleus.tabs.create({ url: newTabUrl }));

  function makeView(tab) {
    const favEl = h('span', { class: 'favicon' });
    const titleEl = h('span', { class: 'tab-title' });
    const closeEl = h('button', { class: 'tab-close', title: '关闭', html: icon('x', { size: 9 }) });
    const el = h('div', { class: 'tab', dataset: { id: tab.id } }, favEl, titleEl, closeEl);

    closeEl.addEventListener('mousedown', (e) => e.stopPropagation());
    closeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      nucleus.tabs.close(tab.id);
    });

    el.addEventListener('pointerdown', (e) => onDragStart(e, tab.id));
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) { e.preventDefault(); nucleus.tabs.close(tab.id); }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showTabMenu(e.clientX, e.clientY, tab.id);
    });

    return { el, titleEl, favEl, closeEl };
  }

  function paintFavicon(view, tab) {
    if (tab.loading) {
      view.favEl.innerHTML = '<span class="tab-loading"></span>';
      return;
    }
    if (tab.audible || tab.muted) {
      view.favEl.innerHTML = icon(tab.muted ? 'volume-x' : 'volume-2', { size: 14 });
      return;
    }
    if (tab.favicon) {
      const img = document.createElement('img');
      img.src = tab.favicon;
      img.addEventListener('error', () => {
        view.favEl.innerHTML = icon('globe', { size: 14 });
      }, { once: true });
      view.favEl.innerHTML = '';
      view.favEl.appendChild(img);
      return;
    }
    view.favEl.innerHTML = icon(tab.internal ? 'layers' : 'globe', { size: 14 });
  }

  function updateView(view, tab) {
    view.el.classList.toggle('active', !!tab.active);
    view.el.classList.toggle('loading', !!tab.loading);
    view.titleEl.textContent = tab.title || '新标签页';
    view.el.title = `${tab.title || ''}\n${tab.url || ''}`.trim();
    view.closeEl.style.display = nucleus.settings.get('closeButton', true) ? '' : 'none';
    paintFavicon(view, tab);
  }

  function sync() {
    const tabs = nucleus.tabs.list();
    const alive = new Set(tabs.map((t) => t.id));

    for (const [id, view] of Array.from(views)) {
      if (!alive.has(id)) {
        view.el.remove();
        views.delete(id);
      }
    }

    let prev = null;
    for (const tab of tabs) {
      let view = views.get(tab.id);
      if (!view) {
        view = makeView(tab);
        views.set(tab.id, view);
        host.insertBefore(view.el, newBtn);
      }
      updateView(view, tab);

      const expectNext = prev ? prev.nextSibling : host.firstChild;
      if (expectNext !== view.el) {
        host.insertBefore(view.el, expectNext || newBtn);
      }
      prev = view.el;
    }

    if (newBtn.parentNode !== host || host.lastElementChild !== newBtn) {
      host.appendChild(newBtn);
    }

    strip.classList.toggle('dense', tabs.length > 8);
    const maxW = nucleus.settings.get('maxWidth', 210);
    for (const view of views.values()) view.el.style.maxWidth = `${maxW}px`;
  }

  // ---------- 拖拽排序 ----------

  let drag = null;

  function onDragStart(e, id) {
    if (e.button !== 0) return;
    if (e.target.closest('.tab-close')) return;
    const view = views.get(id);
    if (!view) return;
    drag = { id, startX: e.clientX, el: view.el, moved: false };
    view.el.setPointerCapture?.(e.pointerId);
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd, { once: true });
  }

  function onDragMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.el.classList.add('dragging');
    }
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.tab');
    for (const v of views.values()) v.el.classList.remove('drop-before', 'drop-after');
    if (target && target !== drag.el) {
      const rect = target.getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      target.classList.add(after ? 'drop-after' : 'drop-before');
      drag.targetId = target.dataset.id;
      drag.after = after;
    } else {
      drag.targetId = null;
    }
  }

  function onDragEnd() {
    window.removeEventListener('pointermove', onDragMove);
    if (!drag) return;
    const { id, moved, el, targetId, after } = drag;
    el.classList.remove('dragging');
    for (const v of views.values()) v.el.classList.remove('drop-before', 'drop-after');
    const wasDrag = moved;
    drag = null;

    if (!wasDrag) {
      nucleus.tabs.activate(id);
      return;
    }
    if (targetId && targetId !== id) {
      const order = nucleus.tabs.list().map((t) => t.id).filter((x) => x !== id);
      let idx = order.indexOf(targetId);
      if (idx < 0) return;
      if (after) idx += 1;
      nucleus.tabs.reorder(id, idx);
    }
  }

  // ---------- 标签右键 ----------

  function showTabMenu(x, y, id) {
    const tab = nucleus.tabs.get(id);
    if (!tab) return;
    nucleus.ui.menu([
      { label: '新建标签页', icon: 'plus', keybinding: 'Ctrl+T', onClick: () => nucleus.tabs.create({ url: newTabUrl }) },
      { label: '复制标签页', icon: 'copy', onClick: () => nucleus.tabs.duplicate(id) },
      { separator: true },
      {
        label: tab.muted ? '取消静音' : '静音标签页',
        icon: tab.muted ? 'volume-2' : 'volume-x',
        onClick: () => nucleus.tabs.toggleMute(id),
      },
      { label: '重新加载', icon: 'rotate-cw', onClick: () => nucleus.tabs.reload(id) },
      { separator: true },
      { label: '关闭标签页', icon: 'x', keybinding: 'Ctrl+W', onClick: () => nucleus.tabs.close(id) },
      { label: '关闭其他标签页', icon: 'layers', onClick: () => nucleus.tabs.closeOthers(id) },
      { label: '关闭右侧标签页', icon: 'panel-right', onClick: () => nucleus.tabs.closeToRight(id) },
    ], { x, y });
  }

  // ---------- 撤销关闭 ----------

  nucleus.tabs.on('removing', (tab) => {
    if (!tab || !tab.url) return;
    const limit = nucleus.settings.get('rememberClosed', 20);
    if (!limit) return;
    closed.unshift({ url: tab.url, title: tab.title, pinned: tab.pinned });
    while (closed.length > limit) closed.pop();
  });

  // ---------- 命令 ----------

  nucleus.commands.register('tabs.new', {
    title: '新建标签页',
    icon: 'plus',
    keybinding: 'Ctrl+T',
    handler: () => nucleus.tabs.create({ url: newTabUrl }),
  });

  nucleus.commands.register('tabs.close', {
    title: '关闭当前标签页',
    icon: 'x',
    keybinding: 'Ctrl+W',
    handler: () => {
      const active = nucleus.tabs.active();
      if (active) nucleus.tabs.close(active.id);
    },
  });

  nucleus.commands.register('tabs.reopen', {
    title: '重新打开已关闭的标签页',
    icon: 'rotate-cw',
    keybinding: 'Ctrl+Shift+T',
    handler: () => {
      const last = closed.shift();
      if (!last) {
        nucleus.ui.toast('没有可恢复的标签页');
        return;
      }
      nucleus.tabs.create({ url: last.url, active: true });
    },
  });

  nucleus.commands.register('tabs.next', {
    title: '切换到下一个标签页',
    icon: 'chevron-right',
    keybinding: 'Ctrl+Tab',
    handler: () => {
      const list = nucleus.tabs.list();
      if (list.length < 2) return;
      const idx = list.findIndex((t) => t.active);
      nucleus.tabs.activate(list[(idx + 1) % list.length].id);
    },
  });

  nucleus.commands.register('tabs.prev', {
    title: '切换到上一个标签页',
    icon: 'chevron-left',
    keybinding: 'Ctrl+Shift+Tab',
    handler: () => {
      const list = nucleus.tabs.list();
      if (list.length < 2) return;
      const idx = list.findIndex((t) => t.active);
      nucleus.tabs.activate(list[(idx - 1 + list.length) % list.length].id);
    },
  });

  nucleus.commands.register('tabs.duplicate', {
    title: '复制当前标签页',
    icon: 'copy',
    keybinding: 'Ctrl+Shift+D',
    handler: () => {
      const active = nucleus.tabs.active();
      if (active) nucleus.tabs.duplicate(active.id);
    },
  });

  nucleus.commands.register('tabs.closeOthers', {
    title: '关闭其他标签页',
    icon: 'layers',
    handler: () => {
      const active = nucleus.tabs.active();
      if (active) nucleus.tabs.closeOthers(active.id);
    },
  });

  nucleus.commands.register('tabs.closeRight', {
    title: '关闭右侧标签页',
    icon: 'panel-right',
    handler: () => {
      const active = nucleus.tabs.active();
      if (active) nucleus.tabs.closeToRight(active.id);
    },
  });

  // ---------- 订阅 ----------

  for (const evt of ['created', 'updated', 'removed', 'activated', 'reordered']) {
    nucleus.tabs.on(evt, () => sync());
  }

  nucleus.settings.onChange(() => sync());
  sync();
}
