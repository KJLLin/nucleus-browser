/**
 * feature.privacy —— 隐私清理。
 *
 * 清的是浏览器自己的会话：HTTP 缓存、Cookie、localStorage/IndexedDB。
 * 不包含下载文件、书签、历史记录 —— 那几样是「用户资产」，不是「临时数据」，
 * 混在一个按钮里迟早会有人误删。
 */
import { h } from 'nucleus://core/lib/dom.js';
import { icon } from 'nucleus://core/lib/icons.js';

const ITEMS = [
  {
    what: 'cache',
    title: '缓存文件',
    desc: '网页的图片、脚本、样式副本。清掉后首次加载会稍慢，但能解决「页面样式错乱」。',
    icon: 'zap',
  },
  {
    what: 'storage',
    title: '站点数据',
    desc: 'Cookie、localStorage、IndexedDB。清掉后所有网站都会退出登录。',
    icon: 'lock',
  },
];

export async function activate(nucleus) {
  await nucleus.storage.load();

  const fmt = (ts) => {
    if (!ts) return '从未清理';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  async function clear(what, label) {
    const ok = await nucleus.ui.confirm(
      `清除${label}？`,
      what === 'storage'
        ? '所有网站都会退出登录，本地保存的表单与草稿也会丢失。这个操作不能撤销。'
        : '清除后再次打开页面需要重新下载资源，不影响登录状态。'
    );
    if (!ok) return false;

    try {
      await nucleus.invoke('nucleus:session:clear', { what });
      const at = Date.now();
      nucleus.storage.set('lastClearedAt', at);
      nucleus.storage.set('lastClearedWhat', what);
      nucleus.ui.toast(`${label}已清除`, { type: 'success' });
      return true;
    } catch (err) {
      nucleus.ui.toast(`清除失败：${err.message}`, { type: 'error' });
      return false;
    }
  }

  async function openPanel() {
    const lastEl = h('div', { class: 'pv-last' },
      h('span', { html: icon('clock', { size: 13 }) }),
      h('span', {}, `上次清理：${fmt(nucleus.storage.get('lastClearedAt'))}`)
    );

    const tabsEl = h('div', { class: 'pv-last' },
      h('span', { html: icon('layers', { size: 13 }) }),
      h('span', {}, `当前打开 ${nucleus.tabs.list().length} 个标签`)
    );

    const rows = ITEMS.map((item) => {
      const btn = h('button', { class: 'btn' }, `清除${item.title}`);
      const status = h('span', { class: 'pv-done' }, '');

      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const ok = await clear(item.what, item.title);
        btn.disabled = false;
        if (ok) {
          status.textContent = '刚刚清除';
          lastEl.lastChild.textContent = `上次清理：${fmt(Date.now())}`;
        }
      });

      return h('div', { class: 'pv-row' },
        h('span', { class: 'pv-icon', html: icon(item.icon, { size: 16 }) }),
        h('div', { class: 'pv-text' },
          h('div', { class: 'pv-title' }, item.title, status),
          h('div', { class: 'pv-desc' }, item.desc)
        ),
        btn
      );
    });

    const body = h('div', { class: 'pv-body' },
      h('div', { class: 'pv-lead' }, '只清理浏览过程产生的临时数据。书签、历史记录、下载的文件都会保留。'),
      ...rows,
      h('div', { class: 'pv-foot' }, lastEl, tabsEl)
    );

    await nucleus.ui.modal({
      title: '隐私清理',
      body,
      width: 480,
      actions: [{ label: '完成', value: true, primary: true }],
    });
  }

  nucleus.commands.register('privacy.panel', {
    title: '隐私清理',
    icon: 'shield',
    keybinding: 'Ctrl+Shift+Del',
    handler: openPanel,
  });

  nucleus.commands.register('privacy.cache', {
    title: '只清除缓存',
    icon: 'trash',
    hidden: true,
    handler: () => clear('cache', '缓存文件'),
  });

  nucleus.log.info('隐私清理已就绪');
}
