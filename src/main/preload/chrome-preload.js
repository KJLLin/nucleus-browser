'use strict';
/**
 * 浏览器 UI（chrome 层）的 preload。
 *
 * 只暴露一条极窄的通道：invoke / send / on，channel 前缀固定为 nucleus:。
 * 渲染进程拿不到 Node，也拿不到 ipcRenderer 本体。
 *
 * 关于「一次性取走」：
 *   壳页面和插件运行在同一个 JS 世界里，如果 `window.nucleusBridge` 一直挂着，
 *   任何插件都能绕过 nucleus.invoke（以及它的 pluginId 归属）直接发 IPC，
 *   那么主进程那侧的权限校验就形同虚设。
 *   所以这里不常驻暴露，而是给一个只能成功一次的取件口：
 *   引导脚本（app.js）在加载任何插件之前把它取走并删除，
 *   之后插件只能通过 nucleus.invoke 走受控通道。
 */
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_ALLOW = /^nucleus:[a-zA-Z0-9:_-]+$/;
const EVENT_ALLOW = /^nucleus:[a-zA-Z0-9:_-]+$/;

const listeners = new Map();

/**
 * 订阅主进程事件。
 *
 * 注意这里**不能再套一层 `(_event, payload) => handler(payload)`**：
 * ipcRenderer 的回调已经剥掉了 IpcRendererEvent，再包一层会让 handler
 * 收到的是事件的第一个参数（undefined），表现为「事件来了但数据全空」。
 * 之前快捷键、总线广播、下载进度全部静默失效，就是这一行的问题。
 */
function on(channel, handler) {
  if (!EVENT_ALLOW.test(channel)) throw new Error(`非法 channel: ${channel}`);
  if (typeof handler !== 'function') throw new TypeError('handler 必须是函数');
  if (!listeners.has(channel)) {
    listeners.set(channel, new Set());
    ipcRenderer.on(channel, (_e, payload) => {
      const set = listeners.get(channel);
      if (!set) return;
      for (const fn of Array.from(set)) {
        try { fn(payload); } catch (err) { console.error(`[bridge] ${channel} 处理异常`, err); }
      }
    });
  }
  listeners.get(channel).add(handler);
  return () => {
    const set = listeners.get(channel);
    if (set) set.delete(handler);
  };
}

const bridge = {
  invoke(channel, payload) {
    if (!INVOKE_ALLOW.test(channel)) return Promise.reject(new Error(`非法 channel: ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  send(channel, payload) {
    if (!INVOKE_ALLOW.test(channel)) throw new Error(`非法 channel: ${channel}`);
    ipcRenderer.send(channel, payload);
  },
  on,
  platform: process.platform,
  /**
   * 调试模式：壳会把 app 对象挂到 window 上，方便 DevTools 里检查插件树。
   * 注意它和 NUCLEUS_DEV_BRIDGE 是两件事 —— 后者会常驻暴露裸 IPC，
   * 只在手工调试主进程通道时才该打开。
   */
  devMode: process.env.NUCLEUS_DEV_TOOLS === '1',
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
};

let taken = false;
const devBridge = process.env.NUCLEUS_DEV_BRIDGE === '1';

contextBridge.exposeInMainWorld('__nucleusTakeBridge', () => {
  if (taken && !devBridge) {
    throw new Error('nucleusBridge 已被取走：插件必须通过 nucleus API 调用核能力');
  }
  taken = true;
  return bridge;
});

if (devBridge) {
  // 仅在显式开启调试时保留常驻入口，方便在 DevTools 里手工调用
  contextBridge.exposeInMainWorld('nucleusBridge', bridge);
}
