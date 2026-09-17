<div align="center">

<img src="./assets/banner.png" alt="antigravity-with-chatgpt Banner" width="100%" />

# 🚀 antigravity-with-chatgpt

**Zero-Dependency Dual-Brain Reasoning & Verification Architecture for Google Antigravity 2.0 & Gemini**

*Harness the full reasoning and deep-thinking capabilities available in your authenticated ChatGPT Web account as an independent cloud brain for your local Antigravity 2.0 IDE.*

[![CI](https://github.com/dreamfarer-space/antigravity-with-chatgpt/actions/workflows/ci.yml/badge.svg)](https://github.com/dreamfarer-space/antigravity-with-chatgpt/actions/workflows/ci.yml)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Dependencies](https://img.shields.io/badge/Dependencies-0%20(Pure%20Native)-brightgreen)](#-key-features)
[![MCP](https://img.shields.io/badge/MCP-JSON--RPC%202.0%20stdio-orange)](https://modelcontextprotocol.io/)
[![Antigravity](https://img.shields.io/badge/Antigravity-2.0%20Compatible-purple)](#-configuring-mcp-in-antigravity-20)

[English](./README.md) | [中文说明](./README_CN.md)

</div>

---

## ⚡ One-Sentence AI Installation (一句话让 AI 帮忙安装)

You don't even need to open a terminal or run shell commands manually. Simply copy and paste this **single sentence** into your **Google Antigravity 2.0 / Gemini / Claude Code** chat box:

> **Set up antigravity-with-chatgpt for me: clone https://github.com/dreamfarer-space/antigravity-with-chatgpt.git and run node scripts/setup.mjs to configure the environment and verify.**

Your AI Agent will handle the entire installation automatically:
1. 🛠️ **Clone & Inspect**: Clones the repository and verifies the Node.js (>= 22) and Chrome environment;
2. 🔌 **Register Native MCP Server**: Automatically updates `~/.gemini/config/mcp_config.json`;
3. 🔗 **Mount Global Antigravity Skill**: Creates the skill junction in `~/.gemini/config/skills/antigravity-with-chatgpt`;
4. 🖥️ **Generate Dedicated Chrome Shortcut**: Creates a desktop launcher with isolated profile and port `9222`;
5. ✅ **Run Full Self-Checks**: Runs the 104-case adversarial test suite plus the 37-point environment self-check to ensure 100% readiness.

After setup, double-click the **"ChatGPT (Antigravity智脑)"** desktop shortcut to log in to your ChatGPT Web account once, and you can immediately delegate deep reasoning and adversarial code reviews to ChatGPT from within Antigravity 2.0!

*(Manual terminal alternative: `git clone https://github.com/dreamfarer-space/antigravity-with-chatgpt.git && cd antigravity-with-chatgpt && node scripts/setup.mjs`)*

---

## 📖 Background & Design Philosophy

When developing with modern agentic coding assistants, local agents like **Google Antigravity 2.0 IDE**, Gemini CLI, and Claude Code have deep local authority (file I/O, terminal execution, running tests, Git version control). However, when tackling complex architectural refactoring, algorithmic derivation, subtle root-cause debugging, or rigorous code reviews, a single model within a shared context often suffers from confirmation bias and self-rationalizing hallucinations.

Inspired by the notable community project `XiaoDuoYa/codex-with-chatgpt` (**"ChatGPT thinks. Codex works."**) and shaped by ChatGPT's rigorous 38-point architectural code review, **`antigravity-with-chatgpt`** establishes a robust **Proxy-Pull Context Broker** pattern:

- **Local Agent Owns Execution**: File edits, shell terminal commands, build pipelines, and unit tests strictly belong to Antigravity.
- **ChatGPT Owns Reasoning & Review**: High-level task planning, mathematical derivations, and adversarial code reviews are delegated to ChatGPT Web.
- **Local Session Reuse**: Connects directly to your authenticated browser session (Free, Plus, or Pro) running in an isolated local Chrome profile—no separate API key required, operating strictly within standard personal web session parameters.
- **Zero npm Dependencies**: Written entirely in native Node.js 22+ standard library (native WebSocket, fetch, crypto, child_process)—lightning fast startup, zero third-party npm runtime dependency surface.

---

## 🌟 Key Features

- ⚡ **Millisecond-Scale DOM Injection**: Utilizes `execCommand('insertText')` combined with Base64 encoding to bypass ProseMirror per-character event overhead, injecting 10,000+ characters in under 5ms.
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
- ⏳ **Long-Reply Polling & Host-Timeout Guard**:
  - MCP calls clamp the wait window to **150s by default, hard-capped at 165s**—safely inside Antigravity's 180s host watchdog, so a long reasoning turn is never hard-killed mid-flight.
  - When ChatGPT is still streaming, the bridge returns `[STATUS: IN_PROGRESS]` along with resumption credentials (`expectedTurn` + `conversationUrl`) instead of failing. Resume with `fetch_chatgpt_response`—**no prompt re-injection, no overwriting the in-flight answer**.
  - **One absolute deadline, threaded end-to-end**: the deadline is anchored at the MCP boundary and passed down through the orchestrator into every transport wait (Chrome readiness, CDP connect, probes, quiet window, text reads). Downstream layers never re-anchor a fresh relative timeout and never `Math.max()` extra time—once the budget is exhausted, **zero** further CDP calls are issued.
- 🔐 **Single Authorized Workspace Root**:
  - The MCP server / CLI **pins the authorized workspace root at startup** (`CHATGPT_BRAIN_WORKSPACE` or the process cwd, realpath-normalized).
  - Every tool call's `workspace` must equal that root or live strictly inside it; anything else **fails closed** without ever reaching the orchestration layer. Filesystem roots (`/`, `D://`), the user home, system and temp roots are rejected outright—even in library mode.
  - Rationale: a path sandbox only protects the root the caller hands in. Letting a (possibly prompt-injected) agent pick `C://` or `HOME` reduces every containment check to theatre.
- 🧱 **One File-Authorization Choke Point**:
  - All content that may cross the browser boundary goes through `authorizeCanonicalFile()`: workspace authorization + lexical containment + symlink-escape check + **dual** (lexical **and** realpath) sensitive-name and `.brainignore` policy.
  - Closes three bypasses: untracked `alias.txt -> .env` symlinks, tracked Git diffs (now filtered per file via `git diff --name-status -z`, renames validated on both ends), and `searchWorkspace` (both ripgrep and `git grep` branches, ripgrep switched to `--json` to remove Windows drive-letter parsing ambiguity).
  - Excluded files never produce diff headers or content—only an auditable `[DIFF FILTERED: …]` notice.
- 🧭 **Conversation Identity Guard (State Machine)**:
  - Conversation URLs are canonicalized (scheme + host + path, query/hash stripped) and tracked as `UNBOUND_ROOT → PINNED(/c/<id>)`. The first concrete `/c/<id>` observed is **pinned permanently**; from then on comparison is strict.
  - This closes the dangerous `/ → /c/A → /c/B` hole: a root URL can never act as a permanent wildcard, and any mid-generation cross-conversation navigation **fails closed** instead of returning another chat's content.
  - Resumption credentials are **upgraded to the pinned identity**—a request that started at `/` returns `/c/A`, never `/`.
  - **Temporary identities are not identities**: right after submitting a brand-new chat, ChatGPT briefly sits on the client-side `/c/WEB:<uuid>` address before swapping in the server-assigned `/c/<uuid>`. That form is never pinned and never used as a credential, so the normal `WEB:<uuid> → <uuid>` transition is not mis-flagged as a hijack.
  - Multi-tab fetch selects the tab by **exact canonical conversation identity** rather than "first ChatGPT tab, then hope the URL guard passes".

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
│      * Absolute deadline + in-progress (IN_PROGRESS)    │
│        resumption via fetch_chatgpt_response            │
│      * Conversation identity re-validation (fail-closed)│
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
>
> [!NOTE]
> **Why `--remote-allow-origins=*` is required**: Starting in Chrome 111, Chromium enforces strict WebSocket Origin validation on DevTools endpoints (`/devtools/...`). Non-browser processes (such as Node.js WebSocket clients) do not send standard browser origins, causing Chrome to reject the connection with HTTP 403 Forbidden without this flag.
> 
> **Security Boundary**: The debug socket binds strictly to `--remote-debugging-address=127.0.0.1` (loopback only). Because it is not exposed on any external network interface, remote connections from the local network or internet are blocked at the OS socket level.

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

# 9. Poll a long-running reply (--fetch / --poll, no prompt re-injection)
node scripts/ask_chatgpt.mjs --fetch
node scripts/ask_chatgpt.mjs --fetch --json
```

---

## ⏳ Long-Reply Polling & Host-Timeout Guard

Deep reasoning turns can easily run past an MCP host's per-call watchdog (Antigravity aborts a tool call after **3 minutes**). Instead of being hard-killed mid-generation, the bridge degrades gracefully:

```
ask_chatgpt(prompt, timeout: 150)
        │
        ├── reply finished in time ──────────► final answer text
        │
        └── still streaming at the deadline ─► [STATUS: IN_PROGRESS]
                                                 + expectedTurn
                                                 + conversationUrl
                                                        │
                              fetch_chatgpt_response ◄──┘
                              (repeat until the answer is stable)
```

- **Wait window clamping**: `timeout` defaults to **150s** and is hard-clamped to **165s** for both `ask_chatgpt` and `fetch_chatgpt_response`, staying inside the host watchdog.
- **Never resubmit**: on `IN_PROGRESS` the prompt is already injected and generating. Call `fetch_chatgpt_response` with the returned credentials—resubmitting the full prompt can overwrite or interleave the in-flight answer.
- **Resumption credentials**: `targetId` (opaque Chrome target identity, always available and preferred), `expectedTurn` (minimum assistant turn index, prevents turn crossover) and `conversationUrl` (canonicalized conversation identity, only returned once a durable `/c/<id>` exists—it is `null` on root/ephemeral identities rather than a fake value). All optional, but strongly recommended when more than one ChatGPT tab is open.
- **Partial text**: `IN_PROGRESS` responses include the last ~400 characters already captured, so agents can stream progress to the user while waiting.
- **`safeTimeout` semantics**: the default `safeTimeout: true` returns `IN_PROGRESS` (exit code `0`) rather than throwing on timeout. Set `safeTimeout: false` to get a hard failure instead.

---

## 🧰 MCP Tool Reference

| Tool | Description | Key Parameters |
| :--- | :--- | :--- |
| **`ask_chatgpt`** | Delegates complex reasoning, planning, or review to ChatGPT Web | `prompt` (required): Prompt text<br>`mode`: `ask` / `plan` / `review` / `derive` / `diagnose`<br>`files`: Array of relative file paths to attach<br>`gitDiff`: Boolean to attach real Git diff<br>`diffOffset`: Number (byte offset for diff pagination)<br>`diffMaxBytes`: Number (max bytes per diff page, default 32768)<br>`session`: `reuse` or `new`<br>`timeout`: Max seconds to wait (default 150, hard cap 165)<br>Returns `[STATUS: IN_PROGRESS]` + `expectedTurn` / `conversationUrl` when still generating |
| **`fetch_chatgpt_response`** | Resumes / polls the latest reply in the bound conversation—no prompt re-injection | `timeout`: Max seconds to wait (default 150, hard cap 165)<br>`targetId`: Chrome target identity (opaque, preferred resume credential)<br>`expectedTurn`: Minimum assistant turn index (anti-crossover)<br>`conversationUrl`: Expected conversation URL—durable `/c/<id>` only (anti tab-crossover)<br>`workspace`: Optional root path (must be inside the authorized root) |
| **`get_git_diff_page`** | Fetches paginated real Git diff slices with strict byte budgets | `workspace`: Optional root path<br>`offset`: Starting byte offset (default 0)<br>`maxBytes`: Max bytes (default 32768, max 65536)<br>`head`: Boolean (default true)<br>`staged`: Boolean (default false)<br>`file`: Optional file path |
| **`read_review_file`** | Safely reads local code files under path sandbox and budget limits | `path` (required): Relative file path<br>`workspace`: Optional root path<br>`maxBytes`: Max bytes (default 32768) |
| **`chatgpt_status`** | Probes Chrome CDP 9222 connectivity and workspace readiness | `workspace`: Optional root path |
| **`record_execution`** | Stores command execution and test results for closed-loop review | `command` (required): Executed command<br>`exitCode` (required): Process exit code<br>`output`: Output log snippet<br>`testSummary`: Test pass/fail counts |

---

## 🧪 Testing & Verification

The project includes both an automated cross-platform test suite for continuous integration and an environment verification suite for local setup:

### 1. Automated CI Test Suite (`npm test`)
Executed automatically in GitHub Actions on every push and pull request across Ubuntu, Windows, and macOS (Node 22 & 24). **104 adversarial cases** cover path traversal & symlink breakout, secret redaction, egress sanitization, git porcelain parsing, evidence budget ceilings, absolute-deadline exhaustion (zero-borrow across connect/inject/submit/verify), authorized-workspace enforcement, untracked symlink aliases, per-file Git diff policy, conversation identity pinning (`/ → /c/A → /c/B`), durable resume credentials, multi-tab precise selection, and MCP parameter pass-through on the real handler chain:

```powershell
npm test
# Equivalent to: node tests/security_adversarial.test.mjs
```

### 2. Local Environment Verification & Live Integration (`npm run verify`)
Runs local sanity checks and optional live end-to-end integration tests with an active Chrome session:

```powershell
# Verify local module structure, configuration, and CDP connectivity (37 checks)
npm run verify

# Optional: Run live end-to-end multi-mode execution against an active Chrome session
node scripts/verify_install.mjs --run-test
```

---

## ⚖️ Terms of Service & Responsible Use Notice

> [!IMPORTANT]
> **Legal & Compliance Notice:**
> - **Personal Research & Workflow Tool**: `antigravity-with-chatgpt` is an open-source experimental developer tool designed for personal workflow augmentation, dual-brain reasoning research, and local verification pairing Antigravity with web-based LLMs.
> - **OpenAI Terms of Use & Automated Extraction Restrictions**: OpenAI's [Terms of Use](https://openai.com/policies/terms-of-use/) explicitly restrict automated or programmatic extraction of data or Output; additional Service Terms and policies may also apply. Personal, local, interactive, or non-commercial use should not be assumed to create an exemption from those Terms. This project connects locally via Chrome DevTools Protocol (CDP) on `127.0.0.1:9222` to an existing authenticated user session purely as a developer convenience bridge for personal, interactive pair-programming. It is **not** an official OpenAI API client, an automated scraping pipeline, or a commercial extraction tool.
> - **User Responsibility**: Users are solely responsible for ensuring that their use complies with all applicable OpenAI terms, policies, and fair-use guidelines. Interacting programmatically with web interfaces carries inherent risks (including session invalidation, CAPTCHA challenges, or account restrictions). For production, high-throughput, or SLA-backed programmatic access, please use official OpenAI Platform APIs.
> - **No Warranties or Guarantees**: This project does not circumvent paywalls, rate limits, or account restrictions. The maintainers do not assume any liability for account restrictions, session termination, or any other impacts resulting from the use of this software.

---

## 📄 License

Open-sourced under the [MIT License](LICENSE). Contributions, feedback, and pull requests are warmly welcome!
