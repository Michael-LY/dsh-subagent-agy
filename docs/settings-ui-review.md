# 设置页 UI 代码审核报告（task-7）

- 审核对象：`lib/client.js`（+556 行，纯新增，0 删除）、`package.json`（`dsh.client.inject` +1 项）、`test/settings-ui.test.js`（新增）、`docs/settings-ui-design.md`（方案基准）
- 基线：`origin/master` @ `6eb2f27`，工作树分支 `settings-ui`
- 审核方式：先读 `docs/settings-ui-design.md`，再逐项对照实现（read/grep），并实际运行 `node --check` 与 `node --test`
- 审核人：settings-reviewer

## 结论速览（Round 2 复审后 —— **以本节为最新**）

> **变更历史**：Round 1 结论为「有条件通过（M-1 major）」；lead 已按 M-1 修复，Round 2 复审确认 **M-1 已解决**，结论更新为「**可合并**」。下文 Round 1 的逐项细节保留，最终判定以本节与文末「Round 2 复审」为准。

| 项 | 结论（Round 2 最新） |
|---|---|
| 总体结论 | **可合并（mergeable）**——M-1 已修复；仅剩 1 个 minor（m-2）与少量 nit，可后续处理，不阻断合并 |
| 安全性（exports.inject / 可选注入 / 缺 configForms 不抛错） | ✅ 通过（`exports.inject` 仍为 `['slots']`；新增 m-5 用例覆盖缺失路径） |
| 字段覆盖（35 个 Config 字段） | ✅ 35/35 一一对应；`geminiProfileDir` 合成默认已改为 placeholder |
| 读写语义 | ✅ 「失焦未变化不写盘」已由 `normalizeEmptyValue`+`commitOrReset`（valuesEqual）实现（**M-1 resolved**） |
| 不回归（Gemini 面板） | ✅ 通过（diff 纯新增，面板注册未动） |
| 测试 | ✅ **99 pass / 0 fail**（settings 12 例）；m-5 缺口语义路径已补 |
| 阻断/严重问题 | **major ×0**、minor ×1（m-2 仍 open）、nit ×若干 |

> Round 1 发现的 major 已 `send_message` 给 lead 并完成修复；Round 2 未再发现 blocker/major，无需再上报。

---

## 逐项结论（按 task-7 的 8 个要点）

### 1) 正确性：settings.section 注册参数与组件消费方式

**结论：通过（代码层面对齐设计 §3.1/§3.2/§3.3）。**

- 注册参数完整且与设计一致：`name:'settings.section'`、`id:'subagent-antigravity'`、`order:50`、`label:()=>'Antigravity'`、`inject:()=>controller.inject()` —— `lib/client.js:1341-1352`。
- 常量与设计一致：`SETTINGS_NS='subagent-antigravity'`、`SECTION_ID='subagent-antigravity'`、`SECTION_ORDER=50` —— `lib/client.js:116-118`。
- 控制器经 `inject()` 暴露 `hooks.antigravitySettings` + `editField` + `resetField` —— `lib/client.js:345-355`；组件通过 `props.useAntigravitySettings(s => s)` 消费 —— `lib/client.js:1301-1302`。
- `whileServed([SETTINGS_NS], register)` 只在 namespace 出现时注册、消失时注销 —— `lib/client.js:1338-1357`。
- 严重级别：无。
- 遗留：`settings.section` 是浏览器端 slot，`ctx.configForms`/`whileServed` 的真实运行期形状本机无法执行验证，需按第 8 节人工验收（见 §8）。

### 2) 安全性：exports.inject 必须仍为 ['slots']，configForms 只能可选注入

**结论：通过（重点核查项，符合要求）。**

- `exports.inject` 仍为 `['slots']`：`var inject = ['slots'];`（`lib/client.js:1375`）+ `exports.inject = inject;`（`lib/client.js:1417`）。`git diff` 显示这两行均为**未改动的上下文行**，`configForms` 未进入必需依赖。
- `configForms` 走可选注入：`ctx.inject(['configForms'], function (child) { mount(child); })` —— `lib/client.js:1362-1364`；且外围有 `typeof ctx.inject === 'function'` 防御、`else if (ctx.configForms)` 兜底 —— `lib/client.js:1362-1367`。
- `mount()` 内再次校验 `child.slots && child.configForms` 才继续，缺失则 `return`，不抛错 —— `lib/client.js:1335-1337`。
- `apply()` 仍无条件先注册四个既有 Gemini slot（`lib/client.js:1380-1407`），`registerSettingsSection(ctx)` 作为独立项追加（`lib/client.js:1408`），缺 settings 服务时仅该项为空操作。
- 严重级别：无。
- 结论：缺 `configForms` 的部署**不会**连 Gemini 面板一起失效，符合设计 §3.2 的核心安全要求。

### 3) 读写语义

**结论：基本正确，但存在 major（M-1）。**

正确项：
- `set/unset` 使用正确：`editField→form.set`、`resetField→form.unset` —— `lib/client.js:348-353`。
- 数字空值→`unset` 不写 NaN：`parseNumberField` 空串返回 `{kind:'unset'}`，非法返回 `invalid` 且提交端不写 —— `lib/client.js:206-216`、`1155-1161`。✅
- env 非法行不写盘：`parseEnvText` 返回 `{ok:false,...}` 时 `commitNow` 仅 `setInvalid` 不提交 —— `lib/client.js:229-244`、`1170-1176`。✅
- list 按行解析、不切逗号 —— `lib/client.js:218-227`。✅
- `subscribe` 驱动渲染：控制器订阅 `form.subscribe` 并在 `commit` 前后 `notify()` —— `lib/client.js:308-335`。✅
- `dispose` 清理：`unsubscribe()` + `listeners.clear()` —— `lib/client.js:356-359`；`whileServed` 返回的注销函数内调用 `controller.dispose()` —— `lib/client.js:1353-1356`。未见明显 listener 泄漏。✅

问题（详见问题清单 M-1）：文本/数字/数组/env 控件在 `onBlur` 时**无条件**调用 `commitNow()`，不比较草稿是否与原值相同（`valuesEqual` 已实现却未被使用），导致「只聚焦再离开、未修改」也会写盘。

### 4) 字段覆盖：35 个 Config 字段

**结论：通过，35/35 一一对应；分组/控件正确；默认值 1 处为合成值（m-1）。**

- `FIELDS` 共 35 项（`lib/client.js:148-188`），与 `lib/index.js` 的 `Config`（`lib/index.js:48-84`）逐字段核对一一对应，无遗漏、无多余、无重复。
- `GROUPS` 5 组（basic/acp/gemini/team/advanced）—— `lib/client.js:140-146`；各字段 `group` 归属正确；控件类型（text/textarea/number/select/checkbox/list/keyvalue）与设计 §4 一致。
- 分组计数：基础 6 + ACP 6 + Gemini 9 + 团队 4 + 高级 10 = 35。✅
- 默认值逐项核对：`model=gemini-3.8-flash-medium`（`DEFAULT_MODEL`）、`permissionMode=dangerously-skip-permissions`（`DEFAULT_ANTIGRAVITY_PERMISSION_MODE`）、`transport=stream-json`、`parallelMaxTasks=8`（min1/max8）、`disposeGraceMs=3000`（`DEFAULT_DISPOSE_GRACE_MS`）等均与 `lib/index.js`/`lib/run.js` 一致。
- 唯一不一致：`geminiProfileDir` 的 `meta.default` 写成 `'~/.dsh/gemini-web-research/browser-profile'`（`lib/client.js:163`），而 `Config.geminiProfileDir`（`lib/index.js:71`）**无 schema 默认**，实际默认来自 `apply()` 的 `join(homedir(),'.dsh',...)` 绝对路径（`lib/index.js:214`）。见 m-1 / M-1。
- 严重级别：minor ×1（m-1）。

### 5) 健壮性

**结论：基本通过。**

- `configForms` 缺失：`mount` 有防御返回，不抛错（`lib/client.js:1335-1337`、`1362-1367`）。✅
- `value === undefined`/`status==='loading'`：`GroupSection` 用 `projectFieldDefaults` 兜底、`AntigravitySettingsSection` 对 `!state || loading` 渲染占位（`lib/client.js:1308-1310`、`1283-1285`）。✅（但 `geminiProfileDir` 兜底值不真实，见 m-1）
- env 非法行：正确拦截不写盘。✅
- 重复渲染 / listener 泄漏 / dispose：见第 3 点，未见泄漏。✅
- 问题：`pending`（任一字段在飞）会禁用**全部**行并在每行显示「保存中…」，与设计 §6.4「只禁用该行、允许连续编辑不同字段」不符 —— `lib/client.js:1291-1292`（m-2）。
- 严重级别：minor ×1（m-2）。

### 6) 测试质量

**结论：合格，存在覆盖缺口（m-5）。**

- `test/settings-ui.test.js` 用「假 window 捕获 lazy-CJS factory + 假 react」物化真实运行时代码（`test/settings-ui.test.js:22-41`），测的是同一份源码，不会漂移。
- 覆盖：`exports.inject===['slots']`、35 字段/5 组、控件合法性、`parseNumberField`/`parseListText`/`parseEnvText`/`serialize*`/`projectFieldDefaults`/`isFieldOverridden`/`valuesEqual` 边界、以及 `apply` 的 `settings.section` 接线（`test/settings-ui.test.js:53-179`）。质量良好。
- 缺口：`apply` 测试只覆盖「configForms 存在」路径（`test/settings-ui.test.js:142-179`），**未覆盖最强调的安全路径**——「`ctx.inject` 存在但 configForms 从不 serve 时，`apply` 不抛错且仍注册 Gemini 面板」（m-5）。
- 不依赖 `document`（仅用假 `window.__ModuleLoader__`），不会因真实浏览器缺失而失效；但它用假 react、从不真正 render 组件，因此**无法捕获 React 渲染层的问题（如 M-1 的失焦提交、pending 全禁用等）**——这是此类物化测试的固有边界，需人工验证补足。
- 严重级别：minor ×1（m-5）。

### 7) 不回归（现有 Gemini 面板）

**结论：通过。**

- `git diff --stat`：`lib/client.js | 556 ++...++`、`package.json | 3 +-`，合计 **558 insertions(+), 1 deletion(-)**，`lib/client.js` 为**纯新增 0 删除**。
- 原始文件（`git show HEAD:lib/client.js`）已有 `var inject=['slots']`（原 834 行）与 `exports.inject=inject`（原 875 行），本次 diff 中这两行为上下文、未改动。
- `apply()` 中四个 Gemini slot 注册（`main`×2、`sidebar.panellist`×2，`lib/client.js:1380-1407`）与 `exports.__panel/__icon/__chatPanel/__chatIcon`（`lib/client.js:1432-1435`）均保留。
- `package.json` 仅追加 `@deepseek-ai/dsh-client-ui-settings`，保留 `@deepseek-ai/dsh-client-ui-slots`（`package.json:64-67`）。
- 严重级别：无。

### 8) 手工验证

见文末「手工验收步骤」。无法在本机自动验证的部分：slot 渲染、`ctx.configForms` 运行期 API、`whileServed` 行为、Host 写入/revision、live reload 热重载、真实浏览器交互。

---

## 问题清单

| 编号 | 严重级别 | 位置 | 问题 | 修复建议 |
|---|---|---|---|---|
| M-1 | **major** | `lib/client.js:1147-1177`（commitNow）、`1207-1253`（textarea/number/text 的 onBlur）、`163`（geminiProfileDir meta.default） | 文本/数字/数组/env 控件在 `onBlur` 时**无条件**提交，不判断草稿是否与原值相同。后果：① 只点进再离开、未做任何修改也会 `set` 写盘；② 每次写会触发插件 live reload（设计 §10.1），可能中断正在运行的 Gemini 任务；③ 被触碰的字段会被错误标记为「已覆盖」；④ 对 `geminiProfileDir` 尤其危险——它无 schema 默认，UI 显示的是合成的 `~/.dsh/...` 字面量（`lib/client.js:163`），一聚焦再离开就会把该 `~` 字面量写入 user 覆盖，而 `gemini-web.js` 不展开 `~`（`lib/gemini-web.js` 全无 `~` 展开），会指向错误 profile 目录、丢失登录态。 | 在 `commitNow` 提交前用已实现但未使用的 `valuesEqual`（`lib/client.js:265-282`）比较「待写值 vs 当前 `props.value`」，相等则直接 `return` 不提交；并对无 schema 默认的 `geminiProfileDir` 去掉 `meta.default`，改用 `placeholder` 展示「默认：~/.dsh/...」，空输入视为未覆盖（不写）。 |
| m-1 | minor | `lib/client.js:163` vs `lib/index.js:71`/`214` | `geminiProfileDir` 的显示默认值 `~/.dsh/...` 与 `apply()` 实际默认（`join(homedir(),...)` 绝对路径）不一致，属误导性默认。 | 改为 placeholder 提示（见 M-1 修复），不要在 `FIELDS` 放 `default`。 |
| m-2 | minor | `lib/client.js:1291-1292` | `pending` 为全局量：任一字段写入在飞即禁用所有行、所有行都显示「保存中…」，与设计 §6.4「仅禁用该行、允许连续编辑不同字段」不符。 | 把 `pending` 细化到字段级（controller 记录 `pendingFields` 集合），`disabled/pending` 按 `field` 判断。 |
| m-3 | minor | `lib/client.js:187`（disposeGraceMs `min:1`，无 `max`）vs `lib/index.js:229` | 数字控件未校验上限，输入 `> MAX_TIMER_DELAY_MS` 会让 `apply()` 抛错、插件（含 Gemini 面板）加载失败；设计 §10.2 也建议 UI 侧预防。 | 给该字段加 `max`（取 `MAX_TIMER_DELAY_MS`），或在提交前本地做上限校验并拒绝写入。 |
| m-4 | minor | `lib/client.js:173`、`lib/index.js:232` | `teamProviderName` 无本地同名校验，仅 hint 提示；用户填成与 `providerName` 相同会使 `apply()` 抛错、插件加载失败。设计 §10.2 建议「保存前本地做同名校验，冲突不写并提示」。 | 提交 `teamProviderName` 前读取 `values.providerName` 比较，相等则不写并显示行内错误。 |
| m-5 | minor | `test/settings-ui.test.js:142-179` | 测试只覆盖 configForms 存在的接线路径，未覆盖「configForms 从不 serve 时 `apply` 不抛错、Gemini 面板仍注册」这条最关键安全路径。 | 增加一个用例：`ctx.inject` 仅登记依赖但从不调用回调（或 `ctx.inject` 缺失且无 `ctx.configForms`），断言 `apply` 不抛错、四个面板注册照旧。 |
| nit-1 | nit | `lib/client.js:265-282`、`1430` | `valuesEqual` 在生产代码中未被使用（仅导出 + 测试），疑似本应作为 M-1 的变更判据。 | 用于 M-1 的提交前比较；否则删除以免误导。 |
| nit-2 | nit | `lib/client.js:150` | `executable` 的 `meta.default` 用 `%USERPROFILE%\.gemini\bin\agy.exe` 字面量，与 schema 实际默认（绝对路径）不同；因 schema 有默认，通常不会显示到，仅兜底。 | 建议改 placeholder 语义，避免不一致。 |

---

## 实际运行输出（原文）

### `node --check lib/client.js`

（无输出，退出码 0）

```
=== node --check lib/client.js ===
exit=0
```

### `node --test`

```
ℹ tests 97
ℹ suites 0
ℹ pass 97
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5583.3164
```

- 退出码 `0`；`97 pass / 0 fail`，与 task 期望的「97 通过 / 0 失败」一致（设计 §1 记录的历史基线为 87，本分支新增 10 个 settings 用例后为 97）。
- 沙箱下 `node --test` 直接可用，未触发 spawn EPERM，故无需 `--test-isolation=none`。

### `git diff --stat`

```
 lib/client.js | 556 ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
 package.json  |   3 +-
 2 files changed, 558 insertions(+), 1 deletion(-)
```

（`test/settings-ui.test.js`、`docs/settings-ui-design.md` 为未跟踪新文件，不在 `git diff` 统计内。）

---

## 手工验收步骤（profile pnpm install + 重启 GUI 后）

> 前置：`lib/client.js` 的改动会随 profile 硬链接同步，但**新增文件不会**，且原子写会断链，因此必须重装：
> ```powershell
> cd $env:USERPROFILE\.dsh\profiles\desktop
> pnpm install        # 沙箱挡就换真实终端
> # 重启 DSH GUI
> ```

**必须由人眼看 UI 的部分（本机无法自动验证）：**

1. **入口与顺序**：打开「设置」→ 左侧导航出现「Antigravity」，order 50，位于 General/Plugins 之后；**只有一个**该入口（若出现两个，按设计 §3.5/§10.3 处理）。
2. **字段渲染**：首屏显示 5 个分组、35 个字段；默认值可见（`model=gemini-3.8-flash-medium`、`transport=stream-json`、`parallelMaxTasks=8`、`disposeGraceMs=3000` 等）；`geminiProfileDir` 显示为提示而非已填值（对应 m-1/M-1 修复后的形态）。
3. **重点复现 M-1（修复前后各验一次）**：
   - 修复前：点进 `geminiProfileDir` 输入框（不改任何内容）→ 点别处失焦 → 预期观察到「保存中…」且该字段被标记「已覆盖」（bug 现象）。
   - 修复后：同样的「聚焦→离开」应**无写入、无保存中、无已覆盖标记**。
   - 对普通文本字段（如 `model`）同样做「聚焦→不改→离开」，确认不再触发写盘/插件重载。
4. **标量写读**：改 `model` 为其它值 → 失焦 → 行内短暂「保存中…」→ 重进页面值保留。
5. **数组/env**：`addDirs` 填两行、`env` 填 `FOO=bar` → 失焦 → 重进回显一致；`env` 故意写一行无 `=`（如 `BADLINE`）→ 行内报错且**未**写盘。
6. **数字**：`parallelMaxTasks=99` → 行内报错不写；清空 → 回落默认且「已覆盖」消失。
7. **恢复默认**：点某项「恢复默认」→ 回落默认、「已覆盖」消失。
8. **持久化落盘**：打开 profile 设置文档（`settings.prepareDocument()` 指向文件 / 被编辑的 patch）确认键值写入；观察 GUI 热重载后两个 Gemini 面板与工具仍可用。
9. **不回归**：两个 Gemini 面板（「Gemini 调研」「Gemini 对话」）仍能打开；`subagent_agy` / `subagent_agy_team` / `subagent_agy_parallel` 工具仍在。
10. **只读场景**（若能模拟）：profile 只读 → 顶部「只读」横幅、输入全禁用、无「恢复默认」。
11. **loading/unavailable**：冷启动进入页面的瞬间应为占位/骨架；不出现因 `value===undefined` 崩溃。

**修复 M-1 后建议补跑**：`node --check lib/client.js` 与 `node --test`（期望仍 97+ 通过、0 失败，若按 m-5 增加用例则总数相应增加）。

---

## 附：变更清单

- `lib/client.js`：新增 200+ 行设置页常量/字段表/纯函数/controller/组件，及 `apply()` 内可选 `configForms` 注入与 `settings.section` 注册；`exports.inject` 与四个 Gemini 面板注册保持不变。纯新增，无删除。
- `package.json`：`dsh.client.inject` 追加 `@deepseek-ai/dsh-client-ui-settings`（保留 slots）。
- `test/settings-ui.test.js`：新增 10 个用例（字段表/解析/序列化/接线）。
- `lib/types/index.d.ts`：未改（符合设计 §2「无新 Config 字段/无新 host 导出则不改」）。
- `docs/settings-ui-design.md`：方案基准（未改代码）。

---

## Round 2 复审（M-1 修复复验）

- 触发：lead 按 Round 1 的 M-1 修复后请求复审
- 复审范围：`lib/client.js`、`test/settings-ui.test.js`（`git diff --stat`：client.js **+573 行仍为纯新增**、package.json 仍仅 +1 行；settings 用例由 10 → 12）
- 方法：read/grep 对照修复点 + 实际运行命令

### 实测输出（原文）

```
=== node --check lib/client.js ===
exit=0
```

```
ℹ tests 99
ℹ suites 0
ℹ pass 99
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5570.5111
EXIT=0
```

- `99 pass / 0 fail`，与 lead 所述一致（Round 1 为 97，新增 `normalizeEmptyValue` 与「configForms 缺失」两例后为 99）。

### M-1 修复核验：**已解决（closed）**

1. 新增 `normalizeEmptyValue(value)`（`lib/client.js:265-270`）：`''`/`undefined`/`null`/`[]`/`{}` → `undefined`；非空数组/对象保留；`0`/`false` 保留（测试 `normalizeEmptyValue(0)===0`，`test/settings-ui.test.js:150`）。
2. 新增 `commitOrReset(next, current)`（`lib/client.js:1154-1160`）：`desired=normalizeEmptyValue(next)`、`baseline=normalizeEmptyValue(current)`；`valuesEqual(desired,baseline)` 为真则**直接 return，不写盘、不触发热重载**；否则 `desired===undefined` → `onReset`(unset)，否则 `onCommit(desired)`。
3. `commitNow` 现对四类草稿控件统一经 `commitOrReset` 提交：text/textarea（`lib/client.js:1170`）、number（`:1177`）、list（`:1183`）、keyvalue（`:1190`），空值统一传 `undefined`。Round 1 的「无条件提交」已消除。
4. 逐类核对不再误写：文本不改→skip；数字不改（含 `0`）→skip；list/env 空或不变→skip；清空且原本非空→unset。✅
5. `geminiProfileDir` 删除 synthetic default，改为 placeholder（`lib/client.js:163`，`placeholder:'留空=使用默认 ~/.dsh/gemini-web-research/browser-profile'`）；`projectFieldDefaults('geminiProfileDir')` 归为 `''`，聚焦再离开（value=undefined、draft=''）→ `commitOrReset(undefined,undefined)` skip，**不再把 `~/.dsh/...` 字面量写入 user**。M-1 第 ④ 项数据风险消除。✅
6. `valuesEqual` 已由 `commitOrReset` 实际调用（`lib/client.js:1157`）；`normalizeEmptyValue` 已挂入 `exports.__internals`（`lib/client.js:1447`）并有单测（`test/settings-ui.test.js:142-151`）。Round 1 的 nit-1（`valuesEqual` 未使用）消除。✅

### 附加修复核验

- **m-3（disposeGraceMs 上限）已解决**：`FIELDS` 增 `max: 600000`（`lib/client.js:187`），`parseNumberField` 按 max 判 invalid 不写；600000 小于 `MAX_TIMER_DELAY_MS`，不会再让 `apply()` 抛错。✅
- **m-4（teamProviderName 同名校验）主要解决**：`commitNow` 在 text 分支判 `meta.key==='teamProviderName' && trimmed===props.siblings.providerName` → `setInvalid` 且不写（`lib/client.js:1166-1168`）；`GroupSection` 传入 `siblings: state.values`（`lib/client.js:1305`）。✅（反向残留见「新增观察」nit-3）
- **m-5（configForms 缺失用例）已解决**：`test/settings-ui.test.js:153-173`「apply works without configForms … keeps Gemini panels」断言 `doesNotThrow`、Gemini 面板仍注册、无 `settings.section`。✅
- **m-1（geminiProfileDir 显示默认不一致）已解决**：见上第 5 点。✅

### 问题状态更新

| 编号 | Round 1 级别 | Round 2 状态 |
|---|---|---|
| M-1 失焦无条件提交 + geminiProfileDir 误写 | major | ✅ 已解决（closed） |
| m-1 geminiProfileDir 合成默认不一致 | minor | ✅ 已解决（closed） |
| m-2 pending 全局禁用所有行 / 全部显示「保存中」 | minor | ⚠️ **仍 open**（未改动，`lib/client.js:1307-1308` 依旧全局） |
| m-3 disposeGraceMs 无上限 | minor | ✅ 已解决（max:600000） |
| m-4 teamProviderName 无同名校验 | minor | ✅ 主要解决（反向残留见 nit-3） |
| m-5 缺 configForms 缺失用例 | minor | ✅ 已解决 |
| nit-1 valuesEqual 未使用 | nit | ✅ 已解决（commitOrReset 使用） |
| nit-2 executable meta.default 字面量 | nit | ✅ 影响消除（value 来自 schema 默认，不再展示合成值；可留作清理） |

### 新增观察（不阻断）

- **nit-3**：`teamProviderName` 仅校验「编辑 teamProviderName 时 == providerName」；反向「把 providerName 改成与 teamProviderName 相同」未校验，仍会命中 `apply()` 的 `throw`（`lib/index.js:232`）导致插件加载失败。建议对 providerName 侧也做校验，或在提交前做跨字段终检（低风险，可后续）。
- **nit-4**：m-5 新用例用的是「无 `ctx.inject`」变体（`ctx={slots}`），未覆盖「`ctx.inject` 存在但 callback 从不触发（configForms 未 serve）」这一更贴近真实的变体；两者都验证了「不抛错且保留 Gemini 面板」的核心保证，仅提示。

### Round 2 结论

- **M-1 已解决**；未再发现 blocker/major；**可合并（mergeable）**。
- 剩余：minor ×1（m-2，pending 全局禁用，属 UX，可后续）、nit ×若干（nit-3/nit-4）。
- 合并前建议顺手（可选）：修复 m-2（字段级 pending）、补 nit-3 反向校验。

### Round 2 手工复验补充（profile `pnpm install` + 重启 GUI 后，人眼）

1. `geminiProfileDir` 输入框：**点入再点出、不改内容 → 无「保存中…」、无「已覆盖」、profile 目录不变**（M-1 核心）。
2. `model`（或任一有默认值的文本字段）点入再点出、不改 → 同样无写盘、无热重载。
3. `teamProviderName` 输入与 `providerName` 相同的值 → 失焦应显示行内错误且**不写**。
4. `disposeGraceMs` 输入 `> 600000`（如 `999999`）→ 行内报错不写；输入合法值可正常保存。
5. 正常修改一个字段（如改 `model`）→ 仍能保存并回显（确认「未变化跳过」未误伤真实修改）。
6. 回归仍验：两个 Gemini 面板与 `subagent_agy*` 工具在热重载后仍可用。
