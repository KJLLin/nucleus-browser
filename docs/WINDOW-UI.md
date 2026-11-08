# 窗口与界面：哪些属于宿主，哪些属于插件

> 这份文档回答一个具体问题：在「一切皆插件」的浏览器里，**窗口**和**界面**到底应该被切到哪里。
> 结论来自对 DeepSeek Harness（下称 DSH）公开源码结构与文档的对照分析，以及在 Nucleus 上的落地验证。
> DSH 仍在快速迭代，具体包名可能变化，但分层判断是稳定的。

## 一、结论先行

| 能力 | 归属 | 判断依据 |
| --- | --- | --- |
| 进程 / 原生窗口创建、崩溃恢复、多屏校正 | 宿主 | OS 级能力，换掉就不是浏览器 |
| Chromium 视图（webview / WebContents）的创建与生命周期 | 宿主 | 渲染引擎是浏览器之所以是浏览器的前提 |
| 网络栈（缓存、Cookie、代理、证书） | 宿主 | 插件只能在钩子点注册策略 |
| 存储原语（磁盘、加密、数据库句柄） | 宿主 | 安全边界 |
| Cordis 运行时、Loader、patch 解析、引导 | 宿主 | 组合层本身不能是插件 |
| **界面区域的定义与组合方式** | **插件** | 换一套布局不该改核 |
| **标签栏、地址栏、新标签页** | **插件** | 纯界面策略 |
| **窗口按钮的语义（最小化/最大化/关闭/F11）** | **插件** | 按钮长什么样是产品决策 |
| **状态栏、侧边栏、浮层** | **插件** | 纯界面 |
| **设置页、历史页、书签页、扩展管理页** | **插件** | 内部页面也是页面 |
| 标签数据模型（增删/切换/休眠） | 插件（服务） | 宿主只保留镜像 |
| 导航语义（输入判定、搜索引擎路由） | 插件 | 可替换策略 |

一句话：**宿主保留「引擎 + 安全边界 + 运行时 + 引导」，其余（包括窗口的界面部分）都是插件。**

## 二、DSH 是怎么切的

DSH 是 pnpm monorepo，约 250 个包。与窗口/界面相关的分层：

```
apps/desktop            Electron 壳：创建 BrowserWindow、装载主进程 bundle
apps/desktop-host       Node 侧宿主：Cordis 上下文、Loader、服务装配
packages/boot/app-boot  引导：读 profile → 合并 patch → 挂载插件树
packages/client/web     前端壳：把 client 插件挂到 #root，本身很薄
packages/client/modules 客户端模块装配
packages/client/ui-*    约 80 个界面插件
```

几个关键事实：

1. **`apps/web/src/main.ts` 极薄** —— 只负责把 `@deepseek-ai/dsh-client-web` 挂到 `#root`。
   换句话说，连「Web 前端长什么样」都不在入口里，入口只提供挂载点。
2. **UI 被拆成约 80 个 `ui-*` 包**：布局、会话列表、消息流、输入框、设置、主题……
   每个都是独立插件，可以单独禁用或替换。
3. **布局由插件认领根槽位**：`ui-layout` 提供 AppFrame，注册到根 slot，并在内部声明
   `sidebar / main / statusbar` 等子槽位。宿主不定义这些区域。
4. **必需插件审计**：`requiredClientEntryNames` 这类清单在启动时校验，
   缺了关键插件不是「静默降级」，而是明确失败。
5. **Host / Client 双面构建**：同一份源码，构建期按 `DSH_BUILD_FACE` 分成两个产物面，
   业务包不需要在运行时判断自己跑在哪一侧。

对照下来，DSH 没有把「窗口」做成插件，但把**窗口里的一切界面**都做成了插件，
并且把「界面区域的定义权」也交给了插件（布局插件声明子槽位）。

## 三、Nucleus 的对照与差距

v0.1.0 之前，Nucleus 的做法是：

- `index.html` 写死 8 个 `data-region` 容器；
- `app.js` 的 `installRegions()` 由**核**声明 `region.tabstrip / nav-* / sidebar / statusbar / overlay`；
- `app.js` 的 `installWindowControls()` 由**核**处理窗口按钮点击与图标切换。

这留下两个问题：

1. **区域定义权在核手里**：想换一套布局（比如垂直标签栏、移动端底栏），必须改 `app.js`。
   插件只能往既定区域里塞东西，"换界面"实际上换不掉。
2. **窗口按钮在核里**：`ui.shell` 被禁用时按钮仍然存在，而它们又依赖核的 DOM 假设，
   等于把一个界面策略焊在了引导代码上。

## 四、v0.1.1-rc1 的改动

### 4.1 区域定义权移交给界面插件

`app.js` 现在只保证「有一个根空位」，不再声明任何具体区域：

```js
function installRootSlot() {
  // root 由 SlotRegistry 内置；核刻意不声明 tabstrip / nav-center …
  if (!app.slots.defs.has('root')) return;
}
```

`ui.shell` 在自己的 `activate()` 里声明全部区域：

```js
const REGION_SPECS = [
  { name: 'wincontrols', card: 'list', ownerOnly: 'ui.window', permission: 'window' },
  { name: 'tabstrip', card: 'list' },
  { name: 'nav-left', card: 'list' },
  { name: 'nav-center', card: 'list' },
  { name: 'nav-right', card: 'list' },
  { name: 'sidebar', card: 'single' },
  { name: 'statusbar', card: 'list' },
  { name: 'overlay', card: 'list' },
];
```

`root` 的声明规则也相应放宽：**任何插件都可以在 `root` 下声明子空位**。
如果要求「先往 root 注册条目才能声明子空位」，就等于核必须先画一层界面，
换布局又要回到改核 —— 那插件化是假的。

### 4.2 窗口控制成为独立插件

新增 `ui.window`：三个按钮、双击标题栏最大化、`F11` 全屏、品牌标识显隐。
宿主只保留 `BrowserWindow` 与一个空的 `.wincontrols` 容器。

`region.wincontrols` 带权限策略：

```js
policy: { restricted: true, allow: ['ui.window'], permission: 'window' }
```

窗口按钮能关窗、能最大化，属于安全边界附近的能力，因此只允许声明过的插件注册，
而不是任何 UI 插件都能往里塞一个「关闭」按钮。

### 4.3 必需插件审计

`manifest.required`（仅内置插件可声明）+ `PluginHost.auditRequired()`：

- 启动时写日志：`必需插件审计：齐全` / `必需插件缺失：ui.shell（disabled）`；
- 界面侧恢复通道优先展示必需插件，并说明「它不是可选组件」；
- `ui.shell` 与 `ui.window` 被标记为必需。

这对应 DSH 的 `requiredClientEntryNames`：组合失败要**显式**，不能表现为「浏览器打开是一片空白」。

### 4.4 渲染层补齐窗口能力

渲染层 API 之前没有 `nucleus.window`，窗口插件只能直接摸 DOM。现在补上：

```js
nucleus.window.minimize() / toggleMaximize() / close() / toggleFullScreen()
nucleus.window.isMaximized()
nucleus.window.on('maximized', fn)   // 事件由主进程广播，经 bus 转发
```

## 五、还没有插件化的部分，以及为什么

| 部分 | 现状 | 为什么先不做 |
| --- | --- | --- |
| 多窗口 | 单窗口 | 窗口是宿主资源；多窗口需要先有窗口注册表与跨窗口 RPC，属于宿主能力扩展，不是插件能自行解决的 |
| 标签视图容器（`#webarea`） | 宿主 DOM | `<webview>` 的挂载点与层叠顺序（侧边栏、浮层要能盖住网页）由宿主保证；插件拿到的是受限的 `tabs` API |
| 浏览器动作（前进/后退的实际执行） | 宿主执行、插件触发 | 导航原语在 `webContents` 上，插件只决定「什么时候调用」 |
| 内部页面（设置/历史/书签/扩展） | 插件页面 | 已经是插件：`nucleus://<plugin>/index.html`，与网页共用同一套标签机制 |
| 主题变量 | 插件 | `theme.nucleus` 只改 CSS 变量；宿主不内置配色 |

## 六、下一步

1. **窗口注册表**：宿主提供多窗口原语，`ui.window` 插件负责窗口切换器与布局；
2. **布局插件化**：把 `ui.shell` 再拆成 `ui.layout`（区域声明）+ `ui.tabstrip` + `ui.omnibox`，
   让「换布局」只换 `ui.layout` 一个插件；
3. **内部页面 keyed 槽位**：让设置页的每个分区都能被其他插件接管，而不是一个插件画完；
4. **视图与标签解耦**：标签数据（`tabs`）与 `<webview>` 生命周期分离，为崩溃恢复和会话迁移铺路。

---

参考：DSH 仓库 `docs/architecture.md`、`packages/client/*`、`packages/bundle/base/cordis.patch.yml`，
以及 Cordis 的 fiber / service / slot 语义。本文只做结构对照，不复制其代码。
