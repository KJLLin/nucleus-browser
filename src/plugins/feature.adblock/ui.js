/**
 * feature.adblock —— 渲染层侧：只负责显示与开关。
 * 真正的拦截逻辑在主进程，通过事件总线把统计数字送上来。
 */
import { icon } from 'nucleus://core/lib/icons.js';
import { h } from 'nucleus://core/lib/dom.js';

export async function activate(nucleus) {
  let total = 0;
  let enabled = nucleus.settings.get('enabled', true) !== false;

  const btn = h('button', {
    class: 'navbtn',
    title: '广告拦截',
    html: icon('shield', { size: 16 }),
  });
  const badge = h('span', { class: 'badge hidden' });
  btn.appendChild(badge);

  if (nucleus.regions.el('nav-right')) nucleus.regions.mount('nav-right', btn);

  // 状态栏条目：条件渲染 —— 只有开启且真的拦到了东西才出现。
  // inject 保证 ui.shell 晚于本插件加载时也不会丢。
  nucleus.slots.inject('shell.statusbar.items', ({ register }) => register({
    id: 'adblock:status',
    order: 20,
    when: () => enabled && total > 0,
    render: () => h('span', {
      class: 'status-item status-adblock',
      title: `广告拦截已拦截 ${total} 项请求`,
    }, `拦截 ${total}`),
  }));

  function paint() {
    btn.classList.toggle('on', enabled);
    badge.textContent = total > 999 ? '999+' : String(total);
    badge.classList.toggle('hidden', !enabled || total === 0);
    btn.title = enabled ? `广告拦截已开启 · 已拦截 ${total} 项` : '广告拦截已暂停';
    const svg = btn.querySelector('svg');
    if (svg) svg.style.opacity = enabled ? '1' : '0.45';
  }

  nucleus.bus.on('adblock:stats', (payload) => {
    if (!payload) return;
    if (typeof payload.total === 'number') total = payload.total;
    if (typeof payload.enabled === 'boolean') enabled = payload.enabled;
    paint();
    nucleus.slots.invalidate('shell.statusbar.items');
  });

  async function toggle() {
    enabled = !enabled;
    nucleus.settings.set('enabled', enabled);
    paint();
    nucleus.slots.invalidate('shell.statusbar.items');
    nucleus.ui.toast(enabled ? '广告拦截已开启' : '广告拦截已暂停', { type: enabled ? 'success' : 'info' });
  }

  btn.addEventListener('click', () => {
    const rect = btn.getBoundingClientRect();
    nucleus.ui.menu([
      { label: enabled ? '广告拦截：已开启' : '广告拦截：已暂停', header: true },
      { label: `本次运行已拦截 ${total} 项请求`, icon: 'shield', disabled: true },
      { separator: true },
      { label: enabled ? '暂停拦截' : '恢复拦截', icon: enabled ? 'shield-off' : 'shield', onClick: toggle },
      {
        label: '拦截设置…',
        icon: 'sliders',
        onClick: () => {
          nucleus.tabs.create({ url: 'nucleus://feature.settings/index.html#adblock' });
        },
      },
    ], { x: rect.left, y: rect.bottom + 6 });
  });

  nucleus.commands.register('adblock.toggle', {
    title: '启用 / 暂停广告拦截',
    icon: 'shield',
    handler: toggle,
  });

  nucleus.commands.register('adblock.stats', {
    title: '查看拦截统计',
    icon: 'shield',
    handler: () => btn.click(),
  });

  paint();
}
