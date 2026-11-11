# dsh-subagent-agy 设置页 UI 集成方案（settings.section + ctx.configForms）

> 目标：把本插件（`dsh-subagent-agy`）的全部运行时设置做成 DSH Web GUI「设置 → Antigravity」里的一页可编辑表单，读写走浏览器端 `ctx.configForms`，与现有两个 Gemini 面板（`main` / `sidebar.panellist`）互不影响。
>
> 读者：implementer（task-6）。文中接口签名、注册形态、字段映射、状态语义都按「可照着写」粒度给出。
>
> 边界：本文件只做方案，**不改代码**。实现写入范围以 task-6 为准（`lib/client.js`、`package.json`、`lib/types/index.d.ts`、`test/settings-ui.test.js`；必要时按第 10 节单独说明后动 `lib/index.js`）。

---

## 0. 结论速览

| 项 | 结论 |
|---|---|
| 扩展点 | slot `settings.section`（kind `list`，scope `root`），注册一页顶级导航「Antigravity」 |
| 页面 id / order / label | `id: 'subagent-antigravity'`、`order: 50`、`label: () => 'Antigravity'` |
| 数据命名空间 / entry id | `subagent-antigravity`（= `cordis.patch.yml` 里的 insert `id`） |
| 读写服务 | `ctx.configForms.get('subagent-antigravity')` → `ConfigForm`（`getSnapshot/subscribe/set/unset/mutate`） |
| 服务获取方式 | **可选注入**：`ctx.inject(['configForms'], cb)`；**不要**把 `configForms` 放进 `exports.inject`（否则缺该服务的部署会连 Gemini 面板一起挂掉，见 §3.2） |
| 包声明 | `package.json > dsh.client.inject` 追加 `"@deepseek-ai/dsh-client-ui-settings"`（只影响 bundle 装载顺序，不强制服务存在） |
| locale | 不引入。中文硬编码，文案集中在 `LABELS` 常量里，后续要 i18n 再加 `@deepseek-ai/dsh-client-locale`（见 §3.6） |
| 写入模型 | 即时生效：标量/枚举/布尔/数字「失焦或变更即 set」，数组/env「失焦解析后 set」，恢复默认「unset」 |
| revision 冲突 | 交给 `ConfigForm`：不传 `expectedRevision` 时它用最新已知 revision 排队；Host 拒绝会自动 recovery 重载，`set/unset` 返回 `false` |
| 组件技术 | lazy-CJS + `react.createElement`（无 JSX、无打包器、不新增运行时依赖），自建极简 store 走 `hooks` 注入 |

---

## 1. 事实核对（与 Lead 调研的差异说明）

Lead 给出的 5 条 API 事实基本成立，本方案全部沿用。**一处需要澄清**：

- Lead 说「Config 共 36 个字段」，但 `lib/index.js` 的 `Config = z.object({...})` 实际是 **35 个**字段（task 描述和 task-6 里逐一列举的也是 35 个）。本方案按 **35 个**落表，并把 35 个全部覆盖。若坚持「36」，唯一能凑数的只有 `lib/index.js` `start()` 里读取的 `promptPrefix`——但它**不在 `Config` schema 里**，只由 `apply()` 内部给 `antigravity-team` provider 注入 `NATIVE_TEAM_DIRECTIVE`，不是用户可配置项，**不应**出现在设置页。
- 本机实测：`node --version` = v26.13.0；`node --check lib/client.js` 通过；`node --test --test-isolation=none` = **87 passed / 0 fail**（这是回归基线，见 §9）。

其余 API 事实复述并补齐精确签名：

- `ConfigFormSnapshot<T>`：`{ status: 'loading' | 'ready' | 'unavailable'; value: T | undefined; base: unknown; user: unknown; revision: number | undefined; writable: boolean }`。
- `ConfigForm<T>.set(field, value)` 等价于 `mutate([{ op:'set', path:[field], value }])`；`unset(field)` 等价于 `mutate([{ op:'unset', path:[field] }])`。因此**顶层数组/字典字段**（`extraArgs` / `addDirs` / `acpExtraArgs` / `env`）可以直接 `set(field, 整个新值)`，不需要逐元素 `mutate`。
- `mutate` 的 `ops` 是 `SettingsPathOp[]`：`{ op:'set', path: string[], value } | { op:'unset', path: string[] }`，内部 `structuredClone`。
- `whileServed(namespaces, register)`：当 Host 的 describe mirror 里出现其中任一 namespace 时调用一次 `register(servedSet)`，其返回的 disposer 在所有 namespace 都消失或被外层 disposer 触发时执行。调用方负责把返回的 disposer 包进 `ctx.effect`。
- 参考实现：`@deepseek-ai/dsh-client-ui-settings-shell/lib/client.js` 与本页最像（`settings.section` 之外的 `plugins.item` 版），`@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js` 是 `settings.section` 注册的最短范本，`@deepseek-ai/dsh-client-ui-settings-subagent/lib/client.js` 是「一个 namespace 一套表单」的控制器范本。

---

## 2. 涉及文件与职责

| 文件 | 本次是否改 | 职责 |
|---|---|---|
| `lib/client.js` | 改 | 新增 `AntigravitySettingsSection` 组件 + 极简表单控制器；`apply()` 里追加可选注入注册；保留现有 `main`/`sidebar.panellist` 注册不动 |
| `package.json` | 改 | `dsh.client.inject` 追加 `@deepseek-ai/dsh-client-ui-settings` |
| `lib/types/index.d.ts` | 一般不改 | `Config` 不新增字段、`client` 不进 host 类型；只有新增导出符号时才动。**没有就明确不改** |
| `test/settings-ui.test.js` | 新增 | 覆盖字段表/解析/序列化纯函数（见 §8） |
| `lib/index.js` | 默认不改 | 只有「自动生成页与自定义页重复」实测成立时，才按 §10.3 加 `settings.configure({ auto:false })` |

> 注意 `package.json > files` 白名单只收 `lib/*.js`（顶层，不含子目录）+ `lib/types/**/*.d.ts`。**不要**把新模块放 `lib/` 子目录，否则装进 profile 会缺失（详见仓库 AGENTS.md）。

---

## 3. 页面注册方案

### 3.1 注册形态（settings.section）

```js
// client.js，factory 内部
var SETTINGS_NS = 'subagent-antigravity';   // 与 cordis.patch.yml 的 insert id 一致
var SECTION_ID  = 'subagent-antigravity';   // settings.section 的导航 key（见 §3.7 冲突备注）
var SECTION_ORDER = 50;

ctx.slots.inject('settings.section', function () {
  return ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: SECTION_ORDER,
    label: function () { return 'Antigravity'; },
    inject: function () { return controller.inject(); }
  }, AntigravitySettingsSection);
});
```

- `order: 50`：现有 section 的 order 为 `general=0`、`plugins=15`、`web-search=20`、`agent-loop=30`、`session-log=90`，取 50 不冲突且排在常用项之后。
- `label` 用函数返回常量字符串（`resolveSlotLabel` 支持函数或字符串）；不写 `locale`，因此组件**拿不到 `t` prop**，文案需硬编码（见 §3.6 / §7.5）。
- 不声明 `children`：本页所有字段都在同一个 section 内渲染，不使用子 slot，因此组件**拿不到 `renderSlot`**。

### 3.2 inject 决策（关键：避免连带搞挂 Gemini 面板）

DSH 客户端插件有两层「注入」，含义不同，必须分开处理：

1. **`lib/client.js` 的 `exports.inject`（cordis 服务依赖，控制 `apply` 何时执行）**
   - 现有值 `['slots']`。**保持不动**。
   - **绝对不要**改成 `['slots','configForms']`：cordis 的 `inject` 是**必需**依赖，一旦某部署没有 `configForms` 服务（未 compose `dsh-client-ui-settings`），整个 `apply` 不执行 → 连现有的两个 Gemini 面板都不再注册。这是最容易被实现者踩的坑。
   - 需要 configForms 时用**可选注入**，只在服务存在时才跑：
     ```js
     ctx.inject(['configForms'], function (settingsCtx) {
       var form = settingsCtx.configForms.get(SETTINGS_NS);
       var controller = createSettingsController(form);
       settingsCtx.effect(function () { return function () { controller.dispose(); }; }, 'subagent-agy: settings form subscription');
       settingsCtx.effect(function () {
         return settingsCtx.configForms.whileServed([SETTINGS_NS], function () {
           return settingsCtx.slots.inject('settings.section', function () {
             return settingsCtx.slots.register({ /* 见 §3.1 */ }, AntigravitySettingsSection);
           });
         });
       }, 'subagent-agy: settings page');
     });
     ```
   - 这样：没有 settings 服务的部署 → 回调不执行 → Gemini 面板照常；有服务的部署 → 追加一个设置页。

2. **`package.json > dsh.client.inject`（客户端 bundle 装载顺序，不算 cordis 依赖）**
   - 现为 `["@deepseek-ai/dsh-client-ui-slots"]`，追加 `"@deepseek-ai/dsh-client-ui-settings"`。
   - 该字段由 `@deepseek-ai/dsh-client-modules` 读取：对本包列出的每个包名，若它在 boot graph 里存在就先 `materialize` 它再 materialize 本包（`graphRows.get(packageName)` 未命中则静默跳过）。所以它**不会**强制服务存在，只是保证 `dsh-client-ui-settings` 的 bundle（提供 `ctx.configForms`）先于本插件装载。
   - 不需要 locale，故**不**追加 `@deepseek-ai/dsh-client-locale`。

### 3.3 whileServed 用法

- `whileServed([SETTINGS_NS], register)` 语义：`subagent-antigravity` 这个 namespace 出现在 describe mirror 后才注册页面；namespace 消失（插件被移除/未 compose）则自动注销页面。这正是「部署里没这个插件就不显示这页」的正确姿势，和第一方 `settings-shell` / `settings-subagent` 一致。
- `form = ctx.configForms.get(SETTINGS_NS)` 可以在 `whileServed` 之外、`apply` 时立即创建：`get` 返回的 form 在首个 Host 视图到达前 `status` 是 `'loading'`，`whileServed` 只负责「页面何时出现」，两者解耦。控制器订阅 form 的 `subscribe`，页面出现时已是 `ready`（否则组件按 §7 处理 loading/unavailable）。
- `whileServed` 的 disposer 与控制器 `dispose` 都要 `ctx.effect` 包裹，保证热重载/卸载时清理。

### 3.4 与现有 main / sidebar.panellist 共存

- 现有 `apply()` 先 `ensureStyles()` 再 push 四个 `ctx.slots.inject` disposer（`main` × 2、`sidebar.panellist` × 2），返回统一 disposer。**保持这段逻辑与 PANEL_ID/ICON 不变**。
- 新增的设置页只是**再追加**一段 `ctx.inject(['configForms'], …)`。`settings.section` 与 `main` / `sidebar.panellist` 是不同 slot，互不占用；`main` 用 `key`、`sidebar.panellist` 用 `id`，与 `settings.section` 的 `id` 命名空间彼此独立。
- CSS：复用现有 `ensureStyles()` + `STYLE_ID` 机制，新增样式合并进同一个 `CSS` 数组（同一 `<style data-plugin-css>` 标签），不要另起标签。
- 组件命名与导出：新增 `exports.__settingsSection = AntigravitySettingsSection`（供 §8 的测试与调试），保留现有 `__panel/__icon/__chatPanel/__chatIcon`。

### 3.5 autoGenerate（自动生成页）澄清

`dsh-settings` 的 descriptor 有 `autoGenerate`（默认 `true`：instance 没注册自定义页时可由通用编辑器生成一页）。第一方插件在**自带自定义页**时用 host 端 `settings.configure({ auto: false })` 关掉自动页（见 `dsh-agent-default-model`）。本页是自定义页，理论上 autoGenerate 不应再生成重复页。**先按纯客户端方式实现并手工验证**；若「设置」里出现两个 Antigravity/`subagent-antigravity` 入口，再按 §10.3 加 host 端一行关闭（属 `lib/index.js` 的受控小改，需在 PR 说明）。

### 3.6 文案 / 是否引入 locale

- **不引入 locale**：现有两个面板就是中文硬编码；设置页再引 `@deepseek-ai/dsh-client-locale` 会多一个 bundle 依赖与 `t` prop 约定，收益低。所有中文文案集中在 `LABELS` 常量对象里（字段 label/hint、分组标题、状态文案），后续要 i18n 时把 `LABELS` 换成 `t()` 即可。
- 专有名词（`agy`、`stream-json`、`acp`、模型 id、路径）保留英文原样。
- 若将来加 locale：registration 加 `locale: NS`、`exports.inject` 追加 `'locale'`、`package.json dsh.client.inject` 追加 `@deepseek-ai/dsh-client-locale`，组件改用 `props.t`。本方案不要求。

### 3.7 id 冲突备注

`SECTION_ID` 用的是 `subagent-antigravity`（Lead 在 task-6 指定）。它是 section 的**导航 key**，不是 namespace；唯一风险是「若通用编辑器按 `ns` 生成了同名 section」，会出现两个同名入口。规避手段二选一：把 section `id` 改成 `'antigravity'`（推荐备选，短且与 ns 解耦），或 §10.3 关自动生成。手工验证时留意即可。

---

## 4. 字段 → 控件映射表（35 字段，全部覆盖）

分组顺序（与 task-6 一致）：**基础 → 传输与 ACP → Gemini 网页 → 团队与并发 → 高级**。

列含义：**控件**（text/select/checkbox/number/textarea/key-value/array）、**选项/格式**、**默认值**（指 schema 默认或 `apply()` 解析后的有效默认）、**恢复默认**（所有字段都可 `unset` 回落到默认/未设置，故统一「可」，仅说明 unset 后的语义）。

### 4.1 基础（basic）

| 字段 | 中文标签 | 控件 | 选项 / 格式 | 默认值 | 恢复默认后 | 备注 |
|---|---|---|---|---|---|---|
| `providerName` | 提供商名称 | text | 非空字符串 | `antigravity` | 回落 `antigravity` | 改名一般无意义，可置灰/加提示 |
| `executable` | agy 可执行文件 | text | 绝对路径 | `%USERPROFILE%\.gemini\bin\agy.exe` | 回落该路径 | 改错会在 `start()` 时报「CLI not found」 |
| `model` | 模型 | text | 模型 id | `gemini-3.8-flash-medium` | 回落该值 | 也可给静态候选 select（可选增强） |
| `effort` | 思考强度 | select | 空(`未设置`)/`low`/`medium`/`high`/`xhigh`/`max` | 未设置（CLI 默认） | unset=未设置 | `transport=acp` 时被忽略（加提示） |
| `permissionMode` | 权限模式 | select | `dangerously-skip-permissions`/`auto` | `dangerously-skip-permissions` | 回落该值 | 加风险提示：`auto` 在 print 模式工具确认被软拒 |
| `transport` | 传输方式 | select | `stream-json`/`acp` | `stream-json` | 回落 `stream-json` | 切换后刷新 ACP/高级组提示 |

### 4.2 传输与 ACP（acp）

| 字段 | 中文标签 | 控件 | 选项 / 格式 | 默认值 | 恢复默认后 | 备注 |
|---|---|---|---|---|---|---|
| `acpProtocolVersion` | ACP 协议版本 | number | 整数 ≥1 | `1` | 回落 1 | |
| `acpRequestTimeoutMs` | ACP 握手超时(ms) | number | 整数 ≥1000 | `30000` | 回落 30000 | |
| `acpPromptTimeoutMs` | ACP 单轮超时(ms) | number | 整数 ≥0（0=不限） | `0` | 回落 0 | |
| `acpPermissionPolicy` | ACP 权限策略 | select | `auto-approve`/`first-allow`/`reject`/`manual` | `auto-approve` | 回落 `auto-approve` | 注：`permissionMode=dangerously-skip-permissions` 时 host 强制 `auto-approve` |
| `acpFallbackToStreamJson` | ACP 失败回退 | checkbox | true/false | `true` | 回落 true | |
| `acpExtraArgs` | ACP 额外参数 | array(textarea，按行) | 每行一个 argv | `[]` | unset=未设置 | 只在 `agy acp` 之后追加 |

### 4.3 Gemini 网页（gemini）

| 字段 | 中文标签 | 控件 | 选项 / 格式 | 默认值 | 恢复默认后 | 备注 |
|---|---|---|---|---|---|---|
| `geminiProfileDir` | 浏览器 profile 目录 | text | 路径 | `~/.dsh/gemini-web-research/browser-profile` | 回落该目录 | schema 本身无 default，实际默认来自 `apply()` |
| `geminiPython` | Python 可执行文件 | text | 命令名/路径 | `python` | 回落 `python` | |
| `geminiHeadless` | 无头运行 | checkbox | true/false | `true` | 回落 true | 登录初始化始终 headed，与此无关 |
| `geminiTimeoutMs` | 调研任务超时(ms) | number | 整数 >0 | `900000` | 回落 900000 | |
| `geminiChatTimeoutMs` | 对话超时(ms) | number | 整数 ≥1000 | `180000` | 回落 180000 | |
| `geminiWorkerIdleMs` | worker 空闲回收(ms) | number | 整数 ≥0 | `600000` | 回落 600000 | |
| `geminiWorkerMode` | worker 模式 | select | `persistent`/`oneshot` | `persistent` | 回落 `persistent` | oneshot 下 research 不接受模型/思考参数 |
| `geminiDefaultModel` | 默认模型 | text | 空=无偏好 | `''` | unset=未设置 | 占位提示 `flash`/`flash-lite`/`pro`/`argon` |
| `geminiDefaultThinking` | 默认思考等级 | text | 空/`low`/`medium`/`high` | `''` | unset=未设置 | |

### 4.4 团队与并发（team）

| 字段 | 中文标签 | 控件 | 选项 / 格式 | 默认值 | 恢复默认后 | 备注 |
|---|---|---|---|---|---|---|
| `teamProviderName` | 团队 provider 名 | text | 非空字符串 | `antigravity-team` | 回落该值 | 必须 ≠ `providerName`，否则 apply 抛错（见 §10） |
| `teamEnabled` | 启用团队 provider | checkbox | true/false | `true` | 回落 true | 关闭后不注册 `antigravity-team` |
| `parallelToolName` | 并发工具名 | text | 非空字符串 | `subagent_agy_parallel` | 回落该值 | 模型可见的工具名 |
| `parallelMaxTasks` | 并发上限 | number | 整数 1..8 | `8` | 回落 8 | schema `max(8)` |

### 4.5 高级（advanced）

| 字段 | 中文标签 | 控件 | 选项 / 格式 | 默认值 | 恢复默认后 | 备注 |
|---|---|---|---|---|---|---|
| `env` | 环境变量 | key-value(textarea，`KEY=VALUE` 每行) | 见 §5.4 | `{}` | unset=未设置 | 叠加在 SCRUBBED_ENV 之上 |
| `extraArgs` | 额外 CLI 参数 | array(textarea，按行) | 每行一个 argv | `[]` | unset=未设置 | |
| `addDirs` | 附加工作目录 | array(textarea，按行) | 每行一个路径 | 未设置 | unset=未设置 | ACP 下映射 additionalDirectories（best-effort） |
| `newProject` | 每次新建项目 | checkbox | true/false | `false` | 回落 false | ACP 下被忽略 |
| `projectName` | 项目名 | text | 字符串 | `''` | 回落 `''` | 优先级高于 `newProject`；ACP 下被忽略 |
| `printTimeout` | 打印超时 | text | Go duration 如 `180s`/`10m` | 未设置 | unset=未设置 | ACP 下被忽略（改用 `acpPromptTimeoutMs`） |
| `jsonSchema` | 结果 JSON Schema | textarea | 内联 JSON 或文件路径 | 未设置 | unset=未设置 | ACP 下被忽略 |
| `fallbackModel` | 备用模型 | text | 模型 id，空=禁用 | 未设置 | unset=未设置 | 只有显式设置才触发一次重试 |
| `retryOnRateLimit` | 限流重试一次 | checkbox | true/false | `false` | 回落 false | 默认关闭，勿默认开启 |
| `disposeGraceMs` | 进程回收宽限(ms) | number | 整数 >0，且 ≤ `MAX_TIMER_DELAY_MS` | `3000` | 回落 3000 | apply 会 `assertPositiveFinite` 并校验上限 |

> 合计 6 + 6 + 9 + 4 + 10 = **35**，与 `Config` 字段一一对应，无遗漏无臆造。

---

## 5. 读写语义

### 5.1 读取与渲染值

- 永远从 `form.getSnapshot()` 取，不缓存过期值。展示值用 `snapshot.value?.[field]`（`value` 是 schema 默认→composition base→user 层解析后的**有效值**，所以默认值天然可见）。
- 「是否被覆盖」用 `snapshot.user`：**字段在 `user` 对象里存在**即视为用户已覆盖（哪怕值恰好等于默认值），据此显示「已覆盖 / 恢复默认」按钮。不要用 `value === default` 判断。
- `base` 是 unset 后回落的合成层，可用于提示「默认值来自部署」，但**不要**用它判断覆盖。

### 5.2 何时 set / unset

- 标量/枚举/布尔：控件变更即 `form.set(field, value)`。
- 文本/数字/数组/env：用本地草稿（component state）+ **失焦或回车**再 `form.set`，避免每次击键写盘；草稿与 `snapshot.value` 在外部变更（他人写入 / 恢复默认）时需同步（见 §6.4）。
- **恢复默认**：`form.unset(field)`。对所有字段都成立；对无 schema 默认的字段（`effort`/`printTimeout`/`jsonSchema`/`addDirs`/`fallbackModel`）unset 后即「未设置」，UI 显示空。
- **空串语义**：对 `min(1)` 的字符串字段（`providerName`/`executable`/`model`/`acp...`无/`geminiPython`/`teamProviderName`/`parallelToolName` 等），清空输入 = `unset`（不要 `set('')`，会被 schema 拒绝）。
- **数字空值**：空输入 = `unset`（回落默认）；**绝不**写入 `NaN`/`null`。非法（非整数、越界）时**不写**，显示行内错误（见 §5.5）。
- **多字段原子写**：本页不需要，天然一字段一写。如未来要「一次提交多个」，用 `form.mutate([...ops], expectedRevision)`（`expectedRevision` 取开始编辑时的 `snapshot.revision`）。

### 5.3 revision 冲突（交给 ConfigForm）

- `set/unset/mutate` 不传 `expectedRevision` 时，`ConfigForm` 用「最新已知 revision（pendingRevision 或镜像 revision）」排队，每次写天然带最新 revision。
- 若显式传 `expectedRevision`（开始编辑时的 revision），Host 在 revision 已前进时拒绝 → `mutate` 内部 `recover()` 重新 `load()` 镜像 → 返回 `false`。
- 因此本页**不需要**自己算 revision：只要检查 `set/unset` 返回的布尔值：
  - `true` → 已接受（镜像会被 fold，`subscribe` 触发重渲染）。
  - `false` → Host 拒绝/跳过，`ConfigForm` 已把镜像刷新到最新；UI 显示一行「本次修改未被接受，已刷新为最新值」（同时草稿以新 `snapshot.value` 重置）。
  - `Promise` reject → 传输层失败（网络/服务不可用），显示错误文案并保留草稿供重试。
- **不要**在组件里自己维护 revision 或 undo 栈。

### 5.4 数组与 env 的编辑

内存表示统一为「文本草稿 ⇄ 结构化值」：

- `extraArgs` / `addDirs` / `acpExtraArgs`（`string[]`）：
  - 展示：`value.join('\n')`（每行一项；空数组显示空）。
  - 解析（`parseListText(text)`）：按 `\n` 切行 → `trim()` → 丢弃空行 → 得到 `string[]`。**不做**逗号切分（路径可能含逗号/空格）。
  - 非法情况：无（任何非空行都是合法 argv/路径）；只需去空。
- `env`（`Record<string,string>`）：
  - 展示：`Object.keys(value).sort()` → `KEY=VALUE` 每行。
  - 解析（`parseEnvText(text)`）：按 `\n` 切行 → 跳过空行与 `#` 开头行 → 每行按**第一个** `=` 切分为 key/value（value 可含 `=`）→ key `trim()`，value 不 trim（保留原样，仅去行尾 `\r`）。
  - 非法：行非空且不含 `=`，或 key 为空 → 视为该行错误；整次不写，显示「第 N 行缺少 '=' 或 key 为空」。
  - 空文本 = `unset('env')`（或 `set('env', {})`，二者等效，建议 `unset` 更干净）。
- 写入时机：失焦时解析+写；解析失败保留草稿并标错，不打断用户输入。

### 5.5 写入中 / 失败 / 只读 / unavailable 的状态展示

控制器维护 `pending`（在飞写入计数）与 `error`（最近一次失败的字段+原因），投影进 store：

| snapshot 状态 | UI |
|---|---|
| `status === 'loading'` | 整页显示骨架/「正在读取配置…」占位；禁用所有输入 |
| `status === 'unavailable'` | 显示「该配置未由当前 Host 提供」（正常不会出现，因 `whileServed` 已挡；仍要兜底） |
| `status === 'ready' && writable === false` | 顶部横幅「本部署的设置为只读」；所有输入 `disabled`；不显示「恢复默认」 |
| `status === 'ready' && writable === true` | 正常可编辑；若有 `pending > 0` 在对应行显示「保存中…」并轻量禁用该行 |
| 写失败（返回 false 或 reject） | 顶部/行内错误条：「本次修改未生效：<原因>」；保留可编辑 |
| 该字段在 `user` 里存在 | 行尾显示「已覆盖 · 恢复默认」按钮 |

---

## 6. 组件结构（React.createElement，无 JSX、无打包器）

### 6.1 极简 store（替代 `@deepseek-ai/dsh-client-store` 的 `createSnapshotStore`）

本插件不能 `require('@deepseek-ai/dsh-client-store')`（未在依赖/注入里），也不需要。自建一个满足 renderer `observableHook` 契约的对象即可——renderer 对每个 `hooks[name]` 用 `source.subscribe(fn)` + `source.getSnapshot()` 包成 `use<Name>(selector)`（见 `dsh-client-ui-renderer` 的 `observableHook`）。所以 store 只需 `{ getSnapshot, subscribe }`：

```js
function createSettingsController(form) {
  var state = project();                 // 见 §6.2
  var listeners = new Set();
  var pending = 0;
  var error = '';

  function notify() { listeners.forEach(function (fn) { fn(); }); }

  function project() {
    var s = form.getSnapshot();
    return {
      status: s.status,
      writable: s.writable,
      values: s.value || {},
      user: s.user || {},
      pending: pending,
      error: error
    };
  }

  var unsubscribe = form.subscribe(function () { state = project(); notify(); });

  function commit(fn) {
    pending += 1; error = ''; state = project(); notify();
    var p = fn();
    p.then(function (ok) {
      pending -= 1;
      if (ok === false) { error = '本次修改未被接受，已刷新为最新值'; }
      state = project(); notify();
    }, function (err) {
      pending -= 1;
      error = '保存失败：' + (err && err.message ? err.message : String(err));
      state = project(); notify();
    });
  }

  return {
    store: {
      getSnapshot: function () { return state; },
      subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; }
    },
    inject: function () {
      return {
        hooks: { antigravitySettings: this.store },
        editField: function (field, value) { commit(function () { return form.set(field, value); }); },
        resetField: function (field) { commit(function () { return form.unset(field); }); }
      };
    },
    dispose: function () { unsubscribe(); listeners.clear(); }
  };
}
```

> 也可以用 `React.useSyncExternalStore` 自行订阅；但走 `hooks` 约定更贴近第一方、且 renderer 已处理选择器缓存。**两种都不新增依赖**，推荐 `hooks`。

### 6.2 组件层级与 props 形状

```
AntigravitySettingsSection(props)
├─ 读 props.useAntigravitySettings(s => s)         // → { status, writable, values, user, pending, error }
├─ 顶部状态条（loading / unavailable / 只读 / 全局 error）
├─ GroupSection(title)  × 5（basic/acp/gemini/team/advanced）
│   └─ FieldRow(field)  × N
│       ├─ 标签 + hint + 「已覆盖·恢复默认」
│       └─ 受控控件（Text/Number/Select/Checkbox/Textarea/KeyValue/List）
└─ 无保存按钮（即时生效）
```

**props 形状（由 slot renderer 生成）**：

| prop | 来源 | 说明 |
|---|---|---|
| `useAntigravitySettings` | `inject().hooks.antigravitySettings` | `use<Capitalized(name)>`，签名 `(selector) => selected`，本项目用 `s => s` 全量 |
| `editField(field, value)` | `inject()` 普通 prop | 触发 `form.set` 包装 |
| `resetField(field)` | `inject()` 普通 prop | 触发 `form.unset` |
| `close` | slot owner props（`settings.section` 的 `{ close }`） | 本页用不到，可不接收 |
| `t` | **不提供**（未声明 `locale`） | 文案用内置 `LABELS` |

**行组件（FieldRow）的受控输入 props（建议统一形状）**：

```js
// 纯展示 + 回调，全部受控，无副作用
FieldRow({
  field,            // 字段名
  label, hint,      // 文案
  control,          // 'text' | 'number' | 'select' | 'checkbox' | 'textarea' | 'keyvalue' | 'list'
  options,          // select 用 [{ value, label }]
  value,            // 当前有效值（来自 values[field]）
  overridden,       // user 里是否存在该字段
  disabled,         // 来自 !writable || pending>0
  invalid,          // 本地解析错误文案（空则合法）
  onCommit(value),  // 合法时提交（内部 editField）
  onReset()         // 恢复默认（unset）
})
```

- 文本/数字/数组/env 行内部用 `React.useState` 存草稿，`React.useEffect` 在 `value` 外部变化且「非编辑中」时同步草稿（见 §6.4）。
- `select`/`checkbox` 无需草稿，直接 `onChange` → `onCommit`。
- `keyvalue`/`list` 用 `textarea`：`onChange` 更新草稿，`onBlur` 解析 → 合法则 `onCommit`，非法则 set 本地 `invalid`。
- `number` 用 `input type="number"`，`step` 视字段（协议版本/上限为 1，ms 为 1），`min`/`max` 也按 §4 设置；解析见 §7.3。

### 6.3 全部用 `react.createElement`（`h`）

文件里已有 `var h = react.createElement;`。示例（一行）：

```js
function FieldRow(props) {
  var id = 'antigravity-field-' + props.field;
  return h('div', { className: 'das-row' },
    h('div', { className: 'das-rowHead' },
      h('label', { className: 'das-label', htmlFor: id }, props.label),
      props.overridden ? h('button', {
        type: 'button', className: 'das-reset',
        onClick: props.onReset, disabled: props.disabled
      }, '恢复默认') : null
    ),
    renderControl(props),
    props.hint ? h('div', { className: 'das-hint' }, props.hint) : null,
    props.invalid ? h('div', { className: 'das-invalid' }, props.invalid) : null
  );
}
```

不要引入 `react/jsx-runtime`（本包原有代码也不用；`require` 只有 `react` 保证可用）。

### 6.4 渲染驱动

- `subscribe` → `notify` → `hooks` 的 `useSyncExternalStoreWithSelector` 让组件按 selector 快照重渲染。全量 `s => s` 即可（字段很多，但一次设置页渲染开销可接受）。
- 外部写入（Host 侧改动、他人恢复默认）导致 `snapshot.value` 变化时：文本类行若**不在聚焦/编辑中**，用 `useEffect` 把草稿重置为新值；**在编辑中**则保留用户草稿，避免打断输入。
- `pending > 0` 时对**该行**轻量禁用并显示「保存中…」；全局 `pending` 不作为整页 loading（允许连续编辑不同字段，`ConfigForm` 内部已串行排队）。

---

## 7. 健壮性

### 7.1 configForms 缺失
- 用 `ctx.inject(['configForms'], cb)` 可选注入（§3.2），服务缺失时 `cb` 不执行，**不抛错、不影响 Gemini 面板**。
- 额外防御：进入 `cb` 后再判 `typeof settingsCtx.configForms.get === 'function'`，否则直接 return。

### 7.2 status = unavailable / value undefined
- `unavailable`：渲染「该配置未由当前 Host 提供」的整页提示，不渲染字段。
- `loading` 或 `value === undefined`：渲染占位，不渲染字段（避免读到 undefined 崩）。
- 一律用可选链式取值：`var v = (state.values && state.values[field]);`，缺省按类型给空（string→`''`、bool→`false`、number→`''`、array→`[]`、object→`{}`），**只在渲染层补默认，不回写**。

### 7.3 数字字段空值 / 非法
- `parseNumberField(text, { min, max, integer })`：`text.trim()===''` → `{ kind:'unset' }`；`Number(text)` 非有限 → `{ kind:'invalid', reason:'请输入数字' }`；`integer && !Number.isSafeInteger` → invalid；`< min`/`> max` → invalid（附范围）；否则 `{ kind:'set', value }`。**永不返回 NaN**。
- 提交端：`invalid` 不写；`unset` 走 `resetField`。

### 7.4 数组 / env 解析失败
- 解析函数返回 `{ ok:true, value } | { ok:false, line, reason }`；失败时只显示行内错误、保留草稿、不写盘。见 §5.4。

### 7.5 文案策略
- 中文为主，集中 `LABELS`；专有名词保英文。状态文案：`loading/unavailable/readOnly/saving/saveFailed/reset/overridden` 六类必须齐（参考 `settings-shell` 的 `formLabels` 语义）。
- 危险项（`permissionMode`、`retryOnRateLimit`、`teamProviderName`）加一行 hint 说明后果。

### 7.6 布局与主题
- 使用 `var(--dsw-alias-*)` 主题变量（现有 CSS 已这样用），不要硬编码颜色。
- 容器 `max-width:760px`，分组用 `section` + `h3`，行用 flex 两列（label 左、控件右），窄屏（`@media (max-width:700px)`）单列堆叠。
- 无障碍：`label[htmlFor]` 绑定输入 `id`；错误用 `aria-invalid`；分组 `aria-labelledby`。

---

## 8. 可测试性设计（node 下能测纯逻辑）

`lib/client.js` 是 lazy-CJS（顶层 `window.__ModuleLoader__.load(...)`），不能像 ESM 模块那样被普通 `import` 到测试里；但它**可以**在测试里用「假 window + 假 react」物化后取导出。两种做法任选，推荐 **A（零复制）**：

**A. 物化工厂 + 复用导出（推荐，无代码重复）**
- 在 `client.js` 工厂内把纯函数挂到导出：`exports.__settings = { FIELDS, GROUPS, parseNumberField, parseListText, parseEnvText, serializeEnv, serializeList, projectFieldDefaults, LABELS }`。
- `test/settings-ui.test.js`：
  ```js
  import test from 'node:test';
  import assert from 'node:assert/strict';

  test('settings field table', async () => {
    let decl = null;
    globalThis.window = { __ModuleLoader__: { load: (d) => { decl = d; } } };
    await import('../lib/client.js');            // 触发 window.* 注册，捕获 decl
    const fakeReact = {
      createElement: () => null,
      useState: () => [undefined, () => {}],
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useSyncExternalStore: () => undefined
    };
    const mod = decl.factory((spec) => { if (spec === 'react') return fakeReact; throw new Error('unexpected require ' + spec); });
    const { FIELDS, GROUPS, parseNumberField, parseListText, parseEnvText } = mod.__settings;
    // 断言 35 个字段、5 个分组、每组字段齐全、默认值正确、解析边界
  });
  ```
- 好处：测的就是运行时代码本身，永不漂移。注意：**不要**在测试里调用 `apply`（`ensureStyles` 会碰 `document`）；只物化工厂取 `__settings`。

**B. 抽独立 ESM `lib/settings-fields.js` + client.js 复制一份**
- 更直观但会复制逻辑，有漂移风险；若采用，必须加一条「读 `lib/client.js` 源文本断言字段名/默认值都在」的守卫测试。**除非 A 遇到障碍，否则不用 B。**

> 仅测纯函数：字段默认值、分组归属、`parseNumberField`（空/NaN/越界/合法）、`parseListText`（多行/空行/含空格）、`parseEnvText`（含 `=` 的 value/空行/`#` 注释/缺 `=` 报错）、序列化 round-trip。**不测** React 渲染。

---

## 9. 验证计划

### 9.1 语法与单测（必须全绿，无回归）
```powershell
node --check lib/client.js
node --check lib/index.js           # 若改了 index.js 才需要
node --test --test-isolation=none   # 基线 87 passed；改完应 ≥ 87 + 新增用例，0 fail
```
> 沙箱里若 `node --test` 报 spawn EPERM，用 `--test-isolation=none`（本机已实测可用）。记录改动前/后的 `tests/pass/fail` 数字。

### 9.2 profile 部署
```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm install        # profile 的 node_modules 是指向本仓库的硬链接；新增文件必须 install，沙箱挡就换真实终端
# 重启 DSH GUI
```

### 9.3 手工验证步骤
1. 打开「设置」→ 左侧导航出现「**Antigravity**」（order 50，位于 General/Plugins 之后）。
2. 首次进入：应显示 5 个分组、35 个字段，默认值可见（`model=gemini-3.8-flash-medium`、`transport=stream-json`、`parallelMaxTasks=8` 等）。
3. 改一个标量（如 `model` 改成其它值）→ 失焦 → 该行短暂「保存中…」→ 再打开确认值保留。
4. 改一个数组（`addDirs` 两行）与 `env`（`FOO=bar` 一行）→ 失焦 → 重进页面确认回显一致；故意写一行 `BADLINE`（无 `=`）→ 出现行内错误且**未**写盘。
5. 数字字段填非法值（如 `parallelMaxTasks=99`）→ 行内报错、不写；清空 → 该字段回到默认（「已覆盖」标记消失）。
6. 点某项「恢复默认」→ 该字段回落到默认值，「已覆盖」消失。
7. 打开 profile 的设置文档（`settings.prepareDocument()` 指向的文件，或 profile 目录下被编辑的 patch/设置文档）确认写入的键值出现；观察 GUI 是否**热重载**该插件（面板/工具仍可用）。
8. 验证**不回归**：两个 Gemini 面板（「Gemini 调研」「Gemini 对话」）仍能打开、`subagent_agy` / `subagent_agy_team` / `subagent_agy_parallel` 工具仍在。
9. 只读场景（若可模拟）：把 profile 设为只读 → 页面横幅「只读」、输入全禁用。

### 9.4 记录
- 若第 1 步出现**两个**「Antigravity/`subagent-antigravity`」入口 → 按 §10.3 处理后再验。
- 把上述截图/结果贴 PR。

---

## 10. 风险与回退

### 10.1 写入即热重载插件
- `applies: 'live'`：每次写生效都会让 Host 重新应用该 entry 的 Config，插件 fiber 可能被重建 → **正在跑的 Gemini 任务/worker 可能被中断**，设置页本身也可能短暂重挂载。
- 缓解：控制器 `dispose` 与 `whileServed` 都要 `ctx.effect` 清理；`apply` 幂等（重复执行不残留 slot/监听）；提示用户「修改 Gemini 运行参数会重启其 worker，正在进行的任务会中断」。**测试配置时避免在跑任务**。
- 因为每字段即时写，连续编辑多字段会触发多次重载；可接受（设置不是高频操作），必要时对文本类用「失焦写」降低频率（本方案已如此）。

### 10.2 误改导致插件启动失败
- 高风险项：
  - `teamProviderName === providerName` → `apply()` 直接 `throw new Error('teamProviderName must differ from providerName')` → 插件加载失败。
  - `disposeGraceMs <= 0` 或 `> MAX_TIMER_DELAY_MS` → `assertPositiveFinite` / 上限校验抛错。
  - `executable` 指向不存在文件 → 不致命（`start()` 才检查），但每次委派都会失败。
- **恢复方式**（按顺序）：
  1. 打开 profile 设置文档（`settings.prepareDocument()` 返回值 / profile 目录下被写入的文件），删掉出错字段的键，保存；
  2. 或直接编辑 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 里 `- id: subagent-antigravity` 的 `config:`（若配置落在该 patch）；
  3. 重启 GUI。
  > 具体落盘文件名以实际为准：先用 `settings.prepareDocument()`/设置页「查看文档」定位，不要凭猜测乱删文件。
- UI 侧预防：`teamProviderName` 行加 hint「必须不同于 providerName」；`disposeGraceMs` 输入给 `min=1`；保存前本地做同名校验，冲突时**不写**并提示。

### 10.3 是否需要 host 端改动
- 正常情况下**不需要**：纯客户端 `settings.section` + `ctx.configForms` 即可读写并持久化（`applies: live`）。
- 唯一可能需要的小改：若手工验证发现「自动生成页」与本页重复（§3.5），在 `lib/index.js` 的 `apply()` 里加可选注入关闭：
  ```js
  // lib/index.js apply() 内（只关自动生成页，不影响其它）
  ctx.inject(['settings'], function (child) {
    child.effect(function () {
      return child.settings.configure({ auto: false }, ctx.fiber);
    }, 'subagent-agy: disable auto-generated settings page');
  });
  ```
  这是 `lib/index.js` 的受控改动，属 task-6 的「确有必要才改」范畴，需在 PR 说明。若未出现重复页，**不要加**。

### 10.4 其它
- `requestPermission`/ACP 相关字段只在 `transport=acp` 生效，UI 用 hint 标注「仅 ACP 生效」，避免用户误以为无效。
- `env` 里若写 `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `GEMINI_CLI` / `ANTIGRAVITY_SESSION_ID`：会被 `start()` 用空串覆盖（`SCRUBBED_ENV`），在 hint 里提示这几个键会被忽略。

---

## 11. 给 implementer 的落地清单（照着做）

1. `package.json > dsh.client.inject` 追加 `"@deepseek-ai/dsh-client-ui-settings"`（保留 `@deepseek-ai/dsh-client-ui-slots`）。
2. `lib/client.js`：
   - 顶部常量：`SETTINGS_NS='subagent-antigravity'`、`SECTION_ID='subagent-antigravity'`、`SECTION_ORDER=50`、`LABELS`、`FIELDS`（35 项，见 §4）、`GROUPS`（5 组）。
   - 新增纯函数：`parseNumberField` / `parseListText` / `parseEnvText` / `serializeList` / `serializeEnv`（并挂到 `exports.__settings`）。
   - 新增 `createSettingsController(form)`（§6.1）。
   - 新增 `AntigravitySettingsSection` + `GroupSection` + `FieldRow` + 各控件渲染（全部 `h(...)`）。
   - `apply()` 末尾追加 `ctx.inject(['configForms'], cb)`，`cb` 内建控制器 + `whileServed` + `settings.section` 注册（§3.2/§3.3），全部包 `ctx.effect`。
   - 保持现有 `exports.inject = ['slots']` 与四个面板注册不变；新增 `exports.__settingsSection`、`exports.__settings`。
   - CSS 合并进现有 `CSS` 数组（`das-*` 前缀）。
3. `lib/types/index.d.ts`：**确认无需改**（无新 Config 字段/无新 host 导出）。若真加了导出符号再手工同步。
4. `test/settings-ui.test.js`：按 §8-A 物化工厂，断言字段表/分组/默认值/解析边界；确保 `node --test` 0 fail 且总数 ≥ 87+新增。
5. 跑 §9 全部验证，记录数字与手工步骤结果。
6. 未出现重复页则**不改** `lib/index.js`；出现才按 §10.3 处理并在 PR 说明。
