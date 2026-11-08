'use strict';
/**
 * 窗口服务：只负责「一个主窗口」的创建与状态持久化。
 * 多窗口不是核的能力 —— 需要多窗口的插件自己通过 tabs 打开新标签。
 */
const path = require('path');
const { BrowserWindow, screen, shell, webContents } = require('electron');
const { JsonStore } = require('./store');
const { userDataFile } = require('./paths');
const { EventBus } = require('./bus');

class WindowService {
  constructor({ bus }) {
    this.bus = bus || new EventBus();
    this.win = null;
    this.state = new JsonStore(userDataFile('window-state.json'), {
      bounds: { width: 1280, height: 820 },
      maximized: false,
    });
    this._saveTimer = null;
  }

  get mainId() {
    return this.win && !this.win.isDestroyed() ? this.win.id : null;
  }

  create({ frameless = true } = {}) {
    const saved = this.state.get('bounds', { width: 1280, height: 820 });
    const bounds = this._sanitizeBounds(saved);

    this.win = new BrowserWindow({
      ...bounds,
      minWidth: 620,
      minHeight: 420,
      show: false,
      frame: !!frameless ? false : true,
      thickFrame: true,
      backgroundColor: '#1b1d21',
      title: 'Nucleus',
      icon: path.join(__dirname, '..', '..', '..', 'build', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'chrome-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: true,
        spellcheck: false,
        backgroundThrottling: false,
        // Win7 上部分机器缺少 GPU 合成能力，交给命令行开关统一处理
      },
    });

    if (this.state.get('maximized')) this.win.maximize();

    // 核的 UI 页面不允许开新窗口；网页的 window.open 由渲染层交给 tabs 处理
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());

    this.win.once('ready-to-show', () => this.win.show());

    const persist = () => this._scheduleSave();
    this.win.on('resize', persist);
    this.win.on('move', persist);
    this.win.on('maximize', () => {
      this._scheduleSave();
      this.bus.emit('window:maximized', true);
    });
    this.win.on('unmaximize', () => {
      this._scheduleSave();
      this.bus.emit('window:maximized', false);
    });
    this.win.on('closed', () => {
      this.bus.emit('window:closed');
      this.win = null;
    });

    for (const evt of ['enter-full-screen', 'leave-full-screen', 'blur', 'focus']) {
      this.win.on(evt, () => this.bus.emit(`window:${evt}`));
    }

    return this.win;
  }

  _sanitizeBounds(b) {
    const width = Math.max(620, Math.min(Number(b.width) || 1280, 8000));
    const height = Math.max(420, Math.min(Number(b.height) || 820, 8000));
    let x = Number.isFinite(b.x) ? b.x : undefined;
    let y = Number.isFinite(b.y) ? b.y : undefined;

    // 屏幕分辨率变化后，旧坐标可能落在可见区域之外
    if (x !== undefined && y !== undefined) {
      const displays = screen.getAllDisplays();
      const visible = displays.some((d) => {
        const a = d.workArea;
        return x + 80 > a.x && x < a.x + a.width - 40 && y + 40 > a.y && y < a.y + a.height - 20;
      });
      if (!visible) {
        x = undefined;
        y = undefined;
      }
    }
    return x === undefined ? { width, height } : { width, height, x, y };
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveNow();
    }, 400);
  }

  _saveNow() {
    if (!this.win || this.win.isDestroyed()) return;
    const maximized = this.win.isMaximized();
    const bounds = maximized
      ? this.win.getNormalBounds()
      : this.win.getBounds();
    this.state.merge({ bounds, maximized });
    this.state.flush();
  }

  minimize() {
    if (this.win) this.win.minimize();
  }

  toggleMaximize() {
    if (!this.win) return;
    if (this.win.isMaximized()) this.win.unmaximize();
    else this.win.maximize();
  }

  isMaximized() {
    return !!(this.win && this.win.isMaximized());
  }

  setTitle(t) {
    if (this.win) this.win.setTitle(t || 'Nucleus');
  }

  toggleFullScreen() {
    if (this.win) this.win.setFullScreen(!this.win.isFullScreen());
  }

  close() {
    if (this.win) this.win.close();
  }

  on(evt, handler) {
    return this.bus.on(`window:${evt}`, handler);
  }

  openExternal(url) {
    if (/^https?:/i.test(url)) return shell.openExternal(url);
    return Promise.resolve();
  }

  /** 把事件推给某个插件的所有内部页面（nucleus://<pluginId>/...） */
  sendToPages(pluginId, event, payload) {
    let sent = 0;
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue;
      let url = '';
      try { url = wc.getURL(); } catch (_) { continue; }
      if (!url.startsWith(`nucleus://${pluginId}/`)) continue;
      try {
        wc.send(`nucleus:content:${event}`, payload);
        sent += 1;
      } catch (_) { /* 页面已关闭 */ }
    }
    return sent;
  }

  /** 把事件推给壳页面（浏览器 UI 本身） */
  sendToShell(channel, payload) {
    if (!this.win || this.win.isDestroyed()) return 0;
    try {
      this.win.webContents.send(channel, payload);
      return 1;
    } catch (_) {
      return 0;
    }
  }

  persistNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._saveNow();
  }
}

module.exports = { WindowService };
