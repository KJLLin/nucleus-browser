/**
 * feature.session —— 会话恢复。
 *
 * 这是启动时最先「抢跑」的插件之一：它在 activate 里就把上次的标签建出来，
 * 因此核的兜底逻辑会发现「已经有标签了」，不再重复开新的。
 */
import { debounce } from 'nucleus://core/lib/dom.js';

export async function activate(nucleus) {
  await nucleus.storage.load();

  const saveNow = () => {
    const tabs = nucleus.tabs.list().filter((t) => {
      if (!t.url || t.url === 'about:blank' || t.url === nucleus.env.newTabUrl) return false;
      if (nucleus.settings.get('skipInternal', true) && t.url.startsWith('nucleus://')) return false;
      return /^(https?|file):/i.test(t.url);
    });
    if (!tabs.length) return; // 不覆盖上一次有效的会话
    nucleus.storage.set('lastSession', {
      tabs: tabs.map((t) => t.url).slice(0, 40),
      activeIndex: Math.max(0, tabs.findIndex((t) => t.active)),
      savedAt: Date.now(),
    });
  };

  const scheduleSave = debounce(saveNow, 900);

  for (const evt of ['created', 'removed', 'activated', 'updated']) {
    nucleus.tabs.on(evt, scheduleSave);
  }

  // ---------- 启动恢复 ----------

  const session = nucleus.storage.get('lastSession', null);
  const startup = nucleus.settings.get('startup', 'restore');

  if (startup === 'restore' && session && Array.isArray(session.tabs) && session.tabs.length) {
    const urls = nucleus.tabs.list().length
      ? [] // 已经有标签（例如命令行传入了 URL），就不重复恢复
      : session.tabs.slice(0, 20);

    urls.forEach((url, i) => {
      nucleus.tabs.create({ url, active: i === (session.activeIndex || 0) });
    });

    if (urls.length) {
      nucleus.ui.toast(`已恢复上次的 ${urls.length} 个标签`, { timeout: 2600 });
    }
  }

  // ---------- 命令 ----------

  nucleus.commands.register('session.restore', {
    title: '恢复上次会话',
    icon: 'history',
    handler: () => {
      const s = nucleus.storage.get('lastSession', null);
      if (!s || !s.tabs?.length) {
        nucleus.ui.toast('没有可恢复的会话');
        return;
      }
      s.tabs.slice(0, 20).forEach((url, i) => {
        nucleus.tabs.create({ url, active: i === 0 });
      });
    },
  });

  nucleus.commands.register('session.save', {
    title: '立即保存当前会话',
    icon: 'save',
    handler: () => {
      saveNow();
      nucleus.ui.toast('会话已保存', { type: 'success' });
    },
  });
}
