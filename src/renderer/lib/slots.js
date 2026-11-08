/**
 * 槽位（Slot）注册表 —— 浏览器界面层的组合系统。
 *
 * 语义对齐 DeepSeek Harness 的 client slots，只是把 React 换成了 DOM：
 *
 *   声明（declare）  拥有某个渲染位置的插件，把那个位置开成一个有名空位
 *   注册（register） 任何插件往里放条目，可带 order / priority / when / key
 *   渲染（outlet）   owner 把空位挂到自己的 DOM 里，条目由注册表填进去
 *   折叠（dispose） 声明消失时，它下面的注册与子空位一起撤销
 *
 * 四条不变量（都是 Cordis 的 effect 语义在这个模块里的投影）：
 *   1. 每个空位有且只有一个 owner，只有 owner 能渲染它
 *   2. 注册必须落在已声明的空位上，否则拒绝并记账（供自省页查看）
 *   3. 注册者必须在 manifest 里静态声明过这个空位，或获得 owner 的策略放行
 *   4. 撤销是递归的：父空位折叠 → 子空位折叠 → 它们的注册全部移除
 */

const DEFAULT_ORDER = 100;
const DEFAULT_PRIORITY = 100;
const CARDINALITIES = new Set(['single', 'list', 'keyed', 'chain']);
const SCOPES = new Set(['root', 'tab', 'tab-maybe']);

function seqOf(entry) {
  return entry.__seq;
}

export class SlotRegistry {
  constructor() {
    /** name -> definition */
    this.defs = new Map();
    /** name -> entry[] */
    this.entries = new Map();
    /** name -> Set<outlet> */
    this.outlets = new Map();
    /** name -> Set<{cb, dispose}> 等待声明出现的注入 */
    this.pending = new Map();
    /** 被拒绝的注册（诊断用，容量上限防止无限增长） */
    this.rejections = [];
    this.seq = 0;
    this._frame = 0;
    this._dirty = new Set();

    // root 是唯一内置声明：整个界面的挂载点
    this.defs.set('root', {
      name: 'root',
      parent: null,
      owner: 'core',
      cardinality: 'single',
      scope: 'root',
      policy: { restricted: false },
      description: '应用根空位',
      children: new Set(),
      builtin: true,
    });
    this.entries.set('root', []);
  }

  // ---------------------------------------------------------------- 声明

  /**
   * 声明一个空位。只能在自己的渲染位置下声明 —— parent 必须已存在且由自己拥有。
   * @param {object} spec { name, parent, cardinality, scope, policy, description }
   * @param {object} who  { id, permissions, contributes }
   */
  declare(spec, who) {
    if (!spec || typeof spec.name !== 'string' || !spec.name) {
      throw new Error('declare 需要 name');
    }
    const name = spec.name;
    if (this.defs.has(name)) {
      throw new Error(`空位已存在：${name}`);
    }

    const parent = spec.parent === undefined ? 'root' : spec.parent;
    const parentDef = parent === null ? null : this.defs.get(parent);
    if (parent !== null && !parentDef) {
      throw new Error(`父空位尚未声明：${parent}`);
    }
    if (parentDef && parentDef.owner !== who.id && who.id !== 'core' && parent !== 'root') {
      // 谁渲染谁声明：即使不是空位 owner，只要在这个位置有注册条目，
      // 就说明那块界面确实是它画的，可以在里面继续开子空位。
      //
      // root 例外：它是「整个界面」的挂载点，本来就该由界面插件认领。
      // 如果要求先往 root 注册条目才能声明子空位，就等于核必须先画一层界面，
      // 「换一套布局」又要回到改核 —— 那插件化就是假的。
      const renders = (this.entries.get(parent) || []).some((e) => e.pluginId === who.id);
      if (!renders) {
        this._reject(name, who.id, `无权在 ${parent} 下声明子空位（owner 是 ${parentDef.owner}）`);
        throw new Error(`无权在 ${parent} 下声明子空位`);
      }
    }

    const cardinality = CARDINALITIES.has(spec.cardinality) ? spec.cardinality : 'list';
    const scope = SCOPES.has(spec.scope) ? spec.scope : 'root';
    const policy = normalizePolicy(spec.policy);

    const def = {
      name,
      parent,
      owner: who.id,
      cardinality,
      scope,
      policy,
      description: typeof spec.description === 'string' ? spec.description : '',
      children: new Set(),
      builtin: false,
      declaredAt: Date.now(),
    };
    this.defs.set(name, def);
    this.entries.set(name, []);
    if (parentDef) parentDef.children.add(name);

    // 有人在等这个空位出现，现在放行
    this._flushPending(name);

    this.invalidate(parent === null ? name : parent);
    return () => this._collapse(name);
  }

  // ---------------------------------------------------------------- 注册

  /**
   * 往空位里注册一个条目。
   * @param {object} entry { name, id, order, priority, when, key, select, render }
   * @param {object} who   { id, permissions, contributes }
   */
  register(entry, who) {
    if (!entry || typeof entry.name !== 'string') throw new Error('register 需要 name');
    if (typeof entry.render !== 'function') throw new Error(`注册 ${entry.name} 需要 render 函数`);

    const def = this.defs.get(entry.name);
    if (!def) {
      this._reject(entry.name, who.id, '空位尚未声明');
      throw new Error(`空位尚未声明：${entry.name}`);
    }

    // 权限闸：清单静态声明 + owner 策略
    const deny = this._checkAccess(def, who);
    if (deny) {
      this._reject(entry.name, who.id, deny);
      throw new Error(deny);
    }

    const id = typeof entry.id === 'string' && entry.id ? entry.id : `auto-${++this.seq}`;

    if (def.cardinality === 'keyed' && typeof entry.key !== 'string') {
      throw new Error(`空位 ${entry.name} 是 keyed，注册需要 key`);
    }
    if (def.cardinality === 'chain' && typeof entry.select !== 'function') {
      throw new Error(`空位 ${entry.name} 是 chain，注册需要 select(owner)`);
    }

    const rec = {
      __seq: ++this.seq,
      name: entry.name,
      id,
      // 允许核代注册时标注真实来源插件
      pluginId: typeof entry.pluginId === 'string' ? entry.pluginId : who.id,
      order: Number.isFinite(entry.order) ? entry.order : DEFAULT_ORDER,
      priority: Number.isFinite(entry.priority) ? entry.priority : DEFAULT_PRIORITY,
      when: typeof entry.when === 'function' ? entry.when : null,
      key: typeof entry.key === 'string' ? entry.key : null,
      select: typeof entry.select === 'function' ? entry.select : null,
      render: entry.render,
      meta: entry.meta || null,
    };

    this.entries.get(entry.name).push(rec);
    this.invalidate(entry.name);

    return () => {
      const list = this.entries.get(entry.name);
      if (!list) return;
      const i = list.indexOf(rec);
      if (i >= 0) list.splice(i, 1);
      this.invalidate(entry.name);
    };
  }

  /**
   * 等某个空位被声明后再注册。owner 卸载时自动撤销，owner 重新挂载时再次执行。
   * 这是插件不必猜「对方加载了没有」的关键。
   */
  inject(name, callback, who) {
    if (typeof callback !== 'function') throw new Error('inject 需要回调');
    const def = this.defs.get(name);
    if (def) {
      // 已存在：立即执行，把回调里的注册记在这个回调名下
      const rec = { cb: callback, dispose: null };
      this._runInject(name, rec, who);
      return () => this._disposeInject(name, rec);
    }
    let set = this.pending.get(name);
    if (!set) {
      set = new Set();
      this.pending.set(name, set);
    }
    const rec = { cb: callback, dispose: null, who };
    set.add(rec);
    return () => this._disposeInject(name, rec);
  }

  // ---------------------------------------------------------------- 渲染

  /**
   * 创建一个空位容器。owner 把它插到自己的 DOM 里，注册表负责填内容。
   * @param {string} name 空位名
   * @param {object} props 传给每个条目 render 的上下文（owner 自己的数据）
   */
  outlet(name, props = {}) {
    return this._attach(name, document.createElement('div'), props, false);
  }

  /**
   * 认领一个既有元素作为空位容器。
   * bare = true 时不包 .slot-item 外壳 —— 标签栏这类靠「直接子元素」写样式的
   * 容器必须用这个模式，否则每层 wrapper 都会破坏 CSS 选择器。
   */
  adopt(name, element, props = {}, bare = true) {
    return this._attach(name, element, props, bare);
  }

  _attach(name, el, props, bare) {
    const def = this.defs.get(name);
    if (!def) throw new Error(`空位尚未声明：${name}`);

    if (!el.dataset) el.dataset = {};
    if (!el.dataset.slot) el.dataset.slot = name;
    el.dataset.cardinality = def.cardinality;

    const outlet = { el, props: { ...props }, cache: new Map(), name, bare };
    let set = this.outlets.get(name);
    if (!set) {
      set = new Set();
      this.outlets.set(name, set);
    }
    set.add(outlet);

    this._paint(def, outlet);
    return el;
  }


  /** 更新某个容器的 owner 数据（例如当前标签变了），并重绘 */
  updateOutlet(el, props) {
    const name = el && el.dataset ? el.dataset.slot : null;
    if (!name) return;
    for (const o of this.outlets.get(name) || []) {
      if (o.el !== el) continue;
      const next = { ...o.props, ...props };
      // 只在 owner 数据真的变了才重建。标签的 updated 事件很频繁，
      // 每次重建会让地址栏里的按钮闪烁、丢失 hover。
      let sig;
      try { sig = JSON.stringify(next); } catch (_) { sig = String(Date.now()); }
      o.props = next;
      if (sig === o.propsSig) continue;
      o.propsSig = sig;
      this._paint(this.defs.get(name), o, true);
    }
  }

  /** 容器从 DOM 里摘掉时调用，避免注册表抓着已死元素 */
  removeOutlet(el) {
    const name = el && el.dataset ? el.dataset.slot : null;
    if (!name) return;
    const set = this.outlets.get(name);
    if (set) {
      for (const o of Array.from(set)) if (o.el === el) set.delete(o);
    }
  }

  /** 标记需要重绘；不传参数表示全部 */
  invalidate(name) {
    if (name) this._dirty.add(name);
    else for (const key of this.defs.keys()) this._dirty.add(key);
    if (this._frame) return;
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16);
    this._frame = schedule(() => {
      this._frame = 0;
      const names = Array.from(this._dirty);
      this._dirty.clear();
      for (const n of names) this._refresh(n);
    });
  }

  _refresh(name) {
    const def = this.defs.get(name);
    if (!def) return;
    for (const outlet of this.outlets.get(name) || []) {
      this._paint(def, outlet);
    }
    // 子空位的内容依赖父的数据时（scope: tab），一起刷新
    const visited = new Set([name]);
    for (const child of def.children) this._refreshDeferred(child, visited);
  }

  /**
   * 子空位递归刷新。必须带 visited：
   * 同一棵子树会被父级多次触达（父声明变化 + 自己的 invalidate），
   * 没有去重时深树会指数级重复绘制。
   */
  _refreshDeferred(child, visited = new Set()) {
    if (visited.has(child)) return;
    visited.add(child);
    const def = this.defs.get(child);
    if (!def) return;
    for (const outlet of this.outlets.get(child) || []) this._paint(def, outlet);
    for (const c of def.children) this._refreshDeferred(c, visited);
  }

  /** 缓存键要带来源插件：两个插件恰好都用 id "main" 时不能互相覆盖 */
  _keyOf(entry) {
    return `${entry.pluginId}::${entry.id}`;
  }

  _paint(def, outlet, force = false) {
    // 强制重绘时先清干净：否则旧节点会被新节点顶掉，变成 DOM 里的孤儿
    if (force) {
      for (const n of Array.from(outlet.el.children)) n.remove();
      outlet.cache.clear();
    }

    const selected = this._select(def, outlet.props);
    const seen = new Set();

    for (const item of selected) {
      const entry = item.entry;
      const key = this._keyOf(entry);
      const sig = force ? `${Date.now()}-${Math.random()}` : item.sig;
      seen.add(key);

      const cached = outlet.cache.get(key);
      // 注意不能用 isConnected：容器首帧还没插进文档，但节点确实已经在容器里了。
      // 判「节点仍属于这个容器」才是正确的复用条件。
      if (cached && cached.sig === sig && cached.node && cached.node.parentNode === outlet.el) {
        outlet.el.appendChild(cached.node); // 顺序由 append 决定
        continue;
      }
      // 未命中：先把同一 key 的旧节点摘掉。否则旧节点会被新节点顶掉、
      // 失去引用留在 DOM 里 —— 表现为同一个按钮出现两次。
      if (cached) {
        for (const n of cached.nodes || (cached.node ? [cached.node] : [])) {
          if (n && n.parentNode) n.remove();
        }
        outlet.cache.delete(key);
      }

      let node = null;
      try {
        node = entry.render({
          ...outlet.props,
          ...(item.scopeProps || {}),
          slot: def.name,
          entry,
          matched: item.matched,
        });
      } catch (err) {
        console.error(`[slots] ${def.name}/${entry.id} 渲染失败`, err);
        node = renderError(def.name, entry.id, err);
      }
      if (!node) {
        outlet.cache.delete(key);
        continue;
      }

      // 允许 render 返回数组
      const frag = (Array.isArray(node) ? node : [node]).filter(Boolean);

      if (outlet.bare) {
        const nodes = frag;
        for (const n of nodes) {
          if (n.dataset) n.dataset.slotFrom = entry.pluginId;
          outlet.el.appendChild(n);
        }
        outlet.cache.set(key, { sig, node: nodes[0], nodes });
        continue;
      }

      const wrap = document.createElement('div');
      wrap.className = 'slot-item';
      wrap.dataset.slotItem = entry.id;
      wrap.dataset.plugin = entry.pluginId;
      for (const n of frag) wrap.appendChild(n);

      outlet.cache.set(key, { sig, node: wrap, nodes: [wrap] });
      outlet.el.appendChild(wrap);
    }

    // 清掉不再出现的条目
    for (const [key, cached] of outlet.cache) {
      if (seen.has(key)) continue;
      for (const n of cached.nodes || (cached.node ? [cached.node] : [])) {
        if (n && n.parentNode) n.remove();
      }
      outlet.cache.delete(key);
    }
  }

  /** 按 cardinality 选出该渲染的条目 */
  _select(def, props) {
    const list = this.entries.get(def.name) || [];
    const alive = [];
    for (const e of list) {
      let active = true;
      if (e.when) {
        try { active = !!e.when(props); } catch (err) {
          console.error(`[slots] ${def.name}/${e.id} 的 when 求值失败`, err);
          active = false;
        }
      }
      if (active) alive.push({ entry: e, sig: `${e.__seq}:1` });
      else if (def.cardinality === 'single' || def.cardinality === 'keyed') {
        // 不参与竞争，但记录状态供自省
      }
    }

    if (!alive.length) return [];

    switch (def.cardinality) {
      case 'single': {
        const winner = alive.slice().sort((a, b) => a.entry.priority - b.entry.priority || a.entry.__seq - b.entry.__seq)[0];
        return [winner];
      }
      case 'keyed': {
        const dispatchKey = props.dispatchKey != null ? String(props.dispatchKey) : null;
        const hit = alive
          .filter((a) => dispatchKey !== null && a.entry.key === dispatchKey)
          .sort((a, b) => a.entry.priority - b.entry.priority || a.entry.__seq - b.entry.__seq)[0];
        return hit ? [{ ...hit, sig: `${hit.sig}:${dispatchKey}` }] : [];
      }
      case 'chain': {
        const ordered = alive
          .slice()
          .sort((a, b) => a.entry.priority - b.entry.priority || a.entry.__seq - b.entry.__seq);
        for (const item of ordered) {
          let matched = null;
          try { matched = item.entry.select(props); } catch (err) {
            console.error(`[slots] ${def.name}/${item.entry.id} 的 select 求值失败`, err);
          }
          if (matched != null) {
            return [{
              entry: item.entry,
              matched,
              scopeProps: { matched },
              sig: `${item.sig}:${safeKey(matched)}`,
            }];
          }
        }
        return [];
      }
      case 'list':
      default:
        return alive.sort((a, b) => a.entry.order - b.entry.order || a.entry.__seq - b.entry.__seq);
    }
  }

  // ---------------------------------------------------------------- 折叠

  /**
   * 清理来自「已不存在插件」的条目。
   *
   * 正常路径下不该有这种条目（注册都记在 fiber 账本上），
   * 但插件如果在主进程侧被禁用、界面还没重载，就会留下一批孤儿。
   * 健康检查的修复动作会调用这里，返回清掉的条数。
   */
  prune(aliveIds) {
    const alive = aliveIds instanceof Set ? aliveIds : new Set(aliveIds || []);
    let removed = 0;
    for (const [name, list] of this.entries) {
      let hit = 0;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const e = list[i];
        if (!e || e.pluginId === 'core' || alive.has(e.pluginId)) continue;
        list.splice(i, 1);
        hit += 1;
      }
      if (hit) {
        removed += hit;
        this.invalidate(name);
      }
    }
    return removed;
  }

  _collapse(name) {
    const def = this.defs.get(name);
    if (!def || def.builtin) return;

    // 先折叠子空位（递归）
    for (const child of Array.from(def.children)) this._collapse(child);

    // 撤销等待中的注入
    for (const rec of this.pending.get(name) || []) this._disposeInject(name, rec);
    this.pending.delete(name);

    // 清空容器
    for (const outlet of this.outlets.get(name) || []) {
      outlet.el.innerHTML = '';
      outlet.cache.clear();
    }
    this.outlets.delete(name);
    this.entries.delete(name);

    if (def.parent) {
      const parent = this.defs.get(def.parent);
      if (parent) parent.children.delete(name);
    }
    this.defs.delete(name);
    this.invalidate(def.parent || null);
  }

  // ---------------------------------------------------------------- 权限

  _checkAccess(def, who) {
    if (who.id === 'core') return null;
    if (def.owner === who.id) return null;

    const policy = def.policy || {};
    if (Array.isArray(policy.allow) && policy.allow.includes(who.id)) return null;
    if (policy.permission && (who.permissions || []).includes(policy.permission)) return null;

    if (policy.restricted) {
      return `空位 ${def.name} 已限制访问：需要 owner 放行或 ${policy.permission || '特定'} 权限`;
    }

    // 非受限空位仍要求清单静态声明 —— 让"这个插件会改哪里"在安装前就可见
    const declared = (who.contributes && who.contributes.slots) || [];
    if (declared.includes(def.name) || declared.includes('*')) return null;

    return `插件 ${who.id} 未在 manifest 的 contributes.slots 中声明 ${def.name}`;
  }

  _reject(name, pluginId, reason) {
    this.rejections.unshift({ name, pluginId, reason, at: Date.now() });
    if (this.rejections.length > 60) this.rejections.length = 60;
    console.warn(`[slots] 拒绝 ${pluginId} → ${name}：${reason}`);
  }

  // ---------------------------------------------------------------- 注入

  _flushPending(name) {
    const set = this.pending.get(name);
    if (!set) return;
    for (const rec of Array.from(set)) {
      this._runInject(name, rec, rec.who);
    }
  }

  _runInject(name, rec, who) {
    try {
      const result = rec.cb({
        name,
        register: (entry) => this.register({ ...entry, name }, who),
      });
      rec.dispose = typeof result === 'function' ? result : null;
    } catch (err) {
      console.error(`[slots] 注入 ${name} 失败`, err);
    }
  }

  _disposeInject(name, rec) {
    const set = this.pending.get(name);
    if (set) set.delete(rec);
    if (typeof rec.dispose === 'function') {
      try { rec.dispose(); } catch (err) { console.error(`[slots] 撤销注入 ${name} 失败`, err); }
      rec.dispose = null;
    }
  }

  // ---------------------------------------------------------------- 自省

  /** 供自省页使用的完整快照：树形结构 + 每个条目的活性 */
  snapshot() {
    const nodes = [];
    const walk = (name, depth) => {
      const def = this.defs.get(name);
      if (!def) return;
      const list = this.entries.get(name) || [];
      const outletCount = (this.outlets.get(name) || new Set()).size;
      let selected = [];
      try { selected = this._select(def, {}).map((s) => s.entry.id); } catch (_) { /* when 里有依赖 */ }
      nodes.push({
        name,
        parent: def.parent,
        depth,
        owner: def.owner,
        cardinality: def.cardinality,
        scope: def.scope,
        description: def.description,
        restricted: !!(def.policy && def.policy.restricted),
        policy: def.policy || {},
        outlets: outletCount,
        selected,
        entries: list.map((e) => ({
          id: e.id,
          pluginId: e.pluginId,
          order: e.order,
          priority: e.priority,
          key: e.key,
          hasWhen: !!e.when,
          hasSelect: !!e.select,
          active: selected.includes(e.id),
        })),
      });
      for (const child of def.children) walk(child, depth + 1);
    };
    walk('root', 0);
    return {
      slots: nodes,
      rejections: this.rejections.slice(),
      total: this.defs.size,
      entries: Array.from(this.entries.values()).reduce((n, l) => n + l.length, 0),
    };
  }
}

function normalizePolicy(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    restricted: p.restricted === true,
    allow: Array.isArray(p.allow) ? p.allow.filter((x) => typeof x === 'string') : [],
    permission: typeof p.permission === 'string' ? p.permission : null,
  };
}

function renderError(slot, id, err) {
  const el = document.createElement('div');
  el.className = 'slot-error';
  el.title = String(err && err.stack ? err.stack : err);
  el.textContent = `槽位渲染失败：${slot}/${id}`;
  return el;
}

function safeKey(v) {
  if (v == null) return 'null';
  if (typeof v === 'string') return v.length > 40 ? v.slice(0, 40) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v).slice(0, 40); } catch (_) { return 'obj'; }
}
