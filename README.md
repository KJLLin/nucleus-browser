# Nucleus

> 一个「一切皆插件」的浏览器，底座是 Cordis —— 与 DeepSeek Harness 同一个插件内核。

**版本 0.1.1-rc1** · 首个公开发布版，仍在开发中。

Nucleus 用 Chromium 108 内核（Electron 22.3.27，**最后一个支持 Windows 7 的版本**）构建。
插件树、可逆副作用、服务注册与依赖注入由 Cordis 负责；核只保留 Cordis 不提供的部分：
清单校验、权限网关、`nucleus://` 协议、进程间桥接。

界面与功能几乎全部是插件：标签栏、地址栏、新标签页、书签、历史、下载、广告拦截、主题、
右键菜单、命令面板，甚至设置页本身，都可以单独禁用或替换。

---

## 一、为什么叫「一切皆插件」

大多数浏览器的架构是「内核 + 扩展」：内核提供完整功能，扩展只能在边缘加东西。

Nucleus 尝试另一条路 —— 把内核压到最小，把功能全部外置：

| 核（Kernel）负责 | 核**不**负责 |
| --- | --- |
| 创建窗口、承载网页视图 | 标签栏长什么样 |
| 扫描/加载/启停插件 | 地址栏怎么解析输入 |
| 校验权限、转发 IPC | 书签存在哪 |
| 提供事件总线与 RPC | 广告怎么拦 |
| 渲染若干「空区域」 | 设置页有哪些项 |

结果是：把 `ui.shell` 禁用，标签栏、地址栏、新标签页会一起消失，只剩一块空白的网页区域；
换成另一个实现了 `contributes.newTab` 的界面插件，浏览器就换了一整套外观。
把 `feature.adblock` 删掉，拦截逻辑与它的统计角标会一起消失，不会留下任何孤儿按钮。

界面为什么是**一个**插件而不是三个：标签栏、地址栏、新标签页共享同一份「当前标签」状态，
拆成三个插件只会逼它们互相订阅、互相猜测。DeepSeek Harness 的做法也是把一整套交互外壳
交给一个插件，核只留容器 —— 内核对「地址栏」这个词没有任何概念。

核只提供 **6 个 UI 区域**，插件往里面放东西：

```
┌──────────────────────────────────────────────────────────┐
│  brand          [ tabstrip 区域 ]          窗口按钮        │  ← 核（可拖拽）
├──────────────────────────────────────────────────────────┤
│ [nav-left]      [ nav-center ]      [ nav-right]         │  ← 插件填充
├────────────┬─────────────────────────────────────────────┤
│  sidebar   │                                             │
│  区域       │            webarea（核独占）                 │
│ (插件面板)  │                                             │
├────────────┴─────────────────────────────────────────────┤
│  overlay 区域（浮层：命令面板 / 对话框 / 查找条）              │
└──────────────────────────────────────────────────────────┘
```

---

## 二、系统要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 7 SP1 / 8 / 8.1 / 10 / 11（64 位） |
| 运行库 | Windows 7 需要 [KB2533623](https://support.microsoft.com/help/2533623) 与 SHA-2 更新（KB4474419） |
| 内存 | 建议 2 GB 以上 |
| 磁盘 | 约 350 MB（解压后） |

> **为什么锁定 Electron 22？** Chromium 110 起正式放弃 Windows 7/8/8.1。
> Electron 22.3.27 是最后一个仍支持这三代系统的稳定版本，内核为 Chromium 108。
> 这是一个刻意的取舍：牺牲新特性，换 Win7 可用。

---

## 三、快速开始

1. 解压 `Nucleus-2.0.1-win7-x64.zip` 到任意目录（**不要放在需要管理员权限的路径下**）。
2. 双击 `Nucleus.exe`。
3. 首次启动会在 `%APPDATA%\Nucleus\` 建立配置目录。

绿色版，卸载直接删目录即可（配置在 `%APPDATA%\Nucleus`，需要一并删除）。

**命令行开关**

| 开关 | 作用 |
| --- | --- |
| `--nucleus-gpu-off` | 关闭硬件加速（老显卡花屏时使用） |
| `--nucleus-profile=工作` | 使用独立配置目录 `Nucleus-工作` |
| `--nucleus-url=https://…` | 启动时直接打开指定页面 |
| `--nucleus-devtools` | 打开浏览器界面的开发者工具（调试插件用） |

---

## 四、内置插件

21 个插件，覆盖一个浏览器该有的全部日常能力。界面部分合并为单一的 `ui.shell`，
另有「运行时自省」与「浏览器扩展」两个元能力插件。

| 插件 ID | 名称 | 贡献 |
| --- | --- | --- |
| `ui.shell` | 浏览器界面 | 标签栏 + 导航按钮 + 智能地址栏 + 新标签页，并声明整套界面区域（必需） |
| `ui.window` | 窗口控制 | 最小化/最大化/关闭、双击标题栏、`F11` 全屏（必需） |
| `feature.bookmarks` | 书签 | 工具栏星标、侧边栏面板、`Ctrl+D` |
| `feature.history` | 历史记录 | 自动记录、按日期分组、向地址栏提供补全 |
| `feature.downloads` | 下载管理 | 任务进度、工具栏角标、下载面板 |
| `feature.find` | 页内查找 | `Ctrl+F` 查找条、匹配计数、上下跳转 |
| `feature.adblock` | 广告与追踪拦截 | 域名级过滤、三档强度、拦截计数 |
| `feature.palette` | 命令面板 | `Ctrl+K` 搜索并执行任意命令 |
| `feature.settings` | 设置与插件管理 | 自动生成设置表单、启停/安装/卸载插件 |
| `feature.session` | 会话恢复 | 记住标签、下次启动恢复 |
| `feature.contextmenu` | 右键菜单 | 链接/图片/选中文本/输入框的差异化菜单 |
| `feature.devtools` | 开发者工具 | `F12`、查看源代码 |
| `feature.reader` | 阅读模式 | 提取正文、重排排版、`Ctrl+Alt+R` |
| `feature.screenshot` | 网页截图 | 截取可视区域、保存 PNG 或复制 |
| `theme.nucleus` | 主题与外观 | 深色/浅色/跟随系统、界面密度 |
| `feature.inspector` | 运行时自省 | 插件 fiber、服务、槽位树、RPC 契约、事件流、配置层叠 |
| `feature.extensions` | 浏览器扩展 | 加载 Chrome 扩展子集：内容脚本、popup、MV2 后台页、消息路由 |
| `feature.tabsleep` | 标签休眠 | 空闲后台标签释放渲染进程，切回时按原地址重建；固定标签与内建页面永不休眠 |
| `feature.notes` | 侧边便签 | 右侧抽屉里的随手记，输入即保存，数据在插件自己的存储命名空间 |
| `feature.shortcuts` | 快捷键速查 | `F1` 打开，直接读命令注册表，按来源插件分组 |
| `feature.privacy` | 隐私清理 | 分别清除缓存与站点数据，记录上次清理时间 |

---

## 五、架构

### 5.1 进程与职责

```
┌────────────────────── 主进程（Node.js） ──────────────────────┐
│  main.js                                                      │
│   ├─ Kernel             Cordis 根上下文（服务容器）              │
│   ├─ WindowService      窗口 + 位置记忆                        │
│   ├─ PluginHost         扫描 → 校验 → 挂到 Cordis → 停用         │
│   ├─ ProtocolService    nucleus:// 资源服务（含目录穿越防护）      │
│   ├─ InterceptService   多插件共享的 webRequest 总线             │
│   ├─ ShortcutService    before-input-event → 命令              │
│   ├─ TabMirror          标签镜像（只读，写操作 RPC 下发）         │
│   └─ CommandRegistry / DownloadService / SessionService        │
└──────────────────────────────┬────────────────────────────────┘
                               │ IPC（每个请求都带 pluginId 做权限校验）
┌──────────────────────────────┴────────────────────────────────┐
│ 渲染进程（浏览器外壳）                                          │
│   ├─ TabsService   <webview> 的唯一管理者（真相源）              │
│   ├─ SidebarManager / CommandRegistry / UI 原子层              │
│   └─ 插件 UI（ESM 动态 import，来自 nucleus://<id>/ui.js）      │
├───────────────────────────────────────────────────────────────┤
│ 每个标签：<webview> = 独立渲染进程                               │
│   └─ web-preload.js  注入内容脚本（隔离世界）+ 内部页面 RPC 桥    │
└───────────────────────────────────────────────────────────────┘
```

**为什么标签在渲染层？**
`<webview>` 是 DOM 元素，只有它能和浏览器 UI 自由叠放 —— 侧边栏、命令面板、下拉补全
必须能盖在网页之上。`BrowserView` 会永远浮在窗口内容上层，做不到这一点。
代价是主进程只能维护一份只读镜像，写操作通过 RPC 下发（`src/main/core/tabs.js`）。

### 5.2 插件生命周期

```
扫描目录 → 读取 manifest.json → schema 校验 → 检查启用状态
   → root.plugin({ name, apply })        ← 挂到 Cordis
       └─ apply 里：require(main.js) → activate(ctx)（8 秒超时保护）
   → 收集 contributes → 重建快捷键表 → 广播 plugins:changed
```

停用就是 `fiber.dispose()`：Cordis 逆序回收该插件登记的全部副作用。

单插件失败会被隔离：Cordis 把 fiber 标为 FAILED，核记录 `status: "error"` 与原因，
其他插件与核继续正常工作。

### 5.3 权限模型

插件在 `manifest.permissions` 里声明能力，核在 IPC 与 ctx 两层逐条校验：

```
tabs  window  storage  settings  commands  network  session  protocol
downloads  notifications  shell  clipboard  cookies  devtools  plugins  dialog
```

未声明的能力调用会直接抛 `EPERM_PLUGIN`，错误信息里写明缺哪个权限。

> **诚实标注**：这是**防误用**级别的隔离，不是对抗恶意代码的沙箱。
> 插件仍是以你的身份运行的本地代码。请只安装你信任的插件。

### 5.4 贡献点（contributes）

| 贡献点 | 作用 |
| --- | --- |
| `commands` | 命令 + 默认快捷键。命令面板、工具栏、右键菜单都只是它的入口 |
| `toolbar` | 声明式工具栏按钮（核自动渲染；需要动态状态时插件自己 mount） |
| `panels` | 侧边栏面板入口 |
| `settings` | 设置项 schema，设置页据此**自动生成表单** |
| `contentScripts` | 注入网页的脚本（隔离世界，可操作 DOM，读不到页面 JS 变量） |
| `themes` | 主题变量包 |
| `newTab` | 声明「新标签页归我」，值为 `{ url }`。谁声明谁提供，核只转交地址 |
| `omniboxProviders` | 地址栏搜索提供者（`ui.shell` 用它拉历史补全） |

### 5.5 Cordis 内核

插件系统的底座是 **Cordis** —— 与 DeepSeek Harness 同一个插件内核（v4.0.0-rc.12，
MIT，vendored 进仓库，见 `src/renderer/vendor/cordis.mjs`，58 KB 单文件、运行期零依赖）。

核不再自己实现「插件树 / 副作用回收 / 服务注册」，这三件事全部交给它：

| 能力 | 由谁提供 |
| --- | --- |
| 插件挂载/卸载、fiber 生命周期 | Cordis |
| 可逆副作用（`ctx.effect`） | Cordis |
| 服务注册与解析（`ctx.tabs` 等） | Cordis |
| 依赖注入（`ctx.inject`） | Cordis |
| 清单校验、权限网关 | 核 |
| `nucleus://` 协议、IPC、窗口与标签镜像 | 核 |
| 安装/卸载/启停、设置表单生成 | 核 |

**两棵树，一座桥。** 主进程和渲染层各有一个 Cordis 根上下文，
插件分别挂在 `root` 和 `uiRoot` 下面：

```
主进程                    ┌─────────────┐
 root: Context  ──────────│  IPC / RPC  │──────────┐
   ├─ tabs / settings …   └─────────────┘          │
   ├─ feature.adblock  (fiber)                     │
   └─ feature.settings (fiber)                     │
                                    ┌──────────────┴──────────┐
渲染层                               │  uiRoot: Context        │
                                    │   ├─ tabs / commands …  │
                                    │   ├─ ui.shell   (fiber) │
                                    │   └─ theme.nucleus      │
                                    └─────────────────────────┘
```

这是 Cordis 本来的形态，不是妥协：Cordis 的上下文是进程内对象，服务没法跨 IPC，
所以 DSH 也是 Host / Client 各一棵树、中间用自研 RPC 桥接。

**插件拿到的 `ctx` 就是它自己的 Cordis 上下文**，只多了一道权限闸：

```js
ctx.effect(fn, label)      // 直达 Cordis fiber
ctx.inject(['adblock'], cb)// 服务就绪时执行，离开时自动撤销
ctx.fiber                  // 拿到 fiber 本身
ctx.tabs.list()            // 先查 manifest.permissions，再返回能力
```

`ctx.tabs.on` / `bus.on` / `commands.register` / `network.*` / `pages.handle` /
`protocol.register` / `downloads.on` / `settings.onChange` 这些注册类调用的 disposer
会自动记进 fiber，插件不必自己保存。

实测（内置广告拦截插件，禁用再启用）：

```
启用 → 5 条副作用
禁用 → 0 条，status: idle
再启用 → 仍是 5 条（不是 10 条）
```

> 这条链路修掉了一个真实缺陷：早期版本里 `activate()` 返回的 `{ deactivate }`
> 被宿主丢掉了，广告拦截的 `setInterval` 从来没有被清理过 ——
> 每「禁用再启用」一次就多一个定时器在后台跑。

**重新打包 Cordis**：`npm run vendor`（esbuild，target es2020，产物入库）。
升级 Cordis 只需重跑这一条命令，其余代码不用动。

### 5.6 槽位（Slot）

界面不再是一堆「区域容器 + appendChild」，而是一棵**可嵌套的命名空位树**。
语义对齐 DeepSeek Harness 的 client slots，只是把 React 换成了 DOM。

```
root
└─ region.nav-center            ← 核声明：这里有一块导航区
   └─ shell.omnibox.actions      ← ui.shell 声明：地址栏内部还有一处空位
      └─ bookmarks:star          ← feature.bookmarks 注册：星标按钮
```

四条不变量：

1. 每个空位有且只有一个 owner，只有 owner 能渲染它
2. 注册必须落在已声明的空位上，否则拒绝并记账（自省页可见）
3. 注册者必须在 manifest 的 `contributes.slots` 里静态声明过，或获得 owner 的策略放行
4. 撤销是递归的：父空位折叠 → 子空位折叠 → 它们的注册全部移除

四种 cardinality，对应四种组合方式：

| 类型 | 语义 | 用在哪 |
| --- | --- | --- |
| `list` | 全部渲染，按 `order` 排序 | 工具栏、状态栏、地址栏动作位 |
| `single` | 只有一个赢家，`priority` 小者胜 | 侧边栏、根容器 |
| `keyed` | owner 派发 key，匹配的那条渲染 | 按工具名渲染不同的卡片 |
| `chain` | 每条给一个 `select(owner)`，第一个非 null 的胜出 | 可插拔的渲染策略 |

**条件渲染**是条目自己的事，不是 owner 的事：

```js
nucleus.slots.register({
  name: 'shell.omnibox.actions',
  id: 'bookmarks:star',
  order: 10,
  when: (p) => !!p.tab && /^https?:/i.test(p.tab.url || ''),
  render: () => starBtn,
});
```

**插件不必猜对方加载了没有**：`slots.inject()` 会在空位出现时执行回调，
owner 卸载时自动撤销，重新挂载时再执行一次。广告拦截的状态栏条目就是这么注册的 ——
即便 `ui.shell` 比它晚加载，也不会丢。

**槽位权限**有两层：manifest 的 `contributes.slots` 是静态契约（安装前就能看出
这个插件会改哪里），空位声明的 `policy` 是 owner 的运行时否决权
（`restricted` + `allow` 名单 + `permission`）。

**生命周期不漏账**：容器（`outlet` / `adopt`）与条目一样登记进 fiber ——
插件卸载后，注册表不会再往一个已脱离文档的元素里绘制。缓存键是
`插件id::条目id`，两个插件恰好用同一个条目 id 也不会互相覆盖。
健康检查还能扫出来自「已不存在插件」的孤儿条目，并一键清掉。

### 5.7 类型化 RPC

核与渲染层之间的每条通道都可以声明参数与返回值的形状：

```js
'nucleus:tabs:capture': {
  params: T.object({ pluginId: ID, tabId: T.string({ min: 1, max: 40 }) }),
  result: T.string(),
  description: '截取标签页可见区域，返回 PNG data URL',
  permission: 'tabs',
}
```

- 进入处理器**之前**校验参数，返回**之前**校验结果，失败给出字段路径（`$.tabId 应为字符串`）
- 每条通道记录调用数、失败数、平均耗时、最近一次错误
- 自省页展示覆盖率：**32 条通道里 31 条已声明（97%）**，没声明的照常工作但标为 `untyped`

刻意不做类型转换：传错类型就是错，不猜。

### 5.8 配置层（profile / patch）

一个运行中的 Nucleus 是几层配置叠加出来的插件树：

```
profiles/default.yml            产品默认形态
profiles/<name>.yml             本次选择的 profile
<userData>/nucleus.patch.yml    用户最后一层覆盖
```

合并规则刻意简单：`plugins.enable` / `disable` 都是并集，同一插件同时出现时 enable 胜；
`settings` 后层覆盖前层；`force` 里的键启动时强制写回。

设置项的优先级是 **force > settings.json 已有值 > profile 默认值** ——
你在界面上改过的设置，不会被下次启动的配置文件悄悄回滚。

```bash
Nucleus.exe --list-profiles
Nucleus.exe --profile=minimal
Nucleus.exe --profile=minimal --dump-config
```

内置四个 profile：`desktop`（完整）、`minimal`（只有界面 + 设置）、
`kiosk`（演示）、`default`（其余 profile 的底座）。
实测 `--profile=minimal` 后禁用 17 个插件，快捷键从 37 条降到 18 条。

### 5.9 浏览器扩展

支持的是 **Chrome 扩展的一个可用子集**，不是完整兼容：

| 支持 | 不支持（管理页会逐项标出） |
| --- | --- |
| content_scripts（JS / CSS / matches） | MV3 `background.service_worker` |
| action.popup、options_page / options_ui | declarativeNetRequest / webRequest 阻塞 |
| background.page / background.scripts（MV2） | nativeMessaging、chrome.debugger |
| runtime / storage.local / tabs 的子集 | content script 接收 runtime 消息 |
| 消息路由（sendMessage + onMessage 回应） | chrome.scripting、chrome.i18n 完整语义 |

两条注入路径，身份校验方式不同：

```
内容脚本（isolated world）   postMessage → web-preload → IPC
                            身份靠一次性 token（绑定 webContents id）
扩展页面（popup/background）  preload 直接暴露 __nucleusChrome
                            身份靠 sender 的 URL（nucleus://ext-<id>/…）
```

`chrome` 不能直接用 `contextBridge` 覆盖 —— Chromium 在每个页面都内置了一个只读的
`window.chrome`。做法是暴露成 `__nucleusChrome`，再由协议层往扩展页面的 `<head>`
注入一条合并脚本。

实测（`test-extensions/hello`）：

```
内容脚本注入   badge=true，text="扩展已注入 · hello-nucleus"，storage 回调 stored=1
存储落盘       extension-data/hello-nucleus.json 写入 lastVisit
popup          chrome.runtime.id = "hello-nucleus"
消息路由       popup → 后台页 → {"from":"background","echo":{"hello":"nucleus"}}
```

### 5.10 内核加固（v3.1）

「一切皆插件」有个容易被忽略的代价：插件的权限边界就是浏览器的安全边界。
v3.1 把这条边界从「约定」往下压了一层，同时修掉了几处 Cordis 集成期留下的隐患。

#### 插件模块沙箱

之前插件主进程入口走 Node 默认 `require`，一行 `require('child_process')` 就能绕过
整个 `ctx` 权限网关 —— 网关再严也只是建议。现在插件模块由 `plugin-sandbox.js` 手动编译：

| 层 | 做法 |
| --- | --- |
| 模块解析 | 相对路径必须落在插件目录内；npm 包不解析（插件自包含） |
| 内置模块 | 白名单：`path/url/util/events/crypto/buffer/stream/...` |
| 第三方插件 | `electron`、`child_process`、`worker_threads`、`net/http`、`vm` 一律拒绝；`fs` 只给只读 |
| 内置插件 | 宽一档（可用可写 `fs`），但同样出不了进程 |
| 全局遮蔽 | `process` 换成只读视图，`global/globalThis` 换成白名单代理（拿得到 `setTimeout`，拿不到 `require`） |
| 静态扫描 | 拒绝 `import()`、`Function()`、`eval()`、`process.binding`、构造器链 |

实测（`NUCLEUS_VERIFY=1`）：

```
require("child_process")        → EPERM_SANDBOX  child_process（插件应当通过 ctx 与核交互）
require("../../etc/passwd")     → EPERM_SANDBOX  试图加载插件目录之外的文件
普通模块（path、process 视图）   → 正常加载，typeof process === "object"
```

> 诚实标注：这是**能力最小化**，不是真正沙箱。同一进程内没有隔离边界，
> 恶意代码仍可借原型链、异常栈等旁路折腾。它防的是「装错插件顺手把系统交出去」。

#### 一次性桥

壳页面与插件在同一个 JS 世界里。如果 `window.nucleusBridge` 一直挂着，
任何插件都能绕过 `nucleus.invoke`（以及它的 `pluginId` 归属）直接发 IPC。
现在 preload 只暴露一个**只能成功一次**的取件口：

```js
// app.js 引导阶段取走，之后加载的插件拿不到
const bridge = window.__nucleusTakeBridge();
```

实测：插件执行期 `typeof window.nucleusBridge === "undefined"`，
再次调用取件口抛错（`bridgeReopen: denied`）。

#### 权限收紧

| 通道 | 之前 | 现在 |
| --- | --- | --- |
| `plugins:enable/disable/uninstall/install/reload` | 任意插件 | 需要 `plugins` 权限 |
| `state:get/set`（全局 JsonStore） | 任意插件读写任意键 | 需要 `plugins`，且只能读写 `plugin:<自己>:*` |
| `bus:emit` | 任意事件名 | 事件名必须带自己的命名空间（`adblock:stats` 这类短名也接受） |

实测：一个只有 `storage/commands/settings` 权限的插件调用 `plugins:disable`
被拒（`pluginEscalation: denied`）。

#### Cordis 生命周期修复

| 问题 | 症状 | 处理 |
| --- | --- | --- |
| `activate` 超时定时器没清 | 每次激活留一个 8 秒悬挂定时器 | `finally` 里 `clearTimeout` |
| 激活失败只改状态 | 半截注册残留（服务/命令/拦截器） | 失败即 `fiber.dispose()` + 清 owner 表 |
| `ctx` 是 Proxy，`then` 落到 Cordis | `await ctx` 永久挂起，插件「无声消失」 | 挡掉 `then/catch/constructor/__proto__` 等 |
| 渲染层失败 fiber 没回收 | 空位声明与条目残留 | `catch` 里 `fiber.dispose()` |
| 渲染层 `tabs.on / bus.on / outlet` 未记账 | 禁用插件后回调还在跑 | 全部走 `cordisCtx.effect` 记账 |
| 槽位缓存按 `entry.id` | 两个插件同 id 互相顶掉 | 缓存键改为 `pluginId::id` |
| 子空位递归无去重 | 深树重复绘制 | `visited` 集合 |
| 运行期 reload / install 并发 | 扫描清掉正在激活的记录 | 串行队列 |
| Cordis 未 inject 的属性访问抛错 | 插件读一个属性就整体失败 | 兜底 `try/catch`，按「不存在」处理 |

#### 内核健康检查

自省页新增第六个视图「内核健康」，把不变量写成可运行的检查项：

| 检查 | 判定依据 |
| --- | --- |
| 插件状态 | `enabled` 与 `status` 是否自洽，失败原因（是否被沙箱拦截） |
| 副作用账本 | 已禁用插件的 fiber 上不应还有 effect；卸载前后的账本快照 |
| 槽位组合 | 条目来源是否仍是启用插件、有无「有条目没容器」的空位、策略拒绝 |
| Cordis 服务 | 核服务是否齐全 |
| RPC 通道 | 契约覆盖率、失败次数与最近错误 |
| 资源占用 | RSS / Heap / 活动句柄数 |

「回收泄漏 / 清理孤儿槽位」只做两件明确安全的事：强制释放已禁用插件残留的 fiber、
通知界面按存活插件重绘。启动后也会自动跑一次，把结果写进日志。

实测输出：

```
自检通过：0 错误 / 0 警告 / 24 条副作用 / 20 个插件已激活
健康视图：6 项检查 · 20/20 激活 · 10 个空位点 · 0 个孤儿 · RPC 覆盖率 100%
```

#### 新增功能

| 插件 | 能力 | 实现要点 |
| --- | --- | --- |
| `feature.tabsleep` | 后台标签休眠 | 标签服务新增 `suspend/resume/suspendIdle`：摘掉 webview 释放渲染进程，激活时按原地址重建；固定标签、内建页面、加载中、当前标签豁免 |
| `feature.notes` | 侧边便签 | 复用侧边栏容器，输入 400ms 防抖落盘，关窗前强制写盘 |
| `feature.shortcuts` | 快捷键速查 | 直接读命令注册表，插件新增命令自动出现 |
| `feature.privacy` | 隐私清理 | 缓存与站点数据分开确认，不碰书签/历史/下载 |

---

## 六、插件开发

### 6.1 最小插件

目录结构：

```
my-plugin/
├── manifest.json
├── main.js      (可选：主进程逻辑)
└── ui.js        (可选：浏览器界面逻辑)
```

`manifest.json`：

```json
{
  "id": "my.hello",
  "name": "你好插件",
  "version": "1.0.0",
  "author": "你的名字",
  "description": "在工具栏加一个按钮，点了弹提示。",
  "ui": "ui.js",
  "permissions": ["commands"],
  "contributes": {
    "commands": [
      { "id": "hello.say", "title": "打个招呼", "icon": "zap", "keybinding": "Ctrl+Shift+H" }
    ],
    "toolbar": [
      { "id": "hello.btn", "region": "nav-right", "icon": "zap", "title": "打招呼", "command": "hello.say", "order": 50 }
    ]
  }
}
```

`ui.js`：

```js
export async function activate(nucleus) {
  nucleus.commands.register('hello.say', {
    title: '打个招呼',
    icon: 'zap',
    keybinding: 'Ctrl+Shift+H',
    handler: () => nucleus.ui.toast('你好，世界'),
  });
}
```

把目录丢进 `%APPDATA%\Nucleus\plugins\`，或用「设置 → 插件管理 → 从文件夹安装」，
重启即可生效。

### 6.2 manifest 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✓ | 小写字母/数字/点/连字符，全局唯一 |
| `name` | ✓ | 显示名 |
| `version` | ✓ | 语义化版本 |
| `description` / `author` / `homepage` | | 展示信息 |
| `main` | | 主进程入口（CommonJS，导出 `activate(ctx)` / `deactivate()`） |
| `ui` | | 浏览器界面入口（ES Module，导出 `activate(nucleus)`） |
| `styles` | | 随界面一起注入的样式表（相对路径数组），核负责注入并等待加载 |
| `contributes.slots` | | 声明「本插件会向哪些空位注册」。槽位权限的第一层，未声明会在注册时被拒 |
| `permissions` | | 能力声明，见上文 |
| `contributes` | | 贡献点 |

### 6.3 主进程 API（`ctx`）

```js
module.exports = {
  async activate(ctx) {
    ctx.log.info('启动');

    // 标签页（主进程侧操作镜像 + RPC 下发）
    ctx.tabs.list();
    await ctx.tabs.create({ url: 'https://example.com' });

    // 设置（manifest 里 contributes.settings 声明过的 key）
    const enabled = ctx.settings.get('enabled', true);
    ctx.settings.onChange('enabled', (v) => ctx.log.info('变了', v));

    // 插件私有存储（独立 JSON 文件，互相不可见）
    ctx.storage.set('count', 1);

    // 网络拦截（多插件共享一条 webRequest 通道，互不覆盖）
    ctx.network.onBeforeRequest((details) => {
      if (details.url.includes('/track')) return { cancel: true };
      return null;
    });

    // 内部页面 RPC（给插件自己的 nucleus:// 页面调用）
    ctx.pages.handle('ping', () => 'pong');

    // 可逆副作用：fn 立即执行，返回的清理函数在 fiber 卸载时逆序调用
    ctx.effect(() => {
      const timer = setInterval(tick, 1000);
      return () => clearInterval(timer);
    }, 'stats ticker');

    // 依赖注入：等 adblock 这个服务出现再跑，对方卸载后自动撤销并重新等待
    ctx.inject(['adblock'], (c) => c.adblock.stats());

    // Cordis 的进程内事件（与跨进程的 ctx.bus 互补）
    ctx.on('some-service/ready', () => {});

    // 插件管理（需 plugins 权限，仅元插件使用）
    ctx.plugins.list();
  },
};
```

`ctx` 就是该插件自己的 **Cordis 上下文**，只是多了一道权限闸。因此 Cordis 原生能力
（`effect` `inject` `on` `once` `emit` `fiber`）都在，核另加了：

`tabs` `window` `storage` `settings` `bus`（跨进程）`commands` `network` `session`
`protocol` `downloads` `notifications` `shell` `pages` `plugins` `dialog` `log`。

其中 `tabs.on` `window.on` `bus.on` `commands.register` `network.*` `pages.handle`
这些「注册类」调用，返回的 disposer 会自动记进 fiber —— 你**不需要**手动保存它们，
插件卸载时 Cordis 会逆序回收。自己开的定时器、文件监听、子进程，则用 `ctx.effect()` 交出来。

### 6.4 渲染层 API（`nucleus`）

```js
export async function activate(nucleus) {
  // 区域：往核的 6 个容器里放东西
  nucleus.regions.mount('nav-right', myButton);

  // 标签页（本地直连 TabsService，无 IPC 开销）
  const tab = nucleus.tabs.active();
  nucleus.tabs.create({ url: 'https://example.com' });
  nucleus.tabs.on('updated', (t) => console.log(t.title));

  // 命令
  nucleus.commands.register('x.y', { title: 'X', handler: () => {} });
  await nucleus.commands.execute('other.plugin.command');   // 调用别人的命令

  // 侧边栏
  nucleus.sidebar.show('my.plugin', panelEl, { side: 'left', width: 300 });

  // UI 原子层
  nucleus.ui.toast('已保存');
  nucleus.ui.modal({ title: '标题', body: el, actions: [...] });
  nucleus.ui.menu([{ label: '复制', onClick() {} }], { x, y });
  nucleus.ui.palette({ commands });

  // 存储与设置
  await nucleus.storage.load();
  nucleus.storage.set('key', value);

  // 事件总线（跨插件、跨进程）
  nucleus.bus.on('some-event', handler);
  nucleus.bus.emit('some-event', payload);

  // 可逆副作用：界面插件也挂在 Cordis 上，账本已经就位
  nucleus.effect(() => {
    const ro = new ResizeObserver(onResize);
    return () => ro.disconnect();
  }, 'layout');

  // Cordis 依赖注入 / 进程内事件
  nucleus.inject(['commands'], (c) => c.commands.execute('x.y'));
  nucleus.on('some-local-event', handler);
}
```

`nucleus` 与主进程的 `ctx` 同构：都是该插件自己的 Cordis 上下文（渲染层这棵树的 fiber），
区别是渲染层不做权限校验 —— 能力的权限在主进程那侧最终裁决。

**插件之间的调用只走两件事：命令（同步请求-响应）与总线（广播）**，不共享内部状态。

### 6.5 内部页面与 RPC

插件可以带自己的页面（`nucleus://<pluginId>/index.html`），通过 RPC 与主进程通信：

```js
// 页面里
const data = await window.__nucleus.rpc('my-method', { foo: 1 });
```

```js
// main.js 里
ctx.pages.handle('my-method', (payload) => ({ echo: payload.foo }));
```

只有 `nucleus://` 页面能调用这条通道，普通网站会被主进程拒绝。

### 6.6 内容脚本

```json
"contributes": {
  "contentScripts": [
    { "matches": ["https://example.com/*"], "js": "inject.js", "css": "inject.css", "runAt": "document_idle" }
  ]
}
```

脚本在**隔离世界**中执行：能操作 DOM，但拿不到页面自己的 JS 变量。
这也意味着它不会污染页面、不会被页面的 CSP 拦。

### 6.7 主题

界面完全由 CSS 变量驱动。写一个主题插件只需要在 `activate` 里改一组变量：

```js
const THEME = {
  '--bg': '#0b0d10', '--bg-chrome': '#111419', '--text': '#e8ebf1',
  '--accent': '#ff7a45', /* … */
};
```

`nucleus://feature.settings` 页面与新标签页通过 `<html data-theme>` 取色，
切换主题时核会向所有内部页面广播 `nucleus:theme`。

---

## 七、快捷键

| 快捷键 | 功能 | 提供者 |
| --- | --- | --- |
| `Ctrl+T` / `Ctrl+W` / `Ctrl+Shift+T` | 新建 / 关闭 / 恢复标签 | ui.shell |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 切换标签 | ui.shell |
| `Ctrl+L` | 聚焦地址栏 | ui.shell |
| `Alt+←` / `Alt+→` | 后退 / 前进 | ui.shell |
| `F5` / `Ctrl+Shift+R` | 刷新 / 硬刷新 | ui.shell |
| `Ctrl+D` | 收藏 | feature.bookmarks |
| `Ctrl+H` | 历史记录 | feature.history |
| `Ctrl+J` | 下载 | feature.downloads |
| `Ctrl+F` / `F3` | 查找 | feature.find |
| `Ctrl+K` / `Ctrl+Shift+P` | 命令面板 | feature.palette |
| `Ctrl+,` | 设置 | feature.settings |
| `F12` / `Ctrl+U` | 开发者工具 / 查看源码 | feature.devtools |
| `Ctrl+Alt+R` | 阅读模式 | feature.reader |
| `Ctrl+Shift+S` | 截图 | feature.screenshot |
| `Ctrl+Shift+L` | 深/浅色切换 | theme.nucleus |
| `Ctrl+Alt+I` | 运行时自省 | feature.inspector |
| `Ctrl+Shift+E` | 管理浏览器扩展 | feature.extensions |
| `Ctrl+Shift+N` | 侧边便签 | feature.notes |
| `Ctrl+Shift+Del` | 隐私清理 | feature.privacy |
| `F1` | 快捷键速查 | feature.shortcuts |
| `F11` | 切换全屏 | ui.window |

快捷键在主进程用 `before-input-event` 匹配，所以焦点在网页里时同样有效。

---

## 八、Windows 7 兼容性

针对 Win7 做了这些具体处理：

1. **内核锁定** Chromium 108（Electron 22.3.27），这是最后支持 Win7 的版本。
2. **不使用 `color-mix()`**（Chrome 111+），全部改用显式颜色变量。
3. **不使用 `backdrop-filter`**，Win7 的 D3D 合成下它会让整窗掉帧。
4. **不设置 `nativeTheme.themeSource`**：那会全局改写 `prefers-color-scheme`，
   导致没有声明 `color-scheme` 的老网页出现「白底白字」。主题只通过 `data-theme` 传递给内部页面。
5. **无边框窗口保留 `thickFrame`**，Win7 Aero 下仍可拖拽边缘缩放、支持 Aero Snap。
   若个别机器异常，可在「设置 → 通用」关掉「无边距自绘窗口」，重启后回到系统标题栏。
6. **提供 `--nucleus-gpu-off`**，老显卡出现花屏或黑块时关闭硬件加速。
7. 界面字体回退链以 `Segoe UI` / `Microsoft YaHei` 开头，Win7 自带。

---

## 九、已知限制

- **主进程侧插件**禁用时，Cordis 会回收经 `ctx` 登记的全部副作用；但模块自己的顶层状态
  （模块作用域变量、`require` 缓存）无法抹除，要「回到出厂状态」仍需重启。
- Cordis 版本锁在 `4.0.0-rc.12`（vendored）。升级需重跑 `npm run vendor`，
  rc 阶段 API 可能变化，升级后要跑一遍冒烟自检。
- **槽位**：界面插件的槽位注册只在启动时挂载，运行中禁用 `ui.shell` 需重载界面才看得到效果。
- **扩展**：只到「常见小扩展能跑」的程度。MV3 Service Worker 没有宿主，网络请求拦截、
  nativeMessaging、content script 接收消息都不支持；这些会在扩展管理页逐项标出，
  而不是让用户装完才发现按钮没反应。扩展代码是第三方代码，请只安装可信来源。
- **界面插件**只在启动时挂载。禁用 `ui.shell` 后要看到效果，需执行命令面板里的
  「重新加载浏览器界面」（`Ctrl+K` 搜「重载」）或重启；不支持运行中热替换。
- 广告拦截是内置规则表（约 80 个域名 + 路径模式），**不是** EasyList 订阅式过滤。
- 不支持多窗口、扩展商店、账号同步、PDF 内置阅读器。
- 权限模型是**能力最小化**，不是安全沙箱：主进程侧插件现在拿不到 `electron /
  child_process / 可写 fs`，渲染层插件拿不到裸 IPC，但同一进程内没有真正的隔离。
  请只安装可信来源的插件。
- 未做代码签名，首次运行时 SmartScreen 可能提示「未知发布者」，选择「更多信息 → 仍要运行」。

---

## 十、构建

```bash
# 开发运行（Linux/macOS 需要图形环境；Windows 直接 npm start）
npm install
npm start

# 重新打包 Cordis（升级 cordis 版本后才需要跑）
npm run vendor

# 打 Windows 包（在 Linux 上交叉构建，不需要 wine）
npm run pack:win
```

产物在 `dist/Nucleus-win32-x64/`，`build/pack-win.js` 会用 `resedit` 直接改写 PE 资源
写入图标与版本信息，全程不依赖 wine。Electron 运行时从 npmmirror 拉取并缓存到 `.cache/`。

**为什么发布 `resources/app` 目录而不是 `app.asar`**：Cordis 是 ESM，
Node 的 ESM 解析器不认 asar 虚拟路径，`import('file://…/app.asar/…')` 会直接失败。
代价是多几十个文件，换来的是用户能直接读到源码。

---

## 十一、窗口与界面的边界

窗口与界面各自归谁、为什么这样切、还有哪些没插件化 —— 见 [`docs/WINDOW-UI.md`](docs/WINDOW-UI.md)。

---

## 十二、目录结构

```
nucleus/
├── src/
│   ├── main/                   主进程（核）
│   │   ├── main.js             启动与装配
│   │   ├── core/
│   │   │   ├── plugin-host.js      插件生命周期
│   │   │   ├── plugin-manifest.js  清单校验
│   │   │   ├── kernel.js           Cordis 装配（服务容器）
│   │   │   ├── slots 相关在渲染层  src/renderer/lib/slots.js
│   │   │   ├── typert.js           类型化 RPC 校验器
│   │   │   ├── channels.js         通道契约表（唯一事实来源）
│   │   │   ├── config.js           配置层叠加
│   │   │   ├── mini-yaml.js        零依赖 YAML 子集
│   │   │   ├── extensions.js       浏览器扩展服务
│   │   │   ├── ext-shim.js         扩展 API 垫片（两种宿主）
│   │   │   ├── plugin-context.js   ctx 工厂（Cordis 上下文 + 权限闸）
│   │   │   ├── plugin-sandbox.js   插件模块加载器（受限 require）
│   │   │   ├── doctor.js           内核健康检查与安全回收
│   │   │   ├── protocol.js         nucleus:// 服务
│   │   │   ├── tabs.js             标签镜像 + RPC
│   │   │   ├── shortcuts.js        快捷键匹配
│   │   │   ├── intercept.js        多插件网络拦截总线
│   │   │   ├── ipc.js              IPC 路由 + 权限校验
│   │   │   ├── window.js           窗口
│   │   │   ├── services.js         命令/下载/通知/会话
│   │   │   ├── bus.js              事件总线
│   │   │   ├── store.js            原子 JSON 存储
│   │   │   └── paths.js            路径与越界检查
│   │   ├── dev/                    开发脚本（截图 / 冒烟 / 加固验证）
│   │   └── preload/
│   │       ├── chrome-preload.js   浏览器 UI 桥（窄接口）
│   │       └── web-preload.js      网页侧：内容脚本 + 页面 RPC
│   ├── renderer/               浏览器外壳
│   │   ├── index.html / app.js
│   │   ├── lib/                tabs / commands / sidebar / ui / icons / nucleus
│   │   ├── vendor/cordis.mjs   Cordis v4（esbuild 打包，零依赖）
│   │   └── styles/             base（骨架）/ chrome（公共原子）/ widgets
│   └── plugins/                21 个内置插件
├── docs/WINDOW-UI.md          窗口与界面的归属分析
├── profiles/                   配置层：default / desktop / minimal / kiosk
├── test-extensions/hello/      验证用的最小 Chrome 扩展
└── build/                      打包脚本与图标
```

---

## 十三、许可

MIT License，见 `LICENSE`。

内置图标为项目自绘 SVG，无第三方素材依赖。
