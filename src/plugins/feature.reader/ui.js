/**
 * feature.reader —— 阅读模式。
 *
 * 提取逻辑整段注入到页面里执行（executeJavaScript 跑在页面主世界），
 * 因此不需要 content script，也不需要把页面内容回传到浏览器外壳。
 */

const READER_JS = String.raw`
(function () {
  const OLD = document.getElementById('__nucleus_reader');
  if (OLD) { OLD.remove(); document.documentElement.style.overflow = ''; return { closed: true }; }

  const DROP = 'script,style,noscript,iframe,object,embed,svg,canvas,nav,aside,footer,header,form,input,button,select,textarea';
  const BAD_CLASS = /(^|[\s_-])(ad|ads|advert|banner|promo|sponsor|share|social|comment|related|recommend|sidebar|toolbar|breadcrumb|popup|modal|cookie)([\s_-]|$)/i;

  function textLen(el) {
    return (el.innerText || '').replace(/\s+/g, ' ').length;
  }

  function pick() {
    const preferred = ['article', 'main', '[role="main"]', '.post', '.article', '.entry-content', '#content', '.content'];
    let best = null;
    let bestScore = 0;
    for (const sel of preferred) {
      for (const el of Array.from(document.querySelectorAll(sel)).slice(0, 6)) {
        if (el.closest('#__nucleus_reader')) continue;
        const score = textLen(el);
        if (score > bestScore) { bestScore = score; best = el; }
      }
    }
    if (best && bestScore > 600) return best;

    // 退化：找 <p> 最多的祖先
    const counts = new Map();
    for (const p of Array.from(document.querySelectorAll('p'))) {
      if (textLen(p) < 40) continue;
      let node = p.parentElement;
      for (let i = 0; i < 3 && node; i += 1) {
        counts.set(node, (counts.get(node) || 0) + textLen(p));
        node = node.parentElement;
      }
    }
    for (const [el, score] of counts) {
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return bestScore > 400 ? best : null;
  }

  const source = pick();
  if (!source) return { ok: false, reason: '没有找到正文内容' };

  const clone = source.cloneNode(true);
  clone.querySelectorAll(DROP).forEach((n) => n.remove());
  clone.querySelectorAll('*').forEach((n) => {
    const cls = (n.className && typeof n.className === 'string') ? n.className : '';
    if (cls && BAD_CLASS.test(cls)) { n.remove(); return; }
    for (const attr of Array.from(n.attributes)) {
      if (/^on/i.test(attr.name)) n.removeAttribute(attr.name);
      if (attr.name === 'style') n.removeAttribute('style');
    }
    if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noreferrer'); }
  });

  const title = (document.querySelector('h1') || {}).innerText || document.title || '';

  const host = document.createElement('div');
  host.id = '__nucleus_reader';
  host.setAttribute('style', [
    'position:fixed', 'inset:0', 'z-index:2147483600', 'overflow-y:auto',
    'background:#fbfaf7', 'color:#1f2328',
    'font:16px/1.85 Georgia,"Songti SC","Microsoft YaHei",serif'
  ].join(';'));

  const bar = document.createElement('div');
  bar.setAttribute('style', [
    'position:sticky', 'top:0', 'display:flex', 'align-items:center', 'gap:12px',
    'padding:10px 22px', 'background:rgba(251,250,247,.94)', 'border-bottom:1px solid #e6e2da',
    'font:13px/1 system-ui,"Segoe UI","Microsoft YaHei",sans-serif', 'color:#6b7280', 'z-index:2'
  ].join(';'));
  bar.innerHTML = '<span style="font-weight:600;color:#111">阅读模式</span><span style="flex:1"></span>';
  const close = document.createElement('button');
  close.textContent = '退出';
  close.setAttribute('style', [
    'border:1px solid #d8d3c9', 'background:#fff', 'color:#374151', 'border-radius:14px',
    'padding:5px 13px', 'font:12px/1 system-ui,sans-serif', 'cursor:pointer'
  ].join(';'));
  close.onclick = () => { host.remove(); document.documentElement.style.overflow = ''; };
  bar.appendChild(close);

  const article = document.createElement('article');
  article.setAttribute('style', 'max-width:720px;margin:0 auto;padding:36px 24px 120px');
  const h1 = document.createElement('h1');
  h1.textContent = title;
  h1.setAttribute('style', 'font-size:30px;line-height:1.35;margin:0 0 26px;font-weight:700;letter-spacing:-.4px');
  article.appendChild(h1);

  const body = document.createElement('div');
  body.innerHTML = clone.innerHTML;
  body.querySelectorAll('img').forEach((img) => {
    img.setAttribute('style', 'max-width:100%;height:auto;border-radius:6px;display:block;margin:18px auto');
  });
  body.querySelectorAll('a').forEach((a) => { a.setAttribute('style', 'color:#2f6fed'); });
  body.querySelectorAll('pre,code').forEach((n) => {
    n.setAttribute('style', 'background:#f1efe9;border-radius:6px;padding:2px 5px;font-family:Consolas,monospace;font-size:13px');
  });
  body.querySelectorAll('blockquote').forEach((n) => {
    n.setAttribute('style', 'margin:18px 0;padding:2px 0 2px 16px;border-left:3px solid #d5cfc2;color:#4b5563');
  });
  article.appendChild(body);

  host.appendChild(bar);
  host.appendChild(article);
  document.body.appendChild(host);
  document.documentElement.style.overflow = 'hidden';
  host.scrollTop = 0;

  return { ok: true, chars: textLen(clone) };
})()
`;

export async function activate(nucleus) {
  nucleus.commands.register('reader.toggle', {
    title: '切换阅读模式',
    icon: 'book-open',
    keybinding: 'Ctrl+Alt+R',
    handler: async () => {
      const tab = nucleus.tabs.active();
      if (!tab || !/^https?:/i.test(tab.url)) {
        nucleus.ui.toast('阅读模式只支持网页');
        return;
      }
      try {
        const res = await nucleus.tabs.execute(tab.id, READER_JS);
        if (!res) return;
        if (res.closed) nucleus.ui.toast('已退出阅读模式');
        else if (!res.ok) nucleus.ui.toast(res.reason || '无法提取正文', { type: 'error' });
        else nucleus.ui.toast(`已进入阅读模式 · 正文约 ${res.chars} 字`, { type: 'success' });
      } catch (err) {
        nucleus.ui.toast(`阅读模式失败：${err.message}`, { type: 'error' });
      }
    },
  });
}
