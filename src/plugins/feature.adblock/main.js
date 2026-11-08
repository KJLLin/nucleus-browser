'use strict';
/**
 * feature.adblock —— 主进程侧。
 *
 * 它演示了网络权限的正确用法：核只提供一条 webRequest 总线，
 * 多个插件可以同时挂载，互不覆盖（Electron 原生只允许一个监听器）。
 */

// 明确的广告 / 追踪域名。刻意不含 CDN 与统计平台的主域，避免误伤。
const AD_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adservice.google.com',
  'amazon-adsystem.com',
  'adnxs.com',
  'adsrvr.org',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'pubmatic.com',
  'rubiconproject.com',
  'openx.net',
  'media.net',
  'moatads.com',
  'zedo.com',
  'advertising.com',
  'adform.net',
  'smartadserver.com',
  'casalemedia.com',
  'yieldmo.com',
  'sharethrough.com',
  'teads.tv',
  'adsafeprotected.com',
  'adroll.com',
  'bidswitch.net',
  'serving-sys.com',
  'cpmstar.com',
  'popads.net',
  'popcash.net',
  'propellerads.com',
  'adcash.com',
  'exoclick.com',
  'juicyads.com',
  'trafficjunky.com',
];

const CN_AD_HOSTS = [
  'cpro.baidu.com',
  'pos.baidu.com',
  'cbjs.baidu.com',
  'tanx.com',
  'alimama.com',
  'mediav.com',
  'adsame.com',
  'allyes.com',
  'ipinyou.com',
  'irs01.com',
  'miaozhen.com',
  'admaster.com.cn',
  'gridsumdissector.com',
  'cnzz.com',
  'umeng.com',
  'growingio.com',
  'hm.baidu.com',
];

const TRACK_HOSTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'scorecardresearch.com',
  'quantserve.com',
  'hotjar.com',
  'mixpanel.com',
  'segment.io',
  'amplitude.com',
  'fullstory.com',
  'mouseflow.com',
  'crazyegg.com',
  'chartbeat.com',
  'heapanalytics.com',
  'statcounter.com',
  'clarity.ms',
];

const STRICT_EXTRA = [
  'ad-delivery.net',
  'adserver',
  'adskeeper',
  'adx.',
  'aniview.com',
  'betweendigital.com',
  'bttrack.com',
  'contentexchange.me',
  'dmxleo.com',
  'e-volution.ai',
  'exponential.com',
  'genieessp.com',
  'goldbach.com',
  'impdesk.com',
  'inmobi.com',
  'lijit.com',
  'loopme.me',
  'nativeads.com',
  'onetag-sys.com',
  'pangle.io',
  'adspirit',
];

const AD_PATH_PATTERNS = [
  /\/pagead\//i,
  /\/adserver\//i,
  /\/advert(\/|\.|\?|$)/i,
  /\/ads?[/._-]/i,
  /\/banners?\d*\.(gif|jpe?g|png|swf)/i,
  /[?&](ad|ads|adid|adslot|adunit)=/i,
  /\/popunder/i,
  /\/prebid[.\-]/i,
];

const TRACK_PATH_PATTERNS = [
  /\/analytics\.js/i,
  /\/gtag\/js/i,
  /\/gtm\.js/i,
  /\/track(ing)?\/(?:collect|event|beacon)/i,
  /\/collect\?v=\d/i,
  /\/pixel\.(gif|png)/i,
];

function hostMatches(host, list) {
  for (const item of list) {
    if (host === item) return true;
    if (host.endsWith(`.${item}`)) return true;
  }
  return false;
}

module.exports = {
  activate(ctx) {
    let counter = 0;
    let sinceReport = 0;

    const enabled = () => ctx.settings.get('enabled', true) !== false;
    const strictness = () => ctx.settings.get('strictness', 'standard');
    const blockTrackers = () => ctx.settings.get('blockTrackers', true) !== false;

    function shouldBlock(url, type) {
      if (!enabled()) return false;
      if (!url || !/^https?:/i.test(url)) return false;
      // 绝不拦主文档，否则会出现整站白屏
      if (type === 'mainFrame') return false;

      let host = '';
      try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return false; }

      const mode = strictness();

      if (hostMatches(host, AD_HOSTS)) return true;

      if (mode !== 'light') {
        if (hostMatches(host, CN_AD_HOSTS)) return true;
        for (const re of AD_PATH_PATTERNS) if (re.test(url)) return true;
      }

      if (blockTrackers() && mode !== 'light') {
        if (hostMatches(host, TRACK_HOSTS)) return true;
        for (const re of TRACK_PATH_PATTERNS) if (re.test(url)) return true;
      }

      if (mode === 'strict') {
        if (hostMatches(host, STRICT_EXTRA)) return true;
        if (/[?&](utm_|gclid|fbclid)/i.test(url) === false && /\/(ads|adx|adtech|adframe)\//i.test(url)) return true;
      }

      return false;
    }

    ctx.network.onBeforeRequest((details) => {
      if (!shouldBlock(details.url, details.resourceType)) return null;
      counter += 1;
      sinceReport += 1;
      return { cancel: true };
    });

    // 汇总上报，避免每条请求都走一次 IPC。
    // 用 ctx.effect 登记逆操作：插件被禁用时定时器自动停，不会留下一个还在跑的旧账本。
    ctx.effect(() => {
      const timer = setInterval(() => {
        if (sinceReport > 0) {
          sinceReport = 0;
          ctx.bus.emit('adblock:stats', { total: counter, enabled: enabled() });
        }
      }, 1000);
      return () => clearInterval(timer);
    }, 'adblock:stats-ticker');

    // 设置面板里改了开关，这里要把新状态同步回工具栏
    ctx.settings.onChange('enabled', (value) => {
      ctx.bus.emit('adblock:stats', { total: counter, enabled: value !== false });
    });

    ctx.commands.register('adblock.stats:main', () => ({ total: counter, enabled: enabled() }));

    // 首次广播一次，让 UI 拿到初始值
    ctx.effect(() => {
      const t = setTimeout(
        () => ctx.bus.emit('adblock:stats', { total: counter, enabled: enabled() }),
        600
      );
      return () => clearTimeout(t);
    }, 'adblock:initial-broadcast');

    ctx.log.info(`广告拦截已启用（强度：${strictness()}）`);
  },
};
