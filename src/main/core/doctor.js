'use strict';
/**
 * 内核健康检查（doctor）。
 *
 * 为什么需要它：
 *   Cordis 保证了「登记过的副作用会被回收」，但保证不了「插件没绕过账本」。
 *   一旦某处漏记，症状往往是几小时后界面变卡、内存持续上涨，
 *   而不是当场报错。与其等用户反馈，不如把不变量写成检查项，随时可以跑一遍。
 *
 * 检查的都是可证伪的事实，不做猜测：
 *   - 已禁用插件的 fiber 上不该还有副作用
 *   - 界面上的槽位条目不该来自已禁用/已卸载的插件
 *   - 声明了条目却没有容器的空位，说明 owner 没把它画出来
 *   - 核心服务必须齐全，RPC 通道不该出现大面积失败
 *
 * repair() 只做「明确安全」的回收：强制释放泄漏的 fiber、通知界面清理孤儿条目。
 * 它不会重启插件、不会改动用户设置。
 */
const rpc = require('./rpc');
const { runtime } = require('./runtime-state');

const LEVEL = { ok: 'ok', warn: 'warn', error: 'error' };

class Doctor {
  constructor(services) {
    this.services = services;
    this.lastRunAt = 0;
  }

  _plugins() {
    return this.services.plugins.list();
  }

  // ---------- 检查项 ----------

  _checkPlugins(list) {
    const items = [];
    let level = LEVEL.ok;

    for (const p of list) {
      if (p.status === 'error') {
        items.push({ plugin: p.id, text: p.error || '激活失败', hint: p.sandbox ? 'sandbox' : 'error' });
        level = LEVEL.warn;
      } else if (p.enabled && p.manifest && p.manifest.main && p.status !== 'active') {
        items.push({ plugin: p.id, text: `已启用但状态为 ${p.status}`, hint: 'stale' });
        level = LEVEL.warn;
      }
    }

    const disabled = list.filter((p) => !p.enabled).map((p) => p.id);
    if (disabled.length) {
      items.push({ plugin: '—', text: `已禁用 ${disabled.length} 个插件：${disabled.join('、')}`, hint: 'info' });
    }

    return {
      id: 'plugins',
      title: '插件状态',
      level,
      detail: `${list.filter((p) => p.status === 'active').length} 个已激活 / 共 ${list.length} 个`,
      items,
    };
  }

  _checkEffects(list) {
    const items = [];
    let level = LEVEL.ok;
    let total = 0;

    for (const p of list) {
      total += p.effects || 0;
      if (!p.enabled && p.effects > 0) {
        items.push({
          plugin: p.id,
          text: `已禁用但 fiber 上仍挂着 ${p.effects} 条副作用（账本泄漏）`,
          hint: 'leak',
        });
        level = LEVEL.error;
      }
      if (p.enabled && p.manifest && p.manifest.main && p.status === 'active' && p.effects === 0) {
        items.push({ plugin: p.id, text: '已激活但账本为空（可能没登记任何可逆副作用）', hint: 'info' });
      }
    }

    // 最近一次卸载确实回收过东西 —— 说明 effect 记账在真实工作
    const teardowns = list
      .filter((p) => p.teardown && p.teardown.effectsBefore > 0)
      .map((p) => `${p.id}:${p.teardown.effectsBefore}`);

    return {
      id: 'effects',
      title: '副作用账本',
      level,
      detail: `运行中共登记 ${total} 条可逆副作用`,
      items: items.concat(teardowns.length
        ? [{ plugin: '—', text: `最近卸载已回收：${teardowns.join('，')}`, hint: 'ok' }]
        : []),
    };
  }

  _checkSlots(list) {
    const snap = runtime.slots;
    if (!snap || !Array.isArray(snap.slots)) {
      return {
        id: 'slots',
        title: '槽位组合',
        level: LEVEL.warn,
        detail: '界面尚未上报槽位快照',
        items: [],
      };
    }

    const enabled = new Set(list.filter((p) => p.enabled).map((p) => p.id));
    const items = [];
    let level = LEVEL.ok;

    let orphan = 0;
    let empty = 0;
    let entryCount = 0;

    for (const slot of snap.slots) {
      const entries = slot.entries || [];
      entryCount += entries.length;
      for (const e of entries) {
        // 核代注册的条目 pluginId 是真实来源，core 也允许
        if (e.pluginId && e.pluginId !== 'core' && !enabled.has(e.pluginId)) {
          orphan += 1;
          items.push({
            plugin: e.pluginId,
            text: `槽位 ${slot.name} 里的条目 ${e.id} 来自未启用的插件`,
            hint: 'orphan',
          });
        }
      }
      if (entries.length > 0 && slot.outlets === 0 && slot.name !== 'root') {
        empty += 1;
        items.push({
          plugin: slot.owner,
          text: `空位 ${slot.name} 有 ${entries.length} 个条目，但没有任何容器渲染它`,
          hint: 'empty',
        });
      }
    }

    if (orphan) level = LEVEL.error;
    else if (empty) level = LEVEL.warn;

    const rejections = snap.rejections || [];
    if (rejections.length) {
      items.push({
        plugin: rejections[0].pluginId,
        text: `最近有 ${rejections.length} 次注册被权限策略拒绝（最新：${rejections[0].name} — ${rejections[0].reason}）`,
        hint: 'policy',
      });
    }

    return {
      id: 'slots',
      title: '槽位组合',
      level,
      detail: `${snap.total || 0} 个空位点 / ${entryCount} 个条目 / ${orphan} 个孤儿`,
      items,
    };
  }

  _checkServices() {
    const REQUIRED = ['bus', 'settings', 'tabs', 'commands', 'windows', 'downloads', 'intercept', 'protocol', 'plugins'];
    const missing = REQUIRED.filter((k) => !this.services[k]);
    const root = this.services.root;
    return {
      id: 'services',
      title: 'Cordis 服务',
      level: missing.length ? LEVEL.error : LEVEL.ok,
      detail: root ? `${REQUIRED.length - missing.length}/${REQUIRED.length} 个核服务就绪` : '根上下文缺失',
      items: missing.map((k) => ({ plugin: 'core', text: `缺少服务 ${k}`, hint: 'missing' })),
    };
  }

  _checkRpc() {
    let desc;
    try {
      desc = rpc.describe();
    } catch (_) {
      return { id: 'rpc', title: 'RPC 通道', level: LEVEL.warn, detail: '无法读取契约表', items: [] };
    }
    const channels = desc.channels || [];
    const untyped = channels.filter((c) => !c.typed).map((c) => c.channel);
    const failing = channels.filter((c) => c.failed > 0);
    const items = untyped.slice(0, 12).map((ch) => ({
      plugin: 'core',
      text: `${ch} 未登记类型契约`,
      hint: 'untyped',
    }));
    for (const m of failing.slice(0, 12)) {
      const why = m.lastError && m.lastError.message ? m.lastError.message : '未知';
      items.push({ plugin: 'core', text: `${m.channel} 失败 ${m.failed} 次（最近：${why}）`, hint: 'fail' });
    }
    return {
      id: 'rpc',
      title: 'RPC 通道',
      level: failing.length ? LEVEL.warn : LEVEL.ok,
      detail: `${desc.typed} 条已登记 / ${desc.untyped} 条未登记（覆盖率 ${desc.coverage}%）`,
      items,
    };
  }

  _checkResources() {
    const mem = process.memoryUsage();
    const handles = typeof process._getActiveHandles === 'function'
      ? process._getActiveHandles().length
      : -1;
    const rssMB = Math.round(mem.rss / 1048576);
    const heapMB = Math.round(mem.heapUsed / 1048576);
    let level = LEVEL.ok;
    const items = [];
    if (rssMB > 900) {
      level = LEVEL.warn;
      items.push({ plugin: 'core', text: `主进程内存 ${rssMB}MB，偏高`, hint: 'memory' });
    }
    if (handles > 260) {
      level = LEVEL.warn;
      items.push({ plugin: 'core', text: `活动句柄 ${handles} 个，可能存在未释放的定时器/连接`, hint: 'handle' });
    }
    return {
      id: 'resources',
      title: '资源占用',
      level,
      detail: `RSS ${rssMB}MB · Heap ${heapMB}MB · 句柄 ${handles} · 运行 ${Math.round(process.uptime())}s`,
      items,
    };
  }

  // ---------- 对外 ----------

  run() {
    const list = this._plugins();
    const checks = [
      this._checkPlugins(list),
      this._checkEffects(list),
      this._checkSlots(list),
      this._checkServices(),
      this._checkRpc(),
      this._checkResources(),
    ];
    const errors = checks.filter((c) => c.level === LEVEL.error).length;
    const warns = checks.filter((c) => c.level === LEVEL.warn).length;
    this.lastRunAt = Date.now();
    return {
      at: this.lastRunAt,
      ok: errors === 0,
      summary: {
        checks: checks.length,
        errors,
        warns,
        plugins: list.length,
        active: list.filter((p) => p.status === 'active').length,
        effects: list.reduce((n, p) => n + (p.effects || 0), 0),
      },
      checks,
    };
  }

  /**
   * 只做明确安全的回收。返回每一项的处理结果，供自省页逐条展示。
   */
  async repair() {
    const actions = [];
    const list = this._plugins();

    for (const p of list) {
      if (p.enabled || !p.effects) continue;
      const rec = this.services.plugins.get(p.id);
      if (!rec || !rec.fiber) continue;
      try {
        const before = rec.fiber.getEffects().length;
        await rec.fiber.dispose();
        rec.fiber = null;
        rec.status = 'idle';
        actions.push({ plugin: p.id, action: '强制回收 fiber', detail: `${before} 条副作用已撤销`, ok: true });
      } catch (err) {
        actions.push({ plugin: p.id, action: '强制回收 fiber', detail: err.message, ok: false });
      }
    }

    // 通知界面清理来自未启用插件的槽位条目
    try {
      const alive = list.filter((p) => p.enabled).map((p) => p.id);
      const sent = this.services.windows.sendToShell('nucleus:doctor:prune', { alive });
      if (sent) actions.push({ plugin: 'core', action: '清理孤儿槽位', detail: `已通知界面按 ${alive.length} 个存活插件重绘`, ok: true });
    } catch (err) {
      actions.push({ plugin: 'core', action: '清理孤儿槽位', detail: err.message, ok: false });
    }

    return { at: Date.now(), actions };
  }
}

module.exports = { Doctor };
