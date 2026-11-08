'use strict';
/**
 * feature.extensions / 主进程侧。
 *
 * 管理页只是壳，真正的安装在核的 ExtensionService 里。
 * 这里负责把「页面能做什么」限制成一组明确的动作。
 */
module.exports = {
  activate(ctx) {
    ctx.pages.handle('ext.list', () => ctx.extensions.list());

    ctx.pages.handle('ext.enable', ({ id }) => ctx.extensions.enable(id));
    ctx.pages.handle('ext.disable', ({ id }) => ctx.extensions.disable(id));
    ctx.pages.handle('ext.uninstall', ({ id }) => ctx.extensions.uninstall(id));
    ctx.pages.handle('ext.reload', () => ctx.extensions.reload());

    ctx.pages.handle('ext.install', async () => {
      const dir = await ctx.dialog.pickDirectory('选择扩展文件夹（内含 manifest.json）');
      if (!dir) return null;
      return ctx.extensions.installFromDir(dir);
    });

    ctx.pages.handle('ext.open-tab', ({ url }) => {
      if (!/^nucleus:\/\/ext-[a-z0-9][a-z0-9._-]*\//i.test(String(url))) {
        throw new Error('只允许打开扩展页面');
      }
      return ctx.tabs.create({ url });
    });

    ctx.pages.handle('ext.manifest', ({ id }) => {
      const rec = ctx.extensions.list().find((x) => x.id === id);
      return rec || null;
    });
  },
};
