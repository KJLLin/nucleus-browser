/**
 * theme.nucleus —— 主题插件。
 *
 * 整个界面的颜色都由 CSS 变量驱动，所以「换主题」在这里只是替换一组变量。
 * 想做一个自己的主题？复制这个文件，改掉颜色表，再写一份 manifest 就行。
 */

const DARK = {
  '--bg': '#14161a',
  '--bg-chrome': '#1b1e24',
  '--bg-elev': '#232830',
  '--bg-input': '#22262e',
  '--bg-hover': '#2c313b',
  '--bg-active': '#353b47',
  '--border': '#2c313b',
  '--border-strong': '#3f4652',
  '--border-soft': '#24282f',
  '--text': '#e8ebf1',
  '--text-dim': '#99a2b2',
  '--text-faint': '#6b7484',
  '--accent': '#5b8cff',
  '--accent-hover': '#7aa2ff',
  '--accent-soft': 'rgba(91,140,255,0.15)',
  '--danger': '#ff5f57',
  '--warn': '#f0b232',
  '--ok': '#3ecf8e',
  '--shadow-1': '0 2px 10px rgba(0,0,0,0.35)',
  '--shadow-2': '0 16px 48px rgba(0,0,0,0.55)',
};

const LIGHT = {
  '--bg': '#ffffff',
  '--bg-chrome': '#e9edf4',
  '--bg-elev': '#ffffff',
  '--bg-input': '#dde3ec',
  '--bg-hover': '#dfe5ee',
  '--bg-active': '#dbe1ea',
  '--border': '#d5dbe5',
  '--border-strong': '#b9c2d1',
  '--border-soft': '#e8ecf2',
  '--text': '#1b1f27',
  '--text-dim': '#4d5766',
  '--text-faint': '#8a93a2',
  '--accent': '#2f6fed',
  '--accent-hover': '#1f5cd8',
  '--accent-soft': 'rgba(47,111,237,0.11)',
  '--danger': '#d93025',
  '--warn': '#b26a00',
  '--ok': '#1a8f5f',
  '--shadow-1': '0 2px 10px rgba(15,23,42,0.10)',
  '--shadow-2': '0 16px 48px rgba(15,23,42,0.18)',
};

const DENSITY = {
  compact: { '--topbar-h': '34px', '--toolbar-h': '40px' },
  comfortable: { '--topbar-h': '40px', '--toolbar-h': '46px' },
  spacious: { '--topbar-h': '44px', '--toolbar-h': '52px' },
};

export async function activate(nucleus) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const root = document.documentElement;

  function resolve(mode) {
    if (mode === 'auto') return mq.matches ? 'dark' : 'light';
    return mode === 'light' ? 'light' : 'dark';
  }

  function apply(mode) {
    const actual = resolve(mode);

    // 把「最终解析出来的主题」广播给 nucleus:// 内部页面。
    // 注意这里不动 nativeTheme —— 那会连带改掉普通网页的默认文字色。
    nucleus.invoke('nucleus:theme:broadcast', { theme: actual }).catch(() => {});
    const vars = actual === 'dark' ? DARK : LIGHT;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    root.dataset.theme = actual;
    root.style.colorScheme = actual;

    const density = nucleus.settings.get('density', 'comfortable');
    const d = DENSITY[density] || DENSITY.comfortable;
    for (const [k, v] of Object.entries(d)) root.style.setProperty(k, v);
  }

  function setMode(mode) {
    nucleus.settings.set('mode', mode);
    apply(mode);
  }

  apply(nucleus.settings.get('mode', 'auto'));

  mq.addEventListener('change', () => {
    if (nucleus.settings.get('mode', 'auto') === 'auto') apply('auto');
  });

  nucleus.settings.onChange((value, key) => {
    if (key === 'mode' || key === 'density') apply(nucleus.settings.get('mode', 'auto'));
  });

  nucleus.commands.register('theme.toggle', {
    title: '在深色与浅色之间切换',
    icon: 'moon',
    keybinding: 'Ctrl+Shift+L',
    handler: () => {
      const current = resolve(nucleus.settings.get('mode', 'auto'));
      setMode(current === 'dark' ? 'light' : 'dark');
      nucleus.ui.toast(`已切换到${current === 'dark' ? '浅色' : '深色'}主题`);
    },
  });

  nucleus.commands.register('theme.dark', { title: '切换到深色主题', icon: 'moon', handler: () => setMode('dark') });
  nucleus.commands.register('theme.light', { title: '切换到浅色主题', icon: 'sun', handler: () => setMode('light') });
  nucleus.commands.register('theme.auto', { title: '跟随系统外观', icon: 'monitor', handler: () => setMode('auto') });
}
