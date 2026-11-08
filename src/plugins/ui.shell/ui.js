/**
 * ui.shell —— 浏览器基础界面。
 *
 * 一个插件承载整套交互外壳：标签栏、导航按钮、地址栏、新标签页。
 * 这是「一切皆插件」最直接的体现 —— 把它禁用，浏览器就只剩一块空白的网页区域。
 */
import { initTabstrip } from './tabstrip.js';
import { initOmnibox } from './omnibox.js';
import { h } from 'nucleus://core/lib/dom.js';

/**
 * 界面区域的所有权在这里，不在核里。
 *
 * 宿主只提供一个空的根（body）与几个位置合适的 DOM 容器；
 * 「有哪些区域、每个区域是什么组合方式、谁能往里面放东西」全部由本插件声明。
 * 这样换一个界面插件就等于换一套布局，核不需要改一行代码。
 */
const REGION_SPECS = [
  { name: 'wincontrols', card: 'list', desc: '窗口控制按钮组', ownerOnly: 'ui.window', permission: 'window' },
  { name: 'tabstrip', card: 'list', desc: '标签栏' },
  { name: 'nav-left', card: 'list', desc: '导航按钮区（后退/前进/刷新）' },
  { name: 'nav-center', card: 'list', desc: '地址栏区' },
  { name: 'nav-right', card: 'list', desc: '工具栏右侧（下载、拦截、扩展等）' },
  { name: 'sidebar', card: 'single', desc: '侧边栏（同一时刻只显示一个面板）' },
  { name: 'statusbar', card: 'list', desc: '状态栏' },
  { name: 'overlay', card: 'list', desc: '浮层（提示、菜单、命令面板）' },
];

function declareRegions(nucleus) {
  for (const spec of REGION_SPECS) {
    const name = `region.${spec.name}`;
    if (nucleus.slots.tree().slots.some((s) => s.name === name)) {
      // 界面临时重载时 root 还活着，重复声明会被注册表拒绝；这里先跳过
      continue;
    }
    nucleus.slots.declare({
      name,
      parent: 'root',
      cardinality: spec.card,
      scope: 'root',
      description: spec.desc,
      // 窗口按钮属于安全边界附近（能关窗、能最大化），只允许 ui.window 注册
      policy: spec.ownerOnly
        ? { restricted: true, allow: [spec.ownerOnly], permission: spec.permission }
        : undefined,
    });
    const el = document.querySelector(`[data-region="${spec.name}"]`);
    if (el) nucleus.slots.adopt(name, el);
  }
}

/**
 * 状态栏。核只给了 region.statusbar 这个根空位，
 * 内容由这里开出的 shell.statusbar.items 决定 —— 其它插件往那儿注册即可，
 * 不需要知道状态栏长什么样。
 */
function initStatusbar(nucleus) {
  const bar = nucleus.regions.el('statusbar');
  if (!bar) return;

  const container = h('div', { class: 'status-items' });
  nucleus.regions.mount('statusbar', container, { order: 10 });

  nucleus.slots.declare({
    name: 'shell.statusbar.items',
    parent: 'region.statusbar',
    cardinality: 'list',
    scope: 'tab-maybe',
    description: '状态栏条目（拦截计数、下载进度等）',
  });

  const host = nucleus.slots.outlet('shell.statusbar.items', { tab: nucleus.tabs.active() });
  container.appendChild(host);

  // 没有条目时整条状态栏不出现，避免一条空胶囊常驻在网页上
  const syncVisible = () => bar.classList.toggle('has-content', host.children.length > 0);
  const mo = new MutationObserver(syncVisible);
  mo.observe(host, { childList: true });
  nucleus.effect(() => () => mo.disconnect());
  syncVisible();

  nucleus.tabs.on('activated', () => {
    nucleus.slots.updateOutlet(host, { tab: nucleus.tabs.active() });
  });
}

export async function activate(nucleus) {
  // 区域必须先于一切内容声明：其它插件用 slots.inject 等它出现，
  // 声明晚一步就会让它们多等一轮重绘。
  declareRegions(nucleus);

  // 先建导航条，再建标签栏：两者都只依赖 nucleus.tabs，没有先后约束，
  // 但这样首帧的顺序更接近用户从左到右的阅读习惯
  initOmnibox(nucleus);
  initTabstrip(nucleus);
  initStatusbar(nucleus);
}
