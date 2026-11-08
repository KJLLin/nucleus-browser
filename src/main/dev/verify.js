'use strict';
/**
 * 加固回归验证（开发用）：
 *
 *   NUCLEUS_VERIFY=1 npx electron .
 *
 * 只验证「这几处加固真的生效了」，不做视觉检查（那是 shots.js 的事）。
 * 每一项都输出一行 VERIFY_xxx，便于 grep。
 */
module.exports = async function verify({ win, app }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(3500);

  const script = `(async () => {
    const a = window.__nucleusApp;
    const out = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!a) return { fatal: 'no-app' };

    // 1. 一次性桥：取走之后不应再能拿到裸 IPC
    out.bridgeGlobal = typeof window.nucleusBridge;
    try { window.__nucleusTakeBridge(); out.bridgeReopen = 'LEAK'; }
    catch (e) { out.bridgeReopen = 'denied'; }

    // 2. 插件不能冒充别的插件（nucleus.invoke 只会带上自己的 pluginId）
    const notes = a.plugins.get('feature.notes');
    if (notes) {
      try {
        await notes.api.invoke('nucleus:plugins:disable', { target: 'ui.shell' });
        out.pluginEscalation = 'LEAK';
        await a.bridge.invoke('nucleus:plugins:enable', { pluginId: 'core', target: 'ui.shell' });
      } catch (e) { out.pluginEscalation = 'denied'; }
    } else out.pluginEscalation = 'no-plugin';

    // 3. 标签休眠：后台标签的 webview 应被摘掉，唤醒后重建
    const before = document.querySelectorAll('#webarea webview').length;
    const t = a.tabs.create({ url: 'https://example.com/?sleep=1', active: false });
    // 等加载结束：休眠策略会跳过 loading 中的标签（这是有意为之）
    for (let i = 0; i < 12; i += 1) {
      const cur = a.tabs.get(t.id);
      if (cur && !cur.loading && cur.url && !cur.url.startsWith('about:')) break;
      await sleep(500);
    }
    const inner = a.tabs.tabs.get(t.id);
    if (inner) inner.lastActiveAt = Date.now() - 3600000;
    const slept = a.tabs.suspendIdle(60000, 0);
    await sleep(300);
    const during = document.querySelectorAll('#webarea webview').length;
    const sleeping = (a.tabs.get(t.id) || {}).sleeping;
    a.tabs.resume(t.id);
    await sleep(1200);
    const after = document.querySelectorAll('#webarea webview').length;
    out.sleep = { before, slept, during, sleeping: !!sleeping, after };

    // 4. 槽位孤儿清理：塞一个假来源的条目，prune 应该只清掉它
    const slotName = 'region.nav-right';
    const list = a.slots.entries.get(slotName);
    if (list) {
      const seqBefore = list.length;
      a.slots.entries.get(slotName).push({
        __seq: 99999, name: slotName, id: 'ghost:probe', pluginId: 'ghost.plugin',
        order: 100, priority: 100, when: null, key: null, select: null,
        render: () => document.createElement('i'), meta: null,
      });
      const alive = new Set([...a.plugins.keys()].concat(['core']));
      const removed = a.slots.prune(alive);
      out.prune = { seqBefore, removed, seqAfter: a.slots.entries.get(slotName).length };
    } else out.prune = { error: 'no-slot' };

    // 5. 内核健康：结构完整，且槽位一项是「正常」
    try {
      const h = await a.bridge.invoke('nucleus:doctor:run', { pluginId: 'core' });
      out.health = { ok: h.ok, checks: h.checks.length, slots: (h.checks.find((c) => c.id === 'slots') || {}).level };
    } catch (e) { out.health = { error: e.message }; }

    a.tabs.close(t.id);
    return out;
  })()`;

  try {
    const res = await win.webContents.executeJavaScript(script);
    console.log('VERIFY ' + JSON.stringify(res, null, 1));
  } catch (err) {
    console.log('VERIFY_FAIL ' + err.message);
  }

  // 主进程侧：沙箱模块加载的拒绝路径
  try {
    const { loadModule } = require('../core/plugin-sandbox');
    const path = require('path');
    const os = require('os');
    const fs = require('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nucleus-sbx-'));
    fs.writeFileSync(path.join(dir, 'evil.js'), 'module.exports = require("child_process");');
    fs.writeFileSync(path.join(dir, 'esc.js'), 'module.exports = require("../../etc/passwd");');
    fs.writeFileSync(path.join(dir, 'ok.js'), 'module.exports = { sep: require("path").sep, hasProcess: typeof process, hasGlobal: typeof global };');
    const results = {};
    for (const f of ['evil', 'esc', 'ok']) {
      try {
        const m = loadModule(path.join(dir, `${f}.js`), { dir, builtin: false, pluginId: 'probe' });
        results[f] = { ok: true, value: m.exports };
      } catch (err) {
        results[f] = { ok: false, code: err.code, message: err.message };
      }
    }
    console.log('VERIFY_SANDBOX ' + JSON.stringify(results));
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    console.log('VERIFY_SANDBOX_FAIL ' + err.message);
  }

  setTimeout(() => app.quit(), 400);
};
