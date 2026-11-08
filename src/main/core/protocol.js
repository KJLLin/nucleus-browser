'use strict';
/**
 * nucleus:// 协议：插件页面与资源的唯一入口。
 *
 *   nucleus://core/...          核自身的浏览器 UI（src/renderer）
 *   nucleus://<pluginId>/...    插件目录内的文件
 *
 * 三件事必须在这里做对，否则整个插件体系会散架：
 *   1. 只服务「已启用插件」目录，且拦住 ../ 目录穿越；
 *   2. 带上 CORS 头，让 nucleus://core 能 import 来自其它插件的 ESM 模块；
 *   3. 正确的 MIME，否则 type="module" 会被浏览器拒绝执行。
 */
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { protocol } = require('electron');
const { isInside } = require('./paths');

const MIME = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain',
  '.wasm': 'application/wasm',
};

/** 合并扩展 API 的脚本（在扩展页面里先于业务脚本执行） */
const EXT_API_SHIM = `(function () {
  var api = window.__nucleusChrome;
  if (!api) return;
  var target = window.chrome || (window.chrome = {});
  for (var key in api) {
    try { target[key] = api[key]; } catch (e) { /* 只读属性跳过 */ }
  }
  try { window.browser = target; } catch (e) {}
})();`;

const EXT_SHIM_TAG = '<script src="/__nucleus_api.js"></script>';

/** 在扩展页面的 <head> 之后插入 shim，保证它比扩展自己的脚本先跑 */
function injectExtShim(html) {
  if (html.includes('/__nucleus_api.js')) return html;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + EXT_SHIM_TAG);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + EXT_SHIM_TAG);
  return EXT_SHIM_TAG + html;
}

/** 核的 UI 根目录 */
const CORE_ROOT = path.resolve(__dirname, '..', '..', 'renderer');

class ProtocolService {
  constructor({ plugins }) {
    this.plugins = plugins;
    this.extensions = null; // 由 main.js 注入，处理 nucleus://ext-<id>/...
    this.custom = new Map(); // scheme -> {handler, owner}
  }

  /** 必须在 app ready 之前调用 */
  static registerPrivileged() {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: 'nucleus',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true,
        },
      },
    ]);
  }

  _respond(callback, statusCode, mimeType, body) {
    callback({
      statusCode,
      headers: {
        'Content-Type': `${mimeType}; charset=utf-8`,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      },
      data: Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')]),
    });
  }

  install() {
    protocol.registerStreamProtocol('nucleus', (request, callback) => {
      try {
        const url = new URL(request.url);
        const host = decodeURIComponent(url.hostname || '').toLowerCase();
        const rel = decodeURIComponent(url.pathname || '/');

        if (host === 'core') {
          const abs = path.resolve(CORE_ROOT, `.${rel}`);
          if (!isInside(CORE_ROOT, abs)) {
            this._respond(callback, 403, 'text/html', forbiddenPage(request.url));
            return;
          }
          if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
            // 目录默认回退到 index.html
            const idx = path.join(abs, 'index.html');
            if (fs.existsSync(idx)) {
              this._respond(callback, 200, 'text/html', fs.readFileSync(idx));
              return;
            }
            this._respond(callback, 404, 'text/html', notFoundPage(request.url));
            return;
          }
          const ext = path.extname(abs).toLowerCase();
          this._respond(callback, 200, MIME[ext] || 'application/octet-stream', fs.readFileSync(abs));
          return;
        }

        // 扩展资源：nucleus://ext-<id>/<path>
        if (host.startsWith('ext-')) {
          // 虚拟文件：扩展 API 合并脚本，不属于扩展目录
          if (rel === '/__nucleus_api.js') {
            this._respond(callback, 200, 'text/javascript', EXT_API_SHIM);
            return;
          }

          const res = this.extensions ? this.extensions.resolveAsset(host, rel) : null;
          if (!res) {
            this._respond(callback, 404, 'text/html', notFoundPage(request.url));
            return;
          }
          if (res.virtual === 'background') {
            const scripts = (res.rec.background.scripts || [])
              .map((src) => `<script src="${String(src).replace(/"/g, '&quot;')}"></script>`)
              .join('\n');
            const html = injectExtShim(`<!doctype html><head><meta charset="utf-8"><title>${res.rec.name}</title></head><body>${scripts}</body>`);
            this._respond(callback, 200, 'text/html', html);
            return;
          }
          // 扩展 API 合并脚本：把 preload 暴露的 __nucleusChrome 挂到 window.chrome 上。
          // 必须比扩展自己的脚本先执行，所以在 HTML 的 <head> 后插入一条 <script>。
          if (rel === '/__nucleus_api.js') {
            this._respond(callback, 200, 'text/javascript', EXT_API_SHIM);
            return;
          }

          const extName = path.extname(res).toLowerCase();
          const mime = MIME[extName] || 'application/octet-stream';
          if (mime === 'text/html') {
            const html = fs.readFileSync(res, 'utf8');
            this._respond(callback, 200, mime, injectExtShim(html));
            return;
          }
          this._respond(callback, 200, mime, fs.readFileSync(res));
          return;
        }

        const file = this.plugins ? this.plugins.resolveAsset(host, rel) : null;
        if (!file) {
          this._respond(callback, 404, 'text/html', notFoundPage(request.url));
          return;
        }
        const ext = path.extname(file).toLowerCase();
        this._respond(callback, 200, MIME[ext] || 'application/octet-stream', fs.readFileSync(file));
      } catch (err) {
        console.warn('[protocol] 处理失败', request.url, err.message);
        this._respond(callback, 500, 'text/plain', `资源读取失败：${err.message}`);
      }
    });
  }

  /** 插件自定义协议（需 protocol 权限） */
  register(scheme, handler, owner) {
    if (!/^[a-z][a-z0-9+.-]{1,20}$/.test(scheme)) throw new Error(`非法协议名：${scheme}`);
    if (scheme === 'nucleus' || ['http', 'https', 'file', 'about', 'data'].includes(scheme)) {
      throw new Error(`协议 ${scheme} 由浏览器保留，插件不可注册`);
    }
    if (this.custom.has(scheme)) throw new Error(`协议 ${scheme} 已被注册`);
    protocol.registerStreamProtocol(scheme, (request, callback) => {
      Promise.resolve(handler(request.url))
        .then((res) => {
          if (!res) return this._respond(callback, 404, 'text/plain', 'not found');
          const body = res.body !== undefined ? res.body : '';
          this._respond(
            callback,
            res.statusCode || 200,
            res.mimeType || 'text/plain',
            typeof body === 'string' ? body : JSON.stringify(body)
          );
          return null;
        })
        .catch(() => this._respond(callback, 500, 'text/plain', 'handler error'));
    });
    this.custom.set(scheme, { handler, owner });
    return () => {
      this.custom.delete(scheme);
      protocol.unregisterProtocol(scheme).catch(() => {});
    };
  }
}

function shell(bodyHtml) {
  return `<!doctype html><meta charset="utf-8"><title>Nucleus</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
background:#14161a;color:#c9ced8;font:14px/1.7 "Segoe UI","Microsoft YaHei",sans-serif}
.box{max-width:620px;padding:32px}h1{font-size:17px;margin:0 0 12px;color:#fff}
code{background:#22262e;padding:2px 6px;border-radius:4px;color:#8ab4f8;word-break:break-all}
ul{padding-left:18px;margin:8px 0}</style><div class="box">${bodyHtml}</div>`;
}

function notFoundPage(url) {
  const safe = String(url).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  return shell(`<h1>资源不存在</h1>
<p>核没有在已启用插件的目录中找到这个资源。常见原因：</p>
<ul><li>插件已被禁用或卸载</li><li>路径写错，或文件确实不存在</li></ul>
<p><code>${safe}</code></p>`);
}

function forbiddenPage(url) {
  const safe = String(url).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  return shell(`<h1>拒绝访问</h1><p>该请求试图越出插件目录，已被核拦截。</p><p><code>${safe}</code></p>`);
}

module.exports = { ProtocolService, CORE_ROOT };
