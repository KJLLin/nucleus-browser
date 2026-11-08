/**
 * 标签页服务：<webview> 的唯一管理者。
 *
 * 为什么标签在渲染层而不是主进程：只有 DOM 元素才能和浏览器 UI 自由叠放
 * （侧边栏、命令面板要能盖住网页）。主进程因此只保留镜像，见 src/main/core/tabs.js。
 */
import { h } from './dom.js';

/**
 * 兜底地址。真正的新标签页由声明了 contributes.newTab 的插件提供，
 * 引导阶段通过 setNewTabUrl() 注入 —— 核不该知道某个具体插件叫什么。
 */
export const NEW_TAB_URL = 'about:blank';

export class TabsService {
  constructor({ container, bridge, preloadUrl }) {
    this.container = container;
    this.bridge = bridge;
    this.preloadUrl = preloadUrl;
    this.tabs = new Map();
    this.order = [];
    this.activeId = null;
    this._seq = 0;
    this.newTabUrl = null;
    this._listeners = new Map();
    this._rpcInstalled = false;
    this._installRpc();
  }

  // ---------- 事件 ----------

  on(evt, handler) {
    if (!this._listeners.has(evt)) this._listeners.set(evt, new Set());
    this._listeners.get(evt).add(handler);
    return () => this._listeners.get(evt).delete(handler);
  }

  _emit(evt, payload) {
    const set = this._listeners.get(evt);
    if (set) for (const fn of Array.from(set)) {
      try { fn(payload); } catch (err) { console.error(`[tabs] ${evt} 监听异常`, err); }
    }
  }

  _report(type, tab, extra = {}) {
    this.bridge.send('nucleus:tabs:event', {
      type,
      tab: tab ? this._public(tab) : undefined,
      tabId: tab ? tab.id : extra.tabId,
      activeId: this.activeId,
      ...extra,
    });
  }

  _public(tab) {
    return {
      id: tab.id,
      url: tab.url,
      title: tab.title || '新标签页',
      favicon: tab.favicon || null,
      loading: !!tab.loading,
      canGoBack: !!tab.canGoBack,
      canGoForward: !!tab.canGoForward,
      muted: !!tab.muted,
      audible: !!tab.audible,
      zoom: tab.zoom || 1,
      error: tab.error || null,
      webContentsId: tab.webContentsId || null,
      pinned: !!tab.pinned,
      /** 已休眠：webview 被摘掉，只留标题与地址，激活时重建 */
      sleeping: !!tab.sleeping,
      active: tab.id === this.activeId,
    };
  }

  _update(tab, patch, { silent = false } = {}) {
    Object.assign(tab, patch);
    if (!silent) this._report('updated', tab);
    this._emit('updated', this._public(tab));
  }

  // ---------- 创建 / 关闭 ----------

  /** 由引导阶段调用：把「新标签页归谁」告诉标签服务 */
  setNewTabUrl(url) {
    this.newTabUrl = url || null;
  }

  /** 一个空白标签该开到哪里 */
  blankUrl() {
    return this.newTabUrl || NEW_TAB_URL;
  }

  create(opts = {}) {
    const id = `t${++this._seq}`;
    const url = opts.url || this.blankUrl();
    const tab = {
      id,
      url,
      title: '新标签页',
      favicon: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      muted: false,
      audible: false,
      zoom: 1,
      error: null,
      webContentsId: null,
      pinned: !!opts.pinned,
      internal: url.startsWith('nucleus://'),
      sleeping: false,
      sleepingSince: 0,
      /** 最近一次处于前台的时间：休眠策略据此判断「空闲多久」 */
      lastActiveAt: Date.now(),
      wv: null,
    };

    this._spawnView(tab, url);
    this.tabs.set(id, tab);

    const index = Number.isFinite(opts.index) && opts.index >= 0
      ? Math.min(opts.index, this.order.length)
      : this.order.length;
    this.order.splice(index, 0, id);

    const shouldActivate = opts.active !== false && opts.background !== true;
    if (shouldActivate) this.activate(id);
    else this._report('created', tab);

    this._emit('created', this._public(tab));
    this.syncAll();
    return this._public(tab);
  }

  /**
   * 创建 webview 并绑定事件。
   * 抽出来是为了「休眠后唤醒」能复用同一套配置 —— 否则两处漏改就会
   * 出现「唤醒后的标签没有 preload」这类诡异问题。
   */
  _spawnView(tab, url) {
    const wv = document.createElement('webview');
    wv.className = 'tabs-view';
    wv.setAttribute('preload', this.preloadUrl);
    // 刻意不使用独立 partition：nucleus:// 协议、代理、UA、缓存清理都注册在
    // 默认会话上，分区会让这些能力对网页视图失效（页面会退回系统默认浏览器）
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('webpreferences', 'contextIsolation=yes,sandbox=no,nodeIntegration=no,webSecurity=yes');

    tab.wv = wv;
    this._bindView(tab);
    this.container.appendChild(wv);
    wv.setAttribute('src', url);
    return wv;
  }

  // ---------- 休眠 / 唤醒 ----------
  //
  // 后台标签长期不用的最大成本不是 CPU，而是整个渲染进程常驻内存。
  // 休眠就是把这个 tab 的 webview 从 DOM 里摘掉（guest 随之销毁），
  // 只留下标题/图标/URL 这些便宜的状态；再次激活时按原地址重建。
  //
  // 代价说得清楚：页面内的表单、滚动位置、播放进度都会丢。
  // 所以只休眠「后台超过 N 分钟」的普通网页标签，固定标签与内建页面永不休眠。

  suspend(id) {
    const tab = this.tabs.get(id);
    if (!tab || tab.sleeping || !tab.wv) return false;
    if (id === this.activeId) return false;
    if (tab.pinned) return false;
    if (tab.internal) return false; // nucleus:// 页面是插件界面，重建成本高且没意义
    if (!tab.url || tab.url === this.blankUrl() || tab.url === 'about:blank') return false;
    if (tab.loading) return false;

    const wv = tab.wv;
    tab.sleeping = true;
    tab.sleepingSince = Date.now();
    tab.wv = null;
    tab.webContentsId = null;
    try { wv.remove(); } catch (_) { /* 已脱离 DOM */ }
    this._update(tab, { loading: false });
    return true;
  }

  resume(id) {
    const tab = this.tabs.get(id);
    if (!tab || !tab.sleeping) return false;
    tab.sleeping = false;
    tab.sleepingSince = 0;
    this._spawnView(tab, tab.url);
    this._update(tab, { error: null });
    return true;
  }

  /**
   * 按空闲时长批量休眠。由「标签休眠」插件定时调用。
   * @param {number} maxIdleMs 空闲超过多久算可休眠
   * @param {number} keep 最近多少个标签不免（用户可能马上就要切回去）
   */
  suspendIdle(maxIdleMs, keep = 2) {
    const candidates = this.order
      .filter((id) => id !== this.activeId)
      .map((id) => this.tabs.get(id))
      .filter((t) => t && !t.sleeping && t.wv && !t.pinned && !t.internal && t.lastActiveAt);

    // 最近活跃的 keep 个先放过
    const sorted = candidates.slice().sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
    const spared = new Set(sorted.slice(0, keep).map((t) => t.id));

    let n = 0;
    for (const tab of sorted) {
      if (spared.has(tab.id)) continue;
      if (Date.now() - (tab.lastActiveAt || 0) < maxIdleMs) continue;
      if (this.suspend(tab.id)) n += 1;
    }
    return n;
  }

  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    const idx = this.order.indexOf(id);
    this.order = this.order.filter((x) => x !== id);
    this.tabs.delete(id);

    this._emit('removing', this._public(tab));
    try {
      tab.wv.remove();
    } catch (_) { /* 已经脱离 DOM */ }
    if (tab.errorEl) {
      tab.errorEl.remove();
      tab.errorEl = null;
    }

    this._report('removed', null, { tabId: id });
    this._emit('removed', { id });

    if (this.activeId === id) {
      this.activeId = null;
      const next = this.order[Math.min(idx, this.order.length - 1)];
      if (next) this.activate(next);
      else this._emit('empty', null);
    }
    this.syncAll();
    return true;
  }

  closeOthers(keepId) {
    for (const id of Array.from(this.order)) if (id !== keepId) this.close(id);
  }

  closeToRight(id) {
    const idx = this.order.indexOf(id);
    if (idx < 0) return;
    for (const other of this.order.slice(idx + 1)) this.close(other);
  }

  // ---------- 激活 ----------

  activate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    // 休眠标签被切回来：先按原地址重建，再走正常的激活逻辑
    if (tab.sleeping) this.resume(id);
    for (const other of this.tabs.values()) {
      const isActive = other.id === id;
      if (other.wv) other.wv.classList.toggle('active', isActive);
      if (other.errorEl) other.errorEl.style.display = isActive ? 'flex' : 'none';
    }
    const prev = this.activeId;
    this.activeId = id;
    tab.lastActiveAt = Date.now();
    if (prev !== id) {
      this._report('activated', tab);
      this._emit('activated', this._public(tab));
    }
    return true;
  }

  activateRelative(step) {
    const idx = this.order.indexOf(this.activeId);
    if (idx < 0) return;
    const next = (idx + step + this.order.length) % this.order.length;
    this.activate(this.order[next]);
  }

  // ---------- 视图事件 ----------

  _bindView(tab) {
    const wv = tab.wv;

    wv.addEventListener('dom-ready', () => {
      try {
        tab.webContentsId = wv.getWebContentsId();
      } catch (_) { /* 某些时刻不可用 */ }
      this._update(tab, { webContentsId: tab.webContentsId, ready: true });
    });

    wv.addEventListener('did-start-loading', () => this._update(tab, { loading: true, error: null }));

    wv.addEventListener('did-stop-loading', () => {
      this._update(tab, {
        loading: false,
        canGoBack: wv.canGoBack(),
        canGoForward: wv.canGoForward(),
        url: wv.getURL() || tab.url,
      });
    });

    wv.addEventListener('page-title-updated', (e) => {
      this._update(tab, { title: e.title || tab.title });
    });

    wv.addEventListener('page-favicon-updated', (e) => {
      const list = e.favicons || [];
      if (list.length) this._update(tab, { favicon: list[list.length - 1] });
    });

    wv.addEventListener('did-navigate', (e) => {
      this._update(tab, {
        url: e.url,
        canGoBack: wv.canGoBack(),
        canGoForward: wv.canGoForward(),
        error: null,
        internal: String(e.url).startsWith('nucleus://'),
      });
    });

    wv.addEventListener('did-navigate-in-page', (e) => {
      if (!e.isMainFrame) return;
      this._update(tab, { url: e.url });
    });

    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3 || !e.isMainFrame) return; // -3 是用户主动中断
      this.showError(tab.id, {
        code: e.errorCode,
        description: e.errorDescription || '加载失败',
        url: e.validatedURL || tab.url,
      });
    });

    wv.addEventListener('render-process-gone', (e) => {
      this.showError(tab.id, {
        code: -1,
        description: `页面进程异常退出（${e.reason || 'unknown'}）`,
        url: tab.url,
      });
    });

    wv.addEventListener('update-target-url', (e) => {
      this._emit('hover-link', { id: tab.id, url: e.url });
    });

    wv.addEventListener('found-in-page', (e) => {
      this._emit('found', { id: tab.id, result: e.result });
    });

    wv.addEventListener('audio-state-changed', (e) => {
      this._update(tab, { audible: e.audible });
    });

    wv.addEventListener('context-menu', (e) => {
      this._emit('context-menu', { id: tab.id, params: e.params, x: e.params?.x, y: e.params?.y });
    });
  }

  // ---------- 导航 ----------

  /** 休眠中的标签在被操作时先唤醒，避免所有方法各写一遍 if */
  _ensureView(tab) {
    if (!tab) return null;
    if (tab.wv) return tab.wv;
    if (tab.sleeping) {
      this.resume(tab.id);
      return tab.wv;
    }
    return null;
  }

  navigate(id, url) {
    const tab = this.tabs.get(id);
    if (!tab || !url) return false;
    tab.error = null;
    this._hideError(tab);
    // 休眠标签直接按新地址重建，不要先加载旧地址再跳转（会白闪一下）
    if (tab.sleeping) {
      tab.sleeping = false;
      tab.sleepingSince = 0;
      tab.url = url;
      this._spawnView(tab, url);
      this._update(tab, { url, error: null });
      return true;
    }
    if (!tab.wv) return false;
    tab.wv.setAttribute('src', url);
    this._update(tab, { url, error: null });
    return true;
  }

  reload(id, hard = false) {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    if (tab.error) {
      this._hideError(tab);
      this.navigate(id, tab.error.failedUrl || tab.url);
      return true;
    }
    if (!this._ensureView(tab)) return false;
    if (hard) tab.wv.reloadIgnoringCache();
    else tab.wv.reload();
    return true;
  }

  stop(id) {
    const tab = this.tabs.get(id);
    if (tab && tab.wv) {
      try { tab.wv.stop(); } catch (_) { /* ignore */ }
    }
  }

  goBack(id) {
    const tab = this.tabs.get(id);
    if (!this._ensureView(tab)) return false;
    if (tab.wv.canGoBack()) { tab.wv.goBack(); return true; }
    return false;
  }

  goForward(id) {
    const tab = this.tabs.get(id);
    if (!this._ensureView(tab)) return false;
    if (tab.wv.canGoForward()) { tab.wv.goForward(); return true; }
    return false;
  }

  setZoom(id, factor) {
    const tab = this.tabs.get(id);
    if (!tab) return 1;
    const v = Math.max(0.25, Math.min(5, factor));
    try { if (this._ensureView(tab)) tab.wv.setZoomFactor(v); } catch (_) { /* ignore */ }
    this._update(tab, { zoom: v });
    return v;
  }

  toggleMute(id) {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    try {
      if (!this._ensureView(tab)) return false;
      const next = !tab.wv.isAudioMuted();
      tab.wv.setAudioMuted(next);
      this._update(tab, { muted: next });
      return next;
    } catch (_) {
      return false;
    }
  }

  duplicate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    return this.create({ url: tab.url, active: true, index: this.order.indexOf(id) + 1 });
  }

  reorder(from, to) {
    const fromIdx = typeof from === 'number' ? from : this.order.indexOf(from);
    if (fromIdx < 0) return false;
    const [moved] = this.order.splice(fromIdx, 1);
    this.order.splice(Math.max(0, Math.min(to, this.order.length)), 0, moved);
    this._report('reordered', null, { activeId: this.order });
    this._emit('reordered', this.order.slice());
    return true;
  }

  // ---------- 页面操作 ----------

  async execute(id, code) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('标签不存在');
    if (!this._ensureView(tab)) throw new Error('标签已休眠且无法唤醒');
    return tab.wv.executeJavaScript(code, true);
  }

  async insertCss(id, css) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('标签不存在');
    if (!this._ensureView(tab)) throw new Error('标签已休眠且无法唤醒');
    return tab.wv.insertCSS(css);
  }

  find(id, text, options = {}) {
    const tab = this.tabs.get(id);
    if (!tab || !this._ensureView(tab)) return null;
    return tab.wv.findInPage(String(text), options);
  }

  stopFind(id, action = 'clearSelection') {
    const tab = this.tabs.get(id);
    if (tab && tab.wv) tab.wv.stopFindInPage(action);
  }

  async capture(id, pluginId = 'core') {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('标签不存在');
    return this.bridge.invoke('nucleus:tabs:capture', { pluginId, tabId: id });
  }

  webview(id) {
    const tab = this.tabs.get(id);
    return tab ? tab.wv : null;
  }

  // ---------- 错误层 ----------

  showError(id, info) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.error = { ...info, failedUrl: info.url };
    this._hideError(tab);

    const box = h('div', { class: 'tab-error' },
      h('div', { class: 'tab-error-inner' },
        h('div', { class: 'te-code' }, info.code === -1 ? '页面已崩溃' : '无法访问此页面'),
        h('div', { class: 'te-desc' }, info.description || ''),
        h('div', { class: 'te-url mono ellipsis' }, info.url || ''),
        h('button', {
          class: 'btn',
          onclick: () => {
            this._hideError(tab);
            this.navigate(id, info.url || tab.url);
          },
        }, '重新加载')
      )
    );
    box.dataset.tab = id;
    tab.errorEl = box;
    this.container.appendChild(box);

    // 错误层浮在 webview 之上（z-index 2），webview 本身保持 active 状态
    box.style.display = this.activeId === id ? 'flex' : 'none';
    this._emit('error', { id, info });
  }

  _hideError(tab) {
    if (tab.errorEl) {
      tab.errorEl.remove();
      tab.errorEl = null;
    }
    tab.error = null;
  }

  // ---------- 与主进程同步 ----------

  syncAll() {
    this.bridge.invoke('nucleus:tabs:sync-from-renderer', {
      pluginId: 'core',
      tabs: this.order.map((id) => this._public(this.tabs.get(id))).filter(Boolean),
      activeId: this.activeId,
    }).catch(() => { /* 启动早期可能还没就绪 */ });
  }

  _installRpc() {
    if (this._rpcInstalled) return;
    this._rpcInstalled = true;
    this.bridge.on('nucleus:rpc', async (msg) => {
      const { id, method, payload } = msg || {};
      try {
        const result = await this._handle(method, payload || {});
        this.bridge.send('nucleus:rpc:res', { id, ok: true, result });
      } catch (err) {
        this.bridge.send('nucleus:rpc:res', { id, ok: false, error: err.message });
      }
    });
  }

  async _handle(method, p) {
    switch (method) {
      case 'tabs.create': return this.create(p);
      case 'tabs.close': return this.close(p.id);
      case 'tabs.activate': return this.activate(p.id);
      case 'tabs.navigate': return this.navigate(p.id, p.url);
      case 'tabs.reload': return this.reload(p.id, p.hard);
      case 'tabs.stop': return this.stop(p.id);
      case 'tabs.goBack': return this.goBack(p.id);
      case 'tabs.goForward': return this.goForward(p.id);
      case 'tabs.setZoom': return this.setZoom(p.id, p.factor);
      case 'tabs.toggleMute': return this.toggleMute(p.id);
      case 'tabs.duplicate': return this.duplicate(p.id);
      case 'tabs.reorder': return this.reorder(p.from, p.to);
      case 'ui.toast': this._emit('toast', p); return true;
      default: throw new Error(`未知方法：${method}`);
    }
  }

  /** 按 id 取单个标签（插件 API 的 nucleus.tabs.get 走这里） */
  get(id) {
    const tab = this.tabs.get(id);
    return tab ? this._public(tab) : null;
  }

  /**
   * 查找结果回填。
   * 不依赖 <webview> 的 found-in-page 事件（在 Chromium 108 的 webview 里不派发），
   * 改由主进程监听 guest 的 webContents 后转发进来。
   */
  handleFound(payload) {
    if (payload && payload.id) this._emit('found', payload);
  }

  get all() {
    return this.order.map((id) => this._public(this.tabs.get(id))).filter(Boolean);
  }

  get active() {
    return this.activeId ? this._public(this.tabs.get(this.activeId)) : null;
  }
}
