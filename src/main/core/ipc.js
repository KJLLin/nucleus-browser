'use strict';
/**
 * IPC 路由。
 * 渲染层（浏览器 UI 与插件 UI）对核的所有请求都在这里落地，
 * 每个请求都带上 pluginId，核据此校验该插件是否已启用、是否声明了对应权限。
 *
 * 说明（诚实标注）：这是「防误用」级别的隔离 —— 它保证插件不会调用自己没声明的能力，
 * 但不构成对恶意代码的强沙箱。插件本质上仍是以你的身份运行的本地代码，请只安装可信插件。
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ipcMain, app, dialog, shell, clipboard, webContents } = require('electron');
const rpc = require('./rpc');
const { runtime } = require('./runtime-state');

const CORE_OWNER = 'core';

function installIpc(ctx) {
  const { plugins, tabs, windows, settings, bus, commands, downloads, session, notifications, protocol, intercept, state, extensions, doctor } = ctx;

  const resolve = (pluginId) => {
    if (pluginId === CORE_OWNER) return { core: true, perms: null };
    const rec = plugins.get(pluginId);
    if (!rec || !rec.enabled) return null;
    return { core: false, perms: new Set(rec.manifest.permissions), rec };
  };

  const need = (pluginId, perm) => {
    const owner = resolve(pluginId);
    if (!owner) throw new Error(`插件 ${pluginId} 未启用，请求被拒绝`);
    if (!owner.core && perm && !owner.perms.has(perm)) {
      throw new Error(`插件 ${pluginId} 未声明权限 "${perm}"，请求被拒绝`);
    }
    return owner;
  };

  /**
   * 注册一条通道。参数与返回值按 channels.js 的契约校验，
   * 调用次数与失败原因记进 rpc 的指标里，自省页直接读。
   */
  const handle = (channel, fn) => {
    const wrapped = rpc.wrap(channel, fn);
    ipcMain.handle(channel, async (event, payload) => {
      // 只接受来自核窗口的请求
      if (!windows.win || event.sender !== windows.win.webContents) {
        throw new Error('非法请求来源');
      }
      return wrapped(payload || {}, event);
    });
  };

  // ---------- 应用信息 ----------

  handle('nucleus:app:info', () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osVersion: typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '',
    isWin7: process.platform === 'win32' && /^6\.1/.test(
      (typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '') || ''
    ),
    userData: app.getPath('userData'),
    // <webview> 的 preload 属性只接受 file: 协议，必须是 URL 而不是路径
    webPreloadPath: pathToFileURL(path.join(__dirname, '..', 'preload', 'web-preload.js')).toString(),
    startupAt: Date.now(),
  }));

  /**
   * 重新加载浏览器界面。
   *
   * 刻意由主进程执行 webContents.reload()，而不是渲染层 location.reload()：
   * 自定义协议页面在自己的脚本里调用 location.reload() 时会被 blink 拒绝，
   * 表现为「点了没反应」。主进程这一侧没有这个限制。
   */
  handle('nucleus:ui:reload', ({ pluginId }) => {
    need(pluginId, null);
    setTimeout(() => {
      try { windows.win.webContents.reload(); } catch (_) { /* 窗口已关 */ }
    }, 60);
    return true;
  });

  handle('nucleus:app:quit', () => {
    app.quit();
    return true;
  });

  // ---------- 浏览器扩展 ----------

  handle('nucleus:ext:list', ({ pluginId }) => {
    need(pluginId, 'plugins');
    return extensions.list();
  });

  handle('nucleus:ext:enable', ({ pluginId, target }) => {
    need(pluginId, 'plugins');
    return extensions.enable(target);
  });

  handle('nucleus:ext:disable', ({ pluginId, target }) => {
    need(pluginId, 'plugins');
    return extensions.disable(target);
  });

  handle('nucleus:ext:uninstall', ({ pluginId, target }) => {
    need(pluginId, 'plugins');
    return extensions.uninstall(target);
  });

  handle('nucleus:ext:reload', ({ pluginId }) => {
    need(pluginId, 'plugins');
    extensions.scan();
    return extensions.list();
  });

  handle('nucleus:ext:install-dialog', async ({ pluginId }) => {
    need(pluginId, 'plugins');
    const res = await dialog.showOpenDialog(windows.win, {
      title: '选择扩展文件夹（内含 manifest.json）',
      properties: ['openDirectory'],
      buttonLabel: '安装扩展',
    });
    if (res.canceled || !res.filePaths.length) return null;
    return extensions.installFromDir(res.filePaths[0]);
  });

  // 内容脚本与扩展页面共用这一条：身份由 token 或 sender 决定，
  // 因此不能用 handle()（它只接受主窗口发来的请求）。
  ipcMain.handle('nucleus:ext:bridge', async (event, payload = {}) => {
    try {
      // 扩展页面可能在 did-finish-load 之前就调 API（popup.js 一解析就跑），
      // 所以这里按 URL 惰性补登记，而不是只依赖加载完成事件。
      if (!extensions.contextOf(event.sender.id)) {
        let url = '';
        try { url = event.sender.getURL(); } catch (_) { url = ''; }
        const m = url.match(/^nucleus:\/\/ext-([^/]+)\//);
        if (m) extensions.registerContext(m[1], event.sender, 'page');
      }
      return await extensions.bridge({ ...payload, wcId: event.sender.id });
    } catch (err) {
      throw new Error(err && err.message ? err.message : String(err));
    }
  });

  ipcMain.on('nucleus:ext:onmessage-reply', (_event, payload = {}) => {
    extensions.resolveMessageReply(payload.msgId, payload.value);
  });

  ipcMain.on('nucleus:ext:manifest-sync', (event, extId) => {
    const rec = extensions.get(extId);
    event.returnValue = rec ? {
      manifest_version: rec.manifestVersion,
      name: rec.name,
      version: rec.version,
      description: rec.description,
    } : null;
  });

  // ---------- 界面槽位（渲染层 → 主进程，供自省页） ----------

  handle('nucleus:slots:report', ({ snapshot }) => {
    runtime.slots = snapshot;
    return true;
  });

  // ---------- 插件 ----------

  handle('nucleus:plugins:list', () => plugins.list());

  handle('nucleus:plugins:ui', () => plugins.uiPlugins());

  handle('nucleus:plugins:enable', async ({ pluginId, target }) => {
    need(pluginId, 'plugins');
    return plugins.enable(target);
  });

  handle('nucleus:plugins:disable', async ({ pluginId, target }) => {
    need(pluginId, 'plugins');
    return plugins.disable(target);
  });

  handle('nucleus:plugins:uninstall', async ({ pluginId, target }) => {
    need(pluginId, 'plugins');
    return plugins.uninstall(target);
  });

  handle('nucleus:plugins:install-dialog', async ({ pluginId }) => {
    need(pluginId, 'plugins');
    const res = await dialog.showOpenDialog(windows.win, {
      title: '选择插件文件夹（内含 manifest.json）',
      properties: ['openDirectory'],
      buttonLabel: '安装',
    });
    if (res.canceled || !res.filePaths.length) return null;
    return plugins.installFromDir(res.filePaths[0]);
  });

  handle('nucleus:plugins:open-dir', async ({ pluginId, target }) => {
    need(pluginId, 'plugins');
    const rec = target ? plugins.get(target) : null;
    const dir = rec ? rec.dir : path.join(app.getPath('userData'), 'plugins');
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return dir;
  });

  handle('nucleus:plugins:audit', ({ pluginId }) => {
    need(pluginId, null);
    return plugins.auditRequired();
  });

  handle('nucleus:plugins:reload', async ({ pluginId }) => {
    need(pluginId, 'plugins');
    const list = await plugins.reload();
    return list;
  });

  // ---------- 内核健康 ----------

  handle('nucleus:doctor:run', ({ pluginId }) => {
    need(pluginId, 'plugins');
    if (!doctor) throw new Error('健康检查器未就绪');
    return doctor.run();
  });

  handle('nucleus:doctor:repair', async ({ pluginId }) => {
    need(pluginId, 'plugins');
    if (!doctor) throw new Error('健康检查器未就绪');
    return doctor.repair();
  });

  // ---------- 设置 ----------

  handle('nucleus:settings:all', ({ pluginId }) => {
    const owner = need(pluginId, null);
    const out = {};
    for (const [k, v] of Object.entries(settings.get() || {})) {
      if (owner.core) out[k] = v;
      else if (k.startsWith(`plugin:${pluginId}:`)) out[k.slice(`plugin:${pluginId}:`.length)] = v;
    }
    return out;
  });

  handle('nucleus:settings:set', ({ pluginId, key, value }) => {
    const owner = resolve(pluginId);
    if (!owner) throw new Error(`插件 ${pluginId} 未启用，请求被拒绝`);
    if (!owner.core && !owner.perms.has('settings')) {
      throw new Error(`插件 ${pluginId} 未声明权限 "settings"，请求被拒绝`);
    }
    const full = owner.core ? key : `plugin:${pluginId}:${key}`;
    settings.set(full, value);
    bus.emit('settings:changed', { key: full, value });
    return true;
  });

  // ---------- 标签镜像 ----------

  handle('nucleus:tabs:sync-from-renderer', ({ pluginId, tabs: list, activeId }) => {
    need(pluginId, null);
    tabs.applySync({ tabs: list, activeId });
    return true;
  });

  handle('nucleus:tabs:capture', async ({ pluginId, tabId }) => {
    need(pluginId, 'tabs');
    const t = tabs.get(tabId);
    if (!t || !t.webContentsId) throw new Error('标签尚未就绪');
    const wc = webContents.fromId(t.webContentsId);
    if (!wc || wc.isDestroyed()) throw new Error('页面进程不可用');
    const img = await wc.capturePage();
    return img.toDataURL();
  });

  // ---------- 窗口 ----------

  handle('nucleus:window:action', ({ pluginId, action }) => {
    need(pluginId, 'window');
    switch (action) {
      case 'minimize': windows.minimize(); break;
      case 'maximize': windows.toggleMaximize(); break;
      case 'close': windows.close(); break;
      case 'fullscreen': windows.toggleFullScreen(); break;
      default: throw new Error(`未知窗口操作：${action}`);
    }
    return windows.isMaximized();
  });

  handle('nucleus:window:state', () => ({
    maximized: windows.isMaximized(),
    fullscreen: !!(windows.win && windows.win.isFullScreen()),
  }));

  // ---------- 插件私有存储 ----------

  handle('nucleus:storage:get', ({ pluginId, key, fallback }) => {
    need(pluginId, 'storage');
    const rec = plugins.get(pluginId);
    return rec && rec.ctx ? rec.ctx.storage.get(key, fallback) : fallback;
  });

  handle('nucleus:storage:set', ({ pluginId, key, value }) => {
    need(pluginId, 'storage');
    const rec = plugins.get(pluginId);
    if (rec && rec.ctx) rec.ctx.storage.set(key, value);
    return true;
  });

  handle('nucleus:storage:all', ({ pluginId }) => {
    need(pluginId, 'storage');
    const rec = plugins.get(pluginId);
    return rec && rec.ctx ? rec.ctx.storage.all() : {};
  });

  // ---------- 命令 ----------

  handle('nucleus:commands:execute', async ({ pluginId, id, args }) => {
    need(pluginId, 'commands');
    return commands.execute(id, ...(Array.isArray(args) ? args : []));
  });

  handle('nucleus:commands:list-main', ({ pluginId }) => {
    need(pluginId, null);
    return commands.list();
  });

  // ---------- 总线 ----------

  handle('nucleus:bus:emit', ({ pluginId, event, payload }) => {
    need(pluginId, 'storage');
    const name = String(event);
    if (!/^[a-z0-9][a-z0-9:._/-]*$/i.test(name)) throw new Error('非法事件名');
    // 事件名必须带自己的命名空间，否则等于允许伪造别人的事件
    // （约定是 "<插件id>/<事件>"，短名同样接受，例如 adblock:stats）
    if (pluginId !== 'core') {
      const short = String(pluginId).split('.').pop();
      const own = name.startsWith(`${pluginId}/`) || name.startsWith(`${pluginId}:`)
        || name.startsWith(`${short}/`) || name.startsWith(`${short}:`);
      if (!own) throw new Error(`事件名 "${name}" 必须以插件自己的命名空间开头`);
    }
    bus.emit(name, payload, pluginId);
    return true;
  });

  // ---------- 下载 ----------

  handle('nucleus:downloads:list', ({ pluginId }) => {
    need(pluginId, 'downloads');
    return downloads.list();
  });

  handle('nucleus:downloads:open-folder', ({ pluginId, p }) => {
    need(pluginId, 'downloads');
    downloads.openFolder(p);
    return true;
  });

  // ---------- 会话 ----------

  handle('nucleus:session:clear', async ({ pluginId, what }) => {
    need(pluginId, 'session');
    if (what === 'cache') await session.clearCache();
    else if (what === 'storage') await session.clearStorage();
    else if (what === 'all') {
      await session.clearCache();
      await session.clearStorage();
    }
    return true;
  });

  handle('nucleus:session:set-proxy', async ({ pluginId, config }) => {
    need(pluginId, 'session');
    await session.setProxy(config);
    return true;
  });

  handle('nucleus:session:set-ua', ({ pluginId, ua }) => {
    need(pluginId, 'session');
    session.setUserAgent(ua);
    return true;
  });

  // ---------- 杂项 ----------

  handle('nucleus:clipboard:write', ({ pluginId, text }) => {
    need(pluginId, 'clipboard');
    clipboard.writeText(String(text));
    return true;
  });

  handle('nucleus:clipboard:read', ({ pluginId }) => {
    need(pluginId, 'clipboard');
    return clipboard.readText();
  });

  handle('nucleus:shell:open-external', async ({ pluginId, url }) => {
    need(pluginId, 'shell');
    if (!/^(https?|mailto):/i.test(String(url))) throw new Error('只允许打开 http/https/mailto 链接');
    await shell.openExternal(url);
    return true;
  });

  handle('nucleus:file:save-image', async ({ pluginId, dataUrl, defaultName }) => {
    need(pluginId, 'tabs');
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      throw new Error('图片数据格式不正确');
    }
    const res = await dialog.showSaveDialog(windows.win, {
      title: '保存图片',
      defaultPath: defaultName || `nucleus-${Date.now()}.png`,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (res.canceled || !res.filePath) return null;
    const base64 = dataUrl.replace(/^data:image\/[a-z+]+;base64,/, '');
    fs.writeFileSync(res.filePath, Buffer.from(base64, 'base64'));
    return res.filePath;
  });

  handle('nucleus:notify', ({ pluginId, title, body }) => {
    need(pluginId, 'notifications');
    return notifications.show(title, body);
  });

  handle('nucleus:devtools:toggle', ({ pluginId, tabId }) => {
    need(pluginId, 'devtools');
    const wc = tabId && tabs.get(tabId) ? tabs.get(tabId).webContentsId : null;
    const { webContents } = require('electron');
    const target = wc ? webContents.fromId(wc) : null;
    if (!target) return false;
    if (target.isDevToolsOpened()) target.closeDevTools();
    else target.openDevTools({ mode: 'detach' });
    return true;
  });

  /**
   * 主题广播：只告诉 nucleus:// 内部页面该用哪套配色。
   * 刻意不用 nativeTheme.themeSource —— 那会把 prefers-color-scheme 全局改掉，
   * 导致没有声明 color-scheme 的普通网页出现「白底白字」。
   */
  handle('nucleus:theme:broadcast', ({ pluginId, theme }) => {
    need(pluginId, 'settings');
    const next = theme === 'light' ? 'light' : 'dark';
    state.set('resolvedTheme', next);
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue;
      let url = '';
      try { url = wc.getURL(); } catch (_) { continue; }
      if (url.startsWith('nucleus://')) {
        try { wc.send('nucleus:theme', { theme: next }); } catch (_) { /* ignore */ }
      }
    }
    return next;
  });

  /**
   * 全局状态（JsonStore）。
   *
   * 早期这里对任何插件开放，等于允许它改核自己的状态（比如 disabled 列表）。
   * 现在要求 plugins 权限，并且只能读写自己命名空间下的键 ——
   * 插件自己的持久化应该用 ctx.storage（按 pluginId 隔离）。
   */
  handle('nucleus:state:get', ({ pluginId, key, fallback }) => {
    const owner = need(pluginId, 'plugins');
    if (!owner.core && !String(key).startsWith(`plugin:${pluginId}:`)) {
      throw new Error('只能读取自己命名空间下的状态');
    }
    return state.get(key, fallback);
  });

  handle('nucleus:state:set', ({ pluginId, key, value }) => {
    const owner = need(pluginId, 'plugins');
    if (!owner.core && !String(key).startsWith(`plugin:${pluginId}:`)) {
      throw new Error('只能写入自己命名空间下的状态');
    }
    state.set(key, value);
    return true;
  });

  // ---------- 高频单向通道（用 send，避免 invoke 的往返开销） ----------

  ipcMain.on('nucleus:tabs:event', (event, payload) => {
    if (!windows.win || event.sender !== windows.win.webContents) return;
    tabs.applyEvent(payload || {});
  });

  ipcMain.on('nucleus:rpc:res', (event, payload) => {
    if (!windows.win || event.sender !== windows.win.webContents) return;
    tabs.handleRpcResponse(payload || {});
  });

  ipcMain.on('nucleus:ui:command-failed', (event, payload) => {
    logCommandFailure(payload);
  });

  // ---------- 内部页面 RPC（nucleus:// 页面专用，普通网页会被拒绝） ----------

  ipcMain.handle('nucleus:page:rpc', async (event, msg = {}) => {
    let senderUrl = '';
    try { senderUrl = event.sender.getURL(); } catch (_) { senderUrl = ''; }
    if (!senderUrl.startsWith('nucleus://')) {
      throw new Error('该接口仅对浏览器内部页面开放');
    }
    let pluginId = '';
    try { pluginId = new URL(senderUrl).hostname; } catch (_) { pluginId = ''; }

    const rec = plugins.get(pluginId);
    if (!rec || !rec.enabled) throw new Error(`插件 ${pluginId} 未启用`);

    const map = plugins.pageHandlers.get(pluginId);
    const fn = map && map.get(String(msg.method || ''));
    if (typeof fn !== 'function') throw new Error(`页面方法未实现：${msg.method}`);

    return fn(msg.payload || {}, { webContentsId: event.sender.id, url: senderUrl });
  });

  /** 内部页面 preload 的同步引导：拿主题，避免首帧闪色 */
  ipcMain.on('nucleus:bootstrap-sync', (event) => {
    event.returnValue = {
      theme: state.get('resolvedTheme', 'dark') === 'light' ? 'light' : 'dark',
      newTabUrl: plugins.newTabUrl(),
    };
  });

  // ---------- 内容脚本匹配（网页 preload 同步调用） ----------

  const scriptCache = new Map();

  ipcMain.on('nucleus:content:match', (event, { url } = {}) => {
    try {
      event.returnValue = collectContentScripts(plugins, String(url || ''), scriptCache);
    } catch (err) {
      console.warn('[content] 匹配失败', err.message);
      event.returnValue = [];
    }
  });

  ipcMain.on('nucleus:content:message', (event, payload = {}) => {
    bus.emit(`content:${payload.event}`, Object.assign({}, payload, {
      webContentsId: event.sender.id,
    }));
  });

  return { handle };
}

/** 极简 glob 匹配，语义与 Chrome 的 match pattern 对齐（够用即可） */
function matchPattern(pattern, url) {
  if (!pattern) return false;
  if (pattern === '<all_urls>') return /^(https?|file|nucleus):/i.test(url);
  if (!pattern.includes('*')) return url.startsWith(pattern);
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  try {
    return new RegExp(`^${escaped}$`).test(url);
  } catch (_) {
    return false;
  }
}

function collectContentScripts(plugins, url, cache) {
  if (!/^(https?|file):/i.test(url)) return [];
  const out = [];
  for (const rec of plugins.records.values()) {
    if (!rec.enabled || !rec.manifest) continue;
    for (const cs of rec.manifest.contributes.contentScripts) {
      if (!cs.matches.some((p) => matchPattern(p, url))) continue;
      const jsPath = path.join(rec.dir, cs.js);
      const key = `${rec.id}:${cs.js}`;
      let js = cache.get(key);
      if (js === undefined) {
        try {
          js = fs.readFileSync(jsPath, 'utf8');
        } catch (err) {
          console.warn(`[content] 读取 ${jsPath} 失败`, err.message);
          js = '';
        }
        cache.set(key, js);
      }
      let css = null;
      if (cs.css) {
        const cssKey = `${rec.id}:${cs.css}`;
        css = cache.get(cssKey);
        if (css === undefined) {
          try {
            css = fs.readFileSync(path.join(rec.dir, cs.css), 'utf8');
          } catch (_) {
            css = '';
          }
          cache.set(cssKey, css);
        }
      }
      out.push({ key, pluginId: rec.id, js, css, runAt: cs.runAt });
    }
  }
  return out;
}

let failureLogger = null;
function logCommandFailure(payload) {
  if (failureLogger) failureLogger(payload);
}
function setCommandFailureLogger(fn) {
  failureLogger = fn;
}

module.exports = { installIpc, setCommandFailureLogger };
