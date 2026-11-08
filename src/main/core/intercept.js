'use strict';
/**
 * 网络拦截总线。
 *
 * Electron 的 webRequest 每个事件只能挂一个监听器，多个插件直接注册会互相覆盖。
 * 核因此做一层分发：插件注册自己的 handler，核合成一个总监听器依次调用。
 * 任一插件抛错只跳过该插件，不打断链条。
 */
class InterceptService {
  constructor({ bus }) {
    this.bus = bus;
    this.beforeRequest = []; // {owner, handler}
    this.headersReceived = [];
    this._installed = false;
  }

  install(session) {
    if (this._installed) return;
    this._installed = true;
    this.session = session;

    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      for (const entry of this.beforeRequest.slice()) {
        try {
          const res = entry.handler(details);
          if (res && (res.cancel || res.redirectURL)) {
            callback(res);
            return;
          }
        } catch (err) {
          console.warn(`[intercept] ${entry.owner} beforeRequest 抛错`, err.message);
        }
      }
      callback({});
    });

    session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
      for (const entry of this.headersReceived.slice()) {
        try {
          const res = entry.handler(details);
          if (res && (res.cancel || res.responseHeaders)) {
            callback(res);
            return;
          }
        } catch (err) {
          console.warn(`[intercept] ${entry.owner} headersReceived 抛错`, err.message);
        }
      }
      callback({});
    });
  }

  onBeforeRequest(owner, handler) {
    const entry = { owner, handler };
    this.beforeRequest.push(entry);
    return () => {
      this.beforeRequest = this.beforeRequest.filter((x) => x !== entry);
    };
  }

  onHeadersReceived(owner, handler) {
    const entry = { owner, handler };
    this.headersReceived.push(entry);
    return () => {
      this.headersReceived = this.headersReceived.filter((x) => x !== entry);
    };
  }

  removeOwner(owner) {
    this.beforeRequest = this.beforeRequest.filter((x) => x.owner !== owner);
    this.headersReceived = this.headersReceived.filter((x) => x.owner !== owner);
  }
}

module.exports = { InterceptService };
