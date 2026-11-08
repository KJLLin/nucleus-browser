'use strict';
/**
 * 插件宿主：扫描 → 校验 → 激活 → 停用。
 *
 * 设计原则：
 * 1. 单个插件失败不影响核与其它插件（全部 try/catch 隔离）。
 * 2. 所有插件能力都经由 ctx，核从不直接 import 插件内部模块。
 * 3. 启用状态持久化，但「主进程入口」的彻底卸载需要重启（模块缓存所致），
 *    这一点在插件管理页会如实提示用户。
 */
const fs = require('fs');
const path = require('path');
const { EventBus } = require('./bus');
const { validateManifest } = require('./plugin-manifest');
const { createContext } = require('./plugin-context');
const { loadModule } = require('./plugin-sandbox');
const { builtinPluginDir, userPluginDir } = require('./paths');

const ACTIVATE_TIMEOUT = 8000;

class PluginHost {
  constructor(services) {
    this.services = services;
    this.bus = services.bus;
    /** @type {Map<string, object>} id -> record */
    this.records = new Map();
    this.state = services.state; // JsonStore：{ disabled: [] }
    /** pluginId -> Map<method, handler>，供插件自己的内部页面调用 */
    this.pageHandlers = new Map();
    this._fileWatchTimer = null;
  }

  // ---------- 扫描 ----------

  _readDirs(root, builtin) {
    const out = [];
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[plugins] 无法读取目录', root, err.message);
      return out;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const manifestPath = path.join(dir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (err) {
        out.push({
          id: `broken:${entry.name}`,
          dir,
          builtin,
          status: 'error',
          error: `manifest.json 解析失败：${err.message}`,
          manifest: null,
        });
        continue;
      }
      const res = validateManifest(raw, { builtin });
      if (!res.ok) {
        out.push({
          id: raw.id || `broken:${entry.name}`,
          dir,
          builtin,
          status: 'error',
          error: `清单校验失败：${res.errors.join('；')}`,
          manifest: null,
          invalid: true,
        });
        continue;
      }
      out.push({ dir, builtin, manifest: res.manifest, status: 'idle' });
    }
    return out;
  }

  /** 扫描内置 + 用户插件，返回可用记录（不激活） */
  scan() {
    const found = [];
    const seen = new Set();

    for (const rec of this._readDirs(builtinPluginDir(), true)) {
      if (rec.manifest) {
        if (seen.has(rec.manifest.id)) continue;
        seen.add(rec.manifest.id);
      }
      found.push(rec);
    }
    for (const rec of this._readDirs(userPluginDir(), false)) {
      // 用户插件不能冒用内置 id，避免「影子覆盖」导致信任错乱
      if (rec.manifest && seen.has(rec.manifest.id)) {
        console.warn(`[plugins] 用户插件 ${rec.manifest.id} 与内置插件 id 冲突，已忽略`);
        continue;
      }
      if (rec.manifest) seen.add(rec.manifest.id);
      found.push(rec);
    }

    this.records.clear();
    for (const rec of found) {
      const id = rec.manifest ? rec.manifest.id : rec.id;
      rec.id = id;
      rec.enabled = rec.manifest ? !this._isDisabled(id) : false;
      rec.instance = null;
      rec.ctx = null;
      rec.fiber = null;
      rec.lastTeardown = null;
      rec.sandboxError = null;
      this.records.set(id, rec);
    }
    return Array.from(this.records.values());
  }

  _isDisabled(id) {
    const list = this.state.get('disabled', []);
    return Array.isArray(list) && list.includes(id);
  }

  _setDisabled(id, disabled) {
    const list = new Set(this.state.get('disabled', []));
    if (disabled) list.add(id);
    else list.delete(id);
    this.state.set('disabled', Array.from(list));
  }

  // ---------- 生命周期 ----------

  async activateAll() {
    const order = Array.from(this.records.values()).filter((r) => r.enabled && r.manifest);
    for (const rec of order) {
      // eslint-disable-next-line no-await-in-loop
      await this.activate(rec.id);
    }
    return this.list();
  }

  async activate(id) {
    const rec = this.records.get(id);
    if (!rec || !rec.manifest || rec.status === 'active') return rec;

    if (!rec.manifest.main) {
      rec.status = 'active'; // 纯 UI 插件，无主进程逻辑
      return rec;
    }

    const entry = path.join(rec.dir, rec.manifest.main);
    if (!fs.existsSync(entry)) {
      rec.status = 'error';
      rec.error = `主进程入口不存在：${rec.manifest.main}`;
      return rec;
    }

    const root = this.services.root;
    if (!root) {
      rec.status = 'error';
      rec.error = 'Cordis 根上下文未就绪';
      return rec;
    }

    // 每个插件是一根 Cordis fiber：生命周期、副作用回收、服务解析都归它管。
    // 核只负责「读清单、校验权限、把模块塞进 fiber」。
    const fiber = root.plugin({
      name: rec.id,
      apply: async (cordisCtx) => {
        const { ctx } = createContext({
          manifest: rec.manifest,
          dir: rec.dir,
          services: this.services,
          cordisCtx,
        });
        rec.ctx = ctx;

        // 模块加载走受限 require（见 plugin-sandbox.js）：
        // 第三方插件拿不到 electron / child_process / 可写 fs，
        // 内置插件宽一档，但同样出不了进程。
        const mod = loadModule(entry, {
          dir: rec.dir,
          builtin: !!rec.builtin,
          pluginId: rec.id,
        });
        const activateFn = typeof mod.exports === 'function' ? mod.exports : mod.exports.activate;
        rec.instance = mod.exports;
        // 允许只声明贡献点、不写逻辑的插件
        if (typeof activateFn !== 'function') return;

        const returned = await activateFn(ctx);
        // 老式写法：activate 返回 { deactivate } 作为实例
        if (returned && typeof returned.deactivate === 'function') rec.instance = returned;
      },
    });
    rec.fiber = fiber;

    // Cordis 会等 apply 里的 await 走完；这里再套一层超时，防止坏插件卡住启动。
    // 定时器必须在 finally 里清掉 —— 否则每次激活都会留一个 8 秒的悬挂定时器。
    let timer = null;
    try {
      await Promise.race([
        fiber.await(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`activate 超时（>${ACTIVATE_TIMEOUT}ms）`)),
            ACTIVATE_TIMEOUT
          );
        }),
      ]);

      rec.status = 'active';
      rec.error = null;
      this.services.bus.emit('plugins:activated', { id });
    } catch (err) {
      rec.status = 'error';
      rec.error = err && err.message ? err.message : String(err);
      rec.sandboxError = err && err.code === 'EPERM_SANDBOX' ? rec.error : null;
      console.error(`[plugins] ${id} 激活失败`, err);
      // 激活到一半失败，也要把已经登记的副作用撤掉，不留半截状态。
      // 超时的情况下 apply 可能还在跑，Cordis 会让它后续登记的 effect 立刻回收。
      try { await fiber.dispose(); } catch (_) { /* Cordis 已记录 */ }
      rec.ctx = null;
      rec.fiber = null;
      rec.instance = null;
      this.services.bus.removeOwner(`plugin:${id}`);
      this.services.commands.unregisterOwner(id);
      this.services.intercept.removeOwner(id);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return rec;
  }

  async deactivate(id) {
    const rec = this.records.get(id);
    if (!rec) return;
    let timer = null;
    try {
      if (rec.instance && typeof rec.instance.deactivate === 'function') {
        await Promise.race([
          Promise.resolve(rec.instance.deactivate()),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('deactivate 超时')), 3000);
          }),
        ]);
      }
    } catch (err) {
      console.warn(`[plugins] ${id} deactivate 抛错`, err.message);
    } finally {
      if (timer) clearTimeout(timer);
    }

    // 核心：逆序回收插件登记过的所有副作用。
    // 回收前后各取一次账本，回收不干净要留痕 —— 自省页的「内核健康」会读这个数。
    const effectsBefore = rec.fiber && typeof rec.fiber.getEffects === 'function'
      ? rec.fiber.getEffects().length
      : 0;
    if (rec.fiber) {
      try {
        await rec.fiber.dispose();
      } catch (err) {
        console.warn(`[plugins] ${id} 副作用回收异常`, err.message);
      }
      rec.fiber = null;
    }
    rec.lastTeardown = {
      effectsBefore,
      at: Date.now(),
    };

    // 兜底清理：老式插件可能绕过 ctx 直接动过这些表
    this.services.bus.removeOwner(`plugin:${id}`);
    this.services.commands.unregisterOwner(id);
    this.services.intercept.removeOwner(id);
    rec.instance = null;
    rec.ctx = null;
    if (rec.status === 'active') rec.status = 'idle';
  }

  async enable(id) {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`插件不存在：${id}`);
    this._setDisabled(id, false);
    rec.enabled = true;
    await this.activate(id);
    this.bus.emit('plugins:changed', this.list());
    return this.publicView(rec);
  }

  async disable(id) {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`插件不存在：${id}`);
    await this.deactivate(id);
    this._setDisabled(id, true);
    rec.enabled = false;
    this.bus.emit('plugins:changed', this.list());
    return this.publicView(rec);
  }

  /**
   * 串行化：reload / install / uninstall 会同时改 records 与 fiber 树，
   * 并发跑就会出现「扫描把正在激活的记录清掉」的竞态。
   */
  _serial(fn) {
    const prev = this._queue || Promise.resolve();
    let release;
    this._queue = new Promise((resolve) => { release = resolve; });
    return prev.catch(() => {}).then(fn).finally(release);
  }

  async _reloadInner() {
    const activeIds = Array.from(this.records.values())
      .filter((r) => r.status === 'active' && r.manifest && r.manifest.main)
      .map((r) => r.id);
    for (const id of activeIds) {
      // eslint-disable-next-line no-await-in-loop
      await this.deactivate(id);
    }
    this.scan();
    await this.activateAll();
    this.bus.emit('plugins:changed', this.list());
    return this.list();
  }

  /**
   * 必需插件审计（借鉴 DSH 的 requiredClientEntryNames）。
   *
   * 缺了界面外壳，浏览器会变成一块只有网页、没有地址栏的空白 ——
   * 这不该是「用户自己想办法」的状态。所以启动时明确审计：
   * 缺了哪些、是被禁用还是加载失败、能不能一键救回来。
   */
  auditRequired() {
    const missing = [];
    for (const rec of this.records.values()) {
      if (!rec.manifest || !rec.manifest.required) continue;
      if (!rec.enabled) {
        missing.push({ id: rec.id, name: rec.manifest.name, reason: 'disabled' });
      } else if (rec.status !== 'active') {
        missing.push({ id: rec.id, name: rec.manifest.name, reason: rec.status, error: rec.error || null });
      }
    }
    return { ok: missing.length === 0, missing };
  }

  /** 运行时重载：重新扫描目录（用于从文件夹安装后刷新） */
  async reload() {
    return this._serial(() => this._reloadInner());
  }

  // ---------- 外部插件安装 / 卸载 ----------

  async installFromDir(srcDir) {
    const manifestPath = path.join(srcDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('所选目录内没有 manifest.json');
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const res = validateManifest(raw, { builtin: false });
    if (!res.ok) throw new Error(`清单校验失败：${res.errors.join('；')}`);

    const id = res.manifest.id;
    if (Array.from(this.records.values()).some((r) => r.builtin && r.manifest && r.manifest.id === id)) {
      throw new Error(`内置插件 id "${id}" 不允许被覆盖`);
    }

    return this._serial(async () => {
      const dest = path.join(userPluginDir(), id);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(srcDir, dest, { recursive: true });
      await this._reloadInner();
      return this.publicView(this.records.get(id));
    });
  }

  async uninstall(id) {
    const rec = this.records.get(id);
    if (!rec) throw new Error('插件不存在');
    if (rec.builtin) throw new Error('内置插件不能卸载，只能禁用');
    return this._serial(async () => {
      await this.deactivate(id);
      fs.rmSync(rec.dir, { recursive: true, force: true });
      this._setDisabled(id, false);
      await this._reloadInner();
      return true;
    });
  }

  /**
   * 应用启动配置（profile / patch）。
   *
   * 刻意不写回 state：profile 是「这一次以什么形态启动」，不是永久设置。
   * 否则用过 --profile=minimal 之后，下次不带参数启动就再也回不到完整形态了。
   */
  applyStartupConfig({ enable = [], disable = [] } = {}) {
    const enableSet = new Set(enable);
    const disableSet = new Set(disable);
    const applied = { enabled: [], disabled: [] };

    for (const rec of this.records.values()) {
      if (enableSet.has(rec.id)) {
        rec.enabled = true;
        applied.enabled.push(rec.id);
      } else if (disableSet.has(rec.id)) {
        rec.enabled = false;
        applied.disabled.push(rec.id);
      }
    }
    return applied;
  }

  // ---------- 查询 ----------

  /** 当前提供新标签页的插件给出的地址；没有插件认领则为 null */
  newTabUrl() {
    for (const rec of this.records.values()) {
      if (!rec.enabled || !rec.manifest) continue;
      const nt = rec.manifest.contributes && rec.manifest.contributes.newTab;
      if (nt && nt.url) return nt.url;
    }
    return null;
  }

  publicView(rec) {
    if (!rec) return null;
    return {
      id: rec.id,
      dir: rec.dir,
      builtin: rec.builtin,
      /** 缺了它浏览器不可用（清单里 builtin + required） */
      required: !!(rec.manifest && rec.manifest.required),
      enabled: rec.enabled,
      status: rec.status,
      error: rec.error || null,
      /** Cordis fiber 当前登记的可逆副作用条数（诊断用：禁用后应归零） */
      effects: rec.fiber && typeof rec.fiber.getEffects === 'function'
        ? rec.fiber.getEffects().length
        : 0,
      /** 上一次卸载时的账本快照：effectsBefore > 0 说明确实有东西被回收 */
      teardown: rec.lastTeardown || null,
      /** 主进程入口是否被沙箱拦截（加载成功后为 null） */
      sandbox: rec.sandboxError || null,
      manifest: rec.manifest,
    };
  }

  list() {
    return Array.from(this.records.values())
      .map((r) => this.publicView(r))
      .filter(Boolean);
  }

  get(id) {
    return this.records.get(id);
  }

  /** 给自定义协议用：把 nucleus://<id>/<rel> 解析成磁盘绝对路径 */
  resolveAsset(pluginId, rel) {
    const rec = this.records.get(pluginId);
    if (!rec) return null;
    const clean = decodeURIComponent(rel || '').replace(/^\/+/, '');
    const abs = path.resolve(rec.dir, clean);
    const rootWithSep = path.resolve(rec.dir) + path.sep;
    if (abs !== path.resolve(rec.dir) && !abs.startsWith(rootWithSep)) return null; // 防穿越
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    return abs;
  }

  /** 已启用插件里声明了 ui 入口的清单，用于渲染层挂载 */
  uiPlugins() {
    return Array.from(this.records.values())
      .filter((r) => r.enabled && r.manifest && r.manifest.ui)
      .map((r) => ({
        id: r.id,
        name: r.manifest.name,
        ui: r.manifest.ui,
        styles: r.manifest.styles || [],
        permissions: r.manifest.permissions || [],
        contributes: r.manifest.contributes,
      }));
  }
}

module.exports = { PluginHost };
