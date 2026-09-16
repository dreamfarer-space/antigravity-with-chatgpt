---
name: antigravity-with-chatgpt
description: >-
  Use this skill to consult ChatGPT's web UI as a second reasoning model
  ("cloud brain") from Google Antigravity (Antigravity 2.0 IDE / agy CLI),
  Gemini CLI, Claude Code, or any other CLI agent. Drives a dedicated isolated
  Chrome over CDP to handle complex algorithm derivation, architecture
  decisions, hard-to-diagnose bugs, code review, and refactoring advice with a
  second model. Activate when a task needs cross-model verification or a second
  opinion, or when the user says "问问GPT", "让GPT看看", "问一下ChatGPT",
  "让外脑分析", "让Sol看看", "ask ChatGPT", "second opinion".
---

# Antigravity with ChatGPT (Cloud Brain Bridge)

## 定位

**ChatGPT 是本地 Gemini Agent 的第二推理模型 / 云端外脑。**

本地 Agent（Gemini CLI、Claude Code 或任意命令行 Agent）擅长读写磁盘、跑测试、改代码，
但单模型在复杂推理上会有盲区。本 Skill 把 ChatGPT 网页版接入本地工作流：

```
Gemini / 本地 Agent
   ->  Node.js 原生桥接脚本 (ask_chatgpt.mjs)
      ->  Chrome DevTools Protocol (CDP, 127.0.0.1:9222)
         ->  专用 Chrome (独立 Profile)
            ->  ChatGPT 网页版
```

它提供：

- 复杂算法推导
- 架构决策
- 疑难 Bug 分析
- Code Review
- 重构建议
- 第二模型交叉验证

---

## CRITICAL: ChatGPT 网页端无法直接访问本机项目文件系统

> **ChatGPT 网页端无法直接访问本机项目文件系统。**

因此**绝对不能**只问：

```text
帮我检查 src/main.ts
```

因为 **ChatGPT 根本看不到它**。它只能看到你**通过脚本显式附带的文本**。

### 正确工作流

```text
Gemini
  ↓
读取本地 src/main.ts
  ↓
ask_chatgpt.mjs --attach src/main.ts "进行 Code Review"
  ↓
ChatGPT 得到完整源码
  ↓
返回分析
  ↓
Gemini 修改本地项目
```

源码非常长时，优先：

- `--file prompt.md`（把长提示词写进文件，绕过命令行长度限制），或
- 只附带**相关**的几个文件，而不是整个仓库。

---

## 目录与文件

```text
D:\ChatGPT-Brain-Bridge\
├─ chrome-profile\                             专用 Chrome 用户数据目录（认证状态只留在这里）
└─ gemini-skill\antigravity-with-chatgpt\
   ├─ SKILL.md
   └─ scripts\
      ├─ ask_chatgpt.mjs      主桥接脚本（零依赖：CDP + 极速输入 + MutationObserver 等待回复）
      ├─ mcp_server.mjs       Antigravity 2.0 原生 MCP Server（零依赖：JSON-RPC 2.0 over stdio）
      ├─ make_shortcut.mjs    重建桌面快捷方式（零依赖，纯二进制写 .lnk）
      └─ verify_install.mjs   安装自检（目录/Junction/MCP/Node/快捷方式/CDP/联通测试）
```

Gemini / Antigravity 通过 Windows Directory Junction 识别 D 盘 Skill：

```text
%USERPROFILE%\.gemini\config\skills\antigravity-with-chatgpt  ->  D:\ChatGPT-Brain-Bridge\gemini-skill\antigravity-with-chatgpt
```

重建桌面快捷方式 `ChatGPT (Antigravity智脑).lnk`：

```cmd
node "D:\ChatGPT-Brain-Bridge\gemini-skill\antigravity-with-chatgpt\scripts\make_shortcut.mjs"
node "D:\ChatGPT-Brain-Bridge\gemini-skill\antigravity-with-chatgpt\scripts\make_shortcut.mjs" --launch
```

> 说明：`make_shortcut.mjs` 会在系统里找一个目标同样为 `chrome.exe` 的既有快捷方式，
> **复用它真实的 `LinkTargetIDList`**，再套上自己的名称/参数/工作目录/图标。
> 这是必要的 —— 手写 IDList 的 shell item 编码极易让 Windows 解析不了快捷方式
> （症状：双击毫无反应）。

---

## 调用方式

### 方式 1：Antigravity 2.0 原生 MCP 工具（推荐）

在 `~/.gemini/config/mcp_config.json` 中配置完成后，Antigravity Agent 原生拥有以下 3 个 MCP 工具：

- **`ask_chatgpt`**: 直接向 ChatGPT 发起智能体推理任务
  - `prompt`: 提示词或任务目标（必填）
  - `mode`: `"ask"`（通用问答，默认）| `"plan"`（架构与任务规划）| `"review"`（闭环独立审查，自动抓取真实 Git Diff 与测试记录）| `"derive"`（纯算法/数学推导）| `"diagnose"`（故障根因排查）
  - `session`: `"reuse"`（继续当前会话，默认）或 `"new"`（开启全新会话）
  - `files`: 需要作为证据一起发送的代码文件路径列表（可选，自动进行防逃逸与脱敏）
  - `gitDiff`: 布尔值，是否注入工作区真实的 Git Diff（review / diagnose 模式默认自动开启）
  - `timeout`: 最长等待时间（秒，默认 600）
- **`record_execution`**: 记录本地命令或测试执行事实
  - `command`: 运行的命令（如 `npm test`）
  - `exitCode`: 退出码
  - `testSummary`: 测试通过/失败统计 `{ passed, failed }`
  - `notes`: 补充说明
- **`chatgpt_status`**: 探测专用 Chrome 与 ChatGPT 连接就绪状态及当前工作区

### 方式 2：CLI 脚本直接调用

脚本路径（固定）：

```text
D:\ChatGPT-Brain-Bridge\gemini-skill\antigravity-with-chatgpt\scripts\ask_chatgpt.mjs
```

#### 模式 1：通用提问 (Ask)
```cmd
node "D:\ChatGPT-Brain-Bridge\gemini-skill\antigravity-with-chatgpt\scripts\ask_chatgpt.mjs" "分析这个架构"
node "D:\ChatGPT-Brain-Bridge\gemini-skill\antigravity-with-chatgpt\scripts\ask_chatgpt.mjs" --new "开启独立新会话提问"
```

#### 模式 2：任务规划 (Plan)
```cmd
node "D:\ChatGPT-Brain-Bridge\gemini-skill\antigravity-with-chatgpt\scripts\ask_chatgpt.mjs" --plan "为当前项目设计分布式缓存架构"
```

#### 模式 3：独立审查 (Review - 自动携带真实 Git Diff 与测试证据)
```cmd
node "D:\ChatGPT-Brain-Bridge\gemini-skill\antigravity-with-chatgpt\scripts\ask_chatgpt.mjs" --review "请审查最新修改，找出潜在隐患"
```

#### 模式 4：深度推导 (Derive - 专精数学与算法，去除代码库杂音)
```cmd
node "D:\ChatGPT-Brain-Bridge\gemini-skill\antigravity-with-chatgpt\scripts\ask_chatgpt.mjs" --derive "推导卡尔曼滤波在延时观测下的递推公式"
```

#### 模式 5：故障排查 (Diagnose)
```cmd
node "D:\ChatGPT-Brain-Bridge\gemini-skill\antigravity-with-chatgpt\scripts\ask_chatgpt.mjs" --diagnose "测试偶发超时，分析可能原因"
```

#### 附加本地源码（自动防逃逸与敏感文件过滤）
```cmd
node "D:\ChatGPT-Brain-Bridge\gemini-skill\antigravity-with-chatgpt\scripts\ask_chatgpt.mjs" --attach src\main.ts src\app.ts "请进行 Code Review"
```

脚本会读取文件并按扩展名生成带语言标记的 Markdown 代码块：

```markdown
请进行严格 Code Review

## File: src/main.ts

```typescript
...
```

## File: src/app.ts

```typescript
...
```
```

支持的扩展名映射（节选）：`.ts → typescript`、`.tsx → tsx`、`.js → javascript`、`.py → python`、
`.rs → rust`、`.cpp → cpp`、`.c → c`、`.java → java`、`.json → json`、`.md → markdown`、
`.css → css`、`.html → html`；未知类型使用无标记代码块。

**提示词写在文件列表之后**（如上例）。脚本靠"是否像文件路径"自动切分边界，
不会把提示词误当成文件。单个附带文件上限 256 KB，二进制/媒体/压缩/数据库类扩展名直接拒收。

#### 模式 D：超长提示词

```cmd
node "D:\ChatGPT-Brain-Bridge\gemini-skill\antigravity-with-chatgpt\scripts\ask_chatgpt.mjs" --file D:\temp\prompt.md
node "D:\ChatGPT-Brain-Bridge\gemini-skill\antigravity-with-chatgpt\scripts\ask_chatgpt.mjs" --new --file prompt.md
```

### 诊断

```cmd
node "D:\ChatGPT-Brain-Bridge\gemini-skill\antigravity-with-chatgpt\scripts\ask_chatgpt.mjs" --doctor
```

`--doctor` 会逐项检查 Node 版本、全局 WebSocket/fetch、目录、chrome.exe、CDP 9222、
ChatGPT 页面、输入框 / 发送按钮 / 停止按钮 / Assistant 节点的选择器命中情况，以及登录状态。

### 安装自检（部署/排障时用）

```cmd
node "D:\ChatGPT-Brain-Bridge\gemini-skill\antigravity-with-chatgpt\scripts\verify_install.mjs"
node "D:\ChatGPT-Brain-Bridge\gemini-skill\antigravity-with-chatgpt\scripts\verify_install.mjs" --run-test
```

校验目录、SKILL.md、脚本、Junction 指向、MCP 配置、Node 版本、桌面快捷方式的 4 个必需启动参数、
CDP 9222；加 `--run-test` 会额外跑一次真实联通测试。

---

## 输出约定（Agent 集成要点）

| 通道 | 内容 |
| --- | --- |
| **stdout** | 正常成功时**只有** ChatGPT 的最终回复文本 |
| **stderr** | 所有日志、警告、诊断、错误 |
| **exit 0** | 成功 |
| **exit 2** | 用法 / 配置错误（含 Node 版本过低） |
| **exit 3** | CDP / 页面 / 选择器问题 |
| **exit 4** | 需要用户手动登录 |
| **exit 5** | 等待回复超时 |
| **exit 6** | 文件问题（不存在 / 二进制 / 过大） |

因此本地 Agent 可以直接这样捕获结果：

```cmd
node ask_chatgpt.mjs "..." > answer.md
```

`--json` 会输出 `{ "ok": true, "text": "...", "url": "...", "elapsedMs": N }`，便于程序化解析。
`--out <path>` 可额外把结果落盘。

### 项目锁定

设置环境变量后，Bridge 会优先进入并**尽量停留在**该地址：

```powershell
$env:CHATGPT_BRAIN_URL="https://chatgpt.com/g/g-xxx/project"
```

没有这个变量时使用 `https://chatgpt.com/`。设置后 `--new` 也会在**该项目范围内**开启新会话，
不会跳到用户其他项目、历史私人会话或侧边栏其他聊天。

---

## 自动触发条件

本地 Agent 遇到以下情况时，**可以主动调用** ChatGPT Brain Bridge：

### 1. 复杂算法

数学推导、控制算法、优化算法、机器学习、深度学习、机器人算法。

### 2. 架构决策

软件架构、前后端架构、数据流设计、API 设计、数据库设计、Agent 系统设计。

### 3. 疑难 Bug

- 已经反复排查但原因不明
- Race Condition
- 状态同步问题
- 网络异常
- 性能异常
- 编译器 / 构建系统问题

### 4. Code Review

安全检查、可维护性、性能、边界条件、重构建议。

### 5. 用户显式要求

只要用户说：

```text
问问GPT
让GPT看看
问一下ChatGPT
让外脑分析
让Sol看看
```

即立刻调用。

---

## 外脑调用策略

用户**允许本地 Agent 主动调用** ChatGPT Brain Bridge。
对于复杂开发任务，**无需每一次调用前重新向用户确认**。

允许进行多轮技术讨论：

```text
Gemini → ChatGPT
ChatGPT → Gemini 分析
Gemini → ChatGPT 追问
ChatGPT → Gemini 最终实现
```

**但不得声称或尝试：**

- 绕过 ChatGPT 产品限制
- 绕过账号限制
- 绕过额度限制
- 绕过安全机制

---

## 并行双脑工作流（推荐）

```text
任务开始
   │
   ├── Gemini：读取项目和环境
   │
   ├── Gemini：搭建测试 / 骨架 / 复现 Bug
   │
   └── ChatGPT Brain Bridge：分析架构 / Review / 推导
             │
             ▼
      ChatGPT 输出结果
             │
             ▼
      Gemini 整合建议
             │
             ▼
      修改本地代码
             │
             ▼
      本地构建 / 测试
             │
             ▼
      必要时再次询问 ChatGPT
```

如果 Agent 的执行环境允许子进程异步运行，可以：

1. 启动 Brain Bridge（后台子进程）；
2. 同时继续本地测试；
3. 稍后等待子进程结束；
4. 收集 ChatGPT 回复；
5. 整合结果。

> **注意**：不要声称 Brain Bridge 可以脱离 Agent 进程"永久后台工作"。
> 它依赖专用 Chrome 一直开着；Chrome 关掉后必须重新启动。

---

## 在 Antigravity (AGY IDE / agy CLI) 里使用

Antigravity 的**全局自定义根目录就是 `~/.gemini/config/`**：
- 技能位置：`~/.gemini/config/skills/antigravity-with-chatgpt/SKILL.md`
- MCP 服务配置：`~/.gemini/config/mcp_config.json`

本 Skill 已经通过 Windows Directory Junction 挂载在全局技能目录：

```text
C:\Users\<你>\.gemini\config\skills\antigravity-with-chatgpt
   -> D:\ChatGPT-Brain-Bridge\gemini-skill\antigravity-with-chatgpt
```

且已在 `~/.gemini/config/mcp_config.json` 中配置了原生的 `antigravity-with-chatgpt` MCP Server 服务：

```json
{
  "mcpServers": {
    "antigravity-with-chatgpt": {
      "command": "node",
      "args": [
        "D:\\ChatGPT-Brain-Bridge\\gemini-skill\\antigravity-with-chatgpt\\scripts\\mcp_server.mjs"
      ]
    }
  }
}
```

因此在 Antigravity 2.0 中，你可以通过 Skill 命令行脚本或 MCP 工具无缝调用 ChatGPT 外脑。

### 在 Antigravity 里怎么触发

Antigravity 的主 Agent 读 `description` 决定是否激活。所以在 Antigravity 里直接说：

```text
让外脑 review 一下 src/auth.ts
问问GPT 这个并发方案有没有问题
让Sol看看这段算法
```

或者干脆提出一个复杂架构 / 疑难 Bug 问题，主 Agent 会自己判断要不要调外脑。

### 发现优先级（Antigravity 规则，高 → 低）

1. **工作区**：从 CWD 一路向上到 repo 根找 `.agents/`（或 `.agent/`、`_agents/`、`_agent/`）下的 `skills/`
2. 工作区显式声明：`skills.json`
3. **全局发现：`~/.gemini/config/`** ← 本 Skill 在这里
4. 内置技能（`builtin/skills/`，由应用按名字挂载）
5. 全局显式声明

即「工作区 > 全局」。想让某个项目覆盖本 Skill，在项目根的
`.agents/skills/antigravity-with-chatgpt/` 放一份即可（同名时工作区版本胜出）。

### 终端权限

Antigravity 执行 `node "D:\...\ask_chatgpt.mjs" ...` 时第一次会弹权限确认，选
**Always allow** 即可。不要手动去改 `~/.gemini/config/config.json` 的
`globalPermissionGrants` —— 那个文件由运行中的应用持有，手改容易被覆盖。

### 让 Antigravity 并行跑双脑

Antigravity 支持后台任务 / 子 Agent，推荐这样组合：

1. 先把桥接挂到后台跑，结果落盘：
   `node "D:\...\ask_chatgpt.mjs" --attach src\a.ts "review" > .brain-answer.md`
2. Antigravity 同时继续本地读代码、改实现、跑测试；
3. 稍后读回 `.brain-answer.md`，把 ChatGPT 的建议整合进代码。

注意：桥接依赖专用 Chrome 一直开着，**不能脱离 Agent 进程永久后台工作**。

---

## 前置条件与 Auto-Healing

脚本运行时**首先**访问：

```text
http://127.0.0.1:9222/json/version
```

- **已经在跑** → 直接连接。
- **没在跑** → 自动寻找 chrome.exe，然后静默启动：

```cmd
chrome.exe ^
--remote-debugging-port=9222 ^
--remote-debugging-address=127.0.0.1 ^
--remote-allow-origins=* ^
--user-data-dir="D:\ChatGPT-Brain-Bridge\chrome-profile" ^
https://chatgpt.com
```

随后循环等待 `127.0.0.1:9222` 就绪（带超时、重试、清晰错误输出，**不会无限死循环**）。

### 需要用户手动登录时

Desktop 快捷方式 **`ChatGPT (AI智脑)`** 打开的专用 Chrome 如果尚未登录，脚本会：

1. 打开该专用 Chrome；
2. **停止自动化**；
3. 提示用户：

```text
请在这个专用 Chrome 中手动登录一次你的 ChatGPT 账号。
登录完成后不要关闭窗口，然后回来继续测试。
```

**绝对不要尝试自动填写**用户名、密码、验证码、2FA。

> **注意**：ChatGPT **未登录时的首页同样有可用的输入框和发送按钮**，
> 所以"输入框存在"≠"已登录"。脚本会在发送前检查未登录标志
> （`login-button`、`Log in` / `Sign up` 文案元素），并在发送后持续监听是否被
> 重定向到 `accounts.google.com` / `auth.openai.com` 等身份提供方；
> 一旦命中立刻以 exit 4 停止并给出登录指引，不会傻等到超时。
>
> 另外，如果专用 Chrome 里已经有一个停留在登录页的标签，脚本**不会再开新标签**，
> 而是直接提示你去那个窗口完成登录。

---

## 安全红线（最高优先级）

### 1. 绝对零删除

严禁操作任何 `Delete / 删除 / Archive / 归档 / Clear / 清空 / Remove` 等历史数据相关按钮。

不得：

- 删除会话
- 删除项目
- 清空历史
- 归档历史
- 操作侧边栏聊天菜单
- 批量整理历史记录

**脚本本身就没有实现这些能力。**

### 2. 禁止获取身份凭证

Bridge 只能利用用户**已经手工登录**的专用 Chrome 页面。禁止：

- 提取 ChatGPT Cookie
- 导出 LocalStorage Token
- 输出 Authorization Token
- 复制 Session
- 读取保存密码
- 将凭证写入文件

浏览器认证状态只允许留在：

```text
D:\ChatGPT-Brain-Bridge\chrome-profile
```

### 3. 与日常 Chrome 完全隔离

- 专用 Profile 位于 `D:\ChatGPT-Brain-Bridge\chrome-profile`，与日常 Chrome 完全隔离
- 不修改日常 Chrome Profile
- 不读取日常 Chrome Cookies
- 不关闭日常 Chrome
- CDP 只监听 `127.0.0.1:9222`，**不监听 `0.0.0.0`**

### 4. 零 npm 依赖

脚本只用 Node.js 内置能力：`fetch`、`WebSocket`、`fs`、`path`、`child_process`、`process`、`timers`。

严禁安装：Puppeteer、Playwright、Selenium、Axios、第三方 WebSocket 包。

需要 **Node.js 22+**（全局 WebSocket）。版本不足时脚本会明确提示升级 Node.js，
**而不是偷偷安装依赖**。

---

## 常见故障排查

| 现象 | 先做什么 |
| --- | --- |
| `exit 4` / 提示登录 | 双击桌面 `ChatGPT (AI智脑)`，手动登录后重跑 |
| `exit 3` 等不到 CDP | `netstat -ano \| findstr :9222`；手动跑快捷方式看 Chrome 是否弹窗 |
| `exit 3` 输入框未命中 | `--doctor`，看输入框/发送按钮选择器命中情况（ChatGPT 改版） |
| `exit 3` 插入后仍为空 | 同上；确认 `#prompt-textarea` 是否存在，必要时更新选择器表 |
| `exit 5` 超时 | 加大 `--timeout 1200`；看 stderr 里的超时诊断与部分内容 |
| `exit 6` 附带文件被拒 | 该文件是二进制/媒体/压缩/数据库，或超过 256 KB 上限 |

脚本使用 `Input.insertText` 一次性输入全文（**不逐字符模拟键盘**），
对中文、Markdown、超长文本、代码都更可靠。

发送消息时优先点击真实的 Send 按钮（多组 fallback：`data-testid`、`aria-label`、`form button[type=submit]`），
找不到可靠按钮时才回退到 `Input.dispatchKeyEvent` 模拟 Enter。
**绝不做模糊匹配去点页面上其他按钮。**

判断回复完成的条件（三者同时满足）：

1. 停止生成按钮已消失；
2. Assistant 文本非空；
3. 最后一条 Assistant 回复连续 3 次读取内容完全一致（每次间隔 800~1500 ms）。

总超时默认 600 秒（10 分钟），可用 `--timeout` 调整。

---

## 全部参数

```
--new                新建会话（仅导航到首页/锁定项目，不删除任何历史）
--attach <files..>   附带本地源码文件（自动识别语言、拒绝二进制）
--file <path>        从文件读取完整提示词（绕过命令行长度限制）
--url <url>          本次锁定到指定 ChatGPT 项目/页面 URL
--timeout <seconds>  总超时，默认 600
--out <path>         额外把结果写入文件
--json               以 JSON 输出结果
--debug              打印调试日志到 stderr
--doctor             自检 / 诊断
```

环境变量：`CHATGPT_BRAIN_URL`、`CHATGPT_BRAIN_PORT`、`CHATGPT_BRAIN_DEBUG`、`CHROME_PATH`。
