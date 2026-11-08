/**
 * feature.notes —— 侧边便签。
 *
 * 这块面板刻意不做成「笔记应用」：
 * 没有多级目录、没有云端同步，只有一块能立刻写字的地方。
 * 内容存在插件自己的 storage 命名空间里（主进程按 pluginId 隔离），
 * 因此卸载插件时数据不会散落在全局设置里。
 */
import { h } from 'nucleus://core/lib/dom.js';
import { icon } from 'nucleus://core/lib/icons.js';

const KEY = 'scratch';
const OWNER = 'feature.notes';

export async function activate(nucleus) {
  await nucleus.storage.load();

  let textarea = null;
  let statusEl = null;
  let saveTimer = 0;

  const now = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const stats = (text) => {
    const chars = text.replace(/\s/g, '').length;
    const words = (text.match(/[A-Za-z0-9]+/g) || []).length;
    return `${chars} 字 · ${words} 词 · ${text.split('\n').length} 行`;
  };

  function updateStatus(saved) {
    if (!statusEl || !textarea) return;
    statusEl.textContent = saved
      ? `已保存 · ${stats(textarea.value)}`
      : `未保存… ${stats(textarea.value)}`;
  }

  function flush() {
    if (!textarea) return;
    nucleus.storage.set(KEY, textarea.value);
    updateStatus(true);
  }

  function scheduleSave() {
    updateStatus(false);
    clearTimeout(saveTimer);
    // 输入停顿 400ms 再落盘：逐字写文件既费 IO 又会让状态栏闪个不停
    saveTimer = setTimeout(flush, 400);
  }

  function insertStamp() {
    if (!textarea) return;
    const stamp = `\n[${now()}] `;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    textarea.value = textarea.value.slice(0, start) + stamp + textarea.value.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + stamp.length;
    textarea.focus();
    scheduleSave();
  }

  function build() {
    textarea = h('textarea', {
      class: 'notes-textarea',
      placeholder: '随手记点什么…（输入即保存）',
      spellcheck: 'false',
    });
    textarea.value = nucleus.storage.get(KEY, '') || '';
    if (nucleus.settings.get('mono', false)) textarea.classList.add('mono');
    textarea.addEventListener('input', scheduleSave);
    textarea.addEventListener('blur', flush);

    statusEl = h('div', { class: 'notes-status' });
    updateStatus(true);

    const stampBtn = h('button', { class: 'notes-btn', title: '插入当前时间', html: icon('clock', { size: 14 }) });
    stampBtn.addEventListener('click', insertStamp);

    const copyBtn = h('button', { class: 'notes-btn', title: '复制全部', html: icon('copy', { size: 14 }) });
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(textarea.value);
        nucleus.ui.toast('已复制便签内容', { type: 'success' });
      } catch (_) {
        nucleus.ui.toast('复制失败：剪贴板不可用', { type: 'error' });
      }
    });

    const clearBtn = h('button', { class: 'notes-btn', title: '清空', html: icon('trash', { size: 14 }) });
    clearBtn.addEventListener('click', async () => {
      if (!textarea.value.trim()) return;
      const ok = await nucleus.ui.confirm('清空便签？', '内容会被删除，且不能撤销。');
      if (!ok) return;
      textarea.value = '';
      flush();
      textarea.focus();
    });

    return h('div', { class: 'notes' },
      h('div', { class: 'notes-head' },
        h('span', { class: 'notes-title', html: `${icon('file-text', { size: 14 })}<span>便签</span>` }),
        h('div', { class: 'notes-actions' }, stampBtn, copyBtn, clearBtn)
      ),
      textarea,
      statusEl
    );
  }

  let open = false;

  function toggle() {
    open = nucleus.sidebar.toggle(OWNER, build, { side: 'right', width: 320 });
    if (open) setTimeout(() => textarea && textarea.focus(), 60);
    return open;
  }

  nucleus.commands.register('notes.toggle', {
    title: '侧边便签',
    icon: 'file-text',
    keybinding: 'Ctrl+Shift+N',
    handler: toggle,
  });

  nucleus.commands.register('notes.stamp', {
    title: '便签：插入当前时间',
    icon: 'clock',
    hidden: true,
    handler: () => {
      if (!open) toggle();
      insertStamp();
    },
  });

  // 面板被其它插件顶掉时同步状态，避免「以为还开着」
  nucleus.effect(
    () => nucleus.sidebar.onChange((owner) => { open = owner === OWNER; }),
    'notes.sidebar-sync'
  );

  // 关窗/切标签前把最后 400ms 内没落盘的内容写掉
  nucleus.effect(() => {
    const onHide = () => flush();
    window.addEventListener('beforeunload', onHide);
    return () => window.removeEventListener('beforeunload', onHide);
  }, 'notes.flush-on-unload');

  if (nucleus.settings.get('autoOpen', false)) toggle();

  nucleus.log.info('侧边便签已就绪');
}
