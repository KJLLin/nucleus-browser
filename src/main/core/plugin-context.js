'use strict';
/**
 * 插件上下文（ctx）工厂。
 *
 * ctx 是插件能触达核的唯一通道：每个能力都先过权限网关，权限来自 manifest 声明。
 * 这样「一切皆插件」不会退化成「一切皆后门」。
 */
const path = require('path');
const { dialog, shell: electronShell } = require('electron');
const { JsonStore } = require('./store');
const { userDataFile } = require('./paths');

function permissionError(pluginId, perm) {
  const err = new Error(`插件 ${pluginId} 未声明权限 "perm:${perm}"，操作被拒绝`);
  err.code = 'EPERM_PLUGIN';
  return err;
}

/**
 * 不透传的属性。
 *
 * `then` 最要紧：ctx 是 Proxy，如果 get('then') 落到 Cordis 上下文并返回函数，
 * 那么任何 `await ctx` / `Promise.resolve(ctx)` 都会把插件卡死在 thenable 上 ——
 * 表现为「插件无声无息地不再继续」。这类问题极难定位，所以在门口就挡掉。
 * 其余是原型链后门：constructor / __proto__ 能一路摸到 Function 构造器。
 */
const BLOCKED_PROPS = new Set([
  'then', 'catch', 'finally', 'toJSON', 'inspect', 'constructor',
  '__proto__', 'prototype', 'valueOf', 'toString', 'apply', 'call', 'bind',
]);

/** 核自己提供的服务名：插件不能用同名服务覆盖（服务投毒会波及全部插件） */
const RESERVED_SERVICES = new Set([
  'bus', 'settings', 'state', 'windows', 'tabs', 'commands', 'downloads',
  'notifications', 'session', 'shell', 'intercept', 'protocol', 'appInfo',
  'plugins', 'shortcuts', 'root',
]);

/**
 * @param {object} opts
 * @param {object} opts.manifest 已校验的清单
 * @param {string} opts.dir 插件目录
 * @param {object} opts.services 核服务集合
 * @param {object} opts.cordisCtx 该插件专属的 Cordis 上下文（生命周期与副作用归它管）
 */
function createContext({ manifest, dir, services, cordisCtx }) {
  const { bus, settings, tabs, windows, intercept, protocol, downloads, notifications, shell, appInfo } = services;
  const perms = new Set(manifest.permissions);
  const tag = `plugin:${manifest.id}`;

  // 副作用记账交给 Cordis：插件挂载时拿到的是一个 fiber 专属上下文，
  // ctx.effect 注册的逆操作在 fiber 卸载时由 Cordis 逆序回收。
  if (!cordisCtx) throw new Error('createContext 需要 Cordis 上下文');
  /** 把某个底层注册的 disposer 记进 fiber；非函数原样返回 */
  const track = (label, disposer) => (
    typeof disposer === 'function' ? cordisCtx.effect(() => disposer, label) : disposer
  );

  const require_ = (perm) => {
    if (!perms.has(perm)) throw permissionError(manifest.id, perm);
  };

  const has = (perm) => perms.has(perm);

  const log = (level) => (...args) => {
    const prefix = `[${manifest.id}]`;
    // eslint-disable-next-line no-console
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](prefix, ...args);
  };

  // 插件私有存储：每个插件独立文件，互不可见
  const storageFile = path.join(userDataFile('plugin-data'), `${manifest.id}.json`);
  const store = new JsonStore(storageFile, {});

  // 设置项默认值来自 manifest 的 contributes.settings
  const defaults = {};
  for (const section of manifest.contributes.settings) {
    for (const item of section.items) defaults[item.key] = item.default;
  }

  const settingsApi = {
    get(key, fallback) {
      require_('settings');
      const v = settings.get(`plugin:${manifest.id}:${key}`);
      if (v !== undefined) return v;
      return defaults[key] !== undefined ? defaults[key] : fallback;
    },
    set(key, value) {
      require_('settings');
      settings.set(`plugin:${manifest.id}:${key}`, value);
      bus.emit(`${tag}:setting-changed`, { key, value });
      return value;
    },
    all() {
      require_('settings');
      const out = Object.assign({}, defaults);
      for (const [k, v] of Object.entries(settings.get() || {})) {
        const p = `plugin:${manifest.id}:`;
        if (k.startsWith(p)) out[k.slice(p.length)] = v;
      }
      return out;
    },
    onChange(key, handler) {
      return track(`settings.onChange:${key || '*'}`, bus.on(`${tag}:setting-changed`, ({ key: k, value }) => {
        if (!key || k === key) handler(value, k);
      }));
    },
  };

  const api = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    dir,
    builtin: manifest.builtin,
    permissions: Array.from(perms),
    has,
    appInfo,

    log: {
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
    },

    /**
     * 可逆副作用（借自 Cordis 的核心语义）。
     *
     *   ctx.effect(() => {
     *     const timer = setInterval(tick, 1000);
     *     return () => clearInterval(timer);   // 逆操作
     *   }, 'stats ticker');
     *
     * fn 立即执行，返回的清理函数在插件卸载时逆序调用。
     * 用得越多，「禁用再启用」之后残留的东西就越少。
     */
    effect(fn, label) {
      return cordisCtx.effect(fn, label);
    },

    /** Cordis 自己的事件系统（进程内），与跨进程的 ctx.bus 互补 */
    on: (...args) => cordisCtx.on(...args),
    once: (...args) => cordisCtx.once(...args),
    emit: (...args) => cordisCtx.emit(...args),

    /**
     * Cordis 的依赖注入：服务就绪时执行，服务离开时自动撤销并重新等待。
     *   ctx.inject(['adblock'], (sctx) => { sctx.adblock.stats() });
     * 这样插件不必猜「对方加载了没有」，也不依赖加载顺序。
     */
    inject: (deps, callback) => cordisCtx.inject(deps, callback),

    /** 当前 fiber 的诊断信息（只读） */
    get fiberState() {
      const f = cordisCtx.fiber;
      return { state: f ? f.state : 'none', effects: f ? f.getEffects().length : 0 };
    },

    /** 插件私有存储（需 storage 权限） */
    storage: {
      get(key, fallback) {
        require_('storage');
        return store.get(key, fallback);
      },
      set(key, value) {
        require_('storage');
        store.set(key, value);
        return value;
      },
      delete(key) {
        require_('storage');
        store.delete(key);
      },
      all() {
        require_('storage');
        return store.get();
      },
    },

    settings: settingsApi,

    /** 跨插件事件：约定事件名以 "<发布者id>/" 开头，避免撞车 */
    bus: {
      on(event, handler) {
        require_('storage'); // 总线属于基础能力，借用 storage 权限校验
        const wrapped = (...args) => handler(...args);
        wrapped.__owner = tag;
        return track(`bus.on:${event}`, bus.on(event, wrapped));
      },
      once(event, handler) {
        require_('storage');
        const wrapped = (...args) => handler(...args);
        wrapped.__owner = tag;
        return track(`bus.once:${event}`, bus.once(event, wrapped));
      },
      emit(event, payload) {
        require_('storage');
        bus.emit(event, payload);
      },
    },

    /** 标签页（需 tabs 权限）：主进程侧只操作镜像 + 下指令 */
    tabs: {
      list: () => (require_('tabs'), tabs.list()),
      get: (id) => (require_('tabs'), tabs.get(id)),
      active: () => (require_('tabs'), tabs.active()),
      create: (opts) => (require_('tabs'), tabs.create(opts)),
      close: (id) => (require_('tabs'), tabs.close(id)),
      activate: (id) => (require_('tabs'), tabs.activate(id)),
      navigate: (id, url) => (require_('tabs'), tabs.navigate(id, url)),
      reload: (id) => (require_('tabs'), tabs.reload(id)),
      stop: (id) => (require_('tabs'), tabs.stop(id)),
      goBack: (id) => (require_('tabs'), tabs.goBack(id)),
      goForward: (id) => (require_('tabs'), tabs.goForward(id)),
      setZoom: (id, factor) => (require_('tabs'), tabs.setZoom(id, factor)),
      on: (evt, handler) => {
        require_('tabs');
        const wrapped = (...args) => handler(...args);
        wrapped.__owner = tag;
        return track(`tabs.on:${evt}`, tabs.on(evt, wrapped));
      },
    },

    /** 窗口（需 window 权限） */
    window: {
      get id() {
        return windows.mainId;
      },
      minimize: () => (require_('window'), windows.minimize()),
      maximize: () => (require_('window'), windows.toggleMaximize()),
      close: () => (require_('window'), windows.close()),
      setTitle: (t) => (require_('window'), windows.setTitle(t)),
      isMaximized: () => (require_('window'), windows.isMaximized()),
      on: (evt, handler) => {
        require_('window');
        const wrapped = (...args) => handler(...args);
        wrapped.__owner = tag;
        return track(`window.on:${evt}`, windows.on(evt, wrapped));
      },
    },

    /** 命令：主进程侧实现的后台命令 */
    commands: {
      register(id, handler) {
        require_('commands');
        return track(`command:${id}`, services.commands.register(id, handler, manifest.id));
      },
      execute(id, ...args) {
        require_('commands');
        return services.commands.execute(id, ...args);
      },
    },

    /** 网络拦截（需 network 权限）：多插件共享一条 webRequest 通道 */
    network: {
      onBeforeRequest(handler) {
        require_('network');
        return track('network.onBeforeRequest', intercept.onBeforeRequest(manifest.id, handler));
      },
      onHeadersReceived(handler) {
        require_('network');
        return track('network.onHeadersReceived', intercept.onHeadersReceived(manifest.id, handler));
      },
    },

    /** 会话（需 session 权限）：代理、UA、缓存 */
    session: {
      setProxy(config) {
        require_('session');
        return services.session.setProxy(config);
      },
      getUserAgent() {
        require_('session');
        return services.session.getUserAgent();
      },
      setUserAgent(ua) {
        require_('session');
        return services.session.setUserAgent(ua);
      },
      clearCache() {
        require_('session');
        return services.session.clearCache();
      },
      clearStorage() {
        require_('session');
        return services.session.clearStorage();
      },
    },

    /** 自定义协议（需 protocol 权限） */
    protocol: {
      register(scheme, handler) {
        require_('protocol');
        return track(`protocol:${scheme}`, protocol.register(scheme, handler, manifest.id));
      },
    },

    /** 下载事件（需 downloads 权限） */
    downloads: {
      on(handler) {
        require_('downloads');
        return track('downloads.on', downloads.on(handler, manifest.id));
      },
      list() {
        require_('downloads');
        return downloads.list();
      },
    },

    notifications: {
      show(title, body) {
        require_('notifications');
        return notifications.show(title, body);
      },
    },

    shell: {
      openExternal(url) {
        require_('shell');
        return shell.openExternal(url);
      },
      showItemInFolder(p) {
        require_('shell');
        return shell.showItemInFolder(p);
      },
    },

    /** 插件管理（需 plugins 权限）：只有设置页这类「元插件」应当声明它 */
    plugins: {
      list: () => (require_('plugins'), services.plugins.list()),
      get: (pid) => (require_('plugins'), services.plugins.publicView(services.plugins.get(pid))),
      enable: (pid) => (require_('plugins'), services.plugins.enable(pid)),
      disable: (pid) => (require_('plugins'), services.plugins.disable(pid)),
      uninstall: (pid) => (require_('plugins'), services.plugins.uninstall(pid)),
      installFromDir: (dir) => (require_('plugins'), services.plugins.installFromDir(dir)),
      reload: () => (require_('plugins'), services.plugins.reload()),
      getSettings: (pid) => {
        require_('plugins');
        const out = {};
        const prefix = `plugin:${pid}:`;
        for (const [k, v] of Object.entries(services.settings.get() || {})) {
          if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
        }
        return out;
      },
      setSetting: (pid, key, value) => {
        require_('plugins');
        services.settings.set(`plugin:${pid}:${key}`, value);
        services.bus.emit('settings:changed', { key: `plugin:${pid}:${key}`, value });
        return true;
      },
      /**
       * 运行时快照：插件树、服务、槽位、事件、RPC 契约、配置层叠。
       * 只读，且需要 plugins 权限 —— 自省页是唯一应该调用它的地方。
       */
      inspect: () => {
        require_('plugins');
        const runtimeState = require('./runtime-state');
        const rpc = require('./rpc');
        const mem = process.memoryUsage();
        const list = services.plugins.list();
        return {
          app: {
            // npm_package_version 只在 npm scripts 里存在，打包后是空字符串 —— 直接用 app.getVersion()
            version: require('electron').app.getVersion(),
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            node: process.versions.node,
            cordis: '4.0.0-rc.12',
            platform: process.platform,
            arch: process.arch,
            uptimeSec: Math.round(process.uptime()),
            memoryMB: {
              rss: Math.round(mem.rss / 1048576),
              heap: Math.round(mem.heapUsed / 1048576),
            },
            userData: require('electron').app.getPath('userData'),
          },
          plugins: list.map((p) => {
            const m = p.manifest || {};
            const c = m.contributes || {};
            return {
              id: p.id,
              name: m.name || p.id,
              version: m.version || '',
              status: p.status,
              enabled: p.enabled,
              builtin: !!p.builtin,
              error: p.error || null,
              effects: p.effects || 0,
              permissions: m.permissions || [],
              slots: c.slots || [],
              commands: (c.commands || []).length,
              hasMain: !!m.main,
              hasUi: !!m.ui,
              dir: p.dir || null,
            };
          }),
          services: Object.keys(services)
            .filter((k) => k !== 'root' && typeof services[k] !== 'function')
            .map((name) => ({ name, source: 'kernel' })),
          slots: runtimeState.runtime.slots,
          events: {
            recent: runtimeState.recentEvents(60),
            stats: runtimeState.eventStats(),
          },
          rpc: rpc.describe(),
          config: runtimeState.runtime.config,
          profile: runtimeState.runtime.profile,
        };
      },

      globalSettings: () => (require_('plugins'), services.settings.get()),
      setGlobal: (key, value) => {
        require_('plugins');
        services.settings.set(key, value);
        services.bus.emit('settings:changed', { key, value });
        return true;
      },

      /** 内核健康检查：不变量 + 一键回收（见 core/doctor.js） */
      health: () => {
        require_('plugins');
        if (!services.doctor) throw new Error('健康检查器未就绪');
        return services.doctor.run();
      },
      repair: () => {
        require_('plugins');
        if (!services.doctor) throw new Error('健康检查器未就绪');
        return services.doctor.repair();
      },
    },

    /** 浏览器扩展（需 plugins 权限）：安装、启停、查看能力 */
    extensions: {
      list: () => (require_('plugins'), services.extensions.list()),
      enable: (id) => (require_('plugins'), services.extensions.enable(id)),
      disable: (id) => (require_('plugins'), services.extensions.disable(id)),
      uninstall: (id) => (require_('plugins'), services.extensions.uninstall(id)),
      reload: () => (require_('plugins'), (services.extensions.scan(), services.extensions.list())),
      installFromDir: (dir) => (require_('plugins'), services.extensions.installFromDir(dir)),
    },

    /**
     * 内部页面 RPC：插件自己的 nucleus://<id>/... 页面可以调用这里注册的方法。
     * 这让插件页面（如设置页）不必把逻辑塞进浏览器外壳。
     */
    pages: {
      handle(method, fn) {
        let map = services.plugins.pageHandlers.get(manifest.id);
        if (!map) {
          map = new Map();
          services.plugins.pageHandlers.set(manifest.id, map);
        }
        map.set(String(method), fn);
        return track(`page:${method}`, () => map.delete(String(method)));
      },
      send(event, payload) {
        return services.windows.sendToPages(manifest.id, event, payload);
      },
    },

    /** 系统对话框（需 dialog 权限） */
    dialog: {
      async pickDirectory(title) {
        require_('dialog');
        const win = services.windows.win;
        const res = await dialog.showOpenDialog(win, {
          title: title || '选择文件夹',
          properties: ['openDirectory'],
        });
        return res.canceled ? null : res.filePaths[0];
      },
      async pickFile(title, filters) {
        require_('dialog');
        const win = services.windows.win;
        const res = await dialog.showOpenDialog(win, {
          title: title || '选择文件',
          properties: ['openFile'],
          filters: filters || [],
        });
        return res.canceled ? null : res.filePaths[0];
      },
      async saveFile(title, defaultPath) {
        require_('dialog');
        const win = services.windows.win;
        const res = await dialog.showSaveDialog(win, { title: title || '保存文件', defaultPath });
        return res.canceled ? null : res.filePath;
      },
    },

    /** 供插件解析自己目录内的资源 */
    file(rel) {
      return path.join(dir, rel);
    },
  };

  /**
   * 能力名 -> 所需权限。访问这些属性时先过闸门，再交给下面的对象。
   * 没列进来的属性（effect / on / inject / fiber ...）直接落到 Cordis 上下文。
   */
  const GATED = {
    tabs: 'tabs',
    window: 'window',
    network: 'network',
    session: 'session',
    protocol: 'protocol',
    downloads: 'downloads',
    notifications: 'notifications',
    shell: 'shell',
    commands: 'commands',
    settings: 'settings',
    storage: 'storage',
    plugins: 'plugins',
    dialog: 'dialog',
    bus: 'storage',
  };

  /**
   * 插件拿到的 ctx 就是它自己的 Cordis 上下文，只是前面加了一道权限闸：
   *   ctx.tabs    → 先查 manifest.permissions，再返回能力
   *   ctx.effect  → 直达 Cordis fiber
   *   ctx.fiber   → 直达 Cordis fiber 对象
   * 换句话说，权限是唯一多出来的一层，其余没有中间商。
   */
  const gate = (cctx) => new Proxy(api, {
    get(target, prop, receiver) {
      // thenable 与原型链后门：一律当作不存在
      if (typeof prop === 'symbol') {
        return prop === Symbol.toStringTag ? 'PluginContext' : undefined;
      }
      if (BLOCKED_PROPS.has(prop)) return undefined;

      if (prop in target) {
        const perm = GATED[prop];
        if (perm) require_(perm);
        return Reflect.get(target, prop, receiver);
      }

      // 服务命名空间防投毒：插件可以注册自己的服务，但不能顶掉核的
      if (prop === 'provide' || prop === 'set') {
        return (name, ...rest) => {
          if (RESERVED_SERVICES.has(name)) {
            throw permissionError(manifest.id, `service:${name}`);
          }
          return cctx[prop](name, ...rest);
        };
      }

      // 子插件：仍由 Cordis 管理，但 apply 收到的子上下文同样过闸门，
      // 否则「插件里再 plugin()」就是一条绕过权限的近路。
      if (prop === 'plugin') {
        return (spec, config) => {
          let normalized = spec;
          if (typeof spec === 'function') normalized = { apply: spec };
          if (normalized && typeof normalized.apply === 'function') {
            const orig = normalized.apply;
            normalized = {
              ...normalized,
              apply: (childCtx, cfg) => orig(gate(childCtx), cfg),
            };
          }
          return cctx.plugin(normalized, config);
        };
      }

      // 兜底到 Cordis 上下文：未 inject 的服务在 getter 里会直接抛错，
      // 按「不存在」处理，避免插件因为读一个属性就整体失败
      try {
        return Reflect.get(cctx, prop, cctx);
      } catch (err) {
        return undefined;
      }
    },
    has(target, prop) {
      if (typeof prop === 'symbol' || BLOCKED_PROPS.has(prop)) return false;
      return prop in target || Reflect.has(cctx, prop);
    },
    set() { return true; },
    defineProperty() { return false; },
    deleteProperty() { return false; },
  });

  const ctx = gate(cordisCtx);

  return { ctx, store };
}

module.exports = { createContext };
