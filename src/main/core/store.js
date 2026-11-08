'use strict';
/**
 * 轻量 JSON 存储：原子写入 + 防抖落盘。
 * 核内所有持久化状态（窗口位置、设置、插件状态）都走这里，
 * 避免各插件各写一套导致文件损坏。
 */
const fs = require('fs');
const path = require('path');

class JsonStore {
  /**
   * @param {string} file 绝对路径
   * @param {object} defaults 默认值（浅合并）
   */
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = defaults;
    this.data = this._load();
    this._timer = null;
    this._dirty = false;
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return Object.assign({}, this.defaults, parsed);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // 文件损坏时保留现场，避免用户数据被静默覆盖
        try {
          fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch (_) { /* ignore */ }
      }
      return JSON.parse(JSON.stringify(this.defaults));
    }
  }

  get(key, fallback) {
    if (key === undefined) return this.data;
    return key in this.data ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  merge(patch) {
    Object.assign(this.data, patch);
    this.save();
  }

  delete(key) {
    delete this.data[key];
    this.save();
  }

  /** 防抖 120ms 落盘，避免高频写入 */
  save() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 120);
  }

  flush() {
    if (!this._dirty) return;
    this._dirty = false;
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] 写入失败', this.file, err);
    }
  }
}

module.exports = { JsonStore };
