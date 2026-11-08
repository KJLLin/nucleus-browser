'use strict';
/**
 * 通道契约表。
 *
 * 这里是「核对外暴露了哪些能力」的唯一事实来源：
 * 参数形状、返回形状、权限要求、一句话说明。
 *
 * 只登记能确定的通道。没登记的通道照常工作，但会在自省页里
 * 标为 untyped —— 覆盖率是诚实的，不靠猜。
 */
const { T } = require('./typert');

const ID = T.string({ min: 1, max: 120 });
const PLUGIN = T.object({ pluginId: ID });

const SPECS = {
  // ---------- 应用 ----------
  'nucleus:app:info': {
    params: PLUGIN,
    result: T.any(),
    description: '应用与运行环境信息（版本、内核版本、启动时间、webview preload 地址）',
  },
  'nucleus:ui:reload': {
    params: PLUGIN,
    result: T.boolean(),
    description: '重新加载浏览器界面（由主进程执行，自定义协议页面自己调 location.reload 会被拒绝）',
  },
  'nucleus:app:quit': {
    params: PLUGIN,
    result: T.boolean(),
    description: '退出应用',
  },

  // ---------- 插件 ----------
  'nucleus:plugins:list': {
    params: PLUGIN,
    result: T.any(),
    description: '列出全部插件及其状态、副作用条数',
    permission: 'plugins',
  },
  'nucleus:plugins:ui': {
    params: PLUGIN,
    result: T.any(),
    description: '列出有界面入口的插件（供渲染层挂载）',
  },
  'nucleus:plugins:enable': {
    params: T.object({ pluginId: ID, target: ID }),
    result: T.any(),
    description: '启用一个插件',
    permission: 'plugins',
  },
  'nucleus:plugins:disable': {
    params: T.object({ pluginId: ID, target: ID }),
    result: T.any(),
    description: '禁用一个插件，Cordis 逆向回收它的全部副作用',
    permission: 'plugins',
  },
  'nucleus:plugins:uninstall': {
    params: T.object({ pluginId: ID, target: ID }),
    result: T.any(),
    description: '卸载插件（移入回收站，不是永久删除）',
    permission: 'plugins',
  },
  'nucleus:plugins:audit': {
    params: PLUGIN,
    result: T.any(),
    description: '审计必需插件（界面外壳等）：缺失时返回原因，供恢复通道展示',
  },
  'nucleus:plugins:reload': {
    params: PLUGIN,
    result: T.any(),
    description: '重新扫描插件目录',
    permission: 'plugins',
  },
  'nucleus:doctor:run': {
    params: PLUGIN,
    result: T.any(),
    description: '运行内核健康检查（插件状态、副作用账本、槽位孤儿、RPC 失败率、资源占用）',
    permission: 'plugins',
  },
  'nucleus:doctor:repair': {
    params: PLUGIN,
    result: T.any(),
    description: '回收泄漏的 fiber 并通知界面清理孤儿槽位条目',
    permission: 'plugins',
  },

  // ---------- 设置 ----------
  'nucleus:settings:all': {
    params: PLUGIN,
    result: T.record(T.any()),
    description: '读取设置：core 拿全局，插件只拿自己命名空间下的',
  },
  'nucleus:settings:set': {
    params: T.object({ pluginId: ID, key: T.string({ min: 1, max: 120 }), value: T.any() }),
    result: T.boolean(),
    description: '写入一个设置项',
    permission: 'settings',
  },

  // ---------- 标签镜像 ----------
  'nucleus:tabs:sync-from-renderer': {
    params: T.object({
      pluginId: ID,
      tabs: T.array(T.object({
        id: T.string({ min: 1, max: 40 }),
        url: T.string({ max: 4000 }),
        title: T.string({ max: 2000 }),
      }, { strict: false })),
      activeId: T.nullable(T.string({ max: 40 })),
    }),
    result: T.boolean(),
    description: '渲染层把标签状态同步给主进程（webview 在渲染层，主进程只维护镜像）',
  },
  'nucleus:tabs:capture': {
    params: T.object({ pluginId: ID, tabId: T.string({ min: 1, max: 40 }) }),
    result: T.string(),
    description: '截取标签页可见区域，返回 PNG data URL',
    permission: 'tabs',
  },

  // ---------- 窗口 ----------
  'nucleus:window:action': {
    params: T.object({
      pluginId: ID,
      action: T.enum(['minimize', 'maximize', 'close', 'fullscreen']),
    }),
    result: T.boolean(),
    description: '窗口级动作',
    permission: 'window',
  },
  'nucleus:window:state': {
    params: PLUGIN,
    result: T.object({ maximized: T.boolean(), fullscreen: T.boolean() }),
    description: '读取窗口状态',
  },

  // ---------- 插件存储 ----------
  'nucleus:storage:get': {
    params: T.object({
      pluginId: ID,
      key: T.string({ min: 1, max: 200 }),
      fallback: T.any(),
    }),
    result: T.any(),
    description: '读插件私有存储',
    permission: 'storage',
  },
  'nucleus:storage:set': {
    params: T.object({ pluginId: ID, key: T.string({ min: 1, max: 200 }), value: T.any() }),
    result: T.boolean(),
    description: '写插件私有存储',
    permission: 'storage',
  },
  'nucleus:storage:all': {
    params: PLUGIN,
    result: T.record(T.any()),
    description: '读插件全部私有存储',
    permission: 'storage',
  },

  // ---------- 命令与总线 ----------
  'nucleus:commands:execute': {
    params: T.object({ pluginId: ID, id: ID, args: T.optional(T.array(T.any())) }),
    result: T.any(),
    description: '执行一条命令',
    permission: 'commands',
  },
  'nucleus:commands:list-main': {
    params: PLUGIN,
    result: T.any(),
    description: '列出主进程侧注册的命令',
  },
  'nucleus:bus:emit': {
    params: T.object({
      pluginId: ID,
      event: T.string({ min: 1, max: 120, pattern: '^[a-z0-9][a-z0-9:._/-]*$' }),
      payload: T.any(),
    }),
    result: T.boolean(),
    description: '向跨进程事件总线发一条事件',
  },

  // ---------- 下载与会话 ----------
  'nucleus:downloads:list': {
    params: PLUGIN,
    result: T.array(T.any()),
    description: '当前下载列表',
    permission: 'downloads',
  },
  'nucleus:downloads:control': {
    params: T.object({
      pluginId: ID,
      id: T.number(),
      action: T.enum(['pause', 'resume', 'cancel']),
    }),
    result: T.boolean(),
    description: '暂停 / 继续 / 取消下载',
    permission: 'downloads',
  },
  'nucleus:session:clear': {
    params: T.object({ pluginId: ID, what: T.enum(['cache', 'storage', 'all']) }),
    result: T.boolean(),
    description: '清理缓存 / 存储',
    permission: 'session',
  },
  'nucleus:session:set-ua': {
    params: T.object({ pluginId: ID, ua: T.string({ max: 500 }) }),
    result: T.boolean(),
    description: '设置全局 User-Agent',
    permission: 'session',
  },

  // ---------- 剪贴板与系统 ----------
  'nucleus:clipboard:write': {
    params: T.object({ pluginId: ID, text: T.string({ max: 200000 }) }),
    result: T.boolean(),
    description: '写剪贴板',
    permission: 'clipboard',
  },
  'nucleus:clipboard:read': {
    params: PLUGIN,
    result: T.string(),
    description: '读剪贴板',
    permission: 'clipboard',
  },
  'nucleus:shell:open-external': {
    params: T.object({ pluginId: ID, url: T.string({ min: 1, max: 4000, pattern: '^(https?|mailto):' }) }),
    result: T.boolean(),
    description: '用系统默认程序打开链接（只允许 http/https/mailto）',
    permission: 'shell',
  },
  'nucleus:file:save-image': {
    params: T.object({
      pluginId: ID,
      dataUrl: T.string({ min: 24, max: 40000000, pattern: '^data:image/' }),
      defaultName: T.optional(T.string({ max: 200 })),
    }),
    result: T.nullable(T.string()),
    description: '弹出保存对话框写出一张图片',
    permission: 'tabs',
  },

  // ---------- 浏览器扩展 ----------
  'nucleus:ext:list': {
    params: PLUGIN,
    result: T.array(T.any()),
    description: '列出已安装的浏览器扩展及其能力',
    permission: 'plugins',
  },
  'nucleus:ext:enable': {
    params: T.object({ pluginId: ID, target: ID }),
    result: T.any(),
    description: '启用扩展',
    permission: 'plugins',
  },
  'nucleus:ext:disable': {
    params: T.object({ pluginId: ID, target: ID }),
    result: T.any(),
    description: '禁用扩展',
    permission: 'plugins',
  },
  'nucleus:ext:uninstall': {
    params: T.object({ pluginId: ID, target: ID }),
    result: T.boolean(),
    description: '卸载扩展（移入回收站）',
    permission: 'plugins',
  },
  'nucleus:ext:reload': {
    params: PLUGIN,
    result: T.array(T.any()),
    description: '重新扫描扩展目录',
    permission: 'plugins',
  },

  // ---------- 主题与自省 ----------
  'nucleus:theme:broadcast': {
    params: T.object({ pluginId: ID, theme: T.enum(['light', 'dark']) }),
    result: T.enum(['light', 'dark']),
    description: '把解析后的主题广播给内部页面（刻意不动 nativeTheme）',
    permission: 'settings',
  },
  'nucleus:slots:report': {
    params: T.object({ pluginId: ID, snapshot: T.any() }),
    result: T.boolean(),
    description: '渲染层上报槽位树快照，供自省页展示',
  },
  'nucleus:state:get': {
    params: T.object({ pluginId: ID, key: T.string({ min: 1, max: 120 }) }),
    result: T.any(),
    description: '读取核的运行期状态',
  },
  'nucleus:state:set': {
    params: T.object({ pluginId: ID, key: T.string({ min: 1, max: 120 }), value: T.any() }),
    result: T.boolean(),
    description: '写入核的运行期状态',
  },
};

module.exports = { SPECS };
