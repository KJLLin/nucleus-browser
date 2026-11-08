'use strict';
/**
 * 浏览器扩展支持（Chrome 扩展的一个可用子集）。
 *
 * 刻意划清边界 —— 这不是「兼容 Chrome 扩展」，而是「让常见的小扩展能跑」：
 *
 *   支持：content_scripts（JS / CSS / matches / run_at 归一为加载后）
 *         action.default_popup、options_page / options_ui
 *         background.page / background.scripts（MV2 形态，跑在隐藏窗口里）
 *         permissions 里的 storage / tabs / activeTab（仅作展示与提示）
 *         chrome.runtime / chrome.storage.local / chrome.tabs 的一个子集
 *
 *   不支持（会在管理页明确列出）：
 *         MV3 的 background.service_worker（Electron 没有扩展的 Service Worker 宿主）
 *         declarativeNetRequest / webRequest 阻塞、nativeMessaging、chrome.debugger
 *         content script 接收 runtime 消息（只能发）
 *         chrome.i18n 的完整语义、chrome.scripting
 *
 * 为什么这么划：扩展代码是第三方代码。能跑的和不能跑的必须写在界面上，
 * 而不是让用户装完之后发现「有的按钮点了没反应」。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isInside } = require('./paths');
const { contentShim } = require('./ext-shim');
const { webContents, BrowserWindow } = require('electron');

const EXT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SUPPORTED_PERMISSIONS = new Set(['storage', 'tabs', 'activeTab', 'unlimitedStorage']);

function slug(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'ext';
}

/** Chrome match pattern → 正则。`<all_urls>` 匹配 http/https/file/nucleus。 */
function patternToRegExp(pattern) {
  if (pattern === '<all_urls>') return /^(https?|file|nucleus):\/\//i;
  const m = String(pattern).match(/^(\*|https?|file|ftp|nucleus):\/\/([^/]*)(\/.*)$/i);
  if (!m) return null;
  const [, scheme, host, pathPart] = m;
  const schemeRe = scheme === '*' ? '(https?)' : scheme.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  let hostRe;
  if (host === '*') hostRe = '[^/]+';
  else if (host.startsWith('*.')) hostRe = `(?:[^/]+\\.)?${host.slice(2).replace(/[.+?^${}()|[\]\\]/g, '\\$&')}`;
  else hostRe = host.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const pathRe = pathPart.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  try {
    return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`, 'i');
  } catch (_) {
    return null;
  }
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v) return [v];
  return [];
}

class ExtensionService {
  constructor({ root, dataRoot }) {
    this.root = root;           // <userData>/extensions
    this.dataRoot = dataRoot;   // <userData>/extension-data
    this.records = new Map();   // id -> rec
    this.contexts = new Map();  // wcId -> { extId, type }
    this.tokens = new Map();    // token -> { extId, wcId }
    this._jsCache = new Map();
    this._stateFile = path.join(dataRoot, 'state.json');
    this.state = { enabled: [], disabled: [] };
    /** msgId -> resolve，等待扩展页面回应 runtime 消息 */
    this._pendingMsgs = new Map();
    /** 由 main.js 注入，用于 tabs.* 能力 */
    this.tabsApi = null;
    /** extId -> 后台页窗口（隐藏） */
    this._bgWindows = new Map();
  }

  init() {
    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(this.dataRoot, { recursive: true });
    try {
      if (fs.existsSync(this._stateFile)) {
        this.state = JSON.parse(fs.readFileSync(this._stateFile, 'utf8'));
        if (!Array.isArray(this.state.enabled)) this.state.enabled = [];
        if (!Array.isArray(this.state.disabled)) this.state.disabled = [];
      }
    } catch (_) {
      this.state = { enabled: [], disabled: [] };
    }
    this.scan();
  }

  _saveState() {
    try {
      fs.writeFileSync(this._stateFile, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (err) {
      console.warn('[ext] 状态写入失败', err.message);
    }
  }

  scan() {
    this.records.clear();
    let dirs = [];
    try {
      dirs = fs.readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch (_) {
      return;
    }
    for (const d of dirs) {
      const rec = this._readOne(path.join(this.root, d.name), d.name);
      if (rec) this.records.set(rec.id, rec);
    }
    console.log(`[ext] 已发现 ${this.records.size} 个扩展`);
  }

  _readOne(dir, dirName) {
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;

    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
    } catch (err) {
      return {
        id: slug(dirName),
        dir,
        enabled: false,
        name: dirName,
        version: '0',
        description: '',
        manifestVersion: 0,
        errors: [`manifest.json 解析失败：${err.message}`],
        unsupported: [],
        permissions: [],
        unsupportedPermissions: [],
        contentScripts: [],
        popup: null,
        options: null,
        background: null,
        icon: null,
      };
    }

    const mv = raw.manifest_version === 3 ? 3 : 2;
    const id = slug(raw.name || dirName);

    const contentScripts = [];
    for (const cs of asArray(raw.content_scripts)) {
      if (!cs || typeof cs !== 'object') continue;
      const matches = asArray(cs.matches).filter((m) => typeof m === 'string');
      if (!matches.length) continue;
      contentScripts.push({
        matches,
        js: asArray(cs.js).filter((f) => typeof f === 'string'),
        css: asArray(cs.css).filter((f) => typeof f === 'string'),
        runAt: ['document_start', 'document_end', 'document_idle'].includes(cs.run_at)
          ? cs.run_at
          : 'document_end',
        allFrames: cs.all_frames === true,
      });
    }

    const action = raw.action || raw.browser_action || null;
    const popup = action && typeof action.default_popup === 'string' ? action.default_popup : null;
    const options = typeof raw.options_page === 'string'
      ? raw.options_page
      : (raw.options_ui && typeof raw.options_ui.page === 'string' ? raw.options_ui.page : null);

    let background = null;
    if (raw.background && typeof raw.background === 'object') {
      if (typeof raw.background.page === 'string') {
        background = { type: 'page', entry: raw.background.page };
      } else if (Array.isArray(raw.background.scripts) && raw.background.scripts.length) {
        background = { type: 'scripts', entry: '__nucleus_background.html', scripts: raw.background.scripts };
      } else if (typeof raw.background.service_worker === 'string') {
        background = { type: 'service_worker', entry: raw.background.service_worker };
      }
    }

    const permissions = asArray(raw.permissions).filter((p) => typeof p === 'string');
    const unsupported = [];
    if (background && background.type === 'service_worker') {
      unsupported.push('MV3 Service Worker 后台（Electron 没有扩展 SW 宿主）');
      background = null;
    }
    if (raw.declarative_net_request) unsupported.push('declarativeNetRequest 网络规则');
    if (permissions.includes('webRequest') || permissions.includes('webRequestBlocking')) {
      unsupported.push('webRequest 请求拦截');
    }
    if (permissions.includes('nativeMessaging')) unsupported.push('nativeMessaging');
    if (raw.chrome_url_overrides) unsupported.push('chrome_url_overrides（新标签页覆盖）');
    if (raw.content_scripts && contentScripts.length === 0) unsupported.push('content_scripts 缺少 matches');

    const icons = raw.icons && typeof raw.icons === 'object' ? raw.icons : null;
    let icon = null;
    if (icons) {
      const sizes = Object.keys(icons).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => b - a);
      if (sizes.length) icon = icons[String(sizes[0])];
    }

    const rec = {
      id,
      dir,
      dirName,
      // 用户主动放进来的扩展默认启用；只有明确禁用过才保持关闭
      enabled: this.state.disabled && this.state.disabled.includes(id)
        ? false
        : true,
      name: typeof raw.name === 'string' ? raw.name : dirName,
      version: typeof raw.version === 'string' ? raw.version : '0',
      description: typeof raw.description === 'string' ? raw.description : '',
      manifestVersion: mv,
      permissions,
      unsupportedPermissions: permissions.filter((p) => !SUPPORTED_PERMISSIONS.has(p)),
      unsupported,
      contentScripts,
      popup,
      options,
      background,
      icon,
      errors: [],
      installedAt: fs.statSync(manifestPath).mtimeMs,
    };

    // 文件存在性检查：装的时候就报出来，别等到运行时白屏
    const check = (rel, label) => {
      if (!rel) return;
      const abs = path.join(dir, rel);
      if (!isInside(dir, abs) || !fs.existsSync(abs)) rec.errors.push(`${label} 不存在：${rel}`);
    };
    check(popup, 'popup');
    check(options, '选项页');
    if (background && background.type === 'page') check(background.entry, '后台页');
    if (background && background.type === 'scripts') {
      for (const s of background.scripts) check(s, '后台脚本');
    }
    for (const cs of contentScripts) {
      for (const j of cs.js) check(j, '内容脚本');
      for (const c of cs.css) check(c, '内容样式');
    }

    return rec;
  }

  list() {
    return Array.from(this.records.values()).map((r) => this.publicView(r));
  }

  publicView(rec) {
    if (!rec) return null;
    return {
      id: rec.id,
      name: rec.name,
      version: rec.version,
      description: rec.description,
      manifestVersion: rec.manifestVersion,
      enabled: rec.enabled,
      permissions: rec.permissions,
      unsupportedPermissions: rec.unsupportedPermissions,
      unsupported: rec.unsupported,
      errors: rec.errors,
      contentScripts: rec.contentScripts.length,
      hasPopup: !!rec.popup,
      popupPath: rec.popup,
      optionsPath: rec.options,
      hasOptions: !!rec.options,
      hasBackground: !!rec.background,
      icon: rec.icon ? `nucleus://ext-${rec.id}/${rec.icon}` : null,
      dir: rec.dir,
      installedAt: rec.installedAt,
    };
  }

  get(id) {
    return this.records.get(id) || null;
  }

  enable(id) {
    const rec = this.get(id);
    if (!rec) throw new Error('扩展不存在');
    rec.enabled = true;
    if (!this.state.enabled.includes(id)) this.state.enabled.push(id);
    this.state.disabled = this.state.disabled.filter((x) => x !== id);
    this._saveState();
    this.startBackground(rec);
    return this.publicView(rec);
  }

  disable(id) {
    const rec = this.get(id);
    if (!rec) throw new Error('扩展不存在');
    rec.enabled = false;
    this.state.enabled = this.state.enabled.filter((x) => x !== id);
    if (!this.state.disabled.includes(id)) this.state.disabled.push(id);
    this._saveState();
    this.stopBackground(id);
    return this.publicView(rec);
  }

  installFromDir(srcDir) {
    const manifestPath = path.join(srcDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('该目录里没有 manifest.json');
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      throw new Error(`manifest.json 解析失败：${err.message}`);
    }
    const id = slug(raw.name || path.basename(srcDir));
    const target = path.join(this.root, id);
    if (fs.existsSync(target)) throw new Error(`已存在同名扩展：${id}`);

    fs.cpSync(srcDir, target, { recursive: true });
    const rec = this._readOne(target, id);
    if (!rec) throw new Error('安装后无法读取扩展清单');
    this.records.set(rec.id, rec);
    this.enable(rec.id);
    return this.publicView(rec);
  }

  uninstall(id) {
    const rec = this.get(id);
    if (!rec) throw new Error('扩展不存在');
    // 移入回收站而不是 rm -rf：用户可能只是装错了
    const trash = path.join(this.dataRoot, '.trash');
    fs.mkdirSync(trash, { recursive: true });
    const dest = path.join(trash, `${id}-${Date.now()}`);
    try {
      fs.renameSync(rec.dir, dest);
    } catch (_) {
      fs.rmSync(rec.dir, { recursive: true, force: true });
    }
    this.stopBackground(id);
    this.records.delete(id);
    this.state.enabled = this.state.enabled.filter((x) => x !== id);
    this.state.disabled = this.state.disabled.filter((x) => x !== id);
    this._saveState();
    return true;
  }

  resolveAsset(host, rel) {
    if (!host.startsWith('ext-')) return null;
    const id = host.slice(4);
    const rec = this.get(id);
    if (!rec || !rec.enabled) return null;

    // 虚拟后台页：MV2 的 scripts 数组需要一个宿主 HTML
    if (rel === '/__nucleus_background.html') return { virtual: 'background', rec };

    const abs = path.resolve(rec.dir, `.${rel}`);
    if (!isInside(rec.dir, abs)) return null;
    return fs.existsSync(abs) ? abs : null;
  }

  /** 返回该 URL 命中的所有内容脚本（含文件内容） */
  contentScriptsFor(url, extIdFilter) {
    const out = [];
    for (const rec of this.records.values()) {
      if (!rec.enabled) continue;
      if (extIdFilter && rec.id !== extIdFilter) continue;
      for (const cs of rec.contentScripts) {
        const hit = cs.matches.some((p) => {
          const re = patternToRegExp(p);
          return re ? re.test(url) : false;
        });
        if (!hit) continue;
        out.push({ ext: rec, cs });
      }
    }
    return out;
  }

  readFile(rec, rel) {
    const key = `${rec.id}:${rel}`;
    if (this._jsCache.has(key)) return this._jsCache.get(key);
    const abs = path.resolve(rec.dir, `.${rel.startsWith('/') ? '' : '/'}${rel}`);
    let content = '';
    try {
      if (isInside(rec.dir, abs)) content = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      content = `console.warn('[nucleus-ext] 读取 ${rel} 失败：${err.message}')`;
    }
    this._jsCache.set(key, content);
    return content;
  }

  tokenFor(extId, wcId) {
    const token = crypto.randomBytes(12).toString('hex');
    this.tokens.set(token, { extId, wcId, at: Date.now() });
    if (this.tokens.size > 500) {
      const oldest = Array.from(this.tokens.entries()).sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.tokens.delete(oldest[0]);
    }
    return token;
  }

  resolveToken(token, wcId) {
    const rec = this.tokens.get(token);
    if (!rec) return null;
    if (wcId != null && rec.wcId !== wcId) return null;
    return rec;
  }

  // ---------- 上下文与消息 ----------

  registerContext(extId, wc, type) {
    this.contexts.set(wc.id, { extId, type });
    wc.once('destroyed', () => this.contexts.delete(wc.id));
  }

  contextOf(wcId) {
    return this.contexts.get(wcId) || null;
  }

  contextsOf(extId) {
    const out = [];
    for (const [wcId, ctx] of this.contexts) {
      if (ctx.extId === extId) out.push(wcId);
    }
    return out;
  }

  // ---------- 后台页 ----------

  /**
   * MV2 的后台页跑在一个隐藏窗口里。
   * 它不是真正的「扩展后台」——没有独立生命周期、不会常驻到浏览器退出，
   * 但足以让 onMessage、定时器、storage 这些常见用法工作。
   */
  startBackgrounds() {
    for (const rec of this.records.values()) {
      if (rec.enabled && rec.background) this.startBackground(rec);
    }
  }

  startBackground(rec) {
    if (!rec.background || this._bgWindows.has(rec.id)) return;
    if (rec.background.type !== 'page' && rec.background.type !== 'scripts') return;

    let win;
    try {
      win = new BrowserWindow({
        show: false,
        width: 400,
        height: 300,
        skipTaskbar: true,
        title: `[扩展] ${rec.name}`,
        webPreferences: {
          preload: path.join(__dirname, '..', 'preload', 'web-preload.js'),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false,
          webSecurity: true,
        },
      });
    } catch (err) {
      console.warn(`[ext:${rec.id}] 后台页创建失败`, err.message);
      return;
    }

    this._bgWindows.set(rec.id, win);
    win.on('closed', () => this._bgWindows.delete(rec.id));
    // 后台页的 console 进主进程日志：扩展出错时用户能拿到线索
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.warn(`[ext-bg:${rec.id}] ${message}`);
    });
    win.loadURL(`nucleus://ext-${rec.id}/${rec.background.entry}`).catch((err) => {
      console.warn(`[ext:${rec.id}] 后台页加载失败`, err.message);
    });
    console.log(`[ext:${rec.id}] 后台页已启动`);
  }

  stopBackground(extId) {
    const win = this._bgWindows.get(extId);
    if (!win) return;
    this._bgWindows.delete(extId);
    try { win.destroy(); } catch (_) { /* 已关闭 */ }
  }

  // ---------- 内容脚本注入 ----------

  /**
   * 把命中的内容脚本注入到某个 webview。
   * 用 isolated world 而不是 main world：扩展代码与页面脚本共享 DOM，
   * 但碰不到彼此的 JS 全局，页面也没法偷扩展的 chrome 对象。
   */
  injectInto(wc) {
    if (!wc || wc.isDestroyed()) return 0;
    let url = '';
    try { url = wc.getURL(); } catch (_) { return 0; }
    if (!/^(https?|file):/i.test(url)) return 0;

    const hits = this.contentScriptsFor(url);
    let injected = 0;

    for (const { ext, cs } of hits) {
      const token = this.tokenFor(ext.id, wc.id);
      const manifest = {
        manifest_version: ext.manifestVersion,
        name: ext.name,
        version: ext.version,
        description: ext.description,
      };
      const parts = [contentShim(ext.id, token, manifest)];
      for (const file of cs.js) parts.push(this.readFile(ext, file));

      // 每个扩展一个固定 world：同一页里两个扩展的全局变量不会互相污染
      const worldId = 1000 + (hashString(ext.id) % 800);
      wc.executeJavaScriptInIsolatedWorld(worldId, [{ code: parts.join('\n;\n') }])
        .then(() => {
          if (cs.css.length) {
            const cssText = cs.css.map((f) => this.readFile(ext, f)).join('\n');
            wc.insertCSS(cssText).catch(() => {});
          }
        })
        .catch((err) => {
          console.warn(`[ext:${ext.id}] 注入失败 @ ${url}`, err.message);
        });
      injected += 1;
    }
    return injected;
  }

  // ---------- 消息路由 ----------

  /**
   * 把 runtime 消息派给同扩展的其它上下文（popup / background）。
   * 与 Chrome 一样：第一个回应者胜出，无人回应或超时则返回 undefined。
   */
  broadcast(extId, message, fromWcId) {
    const targets = this.contextsOf(extId).filter((id) => id !== fromWcId);
    if (!targets.length) return Promise.resolve(undefined);

    const msgId = crypto.randomBytes(8).toString('hex');
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        this._pendingMsgs.delete(msgId);
        resolve(value);
      };
      this._pendingMsgs.set(msgId, done);
      setTimeout(() => done(undefined), 3000);

      for (const id of targets) {
        const wc = webContents.fromId(id);
        if (wc && !wc.isDestroyed()) {
          try { wc.send('nucleus:ext-onmessage', { msgId, message }); } catch (_) { /* 已关闭 */ }
        }
      }
    });
  }

  resolveMessageReply(msgId, value) {
    const done = this._pendingMsgs.get(msgId);
    if (done) done(value);
  }

  /** 内容脚本 / 扩展页面的能力调用统一入口 */
  async bridge({ extId, op, args, token, wcId }) {
    let resolved = extId;

    if (token) {
      // 内容脚本：身份完全由令牌决定，页面无法伪造成别的扩展
      const bound = this.resolveToken(token, wcId);
      if (!bound) throw new Error('非法扩展令牌');
      resolved = bound.extId;
    } else {
      const ctx = this.contextOf(wcId);
      if (!ctx) throw new Error('调用来源不属于任何扩展');
      if (extId && ctx.extId !== extId) throw new Error('调用来源不属于该扩展');
      resolved = ctx.extId;
    }

    const rec = this.get(resolved);
    if (!rec || !rec.enabled) throw new Error('扩展未启用');

    switch (op) {
      case 'sendMessage':
        return this.broadcast(resolved, args[0], wcId);

      case 'storage.get':
        return this.storageGet(resolved, args[0]);
      case 'storage.set':
        return this.storageSet(resolved, args[0]);
      case 'storage.remove':
        return this.storageRemove(resolved, args[0]);
      case 'storage.clear':
        return this.storageSet(resolved, Object.fromEntries(
          Object.keys(this.storageGet(resolved)).map((k) => [k, null])
        ));

      case 'tabs.query': {
        if (!this.tabsApi) return [];
        const query = args[0] || {};
        return this.tabsApi.list()
          .filter((t) => (query.active === undefined ? true : t.active === query.active))
          .map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, index: t.index }));
      }

      case 'tabs.create': {
        if (!this.tabsApi) throw new Error('标签能力不可用');
        const opts = args[0] || {};
        const t = this.tabsApi.create({ url: opts.url || 'about:blank', active: opts.active !== false });
        return { id: t.id };
      }

      default:
        throw new Error(`扩展 API 尚未支持：${op}`);
    }
  }

  // ---------- 存储 ----------

  _storageFile(extId) {
    return path.join(this.dataRoot, `${extId}.json`);
  }

  storageGet(extId, keys) {
    let data = {};
    try {
      const f = this._storageFile(extId);
      if (fs.existsSync(f)) data = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (_) { data = {}; }

    if (keys == null) return data;
    if (typeof keys === 'string') return { [keys]: data[keys] };
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) out[k] = data[k];
      return out;
    }
    if (typeof keys === 'object') {
      const out = { ...keys };
      for (const k of Object.keys(keys)) if (k in data) out[k] = data[k];
      return out;
    }
    return data;
  }

  storageSet(extId, items) {
    let data = {};
    try {
      const f = this._storageFile(extId);
      if (fs.existsSync(f)) data = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (_) { data = {}; }
    Object.assign(data, items || {});
    try {
      fs.writeFileSync(this._storageFile(extId), JSON.stringify(data), 'utf8');
    } catch (err) {
      throw new Error(`写入扩展存储失败：${err.message}`);
    }
    return true;
  }

  storageRemove(extId, keys) {
    let data = {};
    try {
      const f = this._storageFile(extId);
      if (fs.existsSync(f)) data = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (_) { data = {}; }
    for (const k of asArray(keys)) delete data[k];
    fs.writeFileSync(this._storageFile(extId), JSON.stringify(data), 'utf8');
    return true;
  }
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

module.exports = { ExtensionService, patternToRegExp };
