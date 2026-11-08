/**
 * feature.shortcuts —— 快捷键速查。
 *
 * 数据不写死在插件里：直接读命令注册表，所以任何插件新注册的命令、
 * 声明的快捷键都会自动出现在这张表里。这也让「文档与实现不一致」
 * 这个问题在结构上消失了。
 */
import { h } from 'nucleus://core/lib/dom.js';
import { icon } from 'nucleus://core/lib/icons.js';

const OWNER_LABEL = {
  'ui.shell': '标签与地址栏',
  'feature.palette': '命令面板',
  'feature.find': '页内查找',
  'feature.history': '历史记录',
  'feature.bookmarks': '书签',
  'feature.session': '会话恢复',
  'feature.settings': '设置',
  'feature.devtools': '开发者工具',
  'feature.inspector': '运行时自省',
  'feature.reader': '阅读模式',
  'feature.screenshot': '截图',
  'feature.downloads': '下载管理',
  'feature.adblock': '广告拦截',
  'feature.extensions': '浏览器扩展',
  'feature.contextmenu': '右键菜单',
  'feature.tabsleep': '标签休眠',
  'feature.notes': '侧边便签',
  'feature.privacy': '隐私清理',
  'feature.shortcuts': '快捷键速查',
  'theme.nucleus': '主题',
  core: '浏览器内核',
};

const ownerName = (id) => OWNER_LABEL[id] || id;

export async function activate(nucleus) {
  async function open() {
    const all = nucleus.commands.list().filter((c) => !c.hidden);
    const withKey = all.filter((c) => c.keybinding);

    const input = h('input', {
      class: 'sc-search',
      type: 'text',
      placeholder: '搜索命令或按键…',
      spellcheck: 'false',
    });

    const listEl = h('div', { class: 'sc-list' });

    const groups = new Map();
    for (const cmd of all) {
      if (!groups.has(cmd.owner)) groups.set(cmd.owner, []);
      groups.get(cmd.owner).push(cmd);
    }

    const render = (query) => {
      const q = String(query || '').trim().toLowerCase();
      listEl.textContent = '';
      let shown = 0;

      for (const [owner, cmds] of Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        const hit = cmds.filter((c) => !q
          || c.title.toLowerCase().includes(q)
          || String(c.keybinding || '').toLowerCase().includes(q)
          || c.id.toLowerCase().includes(q));
        if (!hit.length) continue;

        listEl.appendChild(h('div', { class: 'sc-group' }, ownerName(owner)));
        for (const cmd of hit.sort((a, b) => (a.keybinding ? 0 : 1) - (b.keybinding ? 0 : 1))) {
          shown += 1;
          const row = h('button', { class: 'sc-row', title: cmd.description || cmd.id },
            h('span', { class: 'sc-icon', html: icon(cmd.icon || 'command', { size: 14 }) }),
            h('span', { class: 'sc-title' }, cmd.title),
            cmd.keybinding
              ? h('span', { class: 'sc-key' }, ...String(cmd.keybinding).split('+').flatMap((part, i, arr) => (
                i < arr.length - 1 ? [h('kbd', {}, part), h('span', { class: 'sc-plus' }, '+')] : [h('kbd', {}, part)]
              )))
              : h('span', { class: 'sc-key sc-key-none' }, '—')
          );
          row.addEventListener('click', () => {
            closeModal();
            Promise.resolve(nucleus.commands.execute(cmd.id)).catch((err) => {
              nucleus.ui.toast(err.message || '命令执行失败', { type: 'error' });
            });
          });
          listEl.appendChild(row);
        }
      }

      if (!shown) listEl.appendChild(h('div', { class: 'sc-empty' }, '没有匹配的命令'));
    };

    let closeModal = () => {};
    input.addEventListener('input', () => render(input.value));

    render('');
    setTimeout(() => input.focus(), 50);

    const body = h('div', { class: 'sc-body' },
      input,
      h('div', { class: 'sc-hint' }, `${all.length} 个命令 · ${withKey.length} 个带快捷键`),
      listEl
    );

    nucleus.ui.modal({
      title: '快捷键速查',
      body,
      width: 560,
      dismissValue: null,
      actions: [{ label: '关闭', value: null }],
    });

    // modal 没暴露关闭句柄；它的遮罩是 .scrim，点完后直接把这一层摘掉。
    // 内部那次 keydown 监听会在下一次 Esc 时自然失效（close 里做了 remove）。
    closeModal = () => {
      const scrim = document.querySelector('.scrim');
      if (scrim) scrim.remove();
    };
  }

  nucleus.commands.register('shortcuts.help', {
    title: '快捷键速查表',
    icon: 'command',
    keybinding: 'F1',
    description: '列出所有命令与当前生效的快捷键',
    handler: open,
  });

  nucleus.log.info('快捷键速查已就绪');
}
