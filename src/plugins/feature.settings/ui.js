/** feature.settings 在浏览器外壳侧：只负责把设置页打开成标签。 */
export async function activate(nucleus) {
  const SETTINGS_URL = 'nucleus://feature.settings/index.html';

  function open(hash = '') {
    const url = hash ? `${SETTINGS_URL}#${hash}` : SETTINGS_URL;
    const existing = nucleus.tabs.list().find((t) => t.url.startsWith(SETTINGS_URL));
    if (existing && !hash) {
      nucleus.tabs.activate(existing.id);
      return;
    }
    nucleus.tabs.create({ url, active: true });
  }

  nucleus.commands.register('settings.open', {
    title: '打开设置',
    icon: 'settings',
    keybinding: 'Ctrl+,',
    handler: () => open(),
  });

  nucleus.commands.register('settings.plugins', {
    title: '管理插件',
    icon: 'puzzle',
    handler: () => open('plugins'),
  });
}
