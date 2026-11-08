/** feature.screenshot —— 用核的 capturePage 能力截图，再交给用户保存。 */
import { h } from 'nucleus://core/lib/dom.js';

export async function activate(nucleus) {
  async function capture() {
    const tab = nucleus.tabs.active();
    if (!tab) {
      nucleus.ui.toast('没有可截图的页面');
      return;
    }
    let dataUrl;
    try {
      dataUrl = await nucleus.tabs.capture(tab.id);
    } catch (err) {
      nucleus.ui.toast(`截图失败：${err.message}`, { type: 'error' });
      return;
    }

    const img = h('img', { src: dataUrl, style: { width: '100%', borderRadius: '8px', display: 'block' } });
    const name = `${(tab.title || 'page').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)}-${Date.now()}.png`;

    const res = await nucleus.ui.modal({
      title: '页面截图',
      body: h('div', { class: 'vstack' }, img),
      width: 620,
      actions: [
        { label: '关闭', value: 'close' },
        { label: '复制到剪贴板', value: 'copy' },
        { label: '保存为 PNG', value: 'save', primary: true },
      ],
      dismissValue: 'close',
    });

    if (res === 'save') {
      try {
        const saved = await nucleus.invoke('nucleus:file:save-image', { dataUrl, defaultName: name });
        if (saved) nucleus.ui.toast(`已保存到 ${saved}`, { type: 'success', timeout: 5000 });
      } catch (err) {
        nucleus.ui.toast(`保存失败：${err.message}`, { type: 'error' });
      }
    } else if (res === 'copy') {
      try {
        const blob = await (await fetch(dataUrl)).blob();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        nucleus.ui.toast('已复制到剪贴板', { type: 'success' });
      } catch (err) {
        nucleus.ui.toast('复制失败，请改用保存', { type: 'error' });
      }
    }
  }

  nucleus.commands.register('screenshot.capture', {
    title: '截取当前页面',
    icon: 'camera',
    keybinding: 'Ctrl+Shift+S',
    handler: capture,
  });
}
