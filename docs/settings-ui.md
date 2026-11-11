# dsh-subagent-agy 图形化设置页（Settings → Antigravity）

> 交付文档。把本插件的全部运行时配置从「只能改 profile YAML」升级为 DSH Web GUI「设置 → Antigravity」里的一页可编辑表单。
>
> 事实以当前分支 `settings-ui` 的代码为准（`lib/client.js`、`package.json`、`test/settings-ui.test.js`）。方案见 [settings-ui-design.md](./settings-ui-design.md)，审核记录见 [settings-ui-review.md](./settings-ui-review.md)。

---

## 1. 背景与目标

### 1.1 背景

此前本插件（`dsh-subagent-agy`）的所有运行时参数（provider 名、`agy` 路径、模型、传输方式、ACP 超时、Gemini 浏览器 profile、团队/并发、环境变量等）只能通过手工编辑 profile 的 `cordis.patch.yml`（`- id: subagent-antigravity` 的 `config:`）来修改，用户看不到字段清单、默认值，也容易写错。

### 1.2 目标

在 DSH 的「设置」界面里提供一页完整的表单：

- **集中**：一页列出全部 35 个可配置字段，按 5 组归类，默认值可见。
- **可编辑**：修改即时写入 profile 配置并触发热重载，无需手改 YAML。
- **安全**：缺 `configForms` 服务的部署不受影响（Gemini 面板照常）；空值/非法值不落盘、不写 `NaN`；未修改不写盘，避免无谓热重载。
- **不回归**：现有两个 Gemini 面板（「Gemini 调研」「Gemini 对话」）与三个工具（`subagent_agy` / `subagent_agy_team` / `subagent_agy_parallel`）行为不变。

---

## 2. 使用入口与分组

**入口**：DSH Web GUI →「设置（Settings）」→ 左侧导航「**Antigravity**」。

- 该导航项由 `settings.section` slot 注册，`id = 'subagent-antigravity'`、`order = 50`、`label = 'Antigravity'`（排在 General / Plugins / Web Search / Agent Loop 等之后）。
- 打开后是一页表单，**没有「保存」按钮**：每个控件在变更/失焦时即时写入。

**5 个分组**（顺序与实现一致）：

| # | 分组 id | 标题 | 说明 |
|---|---|---|---|
| 1 | `basic` | 基础 | Provider、`agy` 可执行文件、模型、思考强度、权限模式、传输方式。 |
| 2 | `acp` | 传输与 ACP | 仅 `transport = acp` 时生效的协议版本、握手/单轮超时、权限策略与回退。 |
| 3 | `gemini` | Gemini 网页 | 浏览器 profile 与各类超时；**修改运行参数会重启 worker，可能中断进行中的任务**。 |
| 4 | `team` | 团队与并发 | 团队 provider、是否启用、批量并发工具名与上限。 |
| 5 | `advanced` | 高级 | 环境变量、额外 CLI 参数、附加目录、重试、进程回收宽限等底层项。 |

> 读写服务：浏览器端 `ctx.configForms.get('subagent-antigravity')` 返回一个 `ConfigForm`，提供 `getSnapshot / subscribe / set / unset`。命名空间 `subagent-antigravity` 与 `cordis.patch.yml` 里的 insert `id` 一致。

---

## 3. 字段总表（35 个）

控件取值：`text` 单行文本、`textarea` 多行文本、`number` 数字、`select` 下拉、`checkbox` 勾选、`list` 按行文本（`string[]`）、`keyvalue` 按行 `KEY=VALUE`（`Record<string,string>`）。

> 所有字段的「恢复默认」按钮都走 `unset(field)`，回落到 schema/`apply()` 的默认值或「未设置」。

### 3.1 基础（basic，6 项）

| 字段 | 标签 | 控件 | 默认值 | 生效说明 |
|---|---|---|---|---|
| `providerName` | 提供商名称 | text | `antigravity` | 注册到 `ctx.subagents` 的 provider 名，须与 `cordis.patch.yml` 的绑定名一致；改名一般无实际意义。 |
| `executable` | agy 可执行文件 | text | `%USERPROFILE%\.gemini\bin\agy.exe` | `agy` 绝对路径；改错会在启动时报「CLI not found」。 |
| `model` | 模型 | select（下拉） | `gemini-3.8-flash` | 选项取自 `agy models` 的基础模型：`gemini-3.8-flash` / `gemini-4-argon` / `claude-opus-5-5` / `claude-sonnet-5-5` / `gpt-oss-120b`；显式值始终优先。 |
| `effort` | 思考强度 | select（下拉） | `medium` | 推理档位；选项随所选模型过滤（`low/medium/high`，`gpt-oss-120b` 仅 `medium`）。ACP 下会拼成模型名后缀（如 `gemini-3.8-flash-medium`）。 |
| `permissionMode` | 权限模式 | select | `dangerously-skip-permissions` | `auto` 在 print 模式下工具确认会被软拒，仅适合无需工具的 prompt。 |
| `transport` | 传输方式 | select | `stream-json` | `stream-json` / `acp`。切到 `acp` 后 ACP 组生效，`printTimeout` / `jsonSchema` 等失效。 |

### 3.2 传输与 ACP（acp，6 项）

| 字段 | 标签 | 控件 | 默认值 | 生效说明 |
|---|---|---|---|---|
| `acpProtocolVersion` | ACP 协议版本 | number（整数 ≥1） | `1` | `initialize` 请求的协议版本。 |
| `acpRequestTimeoutMs` | ACP 握手超时(ms) | number（整数 ≥1000） | `30000` | 握手/初始化阶段的超时。 |
| `acpPromptTimeoutMs` | ACP 单轮超时(ms，0=不限) | number（整数 ≥0） | `0` | 单轮 `session/prompt` 超时；`0` 表示不限，靠上层 abort。 |
| `acpPermissionPolicy` | ACP 权限策略 | select | `auto-approve` | `auto-approve/first-allow/reject/manual`；`permissionMode = dangerously-skip-permissions` 时 host 强制 `auto-approve`。 |
| `acpFallbackToStreamJson` | ACP 失败回退到 stream-json | checkbox | `true` | 握手失败时自动回退 `stream-json`。 |
| `acpExtraArgs` | ACP 额外参数 | list（每行一个 argv） | `[]` | 只在 `agy acp` 子命令之后追加。 |

### 3.3 Gemini 网页（gemini，9 项）

| 字段 | 标签 | 控件 | 默认值 | 生效说明 |
|---|---|---|---|---|
| `geminiProfileDir` | 浏览器 profile 目录 | text | **留空 = 默认**（`~/.dsh/gemini-web-research/browser-profile`，实际由 `apply()` 解析为绝对路径） | Playwright 专用 profile；**`~` 不做展开，请填绝对路径**；留空即用默认。 |
| `geminiPython` | Python 可执行文件 | text | `python` | Playwright 脚本使用的 Python。 |
| `geminiHeadless` | 无头运行浏览器 | checkbox | `true` | 初始化登录始终有头，与此无关。 |
| `geminiTimeoutMs` | 调研任务超时(ms) | number（整数 >0） | `900000` | 单次 Deep Research 硬超时。 |
| `geminiChatTimeoutMs` | 对话超时(ms) | number（整数 ≥1000） | `180000` | 单条普通对话超时。 |
| `geminiWorkerIdleMs` | worker 空闲回收(ms) | number（整数 ≥0） | `600000` | `0` 表示不自动回收。 |
| `geminiWorkerMode` | worker 模式 | select | `persistent` | `persistent` / `oneshot`；`oneshot` 下 research 不接受模型/思考参数。 |
| `geminiDefaultModel` | 默认模型 | text | `''`（空=无偏好） | 占位提示 `flash / flash-lite / pro / argon`。 |
| `geminiDefaultThinking` | 默认思考等级 | text | `''`（空=跟随网页） | `low / medium / high`。 |

> **注意**：修改本组任何运行参数（worker 模式、超时、profile、模型等）都会写入配置并触发热重载，从而**重启 Gemini worker、可能中断正在进行的任务**。测试时避免在跑任务。

### 3.4 团队与并发（team，4 项）

| 字段 | 标签 | 控件 | 默认值 | 生效说明 |
|---|---|---|---|---|
| `teamProviderName` | 团队 provider 名 | text | `antigravity-team` | **必须 ≠ `providerName`**，否则 `apply()` 抛错、插件加载失败（UI 已在提交前做本地同名校验）。 |
| `teamEnabled` | 启用团队 provider | checkbox | `true` | 关闭后不注册 `antigravity-team`。 |
| `parallelToolName` | 并发工具名 | text | `subagent_agy_parallel` | 模型可见的批量并发工具名。 |
| `parallelMaxTasks` | 并发上限 | number（整数 1..8） | `8` | schema `max(8)`。 |

### 3.5 高级（advanced，10 项）

| 字段 | 标签 | 控件 | 默认值 | 生效说明 |
|---|---|---|---|---|
| `env` | 环境变量 | keyvalue（每行 `KEY=VALUE`） | `{}` | 叠加在内置清理环境之上；`CLAUDECODE / CLAUDE_CODE_ENTRYPOINT / GEMINI_CLI / ANTIGRAVITY_SESSION_ID` 会被进程显式覆盖为**空串**，此处设置无效。 |
| `extraArgs` | 额外 CLI 参数 | list（每行一个 argv） | `[]` | 直接追加到命令行。 |
| `addDirs` | 附加工作目录 | list（每行一个路径） | `[]`（未设置） | stream-json 下映射 `--add-dir`；ACP 下映射 `session/new.additionalDirectories`（best-effort）。 |
| `newProject` | 每次新建项目 | checkbox | `false` | **ACP 下被忽略**。 |
| `projectName` | 项目名 | text | `''` | 非空时固定复用同一项目，优先于 `newProject`；**ACP 下被忽略**。 |
| `printTimeout` | 打印超时 | text（Go duration 如 `180s`/`10m`） | 未设置（无限等待） | `--print-timeout`；**ACP 下被忽略**（改用 `acpPromptTimeoutMs`）。到期返回部分结果并以 exit 0 退出，不能据此判断完成。 |
| `jsonSchema` | 结果 JSON Schema | textarea（内联 JSON 或文件路径） | 未设置 | `--json-schema`；**ACP 下被忽略**。 |
| `fallbackModel` | 备用模型 | text | 未设置（不重试） | 只有**显式设置**才在限流/配额失败时重试一次。 |
| `retryOnRateLimit` | 限流重试一次 | checkbox | `false` | 默认关闭，勿默认开启（会翻倍配额）。 |
| `disposeGraceMs` | 进程回收宽限(ms) | number（整数 ≥1，≤600000） | `3000` | 终止清理子进程的宽限；超过 `MAX_TIMER_DELAY_MS` 会让 `apply()` 抛错。 |

> 合计 **6 + 6 + 9 + 4 + 10 = 35**，与 `lib/index.js` 的 `Config` 一一对应，无遗漏、无臆造。

---

## 4. 实现架构

### 4.1 注册与数据流

```
DSH 设置 UI
  └─ slot 'settings.section'
       id='subagent-antigravity' · order=50 · label='Antigravity'
       └─ 组件 AntigravitySettingsSection(props)
            ├─ props.useAntigravitySettings(s => s)   ← 控制器 store（hooks）
            ├─ props.editField(field, value)  →  form.set(field, value)
            └─ props.resetField(field)        →  form.unset(field)
                         │
        ctx.configForms.get('subagent-antigravity')  →  ConfigForm
          getSnapshot() / subscribe(fn) / set / unset
                         │
        Host 配置镜像  →  profile 设置文档（applies: live → 写入即热重载）

注册链（lib/client.js · apply(ctx)）
  apply(ctx)
    ├─ ensureStyles()
    ├─ 4× ctx.slots.inject（main ×2 / sidebar.panellist ×2）   ← 原有 Gemini 面板，未改动
    └─ registerSettingsSection(ctx)
          ctx.inject(['configForms'], child => mount(child))    ← 可选注入（非必需依赖）
            └─ configForms.whileServed([SETTINGS_NS], () => {
                   form = configForms.get(SETTINGS_NS)
                   controller = createSettingsController(form)
                   slots.inject('settings.section', () => slots.register({...}, AntigravitySettingsSection))
                   // disposer：注销 slot + controller.dispose()
               })
```

### 4.2 三个关键点

1. **`settings.section` 注册**：`name:'settings.section'`、`id:'subagent-antigravity'`、`order:50`、`label:()=>'Antigravity'`、`inject:()=>controller.inject()`；组件通过 `props.useAntigravitySettings(s => s)` 全量订阅，`editField/resetField` 由 `inject()` 提供。
2. **`ctx.configForms` 读写**：`get` 拿 `ConfigForm`；读用 `getSnapshot()` 的 `value`（有效值，含默认）与 `user`（用户覆盖层），写用 `set`/`unset`。
3. **可选注入（安全边界）**：
   - `exports.inject` 仍为 **`['slots']`**——**绝不**把 `configForms` 放进必需依赖，否则缺 settings 服务的部署会连 Gemini 面板一起失效。
   - `configForms` 走 `ctx.inject(['configForms'], cb)`；服务缺失时回调不执行，`mount()` 内再判 `child.slots && child.configForms` 才继续，缺失直接 `return`，不抛错。
   - `package.json > dsh.client.inject` 追加 `"@deepseek-ai/dsh-client-ui-settings"`（只保证该 bundle 先于本插件装载，并非强制服务存在）。
4. **Config 必须是 volatile（关键前提）**：DSH 设置表单只暴露 volatile 字段。因此 `lib/index.js` 的 `Config = z.object({...}).volatile()`，`apply()` 入口用 `readConfig()` 解包 `.get()`。核心委派字段（model / transport / acp* / effort / printTimeout / jsonSchema / env / addDirs / fallbackModel / retryOnRateLimit）在每次 `provider.start()` 读取 live 值，**即时生效**；结构性字段（providerName / teamProviderName / teamEnabled / parallelToolName / parallelMaxTasks 及 Gemini 网页参数）在 apply 时注册，**需重启 DSH 生效**。

### 4.3 读写语义（含「未变化不写盘」）

- **读取**：永远从 `form.getSnapshot()` 取；展示值 = `value[field]`，覆盖标记 = `user` 里是否有该键。
- **即时写**：标量/枚举/布尔 `onChange` 即 `set`；文本/数字/数组/env 在**失焦或 Ctrl/Cmd+Enter** 时提交（避免逐键写盘）。
- **未变化不写盘**：`commitOrReset` 先用 `valuesEqual` 比较「目标值 vs 当前值」，相等则直接 `return`，不写盘、不触发热重载、不误标「已覆盖」。
- **空值归一**：`normalizeEmptyValue` 把 `'' / undefined / null / [] / {}` 归一为 `undefined`，走 `unset`（恢复默认），不写空容器。
- **数字**：`parseNumberField` 空→`unset`、非法→行内报错不写，**永不写 `NaN`**。
- **数组/env**：`parseListText` 按行（只按换行切，不切逗号）；`parseEnvText` 按第一个 `=` 切分，缺失 `=` 或 key 为空→整次不写并提示行号。
- **本地校验**：`teamProviderName` 提交前与 `providerName` 比较，相同则不写并显示行内错误。
- **恢复默认**：`unset(field)`。

---

## 5. 验证

### 5.1 语法与单元测试（本分支已实测）

```powershell
node --check lib/client.js
# 退出码 0，无输出

node --test
# ℹ tests 99
# ℹ pass 99
# ℹ fail 0
```

- **99 通过 / 0 失败** = 原有 87 用例 + 设置页新增 12 用例（`test/settings-ui.test.js`）。
- 设置页用例覆盖：`exports.inject === ['slots']`、35 字段/5 组一一对应、控件合法性、`parseNumberField / parseListText / parseEnvText / serialize* / projectFieldDefaults / isFieldOverridden / valuesEqual / normalizeEmptyValue` 的边界、以及 `apply` 的两条路径（有 `configForms` 时注册 section；无 `configForms` 时不抛错且保留 Gemini 面板）。
- 若受限 shell 报 `spawn EPERM`，改用 `node --test --test-isolation=none`。

### 5.2 profile 部署 + 重启 GUI

`lib/client.js` 改动会随 profile 硬链接同步，但**新增文件不会**，且原子写可能断链，因此必须重装：

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm install        # 沙箱挡就换真实终端执行
# 重启 DSH GUI
```

### 5.3 手工验收步骤（需人眼看 UI，本机无法自动验证）

1. **入口**：打开「设置」→ 左侧出现「Antigravity」（order 50，位于 General/Plugins 之后），且**只有一个**该入口（若出现两个，见 [settings-ui-design.md](./settings-ui-design.md) §3.5/§10.3）。
2. **字段渲染**：显示 5 个分组、35 个字段；默认值可见（`model=gemini-3.8-flash`、`effort=medium`、`transport=stream-json`、`parallelMaxTasks=8`、`disposeGraceMs=3000` 等）；`model` / `effort` 为下拉选择；`geminiProfileDir` 显示为占位提示而非已填值。
3. **未变化不写盘**：点进普通文本字段（如 `model`）不改内容→点别处失焦：**应无「保存中…」、无「已覆盖」、不触发重载**。
4. **标量读写**：改 `model` 为其它值→失焦→短暂「保存中…」→重进页面值保留。
5. **数组/env**：`addDirs` 填两行、`env` 填 `FOO=bar`→失焦→重进回显一致；`env` 故意写一行无 `=`（如 `BADLINE`）→行内报错且**未**写盘。
6. **数字校验**：`parallelMaxTasks=99`→行内报错不写；清空→回落默认且「已覆盖」消失。
7. **恢复默认**：点某项「恢复默认」→回落默认、「已覆盖」消失。
8. **持久化 + 热重载**：打开 profile 设置文档确认键值写入；观察 GUI 热重载后两个 Gemini 面板与三个工具仍可用。
9. **不回归**：两个 Gemini 面板（「Gemini 调研」「Gemini 对话」）能打开；`subagent_agy` / `subagent_agy_team` / `subagent_agy_parallel` 仍在。
10. **只读 / loading**：模拟 profile 只读→顶部「只读」横幅、输入全禁用、无「恢复默认」；冷启动瞬间显示占位，不因 `value===undefined` 崩溃。

---

## 6. 风险与回退

### 6.1 写入即热重载

- 该配置 `applies: live`：每次写入都让 Host 重新应用该 entry 的 Config，插件 fiber 可能被重建，**正在运行的 Gemini 任务/worker 可能被中断**，设置页本身也可能短暂重挂载。
- 缓解：控制器 `dispose` 与 `whileServed` 均包 `ctx.effect` 清理；`apply` 幂等；「未变化不写盘」显著降低误触发的重载；提示用户「修改 Gemini 运行参数会重启 worker，测试时避免在跑任务」。

### 6.2 误配导致插件启动失败如何恢复

- 高风险项：`teamProviderName === providerName` → `apply()` 直接抛错；`disposeGraceMs` 越界（> `MAX_TIMER_DELAY_MS`）→ 校验抛错；`executable` 指向不存在文件 → 不致命，但每次委派失败。
- **恢复**（按顺序）：
  1. 打开 profile 设置文档（`settings.prepareDocument()` 指向的文件，或 profile 目录下被写入的文件），删掉出错字段的键，保存；
  2. 或直接编辑 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 里 `- id: subagent-antigravity` 的 `config:`；
  3. 重启 GUI。
  > 具体落盘文件名以实际为准，先用 `settings.prepareDocument()` / 设置页定位，不要凭猜测删文件。
- UI 侧预防：`teamProviderName` 行有 hint 且提交前本地同名校验；`disposeGraceMs` 输入带 `min=1 / max=600000`。

### 6.3 空值 / NaN / env 处理

- 空串、空数组、空对象 → `unset`（恢复默认），不写空容器。
- 数字空输入 → `unset`；非法（非数、非整数、越界）→ 不写，行内报错；**永不写 `NaN`**。
- `env` 非法行（缺 `=` 或 key 为空）→ 整次不写，提示行号；`CLAUDECODE / CLAUDE_CODE_ENTRYPOINT / GEMINI_CLI / ANTIGRAVITY_SESSION_ID` 会被进程覆盖为空串，设置无效。
- `geminiProfileDir` **留空 = 默认**；`~` 不展开，建议填绝对路径。

### 6.4 ACP 差异提醒

- ACP 下 `printTimeout` / `jsonSchema` 不生效（单轮超时改用 `acpPromptTimeoutMs`）；`effort` 会拼到模型名后缀（`base-effort`）；`addDirs` 改走 `session/new.additionalDirectories`（best-effort）；`newProject` / `projectName` 被忽略。

---

## 7. 变更清单与审核结论

### 7.1 变更清单

| 文件 | 变更 |
|---|---|
| `lib/client.js` | **纯新增 +556 行**：设置页常量（`SETTINGS_NS`/`SECTION_ID`/`SECTION_ORDER`/`LABELS`）、`GROUPS`（5 组）、`FIELDS`（35 项）、纯函数（`parseNumberField`/`parseListText`/`parseEnvText`/`serializeList`/`serializeEnv`/`projectFieldDefaults`/`isFieldOverridden`/`normalizeEmptyValue`/`valuesEqual`）、`createSettingsController`、`AntigravitySettingsSection`/`GroupSection`/`FieldRow` 组件、`registerSettingsSection` 可选注入与 `settings.section` 注册。`exports.inject` 仍为 `['slots']`；新增导出 `__settingsSection` / `__internals`；四个 Gemini 面板注册不变。 |
| `package.json` | `dsh.client.inject` 追加 `@deepseek-ai/dsh-client-ui-settings`（保留 `@deepseek-ai/dsh-client-ui-slots`）。 |
| `test/settings-ui.test.js` | 新增 12 个用例（字段表/分组/解析/序列化/覆盖判断/空值归一/`apply` 两条路径）。 |
| `lib/types/index.d.ts` | 未改（无新 `Config` 字段、无新 host 导出）。 |
| `docs/settings-ui-design.md`、`docs/settings-ui-review.md` | 方案基准与审核记录（含问题清单）。 |

### 7.2 审核结论摘要（引用 [settings-ui-review.md](./settings-ui-review.md)）

- **首轮结论：有条件通过（conditional pass）**——需先修 1 个 major（M-1：「失焦无条件提交」）后可合并；另列 minor m-1..m-5、nit-1..nit-2。
- **Round 2 复审结论：可合并（mergeable）**——M-1 已修复，无 blocker/major；仅剩 minor m-2（pending 全局禁用，UX）与 nit-3/nit-4，见 review 文档 Round 2 小节。
- **审核后实现已处理项（对照当前代码）**：
  - **M-1**（聚焦未改也会写盘/误标已覆盖/触发重载）→ `commitOrReset` 用 `valuesEqual` 比较，未变化直接 `return`（`lib/client.js:1154-1160`）。
  - **m-1**（`geminiProfileDir` 假默认 `~/...`）→ 改为 placeholder、空值视为未覆盖（`lib/client.js:163`）。
  - **m-3**（`disposeGraceMs` 无上限）→ 加 `max: 600000`（`lib/client.js:187`）。
  - **m-4**（`teamProviderName` 无同名校验）→ 提交前与 `siblings.providerName` 比较，冲突不写（`lib/client.js:1166-1169`）。
  - **m-5**（缺「无 configForms 不抛错」安全路径测试）→ 新增对应 `apply` 用例（`test/settings-ui.test.js:153-173`）。
  - **nit-1**（`valuesEqual` 未被生产代码使用）→ 现已在 `commitOrReset` 使用。
- **残余项（截至本分支）**：
  - **m-2**：`pending` 仍是全局量，任一字段在飞即禁用**全部**行并全部显示「保存中…」（`lib/client.js:1307-1308`），与设计 §6.4「仅禁用该行、允许连续编辑不同字段」不符。影响：并发编辑体验，不阻断正确性。
  - **nit-2**：`executable` 的 `meta.default` 仍是字面量，仅作占位兜底（schema 有默认时通常不显示）。
  - **实证风险**：`settings.section` slot 渲染、`ctx.configForms` 运行期 API、`whileServed` 行为、Host 写入/revision、live reload 热重载、真实浏览器交互**本机无法自动验证**，须按 §5.3 手工验收。
- **测试基线**：由审核时的 97（原 87 + 设置页 10）随修复补测增至 **99（原 87 + 设置页 12）**，`0 fail`。

---

## 8. 相关文档

- 方案设计：[settings-ui-design.md](./settings-ui-design.md)
- 代码审核：[settings-ui-review.md](./settings-ui-review.md)
- ACP 传输：[agy-acp-transport.md](./agy-acp-transport.md)
- 项目总览：[../README.md](../README.md)
