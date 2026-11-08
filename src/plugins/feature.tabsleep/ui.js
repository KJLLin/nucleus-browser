/**
 * feature.tabsleep —— 标签休眠。
 *
 * 休眠不是「关掉标签」：标题、图标、地址都还在，点回来时按原地址重建，
 * 只是把那个标签的渲染进程先还给了系统。所以它适合「开了二十个标签，
 * 一下午只看其中三个」的用法，而不是当作清理工具。
 *
 * 全部逻辑都跑在渲染层的 fiber 里：
 *   - 定时器用 nucleus.effect 记账，插件禁用后自己就停了
 *   - 判断依据是标签的 lastActiveAt，由标签服务在激活时维护
 *   - 固定标签、内建页面、正在加载的标签永远不会被休眠
 */
export async function activate(nucleus) {
  const cfg = () => ({
    enabled: nucleus.settings.get('enabled', true) !== false,
    idleMinutes: Number(nucleus.settings.get('idleMinutes', 15)) || 15,
    keepRecent: Number(nucleus.settings.get('keepRecent', 2)) || 0,
  });

  let sleptTotal = 0;

  function sweep(manual) {
    const { enabled, idleMinutes, keepRecent } = cfg();
    if (!manual && !enabled) return 0;

    const n = nucleus.tabs.suspendIdle(idleMinutes * 60000, keepRecent);
    sleptTotal += n;

    if (manual) {
      if (n) nucleus.ui.toast(`已休眠 ${n} 个空闲标签`, { type: 'success' });
      else nucleus.ui.toast('没有符合条件的标签（固定标签、浏览器内建页面和当前标签不会休眠）');
    }
    return n;
  }

  // 每分钟扫一遍。effect 的清理函数保证禁用插件后定时器不会继续跑。
  nucleus.effect(() => {
    const timer = setInterval(() => sweep(false), 60000);
    return () => clearInterval(timer);
  }, 'tabsleep.ticker');

  nucleus.commands.register('tabsleep.now', {
    title: '立即休眠空闲标签',
    icon: 'moon',
    description: '把超过设定时长没看过的后台标签的渲染进程释放掉',
    handler: () => sweep(true),
  });

  nucleus.commands.register('tabsleep.wake', {
    title: '唤醒全部休眠标签',
    icon: 'sun',
    handler: () => {
      let n = 0;
      for (const tab of nucleus.tabs.list()) {
        if (tab.sleeping) {
          nucleus.tabs.resume(tab.id);
          n += 1;
        }
      }
      nucleus.ui.toast(n ? `已唤醒 ${n} 个标签` : '当前没有休眠中的标签');
      return n;
    },
  });

  nucleus.commands.register('tabsleep.toggle', {
    title: '开关自动休眠',
    icon: 'zap',
    handler: () => {
      const next = !cfg().enabled;
      nucleus.settings.set('enabled', next);
      nucleus.ui.toast(next ? '自动休眠已开启' : '自动休眠已关闭');
      return next;
    },
  });

  // 设置页一改就立刻按新值工作，不必等下一个 60 秒
  nucleus.effect(
    () => nucleus.settings.onChange(() => sweep(false)),
    'tabsleep.settings'
  );

  nucleus.log.info('标签休眠已就绪', cfg());

  return {
    stats: () => ({ sleptTotal, sleeping: nucleus.tabs.list().filter((t) => t.sleeping).length }),
  };
}
