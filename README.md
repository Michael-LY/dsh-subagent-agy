# dsh-subagent-antigravity

把一次性任务委派给本机 **Antigravity CLI（`agy`）** 的 DSH 子智能体插件。

与官方 `dsh-subagent-codex` / `dsh-subagent-claude-code` 同构：注册一个外部
（one-shot）subagent provider，再由 `@deepseek-ai/dsh-tool-subagent` 挂出一个
模型可见工具 `subagent_agy`（触发词：**agy** 或 **antigravity**，不区分大小写）。

工具本身不能「听」关键词——关键词是模型对工具的选择依据，因此触发词需要两处落地：

1. **插件侧**（本仓库）：`locale/zh.json`、`locale/en.json` 的 `description` 列出 `agy`、`antigravity`，
   它们是插件在设置 / 市场里的展示文案。
2. **指令侧**（`~/.dsh/AGENTS.md`）：写明 `agy` 与 `antigravity` 都指向 `subagent_agy`，
   模型在系统提示里读到后才真正会在用户说这两个词时调用该工具。

## 协议选型

Antigravity 没有 app-server / SDK 协议，只有 CLI。因此本插件走 **print + stream-json**：

```
agy --print <prompt> --output-format stream-json --new-project [--model M] [--effort E] [--dangerously-skip-permissions | --mode auto]
```

stdout 为逐行 NDJSON，插件只消费三种 envelope：

| event | 用途 |
|---|---|
| `init` | 记录 `conversation_id` |
| `step_update` (`step_type: agent_response`) | 累积 `text_delta` 作为兜底答案 |
| `result` | **权威答案**：`status` + `response` |

`--new-project` 保证每次委派是全新会话，不污染、不复用用户已有的 Antigravity 项目。

## 配置

```yaml
- id: subagent-antigravity
  name: dsh-subagent-antigravity
  config:
    executable: 'C:/Users/<you>/.gemini/bin/agy.exe'    # 默认 %USERPROFILE%/.gemini/bin/agy.exe
    model: gemini-4-argon-high                          # 可选，取值来自 `agy models`
    effort: high                                        # low|medium|high|xhigh|max，可选
    permissionMode: dangerously-skip-permissions        # 默认 | auto
    printTimeout: 180s                                   # 可选，--print-timeout（Go duration；省略=等到本轮结束）
    jsonSchema: ''                                       # 可选，--json-schema（内联 JSON 或文件路径）
    addDirs: []                                          # 可选，--add-dir 追加工作目录
    extraArgs: []                                       # 追加参数
    env: {}                                             # 追加环境变量
    disposeGraceMs: 3000
```

`agy models` 列出的 id 自带档位后缀（如 `gemini-4-argon-high`）；`model` 省略则用 CLI 当前设置。

`permissionMode`：
- `dangerously-skip-permissions`（默认）→ `--dangerously-skip-permissions`。
  print 模式下所有工具确认都会被软拒，不跳过权限的子级读不了工作区，
  所以这是唯一能真正干活的取值；代价是子级对本机有完全权限。
- `auto` → `--mode auto`，保留权限边界，只适合完全不需要工具的纯问答 prompt。

## 已知限制

- **一次性执行**：Antigravity 没有后续消息通道，子级不接受 `send_message`，只能看结果。
- **不继承父上下文**：子级是全新进程，prompt 必须自包含。
- **能力集为 `NO_START_CAPABILITIES`**：不支持 `agentOptions`（子模型路由由本插件 `model` 配置决定）、
  `outputSchema`、`agentPreset`、`depthLimit`。工具侧因此配 `maxDepth: provider-managed`。
- **需要先登录 Antigravity**：未登录时 `agy` 可能仍返回兜底答案，但能力/模型会静默降级。
  插件不会替你判断登录状态，建议先跑一次 `agy --print "hi"` 确认。
- **日志会写用户目录**：`agy` 会尝试写 `~/.gemini/antigravity-cli/{log,crashes}`；
  在 DSH 沙箱下写被拒时它只打 warning，不影响运行。
- **`--print-timeout` 语义（1.1.28+）**：超时到期会返回**部分输出并以 exit 0 成功退出**，不是失败。
  因此 `printTimeout` 只是兜底截断，不能据此判断任务是否真正完成；需要严格完成判定时请结合结果内容校验。
- **退出码与输出一起看**：print 模式用法错误为 exit 2；配额/限流另有表现。插件以终态 `result` 帧与退出码共同判定，不单凭一个信号下结论。

## 安装状态

已经在 `~/.dsh/profiles/desktop`（本机在用的 profile）里装好并启用：

- `dependencies` 里有 `"dsh-subagent-antigravity": "file:C:/Users/moyi_/Documents/Claude-Mok/dsh-subagent-antigravity"`
- `dsh.profile.bundles` 里有 `"dsh-subagent-antigravity"`

改完本仓库后需要重新同步一次：

```bash
cd ~/.dsh/profiles/desktop
pnpm install
```

profile 里 `node_modules/dsh-subagent-antigravity/*` 是**硬链接**到本仓库
（`fsutil hardlink list lib/run.js` 可验证）：改已有文件的内容会直接同步过去，
但**新增文件不会**，并且整体替换文件的保存方式（原子写）会断开硬链接。
所以新增文件、或想确认 profile 里是最新代码时，跑一次 `pnpm install`。

DSH 的文件沙箱会拦住 pnpm 写全局 store，若在 DSH 内失败就换真实终端跑。
装完重启 GUI，`subagent_agy` 才带新代码。

## 验证

```bash
# 1. 语法（仓库没有构建/测试，这是唯一必需的一步）
node --check lib/index.js && node --check lib/run.js && node --check lib/wire.js

# 2. CLI 本身能跑（参数与插件默认一致）
"C:/Users/moyi_/.gemini/bin/agy.exe" --print "Say OK" --output-format stream-json --new-project --dangerously-skip-permissions

# 3. 期望看到以 {"event":"result",...} 结尾、status 为 SUCCESS
```

已验证：上述命令在本机返回 `{"status":"SUCCESS","response":"OK\n"}`，
且 `lib/wire.js` 对真实输出（按 7 字节强制分片）能正确重组帧并提取答案——
协议层的最小冒烟命令见 `AGENTS.md` 的「验证」段。