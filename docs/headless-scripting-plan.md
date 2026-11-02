# Headless 脚本化结合方案（dsh-subagent-antigravity）

> 基于对本地 `agy --help` / `agy models` 的实测，以及 `lib/*.js` 真实源码。
> 结论：调研里约一半内容基于「另一个 CLI / 旧版 Gemini CLI」的假设，不能照搬。

## 0. 结论速览

- 本插件**已经是**「headless 脚本化调用 agy」的正确实现：`agy --print --output-format stream-json --new-project` + NDJSON 帧解析，比调研里的 Python/TS `execFile` + ANSI 剥离更干净。
- 真正值得嫁接的只有 4 个「利用 CLI 原生能力」的点：**超时、模型名纠正、结构化输出、附加目录**；配额降级可选。
- 调研的 `--cd`、ANSI 剥离、旧模型名、`--dangerously-skip-permissions` 判断、Python Tool 包装，均应丢弃或改写。

## 1. 调研事实核对（对照 `agy --help` 实测）

| 调研说法 | 实测结果 | 处理 |
|---|---|---|
| `-p/--prompt` 单次注入 | ✅ 存在（`-p` 是 `--print` 短别名，`--prompt` 是别名） | 已用 `--print` |
| `--dangerously-skip-permissions` 顶层标志 | ✅ **确实存在**（顶层），插件也已正确传它 | 保留，无需改 |
| `--model gemini-2.0-pro-exp / flash` | ❌ 该模型名不存在。实测：`gemini-4-argon-{low,medium,high}`、`gemini-3.8-flash-*`、`claude-opus-5-5-*`、`claude-sonnet-5-5-*`、`gpt-oss-120b-medium` | 纠正文档/示例 |
| `--cd <dir>` 设工作区 | ❌ **没有 `--cd`**。cwd 靠进程工作目录；另有 `--add-dir` 追加目录、`--project` 指定项目 | 用 spawn cwd（现有）/ 可选 `--add-dir` |
| `NO_COLOR=1` / `TERM=dumb` 禁 ANSI | 部分。用 `--output-format stream-json` 时输出是 NDJSON，本就无渲染转义 | 主输出无需；stderr 可选清理 |
| 正则剥 ANSI | ❌ 对 stream-json 路径是多余的 | 不采纳（主输出） |
| Python/TS `execFile` 包成 Tool 节点 | ❌ 与现有 cordis provider 架构重复，插件已是原生 provider | 不采纳 |
| 超时控制（外部 kill） | ✅ 但 CLI **自带** `--print-timeout`（Go duration，默认 0=无限等） | 优先用原生参数 |
| 会话隔离（独立 cwd） | ✅ 现有 `--new-project` + 每 run 独立 cwd 已做到 | 保留；需要更强用 `--project` |
| Linux Keyring / dbus 坑 | 仅 Linux 无头场景；本部署是 Windows `agy.exe`，走 Windows 凭据管理器 | 跨平台部署时再提 |

## 2. 插件现状（已具备，不要重造）

- `lib/run.js#antigravityArgv`：拼 `--print <prompt> --output-format stream-json --new-project [--model] [--effort] (--dangerously-skip-permissions | --mode auto) + extraArgs`。
- `lib/run.js#startAntigravityRun`：spawn 子进程、收流、`settleRunResult`、终止清理（`disposeGraceMs` 三档宽限）。
- `lib/wire.js#AntigravityStream`：NDJSON 切帧、终态 `result.response` 优先、`text_delta` 兜底、status→`completed/aborted/error`。
- `lib/index.js`：`Config`（providerName/executable/model/effort/env/permissionMode/extraArgs/disposeGraceMs）+ `AntigravityProvider`。
- 关键设计约束：`NO_START_CAPABILITIES`、`inheritsParentContext=false` → **一次性委派，无 follow-up**；`permissionMode` 默认 `dangerously-skip-permissions`（print 模式唯一能读工作区的值）。

## 3. 可落地的结合点（按优先级）

### A. 原生超时 `--print-timeout`（高价值 / 低风险 / 小工作量）
- 现状：`Config` 未暴露超时；CLI 默认 0=无限等待，卡死只能靠外层 abort。
- 改法：
  - `lib/index.js` `Config` 增 `printTimeout`：`z.string()`（Go duration，如 `"180s"`、`"10m"`），可选。
  - `lib/types/index.d.ts` 同步加字段。
  - `lib/run.js#antigravityArgv`：`...(spec.printTimeout ? ['--print-timeout', spec.printTimeout] : [])`。
- 好处：用 CLI 自身超时，干净、可被终态帧表达；不必自己 kill 进程。

### B. 模型名纠正（中价值 / 零风险 / 小工作量）
- 把 README / 示例 / 注释里的 `gemini-2.0-*` 换成实测真实名（见上表）。
- 注意：真实模型名自带档位后缀（`-low/-medium/-high`），而 CLI 又有独立 `--effort`。二者叠加关系需实测确认；文档里要提示「`--effort` 与模型名档位可能互相覆盖」。
- `Config.model` 默认仍留空（继承 CLI 设置）是有意设计，不要强塞默认值。

### C. 结构化输出 `--json-schema`（中价值 / 低风险 / 小工作量）
- `Config` 增 `jsonSchema`（内联 JSON 字符串或文件路径）+ types 同步；argv 追加 `--json-schema <value>`。
- 适合「要 agy 返回固定结构」的委派；wire 层已对最终 result 解析，能直接拿到结构化内容。

### D. 附加目录 `--add-dir`（中低价值 / 低风险 / 小工作量）
- `Config` 增 `addDirs`（`string[]`）→ 逐个 `--add-dir`。
- 让 agy 访问工作区之外的只读目录，不必把 cwd 挪到公共父目录。

### E. stderr ANSI 清理（低价值 / 零风险 / 极小工作量）
- `lib/index.js#startAntigravityRun` 的 `writeStderr` 回调里，先 `stripAnsi` 再 `process.stderr.write`，避免日志被转义码污染。

### F. 配额/限流检测与降级重试（已评估：默认不自动重试，只做诊断识别）

**评估结论（基于联网案例）**：值得做「识别」，不建议默认「自动重试」。

- 真实错误形态：`Model quota limit exceeded...`、`⚠ Individual quota reached. Resets in XhYmZs.`、`429` rate limit；CLI 另有 `/usage`(`/quota`) 命令可查配额。
- print 模式**用法错误 exit 2**；且 1.1.28+ **`--print-timeout` 超时以 exit 0 返回部分输出**——退出码与 JSON 必须一起看。
- 自动降级的风险：one-shot 语义下重试会翻倍配额；若配额是账号级耗尽，换模型（同属 Antigravity 配额池）多半仍失败。
- 建议实现（v2，opt-in）：
  1. 在诊断层给错误打标签：`rate_limited`（可解析 retry-after/重置时间时）vs `quota_exhausted` vs `usage_error`(exit 2)。
  2. `Config` 增 `fallbackModel`（仅显式配置才生效）与 `retryOnRateLimit`（429 且可解析短重置时间时退避重试 1 次）。
  3. 默认关闭；只把 `quota_exhausted` 作为明确诊断上报，交上层决策。

## 4. 明确不采纳（附原因）

- `--cd`：CLI 无此参数 → 用 spawn cwd（现有）或 `--add-dir`。
- Python/TS `execFile` 包成 Tool 节点：与 cordis provider 重复；插件就是官方 provider 形态。
- 主输出 ANSI 剥离：`stream-json` 输出是 NDJSON，无 ANSI；只有 `--output-format text` 才需要。
- `--input-format stream-json` 多轮：与 one-shot provider / `NO_START_CAPABILITIES` 架构冲突；除非改造成长连接，不建议。
- Linux keyring/dbus：本 Windows 部署无此问题，仅跨平台时补文档。
- 旧模型名：不存在，按 `agy models` 实测替换。

## 5. 验证方法

```powershell
node --check lib/index.js; node --check lib/run.js; node --check lib/wire.js
# wire 冒烟（见 AGENTS.md 的 7 字节分片用例，期望 completed + 文本）
# 真实 CLI 冒烟，末帧应为 {"status":"SUCCESS",...}
& "$env:USERPROFILE\.gemini\bin\agy.exe" --print "Say OK" --output-format stream-json --new-project
# 生效：cd $env:USERPROFILE\.dsh\profiles\desktop; pnpm install; 重启 GUI（注意硬链接，原子写会断链）
```

## 6. 优先级与工作量

| 项 | 价值 | 风险 | 工作量 | 建议 |
|---|---|---|---|---|
| A 超时 `--print-timeout` | 高 | 低 | 小 | 先做 |
| B 模型名纠正 | 中 | 无 | 小 | 先做（文档） |
| C `--json-schema` | 中 | 低 | 小 | 次做 |
| D `--add-dir` | 中低 | 低 | 小 | 次做 |
| E stderr ANSI | 低 | 无 | 极小 | 顺手 |
| F 配额降级 | 中 | 中 | 中 | v2 或只做诊断 |

---

## 7. 参考案例（联网）

- Antigravity Lab：Running Antigravity CLI Headless（exit codes / idempotency / timeouts / output parsing）
  https://antigravitylab.net/en/articles/integrations/antigravity-cli-headless-non-interactive-ci-design
- Antigravity Lab 相关文章：1.1.28 起 `--print-timeout` 超时以成功退出（部分输出）
- Antigravity CLI `/usage`(/quota) 命令：https://antigravity.google/docs/cli/commands/usage/
- Google AI Dev Forum：Persistent 429 / Model quota limit exceeded：https://discuss.ai.google.dev/t/antigravity-paid-tier-1-not-recognized-persistent-429-rate-limit-errors-on-project/116558
- GitHub gemini-cli discussion #27307（Individual quota reached, resets in ...）：https://github.com/google-gemini/gemini-cli/discussions/27307
- Reddit：Why does Antigravity CLI burn through quotas：https://www.reddit.com/r/GeminiCLI/comments/1tlqd44/why_does_antigravity_cli_burn_through_quotas_so/
