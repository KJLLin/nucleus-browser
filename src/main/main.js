'use strict';
/**
 * Nucleus 主进程入口。
 *
 * 启动顺序被刻意固定为：
 *   解析开关 → 注册特权协议 → 建窗并装载 UI → 激活插件 → 重建快捷键 → 恢复会话
 * 插件永远在核就绪之后才开始工作，这样任何插件崩溃都不会让浏览器停在白屏。
 */
const path = require('path');
const fs = require('fs');
const { app, session, BrowserWindow, webContents, dialog, shell } = require('electron');

// 必须在 app ready 之前执行
const { ProtocolService } = require('./core/protocol');
ProtocolService.registerPrivileged();

const { EventBus } = require('./core/bus');
const { JsonStore } = require('./core/store');
const { userDataFile, profilesDir } = require('./core/paths');
const { WindowService } = require('./core/window');
const { TabMirror } = require('./core/tabs');
const { PluginHost } = require('./core/plugin-host');
const { InterceptService } = require('./core/intercept');
const { ShortcutService } = require('./core/shortcuts');
const { installIpc } = require('./core/ipc');
const { createRoot } = require('./core/kernel');
const { loadConfig, listProfiles, ensurePatchTemplate } = require('./core/config');
const { runtime } = require('./core/runtime-state');
const { ExtensionService } = require('./core/extensions');
const { Doctor } = require('./core/doctor');
const {
  CommandRegistry, DownloadService, NotificationService, SessionService, clipboard,
} = require('./core/services');

// ---------- 命令行开关 ----------

// 开发模式（截图 / 冒烟自检 / 回归验证）需要从外部读 window.__nucleusApp，
// 而常驻的调试入口在正式形态里是关掉的（插件与它在同一个 JS 世界）。
// 这里只开「调试对象」，不开「常驻裸桥」—— 后者会绕过一次性取件的保护。
if (process.env.NUCLEUS_SHOTS === '1' || process.env.NUCLEUS_SMOKE === '1' || process.env.NUCLEUS_VERIFY === '1') {
  process.env.NUCLEUS_DEV_TOOLS = '1';
}

const argv = process.argv.slice(1);
const flag = (name) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagValue = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

// Windows 7 上部分老显卡的 D3D 合成会导致花屏，提供显式开关
if (flag('nucleus-gpu-off')) {
  app.disableHardwareAcceleration();
}
if (flag('nucleus-no-sandbox')) {
  app.commandLine.appendSwitch('no-sandbox');
}
// Linux 下以 root 运行时，Chromium 的 zygote 子进程必须显式关闭沙箱，
// 否则 webview 的渲染进程无法启动（Windows 发行版不会走到这里）
if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
}
const profileName = flagValue('nucleus-profile', '');
if (profileName) {
  app.setPath('userData', path.join(app.getPath('appData'), `Nucleus-${profileName}`));
}

// ---------- 日志 ----------

let logStream = null;
function setupLog() {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'main.log');
    // 简单滚动：超过 1MB 就换名
    try {
      if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.1`);
    } catch (_) { /* 首次运行时文件不存在 */ }
    logStream = fs.createWriteStream(file, { flags: 'a' });
  } catch (_) {
    logStream = null;
  }
}
function logLine(level, ...args) {
  const text = args.map((a) => (a instanceof Error ? a.stack : typeof a === 'object' ? safeJson(a) : String(a))).join(' ');
  const line = `[${new Date().toISOString()}] [${level}] ${text}\n`;
  if (logStream) logStream.write(line);
  if (level === 'ERROR') console.error(text);
  else console.log(text);
}
function safeJson(o) {
  try { return JSON.stringify(o); } catch (_) { return String(o); }
}

process.on('uncaughtException', (err) => logLine('ERROR', '未捕获异常', err));
process.on('unhandledRejection', (err) => logLine('ERROR', '未处理 Promise 拒绝', err));

// ---------- 单实例 ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, commandLine) => {
    const win = windows && windows.win;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    // 从命令行/系统"打开方式"传入的 URL
    const url = commandLine.find((a) => /^https?:\/\//i.test(a));
    if (url) tabs.create({ url, active: true });
  });
}

// ---------- 服务装配 ----------

const bus = new EventBus();
let windows = null;
let tabs = null;
let plugins = null;
let shortcuts = null;
let protocolService = null;
let state = null;
let services = null;
let booted = false;

async function buildServices() {
  state = new JsonStore(userDataFile('state.json'), {
    disabledPlugins: [],
    lastSession: null,
  });

  const settings = new JsonStore(userDataFile('settings.json'), {
    'appearance.theme': 'auto',
    'appearance.frameless': true,
    'appearance.density': 'comfortable',
    'privacy.blockThirdPartyCookies': false,
    'network.proxy.mode': 'system',
  });

  windows = new WindowService({ bus });
  tabs = new TabMirror({ bus });
  shortcuts = new ShortcutService({
    bus,
    getChromeWindow: () => windows.win,
  });

  const intercept = new InterceptService({ bus });
  const commands = new CommandRegistry({ bus });
  const downloads = new DownloadService({ bus });
  const notifications = new NotificationService();
  const sessionService = new SessionService({ session: session.defaultSession, bus });

  const extensionService = new ExtensionService({
    root: path.join(app.getPath('userData'), 'extensions'),
    dataRoot: path.join(app.getPath('userData'), 'extension-data'),
  });
  extensionService.init();

  protocolService = new ProtocolService({ plugins: null });
  protocolService.extensions = extensionService;

  services = {
    bus,
    state,
    settings,
    windows,
    tabs,
    commands,
    downloads,
    notifications,
    session: sessionService,
    shell,
    clipboard,
    intercept,
    protocol: protocolService,
    extensions: extensionService,
    appInfo: {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      cordis: '4.0.0-rc.12',
      isWin7: process.platform === 'win32' && /^6\.1/.test(process.getSystemVersion?.() || ''),
    },
  };

  // 把主进程事件镜像到渲染层
  bus.setBridge((event, payload) => {
    if (!windows.win || windows.win.isDestroyed()) return;
    windows.win.webContents.send('nucleus:bus', { event, payload });
  });

  // Cordis 根上下文：上面这些能力都成为它的服务，插件是它下面的 fiber。
  // 这一步之后，核自己不再实现「插件树 / 副作用回收 / 服务注册」。
  services.root = await createRoot({
    bus,
    settings,
    state,
    windows,
    tabs,
    commands,
    downloads,
    notifications,
    session: sessionService,
    shell,
    intercept,
    protocol: protocolService,
    appInfo: services.appInfo,
  });

  extensionService.tabsApi = tabs;

  plugins = new PluginHost(services);
  protocolService.plugins = plugins;
  services.plugins = plugins;
  // 插件管理器本身也是服务，这样别的插件可以 inject(['plugins'])
  services.root.provide('plugins');
  services.root.set('plugins', plugins);
  services.shortcuts = shortcuts;

  // 健康检查器：读的是核自己的账本，所以也算服务（自省页通过 ctx.plugins.inspect 拿不到它）
  services.doctor = new Doctor(services);
  services.root.provide('doctor');
  services.root.set('doctor', services.doctor);
}

// ---------- 应用就绪 ----------

app.whenReady().then(async () => {
  setupLog();

  // ---------- 配置层 ----------
  let cfg;
  try {
    cfg = loadConfig({
      profilesDir: profilesDir(),
      userDataDir: app.getPath('userData'),
      argv: process.argv,
    });
  } catch (err) {
    logLine('ERROR', `配置加载失败：${err.message}`);
    dialog.showErrorBox('配置加载失败', `${err.message}\n\n修好配置文件后重新启动。`);
    app.quit();
    return;
  }

  if (cfg.args.listProfiles) {
    console.log(listProfiles(profilesDir()).join('\n'));
    app.quit();
    return;
  }

  if (cfg.args.dump) {
    console.log(JSON.stringify(cfg.config, null, 2));
    app.quit();
    return;
  }

  runtime.config = cfg.config;
  runtime.profile = cfg.config.profile;
  ensurePatchTemplate(cfg.patchPath);

  logLine('INFO', `Nucleus 启动 · Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · ${process.platform}`);
  logLine('INFO', `配置：profile=${cfg.config.profile}（${cfg.config.requestedBy}） · ${cfg.config.plugins.enable.length} 启用 / ${cfg.config.plugins.disable.length} 禁用 · ${cfg.config.layers.filter((l) => l.exists).length} 层生效`);
  await buildServices();

  // 会话级安全策略：敏感能力默认拒绝，可用插件扩展为二次确认
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allow = new Set([
      'fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'background-sync',
    ]);
    callback(allow.has(permission));
  });

  // 强制 webview 使用核提供的 preload，防止页面侧篡改
  app.on('web-contents-created', (_e, wc) => {
    shortcuts.attach(wc);

    // 扩展自己的页面（popup / background / options）要能被消息路由找到
    wc.on('did-finish-load', () => {
      let url = '';
      try { url = wc.getURL(); } catch (_) { return; }
      const m = url.match(/^nucleus:\/\/ext-([^/]+)\//);
      if (!m) return;
      services.extensions.registerContext(m[1], wc, wc.getType() === 'webview' ? 'popup' : 'page');
    });

    if (wc.getType() === 'webview') {
      // 查找计数：<webview> 的 found-in-page 在 Chromium 108 里不派发，
      // 直接在 guest 的 webContents 上监听，再转发给浏览器界面。
      wc.on('found-in-page', (_evt, result) => {
        if (!windows.win || windows.win.isDestroyed()) return;
        const rec = tabs.findByWebContentsId(wc.id);
        if (!rec) return;
        windows.win.webContents.send('nucleus:tab-found', { id: rec.id, result });
      });

      wc.setWindowOpenHandler(({ url, disposition }) => {
        if (/^https?:/i.test(url) || /^nucleus:\/\//i.test(url)) {
          tabs.create({ url, active: disposition !== 'background-tab' });
        }
        return { action: 'deny' };
      });
      // 内容脚本注入：DOM 就绪即可，不等子资源
      wc.on('dom-ready', () => {
        try {
          const n = services.extensions.injectInto(wc);
          if (n) logLine('INFO', `扩展注入 ${n} 个 @ ${wc.getURL().slice(0, 80)}`);
        } catch (err) {
          logLine('ERROR', `扩展注入失败：${err.message}`);
        }
      });

      wc.on('render-process-gone', (_evt, details) => {
        logLine('ERROR', `标签页渲染进程退出：${details.reason}`);
        tabs.broadcast('nucleus:tab-crashed', { webContentsId: wc.id, reason: details.reason });
      });
    }
  });

  protocolService.install();
  services.intercept.install(defaultSession);
  services.downloads.install(defaultSession);

  const frameless = state.get('appearance.frameless', true) !== false;
  const win = windows.create({ frameless });
  tabs.attach(win);

  // 禁止 webview 使用自定义 preload 之外的任何配置
  win.webContents.on('will-attach-webview', (_e, webPreferences) => {
    webPreferences.preload = path.join(__dirname, 'preload', 'web-preload.js');
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = false;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
  });

  installIpc({
    plugins,
    tabs,
    windows,
    extensions: services.extensions,
    settings: services.settings,
    bus,
    commands: services.commands,
    downloads: services.downloads,
    session: services.session,
    notifications: services.notifications,
    protocol: protocolService,
    intercept: services.intercept,
    state,
    doctor: services.doctor,
  });

  plugins.scan();

  // 配置层在激活之前落地：被 profile 禁用的插件根本不会被激活，
  // 设置项也要在插件读自己的设置快照之前写进去。
  const applied = plugins.applyStartupConfig(cfg.config.plugins);
  for (const [key, value] of Object.entries(cfg.config.settings || {})) {
    if (!(key in cfg.config.force) && services.settings.get(key) === undefined) {
      services.settings.set(key, value);
    }
  }
  for (const [key, value] of Object.entries(cfg.config.force || {})) {
    services.settings.set(key, value);
  }
  if (applied.disabled.length) {
    logLine('INFO', `配置禁用：${applied.disabled.join(', ')}`);
  }

  // 后台页要等 IPC 装好再启动：它的 preload 会同步取扩展清单
  services.extensions.startBackgrounds();

  await win.loadURL('nucleus://core/index.html');

  // 核 UI 就绪后再激活插件，插件里的 tabs.create 才有地方落地
  await plugins.activateAll();
  shortcuts.rebuild(Array.from(plugins.records.values()));
  booted = true;

  win.webContents.send('nucleus:boot', {
    pluginCount: plugins.list().filter((p) => p.enabled).length,
    shortcutCount: shortcuts.bindings.size,
  });

  // 启动自检：等界面把槽位快照上报之后再跑，否则「槽位」一项必然是空的。
  // 只写日志，不阻塞启动 —— 自检发现问题也不该让浏览器打不开。
  setTimeout(() => {
    // 必需插件审计：缺失不是「降级运行」，要明确记一笔
    try {
      const audit = services.plugins.auditRequired();
      if (audit.ok) logLine('INFO', '必需插件审计：齐全');
      else logLine('WARN', `必需插件缺失：${audit.missing.map((m) => `${m.id}（${m.reason}）`).join('、')}`);
    } catch (err) {
      logLine('WARN', `必需插件审计失败：${err.message}`);
    }

    try {
      const health = services.doctor.run();
      logLine('INFO', `自检${health.ok ? '通过' : '发现问题'}：${health.summary.errors} 错误 / ${health.summary.warns} 警告 / ${health.summary.effects} 条副作用 / ${health.summary.active} 个插件已激活`);
      for (const c of health.checks) {
        if (c.level === 'ok') continue;
        logLine('WARN', `自检 ${c.title}（${c.level}）：${c.detail}`);
        for (const item of c.items.slice(0, 6)) logLine('WARN', `  · ${item.plugin}：${item.text}`);
      }
    } catch (err) {
      logLine('WARN', `自检执行失败：${err.message}`);
    }
  }, 2600);

  const startupUrl = flagValue('nucleus-url', '');
  if (startupUrl) tabs.create({ url: startupUrl, active: true });
  if (flag('nucleus-devtools')) win.webContents.openDevTools({ mode: 'detach' });

  // ---- 截图脚本（开发用）：一次跑完，产出一组界面状态图 ----
  if (process.env.NUCLEUS_SHOTS === '1') {
    require('./dev/shots')({ win, plugins, app }).catch((err) => {
      console.error('SHOTS_ERROR', err);
      app.quit();
    });
  }

  // ---- 加固回归验证（开发用）：沙箱 / 桥取件 / 休眠 / 槽位清理 / 健康检查 ----
  if (process.env.NUCLEUS_VERIFY === '1') {
    require('./dev/verify')({ win, plugins, app }).catch((err) => {
      console.error('VERIFY_ERROR', err);
      app.quit();
    });
  }

  // ---- 恢复通道自检：禁用全部界面插件后，核能不能把自己救回来 ----
  if (process.env.NUCLEUS_SMOKE === 'recover') {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let phase = 0;
    const snapshot = () => win.webContents.executeJavaScript(
      `JSON.stringify({ recovery: !!document.querySelector('.shell-recovery'),
         tabs: document.querySelectorAll('[data-region="tabstrip"] > *').length,
         nav: document.querySelectorAll('[data-region="nav-center"] > *').length,
         booted: !!window.__nucleusApp,
         ready: document.documentElement.dataset.ready || '',
         bodyHead: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160) })`
    );

    const step = async () => {
      phase += 1;
      const p = phase;
      await wait(2600);
      try {
        if (p === 1) {
          await plugins.disable('ui.shell');
          win.webContents.reload();
          return;
        }
        if (p === 2) {
          console.log('RECOVER_EMPTY ' + await snapshot());
          const clicked = await win.webContents.executeJavaScript(`(() => {
            const b = document.querySelector('.shell-recovery .btn');
            if (!b) return 'no-button';
            b.click();
            return b.textContent;
          })()`);
          console.log('RECOVER_CLICK ' + clicked);
          return;
        }
        console.log('RECOVER_BACK ' + await snapshot());
        app.quit();
      } catch (err) {
        console.log('RECOVER_ERROR ' + err.message);
        app.quit();
      }
    };

    // 注意：这里 window 已经加载完，首次要手动触发第一段
    win.webContents.on('did-finish-load', () => { if (phase > 0) step(); });
    step();
  }

  // ---- 冒烟自检：仅在 CI / 开发环境显式开启，不影响正常运行 ----
  if (process.env.NUCLEUS_SMOKE === '1') {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const shot = async (name) => {
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(`/tmp/shot-${name}.png`, img.toPNG());
        console.log('SMOKE_SHOT ' + name);
      } catch (err) {
        console.log('SMOKE_SHOT_FAIL ' + name + ' ' + err.message);
      }
    };
    const evalUI = (code) => win.webContents.executeJavaScript(code);

    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) console.log(`[renderer:${level}] ${message}  (${String(sourceId).split('/').pop()}:${line})`);
    });

    setTimeout(async () => {
      try {
        const state = await evalUI(`(() => {
          const a = window.__nucleusApp;
          const regions = ['tabstrip','nav-left','nav-center','nav-right','sidebar'];
          return JSON.stringify({
            booted: !!a,
            plugins: a ? [...a.plugins.keys()] : [],
            tabs: a ? a.tabs.all.map(t => ({ id: t.id, url: t.url, title: t.title })) : [],
            webviews: document.querySelectorAll('#webarea webview').length,
            regions: regions.map(r => {
              const el = document.querySelector('[data-region="' + r + '"]');
              return [r, el ? el.children.length : -1];
            }),
            commands: a ? a.commands.list().length : 0,
          });
        })()`);
        console.log('SMOKE_STATE ' + state);
        await shot('newtab');

        // 设置页
        await evalUI(`window.__nucleusApp.commands.execute('settings.open')`);
        await sleep(3000);
        await shot('settings');

        // 设置页的「关于」：确认 Cordis 版本与内核说明可见
        await evalUI(`(async () => {
          const wv = [...document.querySelectorAll('webview')]
            .find((w) => { try { return w.getURL().includes('feature.settings'); } catch (e) { return false; } });
          if (!wv) return 'no-wv';
          // 直接点导航项，避免依赖页面内部路由实现
          return wv.executeJavaScript('(() => {' +
            "const item = [...document.querySelectorAll('.nav-item')]" +
            ".find((el) => el.textContent.includes('关于'));" +
            "if (!item) return 'no-item'; item.click(); return 'clicked';" +
            '})()');
        })()`);
        await sleep(900);
        await shot('about');

        // 运行时自省页
        await evalUI(`window.__nucleusApp.commands.execute('inspector.open')`);
        await sleep(3200);
        await shot('inspector');

        const insp = await evalUI(`JSON.stringify(window.__nucleusApp.tabs.all.map(t => ({ u: t.url, title: t.title })))`);
        console.log('SMOKE_INSPECTOR_TABS ' + insp);

        const clickInspectorTab = (name) => evalUI(`(async () => {
          const wv = [...document.querySelectorAll('webview')]
            .find((w) => { try { return w.getURL().includes('feature.inspector'); } catch (e) { return false; } });
          if (!wv) return 'no-wv';
          const code = 'document.querySelector(' + ${JSON.stringify(JSON.stringify('[data-view="' + name + '"]'))} + ').click(), "ok"';
          return wv.executeJavaScript(code);
        })()`);

        console.log('SMOKE_VIEW_SLOTS ' + await clickInspectorTab('slots'));
        await sleep(1400);
        await shot('inspector-slots');

        console.log('SMOKE_VIEW_RPC ' + await clickInspectorTab('rpc'));
        await sleep(1400);
        await shot('inspector-rpc');

        // 扩展管理页
        await evalUI(`window.__nucleusApp.tabs.create({ url: 'nucleus://feature.extensions/index.html' })`);
        await sleep(2000);
        await shot('extensions');

        // 扩展 popup：验证 chrome.* 垫片真的暴露给了扩展页面
        await evalUI(`window.__nucleusApp.tabs.create({ url: 'nucleus://ext-hello-nucleus/popup.html' })`);
        await sleep(2200);
        await shot('ext-popup');
        const popupProbe = await evalUI(`(async () => {
          const wv = [...document.querySelectorAll('#webarea webview')]
            .find((w) => { try { return w.getURL().includes('ext-hello-nucleus'); } catch (e) { return false; } });
          if (!wv) return 'no-wv';
          return wv.executeJavaScript(
            'JSON.stringify({ chrome: typeof chrome, id: (typeof chrome !== "undefined" && chrome.runtime) ? chrome.runtime.id : null,' +
            ' body: (document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 120) })'
          );
        })()`);
        console.log('SMOKE_EXT_POPUP ' + popupProbe);

        // 消息路由：popup → 后台页 → 回应
        const msgProbe = await evalUI(`(async () => {
          const wv = [...document.querySelectorAll('#webarea webview')]
            .find((w) => { try { return w.getURL().includes('ext-hello-nucleus'); } catch (e) { return false; } });
          if (!wv) return 'no-wv';
          return wv.executeJavaScript(
            '(async () => { document.getElementById("ping").click();' +
            ' await new Promise(function (r) { setTimeout(r, 1200); });' +
            ' return document.getElementById("out").textContent; })()'
          );
        })()`);
        console.log('SMOKE_EXT_MSG ' + String(msgProbe).replace(/\s+/g, ' ').slice(0, 220));

        // 深色主题
        await evalUI(`window.__nucleusApp.commands.execute('theme.dark')`);
        await sleep(500);
        await shot('settings-dark');

        // 回到新标签页，看深色外观
        await evalUI(`(() => { const a = window.__nucleusApp; const t = a.tabs.all.find(x => x.url.includes('/newtab/')); if (t) a.tabs.activate(t.id); })()`);
        await sleep(600);
        await shot('newtab-dark');

        // 书签面板
        await evalUI(`window.__nucleusApp.commands.execute('bookmarks.panel')`);
        await sleep(700);
        await shot('panel-dark');
        await evalUI(`window.__nucleusApp.sidebar.hide()`);

        // 命令面板
        await evalUI(`window.__nucleusApp.commands.execute('palette.open')`);
        await sleep(700);
        await shot('palette');
        await evalUI(`(() => {
          const scrim = document.querySelector('.scrim');
          if (scrim) scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          document.querySelectorAll('.menu').forEach((m) => m.remove());
        })()`);

        // 地址栏真实输入 → 导航到外部站点
        const navResult = await evalUI(`(async () => {
          const input = document.querySelector('.omnibox input');
          if (!input) return 'no-input';
          input.focus();
          input.value = 'example.com';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          return 'dispatched';
        })()`);
        console.log('SMOKE_NAV ' + navResult);
        await sleep(6000);
        await shot('web');
        const webInfo = await evalUI(`JSON.stringify(window.__nucleusApp.tabs.all.map(t => ({url: t.url, title: t.title, loading: t.loading})))`);
        console.log('SMOKE_WEB ' + webInfo);

        // 扩展注入验证：内容脚本应在 isolated world 里给页面加角标
        const extProbe = await evalUI(`(async () => {
          const wv = [...document.querySelectorAll('#webarea webview')]
            .find((w) => { try { return w.getURL().includes('example.com'); } catch (e) { return false; } });
          if (!wv) return 'no-wv';
          return wv.executeJavaScript(
            'JSON.stringify({ badge: !!document.getElementById("__hello_badge"),' +
            ' text: (document.getElementById("__hello_badge") || {}).textContent || "",' +
            ' stored: (document.getElementById("__hello_badge") || {}).dataset ? (document.getElementById("__hello_badge").dataset.stored || "") : "" })'
          );
        })()`);
        console.log('SMOKE_EXT ' + extProbe);

        const slotProbe = await evalUI(`(() => {
          const actions = document.querySelector('.omni-actions');
          const all = document.querySelectorAll('.omni-actions');
          return JSON.stringify({
            count: all.length,
            omniActions: actions ? actions.children.length : -1,
            html: actions ? actions.innerHTML.slice(0, 400) : null,
            star: !!document.querySelector('.omni-actions [data-slot-from="feature.bookmarks"]'),
            statusbar: !!document.querySelector('#statusbar.has-content'),
          });
        })()`);
        console.log('SMOKE_SLOTS_UI ' + slotProbe);

        const rt = require('./core/runtime-state');
        console.log('SMOKE_SLOTS ' + JSON.stringify(rt.runtime.slots ? {
          total: rt.runtime.slots.total,
          entries: rt.runtime.slots.entries,
          names: rt.runtime.slots.slots.map((x) => x.name),
          rejections: rt.runtime.slots.rejections.map((r) => r.pluginId + '→' + r.name),
        } : null));
        const overlays = await evalUI(`JSON.stringify({
          suggest: document.querySelectorAll('.suggest').length,
          menu: document.querySelectorAll('.menu').length,
          scrim: document.querySelectorAll('.scrim').length,
          palette: document.querySelectorAll('.palette').length,
          activeTab: window.__nucleusApp.tabs.active?.id,
          editing: !!document.querySelector('.omnibox input:focus'),
        })`);
        console.log('SMOKE_OVERLAY ' + overlays);
        const webDiag = await evalUI(`(async () => {
          const wv = document.querySelector('#webarea webview');
          if (!wv) return 'no-wv';
          try {
            return await wv.executeJavaScript(\`JSON.stringify({
              bg: getComputedStyle(document.body).backgroundColor,
              color: getComputedStyle(document.body).color,
              text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 120),
              scrollH: document.documentElement.scrollHeight,
              innerH: window.innerHeight,
              zoom: window.devicePixelRatio,
              scheme: getComputedStyle(document.documentElement).colorScheme,
            })\`);
          } catch (e) { return 'ERR ' + e.message; }
        })()`);
        console.log('SMOKE_WEBDIAG ' + webDiag);

        const digest = await evalUI(`JSON.stringify(window.__nucleusApp.tabs.all)`);
        console.log('SMOKE_TABS ' + digest);

        // 生命周期自检：禁用 → 副作用归零 → 启用 → 重新登记且不翻倍
        const lifecycle = await evalUI(`(async () => {
          const a = window.__nucleusApp;
          const inv = (ch, p) => a.bridge.invoke(ch, Object.assign({ pluginId: 'core' }, p));
          const pick = async () => (await inv('nucleus:plugins:list'))
            .find((x) => x.id === 'feature.adblock');
          const before = await pick();
          await inv('nucleus:plugins:disable', { target: 'feature.adblock' });
          const off = await pick();
          await inv('nucleus:plugins:enable', { target: 'feature.adblock' });
          const on = await pick();
          return JSON.stringify({
            before: before.effects, beforeStatus: before.status,
            off: off.effects, offStatus: off.status,
            on: on.effects, onStatus: on.status,
          });
        })()`);
        console.log('SMOKE_LIFECYCLE ' + lifecycle);

        // 权限闸自检：临时挂一个零权限插件，访问 tabs 必须被拒
        let gate = 'unexpected';
        const probe = services.root.plugin({
          name: 'smoke-probe',
          apply: (cctx) => {
            const { createContext } = require('./core/plugin-context');
            const { ctx } = createContext({
              manifest: { id: 'smoke.probe', name: 'probe', version: '0.0.0', permissions: [], builtin: true, contributes: { settings: [], commands: [] } },
              dir: __dirname,
              services,
              cordisCtx: cctx,
            });
            try { ctx.tabs.list(); gate = 'LEAK'; } catch (err) { gate = err.code || err.message; }
          },
        });
        await probe.await();
        console.log('SMOKE_GATE ' + gate);
        await probe.dispose();

        // Cordis 自检：渲染层插件确实是 fiber，effect 由它记账并在卸载时回收
        const cordis = await evalUI(`(async () => {
          const rec = window.__nucleusApp.plugins.get('ui.shell');
          if (!rec || !rec.fiber) return 'no-fiber';
          let hits = 0;
          rec.api.effect(() => { hits += 1; return () => { hits += 100; }; }, 'smoke');
          const before = rec.fiber.getEffects().length;
          const stateBefore = rec.fiber.state;
          await rec.fiber.dispose();
          return JSON.stringify({ before, stateBefore, hits, stateAfter: rec.fiber.state });
        })()`);
        console.log('SMOKE_CORDIS ' + cordis);
      } catch (err) {
        console.error('SMOKE_ERROR', err);
      } finally {
        setTimeout(() => app.quit(), 300);
      }
    }, 6500);
  }

  logLine('INFO', `核就绪：插件 ${plugins.list().length} 个，快捷键 ${shortcuts.bindings.size} 条`);
});

app.on('window-all-closed', () => {
  if (windows) windows.persistNow();
  app.quit();
});

app.on('before-quit', () => {
  if (windows) windows.persistNow();
  if (logStream) logStream.end();
});

// 阻止站内信式的可疑导航（核 UI 自身）
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (event, url) => {
    if (wc.getType() === 'window' && !url.startsWith('nucleus://core/')) {
      event.preventDefault();
    }
  });
});
