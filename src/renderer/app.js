/**
 * 浏览器 UI 主引导。
 *
 * 核在这里做四件事，做完就退场，剩下的全部交给插件：
 *   1. 建标签服务、命令表、事件总线
 *   2. 逐个挂载插件 UI
 *   3. 接管窗口按钮
 *   4. 兜底：若没有任何插件创建标签，就开一个新标签页
 */
import { TabsService } from './lib/tabs.js';
import { SidebarManager } from './lib/sidebar.js';
import { SlotRegistry } from './lib/slots.js';
import { Context } from './vendor/cordis.mjs';
import { CommandRegistry } from './lib/commands.js';
import { createPluginApi } from './lib/nucleus.js';
import { toast } from './lib/ui.js';
import { icon } from './lib/icons.js';
import { h } from './lib/dom.js';

const bridge = (() => {
  const take = window.__nucleusTakeBridge;
  if (typeof take === 'function') {
    const b = take();
    // 取走之后把入口删掉：之后加载的插件拿不到裸 IPC 通道，
    // 只能通过 nucleus.invoke 走主进程的权限校验（见 chrome-preload.js）
    try { delete window.__nucleusTakeBridge; } catch (_) { /* contextBridge 属性可能不可删 */ }
    return b;
  }
  return window.nucleusBridge;
})();

class LocalBus {
  constructor() { this.map = new Map(); }

  on(event, handler) {
    if (!this.map.has(event)) this.map.set(event, new Set());
    this.map.get(event).add(handler);
    return () => this.map.get(event)?.delete(handler);
  }

  emit(event, payload) {
    const set = this.map.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(payload); } catch (err) { console.error(`[bus] ${event}`, err); }
    }
  }
}

const app = {
  info: null,
  bridge,
  tabs: null,
  commands: null,
  sidebar: null,
  slots: null,
  newTabUrl: null,
  storeCache: {},
  plugins: new Map(),
};

/** 首帧主题：只影响浏览器自己的界面，不碰网页（网页跟随系统） */
function applyBaseTheme(settings) {
  const theme = settings['appearance.theme'] || 'auto';
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = theme === 'dark' || (theme === 'auto' && prefersDark);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/**
 * 宿主只保证「有一个根空位」。
 *
 * 区域（tabstrip / nav-center / sidebar …）的声明权已经交给界面插件
 * （见 ui.shell 的 declareRegions）。这里刻意什么都不声明 ——
 * 一旦核开始声明具体区域，「换一套界面」就必须改核，插件化就到此为止了。
 */
function installRootSlot() {
  // root 由 SlotRegistry 内置；这里只把 body 作为它的容器，
  // 让「根空位 → 界面插件」这条链在自省页里可见。
  if (!app.slots.defs.has('root')) return;
}

/**
 * 声明式工具栏贡献：manifest 里写了 contributes.toolbar 的插件，
 * 核会替它把按钮放进对应区域，点一下就是执行 command。
 * 需要复杂交互（状态图标、角标、弹层）的插件则自己 mount，不写这条声明。
 */
function renderToolbarContributions(pluginList) {
  const items = [];
  for (const p of pluginList) {
    for (const t of p.contributes?.toolbar || []) items.push({ ...t, pluginId: p.id });
  }
  items.sort((a, b) => (a.order || 100) - (b.order || 100));

  for (const t of items) {
    const slot = `region.${t.region}`;
    if (!app.slots.defs.has(slot)) continue;
    const key = `${t.pluginId}:${t.id}`;

    const btn = h('button', {
      class: 'navbtn',
      title: t.title || t.id,
      dataset: { contribution: key },
      html: icon(t.icon || 'puzzle', { size: 16 }),
    });
    btn.addEventListener('click', () => {
      if (!t.command) return;
      app.commands.execute(t.command).catch((err) => toast(err.message, { type: 'error' }));
    });

    // 核代注册：条目来源仍标注真实插件，便于自省页区分
    app.slots.register({
      name: slot,
      id: `toolbar:${key}`,
      pluginId: t.pluginId,
      order: t.order,
      render: () => btn,
    }, { id: 'core', permissions: [], contributes: {} });
  }
}

/** 插件自带样式：核负责注入并等它加载完，插件不必写样板代码 */
async function injectPluginStyles(plugin) {
  const files = plugin.styles || [];
  if (!files.length) return;
  await Promise.all(files.map((href) => new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `nucleus://${plugin.id}/${href}`;
    link.dataset.plugin = plugin.id;
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', () => {
      console.warn(`[nucleus] 插件样式加载失败：${plugin.id}/${href}`);
      resolve();
    }, { once: true });
    document.head.appendChild(link);
  })));
}

/**
 * 恢复通道：如果启动后发现一个界面插件都没启用，浏览器会变成一块无法操作的空白。
 * 这不是「核要画界面」，而是核必须保证自己还能被救回来 —— 相当于引导程序。
 * 只在零界面插件时出现，正常运行时连 DOM 都不会创建。
 */
async function ensureUsableShell() {
  // 判据是「关键区域有没有被插件认领」，不是「有没有界面插件加载」——
  // 书签、下载这些插件也带 ui 入口，但它们只往工具栏塞按钮，撑不起整个外壳。
  // 用槽位注册表判断：注册是同步写入的，不像 DOM 要等 rAF 才画出来。
  const filled = (name) => ((app.slots.entries.get(`region.${name}`) || []).length > 0);
  if (filled('tabstrip') || filled('nav-center')) return;

  let list = [];
  let audit = { ok: true, missing: [] };
  try {
    list = await bridge.invoke('nucleus:plugins:list', { pluginId: 'core' });
    audit = await bridge.invoke('nucleus:plugins:audit', { pluginId: 'core' });
  } catch (_) { /* 拿不到清单就只显示文字 */ }

  const missingIds = new Set((audit.missing || []).map((m) => m.id));
  const required = list.filter((p) => p.required && missingIds.has(p.id));

  // 只列出「被禁用、且声明了 ui 入口」的插件 —— 核不需要知道它们叫什么
  const candidates = list.filter((p) => !p.enabled && p.manifest && p.manifest.ui);
  const ordered = required
    .concat(candidates.filter((p) => !missingIds.has(p.id)));

  const bar = h('div', { class: 'shell-recovery' },
    h('div', { class: 'sr-title' }, required.length ? '缺少必需插件' : '没有启用任何界面插件'),
    h('div', { class: 'sr-desc' }, required.length
      ? `界面外壳 ${required.map((p) => `「${p.manifest.name || p.id}」`).join('、')} 未加载。它不是可选组件，缺了浏览器就无法导航：`
      : (ordered.length
        ? '标签栏和地址栏都由插件提供，现在它们全被禁用了。点一下即可恢复：'
        : '标签栏和地址栏都由插件提供。请到插件目录里启用一个带 ui 入口的插件。')),
    h('div', { class: 'sr-actions' }, ...ordered.map((p) => {
      const btn = h('button', { class: 'btn primary' }, `启用「${p.manifest.name || p.id}」`);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await bridge.invoke('nucleus:plugins:enable', { pluginId: 'core', target: p.id });
          await bridge.invoke('nucleus:ui:reload', { pluginId: 'core' });
        } catch (err) {
          btn.disabled = false;
          toast(err.message || '启用失败', { type: 'error' });
        }
      });
      return btn;
    }))
  );
  document.body.appendChild(bar);
}

async function loadPlugins(bus) {
  const list = await bridge.invoke('nucleus:plugins:ui', { pluginId: 'core' });

  // 先声明所有清单里的命令，这样命令面板能立刻看到条目
  for (const plugin of list) app.commands.declare(plugin, plugin.id);

  // 谁声明了 newTab 贡献点，新标签页就归谁 —— 核只转交 URL
  const newTabOwner = list.find((p) => p.contributes?.newTab?.url);
  app.newTabUrl = newTabOwner ? newTabOwner.contributes.newTab.url : null;
  app.tabs.setNewTabUrl(app.newTabUrl);

  const failed = [];
  for (const plugin of list) {
    let fiber = null;
    try {
      await injectPluginStyles(plugin);

      // 每个界面插件挂在 uiRoot 下面，拿到的 ctx 就是它自己的 fiber 上下文
      fiber = app.uiRoot.plugin({
        name: plugin.id,
        apply: async (cordisCtx) => {
          // 让每个插件拿到自己的设置快照
          let settingsData = {};
          try {
            settingsData = await bridge.invoke('nucleus:settings:all', { pluginId: plugin.id });
          } catch (_) { /* 无 settings 权限时为空 */ }

          const api = createPluginApi({ plugin, app, settingsData, bus, cordisCtx });
          const mod = await import(`nucleus://${plugin.id}/${plugin.ui}`);
          if (typeof mod.activate === 'function') await mod.activate(api);
          if (typeof mod.default === 'function') await mod.default(api);
          app.plugins.set(plugin.id, { plugin, api, mod, fiber: cordisCtx.fiber });
        },
      });

      // Cordis 会等 apply 里的 await 走完；失败会以拒绝的形式回到这里
      await fiber.await();
    } catch (err) {
      console.error(`[nucleus] 插件 ${plugin.id} 加载失败`, err);
      failed.push({ id: plugin.id, name: plugin.name, message: err.message });
      // 失败也必须回收：apply 可能已经声明了空位、注册了条目、挂了事件，
      // 这些都在 fiber 账本上，不 dispose 就会变成「插件已禁用但界面还留着」。
      try { await fiber.dispose(); } catch (_) { /* Cordis 已记录 */ }
    }
  }
  // 留给诊断入口读：加载失败的原因不该只存在于一闪而过的 toast 里
  app.lastLoadFailures = failed;
  return { loaded: app.plugins.size, failed };
}
async function boot() {
  app.info = await bridge.invoke('nucleus:app:info', { pluginId: 'core' });

  let allSettings = {};
  try {
    allSettings = await bridge.invoke('nucleus:settings:all', { pluginId: 'core' });
  } catch (_) { /* ignore */ }
  applyBaseTheme(allSettings);

  const bus = new LocalBus();
  app.bus = bus;

  app.slots = new SlotRegistry();
  installRootSlot();

  app.tabs = new TabsService({
    container: document.getElementById('webarea'),
    bridge,
    preloadUrl: app.info.webPreloadPath,
  });
  app.commands = new CommandRegistry({ bridge });
  app.sidebar = new SidebarManager();

  // 渲染层的 Cordis 根上下文：每个界面插件是一根 fiber，
  // 与主进程那棵树同构（两侧各自持有服务，靠 RPC 桥接）。
  app.uiRoot = new Context();
  for (const [name, value] of Object.entries({
    tabs: app.tabs, commands: app.commands, sidebar: app.sidebar,
    slots: app.slots, bridge, info: app.info,
  })) {
    app.uiRoot.provide(name);
    app.uiRoot.set(name, value);
  }

  // 核自己的命令：只负责窗口级动作，其余交给插件
  app.commands.register('core:reload-ui', {
    title: '重新加载浏览器界面',
    icon: 'rotate-cw',
    handler: () => bridge.invoke('nucleus:ui:reload', { pluginId: 'core' })
      .catch(() => { location.reload(); }),
  }, 'core');

  // 主进程推送的命令（来自快捷键）
  bridge.on('nucleus:run-command', async ({ id, via, combo }) => {
    try {
      if (!app.commands.has(id)) {
        toast(`命令未实现：${id}`, { type: 'error' });
        return;
      }
      await app.commands.execute(id, { via, combo });
    } catch (err) {
      console.error(`[nucleus] 命令 ${id} 执行失败`, err);
      bridge.send('nucleus:ui:command-failed', { id, message: err.message });
      toast(err.message || `命令 ${id} 执行失败`, { type: 'error' });
    }
  });

  bridge.on('nucleus:tab-crashed', ({ reason }) => {
    toast(`页面进程异常退出（${reason}）`, { type: 'error', timeout: 6000 });
  });

  bridge.on('nucleus:bus', (msg) => {
    if (msg) bus.emit(msg.event, msg.payload);
  });

  // 查找结果由主进程侧监听 guest webContents 后转发（见 main.js）
  bridge.on('nucleus:tab-found', (payload) => app.tabs.handleFound(payload));

  // 槽位的 when 条件通常依赖「当前标签」「设置」——这些变化统一触发重绘，
  // 由 rAF 批处理，同一帧内的多次变化只重绘一次。
  for (const evt of ['activated', 'updated', 'created', 'removed', 'error']) {
    app.tabs.on(evt, () => app.slots.invalidate());
  }
  bus.on('settings:changed', () => app.slots.invalidate());

  // 把槽位树推给主进程，自省页据此展示「界面是如何被组合出来的」
  let reportTimer = 0;
  const reportSlots = () => {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => {
      try {
        bridge.invoke('nucleus:slots:report', { pluginId: 'core', snapshot: app.slots.snapshot() })
          .catch(() => {});
      } catch (_) { /* 主进程未就绪 */ }
    }, 400);
  };
  app.reportSlots = reportSlots;
  for (const evt of ['activated', 'created', 'removed']) app.tabs.on(evt, reportSlots);
  setTimeout(reportSlots, 1200);

  // 健康检查的修复动作：清理来自未启用插件的槽位条目，然后重新上报
  bridge.on('nucleus:doctor:prune', (msg) => {
    const alive = new Set((msg && msg.alive) || []);
    const removed = app.slots.prune(alive);
    app.reportSlots && app.reportSlots();
    if (removed) toast(`已清理 ${removed} 个孤儿槽位条目`, { type: 'info', timeout: 4000 });
  });

  const result = await loadPlugins(bus);
  renderToolbarContributions(await bridge.invoke('nucleus:plugins:ui', { pluginId: 'core' }));
  await ensureUsableShell();

  // 兜底：没有任何插件负责新标签页时，核自己开一个，保证浏览器可用
  if (app.tabs.all.length === 0) {
    app.tabs.create({ url: app.tabs.blankUrl(), active: true });
  }
  app.tabs.syncAll();

  if (result.failed.length) {
    toast(`${result.failed.length} 个插件加载失败，按 Ctrl+Shift+L 查看日志`, { type: 'error', timeout: 8000 });
  }

  document.documentElement.dataset.ready = '1';
  // 调试入口只在显式开启时挂到 window 上：插件与它共享同一个 JS 世界，
  // 常驻的 app 引用等于把「别的插件的 api 对象」也一并交出去。
  if (bridge.devMode) window.__nucleusApp = app;
}

boot().catch((err) => {
  console.error('[nucleus] 启动失败', err);
  const box = document.createElement('div');
  box.style.cssText = "padding:40px;font:14px/1.8 'Segoe UI','Microsoft YaHei',sans-serif;color:#e8ebf1";
  const title = document.createElement('h2');
  title.style.cssText = 'color:#ff5f57;font-size:16px';
  title.textContent = '浏览器界面启动失败';
  const msg = document.createElement('p');
  msg.style.color = '#99a2b2';
  // 用 textContent 而不是拼 HTML：错误信息可能包含页面内容（比如脚本路径、URL）
  msg.textContent = String(err && err.message ? err.message : err);
  const hint = document.createElement('p');
  hint.style.cssText = 'color:#6b7484;font-size:12px';
  hint.textContent = '日志位于用户数据目录的 logs/main.log，可尝试删除 settings.json 后重启。';
  const retry = document.createElement('button');
  retry.textContent = '重试';
  retry.style.cssText = 'margin-top:12px;padding:6px 14px;background:#5b8cff;color:#fff;border:none;border-radius:6px;cursor:pointer';
  retry.addEventListener('click', () => location.reload());
  box.append(title, msg, hint, retry);
  document.body.replaceChildren(box);
});
