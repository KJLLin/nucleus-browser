/**
 * 扩展管理页。
 *
 * 所有动作都走本插件的 pages RPC（ext.list / ext.enable / …），
 * 页面本身没有文件系统与进程能力。
 */
const rpc = (method, payload) => window.__nucleus.rpc(method, payload);

const listEl = document.getElementById('list');
const countEl = document.getElementById('count');

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number'
      ? document.createTextNode(String(c)) : c);
  }
  return el;
}

function toast(msg) {
  const el = h('div', { class: 'toast' }, msg);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2400);
}

function openTab(url) {
  window.__nucleus.rpc('ext.open-tab', { url }).catch(() => {
    // 主进程侧没有这个方法时退回当前页跳转
    location.href = url;
  });
}

async function load() {
  try {
    const items = await rpc('ext.list');
    render(items || []);
  } catch (err) {
    listEl.replaceChildren(h('div', { class: 'empty' },
      h('b', {}, '读取失败'), String(err && err.message ? err.message : err)));
  }
}

function render(items) {
  countEl.textContent = items.length ? `${items.length} 个已安装` : '';

  if (!items.length) {
    listEl.replaceChildren(h('div', { class: 'empty' },
      h('b', {}, '还没有安装任何扩展'),
      '点右上角「安装扩展」，选择一个含 manifest.json 的文件夹。',
      h('div', { style: 'margin-top:10px;font-size:11px' },
        '扩展会安装到 用户数据目录/extensions/，原文件夹可以删掉。')
    ));
    return;
  }

  listEl.replaceChildren(...items.map(card));
}

function card(ext) {
  const icon = ext.icon
    ? h('div', { class: 'ext-icon' }, h('img', { src: ext.icon, alt: ext.name }))
    : h('div', { class: 'ext-icon' }, (ext.name || '?').slice(0, 1).toUpperCase());

  const caps = [];
  if (ext.contentScripts) caps.push(`${ext.contentScripts} 个内容脚本`);
  if (ext.hasPopup) caps.push('popup');
  if (ext.hasOptions) caps.push('选项页');
  if (ext.hasBackground) caps.push('后台页');

  const toggle = h('input', {
    type: 'checkbox',
    onchange: async (e) => {
      const on = e.target.checked;
      try {
        await rpc(on ? 'ext.enable' : 'ext.disable', { id: ext.id });
        toast(on ? `已启用 ${ext.name}` : `已禁用 ${ext.name}`);
        load();
      } catch (err) {
        e.target.checked = !on;
        toast(err.message || '操作失败');
      }
    },
  });
  if (ext.enabled) toggle.checked = true;

  const actions = h('div', { class: 'ext-actions' });
  if (ext.hasPopup) {
    actions.appendChild(h('button', {
      class: 'mini',
      onclick: () => openTab(`nucleus://ext-${ext.id}/${ext.popupPath}`),
    }, '打开弹窗'));
  }
  if (ext.hasOptions) {
    actions.appendChild(h('button', {
      class: 'mini',
      onclick: () => openTab(`nucleus://ext-${ext.id}/${ext.optionsPath}`),
    }, '选项'));
  }
  actions.appendChild(h('button', {
    class: 'mini',
    onclick: () => {
      navigator.clipboard.writeText(ext.dir).then(
        () => toast('扩展目录已复制'),
        () => toast(ext.dir)
      );
    },
  }, '目录'));

  let armed = false;
  const del = h('button', {
    class: 'mini danger',
    onclick: async () => {
      if (!armed) {
        armed = true;
        del.textContent = '确认卸载？';
        setTimeout(() => { armed = false; del.textContent = '卸载'; }, 3000);
        return;
      }
      try {
        await rpc('ext.uninstall', { id: ext.id });
        toast(`已卸载 ${ext.name}`);
        load();
      } catch (err) {
        toast(err.message || '卸载失败');
      }
    },
  }, '卸载');

  return h('div', { class: `ext ${ext.enabled ? '' : 'off'}` },
    icon,
    h('div', { class: 'ext-main' },
      h('div', { class: 'ext-title' },
        h('span', { class: 'ext-name' }, ext.name),
        h('span', { class: 'ext-ver' }, `v${ext.version}`),
        h('span', { class: 'tag' }, `MV${ext.manifestVersion}`),
        caps.map((c) => h('span', { class: 'tag ok' }, c)),
        ext.unsupportedPermissions.length
          ? ext.unsupportedPermissions.map((p) => h('span', { class: 'tag warn' }, p))
          : null
      ),
      ext.description ? h('div', { class: 'ext-desc' }, ext.description) : null,
      ext.errors && ext.errors.length
        ? h('div', { class: 'ext-error' }, `清单问题：${ext.errors.join('；')}`)
        : null,
      ext.unsupported && ext.unsupported.length
        ? h('div', { class: 'ext-warn' }, `不支持：${ext.unsupported.join('；')}`)
        : null,
      h('div', { class: 'path' }, ext.dir)
    ),
    h('div', { class: 'ext-side' },
      h('label', { class: 'switch' }, toggle, h('span', { class: 'track' }), ext.enabled ? '已启用' : '已禁用'),
      actions,
      del
    )
  );
}

document.getElementById('install').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const rec = await rpc('ext.install');
    if (rec) toast(`已安装 ${rec.name}`);
    load();
  } catch (err) {
    toast(err.message || '安装失败');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('reload').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await rpc('ext.reload');
    load();
    toast('已重新扫描扩展目录');
  } catch (err) {
    toast(err.message || '扫描失败');
  } finally {
    btn.disabled = false;
  }
});

load();
