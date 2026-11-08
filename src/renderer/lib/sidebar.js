/**
 * 侧边栏管理：同一时刻只显示一个插件面板。
 * 核只负责「容器 + 宽度 + 左右位置」，内容完全由插件构建。
 */
export class SidebarManager {
  constructor() {
    this.el = document.querySelector('[data-region="sidebar"]');
    this.current = null;
    this._onChange = new Set();
  }

  get isOpen() {
    return !!(this.el && !this.el.hidden);
  }

  show(owner, node, { side = 'left', width = 300 } = {}) {
    if (!this.el) return;
    this.el.hidden = false;
    this.el.dataset.side = side;
    this.el.style.width = `${width}px`;
    this.el.innerHTML = '';
    this.el.appendChild(node);
    this.current = owner;
    this._emit();
  }

  hide() {
    if (!this.el) return;
    this.el.hidden = true;
    this.el.innerHTML = '';
    this.current = null;
    this._emit();
  }

  /** 打开 / 关闭切换；返回切换后的状态 */
  toggle(owner, factory, opts) {
    if (this.current === owner && this.isOpen) {
      this.hide();
      return false;
    }
    const node = factory();
    this.show(owner, node, opts);
    return true;
  }

  close(owner) {
    if (this.current === owner) this.hide();
  }

  onChange(fn) {
    this._onChange.add(fn);
    return () => this._onChange.delete(fn);
  }

  _emit() {
    for (const fn of this._onChange) {
      try { fn(this.current); } catch (err) { console.error(err); }
    }
  }
}
