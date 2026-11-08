/* 后台页：验证消息路由与 onMessage 回应 */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  sendResponse({ from: 'background', echo: msg, at: Date.now() });
  return true;
});
