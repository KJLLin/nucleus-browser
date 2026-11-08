/** feature.devtools —— 把开发者工具开关交给核的 IPC，插件本身不碰 Electron API。 */
export async function activate(nucleus) {
  const activeTab = () => nucleus.tabs.active();

  nucleus.commands.register('devtools.toggle', {
    title: '打开 / 关闭开发者工具',
    icon: 'code',
    keybinding: 'F12',
    handler: async () => {
      const tab = activeTab();
      if (!tab) return;
      const ok = await nucleus.invoke('nucleus:devtools:toggle', { tabId: tab.id });
      if (!ok) nucleus.ui.toast('无法打开开发者工具：页面尚未就绪', { type: 'error' });
    },
  });

  nucleus.commands.register('devtools.inspect', {
    title: '检查元素',
    icon: 'cpu',
    keybinding: 'Ctrl+Shift+C',
    handler: async () => {
      const tab = activeTab();
      if (!tab) return;
      await nucleus.invoke('nucleus:devtools:toggle', { tabId: tab.id });
    },
  });

  nucleus.commands.register('devtools.viewSource', {
    title: '查看页面源代码',
    icon: 'file-text',
    keybinding: 'Ctrl+U',
    handler: () => {
      const tab = activeTab();
      if (!tab || !/^https?:/i.test(tab.url)) {
        nucleus.ui.toast('当前页面不支持查看源代码');
        return;
      }
      nucleus.tabs.create({ url: `view-source:${tab.url}`, active: true });
    },
  });
}
