'use strict';
/** 全局唯一的通道注册表：IPC 处理与自省页共用同一份 */
const { TypeRegistry } = require('./typert');
const { SPECS } = require('./channels');

module.exports = new TypeRegistry().defineAll(SPECS);
