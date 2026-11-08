'use strict';
/**
 * 插件模块加载器（受限 require）。
 *
 * 为什么需要这一层：
 *   Cordis 的 fiber 管的是「插件登记了什么副作用」，管不了「插件能碰到什么」。
 *   如果插件主进程入口直接用 Node 的 require，那么 `require('child_process')`
 *   一行就能绕过整个权限网关 —— ctx 再严也只是建议。
 *
 * 所以插件模块不走 Node 的默认加载器，而是由这里手动编译：
 *   1. 自己拼包装函数，把 require / process / global 换成受限版本；
 *   2. require 只解析相对路径（且必须落在插件目录内）和白名单内置模块；
 *   3. 内置插件（随包分发、经清单校验）比第三方插件宽一档，但仍拿不到
 *      child_process / worker_threads / vm / cluster 这类「跳出进程」的入口。
 *
 * 诚实标注：这是**能力最小化**，不是安全沙箱。同进程内没有真正的隔离，
 * 恶意插件仍可通过原型链、Function 构造器、异常栈等旁路折腾。
 * 它的目标是「装错插件不会顺手把系统也交出去」，而不是「可以随便装不可信代码」。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

/** 第三方插件可用的内置模块：纯计算 / 字符串处理，碰不到系统 */
const SAFE_BUILTINS = new Set([
  'path', 'url', 'util', 'events', 'crypto', 'buffer', 'string_decoder',
  'querystring', 'assert', 'punycode', 'stream', 'zlib', 'timers',
  'constants', 'tty', 'os', 'perf_hooks',
]);

/** 内置插件额外可用：它们由项目自己维护，需要读写自己的资源文件 */
const BUILTIN_EXTRA = new Set(['fs', 'fs/promises']);

/** 任何插件都不能碰：这些能直接跳出进程边界或绕过权限 */
const FORBIDDEN = new Set([
  'child_process', 'worker_threads', 'cluster', 'vm', 'v8', 'inspector',
  'module', 'repl', 'trace_events', 'wasi', 'test', 'node:test',
  'electron', 'original-fs', 'process', 'async_hooks', 'http', 'https',
  'net', 'tls', 'dgram', 'dns', 'http2',
]);

/**
 * 被遮蔽的全局对象里仍然放行的成员 —— 定时器、控制台、编码、URL。
 * 其余（process、require、fetch、WebSocket…）一律看不到。
 */
const GLOBAL_ALLOW = new Set([
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'clearImmediate', 'queueMicrotask', 'console',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'AbortController', 'AbortSignal', 'structuredClone', 'atob', 'btoa',
  'performance', 'crypto', 'Buffer', 'Intl', 'Math', 'JSON',
]);

function deniedHost(reason) {
  const err = new Error(`插件代码试图访问受限能力：${reason}`);
  err.code = 'EPERM_SANDBOX';
  return err;
}

/**
 * 只读 fs：第三方插件只能读，写/删/改权限位一律拒绝。
 * 内置插件拿到真实的 fs —— 它们要写缓存、导出文件，且随包分发。
 */
function readOnlyFs(realFs) {
  const READ_OK = [
    'readFile', 'readFileSync', 'readdir', 'readdirSync', 'stat', 'statSync',
    'lstat', 'lstatSync', 'existsSync', 'access', 'accessSync', 'realpath',
    'realpathSync', 'createReadStream', 'open', 'openSync', 'readlink',
    'readlinkSync',
  ];
  const out = {};
  for (const key of READ_OK) {
    if (typeof realFs[key] === 'function') out[key] = realFs[key].bind(realFs);
  }
  out.constants = realFs.constants;
  for (const key of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
    'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'mkdir',
    'mkdirSync', 'rename', 'renameSync', 'copyFile', 'copyFileSync', 'chmod',
    'chmodSync', 'truncate', 'truncateSync', 'write', 'writeSync', 'cp', 'cpSync']) {
    out[key] = () => { throw deniedHost(`fs.${key}（第三方插件只能读文件）`); };
  }
  return out;
}

/** 受限 process 视图：只给只读的环境信息，不给 binding/mainModule 这类后门 */
function limitedProcess() {
  const p = process;
  return {
    env: Object.freeze({ ...p.env }),
    argv: p.argv.slice(),
    platform: p.platform,
    arch: p.arch,
    pid: p.pid,
    version: p.version,
    versions: Object.freeze({ ...p.versions }),
    cwd: () => p.cwd(),
    uptime: () => p.uptime(),
    memoryUsage: () => p.memoryUsage(),
    hrtime: p.hrtime.bind(p),
    nextTick: p.nextTick.bind(p),
    exitCode: undefined,
    on: (evt, fn) => { if (['uncaughtException', 'unhandledRejection', 'exit'].includes(evt)) return p.on(evt, fn); return undefined; },
    removeListener: (...a) => p.removeListener(...a),
    emitWarning: (...a) => p.emitWarning(...a),
  };
}

/**
 * 源码静态检查：挡住最容易被写出来的几种逃逸写法。
 * 这不是完备的（字符串拼接就能绕过），但把「无意中用到」的情况挡在加载阶段，
 * 并且给出明确的错误信息，比运行期神秘失败好得多。
 */
const FORBIDDEN_PATTERNS = [
  { re: /\bimport\s*\(/, label: '动态 import()' },
  { re: /\bFunction\s*\(/, label: 'Function 构造器' },
  { re: /\beval\s*\(/, label: 'eval()' },
  { re: /process\s*\.\s*(binding|_linkedBinding|mainModule|dlopen)/, label: 'process 内部入口' },
  { re: /\bconstructor\s*\.\s*constructor/, label: '构造器链逃逸' },
];

function scanSource(source, pluginId) {
  // 去掉注释再做匹配，避免「文档里写了 eval(」被误判
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const { re, label } of FORBIDDEN_PATTERNS) {
    if (re.test(stripped)) {
      const err = deniedHost(`${label} 在插件 ${pluginId} 中不可用`);
      err.code = 'EPERM_SANDBOX';
      throw err;
    }
  }
}

function resolveLocal(fromDir, request) {
  if (request.startsWith('node:') || request.startsWith('electron')) return null;
  if (!request.startsWith('./') && !request.startsWith('../') && !request.startsWith('/')) return null;
  return path.resolve(fromDir, request);
}

function makeRequire({ dir, builtin, pluginId, cache: sharedCache }) {
  const root = path.resolve(dir);
  /** 同一个插件内多处 require 同一文件，共享同一份导出 */
  const cache = sharedCache || new Map();

  const insideRoot = (abs) => abs === root || abs.startsWith(root + path.sep);

  const loadLocal = (abs) => {
    if (!insideRoot(abs)) {
      throw deniedHost(`${pluginId} 试图加载插件目录之外的文件（${abs}）`);
    }
    if (cache.has(abs)) return cache.get(abs).exports;

    const candidates = [abs, `${abs}.js`, `${abs}.json`, path.join(abs, 'index.js')];
    const file = candidates.find((p) => {
      try { return fs.statSync(p).isFile(); } catch (_) { return false; }
    });
    if (!file) {
      const err = new Error(`Cannot find module '${abs}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    if (file.endsWith('.json')) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache.set(abs, { exports: data });
      return data;
    }
    const child = loadModule(file, { dir, builtin, pluginId, cache });
    cache.set(abs, child);
    return child.exports;
  };

  const req = (request) => {
    if (typeof request !== 'string') throw new Error('require 只接受字符串');
    const normalized = request.startsWith('node:') ? request.slice(5) : request;

    if (request.startsWith('electron')) {
      throw deniedHost('electron（请改用 ctx 提供的能力，例如 ctx.tabs / ctx.window / ctx.dialog）');
    }
    if (FORBIDDEN.has(normalized)) {
      throw deniedHost(`${normalized}（插件应当通过 ctx 与核交互）`);
    }

    const local = resolveLocal(dir, request);
    if (local) return loadLocal(local);

    if (SAFE_BUILTINS.has(normalized)) return require(normalized);

    if (BUILTIN_EXTRA.has(normalized)) {
      if (!builtin) {
        return normalized.startsWith('fs') ? readOnlyFs(require('fs')) : require(normalized);
      }
      return require(normalized);
    }

    if (!normalized.startsWith('.') && !path.isAbsolute(normalized)) {
      throw deniedHost(`npm 包 "${request}"（插件需自带依赖文件，或用 ctx 能力）`);
    }

    throw deniedHost(request);
  };

  req.resolve = (request) => {
    const local = resolveLocal(dir, request);
    if (local) return local;
    throw deniedHost(`解析模块 ${request}`);
  };
  req.cache = Object.create(null);
  return req;
}

/**
 * 编译并执行一个插件模块。
 * @param {string} file 入口绝对路径
 * @param {{dir:string, builtin:boolean, pluginId:string, cache?:Map}} opts
 * @returns {Module} 已执行的模块（exports 已就绪）
 */
function loadModule(file, opts) {
  const source = fs.readFileSync(file, 'utf8');
  if (!opts.builtin) scanSource(source, opts.pluginId);

  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = [];

  // 自定义包装：比 Module.wrap 多三个被遮蔽的参数。
  // 参数遮蔽是能力最小化里最便宜的一招 —— 插件拿到的 process 不是真 process。
  const wrapper = `(function (exports, require, module, __filename, __dirname, process, global, globalThis) {${source}\n})`;
  const compiled = vm.runInThisContext(wrapper, { filename: file, displayErrors: true });

  const cache = opts.cache || new Map();
  const req = makeRequire({ dir: opts.dir, builtin: opts.builtin, pluginId: opts.pluginId, cache });
  // 全局对象同样是「白名单代理」：拿得到 setTimeout，拿不到 process/require
  const fakeGlobal = new Proxy(Object.create(null), {
    get(_t, prop) {
      if (prop === Symbol.toStringTag) return 'global';
      if (typeof prop !== 'string') return undefined;
      if (GLOBAL_ALLOW.has(prop)) {
        const v = globalThis[prop];
        return typeof v === 'function' ? v.bind(globalThis) : v;
      }
      return undefined;
    },
    set() { return true; },
    has(_t, prop) { return typeof prop === 'string' && GLOBAL_ALLOW.has(prop); },
  });

  try {
    compiled.call(
      mod.exports,
      mod.exports,
      req,
      mod,
      file,
      path.dirname(file),
      limitedProcess(),
      fakeGlobal,
      fakeGlobal
    );
  } catch (err) {
    if (err && err.code === 'EPERM_SANDBOX') {
      err.message = `[${opts.pluginId}] ${err.message}`;
    }
    throw err;
  }

  mod.loaded = true;
  return mod;
}

module.exports = { loadModule, makeRequire, readOnlyFs, scanSource, SAFE_BUILTINS, FORBIDDEN };
