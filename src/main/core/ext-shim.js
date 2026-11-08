'use strict';
/**
 * 扩展 API 垫片。
 *
 * 两个宿主，两种注入方式：
 *
 *   内容脚本（isolated world）—— 没有 preload 权限，只能用 postMessage
 *     与 main world 的 web-preload 通信，再由它转 IPC。
 *   扩展页面（popup / background，nucleus://ext-*）—— 有 preload，
 *     直接走 ipcRenderer，onMessage 也能真正收到消息。
 *
 * 只实现子集：runtime / storage.local / tabs / i18n。没实现的 api 不假装存在，
 * 免得扩展以为自己能用、跑到一半才炸。
 */

/** 内容脚本用的垫片源码（字符串，注入到 isolated world） */
function contentShim(extId, token, manifest) {
  return `
(function () {
  var EXT_ID = ${JSON.stringify(extId)};
  var TOKEN = ${JSON.stringify(token)};
  var MANIFEST = ${JSON.stringify(manifest)};
  var seq = 0;
  var pending = new Map();

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || !d.__nucleusExtReply) return;
    var p = pending.get(d.__nucleusExtReply);
    if (!p) return;
    pending.delete(d.__nucleusExtReply);
    if (p.ok) p.resolve(p.value);
    else p.reject(new Error(p.error || 'extension call failed'));
  });

  function call(op, args) {
    return new Promise(function (resolve, reject) {
      var id = 'e' + (++seq) + '.' + Math.random().toString(36).slice(2);
      pending.set(id, { resolve: resolve, reject: reject });
      window.postMessage({ __nucleusExt: { token: TOKEN, op: op, args: args || [], id: id } }, '*');
      setTimeout(function () {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('extension call timeout: ' + op));
        }
      }, 8000);
    });
  }

  function withCallback(promise, cb) {
    if (typeof cb === 'function') {
      promise.then(function (v) { cb(v); }).catch(function () { cb(undefined); });
    }
    return promise;
  }

  function storageCall(op, arg, cb, fallback) {
    var p = call(op, [arg]);
    if (typeof cb === 'function') {
      p.then(function (v) { cb(v === undefined ? fallback : v); })
        .catch(function () { cb(fallback); });
    }
    return p;
  }

  var chrome = {
    runtime: {
      id: EXT_ID,
      getManifest: function () { return MANIFEST; },
      getURL: function (p) { return 'nucleus://ext-' + EXT_ID + '/' + String(p || '').replace(/^\\//, ''); },
      sendMessage: function () {
        var args = Array.prototype.slice.call(arguments);
        return withCallback(call('sendMessage', [args[0]]), args.find(function (x) { return typeof x === 'function'; }));
      },
      connect: function () { throw new Error('chrome.runtime.connect 尚未支持'); },
      onMessage: { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } },
      onInstalled: { addListener: function () {} },
      lastError: undefined
    },
    storage: {
      local: {
        get: function (k, cb) { return storageCall('storage.get', k, cb, {}); },
        set: function (v, cb) { return storageCall('storage.set', v, cb); },
        remove: function (k, cb) { return storageCall('storage.remove', k, cb); },
        clear: function (cb) { return storageCall('storage.clear', null, cb); },
        onChanged: { addListener: function () {} }
      }
    },
    tabs: {
      query: function (q, cb) { return withCallback(call('tabs.query', [q]), cb); },
      sendMessage: function (id, msg, cb) { return withCallback(call('tabs.sendMessage', [id, msg]), cb); }
    },
    i18n: {
      getMessage: function (key, fallback) { return fallback || key; }
    }
  };
  chrome.storage.sync = chrome.storage.local;

  try {
    Object.defineProperty(globalThis, 'chrome', { value: chrome, writable: true, configurable: true });
  } catch (e) {
    globalThis.chrome = chrome;
  }
  try {
    Object.defineProperty(globalThis, 'browser', { value: chrome, writable: true, configurable: true });
  } catch (e) {
    globalThis.browser = chrome;
  }
})();
`;
}

/**
 * 扩展页面用的 ipc 桥（在 preload 里调用，返回可暴露给页面的对象）。
 * 传的是函数与普通对象，contextBridge 会自动代理。
 */
function pageApi({ ipcRenderer, extId, manifest }) {
  const listeners = new Set();
  let pendingSeq = 0;

  ipcRenderer.on('nucleus:ext-onmessage', async (_e, payload) => {
    if (!payload) return;
    for (const fn of Array.from(listeners)) {
      let responded = false;
      const sendResponse = (value) => {
        if (responded) return;
        responded = true;
        ipcRenderer.send('nucleus:ext:onmessage-reply', { msgId: payload.msgId, value });
      };
      try {
        const ret = fn(payload.message, { id: extId, tab: payload.tab || null }, sendResponse);
        if (ret && typeof ret.then === 'function') {
          const value = await ret;
          if (value !== undefined) sendResponse(value);
        } else if (ret !== undefined && ret !== true) {
          sendResponse(ret);
        }
      } catch (err) {
        console.error(`[ext:${extId}] onMessage 监听器异常`, err);
      }
    }
  });

  const call = (op, args) => ipcRenderer.invoke('nucleus:ext:bridge', { extId, op, args: args || [] });

  const chrome = {
    runtime: {
      id: extId,
      getManifest: () => manifest,
      getURL: (p) => `nucleus://ext-${extId}/${String(p || '').replace(/^\//, '')}`,
      sendMessage: (...args) => {
        const cb = args.find((x) => typeof x === 'function');
        const p = call('sendMessage', [args[0]]);
        if (cb) p.then((v) => cb(v)).catch(() => cb(undefined));
        return p;
      },
      onMessage: {
        addListener: (fn) => { if (typeof fn === 'function') listeners.add(fn); },
        removeListener: (fn) => { listeners.delete(fn); },
        hasListener: (fn) => listeners.has(fn),
      },
      onInstalled: { addListener: () => {} },
      lastError: undefined,
    },
    storage: {
      local: {
        get: (k, cb) => { const p = call('storage.get', [k]); if (cb) p.then((v) => cb(v || {})).catch(() => cb({})); return p; },
        set: (v, cb) => { const p = call('storage.set', [v]); if (cb) p.then(() => cb()).catch(() => cb()); return p; },
        remove: (k, cb) => { const p = call('storage.remove', [k]); if (cb) p.then(() => cb()).catch(() => cb()); return p; },
        clear: (cb) => { const p = call('storage.clear', []); if (cb) p.then(() => cb()).catch(() => cb()); return p; },
        onChanged: { addListener: () => {} },
      },
    },
    tabs: {
      query: (q, cb) => { const p = call('tabs.query', [q]); if (cb) p.then(cb); return p; },
      sendMessage: (id, msg, cb) => { const p = call('tabs.sendMessage', [id, msg]); if (cb) p.then(cb); return p; },
      create: (opts, cb) => { const p = call('tabs.create', [opts]); if (cb) p.then(cb); return p; },
      update: (id, opts, cb) => { const p = call('tabs.update', [id, opts]); if (cb) p.then(cb); return p; },
    },
    i18n: {
      getMessage: (key, fallback) => fallback || key,
    },
  };
  chrome.storage.sync = chrome.storage.local;
  return chrome;
}

module.exports = { contentShim, pageApi };
