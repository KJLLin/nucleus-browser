'use strict';
/**
 * Cordis 内核装配。
 *
 * 核不再自己实现「插件树 / 副作用回收 / 服务注册」——
 * 这三件事交给随包分发的 Cordis（src/renderer/vendor/cordis.mjs，
 * 单文件 ESM，运行期零依赖，主进程与渲染层共用同一份）。
 *
 * 核保留的是 Cordis 不提供的部分：
 *   清单校验、权限网关、nucleus:// 协议、主进程↔渲染层桥接、安装/卸载。
 */
const path = require('path');
const { pathToFileURL } = require('url');

let cached = null;

/** 加载 Cordis。Node 16（Electron 22）也能直接 import .mjs */
async function loadCordis() {
  if (!cached) {
    const file = path.join(__dirname, '..', '..', 'renderer', 'vendor', 'cordis.mjs');
    cached = await import(pathToFileURL(file).toString());
  }
  return cached;
}

/**
 * 建立根上下文，并把核能力注册成 Cordis 服务。
 *
 * 之后 root.tabs / root.commands 就是服务本身，插件通过自己那级 ctx 解析。
 * 权限闸门在这一层之外（见 plugin-context.js），所以不能把 root 直接交给插件。
 *
 * @param {Record<string, any>} services
 */
async function createRoot(services) {
  const { Context } = await loadCordis();
  const root = new Context();

  for (const [name, value] of Object.entries(services)) {
    if (value === undefined) continue;
    // provide 先声明再赋值：Cordis 的服务必须显式声明，避免拼写错误静默失败
    root.provide(name);
    root.set(name, value);
  }

  return root;
}

module.exports = { loadCordis, createRoot };
