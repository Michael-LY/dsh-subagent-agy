# AGENTS.md

DSH 插件：把一次性任务委派给本机 Antigravity CLI（`agy`）。部署实例在 `%USERPROFILE%\.dsh\profiles\desktop`。

## 仓库形态
- 纯 ESM JavaScript：无构建、无 lint、无本地 `node_modules`；已有 `node:test` 单测（`test/*.test.js`，覆盖 `wire.js` / `classify.js` / `gemini-web.js`，共 33 用例）。
- **已是 git 仓库**：origin `https://github.com/Michael-LY/dsh-subagent-antigravity.git`；主干 `master`，开发分支 `feature/headless-scripting`。
- `lib/*.js` 就是发布源码（Tab 缩进、JSDoc 类型）。`lib/types/index.d.ts` **不是** tsc 生成的，改 `Config` / 导出后要手写同步。
- `package.json` 的 `files` 里 lib 部分只收 `lib/*.js`（顶层，不含子目录）加 `lib/types/**/*.d.ts`（另有 `icon.svg` / `README.md` / `locale/*.json` / `cordis.patch.yml`）：新模块放 `lib/` 顶层无需改白名单，放子目录则必须补，否则装进 profile 后缺失。
- `docs/headless-scripting-plan.md`：headless 能力嫁接（超时/结构化输出/附加目录/配额降级）的调研与取舍记录，改相关功能前先读。
- 版本号与 `peerDependencies` 跟随 DSH `0.2.1-rc.5` / cordis `~4.0.5`，升级时一起动。

## 模块分工
- `lib/wire.js`：纯 NDJSON 帧解析（`AntigravityStream`）。按行切帧、校验 envelope、选答案（终态 `result.response` 优先，`text_delta` 兜底）、把终态 status 映射成 `completed` / `aborted` / `error`，并收集 result/error 帧的错误文本供分类。不碰进程。
- `lib/classify.js`：纯函数失败分类。`classifyFailure()` 输出 `quota_exhausted` / `rate_limited` / `usage_error` / `unknown`，`parseRetryAfterMs()` 从文本解析 retry-after / `Resets in XhYmZs`。零依赖、可独立单测。
- `lib/client.js`：DSH 客户端面板（`sidebar.panellist` 入口 + `main` keyed slot）。lazy-CJS 格式（`window.__ModuleLoader__.load`），不需要打包器，只依赖 `react`。
- `lib/gemini-web.js`：主机侧 `/api/dsh-gemini-research/*` 桥接与单任务串行队列（同一 Chrome profile 只允许一个实例），超时终止。
- `scripts/gemini_research/*.py`：Playwright 持久化 Chrome profile 登录（`init_login.py`）与 Gemini 网页 Deep Research 自动化（`run_research.py`）。
- `lib/run.js`：单次子进程生命周期 + 可选重试。`antigravityArgv` 拼 argv（含 `--print-timeout` / `--json-schema` / `--add-dir`）、`textTask` 校验只收 text 块、`startAntigravityRun` 负责 spawn / 收流 / 终止清理 / 组装共享 run handle、`startAntigravityRunWithRetry` 在显式配置 `fallbackModel` / `retryOnRateLimit` 时做一次重试、`stripAnsi` 清理 stderr 转义码。
- `lib/index.js`：cordis 插件入口。定义 `Config`（schemastery，字段：providerName / executable / model / effort / env / permissionMode / extraArgs / printTimeout / jsonSchema / addDirs / fallbackModel / retryOnRateLimit / disposeGraceMs / geminiProfileDir / geminiPython / geminiHeadless / geminiTimeoutMs）、实现 `AntigravityProvider`（`NO_START_CAPABILITIES`、`inheritsParentContext = false`）、`apply()` 注册到 `ctx.subagents` 并调用 `setupGeminiWeb`。
- 数据流：`apply` → `provider.start` →（配置了 fallback/retry 时走 `startAntigravityRunWithRetry`）→ `startAntigravityRun` → spawn `agy` → `wire.js` 解析 stdout → `settleRunResult` 产出 `{ output, stopReason }`；失败由 `classifyFailure` 分类并写进诊断标签 `[kind]`。

## 本地跑不起来的部分
- `lib/wire.js` / `lib/classify.js` / `lib/gemini-web.js` 只用 node 内置模块，可直接用 node 跑；`lib/client.js` 是浏览器 lazy-CJS 模块，只能做 `node --check`。
- `lib/index.js` / `lib/run.js` 依赖 `@deepseek-ai/*`，仓库内解析不到；只能借 profile 的 hoisted `node_modules`（该 profile 是 `nodeLinker: hoisted` + `autoInstallPeers: false`）。
- `lib/run.js` import 了 `@deepseek-ai/dsh-brand`，已随 rc.5 对齐补进 `dependencies`（此前靠别的包提升）。

## 有意为之，别"顺手改回"
- 默认 `permissionMode` 是 `dangerously-skip-permissions`（`lib/run.js`），别按直觉改成「更安全」的 `auto`：print 模式下工具确认被软拒，`auto` 的子级读不了工作区，只适合不需要工具的 prompt。
- `agy` 正常退出（exit 0）必须 resolve，不能当失败：终态 `result` 帧与退出通知会竞争同一轮 stdout。`lib/run.js` 现有的 exit-code 处理就是这个原因。
- 答案取值：终态 `result.response` 优先，`agent_response` 的 `text_delta` 只是兜底；没有终态帧 → `stopReason: 'error'`。
- `SCRUBBED_ENV`（`CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `GEMINI_CLI` / `ANTIGRAVITY_SESSION_ID`）被置为**空字符串**而非删除，用来阻止子进程挂到父 CLI 会话上。
- `NO_START_CAPABILITIES` + `inheritsParentContext = false` 是 Antigravity 只有 CLI、没有 app-server/SDK 的直接后果；因此 `cordis.patch.yml` 里必须配 `maxDepth: provider-managed`。
- CLI 的 `--mode` 还支持 `accept-edits`，但 `Config.permissionMode` 有意只暴露 `auto` / `dangerously-skip-permissions`。
- **重试默认关闭**：`fallbackModel` / `retryOnRateLimit` 只在显式配置时生效。一次性委派自动重试会翻倍配额，`usage_error`（CLI exit 2）一律不重试。别把默认改成自动重试。
- `--print-timeout`（1.1.28+）到期会返回**部分输出、在 stderr 打 warning 并以 exit 0 成功退出**，不是失败；`printTimeout` 只是兜底截断，不能据此判断任务真正完成。
- **Gemini 网页调研严格串行**：同一个 `geminiProfileDir` 同时只能有一个 Chrome 实例；`lib/gemini-web.js` 用单任务队列保证这点，别改成并发。初始化登录必须 headed（可见窗口），调研默认 headless，二者共用同一个 profile。
- **Gemini 网页自动化是 best-effort**：Google ToS 禁止自动化访问，可能触发风控/封号；选择器随网页改版会失效，脚本失败时在 profile 目录留 `debug-*.png`。不要把这条路径接进高频批量任务。

## 三处联动，改触发词要一起改
1. `cordis.patch.yml`：`provider: antigravity` 必须等于插件注册的 `providerName`；`toolName: subagent_agy` 才是模型看到的工具名。
2. `locale/zh.json` + `locale/en.json`：description 里的 `agy` / `antigravity` 关键词，中英同步。
3. `%USERPROFILE%\.dsh\AGENTS.md`：真正让模型在用户说 "agy" 时选中该工具的指令（仓库外，但缺了工具不会被选中）。
- 运行期配置覆盖写在 profile 的 `cordis.patch.yml`（`- id: subagent-antigravity`）；当前部署**没有**覆盖，全部走代码默认值（含默认 `agy.exe` 路径）。

## 验证
```powershell
node --check lib/index.js; node --check lib/run.js; node --check lib/wire.js; node --check lib/classify.js; node --check lib/client.js; node --check lib/gemini-web.js   # 语法
python -m py_compile scripts/gemini_research/init_login.py scripts/gemini_research/run_research.py   # Python 语法
node --test   # 单测（33 用例；DSH 沙箱内若 spawn EPERM，用 node --test --test-isolation=none）

# 协议解析冒烟（7 字节强制分片，模拟真实 chunk 边界）：期望 completed + 文本
node -e "import('./lib/wire.js').then(({AntigravityStream})=>{const s=new AntigravityStream('t');const t=[JSON.stringify({event:'init',conversation_id:'c1'}),JSON.stringify({event:'step_update',step_update:{step_type:'agent_response',text_delta:'par'}}),JSON.stringify({event:'result',result:{status:'SUCCESS',response:'partial answer'}})].join('\n')+'\n';for(let i=0;i<t.length;i+=7)s.push(t.slice(i,i+7));s.end();console.log(s.result(),s.conversationId)})"

# 失败分类冒烟：期望 rate_limited / quota_exhausted
node -e "import('./lib/classify.js').then(({classifyFailure})=>console.log(classifyFailure('429 too many requests',{exitCode:1}),classifyFailure('quota limit exceeded',{exitCode:1}),classifyFailure('x',{exitCode:2})))"

# CLI 本身可用（未登录时会静默降级）：末帧应为 {"status":"SUCCESS",...}
& "$env:USERPROFILE\.gemini\bin\agy.exe" --print "Say OK" --output-format stream-json --new-project
```

## 让改动真的生效
- profile 里的 `node_modules/dsh-subagent-antigravity/*` 是**硬链接**到本仓库（`fsutil hardlink list <file>` 可验证）：原地改内容会同步过去，但**新增文件不会**；而整体替换文件的保存方式（原子写）会断开硬链接，profile 继续用旧副本。
- 因此改完执行：`cd $env:USERPROFILE\.dsh\profiles\desktop; pnpm install`。pnpm 要写全局 store，在 DSH 沙箱里可能被拦——那就换真实终端跑；装完重启 GUI，`subagent_agy` 才会带新代码。
