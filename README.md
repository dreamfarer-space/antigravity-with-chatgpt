<div align="center">

<img src="./assets/banner.png" alt="antigravity-with-chatgpt Banner" width="100%" />

# 🚀 antigravity-with-chatgpt

**Zero-Dependency Dual-Brain Reasoning & Verification Architecture for Google Antigravity 2.0 & Gemini**

*Harness the full reasoning power of ChatGPT Web (GPT-4o, o1, o3, Canvas) as an independent cloud brain for your local Antigravity 2.0 IDE.*

[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Dependencies](https://img.shields.io/badge/Dependencies-0%20(Pure%20Native)-brightgreen)](#-key-features)
[![MCP](https://img.shields.io/badge/MCP-JSON--RPC%202.0%20stdio-orange)](https://modelcontextprotocol.io/)
[![Antigravity](https://img.shields.io/badge/Antigravity-2.0%20Compatible-purple)](#-configuring-mcp-in-antigravity-20)

[English](./README.md) | [中文说明](./README_CN.md)

</div>

---

## 📖 Background & Design Philosophy

When developing with modern agentic coding assistants, local agents like **Google Antigravity 2.0 IDE**, Gemini CLI, and Claude Code have deep local authority (file I/O, terminal execution, running tests, Git version control). However, when tackling complex architectural refactoring, algorithmic derivation, subtle root-cause debugging, or rigorous code reviews, a single model within a shared context often suffers from confirmation bias and self-rationalizing hallucinations.

Inspired by the notable community project `XiaoDuoYa/codex-with-chatgpt` (**"ChatGPT thinks. Codex works."**) and shaped by ChatGPT's rigorous 38-point architectural code review, **`antigravity-with-chatgpt`** establishes a robust **Proxy-Pull Context Broker** pattern:

- **Local Agent Owns Execution**: File edits, shell terminal commands, build pipelines, and unit tests strictly belong to Antigravity.
- **ChatGPT Owns Reasoning & Review**: High-level task planning, mathematical derivations, and adversarial code reviews are delegated to ChatGPT Web.
- **Local Session Reuse**: Connects directly to your authenticated browser session (Free, Plus, or Pro) running in an isolated local Chrome profile—no separate API key required, operating strictly within standard personal web session parameters.
- **Zero npm Dependencies**: Written entirely in native Node.js 22+ standard library (native WebSocket, fetch, crypto, child_process)—lightning fast startup, zero supply-chain attack surface.

---

## 🌟 Key Features

- ⚡ **Sub-Millisecond DOM Injection**: Utilizes `execCommand('insertText')` combined with Base64 encoding to bypass ProseMirror per-character event overhead, injecting 10,000+ characters in under 5ms.
- 🛡️ **Defense-in-Depth Local Security Boundary**:
  - **`path_guard.mjs`**: Platform-aware relative path containment, strictly preventing `../` traversal, NUL byte injection, and symlink breakout.
  - **`sensitive.mjs`**: Blocks `.env*`, SSH keys, and certificates; automatically redacts OpenAI API keys, GitHub tokens, AWS credentials, and Bearer tokens.
  - **`Egress Sanitization`**: Ensures every character crossing the browser boundary—including Git diffs and execution test output—passes through an ultimate redaction filter.
- 🔄 **Closed-Loop Independent Verification**:
  - Automatically captures budgeted `git diff` outputs and persistent test execution records.
  - Anti-flattery enforcement: Without empirical execution evidence, ChatGPT will actively refuse blind approval and issue an actionable `[CHANGES REQUESTED]` report.
- 🔒 **Single-Flight Concurrency Mutex**:
  - Built-in `AsyncMutex` serializes concurrent MCP requests targeting the same Chrome tab, preventing prompt interleaving and signal crossing.
- 🎯 **Five Specialized Operational Modes**:
  1. `ask`: Everyday technical questions and conversational reasoning.
  2. `plan`: Structured planning with RATIONALE, ACTIONS, RISKS, and CRITERIA.
  3. `review`: Closed-loop verification of real Git diffs and execution evidence.
  4. `derive`: Pure mathematical and algorithmic derivation (code files isolated to eliminate noise).
  5. `diagnose`: Root-cause failure analysis with minimal reproduction steps.

---

## 🏗️ Four-Layer Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 Antigravity 2.0 / Gemini                │
└───────────────────────────┬─────────────────────────────┘
                            │ JSON-RPC 2.0 stdio / CLI
┌───────────────────────────▼─────────────────────────────┐
│ 1. Access Layer (scripts/)                               │
│    - ask_chatgpt.mjs: Thin, expressive CLI entrypoint   │
│    - mcp_server.mjs: Antigravity 2.0 Native MCP Server  │
├─────────────────────────────────────────────────────────┤
│ 2. Orchestration & Protocol (src/brain/)                │
│    - orchestrator.mjs: Proxy-Pull Context Broker        │
│    - prompts.mjs: [ANTIGRAVITY-BRIDGE/1] 5 Mode Envelopes│
├─────────────────────────────────────────────────────────┤
│ 3. Security & Evidence Layer (src/security/, workspace/)│
│    - path_guard.mjs: Canonical Realpath Traversal Guard │
│    - sensitive.mjs: Secret Redaction & .env Blocking    │
│    - ignore.mjs: .brainignore Rule Parser               │
│    - context_provider.mjs: Safe Read-Only Slicing       │
│    - git_helper.mjs: Read-Only Budgeted Git Diff        │
│    - recorder.mjs: Execution Evidence Recorder          │
├─────────────────────────────────────────────────────────┤
│ 4. Transport Layer (src/transport/)                     │
│    - cdp_transport.mjs: Native CDP Driver (Port 9222)   │
│      * AsyncMutex single-flight serialization           │
│      * Base64 fast ProseMirror text injection           │
│      * Double-hash multi-sampling + MutationObserver    │
│      * Event-driven WebSocket lifecycle & cleanup       │
└───────────────────────────┬─────────────────────────────┘
                            │ Chrome DevTools Protocol
┌───────────────────────────▼─────────────────────────────┐
│ Dedicated Chrome Profile (127.0.0.1:9222)               │
│ └── ChatGPT Web UI (https://chatgpt.com/)               │
└─────────────────────────────────────────────────────────┘
```

---

## 🛠️ Configuring MCP in Antigravity 2.0

Google Antigravity 2.0 natively integrates external tools via the standard Model Context Protocol (MCP).

### Step 1: Prerequisites
- **Node.js**: `>= 22.0.0` (uses global native `WebSocket` and `fetch`—no npm install needed).
- **Google Chrome**: Standard desktop installation.

### Step 2: Start the Dedicated Chrome Session
To keep your daily browser data separate, launch Chrome with an isolated user profile (`~/.antigravity-with-chatgpt/chrome-profile` or custom directory) and local CDP remote debugging on port `9222`:

**Windows PowerShell:**
```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --remote-debugging-address=127.0.0.1 `
  --remote-allow-origins=* `
  --user-data-dir="$HOME\.antigravity-with-chatgpt\chrome-profile" `
  https://chatgpt.com
```

**macOS Terminal:**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --remote-allow-origins=* \
  --user-data-dir="$HOME/.antigravity-with-chatgpt/chrome-profile" \
  https://chatgpt.com
```

**Linux Bash:**
```bash
google-chrome \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --remote-allow-origins=* \
  --user-data-dir="$HOME/.antigravity-with-chatgpt/chrome-profile" \
  https://chatgpt.com
```

> **Tip**: On first launch, log in to your ChatGPT account once. Your session cookies will be stored in your dedicated local Chrome profile, minimizing repeated logins across restarts (subject to normal OpenAI session lifetimes).

### Step 3: Configure Antigravity 2.0 Global MCP Config

Edit your global MCP configuration file:
- **Windows**: `C:\Users\<YourUsername>\.gemini\config\mcp_config.json`
- **Linux/macOS**: `~/.gemini/config/mcp_config.json`

Add `antigravity-with-chatgpt` under `mcpServers`:

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

> **Note**: Update the path to match where you cloned the repository. Remember to use double backslashes `\\` on Windows.

### Step 4: Verification in Antigravity 2.0

Restart Antigravity 2.0. The agent will discover the tools automatically. You can instruct the agent naturally:

```
"Please ask ChatGPT in plan mode to design a high-throughput message queue architecture for this service."
```

Antigravity will dispatch the MCP tool call:
```json
{
  "name": "ask_chatgpt",
  "arguments": {
    "mode": "plan",
    "prompt": "Design a high-throughput message queue architecture"
  }
}
```

---

## 💻 CLI Usage

You can also interact with the bridge directly from your terminal:

```powershell
# 1. Ask a question (reuses active web session)
node scripts/ask_chatgpt.mjs "Explain the differences between Linux epoll LT and ET modes"

# 2. Start a fresh conversation (--new)
node scripts/ask_chatgpt.mjs --new "Evaluate Raft vs Paxos for distributed consensus"

# 3. Architectural Planning Mode (--plan)
node scripts/ask_chatgpt.mjs --plan "Refactor the authentication module to stateless JWT"

# 4. Closed-Loop Review Mode (--review, auto-injects real Git Diff & test evidence)
node scripts/ask_chatgpt.mjs --review "Review recent changes for security regressions"

# 5. Algorithmic Derivation Mode (--derive, noise-free math reasoning)
node scripts/ask_chatgpt.mjs --derive "Derive the variance formula for consistent hashing virtual nodes"

# 6. Root-Cause Diagnostics (--diagnose)
node scripts/ask_chatgpt.mjs --diagnose "Analyze ECONNRESET errors during test execution"

# 7. Attach Local Source Files (--attach, with automatic path guard & secret redaction)
node scripts/ask_chatgpt.mjs --attach src/auth.ts src/server.ts "Analyze thread-safety"

# 8. Run Environment Doctor (--doctor)
node scripts/ask_chatgpt.mjs --doctor
```

---

## 🧰 MCP Tool Reference

| Tool | Description | Key Parameters |
| :--- | :--- | :--- |
| **`ask_chatgpt`** | Delegates complex reasoning, planning, or review to ChatGPT Web | `prompt` (required): Prompt text<br>`mode`: `ask` / `plan` / `review` / `derive` / `diagnose`<br>`files`: Array of relative file paths to attach<br>`gitDiff`: Boolean to attach real Git diff<br>`session`: `reuse` or `new`<br>`timeout`: Max seconds to wait (default 600) |
| **`chatgpt_status`** | Probes Chrome CDP 9222 connectivity and workspace readiness | `workspace`: Optional root path |
| **`record_execution`** | Stores command execution and test results for closed-loop review | `command` (required): Executed command<br>`exitCode` (required): Process exit code<br>`output`: Output log snippet<br>`testSummary`: Test pass/fail counts |

---

## 🧪 Testing & Verification

Run the comprehensive test suite:

```powershell
# Run baseline installation & component verification
node scripts/verify_install.mjs

# Run adversarial security & concurrency tests
node tests/security_adversarial.test.mjs
```

**Results:**
- ✅ **48 / 48 Tests Passed (100%)**
  - Path traversal, NUL injection & case-sensitivity: 5/5
  - Multi-line PEM, spaced secret assignment & Bearer token redaction: 5/5
  - Egress sanitization leakage prevention: 2/2
  - Orchestrator defensive contract validation: 2/2
  - Core component integrity & CDP live probing: 34/34

---

## ⚖️ Terms of Service & Responsible Use Notice

> [!IMPORTANT]
> **Legal & Compliance Notice:**
> - **Personal Research & Workflow Tool**: `antigravity-with-chatgpt` is an open-source experimental developer tool designed for personal workflow augmentation, dual-brain reasoning research, and local verification pairing Antigravity with web-based LLMs.
> - **CDP Automation & OpenAI Terms**: This project interfaces with a locally running Chrome browser instance via standard Chrome DevTools Protocol (CDP) on `127.0.0.1:9222`. Automating browser interactions with web services is governed by the [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/). Users are solely responsible for ensuring their usage adheres to OpenAI's policies and standard rate limits.
> - **No Guarantees**: This project does not circumvent paywalls, rate limits, or account restrictions. The maintainers do not assume any liability for account restrictions, session termination, or any other impacts resulting from the use of this software.

---

## 📄 License

Open-sourced under the [MIT License](LICENSE). Contributions, feedback, and pull requests are warmly welcome!
