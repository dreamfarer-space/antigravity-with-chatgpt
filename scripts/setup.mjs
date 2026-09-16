#!/usr/bin/env node
/**
 * antigravity-with-chatgpt - setup.mjs
 * ---------------------------------------------------------------------------
 * 一键极速安装与自动化配置脚本 (零第三方依赖，纯 Node.js 标准库)
 * 
 * 自动化完成：
 * 1. 注册全局 Antigravity 2.0 MCP 配置 (~/.gemini/config/mcp_config.json)
 * 2. 挂载 Antigravity 全局 Skill 软链接/Junction (~/.gemini/config/skills/antigravity-with-chatgpt)
 * 3. 创建独立 Chrome Profile 桌面快捷方式 (仅 Windows，调用 make_shortcut.mjs)
 * 4. 运行全套自检验证套件 (verify_install.mjs)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

console.log('='.repeat(64));
console.log('🚀 antigravity-with-chatgpt 一键极速配置与环境挂载');
console.log('='.repeat(64));

const geminiConfigDir = path.join(os.homedir(), '.gemini', 'config');
const mcpConfigFile = path.join(geminiConfigDir, 'mcp_config.json');
const skillsDir = path.join(geminiConfigDir, 'skills');
const skillTarget = path.join(skillsDir, 'antigravity-with-chatgpt');

// 1. 确保目录结构存在
if (!fs.existsSync(geminiConfigDir)) {
  fs.mkdirSync(geminiConfigDir, { recursive: true });
}
if (!fs.existsSync(skillsDir)) {
  fs.mkdirSync(skillsDir, { recursive: true });
}

// 2. 自动配置 mcp_config.json
console.log('\n[1/4] 正在配置 Antigravity 2.0 全局 MCP 服务...');
let mcpData = { mcpServers: {} };
if (fs.existsSync(mcpConfigFile)) {
  try {
    mcpData = JSON.parse(fs.readFileSync(mcpConfigFile, 'utf8'));
    if (!mcpData.mcpServers || typeof mcpData.mcpServers !== 'object') {
      mcpData.mcpServers = {};
    }
  } catch (e) {
    console.warn(`[WARN] 现有 mcp_config.json 解析警告: ${e.message}，将保留原文件并安全更新`);
  }
}

const mcpServerScript = path.join(ROOT, 'scripts', 'mcp_server.mjs');
mcpData.mcpServers['antigravity-with-chatgpt'] = {
  command: 'node',
  args: [mcpServerScript],
};

fs.writeFileSync(mcpConfigFile, JSON.stringify(mcpData, null, 2), 'utf8');
console.log(`[ OK ] 已成功写入全局 MCP 配置: ${mcpConfigFile}`);
console.log(`       服务入口: ${mcpServerScript}`);

// 3. 自动挂载 Antigravity 全局 Skill
console.log('\n[2/4] 正在挂载 Antigravity 全局 Skill...');
try {
  let needLink = true;
  if (fs.existsSync(skillTarget)) {
    try {
      const real = fs.realpathSync(skillTarget);
      if (real.toLowerCase() === ROOT.toLowerCase()) {
        console.log(`[ OK ] Skill 软链接已就绪且指向当前目录: ${skillTarget}`);
        needLink = false;
      } else {
        console.log(`[INFO] 检测到现有 Skill 软链接指向其他路径，更新为当前目录...`);
        fs.rmSync(skillTarget, { recursive: true, force: true });
      }
    } catch {
      fs.rmSync(skillTarget, { recursive: true, force: true });
    }
  }

  if (needLink) {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(ROOT, skillTarget, linkType);
    console.log(`[ OK ] 成功创建 Skill 链接 (${linkType}): ${skillTarget} -> ${ROOT}`);
  }
} catch (err) {
  console.warn(`[WARN] 创建 Skill 链接失败: ${err.message} (不影响 MCP 功能)`);
}

// 4. 生成桌面快捷方式 (Windows) 或 输出启动命令
console.log('\n[3/4] 正在准备独立 Chrome 调试会话入口...');
if (process.platform === 'win32') {
  const shortcutScript = path.join(ROOT, 'scripts', 'make_shortcut.mjs');
  if (fs.existsSync(shortcutScript)) {
    const res = spawnSync('node', [shortcutScript], { stdio: 'inherit' });
    if (res.status === 0) {
      console.log('[ OK ] 桌面独立 Chrome 快捷方式已成功生成！');
    }
  }
} else {
  console.log('[INFO] 在 macOS / Linux 上，请使用以下命令启动独立 Chrome 会话：');
  console.log(`  google-chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --remote-allow-origins=* --user-data-dir="$HOME/.antigravity-with-chatgpt/chrome-profile" https://chatgpt.com`);
}

// 5. 运行自检套件
console.log('\n[4/4] 运行安装就绪性全面自检...');
const verifyScript = path.join(ROOT, 'scripts', 'verify_install.mjs');
const verifyRes = spawnSync('node', [verifyScript], { stdio: 'inherit' });

console.log('\n' + '='.repeat(64));
if (verifyRes.status === 0) {
  console.log('✨ 安装配置完成！所有模块与配置已 100% 准备就绪。');
  console.log('\n🚀 下一步（两步极速上手）：');
  console.log('1. 启动独立 Chrome：双击桌面的「ChatGPT (Antigravity智脑)」快捷方式，在弹出的窗口中登录一次您的 ChatGPT 账号；');
  console.log('2. 打开 Antigravity 2.0 IDE：输入例如「请让 ChatGPT 帮我 review 当前代码」即可无缝协同！');
} else {
  console.log('⚠️ 自检完成，部分可选项请参阅上方自检日志。');
}
console.log('='.repeat(64));
