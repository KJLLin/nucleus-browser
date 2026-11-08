document.getElementById('id').textContent = chrome.runtime.id + ' · v' + chrome.runtime.getManifest().version;

chrome.storage.local.get(['lastVisit'], function (data) {
  const last = data && data.lastVisit;
  document.getElementById('last').textContent = last
    ? `${last.title || '(无标题)'} — ${last.url}`
    : '还没有记录';
});

document.getElementById('ping').addEventListener('click', function () {
  const out = document.getElementById('out');
  out.hidden = false;
  out.textContent = '发送中…';
  chrome.runtime.sendMessage({ hello: 'nucleus' }, function (res) {
    out.textContent = JSON.stringify(res, null, 2);
  });
});
