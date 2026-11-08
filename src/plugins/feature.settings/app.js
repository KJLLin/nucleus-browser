/**
 * 设置页的前端。
 *
 * 它运行在 webview 里，不是浏览器外壳的一部分 —— 所有数据都通过
 * __nucleus.rpc 向 feature.settings 的主进程插件索取。
 * 页面本身不认识任何一个具体的设置项：表单完全由 manifest 的 contributes.settings 生成。
 */
import { icon } from 'nucleus://core/lib/icons.js';

const rpc = (method, payload) => window.__nucleus.rpc(method, payload);

const state = {
  data: null,
  route: 'general',
  query: '',
};

const navEl = document.getElementById('nav');
const mainEl = document.getElementById('main');

// ---------- 工具 ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(3)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function pluginSettings(plugin) {
  const out = {};
  for (const section of plugin.manifest?.contributes?.settings || []) {
    for (const item of section.items || []) {
      out[item.key] = { ...item, value: item.key in (plugin.settings || {}) ? plugin.settings[item.key] : item.default };
    }
  }
  return out;
}

// ---------- 导航 ----------

const ICONS = {
  general: 'sliders',
  plugins: 'puzzle',
  about: 'info',
};

function buildNav() {
  navEl.innerHTML = '';

  navEl.appendChild(h('div', { class: 'nav-group' }, '浏览器'));
  navEl.appendChild(navItem('general', '通用', ICONS.general));

  const withSettings = state.data.plugins.filter(
    (p) => p.enabled && (p.manifest?.contributes?.settings || []).some((s) => s.items?.length)
  );

  if (withSettings.length) {
    navEl.appendChild(h('div', { class: 'nav-group' }, '插件设置'));
    for (const p of withSettings) {
      navEl.appendChild(navItem(`plugin:${p.id}`, p.manifest.name, 'settings', p.builtin ? '' : '扩展'));
    }
  }

  navEl.appendChild(h('div', { class: 'nav-group' }, '管理'));
  navEl.appendChild(navItem('plugins', '插件管理', ICONS.plugins, String(state.data.plugins.length)));
  navEl.appendChild(navItem('about', '关于 Nucleus', ICONS.about));
}

function navItem(route, label, iconName, tag) {
  const el = h('div', {
    class: `nav-item ${state.route === route ? 'active' : ''}`,
    onclick: () => go(route),
  },
    h('span', { class: 'ico', html: icon(iconName, { size: 14 }) }),
    h('span', { class: 'grow' }, label),
    tag ? h('span', { class: 'tag' }, tag) : null
  );
  return el;
}

function go(route) {
  state.route = route;
  location.hash = route;
  buildNav();
  render();
  mainEl.scrollTop = 0;
}

// ---------- 表单控件 ----------

function control(item, onChange) {
  switch (item.type) {
    case 'boolean': {
      const sw = h('div', { class: `switch ${item.value ? 'on' : ''}` });
      sw.addEventListener('click', () => {
        const next = !sw.classList.contains('on');
        sw.classList.toggle('on', next);
        onChange(next);
      });
      return sw;
    }
    case 'select': {
      const sel = h('select', {});
      for (const opt of item.options || []) {
        const o = h('option', { value: String(opt.value) }, opt.label);
        if (String(item.value) === String(opt.value)) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => {
        const raw = item.options?.find((o) => String(o.value) === sel.value)?.value;
        onChange(raw);
      });
      return sel;
    }
    case 'range': {
      const val = h('span', { class: 'val' }, String(item.value));
      const input = h('input', {
        type: 'range',
        min: String(item.min ?? 0),
        max: String(item.max ?? 100),
        step: String(item.step ?? 1),
        value: String(item.value),
      });
      input.addEventListener('input', () => { val.textContent = input.value; });
      input.addEventListener('change', () => onChange(Number(input.value)));
      return h('div', { class: 'field-control' }, input, val);
    }
    case 'number': {
      const input = h('input', { type: 'text', value: String(item.value ?? '') });
      input.addEventListener('change', () => {
        const n = Number(input.value);
        if (!Number.isNaN(n)) onChange(n);
      });
      return input;
    }
    case 'color': {
      const input = h('input', { type: 'color', value: String(item.value || '#5b8cff') });
      input.addEventListener('change', () => onChange(input.value));
      return input;
    }
    default: {
      const input = h('input', {
        type: 'text',
        value: String(item.value ?? ''),
        placeholder: item.placeholder || '',
      });
      input.addEventListener('change', () => onChange(input.value));
      return input;
    }
  }
}

function fieldRow(item, onChange) {
  return h('div', { class: 'field' },
    h('div', { class: 'meta' },
      h('div', { class: 'label' }, item.label),
      item.description ? h('div', { class: 'desc' }, item.description) : null
    ),
    h('div', { class: 'control' }, control(item, onChange))
  );
}

// ---------- 页面渲染 ----------

function pageHead(title, sub) {
  return h('div', { class: 'page-head' },
    h('h1', {}, title),
    sub ? h('div', { class: 'sub' }, sub) : null
  );
}

const GENERAL_ITEMS = [
  {
    key: 'appearance.frameless',
    label: '使用无边距自绘窗口',
    type: 'boolean',
    value: state.data?.global?.['appearance.frameless'] !== false,
    description: '关闭后改用系统标题栏。如果在 Windows 7 上遇到窗口边缘无法拖动调整大小，可关掉此项并重启。',
  },
];

function renderGeneral() {
  mainEl.innerHTML = '';
  mainEl.appendChild(pageHead('通用', '这些设置属于浏览器本体（核），不属于任何插件。'));

  const card = h('div', { class: 'card' }, h('div', { class: 'card-title' }, '窗口'));
  for (const item of GENERAL_ITEMS) {
    card.appendChild(fieldRow(item, async (v) => {
      item.value = v;
      await rpc('global-setting', { key: item.key, value: v });
      toast('已保存，重启后生效');
    }));
  }
  mainEl.appendChild(card);

  const cache = h('div', { class: 'card' }, h('div', { class: 'card-title' }, '数据'));
  cache.appendChild(h('div', { class: 'field' },
    h('div', { class: 'meta' },
      h('div', { class: 'label' }, '清除缓存'),
      h('div', { class: 'desc' }, '清除网页缓存与本地存储。已登录的网站可能需要重新登录。')
    ),
    h('div', { class: 'control' },
      h('button', {
        class: 'btn ghost',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await rpc('clear-data');
            toast('缓存已清除');
          } catch (err) {
            toast(`清除失败：${err.message}`);
          }
          e.target.disabled = false;
        },
      }, '立即清除')
    )
  ));
  mainEl.appendChild(cache);

  mainEl.appendChild(h('div', { class: 'note' },
    h('div', {}, h('b', {}, '关于「一切皆插件」：')),
    h('div', {}, '核只提供窗口、标签容器、插件宿主与权限校验。地址栏、标签栏、书签、历史、下载、广告拦截、主题、右键菜单、命令面板，甚至这个设置页，全部是插件。你可以在「插件管理」里把它们逐个关掉，看看浏览器会变成什么样。')
  ));
}

function renderPluginSettings(plugin) {
  mainEl.innerHTML = '';
  mainEl.appendChild(pageHead(
    plugin.manifest.name,
    `${plugin.manifest.description || ''}`
  ));

  const all = pluginSettings(plugin);
  const sections = plugin.manifest.contributes.settings || [];

  for (const section of sections) {
    const card = h('div', { class: 'card' }, h('div', { class: 'card-title' }, section.section || '常规'));
    for (const raw of section.items || []) {
      const item = all[raw.key];
      if (!item) continue;
      card.appendChild(fieldRow(item, async (v) => {
        item.value = v;
        await rpc('plugin-setting', { pluginId: plugin.id, key: raw.key, value: v });
        toast('已保存');
      }));
    }
    mainEl.appendChild(card);
  }

  mainEl.appendChild(h('div', { class: 'note' },
    h('div', {}, '插件 ID：', h('b', {}, plugin.id), `　版本 ${plugin.manifest.version}　作者 ${plugin.manifest.author}`),
    h('div', { style: { marginTop: '6px' } },
      '这些设置项由插件在 manifest 的 contributes.settings 里声明，设置页只是照着生成表单 —— 加一个新设置不需要改这里一行代码。')
  ));
}

function renderPlugins() {
  mainEl.innerHTML = '';
  mainEl.appendChild(pageHead('插件管理', '启用、禁用、安装与卸载。禁用一个插件后，它贡献的所有界面元素与命令会立即消失。'));

  const toolbar = h('div', { style: { display: 'flex', gap: '8px', marginBottom: '16px' } },
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        try {
          const list = await rpc('install-plugin');
          if (list) {
            state.data.plugins = list;
            buildNav();
            render();
            toast('插件已安装');
          }
        } catch (err) {
          toast(`安装失败：${err.message}`);
        }
      },
    }, '从文件夹安装…'),
    h('button', {
      class: 'btn ghost',
      onclick: async () => {
        state.data.plugins = await rpc('bootstrap').then((d) => d.plugins);
        buildNav();
        render();
        toast('列表已刷新');
      },
    }, '刷新列表')
  );
  mainEl.appendChild(toolbar);

  const card = h('div', { class: 'card' });
  const sorted = [...state.data.plugins].sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });

  for (const p of sorted) {
    const m = p.manifest;
    const row = h('div', { class: 'plugin-row' },
      h('div', { class: 'avatar', html: icon('puzzle', { size: 16 }) }),
      h('div', { class: 'info' },
        h('div', { class: 'name' },
          m ? m.name : p.id,
          h('span', { class: 'id' }, p.id),
          p.builtin ? h('span', { class: 'badge' }, '内置') : h('span', { class: 'badge accent' }, '扩展'),
          p.status === 'error' ? h('span', { class: 'badge danger' }, '异常') : null,
          !p.enabled ? h('span', { class: 'badge warn' }, '已禁用') : null
        ),
        h('div', { class: 'desc' }, p.error || m?.description || ''),
        h('div', { class: 'perms' },
          ...(m?.permissions || []).map((perm) => h('span', { class: 'badge' }, perm)),
          ...(m?.contributes?.commands || []).length
            ? [h('span', { class: 'badge' }, `${m.contributes.commands.length} 命令`)]
            : []
        )
      ),
      h('div', { class: 'actions' },
        h('div', {
          class: `switch ${p.enabled ? 'on' : ''}`,
          title: p.enabled ? '禁用' : '启用',
          onclick: async (e) => {
            const sw = e.currentTarget;
            const next = !sw.classList.contains('on');
            sw.classList.toggle('on', next);
            try {
              state.data.plugins = await rpc('toggle-plugin', { id: p.id, enabled: next });
              buildNav();
              toast(next ? `${m?.name} 已启用` : `${m?.name} 已禁用`, {});
              render();
            } catch (err) {
              sw.classList.toggle('on', !next);
              toast(`操作失败：${err.message}`);
            }
          },
        }),
        !p.builtin
          ? h('button', {
              class: 'btn sm danger',
              onclick: async (e) => {
                const btn = e.currentTarget;
                if (btn.dataset.armed !== '1') {
                  btn.dataset.armed = '1';
                  btn.textContent = '确认卸载？';
                  setTimeout(() => {
                    if (!btn.isConnected) return;
                    btn.dataset.armed = '0';
                    btn.textContent = '卸载';
                  }, 3500);
                  return;
                }
                try {
                  state.data.plugins = await rpc('uninstall-plugin', { id: p.id });
                  buildNav();
                  render();
                  toast('已卸载');
                } catch (err) {
                  toast(`卸载失败：${err.message}`);
                }
              },
            }, '卸载')
          : null
      )
    );
    card.appendChild(row);
  }
  mainEl.appendChild(card);

  mainEl.appendChild(h('div', { class: 'note', style: { marginTop: '18px' } },
    h('div', {}, h('b', {}, '关于权限：')),
    h('div', {}, '每个插件在 manifest 里声明它需要的能力（tabs、network、storage…）。核在 IPC 层逐条校验，声明之外的能力调用会直接失败。这能防止插件误用接口，但不构成对恶意代码的沙箱隔离 —— 请只安装你信任的插件。')
  ));
}

function renderAbout() {
  mainEl.innerHTML = '';
  const a = state.data.app;
  const enabledCount = state.data.plugins.filter((p) => p.enabled).length;

  mainEl.appendChild(h('div', { class: 'about-hero' },
    h('div', { class: 'mark', html: icon('layers', { size: 26 }) }),
    h('div', {},
      h('h2', {}, 'Nucleus'),
      h('div', { class: 'ver' }, `v${a.version} · Electron ${a.electron} · Chromium ${a.chrome} · Cordis ${a.cordis || '4'}`)
    )
  ));

  const card = h('div', { class: 'card' }, h('div', { class: 'card-title' }, '运行环境'));
  const rows = [
    ['应用版本', a.version],
    ['Electron', a.electron],
    ['Chromium 内核', a.chrome],
    ['操作系统', a.isWin7 ? 'Windows 7（兼容模式）' : navigator.userAgent.includes('Windows') ? 'Windows' : navigator.platform],
    ['已启用插件', `${enabledCount} / ${state.data.plugins.length}`],
    ['渲染引擎', 'Blink'],
  ];
  for (const [k, v] of rows) {
    card.appendChild(h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, String(v))));
  }
  mainEl.appendChild(card);

  mainEl.appendChild(h('div', { class: 'note' },
    h('div', { style: { fontSize: '13px', color: 'var(--text)', marginBottom: '8px', fontWeight: '600' } }, '一切皆插件'),
    h('div', {}, '插件树、副作用回收、服务注册与依赖注入由 Cordis 负责 —— 和 DeepSeek Harness 同一个内核。核只保留它不提供的部分：开窗口、装网页、校验权限、内部协议与进程间桥接。除此之外你看到的每一个按钮、每一块面板、每一个页面，都是插件。'),
    h('div', { style: { marginTop: '10px' } }, '这意味着浏览器是可以被你重新组装的：不想要广告拦截就关掉它；不喜欢这套界面，就禁用 ui.shell 换一整套你自己的。核里没有任何一处代码知道「地址栏」长什么样。'),
    h('div', { style: { marginTop: '10px', color: 'var(--text-faint)' } }, `Chromium ${a.chrome} · Cordis ${a.cordis || '4'} 插件内核 · 支持 Windows 7 及以上 · MIT License`)
  ));
}

// ---------- 搜索 ----------

function renderSearch() {
  mainEl.innerHTML = '';
  mainEl.appendChild(pageHead('搜索结果', `关键词：${state.query}`));

  const q = state.query.toLowerCase();
  const results = [];

  for (const p of state.data.plugins) {
    const all = pluginSettings(p);
    for (const item of Object.values(all)) {
      const hay = `${item.label} ${item.description || ''} ${p.manifest?.name || ''}`.toLowerCase();
      if (hay.includes(q)) results.push({ plugin: p, item });
    }
  }

  if (!results.length) {
    mainEl.appendChild(h('div', { class: 'empty' }, '没有匹配的设置项'));
    return;
  }

  const card = h('div', { class: 'card' }, h('div', { class: 'card-title' }, `${results.length} 项`));
  for (const { plugin, item } of results) {
    card.appendChild(h('div', { class: 'field' },
      h('div', { class: 'meta' },
        h('div', { class: 'label' }, item.label),
        h('div', { class: 'desc' }, `${plugin.manifest?.name || plugin.id} · ${item.description || item.key}`)
      ),
      h('div', { class: 'control' }, control(item, async (v) => {
        item.value = v;
        await rpc('plugin-setting', { pluginId: plugin.id, key: item.key, value: v });
        toast('已保存');
      }))
    ));
  }
  mainEl.appendChild(card);
}

// ---------- 提示 ----------

let toastTimer = null;
function toast(msg) {
  let el = document.getElementById('__toast');
  if (!el) {
    el = h('div', {
      id: '__toast',
      style: {
        position: 'fixed',
        bottom: '22px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border-strong)',
        borderRadius: '9px',
        padding: '9px 16px',
        fontSize: '12px',
        boxShadow: 'var(--shadow-2)',
        zIndex: '100',
        transition: 'opacity 160ms linear',
      },
    });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1800);
}

// ---------- 路由 ----------

function render() {
  if (state.query) return renderSearch();

  if (state.route === 'general') return renderGeneral();
  if (state.route === 'plugins') return renderPlugins();
  if (state.route === 'about') return renderAbout();
  if (state.route.startsWith('plugin:')) {
    const id = state.route.slice(7);
    const plugin = state.data.plugins.find((p) => p.id === id);
    if (plugin) return renderPluginSettings(plugin);
  }
  return renderGeneral();
}

// ---------- 启动 ----------

async function boot() {
  document.getElementById('back').addEventListener('click', () => {
    if (history.length > 1) history.back();
    else location.href = (window.__nucleus && window.__nucleus.info.newTabUrl) || 'about:blank';
  });

  const search = document.getElementById('search');
  search.addEventListener('input', () => {
    state.query = search.value.trim();
    render();
  });

  try {
    state.data = await rpc('bootstrap');
  } catch (err) {
    mainEl.innerHTML = '';
    mainEl.appendChild(pageHead('无法加载设置', err.message || String(err)));
    return;
  }

  const hash = location.hash.replace(/^#/, '');
  if (hash) state.route = hash;

  buildNav();
  render();
}

boot();
