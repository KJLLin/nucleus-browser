/**
 * feature.extensions / 界面侧：只负责把管理页开出来。
 */
export function activate(nucleus) {
  nucleus.commands.register('extensions.open', {
    title: '管理浏览器扩展',
    icon: 'puzzle',
    handler: () => {
      const url = 'nucleus://feature.extensions/index.html';
      const existing = nucleus.tabs.list().find((t) => t.url === url);
      if (existing) nucleus.tabs.activate(existing.id);
      else nucleus.tabs.create({ url });
    },
  });
}
