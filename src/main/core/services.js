'use strict';
/**
 * 若干小服务：命令注册表、下载、通知、会话。
 * 它们体量都小，且同为「核提供给插件的通用能力」，因此放在一起。
 */
const { Notification, shell, clipboard } = require('electron');

class CommandRegistry {
  constructor({ bus }) {
    this.bus = bus;
    this.map = new Map(); // id -> {owner, fn}
  }

  register(id, fn, owner = 'core') {
    if (typeof fn !== 'function') throw new TypeError('命令处理器必须是函数');
    this.map.set(id, { owner, fn });
    return () => {
      const cur = this.map.get(id);
      if (cur && cur.fn === fn) this.map.delete(id);
    };
  }

  unregisterOwner(owner) {
    for (const [id, rec] of this.map) if (rec.owner === owner) this.map.delete(id);
  }

  has(id) {
    return this.map.has(id);
  }

  async execute(id, ...args) {
    const rec = this.map.get(id);
    if (!rec) throw new Error(`命令未注册：${id}`);
    return rec.fn(...args);
  }

  list() {
    return Array.from(this.map.entries()).map(([id, rec]) => ({ id, owner: rec.owner }));
  }
}

class DownloadService {
  constructor({ bus }) {
    this.bus = bus;
    this.items = [];
    this._seq = 0;
    this._listeners = new Set();
    /**
     * id -> Electron DownloadItem。
     * 刻意不挂在 rec 上：rec 会被 IPC 序列化送进渲染层，
     * 而 DownloadItem 是不可克隆的原生对象，混进去会直接让整条通道抛错。
     */
    this.handles = new Map();
  }

  install(session) {
    session.on('will-download', (event, item, webContents) => {
      const id = ++this._seq;
      const rec = {
        id,
        filename: item.getFilename(),
        url: item.getURL(),
        mimeType: item.getMimeType(),
        totalBytes: item.getTotalBytes(),
        receivedBytes: 0,
        savePath: item.getSavePath(),
        state: 'progressing',
        startedAt: Date.now(),
        endedAt: null,
        paused: false,
        canResume: false,
      };
      this.items.unshift(rec);
      this.handles.set(id, item);
      if (this.items.length > 200) this.items.length = 200;
      this.bus.emit('downloads:started', Object.assign({}, rec));

      const update = () => {
        rec.receivedBytes = item.getReceivedBytes();
        rec.totalBytes = item.getTotalBytes() || rec.totalBytes;
        rec.savePath = item.getSavePath() || rec.savePath;
        rec.paused = item.isPaused();
        rec.canResume = item.canResume();
        this.bus.emit('downloads:updated', Object.assign({}, rec));
      };

      item.on('updated', update);
      item.on('done', (_e, state) => {
        rec.state = state; // completed | cancelled | interrupted
        rec.receivedBytes = item.getReceivedBytes();
        rec.paused = false;
        rec.canResume = false;
        rec.endedAt = Date.now();
        this.handles.delete(id);
        this.bus.emit('downloads:done', Object.assign({}, rec));
      });
    });
  }

  /**
   * 暂停 / 继续 / 取消。
   * 只有这三个动作暴露给插件 —— 下载项能做的事还有很多（改保存路径、改 UA…），
   * 但那些属于「策略」，该由宿主决定，不该成为插件的能力面。
   */
  control(id, action) {
    const item = this.handles.get(Number(id));
    if (!item) throw new Error('下载任务不存在或已结束');
    if (action === 'pause') {
      if (!item.isPaused()) item.pause();
    } else if (action === 'resume') {
      if (item.canResume()) item.resume();
      else throw new Error('该下载已无法继续');
    } else if (action === 'cancel') {
      item.cancel();
    } else {
      throw new Error(`未知的下载操作：${action}`);
    }
    return true;
  }

  on(handler, owner) {
    const wrapped = (payload) => handler(payload);
    wrapped.__owner = `plugin:${owner}`;
    const offs = [
      this.bus.on('downloads:started', wrapped),
      this.bus.on('downloads:updated', wrapped),
      this.bus.on('downloads:done', wrapped),
    ];
    this._listeners.add(wrapped);
    return () => {
      offs.forEach((off) => off());
      this._listeners.delete(wrapped);
    };
  }

  list() {
    return this.items.map((x) => Object.assign({}, x));
  }

  openFolder(p) {
    if (p) shell.showItemInFolder(p);
  }
}

class NotificationService {
  show(title, body) {
    if (!Notification.isSupported()) return false;
    try {
      new Notification({ title: String(title), body: String(body), silent: false }).show();
      return true;
    } catch (_) {
      return false;
    }
  }
}

class SessionService {
  constructor({ session, bus }) {
    this.session = session;
    this.bus = bus;
    this._baseUA = session.getUserAgent();
  }

  setProxy(config) {
    // config: {mode:'direct'|'system'|'fixed', server?, bypass?}
    if (!config || config.mode === 'system') return this.session.setProxy({ mode: 'system' });
    if (config.mode === 'direct') return this.session.setProxy({ mode: 'direct' });
    if (config.mode === 'fixed') {
      return this.session.setProxy({
        mode: 'fixed_servers',
        proxyRules: String(config.server || ''),
        proxyBypassRules: String(config.bypass || '<local>'),
      });
    }
    return Promise.resolve();
  }

  getUserAgent() {
    return this.session.getUserAgent();
  }

  setUserAgent(ua) {
    this.session.setUserAgent(ua || this._baseUA);
    this.bus.emit('session:user-agent-changed', ua || this._baseUA);
  }

  clearCache() {
    return this.session.clearCache();
  }

  clearStorage() {
    return this.session.clearStorageData();
  }
}

module.exports = { CommandRegistry, DownloadService, NotificationService, SessionService, clipboard, shell };
