/**
 * feature.inspector / 界面侧。
 *
 * 只做一件事：把自省页开出来。真正的逻辑在页面里，
 * 通过 nucleus.rpc 向本插件的主进程侧要快照。
 */
export function activate(nucleus) {
  nucleus.commands.register('inspector.open', {
    title: '打开运行时自省',
    icon: 'activity',
    handler: () => {
      const url = 'nucleus://feature.inspector/index.html';
      const existing = nucleus.tabs.list().find((t) => t.url === url);
      if (existing) nucleus.tabs.activate(existing.id);
      else nucleus.tabs.create({ url });
    },
  });
}
