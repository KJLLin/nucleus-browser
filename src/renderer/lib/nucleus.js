/**
 * 插件 API 工厂（渲染层侧）。
 *
 * 插件拿到的 `nucleus` 对象由这里生成。它是插件与核之间的全部契约：
 * 没有全局变量泄漏，没有 require，只有一组受控方法。
 * 每个方法都会自动带上 pluginId，主进程据此做权限校验。
 */
import { icon, iconEl } from './icons.js';
import { h, esc } from './dom.js';
import * as ui from './ui.js';

export function createPluginApi({ plugin, app, settingsData = {}, bus, cordisCtx }) {
  const id = plugin.id;
  const withId = (payload) => Object.assign({}, payload, { pluginId: id });

  const invoke = (channel, payload) => app.bridge.invoke(channel, withId(payload));

  // 设置：内存缓存 + 主进程持久化，读操作同步返回
  const defaults = {};
  for (const section of plugin.contributes?.settings || []) {
    for (const item of section.items || []) defaults[item.key] = item.default;
  }
  const settingsCache = { ...defaults, ...settingsData };
  const settingsWatchers = new Set();

  const settings = {
    get(key, fallback) {
      return key in settingsCache ? settingsCache[key] : fallback;
    },
    set(key, value) {
      settingsCache[key] = value;
      settingsWatchers.forEach((fn) => {
        try { fn(value, key); } catch (err) { console.error(err); }
      });
      invoke('nucleus:settings:set', { key, value }).catch((err) => {
        console.error(`[${id}] 设置写入失败`, err);
      });
      return value;
    },
    all() {
      return { ...settingsCache };
    },
    onChange(handler) {
      settingsWatchers.add(handler);
      return () => settingsWatchers.delete(handler);
    },
  };

  /**
   * 窗口能力：与主进程侧重名，但这里只做「转发 + 事件订阅」。
   * 真正的 BrowserWindow 始终在宿主手里，插件拿不到窗口对象。
   */
  const windowApi = {
    minimize: () => invoke('nucleus:window:action', { action: 'minimize' }),
    toggleMaximize: () => invoke('nucleus:window:action', { action: 'maximize' }),
    close: () => invoke('nucleus:window:action', { action: 'close' }),
    toggleFullScreen: () => invoke('nucleus:window:action', { action: 'fullscreen' }),
    isMaximized: () => invoke('nucleus:window:state', {}).then((s) => !!(s && s.maximized)),
    /** evt: 'maximized' | 'closed' | 'focus' | 'blur' | 'enter-full-screen' | 'leave-full-screen' */
    on: (evt, handler) => {
      const event = String(evt).includes(':') ? String(evt) : `window:${evt}`;
      return track(`window.on:${event}`, bus.on(event, handler));
    },
  };

  const tabsApi = {
    list: () => app.tabs.all,
    get: (tabId) => app.tabs.all.find((t) => t.id === tabId) || null,
    active: () => app.tabs.active,
    create: (opts) => app.tabs.create(opts),
    close: (tabId) => app.tabs.close(tabId),
    activate: (tabId) => app.tabs.activate(tabId),
    navigate: (tabId, url) => app.tabs.navigate(tabId, url),
    reload: (tabId, hard) => app.tabs.reload(tabId, hard),
    stop: (tabId) => app.tabs.stop(tabId),
    goBack: (tabId) => app.tabs.goBack(tabId),
    goForward: (tabId) => app.tabs.goForward(tabId),
    setZoom: (tabId, f) => app.tabs.setZoom(tabId, f),
    toggleMute: (tabId) => app.tabs.toggleMute(tabId),
    duplicate: (tabId) => app.tabs.duplicate(tabId),
    closeOthers: (tabId) => app.tabs.closeOthers(tabId),
    closeToRight: (tabId) => app.tabs.closeToRight(tabId),
    execute: (tabId, code) => app.tabs.execute(tabId, code),
    insertCss: (tabId, css) => app.tabs.insertCss(tabId, css),
    find: (tabId, text, opts) => app.tabs.find(tabId, text, opts),
    stopFind: (tabId, action) => app.tabs.stopFind(tabId, action),
    capture: (tabId) => app.tabs.capture(tabId, id),
    webview: (tabId) => app.tabs.webview(tabId),
    /** 释放后台标签的渲染进程（保留标题/地址，激活时自动重建） */
    suspend: (tabId) => app.tabs.suspend(tabId),
    resume: (tabId) => app.tabs.resume(tabId),
    /** 批量休眠空闲标签，返回休眠了几个 */
    suspendIdle: (maxIdleMs, keep) => app.tabs.suspendIdle(maxIdleMs, keep),
    on: (evt, handler) => track(`tabs.on:${evt}`, app.tabs.on(evt, handler)),
    open: (url, opts = {}) => app.tabs.create({ url, active: opts.active !== false }),
  };

  /**
   * 插件的身份与静态契约。槽位注册时用它做权限判定：
   *   - 是不是这个空位的 owner
   *   - 有没有被 owner 的策略放行
   *   - manifest 的 contributes.slots 里有没有声明
   */
  const who = {
    id,
    permissions: plugin.permissions || plugin.manifest?.permissions || [],
    contributes: plugin.contributes || {},
  };

  const slots = app.slots;
  let mountSeq = 0;

  /**
   * 把一次注册记进 fiber 账本。
   *
   * 渲染层最容易漏的两处是「容器」和「事件监听」：
   * 容器如果只 append 不登记，插件卸载后空位还会继续往一个已脱离文档的元素里画；
   * 监听如果不登记，插件禁用后回调仍会被触发（回调里再去碰已卸载的 DOM）。
   * 所以凡是从 ctx 拿到的 disposer，一律走这里记账。
   */
  const track = (label, disposer) => (
    typeof disposer === 'function' ? cordisCtx.effect(() => disposer, label) : disposer
  );

  const slotsApi = {
    /**
     * 声明一个空位。只能在自己的渲染位置下声明 —— 子空位的 parent 必须是自己的。
     * 折叠是递归的：这个空位消失时，它下面的注册与子空位一起撤销。
     */
    declare(spec) {
      return cordisCtx.effect(
        () => slots.declare(spec, who),
        `slots.declare:${spec.name}`
      );
    },

    /**
     * 往空位里注册条目。返回 disposer，同时也记在 fiber 上 ——
     * 插件卸载时自动撤销，不需要手动保存。
     */
    register(entry) {
      return cordisCtx.effect(
        () => slots.register(entry, who),
        `slots.register:${entry.name}:${entry.id || '*'}:${++mountSeq}`
      );
    },

    /**
     * 等空位出现再注册。owner 还没加载、或暂时被禁用都不会丢：
     * 声明出现时执行，声明折叠时撤销，重新声明时再执行一次。
     */
    inject(name, callback) {
      return cordisCtx.effect(
        () => slots.inject(name, callback, who),
        `slots.inject:${name}:${++mountSeq}`
      );
    },

    /** 创建容器：owner 把它放进自己的 DOM，注册表负责填内容 */
    outlet(name, props) {
      const el = slots.outlet(name, props);
      track(`slots.outlet:${name}`, () => slots.removeOutlet(el));
      return el;
    },

    /** 认领既有元素（不加 wrapper，适合靠直接子元素写样式的容器） */
    adopt(name, element, props) {
      const el = slots.adopt(name, element, props, true);
      track(`slots.adopt:${name}`, () => slots.removeOutlet(el));
      return el;
    },

    /** 更新容器的 owner 数据（例如当前标签变了），并重绘 */
    updateOutlet(element, props) {
      slots.updateOutlet(element, props);
    },

    invalidate(name) {
      slots.invalidate(name);
    },

    /** 当前槽位树（供自省页 / 调试） */
    tree() {
      return slots.snapshot();
    },
  };

  const regions = {
    el(name) {
      return document.querySelector(`[data-region="${name}"]`);
    },
    /**
     * 兼容层：把节点挂到区域里。
     * 内部走的是槽位注册，所以顺序由 order 决定，与插件加载顺序无关。
     * 新代码建议直接用 nucleus.slots.register()。
     *
     * 区域可能还没被界面插件声明（比如 bookmarks 比 ui.shell 先加载），
     * 这种情况不能直接抛错，而是等区域出现后再注册 —— 这正是 slots.inject 的用途。
     */
    mount(name, node, opts = {}) {
      const slot = `region.${name}`;
      const entry = {
        id: opts.id || `${id}:mount:${++mountSeq}`,
        order: Number.isFinite(opts.order) ? opts.order : 100,
        priority: opts.priority,
        when: opts.when,
        render: () => node,
      };

      if (slots && slots.defs.has(slot)) {
        slotsApi.register({ ...entry, name: slot });
        return node;
      }

      slotsApi.inject(slot, ({ register }) => register(entry));
      return node;
    },
    clear(name) {
      const target = this.el(name);
      if (target) target.innerHTML = '';
    },
    /** 注册区域尺寸变化（用于自适应布局） */
    onResize(handler) {
      const ro = new ResizeObserver(() => handler());
      for (const el of document.querySelectorAll('[data-region]')) ro.observe(el);
      return track('regions.onResize', () => ro.disconnect());
    },
  };

  const api = {
    id,
    name: plugin.name,
    version: plugin.manifest?.version || '1.0.0',
    contributes: plugin.contributes || {},

    /** 与主进程侧同构的日志入口：前缀统一，方便在控制台按插件过滤 */
    log: {
      info: (...args) => console.log(`[${id}]`, ...args),
      warn: (...args) => console.warn(`[${id}]`, ...args),
      error: (...args) => console.error(`[${id}]`, ...args),
    },

    /** 应用信息与环境 */
    env: {
      chrome: app.info.chrome,
      cordis: app.info.cordis,
      electron: app.info.electron,
      appVersion: app.info.appVersion,
      platform: app.info.platform,
      isWin7: app.info.isWin7,
      userData: app.info.userData,
      /** 当前提供新标签页的插件给出的地址（没有插件提供时为 null） */
      newTabUrl: app.newTabUrl,
    },

    invoke,
    settings,
    tabs: tabsApi,
    window: windowApi,
    regions,
    slots: slotsApi,

    /**
     * 可逆副作用：与主进程侧同一个语义，由该插件专属的 Cordis fiber 记账。
     * 界面插件现在只会随窗口重载而卸载，但账本已经就位 ——
     * 将来做「运行中禁用界面插件」不需要再改插件。
     */
    effect: (fn, label) => cordisCtx.effect(fn, label),

    /** Cordis 的进程内事件系统（与跨进程的 bus 互补） */
    on: (...args) => cordisCtx.on(...args),
    once: (...args) => cordisCtx.once(...args),
    emit: (...args) => cordisCtx.emit(...args),

    /** Cordis 依赖注入：服务就绪时执行，离开时自动撤销 */
    inject: (deps, callback) => cordisCtx.inject(deps, callback),


    storage: (() => {
      let cache = null;
      return {
        /** 必须先 await load()，之后再同步读 */
        async load() {
          if (!cache) {
            try { cache = await invoke('nucleus:storage:all', {}); } catch (_) { cache = {}; }
          }
          return cache;
        },
        get(key, fallback) {
          if (!cache || !(key in cache)) return fallback;
          return cache[key];
        },
        set(key, value) {
          cache = Object.assign({}, cache, { [key]: value });
          invoke('nucleus:storage:set', { key, value }).catch(() => {});
          return value;
        },
        all() { return { ...(cache || {}) }; },
      };
    })(),

    /** 侧边栏：核只提供容器，内容与归属都由插件决定 */
    sidebar: app.sidebar,

    commands: {
      register: (cmdId, spec) => track(`command:${cmdId}`, app.commands.register(cmdId, spec, id)),
      execute: (cmdId, ...args) => app.commands.execute(cmdId, ...args),
      list: () => app.commands.list(),
    },

    bus: {
      on: (event, handler) => track(`bus.on:${event}`, bus.on(event, handler)),
      emit: (event, payload) => {
        bus.emit(event, payload, id);
        invoke('nucleus:bus:emit', { event, payload }).catch(() => {});
      },
    },

    ui: {
      toast: ui.toast,
      modal: ui.modal,
      confirm: ui.confirm,
      prompt: ui.promptText,
      menu: ui.menu,
      palette: ui.palette,
    },

    theme: {
      setVar(name, value) {
        document.documentElement.style.setProperty(name, value);
      },
      getVar(name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      },
      setVars(vars) {
        for (const [k, v] of Object.entries(vars || {})) {
          document.documentElement.style.setProperty(k, v);
        }
      },
    },

    icons: { icon, iconEl },
    dom: { h, esc },
  };

  // 与主进程同构：nucleus 就是该插件自己的 Cordis 上下文，
  // 上面挂的是核提供的能力；这里没有权限层（权限在主进程那侧校验）。
  //
  // 需要挡掉的是「代理层自己引入的坑」：
  //   then     —— 否则 await nucleus 会把插件挂在一个永不 resolve 的 thenable 上
  //   constructor / __proto__ —— 否则能顺着原型链摸到 Function 构造器
  const BLOCKED = new Set(['then', 'catch', 'finally', 'toJSON', 'constructor', '__proto__', 'prototype']);

  return new Proxy(api, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') {
        return prop === Symbol.toStringTag ? 'NucleusPluginApi' : undefined;
      }
      if (BLOCKED.has(prop)) return undefined;
      if (prop in target) return Reflect.get(target, prop, receiver);
      // 兜底到 Cordis 上下文。Cordis 的部分属性（例如未 inject 的服务）
      // 会在 getter 里直接抛错 —— 那不应该让整个插件挂掉，按「不存在」处理。
      try {
        return Reflect.get(cordisCtx, prop, cordisCtx);
      } catch (err) {
        console.warn(`[${id}] 访问 nucleus.${String(prop)} 失败：${err.message}`);
        return undefined;
      }
    },
    has(target, prop) {
      if (typeof prop === 'symbol' || BLOCKED.has(prop)) return false;
      return prop in target || Reflect.has(cordisCtx, prop);
    },
    set() { return true; },
    defineProperty() { return false; },
    deleteProperty() { return false; },
  });
}
