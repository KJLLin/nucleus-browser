'use strict';
/**
 * 插件清单（manifest.json）校验。
 *
 * 核不信任任何插件目录里的内容：清单先过 schema 校验，字段不合法就拒绝加载，
 * 并给出可读的错误原因，避免一个坏插件拖垮整个浏览器。
 */

const ID_RE = /^[a-z0-9][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

const PERMISSIONS = new Set([
  'tabs',          // 标签页读写
  'window',        // 窗口控制
  'storage',       // 插件私有存储
  'settings',      // 设置项
  'commands',      // 注册/执行命令
  'network',       // 网络请求拦截
  'session',       // 会话（代理、UA、缓存）
  'protocol',      // 自定义协议
  'downloads',     // 下载事件
  'notifications', // 系统通知
  'shell',         // 调用系统默认程序
  'clipboard',     // 剪贴板
  'cookies',       // Cookie 读写
  'devtools',      // 开发者工具
  'plugins',       // 管理其它插件（仅设置页这类插件需要）
  'dialog',        // 系统文件/目录选择对话框
]);

const REGIONS = new Set(['titlebar', 'tabstrip', 'nav-left', 'nav-center', 'nav-right', 'sidebar', 'overlay', 'statusbar']);

function isStr(v, max = 400) {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

function normalizeCommand(cmd, errors, where) {
  if (!cmd || typeof cmd !== 'object') {
    errors.push(`${where}: 命令必须是对象`);
    return null;
  }
  if (!isStr(cmd.id, 120)) {
    errors.push(`${where}: 命令缺少合法 id`);
    return null;
  }
  if (!isStr(cmd.title, 120)) {
    errors.push(`${where}: 命令 ${cmd.id} 缺少 title`);
    return null;
  }
  return {
    id: cmd.id,
    title: cmd.title,
    icon: isStr(cmd.icon, 60) ? cmd.icon : null,
    keybinding: isStr(cmd.keybinding, 60) ? cmd.keybinding : null,
    description: isStr(cmd.description, 300) ? cmd.description : '',
    hidden: cmd.hidden === true,
  };
}

/**
 * @returns {{ok:true, manifest:object} | {ok:false, error:string, errors:string[]}}
 */
function validateManifest(raw, { builtin = false } = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'manifest.json 不是合法 JSON 对象', errors: ['根节点必须是对象'] };
  }

  if (!isStr(raw.id, 80) || !ID_RE.test(raw.id)) {
    errors.push('id 缺失或格式非法（只允许小写字母、数字、点、连字符）');
  }
  if (!isStr(raw.name, 80)) errors.push('name 缺失');
  if (!isStr(raw.version, 30)) errors.push('version 缺失');

  const perms = Array.isArray(raw.permissions) ? raw.permissions : [];
  const unknownPerms = perms.filter((p) => !PERMISSIONS.has(p));
  if (unknownPerms.length) errors.push(`未知权限: ${unknownPerms.join(', ')}`);

  const contributes = raw.contributes && typeof raw.contributes === 'object' ? raw.contributes : {};
  const out = {
    commands: [],
    toolbar: [],
    panels: [],
    settings: [],
    contentScripts: [],
    themes: [],
    omniboxProviders: [],
    slots: [],
  };

  if (Array.isArray(contributes.commands)) {
    for (const c of contributes.commands) {
      const n = normalizeCommand(c, errors, 'contributes.commands');
      if (n) out.commands.push(n);
    }
  }

  if (Array.isArray(contributes.toolbar)) {
    for (const t of contributes.toolbar) {
      if (!t || !isStr(t.id, 120) || !isStr(t.icon, 60)) {
        errors.push('contributes.toolbar: 每项需要 id 与 icon');
        continue;
      }
      out.toolbar.push({
        id: t.id,
        region: REGIONS.has(t.region) ? t.region : 'nav-right',
        icon: t.icon,
        title: isStr(t.title, 120) ? t.title : t.id,
        command: isStr(t.command, 120) ? t.command : null,
        order: Number.isFinite(t.order) ? t.order : 100,
        toggle: t.toggle === true,
      });
    }
  }

  if (Array.isArray(contributes.panels)) {
    for (const p of contributes.panels) {
      if (!p || !isStr(p.id, 120) || !isStr(p.entry, 200)) {
        errors.push('contributes.panels: 每项需要 id 与 entry');
        continue;
      }
      out.panels.push({
        id: p.id,
        title: isStr(p.title, 80) ? p.title : p.id,
        icon: isStr(p.icon, 60) ? p.icon : 'layout',
        entry: p.entry,
        side: p.side === 'right' ? 'right' : 'left',
      });
    }
  }

  if (Array.isArray(contributes.settings)) {
    for (const section of contributes.settings) {
      if (!section || !Array.isArray(section.items)) {
        errors.push('contributes.settings: 每项需要 items 数组');
        continue;
      }
      const items = [];
      for (const it of section.items) {
        if (!it || !isStr(it.key, 80) || !isStr(it.label, 120)) {
          errors.push('contributes.settings.items: 每项需要 key 与 label');
          continue;
        }
        const type = ['boolean', 'string', 'number', 'select', 'range', 'color'].includes(it.type)
          ? it.type
          : 'string';
        items.push({
          key: it.key,
          label: it.label,
          type,
          default: it.default,
          description: isStr(it.description, 300) ? it.description : '',
          options: Array.isArray(it.options)
            ? it.options.filter((o) => o && isStr(String(o.value ?? ''), 200)).map((o) => ({
                value: o.value,
                label: isStr(o.label, 120) ? o.label : String(o.value),
              }))
            : [],
          min: Number.isFinite(it.min) ? it.min : undefined,
          max: Number.isFinite(it.max) ? it.max : undefined,
          step: Number.isFinite(it.step) ? it.step : undefined,
          placeholder: isStr(it.placeholder, 120) ? it.placeholder : '',
        });
      }
      out.settings.push({ section: isStr(section.section, 80) ? section.section : '常规', items });
    }
  }

  if (Array.isArray(contributes.contentScripts)) {
    for (const cs of contributes.contentScripts) {
      if (!cs || !Array.isArray(cs.matches) || !isStr(cs.js, 200)) {
        errors.push('contributes.contentScripts: 每项需要 matches 与 js');
        continue;
      }
      out.contentScripts.push({
        matches: cs.matches.filter((m) => isStr(m, 400)),
        js: cs.js,
        css: isStr(cs.css, 200) ? cs.css : null,
        runAt: ['document_start', 'document_end', 'document_idle'].includes(cs.runAt)
          ? cs.runAt
          : 'document_end',
      });
    }
  }

  if (Array.isArray(contributes.themes)) {
    for (const th of contributes.themes) {
      if (!th || !isStr(th.id, 80) || !isStr(th.css, 200)) {
        errors.push('contributes.themes: 每项需要 id 与 css');
        continue;
      }
      out.themes.push({
        id: th.id,
        name: isStr(th.name, 80) ? th.name : th.id,
        css: th.css,
        dark: th.dark === true,
      });
    }
  }

  if (Array.isArray(contributes.omniboxProviders)) {
    for (const op of contributes.omniboxProviders) {
      if (!op || !isStr(op.id, 80)) continue;
      out.omniboxProviders.push({
        id: op.id,
        name: isStr(op.name, 80) ? op.name : op.id,
        prefix: isStr(op.prefix, 20) ? op.prefix : null,
        url: isStr(op.url, 400) ? op.url : null,
      });
    }
  }

  // 槽位声明：安装前就能看出「这个插件会往哪些界面位置塞东西」。
  // 运行时由 SlotRegistry 二次校验，这里是静态契约。
  if (Array.isArray(contributes.slots)) {
    for (const name of contributes.slots) {
      if (!isStr(name, 120)) {
        errors.push('contributes.slots: 每项必须是非空字符串');
        continue;
      }
      out.slots.push(name);
    }
  }

  // 样式表：由核在加载插件 UI 之前注入，避免插件各自写一遍样板
  const styleFiles = [];
  if (Array.isArray(raw.styles)) {
    for (const st of raw.styles) {
      if (!isStr(st, 200) || st.includes('..')) {
        errors.push('styles: 每项必须是不含 .. 的相对路径');
        continue;
      }
      styleFiles.push(st);
    }
  }

  // 新标签页：谁声明就由谁提供，核只负责把 URL 转给其他插件
  out.newTab = contributes.newTab && isStr(contributes.newTab.url, 400)
    ? { url: contributes.newTab.url }
    : null;

  if (typeof raw.main === 'string' && raw.main.includes('..')) errors.push('main 路径不允许包含 ..');
  if (typeof raw.ui === 'string' && raw.ui.includes('..')) errors.push('ui 路径不允许包含 ..');

  if (errors.length) {
    return { ok: false, error: errors[0], errors };
  }

  return {
    ok: true,
    manifest: {
      id: raw.id,
      name: raw.name,
      version: raw.version,
      description: isStr(raw.description, 400) ? raw.description : '',
      author: isStr(raw.author, 80) ? raw.author : '未署名',
      homepage: isStr(raw.homepage, 300) ? raw.homepage : '',
      builtin,
      /**
       * 必需插件：缺了它浏览器就不再是一个可用的浏览器（例如界面外壳）。
       * 启动时会审计，缺失不是「静默降级」，而是要明确告诉用户。
       * 第三方插件不能自称必需 —— 那是产品方的判断，不是安装方的。
       */
      required: builtin && raw.required === true,
      main: typeof raw.main === 'string' ? raw.main : null,
      ui: typeof raw.ui === 'string' ? raw.ui : null,
      permissions: Array.from(new Set(perms)),
      styles: styleFiles,
      contributes: out,
    },
  };
}

module.exports = { validateManifest, PERMISSIONS, REGIONS };
