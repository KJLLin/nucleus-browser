/* 内容脚本：验证 isolated world 注入与 chrome.storage 可用 */
(function () {
  if (document.getElementById('__hello_badge')) return;

  const badge = document.createElement('div');
  badge.id = '__hello_badge';
  badge.textContent = '扩展已注入 · ' + (chrome.runtime.id || '?');
  badge.title = 'Nucleus 扩展测试';
  document.documentElement.appendChild(badge);

  const info = {
    url: location.href,
    title: document.title,
    at: Date.now(),
  };
  try {
    chrome.storage.local.set({ lastVisit: info }, function () {
      badge.dataset.stored = '1';
    });
  } catch (err) {
    badge.dataset.stored = '0';
    badge.textContent = 'storage 不可用：' + err.message;
  }
})();
