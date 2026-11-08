/**
 * 新标签页的页面脚本。
 * 这个文件运行在 webview 里（不是浏览器外壳），所以它只能用自己的
 * localStorage —— 一个插件可以拥有完全独立的页面运行环境。
 */

const ENGINES = [
  { key: 'bing', name: 'Bing', url: 'https://cn.bing.com/search?q=' },
  { key: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd=' },
  { key: 'google', name: 'Google', url: 'https://www.google.com/search?q=' },
  { key: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
];

const DEFAULT_SHORTCUTS = [
  { name: 'GitHub', url: 'https://github.com' },
  { name: '哔哩哔哩', url: 'https://www.bilibili.com' },
  { name: '知乎', url: 'https://www.zhihu.com' },
  { name: '微博', url: 'https://weibo.com' },
  { name: '百度', url: 'https://www.baidu.com' },
  { name: 'MDN', url: 'https://developer.mozilla.org' },
];

const KEY_SHORTCUTS = 'nucleus.newtab.shortcuts';
const KEY_ENGINE = 'nucleus.newtab.engine';

/** localStorage 在自定义协议下可能不可用，降级为内存存储 */
const store = (() => {
  try {
    localStorage.setItem('__probe', '1');
    localStorage.removeItem('__probe');
    return {
      get(k, d) {
        const v = localStorage.getItem(k);
        if (v === null) return d;
        try { return JSON.parse(v); } catch (_) { return d; }
      },
      set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
    };
  } catch (_) {
    const mem = new Map();
    return {
      get: (k, d) => (mem.has(k) ? mem.get(k) : d),
      set: (k, v) => mem.set(k, v),
    };
  }
})();

// ---------- 时钟 ----------

const timeEl = document.getElementById('time');
const dateEl = document.getElementById('date');
const greetEl = document.getElementById('greeting');

const GREETINGS = [
  [0, 5, '夜深了，注意休息'],
  [5, 9, '早上好'],
  [9, 12, '上午好'],
  [12, 14, '中午好'],
  [14, 18, '下午好'],
  [18, 23, '晚上好'],
  [23, 24, '夜深了'],
];

function tick() {
  const now = new Date();
  timeEl.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  dateEl.textContent = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · 星期${week}`;
  const h = now.getHours();
  const slot = GREETINGS.find(([a, b]) => h >= a && h < b);
  greetEl.textContent = slot ? slot[2] : '';
}

tick();
setInterval(tick, 10_000);

// ---------- 搜索 ----------

const form = document.getElementById('searchForm');
const input = document.getElementById('q');
const engineBtn = document.getElementById('engine');

let engineKey = store.get(KEY_ENGINE, 'bing');
const currentEngine = () => ENGINES.find((e) => e.key === engineKey) || ENGINES[0];

function paintEngine() {
  engineBtn.textContent = currentEngine().name;
}
paintEngine();

engineBtn.addEventListener('click', (e) => {
  e.preventDefault();
  const idx = ENGINES.findIndex((x) => x.key === engineKey);
  engineKey = ENGINES[(idx + 1) % ENGINES.length].key;
  store.set(KEY_ENGINE, engineKey);
  paintEngine();
});

function toUrl(text) {
  const t = text.trim();
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/i.test(t)) return `http://${t}`;
  if (/^[^\s/?#:]+\.[^\s/?#:]{2,}(:\d+)?([/?#]|$)/.test(t) && !t.includes(' ')) return `https://${t}`;
  return currentEngine().url + encodeURIComponent(t);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = toUrl(input.value);
  if (url) window.location.href = url;
});

// ---------- 快捷方式 ----------

const grid = document.getElementById('shortcuts');

function hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 58% 52%), hsl(${(h + 42) % 360} 62% 44%))`;
}

function initial(name) {
  const trimmed = (name || '?').trim();
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return trimmed.slice(0, 1);
  return trimmed.slice(0, 2).toUpperCase();
}

function renderShortcuts() {
  const list = store.get(KEY_SHORTCUTS, DEFAULT_SHORTCUTS);
  grid.innerHTML = '';
  list.forEach((item, idx) => {
    const card = document.createElement('div');
    card.className = 'sc';
    card.title = item.url;
    card.innerHTML = `
      <div class="avatar" style="background:${hashColor(item.name || item.url)}">${initial(item.name)}</div>
      <div class="label"></div>
      <button class="del" title="移除">×</button>`;
    card.querySelector('.label').textContent = item.name || item.url;
    card.addEventListener('click', () => { window.location.href = item.url; });
    card.querySelector('.del').addEventListener('click', (e) => {
      e.stopPropagation();
      const next = list.slice();
      next.splice(idx, 1);
      store.set(KEY_SHORTCUTS, next);
      renderShortcuts();
    });
    grid.appendChild(card);
  });
}

renderShortcuts();

// ---------- 添加快捷方式（自建轻量表单，Electron 不支持 window.prompt） ----------

document.getElementById('addShortcut').addEventListener('click', () => {
  const mask = document.createElement('div');
  mask.style.cssText = `position:fixed;inset:0;background:rgba(8,9,12,.6);display:flex;
    align-items:center;justify-content:center;z-index:99`;
  const dialog = document.createElement('div');
  dialog.style.cssText = `width:340px;background:var(--bg-soft);border:1px solid var(--line);
    border-radius:14px;padding:18px;box-shadow:0 24px 60px rgba(0,0,0,.5)`;
  dialog.innerHTML = `
    <div style="font-size:13px;font-weight:600;margin-bottom:12px">添加快捷方式</div>
    <input id="scName" placeholder="名称，例如 豆瓣" style="width:100%;height:32px;margin-bottom:8px;
      padding:0 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);
      color:var(--text);outline:none;font-size:12.5px">
    <input id="scUrl" placeholder="网址，例如 https://www.douban.com" style="width:100%;height:32px;
      padding:0 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);
      color:var(--text);outline:none;font-size:12.5px">
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">
      <button id="scCancel" style="height:28px;padding:0 12px;border-radius:7px;border:1px solid var(--line);
        background:none;color:var(--text-dim);cursor:pointer;font-size:12px">取消</button>
      <button id="scOk" style="height:28px;padding:0 14px;border-radius:7px;border:none;
        background:var(--accent);color:#fff;cursor:pointer;font-size:12px">添加</button>
    </div>`;
  mask.appendChild(dialog);
  document.body.appendChild(mask);

  const nameEl = dialog.querySelector('#scName');
  const urlEl = dialog.querySelector('#scUrl');
  setTimeout(() => nameEl.focus(), 30);

  const close = () => mask.remove();
  dialog.querySelector('#scCancel').addEventListener('click', close);
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });

  dialog.querySelector('#scOk').addEventListener('click', () => {
    let url = urlEl.value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    const name = nameEl.value.trim() || url.replace(/^https?:\/\//, '').split('/')[0];
    const list = store.get(KEY_SHORTCUTS, DEFAULT_SHORTCUTS).slice();
    list.push({ name, url });
    store.set(KEY_SHORTCUTS, list);
    close();
    renderShortcuts();
  });

  const onKey = (e) => {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    if (e.key === 'Enter' && dialog.contains(document.activeElement)) {
      dialog.querySelector('#scOk').click();
    }
  };
  document.addEventListener('keydown', onKey);
});

// ---------- 页脚 ----------

const ver = window.__nucleus?.info?.version;
if (ver) document.getElementById('chromeVer').textContent = `Chromium ${ver.split('.')[0]}`;
