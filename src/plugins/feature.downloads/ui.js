/**
 * feature.downloads —— 下载管理。
 *
 * 下载事件由核的 DownloadService 从 session 捕获，再经事件总线广播；
 * 这个插件只是订阅者，不需要任何主进程代码。
 */
import { icon } from 'nucleus://core/lib/icons.js';
import { h, formatBytes } from 'nucleus://core/lib/dom.js';

export async function activate(nucleus) {
  /** id -> item */
  const items = new Map();
  let badgeEl = null;
  let panelBody = null;

  const btn = h('button', { class: 'navbtn', title: '下载（Ctrl+J）', html: icon('download', { size: 16 }) });
  btn.addEventListener('click', () => openPanel());

  badgeEl = h('span', { class: 'badge hidden' });
  btn.appendChild(badgeEl);

  if (nucleus.regions.el('nav-right')) nucleus.regions.mount('nav-right', btn);

  function activeCount() {
    let n = 0;
    for (const it of items.values()) if (it.state === 'progressing') n += 1;
    return n;
  }

  function paintBadge() {
    const n = activeCount();
    badgeEl.textContent = String(n);
    badgeEl.classList.toggle('hidden', n === 0);
    btn.classList.toggle('on', n > 0);
  }

  // ---------- 事件 ----------

  nucleus.bus.on('downloads:started', (item) => {
    items.set(item.id, item);
    paintBadge();
    nucleus.ui.toast(`开始下载：${item.filename}`, { type: 'info' });
    if (panelBody) paintPanel();
  });

  nucleus.bus.on('downloads:updated', (item) => {
    const prev = items.get(item.id);
    items.set(item.id, Object.assign({}, prev, item));
    paintBadge();
    if (panelBody) paintPanel();
  });

  nucleus.bus.on('downloads:done', (item) => {
    const prev = items.get(item.id) || {};
    const merged = Object.assign({}, prev, item);
    items.set(item.id, merged);
    paintBadge();
    if (item.state === 'completed') {
      nucleus.ui.toast(`下载完成：${merged.filename}`, { type: 'success' });
    } else if (item.state === 'interrupted') {
      nucleus.ui.toast(`下载中断：${merged.filename}`, { type: 'error' });
    }
    if (panelBody) paintPanel();
  });

  // ---------- 面板 ----------

  function openPanel() {
    panelBody = h('div', { class: 'panel-body' });
    const panel = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('span', { class: 'grow' }, '下载'),
        h('button', {
          class: 'icon-btn',
          title: '清空已完成',
          html: icon('trash', { size: 14 }),
          onclick: () => {
            for (const [id, it] of Array.from(items)) {
              if (it.state !== 'progressing') items.delete(id);
            }
            paintPanel();
          },
        }),
        h('button', {
          class: 'icon-btn',
          title: '关闭',
          html: icon('x', { size: 14 }),
          onclick: () => { panelBody = null; nucleus.sidebar.hide(); },
        })
      ),
      panelBody
    );
    nucleus.sidebar.show('feature.downloads', panel, { side: 'right', width: 340 });
    paintPanel();
  }

  function paintPanel() {
    if (!panelBody) return;
    panelBody.innerHTML = '';
    const list = Array.from(items.values()).sort((a, b) => b.startedAt - a.startedAt);

    if (!list.length) {
      panelBody.appendChild(h('div', { class: 'empty' },
        h('span', { html: icon('download', { size: 26 }) }),
        h('div', {}, '暂无下载任务')
      ));
      return;
    }

    for (const item of list) {
      const pct = item.totalBytes > 0
        ? Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100))
        : null;

      const stateText = item.state === 'progressing'
        ? (item.paused ? '已暂停' : `${pct === null ? '下载中' : `${pct}%`} · ${formatBytes(item.receivedBytes)}${item.totalBytes ? ` / ${formatBytes(item.totalBytes)}` : ''}`)
        : item.state === 'completed' ? `已完成 · ${formatBytes(item.receivedBytes)}`
        : item.state === 'cancelled' ? '已取消' : '已中断';

      const bar = h('div', {
        style: {
          height: '3px',
          background: 'var(--bg-active)',
          borderRadius: '2px',
          overflow: 'hidden',
          marginTop: '6px',
        },
      }, h('div', {
        style: {
          height: '100%',
          width: `${item.state === 'completed' ? 100 : (pct || 8)}%`,
          background: item.state === 'completed' ? 'var(--ok)'
            : item.state === 'progressing' ? 'var(--accent)' : 'var(--danger)',
          transition: 'width 240ms linear',
        },
      }));

      const row = h('div', { class: 'list-item', style: { flexDirection: 'column', alignItems: 'stretch', gap: '2px', padding: '9px 12px' } },
        h('div', { class: 'hstack' },
          h('span', { style: { color: 'var(--text-faint)', display: 'flex' }, html: icon('file-text', { size: 13 }) }),
          h('span', { class: 'grow ellipsis', style: { color: 'var(--text)' } }, item.filename),
          item.state === 'completed'
            ? h('button', {
                class: 'icon-btn',
                title: '在文件夹中显示',
                html: icon('folder', { size: 13 }),
                onclick: (e) => {
                  e.stopPropagation();
                  nucleus.invoke('nucleus:downloads:open-folder', { p: item.savePath });
                },
              })
            : null
        ),
        h('div', { style: { fontSize: '11px', color: 'var(--text-faint)' } }, stateText),
        item.state === 'progressing' ? bar : null
      );

      panelBody.appendChild(row);
    }
  }

  nucleus.commands.register('downloads.panel', {
    title: '打开下载面板',
    icon: 'download',
    keybinding: 'Ctrl+J',
    handler: () => {
      if (nucleus.sidebar.current === 'feature.downloads' && nucleus.sidebar.isOpen) {
        nucleus.sidebar.hide();
        return;
      }
      openPanel();
    },
  });
}
