/**
 * feature.palette —— 命令面板。
 *
 * 它不持有任何命令清单：调用 nucleus.commands.list() 现取，
 * 因此任何一个插件注册的命令都会立刻出现在这里。
 */
export async function activate(nucleus) {
  function open() {
    const cmds = nucleus.commands
      .list()
      .filter((c) => !c.hidden && c.hasHandler)
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'))
      .map((c) => ({
        id: c.id,
        title: c.title,
        icon: c.icon || 'command',
        keybinding: c.keybinding,
        subtitle: c.owner === 'core' ? '' : c.owner,
        keywords: [c.id, c.owner],
        run: () => nucleus.commands.execute(c.id, { via: 'palette' }),
      }));

    nucleus.ui.palette({
      commands: cmds,
      placeholder: '输入命令名称…',
      emptyText: '没有匹配的命令',
    });
  }

  nucleus.commands.register('palette.open', {
    title: '打开命令面板',
    icon: 'command',
    keybinding: 'Ctrl+K',
    handler: open,
  });

  nucleus.commands.register('palette.openShift', {
    title: '打开命令面板（备用快捷键）',
    icon: 'command',
    keybinding: 'Ctrl+Shift+P',
    handler: open,
  });
}
