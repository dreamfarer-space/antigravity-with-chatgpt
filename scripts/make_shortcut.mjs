#!/usr/bin/env node
/**
 * make_shortcut.mjs - 生成 Windows .lnk 快捷方式（零依赖，直接写 Shell Link 二进制）
 * ---------------------------------------------------------------------------
 * 为什么不用 PowerShell / WScript.Shell？
 *   受管环境下 COM(New-Object -ComObject WScript.Shell) 会被安全策略拦截。
 *   本脚本不执行任何外部代码，只按 [MS-SHLLINK] 规范写出 .lnk 文件字节。
 *
 * 关键点：LinkTargetIDList 里的 shell item 编码很绕，手写容易让 Windows 解析不了
 * （表现为双击无反应）。所以本脚本会：
 *   1) 在系统中寻找一个"目标同样是我们要指向的 exe"的既有快捷方式；
 *   2) 直接复用它的 IDList 字节（Windows 自己写的，必然可解析）；
 *   3) 用我们自己的 LinkInfo + StringData 覆盖名称/参数/工作目录/图标。
 * 找不到模板时退化为"仅 LinkInfo"，并明确告警。
 *
 * 用法:
 *   node make_shortcut.mjs
 *   node make_shortcut.mjs --name "ChatGPT (AI智脑).lnk" --outdir "D:\somewhere"
 *   node make_shortcut.mjs --template "C:\ProgramData\...\Google Chrome.lnk"
 *   node make_shortcut.mjs --launch          # 生成后立刻用 ShellExecute 启动以验证
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const ROOT = 'D:\\ChatGPT-Brain-Bridge';
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
].filter(Boolean);

const DEFAULT_ARGS = [
  '--remote-debugging-port=9222',
  '--remote-debugging-address=127.0.0.1',
  '--remote-allow-origins=*',
  `--user-data-dir="${path.join(ROOT, 'chrome-profile')}"`,
  'https://chatgpt.com',
].join(' ');

const DEFAULT_NAME = 'ChatGPT (Antigravity智脑).lnk'; // UTF-8 literal -> no shell encoding pitfalls
const DEFAULT_DESC = 'antigravity-with-chatgpt - dedicated isolated Chrome with CDP on 127.0.0.1:9222';

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const opt = (flag, def) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const targetExe = opt('--target', CHROME_CANDIDATES.find((p) => fs.existsSync(p)) || CHROME_CANDIDATES[0]);
const targetArgs = opt('--args', DEFAULT_ARGS);
const workDir = opt('--workdir', ROOT);
const iconLoc = opt('--icon', `${targetExe},0`);
const description = opt('--desc', DEFAULT_DESC);
const outName = opt('--name', DEFAULT_NAME);
const outDir = opt('--outdir', path.join(os.homedir(), 'Desktop'));
const outPath = path.resolve(outDir, outName);
const forcedTemplate = opt('--template', null);

// ---------------------------------------------------------------------------
// binary helpers
// ---------------------------------------------------------------------------

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const ansi = (s) => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.from([0])]);
const utf16 = (s) => {
  const chars = Buffer.from(s, 'utf16le');
  return Buffer.concat([u16(chars.length / 2), chars]);
};

// ---------------------------------------------------------------------------
// .lnk parsing (used to harvest a real LinkTargetIDList from a template)
// ---------------------------------------------------------------------------

function readFlags(buf) {
  if (buf.length < 76 || buf.readUInt32LE(0) !== 0x4c) return null;
  return buf.readUInt32LE(20);
}

/** Walk the SHITEMID chain and return the whole ItemIDList (incl. 2-byte terminator) */
function extractIdList(buf) {
  const flags = readFlags(buf);
  if (flags === null || !(flags & 0x1)) return null;
  let p = 76;
  const start = p;
  let guard = 0;
  while (guard++ < 256) {
    if (p + 2 > buf.length) return null;
    const cb = buf.readUInt16LE(p);
    if (cb === 0) { p += 2; return buf.subarray(start, p); }
    if (cb < 2 || p + cb > buf.length) return null;
    p += cb;
  }
  return null;
}

/** Pull VolumeIDAndLocalBasePath out of the LinkInfo structure */
function extractLocalBasePath(buf) {
  const flags = readFlags(buf);
  if (flags === null || !(flags & 0x2)) return null;
  let p = 76;
  if (flags & 0x1) {
    const idl = extractIdList(buf);
    if (!idl) return null;
    p += idl.length;
  }
  if (p + 0x1c > buf.length) return null;
  const liSize = buf.readUInt32LE(p);
  const liHeaderSize = buf.readUInt32LE(p + 4);
  const liFlags = buf.readUInt32LE(p + 8);
  if (!(liFlags & 0x1) || liHeaderSize < 0x1c || liSize <= 0 || p + liSize > buf.length) return null;
  let q = p + buf.readUInt32LE(p + 0x10);
  let s = '';
  while (q < p + liSize && buf[q] !== 0) { s += String.fromCharCode(buf[q]); q++; }
  return s || null;
}

function* walkLnkFiles(dir, depth = 0) {
  if (depth > 4) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) yield* walkLnkFiles(p, depth + 1);
      else if (/\.lnk$/i.test(e.name)) yield p;
    } catch {}
  }
}

function findTemplate(exe) {
  const want = exe.toLowerCase();
  const dirs = [
    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs',
    path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    'C:\\Users\\Public\\Desktop',
    path.join(os.homedir(), 'Desktop'),
  ];
  const scanned = [];
  for (const d of dirs) {
    for (const f of walkLnkFiles(d)) {
      scanned.push(f);
      try {
        const buf = fs.readFileSync(f);
        const lbp = extractLocalBasePath(buf);
        if (lbp && lbp.toLowerCase() === want) {
          const idl = extractIdList(buf);
          if (idl && idl.length > 0) return { file: f, idList: idl, scanned: scanned.length };
        }
      } catch {}
    }
  }
  return { file: null, idList: null, scanned: scanned.length };
}

// ---------------------------------------------------------------------------
// [MS-SHLLINK] builders
// ---------------------------------------------------------------------------

const HEADER_SIZE = 0x4c;
const CLSID_SHELLLINK = Buffer.from([
  0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
]);

const FLAG_HAS_LINK_TARGET_ID_LIST = 0x00000001;
const FLAG_HAS_LINK_INFO = 0x00000002;
const FLAG_HAS_NAME = 0x00000004;
const FLAG_HAS_RELATIVE_PATH = 0x00000008;
const FLAG_HAS_WORKING_DIR = 0x00000010;
const FLAG_HAS_ARGUMENTS = 0x00000020;
const FLAG_HAS_ICON_LOCATION = 0x00000040;
const FLAG_IS_UNICODE = 0x00000080;

const FILE_ATTRIBUTE_ARCHIVE = 0x00000020;
const SW_SHOWNORMAL = 1;

function buildHeader(linkFlags) {
  return Buffer.concat([
    u32(HEADER_SIZE),
    CLSID_SHELLLINK,
    u32(linkFlags),
    u32(FILE_ATTRIBUTE_ARCHIVE),
    Buffer.alloc(8),            // CreationTime
    Buffer.alloc(8),            // AccessTime
    Buffer.alloc(8),            // WriteTime
    u32(0),                     // FileSize
    u32(0),                     // IconIndex
    u32(SW_SHOWNORMAL),         // ShowCommand
    u16(0),                     // HotKey
    u16(0),                     // Reserved
    u32(0),                     // Reserved2
    u32(0),                     // Reserved3
  ]);
}

/**
 * LinkInfo with VolumeID + LocalBasePath + empty CommonPathSuffix.
 *   0x00 LinkInfoSize(4) 0x04 LinkInfoHeaderSize=0x1C(4) 0x08 LinkInfoFlags(4)
 *   0x0C VolumeIDOffset(4) 0x10 LocalBasePathOffset(4)
 *   0x14 CommonNetworkRelativeLinkOffset(4) 0x18 CommonPathSuffixOffset(4)
 */
function buildLinkInfo(localBasePath) {
  const HEADER = 0x1c;

  const volumeIdBody = Buffer.concat([
    u32(0),                                     // VolumeIDSize (patched)
    u32(3),                                     // DriveType = DRIVE_FIXED
    u32(0),                                     // DriveSerialNumber
    u32(0x10),                                  // VolumeLabelOffset
    ansi(''),                                   // VolumeLabel
  ]);
  const volumeId = Buffer.concat([u32(volumeIdBody.length + 4), volumeIdBody]);

  const localBase = ansi(localBasePath);
  const suffix = Buffer.from([0]);

  const volumeIdOffset = HEADER;
  const localBasePathOffset = volumeIdOffset + volumeId.length;
  const commonPathSuffixOffset = localBasePathOffset + localBase.length;
  const size = commonPathSuffixOffset + suffix.length;

  const head = Buffer.concat([
    u32(size),
    u32(HEADER),
    u32(0x00000001),                            // VolumeIDAndLocalBasePath
    u32(volumeIdOffset),
    u32(localBasePathOffset),
    u32(0),                                     // no CommonNetworkRelativeLink
    u32(commonPathSuffixOffset),
  ]);

  return Buffer.concat([head, volumeId, localBase, suffix]);
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

// 1) harvest a real IDList
let template = null;
if (forcedTemplate) {
  if (!fs.existsSync(forcedTemplate)) {
    process.stderr.write(`[make_shortcut][ERROR] --template 不存在: ${forcedTemplate}\n`);
    process.exit(1);
  }
  const buf = fs.readFileSync(forcedTemplate);
  const idl = extractIdList(buf);
  const lbp = extractLocalBasePath(buf);
  if (!idl) {
    process.stderr.write(`[make_shortcut][ERROR] 模板里没有可用的 LinkTargetIDList: ${forcedTemplate}\n`);
    process.exit(1);
  }
  if (lbp && lbp.toLowerCase() !== targetExe.toLowerCase()) {
    process.stderr.write(`[make_shortcut][warn] 模板目标(${lbp}) 与目标 exe(${targetExe}) 不一致，IDList 可能指向别处\n`);
  }
  template = { file: forcedTemplate, idList: idl, scanned: 0 };
} else {
  template = findTemplate(targetExe);
}

let linkFlags = FLAG_HAS_LINK_INFO | FLAG_HAS_NAME | FLAG_HAS_RELATIVE_PATH |
                FLAG_HAS_WORKING_DIR | FLAG_HAS_ARGUMENTS | FLAG_HAS_ICON_LOCATION | FLAG_IS_UNICODE;

let idList = Buffer.alloc(0);
if (template.idList) {
  idList = template.idList;
  linkFlags |= FLAG_HAS_LINK_TARGET_ID_LIST;
  process.stderr.write(`[make_shortcut] 复用真实 IDList (${idList.length} 字节) 来自: ${template.file}\n`);
} else {
  process.stderr.write(
    `[make_shortcut][warn] 扫描 ${template.scanned} 个 .lnk 未找到目标为 ${targetExe} 的模板；\n` +
    `[make_shortcut][warn] 将生成不含 LinkTargetIDList 的快捷方式，Windows 可能无法解析。\n` +
    `[make_shortcut][warn] 可用 --template 手动指定一个既有快捷方式。\n`
  );
}

const stringData = Buffer.concat([
  utf16(description),                            // NAME_STRING
  utf16(targetExe),                              // RELATIVE_PATH
  utf16(workDir),                                // WORKING_DIR
  utf16(targetArgs),                             // COMMAND_LINE_ARGUMENTS
  utf16(iconLoc),                                // ICON_LOCATION
]);

const lnk = Buffer.concat([
  buildHeader(linkFlags),
  idList,
  buildLinkInfo(targetExe),
  stringData,
]);

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, lnk);

// Legacy compatibility shortcut
if (outName === DEFAULT_NAME) {
  const legacyPath = path.resolve(outDir, 'ChatGPT (AI智脑).lnk');
  try { fs.writeFileSync(legacyPath, lnk); } catch {}
}

const st = fs.statSync(outPath);
process.stderr.write(
  `[make_shortcut] 已生成: ${outPath}\n` +
  `[make_shortcut]   size      : ${st.size} bytes\n` +
  `[make_shortcut]   target    : ${targetExe}\n` +
  `[make_shortcut]   arguments : ${targetArgs}\n` +
  `[make_shortcut]   workdir   : ${workDir}\n`
);

// ---------------------------------------------------------------------------
// self-check
// ---------------------------------------------------------------------------

const back = fs.readFileSync(outPath);
const reIdl = extractIdList(back);
const reLbp = extractLocalBasePath(back);
const checks = [
  ['HeaderSize == 0x4C', back.readUInt32LE(0) === 0x4c],
  ['ShellLink CLSID', back.subarray(4, 20).equals(CLSID_SHELLLINK)],
  ['LinkFlags sets HasLinkTargetIDList', (back.readUInt32LE(20) & FLAG_HAS_LINK_TARGET_ID_LIST) !== 0],
  [`LinkTargetIDList parseable (${reIdl ? reIdl.length : 0} bytes)`, !!reIdl && reIdl.length > 0],
  ['LinkInfo LocalBasePath == target', (reLbp || '').toLowerCase() === targetExe.toLowerCase()],
  ['contains --remote-debugging-port=9222', back.includes(Buffer.from('--remote-debugging-port=9222', 'utf16le'))],
  ['contains --remote-debugging-address=127.0.0.1', back.includes(Buffer.from('--remote-debugging-address=127.0.0.1', 'utf16le'))],
  ['contains --remote-allow-origins=*', back.includes(Buffer.from('--remote-allow-origins=*', 'utf16le'))],
  ['contains chrome-profile user-data-dir', back.includes(Buffer.from('--user-data-dir="D:\\ChatGPT-Brain-Bridge\\chrome-profile"', 'utf16le'))],
  ['contains https://chatgpt.com', back.includes(Buffer.from('https://chatgpt.com', 'utf16le'))],
];

let bad = 0;
for (const [label, ok] of checks) {
  if (!ok) bad++;
  process.stderr.write(`[make_shortcut]   ${ok ? 'OK  ' : 'FAIL'} ${label}\n`);
}
process.stderr.write(`[make_shortcut] 自检: ${checks.length - bad}/${checks.length} 通过\n`);

// ---------------------------------------------------------------------------
// optional launch (proves the .lnk really resolves through the shell)
// ---------------------------------------------------------------------------

if (argv.includes('--launch') && bad === 0) {
  process.stderr.write('[make_shortcut] 通过 shell 启动该快捷方式...\n');
  const child = spawn('cmd.exe', ['/c', 'start', '', outPath], { detached: true, stdio: 'ignore' });
  child.on('error', (e) => process.stderr.write(`[make_shortcut][warn] 启动失败: ${e.message}\n`));
  child.unref();
}

process.stdout.write(outPath + '\n');
process.exit(bad === 0 ? 0 : 1);
