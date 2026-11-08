'use strict';
/**
 * 配置层（profile / patch）。
 *
 * 一个运行中的 Nucleus 是「几层配置叠加出来的插件树」：
 *
 *   profiles/default.yml     产品默认形态（哪些插件开、哪些关）
 *   profiles/<name>.yml      选择一个 profile，替换默认形态
 *   <userData>/nucleus.patch.yml   用户的最后一层覆盖
 *
 * 合并规则刻意简单、可预测：
 *   plugins.enable / disable 都是并集；同一个插件同时出现时 enable 胜
 *   settings 后层覆盖前层（浅合并）
 *   force 里的键在启动时强制写回，用于「我说了算」的场景
 *
 * 设置项的优先级：force > settings.json 里已有的值 > profile 给的默认值。
 * 这样你在界面上改过的设置，不会被下次启动的配置文件悄悄回滚。
 */
const fs = require('fs');
const path = require('path');
const yaml = require('./mini-yaml');

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

function parseArgv(argv) {
  const out = { profile: null, dump: false, listProfiles: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dump-config') out.dump = true;
    else if (a === '--list-profiles') out.listProfiles = true;
    else if (a.startsWith('--profile=')) out.profile = a.slice('--profile='.length);
    else if (a === '--profile') out.profile = argv[++i] || null;
  }
  if (!out.profile && process.env.NUCLEUS_PROFILE) out.profile = process.env.NUCLEUS_PROFILE;
  return out;
}

function readLayer(file, name) {
  if (!fs.existsSync(file)) return { name, path: file, exists: false, data: {} };
  const parsed = yaml.parse(fs.readFileSync(file, 'utf8'), path.basename(file));
  if (!parsed.ok) {
    throw new Error(`配置文件解析失败：${parsed.error}`);
  }
  return { name, path: file, exists: true, data: parsed.data || {} };
}

function listProfiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => f.replace(/\.ya?ml$/, ''))
    .filter((n) => PROFILE_NAME_RE.test(n))
    .sort();
}

function mergeInto(state, data) {
  const plugins = data.plugins && typeof data.plugins === 'object' ? data.plugins : {};
  const enable = Array.isArray(plugins.enable) ? plugins.enable : [];
  const disable = Array.isArray(plugins.disable) ? plugins.disable : [];

  for (const id of enable) if (typeof id === 'string') state.enableSet.add(id);
  for (const id of disable) if (typeof id === 'string') state.disableSet.add(id);
  // 同一层里 enable 胜；跨层时也一样 —— 「明确要开」的意图更强
  for (const id of state.enableSet) state.disableSet.delete(id);

  const settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
  Object.assign(state.settings, settings);
  state.settingSources = state.settingSources || {};
  for (const key of Object.keys(settings)) state.settingSources[key] = state.currentLayer;

  const force = data.force && typeof data.force === 'object' ? data.force : null;
  if (force) Object.assign(state.force, force);
}

/**
 * @param {object} opts
 * @param {string} opts.profilesDir 内置 profile 目录
 * @param {string} opts.userDataDir 用户数据目录（放 patch）
 * @param {string[]} opts.argv 启动参数
 */
function loadConfig({ profilesDir, userDataDir, argv = [] }) {
  const args = parseArgv(argv);
  const layers = [];

  const base = readLayer(path.join(profilesDir, 'default.yml'), 'default');
  layers.push(base);

  const defaultProfile = typeof base.data.defaultProfile === 'string'
    ? base.data.defaultProfile
    : 'desktop';
  const profile = args.profile || defaultProfile;

  if (profile !== 'default' && PROFILE_NAME_RE.test(profile)) {
    layers.push(readLayer(path.join(profilesDir, `${profile}.yml`), `profile:${profile}`));
  }

  const patchPath = path.join(userDataDir, 'nucleus.patch.yml');
  layers.push(readLayer(patchPath, 'user-patch'));

  const state = {
    enableSet: new Set(),
    disableSet: new Set(),
    settings: {},
    settingSources: {},
    force: {},
    currentLayer: '',
  };

  for (const layer of layers) {
    state.currentLayer = layer.name;
    if (layer.exists) mergeInto(state, layer.data);
  }

  const dump = {
    profile,
    requestedBy: args.profile ? 'cli' : (process.env.NUCLEUS_PROFILE ? 'env' : 'default'),
    plugins: {
      enable: Array.from(state.enableSet),
      disable: Array.from(state.disableSet),
    },
    settings: state.settings,
    settingSources: state.settingSources,
    force: state.force,
    layers: layers.map((l) => ({
      name: l.name,
      path: l.path,
      exists: l.exists,
      plugins: l.exists
        ? (Array.isArray(l.data.plugins?.enable) ? l.data.plugins.enable.length : 0)
          + (Array.isArray(l.data.plugins?.disable) ? l.data.plugins.disable.length : 0)
        : 0,
      settings: l.exists && l.data.settings ? Object.keys(l.data.settings).length : 0,
    })),
  };

  return { args, config: dump, patchPath };
}

/**
 * 把配置应用到运行时。
 * @returns {{disabled:string[], enabled:string[], errors:string[]}}
 */
function applyConfig(config, { plugins, settings, bus }) {
  const result = { disabled: [], enabled: [], errors: [] };

  for (const id of config.plugins.disable) {
    try {
      const rec = plugins.get(id);
      if (rec && rec.enabled) {
        const ret = plugins.disable(id);
        if (ret && typeof ret.then === 'function') ret.catch((err) => result.errors.push(`${id}: ${err.message}`));
        result.disabled.push(id);
      }
    } catch (err) {
      result.errors.push(`${id}: ${err.message}`);
    }
  }

  for (const id of config.plugins.enable) {
    try {
      const rec = plugins.get(id);
      if (rec && !rec.enabled) {
        const ret = plugins.enable(id);
        if (ret && typeof ret.then === 'function') ret.catch((err) => result.errors.push(`${id}: ${err.message}`));
        result.enabled.push(id);
      }
    } catch (err) {
      result.errors.push(`${id}: ${err.message}`);
    }
  }

  for (const [key, value] of Object.entries(config.settings)) {
    const forced = key in config.force;
    const existing = settings.get(key);
    if (existing === undefined || forced) {
      settings.set(key, forced ? config.force[key] : value);
      bus.emit('settings:changed', { key, value: forced ? config.force[key] : value });
    }
  }

  return result;
}

/** 首次启动时放一份带注释的模板，让「配置层」是可见的，而不是藏在文档里 */
function ensurePatchTemplate(patchPath) {
  if (fs.existsSync(patchPath)) return false;
  const template = [
    '# Nucleus 用户配置（最后一层覆盖）',
    '#',
    '# 这里写的插件启停会叠加在 profile 之上；enable 优先于 disable。',
    '# 设置项如果已经在设置页里改过，这里的值不会覆盖它 —— 除非写进 force。',
    '#',
    '# plugins:',
    '#   enable:',
    '#     - feature.adblock',
    '#   disable:',
    '#     - feature.reader',
    '#',
    '# settings:',
    '#   "plugin:feature.adblock:enabled": false',
    '#',
    '# force:',
    '#   "appearance.theme": "dark"',
    '',
  ].join('\n');
  try {
    fs.mkdirSync(path.dirname(patchPath), { recursive: true });
    fs.writeFileSync(patchPath, template, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { loadConfig, applyConfig, parseArgv, listProfiles, ensurePatchTemplate };
