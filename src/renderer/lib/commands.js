/**
 * 渲染层命令注册表。
 *
 * 命令是插件之间唯一的「动词」接口：命令面板、快捷键、工具栏按钮、右键菜单
 * 都只是「执行某个命令」的不同入口。插件实现命令，核负责找到它。
 */
export class CommandRegistry {
  constructor({ bridge, onError }) {
    this.bridge = bridge;
    this.map = new Map();
    this.onError = onError || ((err) => console.error(err));
    this._owners = new Map(); // pluginId -> Set<commandId>
  }

  register(id, spec, owner = 'core') {
    const existing = this.map.get(id);
    // 清单里声明的命令本来就等着插件来实现，这种情况不算冲突
    if (existing && existing.hasHandler) {
      console.warn(`[commands] 命令 ${id} 被重复注册，后者覆盖前者`);
    }
    this.map.set(id, {
      id,
      title: spec.title || id,
      icon: spec.icon || null,
      keybinding: spec.keybinding || null,
      description: spec.description || '',
      hidden: !!spec.hidden,
      owner,
      handler: spec.handler,
    });
    if (!this._owners.has(owner)) this._owners.set(owner, new Set());
    this._owners.get(owner).add(id);
    return () => this.unregister(id);
  }

  /** 声明式注册：只有元数据，实现在插件 ui 里按需补 */
  declare(manifest, owner) {
    for (const cmd of manifest.contributes?.commands || []) {
      if (this.map.has(cmd.id)) continue;
      this.map.set(cmd.id, {
        id: cmd.id,
        title: cmd.title,
        icon: cmd.icon,
        keybinding: cmd.keybinding,
        description: cmd.description || '',
        hidden: !!cmd.hidden,
        owner,
        handler: null,
      });
    }
  }

  unregister(id) {
    this.map.delete(id);
  }

  unregisterOwner(owner) {
    for (const id of this._owners.get(owner) || []) this.map.delete(id);
    this._owners.delete(owner);
  }

  has(id) {
    return this.map.has(id);
  }

  get(id) {
    return this.map.get(id) || null;
  }

  list() {
    return Array.from(this.map.values()).map((c) => ({
      id: c.id,
      title: c.title,
      icon: c.icon,
      keybinding: c.keybinding,
      description: c.description,
      hidden: c.hidden,
      owner: c.owner,
      hasHandler: !!c.handler,
    }));
  }

  async execute(id, ...args) {
    const rec = this.map.get(id);
    if (rec && typeof rec.handler === 'function') {
      return rec.handler(...args);
    }
    // 渲染层没实现，交给主进程（后台任务型命令）
    try {
      return await this.bridge.invoke('nucleus:commands:execute', {
        pluginId: rec ? rec.owner : 'core',
        id,
        args,
      });
    } catch (err) {
      if (!rec) throw new Error(`命令不存在：${id}`);
      throw err;
    }
  }
}
