/**
 * ui.window —— 窗口控制。
 *
 * 边界很清楚：
 *   宿主创建 BrowserWindow、负责最小尺寸、位置记忆、多屏校正；
 *   这个插件只负责标题栏右侧那三个按钮的**语义**与图标状态。
 *
 * 之所以要拆出来，是因为「窗口按钮长什么样、双击标题栏做什么」
 * 是产品策略，不是操作系统能力。换一套标题栏（比如 macOS 风格红绿灯、
 * 或者移动端手势条）不应该需要改主进程。
 */
import { h } from 'nucleus://core/lib/dom.js';

const ICON = {
  min: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5h6" stroke="currentColor" stroke-width="1"/></svg>',
  max: '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="2.5" y="2.5" width="5" height="5" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
  restore: '<svg viewBox="0 0 10 10" aria-hidden="true">'
    + '<rect x="2" y="3.6" width="4.6" height="4.6" fill="none" stroke="currentColor" stroke-width="1"/>'
    + '<path d="M3.6 3.6V2h4.4v4.4H6.6" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
  close: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" stroke-width="1"/></svg>',
};

export async function activate(nucleus) {
  const call = (action) => nucleus.invoke('nucleus:window:action', { action })
    .catch((err) => {
      nucleus.log.warn(`窗口操作 ${action} 失败`, err.message);
      return null;
    });

  const mk = (kind, title, icon, action) => {
    const btn = h('button', {
      class: `wc${kind === 'close' ? ' close' : ''}`,
      title,
      'aria-label': title,
      html: icon,
    });
    btn.addEventListener('click', () => { call(action); });
    return btn;
  };

  const minBtn = mk('min', '最小化', ICON.min, 'minimize');
  const maxBtn = mk('max', '最大化', ICON.max, 'maximize');
  const closeBtn = mk('close', '关闭', ICON.close, 'close');

  const setMaxIcon = (maximized) => {
    maxBtn.innerHTML = maximized ? ICON.restore : ICON.max;
    maxBtn.title = maximized ? '还原' : '最大化';
  };

  // 用 inject 而不是直接 register：区域由 ui.shell 声明，
  // 如果它晚加载、或者被临时禁用后重新启用，按钮会自动跟着回来/消失，
  // 而不是让本插件在启动时因为「空位尚未声明」直接失败。
  nucleus.slots.inject('region.wincontrols', ({ register }) => {
    register({ id: 'ui.window:min', order: 10, render: () => minBtn });
    register({ id: 'ui.window:max', order: 20, render: () => maxBtn });
    register({ id: 'ui.window:close', order: 30, render: () => closeBtn });
  });

  // 初始状态 + 后续变化都从主进程来：窗口是不是最大化，只有宿主知道
  nucleus.invoke('nucleus:window:state', {})
    .then((s) => setMaxIcon(!!(s && s.maximized)))
    .catch(() => {});
  nucleus.effect(
    () => nucleus.window.on('maximized', (maximized) => setMaxIcon(!!maximized)),
    'ui.window.maximized'
  );

  // 双击标题栏最大化：这是窗口装饰的惯例，但只应该在没有点中标签/按钮时生效
  if (nucleus.settings.get('doubleClickMaximize', true)) {
    const topbar = document.getElementById('topbar');
    if (topbar) {
      const onDblClick = (e) => {
        if (e.target.closest('.tabstrip, button, input, .wc')) return;
        call('maximize');
      };
      topbar.addEventListener('dblclick', onDblClick);
      nucleus.effect(() => () => topbar.removeEventListener('dblclick', onDblClick), 'ui.window.dblclick');
    }
  }

  // 品牌标识显隐（有些用户喜欢更干净的标题栏）
  const brand = document.querySelector('#topbar .brand');
  if (brand) {
    const sync = () => {
      const on = nucleus.settings.get('showBrand', true) !== false;
      brand.style.display = on ? '' : 'none';
    };
    sync();
    nucleus.effect(() => nucleus.settings.onChange(sync), 'ui.window.brand');
  }

  nucleus.commands.register('window.minimize', {
    title: '最小化窗口', icon: 'minus', hidden: true,
    handler: () => call('minimize'),
  });
  nucleus.commands.register('window.maximize', {
    title: '最大化 / 还原窗口', icon: 'maximize-2', hidden: true,
    handler: () => call('maximize'),
  });
  nucleus.commands.register('window.close', {
    title: '关闭窗口', icon: 'x', hidden: true,
    handler: () => call('close'),
  });
  nucleus.commands.register('window.fullscreen', {
    title: '切换全屏', icon: 'maximize-2', keybinding: 'F11',
    handler: () => call('fullscreen'),
  });

  nucleus.log.info('窗口控制已就绪');
}
