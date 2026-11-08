'use strict';
const { recordEvent } = require('./runtime-state');

/**
 * 核级事件总线。
 * 插件之间不直接 require 彼此，只通过总线和命令通信 —— 这是「一切皆插件」
 * 能保持松耦合的前提。
 */
class EventBus {
  constructor() {
    this._map = new Map();
    this._bridge = null;
  }

  /**
   * 把主进程侧的事件镜像到渲染层，让两侧插件收到同一份信号。
   * 由 main.js 注入，避免 bus 直接依赖 BrowserWindow。
   */
  setBridge(fn) {
    this._bridge = fn;
  }

  on(event, handler) {
    if (typeof handler !== 'function') throw new TypeError('handler 必须是函数');
    if (!this._map.has(event)) this._map.set(event, new Set());
    this._map.get(event).add(handler);
    return () => this.off(event, handler);
  }

  once(event, handler) {
    const off = this.on(event, (...args) => {
      off();
      handler(...args);
    });
    return off;
  }

  off(event, handler) {
    const set = this._map.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this._map.delete(event);
  }

  emit(event, ...args) {
    // 插件侧 emit 会把自己 id 作为最后一个参数带上（见渲染层 nucleus.bus.emit）
    let owner = null;
    if (args.length > 1 && typeof args[args.length - 1] === 'string') owner = args.pop();
    recordEvent(event, owner);

    const set = this._map.get(event);
    if (set) {
      // 复制一份，避免回调中增删监听导致遍历异常
      for (const handler of Array.from(set)) {
        try {
          handler(...args);
        } catch (err) {
          console.error(`[bus] 监听器异常 @ ${event}`, err);
        }
      }
    }

    // tabs:* 由渲染层自己产生，回传会形成回声，故不桥接
    if (this._bridge && !String(event).startsWith('tabs:')) {
      try {
        this._bridge(String(event), args[0]);
      } catch (_) { /* 无法结构化克隆的负载直接丢弃 */ }
    }
  }

  /** 移除某个插件注册的全部监听：插件卸载时的兜底 */
  removeOwner(ownerTag) {
    for (const [event, set] of this._map) {
      for (const handler of set) {
        if (handler.__owner === ownerTag) set.delete(handler);
      }
      if (set.size === 0) this._map.delete(event);
    }
  }
}

module.exports = { EventBus };
