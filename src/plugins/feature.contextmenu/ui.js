/**
 * feature.contextmenu —— 网页右键菜单。
 *
 * webview 会把 context-menu 事件抛给渲染层，插件据此拼装菜单。
 * 输入框的剪切/粘贴直接调用 webview 自身的编辑方法，不经过系统剪贴板 API。
 */
export async function activate(nucleus) {
  nucleus.tabs.on('context-menu', ({ id, params }) => {
    if (!params) return;
    openMenu(id, params);
  });

  function openMenu(tabId, p) {
    const items = [];
    const wv = nucleus.tabs.webview(tabId);

    const copyText = async (text) => {
      try {
        await nucleus.invoke('nucleus:clipboard:write', { text });
        nucleus.ui.toast('已复制');
      } catch (_) {
        nucleus.ui.toast('复制失败', { type: 'error' });
      }
    };

    if (p.linkURL) {
      items.push({ label: '在新标签页中打开链接', icon: 'external-link', onClick: () => nucleus.tabs.create({ url: p.linkURL }) });
      items.push({ label: '复制链接地址', icon: 'copy', onClick: () => copyText(p.linkURL) });
      items.push({ separator: true });
    }

    if (p.srcURL && p.mediaType === 'image') {
      items.push({ label: '在新标签页中打开图片', icon: 'image', onClick: () => nucleus.tabs.create({ url: p.srcURL }) });
      items.push({ label: '复制图片地址', icon: 'copy', onClick: () => copyText(p.srcURL) });
      items.push({ separator: true });
    }

    if (p.selectionText && p.selectionText.trim()) {
      const text = p.selectionText.trim();
      items.push({
        label: `搜索「${text.length > 14 ? `${text.slice(0, 14)}…` : text}」`,
        icon: 'search',
        onClick: () => nucleus.tabs.create({ url: `https://cn.bing.com/search?q=${encodeURIComponent(text)}`, active: true }),
      });
      items.push({ label: '复制选中文字', icon: 'copy', onClick: () => copyText(text) });
      items.push({ separator: true });
    }

    if (p.isEditable) {
      items.push({ label: '撤销', icon: 'corner-down-left', onClick: () => wv?.undo?.() });
      items.push({ separator: true });
      items.push({ label: '剪切', icon: 'x', onClick: () => wv?.cut?.() });
      items.push({ label: '复制', icon: 'copy', onClick: () => wv?.copy?.() });
      items.push({ label: '粘贴', icon: 'save', onClick: () => wv?.paste?.() });
      items.push({ label: '全选', icon: 'type', onClick: () => wv?.selectAll?.() });
      items.push({ separator: true });
    }

    items.push({ label: '后退', icon: 'arrow-left', onClick: () => nucleus.tabs.goBack(tabId) });
    items.push({ label: '前进', icon: 'arrow-right', onClick: () => nucleus.tabs.goForward(tabId) });
    items.push({ label: '重新加载', icon: 'rotate-cw', onClick: () => nucleus.tabs.reload(tabId) });
    items.push({ separator: true });
    items.push({ label: '查看页面源代码', icon: 'file-text', onClick: () => {
      if (/^https?:/i.test(p.pageURL)) nucleus.tabs.create({ url: `view-source:${p.pageURL}` });
    } });
    items.push({ label: '检查元素', icon: 'cpu', onClick: () => nucleus.invoke('nucleus:devtools:toggle', { tabId }) });

    // 右键点在网页里，坐标要加上 webview 在窗口中的偏移
    const rect = document.getElementById('webarea').getBoundingClientRect();
    nucleus.ui.menu(items, {
      x: rect.left + (p.x || 0),
      y: rect.top + (p.y || 0),
    });
  }

  nucleus.commands.register('contextmenu.copy', {
    title: '复制',
    hidden: true,
    handler: () => {
      const tab = nucleus.tabs.active();
      const wv = tab ? nucleus.tabs.webview(tab.id) : null;
      wv?.copy?.();
    },
  });

  nucleus.commands.register('contextmenu.paste', {
    title: '粘贴',
    hidden: true,
    handler: () => {
      const tab = nucleus.tabs.active();
      const wv = tab ? nucleus.tabs.webview(tab.id) : null;
      wv?.paste?.();
    },
  });
}
