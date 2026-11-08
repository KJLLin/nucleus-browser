'use strict';
/**
 * 标签页镜像 + 指令下发。
 *
 * 真实的 <webview> 元素活在渲染层（只有那里才能做任意层级的 UI 叠放），
 * 主进程因此维护一份只读镜像：插件在主进程侧读状态是同步的，写操作则通过
 * RPC 交给渲染层执行。这样插件无论跑在哪一侧，看到的都是同一套 tabs API。
 */

class TabMirror {
  constructor({ bus }) {
    this.bus = bus;
    this.chrome = null; // BrowserWindow
    this.tabs = new Map();
    this.order = [];
    this.activeId = null;
    this._seq = 0;
    this._pending = new Map();
  }

  attach(chromeWin) {
    this.chrome = chromeWin;
  }

  detach() {
    this.chrome = null;
  }

  // ---------- RPC ----------

  _rpc(method, payload, timeout = 6000) {
    if (!this.chrome || this.chrome.isDestroyed()) {
      return Promise.reject(new Error('浏览器窗口尚未就绪'));
    }
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`渲染层响应超时：${method}`));
      }, timeout);
      this._pending.set(id, { resolve, reject, timer });
      this.chrome.webContents.send('nucleus:rpc', { id, method, payload });
    });
  }

  handleRpcResponse({ id, ok, result, error }) {
    const slot = this._pending.get(id);
    if (!slot) return;
    this._pending.delete(id);
    clearTimeout(slot.timer);
    if (ok) slot.resolve(result);
    else slot.reject(new Error(error || '渲染层执行失败'));
  }

  // ---------- 渲染层上报 ----------

  applySync(payload) {
    this.tabs.clear();
    for (const t of payload.tabs || []) this.tabs.set(t.id, t);
    this.order = (payload.tabs || []).map((t) => t.id);
    this.activeId = payload.activeId || null;
  }

  applyEvent({ type, tab, tabId, activeId }) {
    if (type === 'created' && tab) {
      this.tabs.set(tab.id, tab);
      if (!this.order.includes(tab.id)) this.order.push(tab.id);
    } else if (type === 'updated' && tab) {
      this.tabs.set(tab.id, Object.assign({}, this.tabs.get(tab.id) || {}, tab));
    } else if (type === 'removed') {
      this.tabs.delete(tabId);
      this.order = this.order.filter((x) => x !== tabId);
    } else if (type === 'activated') {
      this.activeId = tabId || activeId || null;
    } else if (type === 'reordered' && Array.isArray(activeId)) {
      this.order = activeId;
    }
    if (activeId !== undefined && type !== 'reordered') this.activeId = activeId || this.activeId;
    this.bus.emit(`tabs:${type}`, tab || { id: tabId });
    this.bus.emit('tabs:any', { type, tab, tabId });
  }

  // ---------- 读 ----------

  list() {
    return this.order
      .map((id) => this.tabs.get(id))
      .filter(Boolean)
      .map((t) => Object.assign({}, t, { active: t.id === this.activeId }));
  }

  get(id) {
    return this.tabs.get(id) || null;
  }

  active() {
    return this.activeId ? this.get(this.activeId) : null;
  }

  findByUrl(url) {
    for (const t of this.tabs.values()) if (t.url === url) return t;
    return null;
  }

  /** 供快捷键、右键菜单等场景按 webContentsId 反查标签 */
  findByWebContentsId(wcId) {
    for (const t of this.tabs.values()) if (t.webContentsId === wcId) return t;
    return null;
  }

  // ---------- 写（转发渲染层） ----------

  create(opts = {}) {
    return this._rpc('tabs.create', {
      url: opts.url || null,
      active: opts.active !== false,
      background: opts.background === true,
      index: Number.isFinite(opts.index) ? opts.index : -1,
      pinned: opts.pinned === true,
    });
  }

  close(id) {
    return this._rpc('tabs.close', { id });
  }

  activate(id) {
    return this._rpc('tabs.activate', { id });
  }

  navigate(id, url) {
    return this._rpc('tabs.navigate', { id, url });
  }

  reload(id) {
    return this._rpc('tabs.reload', { id, hard: false });
  }

  hardReload(id) {
    return this._rpc('tabs.reload', { id, hard: true });
  }

  stop(id) {
    return this._rpc('tabs.stop', { id });
  }

  goBack(id) {
    return this._rpc('tabs.goBack', { id });
  }

  goForward(id) {
    return this._rpc('tabs.goForward', { id });
  }

  setZoom(id, factor) {
    return this._rpc('tabs.setZoom', { id, factor });
  }

  toggleMute(id) {
    return this._rpc('tabs.toggleMute', { id });
  }

  duplicate(id) {
    return this._rpc('tabs.duplicate', { id });
  }

  reorder(from, to) {
    return this._rpc('tabs.reorder', { from, to });
  }

  /** 广播给 chrome UI（插件 UI 会收到 nucleus:bus 事件） */
  broadcast(channel, payload) {
    if (!this.chrome || this.chrome.isDestroyed()) return;
    this.chrome.webContents.send(channel, payload);
  }

  on(evt, handler) {
    return this.bus.on(`tabs:${evt}`, handler);
  }
}

module.exports = { TabMirror };
