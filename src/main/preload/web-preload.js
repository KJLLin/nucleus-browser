'use strict';
/**
 * 网页侧 preload（注入每个 <webview>）。
 *
 * 职责只有两件：
 *   1. 按插件的 contentScripts 声明，把匹配当前 URL 的脚本注入页面（isolated world，
 *      拿得到 DOM，拿不到页面的 JS 变量）；
 *   2. 提供一个极小的消息桥，让内容脚本可以请求核的能力。
 * 它不向页面暴露任何 Node 能力。
 */
const { ipcRenderer, contextBridge } = require('electron');

const pageUrl = (() => {
  try { return window.location.href; } catch (_) { return ''; }
})();

let matched = [];
try {
  matched = ipcRenderer.sendSync('nucleus:content:match', { url: pageUrl }) || [];
} catch (_) {
  matched = [];
}

const injected = new Set();

function inject(list) {
  if (!list.length) return;
  for (const item of list) {
    if (injected.has(item.key)) continue;
    injected.add(item.key);
    try {
      if (item.css) {
        const style = document.createElement('style');
        style.setAttribute('data-nucleus-plugin', item.pluginId);
        style.textContent = item.css;
        (document.head || document.documentElement).appendChild(style);
      }
      if (item.js) {
        // 在 preload 的隔离世界中执行：可操作 DOM，但与页面脚本互不干扰
        (0, eval)(`(function(){${item.js}\n})()`);
      }
    } catch (err) {
      console.warn(`[nucleus] 内容脚本 ${item.pluginId} 执行失败`, err);
    }
  }
}

// 内部页面：在首帧之前就把主题写进 <html>，避免白闪
let boot = {};
if (pageUrl.startsWith('nucleus://')) {
  try {
    boot = ipcRenderer.sendSync('nucleus:bootstrap-sync') || {};
    const theme = boot.theme === 'light' ? 'light' : 'dark';
    if (document.documentElement) {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
    }
    ipcRenderer.on('nucleus:theme', (_e, payload) => {
      const next = payload && payload.theme === 'light' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      document.documentElement.style.colorScheme = next;
    });
  } catch (_) { /* 主进程尚未就绪 */ }
}

function whenReady(fn) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

const early = matched.filter((x) => x.runAt === 'document_start');
const late = matched.filter((x) => x.runAt !== 'document_start');

inject(early);
if (late.length) whenReady(() => inject(late));

const api = {
  /**
   * 内部页面 RPC：只有 nucleus:// 页面能用，普通网站调用会被主进程拒绝。
   * 这是设置页、插件自带页面获得数据的方式。
   */
  rpc(method, payload) {
    return ipcRenderer.invoke('nucleus:page:rpc', { url: pageUrl, method, payload });
  },

  /** 内容脚本可用的最小桥 */
  send(event, payload) {
    ipcRenderer.send('nucleus:content:message', { url: pageUrl, event, payload });
  },
  on(event, handler) {
    ipcRenderer.on(`nucleus:content:${event}`, (_e, payload) => {
      try { handler(payload); } catch (err) { console.warn(err); }
    });
  },
  info: {
    url: pageUrl,
    version: process.versions.chrome,
    /** 当前新标签页的地址，由声明 contributes.newTab 的插件决定 */
    newTabUrl: boot.newTabUrl || null,
  },
};

try {
  contextBridge.exposeInMainWorld('__nucleus', api);
} catch (_) {
  // iframe 等场景下 contextBridge 可能不可用，忽略即可
}

// ---------------------------------------------------------------- 浏览器扩展
//
// 扩展页面（popup / background / options）与内容脚本是两种宿主：
//   页面：有 preload，直接暴露 chrome.* 对象
//   内容脚本：在 isolated world，只能 postMessage 出来，由这里转 IPC
// 两条路径的身份都由主进程校验（页面看 sender，内容脚本看 token）。

const extMatch = pageUrl.match(/^nucleus:\/\/ext-([^/]+)\//);
if (extMatch) {
  const extId = extMatch[1];
  let manifest = {};
  try {
    manifest = ipcRenderer.sendSync('nucleus:ext:manifest-sync', extId) || {};
  } catch (_) { /* 主进程未就绪 */ }

  try {
    const { pageApi } = require('../core/ext-shim');
    // 注意不能直接暴露成 chrome：Chromium 在每个页面都内置了一个只读的
    // window.chrome（loadTimes/csi 之类），contextBridge 覆盖它会失败。
    // 改成暴露 __nucleusChrome，再由协议层注入的一小段脚本合并进 window.chrome。
    contextBridge.exposeInMainWorld('__nucleusChrome', pageApi({ ipcRenderer, extId, manifest }));
  } catch (err) {
    console.warn(`[ext:${extId}] 暴露扩展 API 失败`, err.message);
  }
}

window.addEventListener('message', async (event) => {
  const data = event.data;
  if (!data || !data.__nucleusExt) return;
  const req = data.__nucleusExt;
  if (!req.token || !req.id) return;

  try {
    const value = await ipcRenderer.invoke('nucleus:ext:bridge', {
      token: req.token,
      op: req.op,
      args: req.args || [],
    });
    window.postMessage({ __nucleusExtReply: req.id, ok: true, value }, '*');
  } catch (err) {
    window.postMessage({
      __nucleusExtReply: req.id,
      ok: false,
      error: String(err && err.message ? err.message : err),
    }, '*');
  }
});
