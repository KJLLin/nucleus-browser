'use strict';
/**
 * feature.inspector / 主进程侧。
 *
 * 页面能拿到什么，完全由这里决定 —— 内部页面的 RPC 只对本插件开放。
 * ctx.plugins.inspect() 是核提供的只读快照，需要 plugins 权限。
 */
module.exports = {
  activate(ctx) {
    ctx.pages.handle('inspect.snapshot', () => ctx.plugins.inspect());
    // 健康检查单独一个方法：它会读进程句柄与账本，比快照重，所以不塞进 2 秒轮询里
    ctx.pages.handle('inspect.health', () => ctx.plugins.health());
    ctx.pages.handle('inspect.repair', () => ctx.plugins.repair());
    ctx.log.info('自省接口已注册');
  },
};
