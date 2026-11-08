'use strict';
/**
 * feature.settings —— 主进程侧。
 *
 * 它扮演「元插件」：设置页是它自己的 nucleus:// 页面，页面通过 ctx.pages
 * 注册的 RPC 读取所有插件的贡献点。核本身不参与设置界面。
 */
module.exports = {
  activate(ctx) {
    ctx.pages.handle('bootstrap', () => ({
      app: {
        version: ctx.appInfo.version,
        electron: ctx.appInfo.electron,
        chrome: ctx.appInfo.chrome,
        isWin7: ctx.appInfo.isWin7,
      },
      plugins: ctx.plugins.list().map((p) => Object.assign({}, p, {
        settings: ctx.plugins.getSettings(p.id),
      })),
      global: ctx.plugins.globalSettings(),
    }));

    ctx.pages.handle('plugin-setting', ({ pluginId, key, value }) => {
      if (!pluginId || !key) throw new Error('缺少参数');
      return ctx.plugins.setSetting(pluginId, key, value);
    });

    ctx.pages.handle('global-setting', ({ key, value }) => {
      if (!key) throw new Error('缺少参数');
      return ctx.plugins.setGlobal(key, value);
    });

    ctx.pages.handle('toggle-plugin', async ({ id, enabled }) => {
      const rec = ctx.plugins.get(id);
      if (!rec) throw new Error('插件不存在');
      if (enabled) await ctx.plugins.enable(id);
      else await ctx.plugins.disable(id);
      return ctx.plugins.list();
    });

    ctx.pages.handle('uninstall-plugin', async ({ id }) => {
      await ctx.plugins.uninstall(id);
      return ctx.plugins.list();
    });

    ctx.pages.handle('install-plugin', async () => {
      const dir = await ctx.dialog.pickDirectory('选择插件文件夹（内含 manifest.json）');
      if (!dir) return null;
      await ctx.plugins.installFromDir(dir);
      return ctx.plugins.list();
    });

    ctx.pages.handle('open-plugin-dir', async ({ id }) => {
      const rec = ctx.plugins.get(id);
      if (!rec) throw new Error('插件不存在');
      return ctx.shell.showItemInFolder(rec.dir);
    });

    ctx.pages.handle('clear-data', async () => {
      await ctx.session.clearCache();
      return true;
    });

    ctx.log.info('设置页 RPC 已注册');
  },
};
