<div align="center">

<img src="./assets/banner.png" alt="antigravity-with-chatgpt Banner" width="100%" />

# 🚀 antigravity-with-chatgpt

**纯原生、零 npm 依赖的 Antigravity 2.0 / Gemini 云端双脑协同与独立审查架构**

*将您登录的 ChatGPT Web 个人账号具备的高级推理与深度思考能力，作为本地 Google Antigravity 2.0 IDE 的独立云端“外脑”与交叉验证模型*

[![CI](https://github.com/dreamfarer-space/antigravity-with-chatgpt/actions/workflows/ci.yml/badge.svg)](https://github.com/dreamfarer-space/antigravity-with-chatgpt/actions/workflows/ci.yml)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Dependencies](https://img.shields.io/badge/Dependencies-0%20(Pure%20Native)-brightgreen)](#-核心特性)
[![MCP](https://img.shields.io/badge/MCP-JSON--RPC%202.0%20stdio-orange)](https://modelcontextprotocol.io/)
[![Antigravity](https://img.shields.io/badge/Antigravity-2.0%20Compatible-purple)](#-在-antigravity-20-中配置-mcp)

[English](./README.md) | [中文说明](./README_CN.md)

</div>

---

## 📖 项目背景与设计哲学

在现代 AI Agent 辅助编程中，本地 Agent（如 **Google Antigravity 2.0 IDE**、Gemini CLI、Claude Code）具备极强的本地操作权限（文件读写、构建编译、测试运行、Git 提交）。然而在面对极端复杂的系统重构规划、深奥的数学算法推导、Bug 根因排查以及客观的代码审查时，单模型的上下文容易产生幻觉或自圆其说。

借鉴社区著名的 `XiaoDuoYa/codex-with-chatgpt`（**“ChatGPT thinks. Codex works.”**）架构思想，并融合了 ChatGPT 深度代码审查提出的 38 项改进方案，本项目构建了 **Proxy-Pull Context Broker（代理式上下文经纪人）** 模式：

- **执行权归本地（Antigravity Owns Local Execution）**：文件读写、Shell 终端、单元测试严格属于本地 Antigravity Agent；
- **思考与审查归云端（ChatGPT Owns Reasoning & Review）**：高阶规划、纯脑力推导与闭环交叉审查委托给 ChatGPT 网页版；
- **本地会话复用（Local Session Reuse）**：复用独立 Chrome Profile 中已登录的个人 ChatGPT 网页会话（Free / Plus / Pro），无需单独申请 API Key，严格在正常个人 Web 会话范畴内运行；
- **零 npm 依赖（Zero Dependencies）**：纯 Node.js 22+ 原生标准库（原生 WebSocket、Fetch、Crypto、ChildProcess），秒级启动，零第三方 npm 运行时依赖攻击面。

---

## 🌟 核心特性

- ⚡ **毫秒级极速注入**：采用 `execCommand('insertText')` + Base64 编码，绕过海量单字符输入事件，万字提示词 5ms 内极速注入 ProseMirror。
- 🛡️ **纵深防御型本地安全边界（Defense-in-Depth Local Security Boundary）**：
  - **`path_guard.mjs`**：跨平台原生路径相对化计算，拦截 `../` 目录逃逸、NUL 字符注入及符号链接（Symlink）越界；
  - **`sensitive.mjs`**：严格拦截 `.env*`、私钥、证书；外发前自动对 OpenAI Key、GitHub Token、AWS 凭据、Bearer Token 进行全局脱敏；
  - **`egress sanitizer`**：确保所有跨越浏览器边界的上下文（包括 Git Diff、测试输出日志）全部强制经过终极脱敏。
- 🔄 **闭环独立审查（Closed-Loop Review）**：
  - 自动抽取受预算控制的 `git diff` 与单元测试运行证据；
  - 强制防奉承机制：若缺少真实证据，ChatGPT 将客观拒绝盲目批准，给出具体的 `[CHANGES REQUESTED]` 或 `[APPROVED]` 判定报告。
- 🔒 **并发排队互斥锁（Single-Flight Mutex）**：
  - 内置 `AsyncMutex`，对同一 Chrome 实例的所有 Agent 请求实施严格串行化排队，彻底杜绝并发请求导致的 DOM 串话与消息错乱。
- 🎯 **五大专业工作模式**：
  1. `ask`：日常通用技术答疑与追问；
  2. `plan`：输出结构化 RATIONALE、ACTIONS、RISKS 与 CRITERIA；
  3. `review`：闭环代码审查真实 Git Diff 与测试日志；
  4. `derive`：纯算法与数学推导（默认过滤代码文件，免受杂音干扰）；
  5. `diagnose`：故障定位与根因排查。

---

## 🏗️ 四层系统架构

```
┌─────────────────────────────────────────────────────────┐
│                 Antigravity 2.0 / Gemini                │
└───────────────────────────┬─────────────────────────────┘
                            │ JSON-RPC 2.0 stdio / CLI
┌───────────────────────────▼─────────────────────────────┐
│ 1. 接入层 (scripts/)                                     │
│    - ask_chatgpt.mjs: 极简 CLI 入口                      │
│    - mcp_server.mjs: Antigravity 2.0 原生 MCP 服务       │
├─────────────────────────────────────────────────────────┤
│ 2. 调度与协议层 (src/brain/)                             │
│    - orchestrator.mjs: Proxy-Pull 架构，出口统一脱敏     │
│    - prompts.mjs: [ANTIGRAVITY-BRIDGE/1] 5 大结构化模式 │
├─────────────────────────────────────────────────────────┤
│ 3. 数据面与安全审计层 (src/security/, src/workspace/, ...)│
│    - path_guard.mjs: 原生相对路径收敛与 Symlink 防护    │
│    - sensitive.mjs: 密钥正则掩码与 .env 阻断            │
│    - ignore.mjs: .brainignore 模式解析器                │
│    - context_provider.mjs: 只读文件切片与工作区上下文   │
│    - git_helper.mjs: 只读 Git 状态与预算约束 Diff       │
│    - recorder.mjs: 本地命令执行与测试证据记录器         │
├─────────────────────────────────────────────────────────┤
│ 4. 传输层 (src/transport/)                               │
│    - cdp_transport.mjs: 零依赖纯原生 CDP 驱动 (端口 9222)│
│      * AsyncMutex 单飞行并发排队隔离                    │
│      * Base64 快速 DOM 注入                             │
│      * 双哈希多采样 + MutationObserver Quiet 结束判定   │
│      * 事件驱动 WebSocket 生命周期与断开清理            │
└───────────────────────────┬─────────────────────────────┘
                            │ Chrome DevTools Protocol
┌───────────────────────────▼─────────────────────────────┐
│ 独立隔离 Profile Chrome 实例 (127.0.0.1:9222)           │
│ └── ChatGPT 网页版 (https://chatgpt.com/)               │
└─────────────────────────────────────────────────────────┘
```

---

## 🛠️ 在 Antigravity 2.0 中配置 MCP

Antigravity 2.0 原生支持通过标准 Model Context Protocol (MCP) 加载外部工具。

### 第一步：环境要求
- **Node.js**：版本 `>= 22.0.0`（利用原生支持的全局 `WebSocket` 与 `fetch`，无需安装任何 npm 包）。
- **Google Chrome**：正常安装的 Google Chrome 浏览器。

### 第二步：启动独立隔离的 ChatGPT Chrome 会话
为避免污染您日常使用的 Chrome，本项目使用专用数据目录（默认为 `~/.antigravity-with-chatgpt/chrome-profile` 或自定义路径）运行独立 Chrome，并开放本地 CDP 调试端口 `9222`：

**Windows PowerShell 启动命令：**
```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --remote-debugging-address=127.0.0.1 `
  --remote-allow-origins=* `
  --user-data-dir="$HOME\.antigravity-with-chatgpt\chrome-profile" `
  https://chatgpt.com
```

**macOS Terminal 启动命令：**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --remote-allow-origins=* \
  --user-data-dir="$HOME/.antigravity-with-chatgpt/chrome-profile" \
  https://chatgpt.com
```

**Linux Bash 启动命令：**
```bash
google-chrome \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --remote-allow-origins=* \
  --user-data-dir="$HOME/.antigravity-with-chatgpt/chrome-profile" \
  https://chatgpt.com
```

> **提示**：首次启动后，请在弹出的专用 Chrome 窗口中完成一次常规 ChatGPT 网页登录。登录会话 Cookie 将保存在独立 Profile 目录中，在常规会话有效期内无需重复登录。
>
> [!NOTE]
> **为什么需要 `--remote-allow-origins=*` 参数**：自 Chrome 111 起，Chromium 对 CDP 调试接口（`/devtools/...`）强制实施 Origin 来源校验。命令行或外部 Node.js 原生 WebSocket 客户端发起连接时并不携带常规浏览器来源头，若不配置此参数，Chrome 会拒绝连接并返回 HTTP 403 Forbidden。
> 
> **本地安全边界保障**：通过同时指定 `--remote-debugging-address=127.0.0.1`，调试端口被严格限制在操作系统本地回环地址（Loopback），杜绝了任何来自外部局域网或公网的未授权访问。

### 第三步：配置 Antigravity 2.0 全局 MCP 配置文件

编辑用户主目录下的 Antigravity 全局 MCP 配置文件：
- **Windows 路径**：`C:\Users\<你的用户名>\.gemini\config\mcp_config.json`
- **Linux/macOS 路径**：`~/.gemini/config/mcp_config.json`

在 `mcpServers` 节点中添加 `antigravity-with-chatgpt`：

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

> **注意**：请将上述 `args` 中的路径替换为您实际克隆本仓库的绝对路径。在 Windows 下路径分隔符需使用双反斜杠 `\\` 转义。

### 第四步：在 Antigravity 2.0 中验证与使用

打开 Antigravity 2.0 IDE，您在向 Agent 下达指令时，Agent 会自动识别并调用该 MCP 工具：

```
用户指令：“请帮我调用 ask_chatgpt 的 plan 模式，为当前项目设计一个高吞吐量消息队列消费架构。”
```

Agent 将自动构造工具调用参数：
```json
{
  "name": "ask_chatgpt",
  "arguments": {
    "mode": "plan",
    "prompt": "设计一个高吞吐量消息队列消费架构"
  }
}
```

---

## 💻 命令行直接调用 (CLI)

除了作为 MCP Server 供 Antigravity 2.0 自动调用外，您也可以直接在终端使用轻量 CLI 脚本：

```powershell
# 1. 通用问答模式 (继续当前网页会话)
node scripts/ask_chatgpt.mjs "解释 Linux epoll 的水平触发 (LT) 与边缘触发 (ET) 的区别"

# 2. 开启全新独立会话 (--new)
node scripts/ask_chatgpt.mjs --new "从头开始评估分布式共识算法 Raft 与 Paxos"

# 3. 架构规划模式 (--plan)
node scripts/ask_chatgpt.mjs --plan "重构认证模块为 JWT 无状态方案"

# 4. 闭环独立代码审查 (--review, 自动提取真实 Git Diff 与执行记录)
node scripts/ask_chatgpt.mjs --review "审查最近的代码提交，确认是否存在安全边界漏洞"

# 5. 纯算法与数学深度推导 (--derive, 无代码库杂音)
node scripts/ask_chatgpt.mjs --derive "推导一致性哈希虚拟节点分布的标准差证明"

# 6. 故障诊断与根因分析 (--diagnose)
node scripts/ask_chatgpt.mjs --diagnose "分析单元测试出现的 ECONNRESET 错误"

# 7. 附带本地代码文件 (--attach, 自动安全收敛与敏感过滤)
node scripts/ask_chatgpt.mjs --attach src/auth.ts src/server.ts "请检查该模块的多线程安全性"

# 8. 系统状态诊断自检 (--doctor)
node scripts/ask_chatgpt.mjs --doctor
```

---

## 🧰 MCP 工具列表与参数规范

| 工具名称 | 描述 | 关键参数 |
| :--- | :--- | :--- |
| **`ask_chatgpt`** | 向 ChatGPT 网页版发送结构化任务并获取完整推理结果 | `prompt` (必填): 提问内容<br>`mode`: `ask` / `plan` / `review` / `derive` / `diagnose`<br>`files`: 附带的代码文件路径数组<br>`gitDiff`: 是否注入真实 Git Diff (布尔值)<br>`diffOffset`: Git Diff 分页起始字节偏移量 (默认 0)<br>`diffMaxBytes`: 单次最大字节预算限制 (默认 32768)<br>`session`: `reuse` / `new`<br>`timeout`: 超时时间（秒，默认 600） |
| **`get_git_diff_page`** | 按需提取真实 Git Diff 的指定分页切片（受字节预算与脱敏保护） | `workspace`: 可选工作区路径<br>`offset`: 分页起始字节偏移量 (默认 0)<br>`maxBytes`: 单次提取最大字节数 (默认 32768, 最大 65536)<br>`head`: 是否对比 HEAD (默认 true)<br>`staged`: 是否仅已暂存 (默认 false)<br>`file`: 可选文件路径过滤 |
| **`read_review_file`** | 安全读取工作区内代码文件（受沙箱防逃逸与字节预算保护） | `path` (必填): 相对文件路径<br>`workspace`: 可选工作区路径<br>`maxBytes`: 最大读取字节数 (默认 32768) |
| **`chatgpt_status`** | 探测专用 Chrome 实例、CDP 9222 端口及工作区就绪性 | `workspace`: 可选工作区路径 |
| **`record_execution`** | 记录命令、构建或测试运行证据，供审查模式调用 | `command` (必填): 执行命令<br>`exitCode` (必填): 退出码<br>`output`: 输出日志<br>`testSummary`: 测试通过/失败统计 |

---

## 🧪 自动化测试与对抗性安全套件

本项目针对持续集成与本地安装分别提供自动化验证方案：

### 1. 自动化 CI 测试套件 (`npm test`)
在 GitHub Actions 持续集成流水线中自动执行，覆盖 Ubuntu、Windows 与 macOS 三大主流平台（Node 22 与 Node 24 矩阵）：

```powershell
npm test
# 等价于: node tests/security_adversarial.test.mjs
```

### 2. 本地环境自检与端到端真实推理 (`npm run verify`)
检查本机环境依赖、模块完整性、全局挂载与真实 Chrome CDP 连通性：

```powershell
# 运行本地环境与配置自检 (36 项检查)
npm run verify

# 可选：在已运行 Chrome 的环境下执行端到端多模式推理测试
node scripts/verify_install.mjs --run-test
```

---

## ⚖️ 服务条款合规与使用免责声明

> [!IMPORTANT]
> **法律合规与使用责任告知：**
> - **个人开发与研究工具**：`antigravity-with-chatgpt` 为开源实验性开发者辅助工具，旨在方便个人开发者探索双脑协同推理、本地代码审查与 Antigravity 自动化交互。
> - **OpenAI 服务条款与程序化提取限制说明**：OpenAI 的 [Terms of Use（服务条款）](https://openai.com/policies/terms-of-use/) 对自动化或程序化提取数据与 Output 有明确限制；其他特定服务条款与政策亦可能适用。个人、本地、交互式或非商业用途并不构成对这些条款的豁免。本项目通过标准 Chrome DevTools Protocol (CDP) 连接本机 `127.0.0.1:9222` 端口上已登录的个人浏览器会话，仅作为本地交互式结对编程与辅助研究的便利桥梁，**绝非** OpenAI 官方 API 客户端，亦非任何商业化批量抓取管道。
> - **用户合规责任**：用户在使用本项目与 ChatGPT Web 交互时，须严格自行遵守所有适用的 OpenAI 条款、政策及合理使用频次准则。在 Web 界面上使用程序化交互存在固有的会话失效、触发人机验证（CAPTCHA）或账号受限风险。如需用于生产环境、高吞吐或具 SLA 保障的调用，请使用 OpenAI 官方提供的开放平台 API。
> - **免责声明**：本项目不破解、不绕过任何付费限制或风控防护。因个人使用不当导致的账号受限、会话中断或任何其他影响，本项目及作者概不承担任何直接或间接法律责任。

---

## 📄 许可证

本项目基于 [MIT 许可证](LICENSE) 开源。欢迎贡献代码与提出 Issue！
