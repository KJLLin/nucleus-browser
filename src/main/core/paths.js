'use strict';
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/** 内置插件目录（随 app 目录发布，与入口同级） */
function builtinPluginDir() {
  return path.join(__dirname, '..', '..', 'plugins');
}

/** 内置配置 profile 目录（随 app 目录发布） */
function profilesDir() {
  // core → main → src → 项目根
  return path.join(__dirname, '..', '..', '..', 'profiles');
}

/** 用户插件目录（%APPDATA%/Nucleus/plugins），支持热插拔 */
function userPluginDir() {
  const dir = path.join(app.getPath('userData'), 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function userDataFile(name) {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

/**
 * 判断 child 是否位于 parent 目录内。
 * 用于自定义协议与插件文件服务，阻断 ../ 目录穿越。
 */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = { builtinPluginDir, profilesDir, userPluginDir, userDataFile, isInside };
