'use strict';
/**
 * 截图脚本（仅开发用）：一次跑完，产出一组界面状态图。
 *
 *   NUCLEUS_SHOTS=1 npx electron .
 *
 * 刻意独立于冒烟自检：自检关心「对不对」，这里关心「长什么样」。
 * 产物写到 /tmp/shots/，由发布流程复制到交付目录。
 */
const fs = require('fs');

const OUT = process.env.NUCLEUS_SHOTS_OUT || '/tmp/shots';

module.exports = async function capture({ win, plugins, app }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(OUT, { recursive: true });

  const ui = (code) => win.webContents.executeJavaScript(code);

  const shot = async (name) => {
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(`${OUT}/${name}.png`, img.toPNG());
      console.log('SHOT ' + name);
    } catch (err) {
      console.log('SHOT_FAIL ' + name + ' ' + err.message);
    }
  };

  const run = async (label, fn) => {
    try {
      await fn();
    } catch (err) {
      console.log(`STEP_FAIL ${label} ${err.message}`);
    }
  };

  /**
   * 执行命令但不等它结束。
   * executeJavaScript 会等待返回值里的 Promise，而有些命令（例如打开模态框）
   * 的 Promise 要等用户关掉面板才 resolve —— 直接 await 会把整个脚本挂住。
   */
  const command = (id) => ui(
    `(() => { try { Promise.resolve(window.__nucleusApp.commands.execute(${JSON.stringify(id)})).catch(() => {}); } catch (e) {} return 'ok'; })()`
  );

  /** 在设置页里点某个导航项 */
  const settingsNav = (label) => {
    // 内层脚本在 Node 侧拼好，再整体作为字符串字面量注入 —— 避免把 Node 变量
    // 直接写进浏览器作用域（那里没有 label）。
    const inner = '(() => {' +
      'const el = [...document.querySelectorAll(".nav-item")]' +
      '.find((e) => e.textContent.includes(' + JSON.stringify(label) + '));' +
      'if (!el) return "no-item"; el.click(); return "ok"; })()';
    return ui(`(() => {
      const wv = [...document.querySelectorAll('webview')]
        .find((w) => { try { return w.getURL().includes('feature.settings'); } catch (e) { return false; } });
      if (!wv) return 'no-wv';
      return wv.executeJavaScript(${JSON.stringify(inner)});
    })()`);
  };

  const closeSidebar = () => ui(`window.__nucleusApp.sidebar.hide()`);

  await sleep(3000);

  // ---------- 新标签页 ----------
  await run('newtab-dark', async () => {
    await command('theme.dark');
    await sleep(500);
    await shot('01-newtab-dark');
  });

  await run('newtab-light', async () => {
    await command('theme.light');
    await sleep(700);
    await shot('02-newtab-light');
    await command('theme.dark');
    await sleep(400);
  });

  // ---------- 浏览 ----------
  await run('browse', async () => {
    await ui(`(() => {
      const i = document.querySelector('.omnibox input');
      i.focus();
      i.value = 'example.com';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await sleep(6000);
    await shot('03-browsing');
  });

  // ---------- 设置页（浅色） ----------
  await run('settings', async () => {
    await command('theme.light');
    await sleep(400);
    await command('settings.open');
    await sleep(3000);
    await shot('04-settings-general');

    await settingsNav('插件管理');
    await sleep(900);
    await shot('05-settings-plugins');

    await settingsNav('关于');
    await sleep(900);
    await shot('06-settings-about');

    await command('theme.dark');
    await sleep(500);
  });

  // ---------- 命令面板 ----------
  await run('palette', async () => {
    await ui(`(() => {
      const t = window.__nucleusApp.tabs.all.find((x) => x.url.includes('/newtab/'));
      if (t) window.__nucleusApp.tabs.activate(t.id);
    })()`);
    await sleep(600);
    await command('palette.open');
    await sleep(800);
    await shot('07-command-palette');
    await ui(`(() => {
      const s = document.querySelector('.scrim');
      if (s) s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.querySelectorAll('.menu').forEach((m) => m.remove());
    })()`);
    await sleep(300);
  });

  // ---------- 侧边栏面板 ----------
  await run('panels', async () => {
    await command('bookmarks.panel');
    await sleep(900);
    await shot('08-bookmarks-panel');
    await closeSidebar();
    await sleep(300);

    await command('history.panel');
    await sleep(900);
    await shot('09-history-panel');
    await closeSidebar();
    await sleep(300);

    await command('downloads.panel');
    await sleep(900);
    await shot('10-downloads-panel');
    await closeSidebar();
    await sleep(300);
  });

  // ---------- 页内查找 ----------
  await run('find', async () => {
    const t = await ui(`(() => {
      const x = window.__nucleusApp.tabs.all.find((v) => v.url.includes('example.com'));
      if (!x) return null;
      window.__nucleusApp.tabs.activate(x.id);
      return x.id;
    })()`);
    if (!t) throw new Error('没有可查找的页面');
    await sleep(700);
    await command('find.open');
    await sleep(600);
    // 查找条用的是无 class 的 input，只能按 placeholder 定位
    await ui(`(() => {
      const i = document.querySelector('input[placeholder="在页面中查找"]');
      if (!i) return 'no-input';
      i.focus();
      i.value = 'domain';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(900);
    await shot('11-find');
    await ui(`(() => {
      const i = document.querySelector('input[placeholder="在页面中查找"]');
      if (!i) return 'no-input';
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return 'closed';
    })()`);
    await sleep(500);
  });

  // ---------- 阅读模式 ----------
  await run('reader', async () => {
    await command('reader.toggle');
    await sleep(1500);
    await shot('12-reader');
    await command('reader.toggle');
    await sleep(600);
  });

  // ---------- 快捷键速查 ----------
  await run('shortcuts', async () => {
    await command('shortcuts.help');
    await sleep(700);
    await shot('14-shortcuts');
    await ui(`document.querySelector('.scrim')?.remove()`);
    await sleep(300);
  });

  // ---------- 隐私清理 ----------
  await run('privacy', async () => {
    await command('privacy.panel');
    await sleep(700);
    await shot('15-privacy');
    await ui(`document.querySelector('.scrim')?.remove()`);
    await sleep(300);
  });

  // ---------- 侧边便签 ----------
  await run('notes', async () => {
    await command('notes.toggle');
    await sleep(700);
    await ui(`(() => {
      const t = document.querySelector('.notes-textarea');
      if (!t) return 'no-textarea';
      t.value = '内核对齐 Cordis fiber\\n· 槽位条目按来源插件分组\\n· 健康检查可一键回收泄漏';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(900);
    await shot('16-notes');
    await closeSidebar();
    await sleep(300);
  });

  // ---------- 内核健康 ----------
  await run('health', async () => {
    await command('inspector.open');
    await sleep(1800);
    await ui(`(() => {
      const wv = [...document.querySelectorAll('webview')]
        .find((w) => { try { return w.getURL().includes('feature.inspector'); } catch (e) { return false; } });
      if (!wv) return 'no-wv';
      return wv.executeJavaScript('(() => { const b = document.querySelector(".nav-item[data-view=\\'health\\']"); if (!b) return "no-btn"; b.click(); return "clicked"; })()');
    })()`);
    await sleep(1600);
    await shot('17-health');
  });

  // ---------- 恢复通道（零界面插件） ----------
  await run('recovery', async () => {
    await plugins.disable('ui.shell');
    win.webContents.reload();
    await sleep(2800);
    await shot('13-recovery');
    await plugins.enable('ui.shell');
    await sleep(400);
  });

  console.log('SHOTS_DONE');
  app.quit();
};
