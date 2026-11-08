/**
 * UI 原子层：toast / 对话框 / 菜单 / 命令面板。
 * 插件不自己搭轮子，保证所有交互长得一样。
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';

const overlayRoot = () => document.getElementById('overlay');
const toastRoot = () => document.getElementById('toasts');

/**
 * 播放退场动画后再移除节点。
 * 动效归 CSS，节奏归 JS：这里只负责「加类 → 等一个时长 → 摘掉」。
 * 元素被提前摘走（例如父容器整体清空）时不会报错。
 */
export function animateOut(node, cls = 'closing', duration = 180) {
  if (!node || !node.isConnected) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      node.remove();
      resolve();
    };
    node.classList.add(cls);
    node.addEventListener('animationend', done, { once: true });
    // 兜底：动画被系统「减少动态效果」关掉时不会有 animationend
    setTimeout(done, duration + 40);
  });
}

// ---------- Toast ----------

export function toast(message, { type = 'info', timeout = 3200 } = {}) {
  const root = toastRoot();
  if (!root) return () => {};
  const iconName = type === 'error' ? 'alert-circle' : type === 'success' ? 'check-circle' : 'info';
  const el = h('div', { class: `toast ${type}` },
    h('span', { class: 't-icon', html: icon(iconName, { size: 15 }) }),
    h('span', { class: 'grow' }, message)
  );
  root.appendChild(el);
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 180);
  };
  const timer = setTimeout(remove, timeout);
  el.addEventListener('click', () => { clearTimeout(timer); remove(); });
  return remove;
}

// ---------- 对话框 ----------

export function modal({
  title = '',
  body = null,
  actions = [{ label: '确定', value: true, primary: true }],
  center = true,
  width = null,
  dismissValue = null,
} = {}) {
  return new Promise((resolve) => {
    const root = overlayRoot();
    const box = h('div', { class: 'modal', style: width ? { width: `${width}px` } : {} });
    if (title) box.appendChild(h('div', { class: 'modal-head' }, title));
    const bodyEl = h('div', { class: 'modal-body' });
    if (body instanceof Node) bodyEl.appendChild(body);
    else if (typeof body === 'string') bodyEl.innerHTML = body;
    box.appendChild(bodyEl);
    if (actions && actions.length) {
      const foot = h('div', { class: 'modal-foot' });
      for (const act of actions) {
        foot.appendChild(h('button', {
          class: `btn ${act.primary ? 'primary' : act.danger ? 'danger' : 'ghost'}`,
          onclick: () => close(act.value),
        }, act.label));
      }
      box.appendChild(foot);
    }

    const scrim = h('div', { class: `scrim ${center ? 'center' : ''}` }, box);
    scrim.addEventListener('mousedown', (e) => {
      if (e.target === scrim) close(dismissValue);
    });

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(dismissValue); }
      if (e.key === 'Enter' && !e.shiftKey) {
        const primary = actions.find((a) => a.primary);
        if (primary && !(e.target instanceof HTMLTextAreaElement)) {
          e.preventDefault();
          close(primary.value);
        }
      }
    }

    let done = false;
    function close(value) {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      // 先让遮罩与卡片退场，再 resolve —— 否则调用方立刻打开下一个对话框时
      // 旧的会「闪」在新的一层上面
      animateOut(scrim, 'closing', 200).then(() => resolve(value));
    }

    document.addEventListener('keydown', onKey, true);
    root.appendChild(scrim);
    const focusable = box.querySelector('input, textarea, button.primary');
    if (focusable) setTimeout(() => focusable.focus(), 30);
  });
}

export async function confirm(title, message, { danger = false, okLabel = '确定' } = {}) {
  const res = await modal({
    title,
    body: h('div', {}, message),
    actions: [
      { label: '取消', value: false },
      { label: okLabel, value: true, primary: !danger, danger },
    ],
    dismissValue: false,
  });
  return res === true;
}

export function promptText(title, { value = '', placeholder = '', label = '' } = {}) {
  const input = h('input', { class: 'input', value, placeholder });
  const wrap = h('div', { class: 'vstack' }, label ? h('div', { class: 'desc' }, label) : null, input);
  setTimeout(() => { input.focus(); input.select(); }, 40);
  return modal({
    title,
    body: wrap,
    actions: [
      { label: '取消', value: null },
      { label: '确定', value: '__ok__', primary: true },
    ],
    dismissValue: null,
  }).then((v) => (v === '__ok__' ? input.value : null));
}

// ---------- 浮动菜单 ----------

export function menu(items, { x = 0, y = 0, align = 'left' } = {}) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());

  const el = h('div', { class: 'menu' });
  for (const item of items) {
    if (!item) continue;
    if (item.separator) { el.appendChild(h('div', { class: 'menu-sep' })); continue; }
    if (item.label && item.header) { el.appendChild(h('div', { class: 'menu-label' }, item.label)); continue; }
    const row = h('div', {
      class: `menu-item ${item.danger ? 'danger' : ''}`,
      style: item.disabled ? { opacity: 0.45, pointerEvents: 'none' } : {},
    },
      h('span', { class: 'm-icon', html: item.icon ? icon(item.icon, { size: 14 }) : '' }),
      h('span', { class: 'grow' }, item.label),
      item.keybinding ? h('span', { class: 'm-key' }, item.keybinding) : null
    );
    row.addEventListener('click', () => {
      close();
      try { item.onClick?.(); } catch (err) { console.error(err); }
    });
    el.appendChild(row);
  }

  document.body.appendChild(el);
  // 用 offsetWidth 而不是 getBoundingClientRect：菜单的进场动画带 scale，
  // 后者会把 0.965 倍后的尺寸算进来，定位就会偏几像素。
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = align === 'right' ? x - w : x;
  let top = y;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  if (left < 8) left = 8;
  if (top + h > window.innerHeight - 8) top = y - h;
  if (top < 8) top = 8;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  // 从点击的位置长出来，而不是从菜单左上角
  el.style.setProperty('--menu-origin', `${Math.max(0, Math.min(w, x - left))}px ${Math.max(0, Math.min(h, y - top))}px`);

  function close() {
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    animateOut(el, 'closing', 120);
  }
  function onDoc(e) {
    if (!el.contains(e.target)) close();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);

  return { close, el };
}

// ---------- 命令面板 ----------

export function palette({
  commands = [],
  placeholder = '输入命令或搜索…',
  onRun = null,
  onQuery = null,
  emptyText = '没有匹配的命令',
} = {}) {
  const input = h('input', { class: 'palette-input', placeholder, spellcheck: 'false' });
  const list = h('div', { class: 'palette-list' });
  const box = h('div', { class: 'palette' }, input, list);
  const scrim = h('div', { class: 'scrim' }, box);
  scrim.style.pointerEvents = 'auto';

  let items = [];
  let cursor = 0;

  function render(query) {
    clear(list);
    const q = query.trim().toLowerCase();
    items = commands.filter((c) => {
      if (!q) return true;
      return c.title.toLowerCase().includes(q)
        || (c.id || '').toLowerCase().includes(q)
        || (c.description || '').toLowerCase().includes(q)
        || (c.keywords || []).some((k) => String(k).toLowerCase().includes(q));
    }).slice(0, 60);

    if (!items.length) {
      list.appendChild(h('div', { class: 'suggest-empty' }, emptyText));
      return;
    }
    cursor = Math.min(cursor, items.length - 1);
    items.forEach((item, idx) => {
      const row = h('div', { class: `palette-item ${idx === cursor ? 'active' : ''}` },
        h('span', { class: 'p-icon', html: icon(item.icon || 'command', { size: 15 }) }),
        h('span', { class: 'p-title' }, item.title),
        item.subtitle ? h('span', { class: 'p-sub' }, item.subtitle) : null,
        item.keybinding ? h('span', { class: 'p-key' }, item.keybinding) : null
      );
      row.addEventListener('mousemove', () => {
        cursor = idx;
        [...list.children].forEach((c, i) => c.classList.toggle('active', i === idx));
      });
      row.addEventListener('click', () => run(idx));
      list.appendChild(row);
    });
  }

  function run(idx) {
    const item = items[idx];
    if (!item) return;
    close();
    try {
      if (onRun) onRun(item);
      else item.run?.();
    } catch (err) {
      console.error(err);
      toast(err.message, { type: 'error' });
    }
  }

  function close() {
    document.removeEventListener('keydown', onKey, true);
    animateOut(scrim, 'closing', 200);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      cursor = Math.min(cursor + 1, items.length - 1);
      [...list.children].forEach((c, i) => c.classList.toggle('active', i === cursor));
      list.children[cursor]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      [...list.children].forEach((c, i) => c.classList.toggle('active', i === cursor));
      list.children[cursor]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(cursor);
    }
  }

  input.addEventListener('input', () => {
    render(input.value);
    onQuery?.(input.value);
  });
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
  document.addEventListener('keydown', onKey, true);

  overlayRoot().appendChild(scrim);
  render('');
  setTimeout(() => input.focus(), 20);
  return { close, input };
}
