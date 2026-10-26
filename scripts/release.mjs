#!/usr/bin/env node
/**
 * 自动化发版脚本。
 *
 *   npm run release -- --dry-run          预览将要做的事（默认行为）
 *   npm run release -- --patch            发修订版 1.0.2 → 1.0.3
 *   npm run release -- --minor            发次版本 1.0.2 → 1.1.0
 *   npm run release -- --major            发主版本 1.0.2 → 2.0.0
 *   npm run release -- --set 1.2.3        指定确切版本号
 *   npm run release -- --minor --push     发布后立即推送
 *
 * 流程：
 *   1. 检查工作区干净、在允许的分支上、与远端同步
 *   2. 跑测试
 *   3. 算出新版本号（默认按提交类型推断）
 *   4. 更新 src/version.ts、package.json、package-lock.json
 *   5. 基于 git log 生成 CHANGELOG 条目
 *   6. commit + 创建附注 tag
 *   7. （--push 时）推送提交与 tag
 *
 * 版本号的唯一来源是 src/version.ts，其余都是它的副本。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const versionFile = join(root, "src", "version.ts");
const pkgFile = join(root, "package.json");
const lockFile = join(root, "package-lock.json");
const changelogFile = join(root, "CHANGELOG.md");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const DRY_RUN = has("--dry-run") || !argv.some((a) => /^--(patch|minor|major|set)$/.test(a));
const PUSH = has("--push");
const ALLOW_BRANCH = process.env.RELEASE_BRANCH || "master";

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fail(msg) {
  console.error(`\n${c.red("✗")} ${msg}\n`);
  process.exit(1);
}

function step(msg) {
  console.log(`${c.green("✓")} ${msg}`);
}

/** 语义化版本号解析 */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) fail(`版本号格式不合法：${v}（应为 x.y.z）`);
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function bump(v, kind) {
  const { major, minor, patch } = parseVersion(v);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** 比较两个版本号，返回 -1 / 0 / 1 */
function compareVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (const k of ["major", "minor", "patch"]) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  return 0;
}

function readVersion() {
  const src = readFileSync(versionFile, "utf8");
  const m = src.match(/export\s+const\s+VERSION\s*=\s*["']([^"']+)["']/);
  if (!m) fail("无法在 src/version.ts 中找到 VERSION 常量");
  return m[1];
}

function writeVersion(next) {
  const src = readFileSync(versionFile, "utf8");
  const out = src.replace(
    /(export\s+const\s+VERSION\s*=\s*["'])[^"']+(["'])/,
    `$1${next}$2`,
  );
  writeFileSync(versionFile, out, "utf8");

  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  pkg.version = next;
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n", "utf8");

  if (existsSync(lockFile)) {
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    lock.version = next;
    if (lock.packages?.[""]) lock.packages[""].version = next;
    writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n", "utf8");
  }
}

// ---------------------------------------------------------------------------
// 1. 前置检查
// ---------------------------------------------------------------------------

const currentBranch = git("rev-parse", "--abbrev-ref", "HEAD");
if (currentBranch !== ALLOW_BRANCH) {
  fail(`当前在 ${currentBranch} 分支，发版只允许在 ${ALLOW_BRANCH} 上进行。\n  可设置环境变量 RELEASE_BRANCH 覆盖。`);
}

const dirty = git("status", "--porcelain");
if (dirty) {
  fail(`工作区不干净，请先提交或暂存改动：\n${dirty}`);
}

// 与远端同步检查（远端不存在时跳过）
let remoteAhead = 0;
let localAhead = 0;
try {
  git("fetch", "--quiet", "origin");
  localAhead = Number(git("rev-list", "--count", `origin/${ALLOW_BRANCH}..HEAD`));
  remoteAhead = Number(git("rev-list", "--count", `HEAD..origin/${ALLOW_BRANCH}`));
} catch {
  console.log(c.yellow("⚠ 无法访问远端，跳过同步检查"));
}
if (remoteAhead > 0) {
  fail(`本地落后远端 ${remoteAhead} 个提交，请先 git pull。`);
}
if (localAhead > 0 && !DRY_RUN) {
  fail(`本地有 ${localAhead} 个提交未推送，请先 git push 再发版（保证 tag 指向已发布代码）。`);
}

const current = readVersion();
const pkgVersion = JSON.parse(readFileSync(pkgFile, "utf8")).version;
if (current !== pkgVersion) {
  fail(`版本号不一致（src/version.ts=${current}，package.json=${pkgVersion}），请先 npm run version:sync。`);
}

// ---------------------------------------------------------------------------
// 2. 计算目标版本
// ---------------------------------------------------------------------------

const lastTag = (() => {
  try {
    return git("describe", "--tags", "--abbrev=0");
  } catch {
    return "";
  }
})();

const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
let commits = [];
try {
  commits = git("log", range, "--pretty=format:%s").split("\n").filter(Boolean);
} catch {
  commits = [];
}

const explicitSet = has("--set") ? argv[argv.indexOf("--set") + 1] : undefined;
const kinds = ["major", "minor", "patch"].filter((k) => has(`--${k}`));

if (has("--set")) {
  if (!explicitSet || !/^\d+\.\d+\.\d+$/.test(explicitSet)) {
    fail("--set 需要一个 x.y.z 形式的版本号，例如 --set 1.2.3");
  }
}
if (!has("--set") && kinds.length > 1) {
  fail("--patch / --minor / --major 只能选一个");
}

/** 按 Conventional Commits 推断版本类型 */
function inferKind() {
  let major = false;
  let minor = false;
  for (const s of commits) {
    if (/^(\w+)(\(.+\))?!:/.test(s) || /BREAKING[ -]CHANGE/i.test(s)) major = true;
    else if (/^feat(\(.+\))?:/.test(s)) minor = true;
  }
  return major ? "major" : minor ? "minor" : "patch";
}

const kind = kinds[0] ?? (has("--set") ? "set" : inferKind());
const next = explicitSet ?? bump(current, kind);

if (compareVersion(next, current) <= 0) {
  fail(`新版本号 ${next} 必须大于当前版本 ${current}`);
}

// ---------------------------------------------------------------------------
// 3. 生成 CHANGELOG 条目
// ---------------------------------------------------------------------------

const TYPE_LABEL = {
  feat: "新增",
  fix: "修复",
  perf: "性能",
  refactor: "重构",
  docs: "文档",
  test: "测试",
  build: "构建",
  ci: "CI",
  style: "样式",
  chore: "杂项",
  revert: "回滚",
};

function buildChangelogSection(version) {
  const groups = new Map();

  function push(label, text) {
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(text);
  }

  for (const subject of commits) {
    // 跳过发版提交本身与合并提交
    if (/^chore(\(.+\))?:\s*(发布|release)/i.test(subject)) continue;
    if (/^Merge (branch|pull request)/i.test(subject)) continue;

    const m = /^(\w+)(\([^)]+\))?(!)?:\s*(.+)$/.exec(subject);
    if (!m) {
      push("其他", subject);
      continue;
    }
    const [, type, scope, bang, desc] = m;
    const label = TYPE_LABEL[type] ?? "其他";
    push(label, scope ? `**${scope.slice(1, -1)}**: ${desc}` : desc + (bang ? "（破坏性变更）" : ""));
  }

  const date = new Date().toISOString().slice(0, 10);
  const lines = [`## [${version}] - ${date}`, ""];
  if (!groups.size) {
    lines.push("- 本版本无面向用户的变更", "");
  } else {
    // 固定顺序：新增 → 修复 → 其他
    const order = ["新增", "修复", "性能", "重构", "文档", "测试", "构建", "CI", "样式", "其他"];
    const keys = [...groups.keys()].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    for (const k of keys) {
      lines.push(`### ${k}`, "");
      for (const item of groups.get(k)) lines.push(`- ${item}`);
      lines.push("");
    }
  }
  return { text: lines.join("\n"), count: groups.size };
}

function writeChangelog(section) {
  const header = `# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

`;

  if (!existsSync(changelogFile)) {
    writeFileSync(changelogFile, header + section, "utf8");
    return;
  }

  const existing = readFileSync(changelogFile, "utf8");
  // 插到标题说明之后、第一个 ## 之前
  const idx = existing.indexOf("\n## [");
  if (idx < 0) {
    writeFileSync(changelogFile, existing.trimEnd() + "\n\n" + section, "utf8");
  } else {
    writeFileSync(changelogFile, existing.slice(0, idx + 1) + section + existing.slice(idx + 1), "utf8");
  }
}

const { text: section, count: sectionCount } = buildChangelogSection(next);

// ---------------------------------------------------------------------------
// 4. 执行
// ---------------------------------------------------------------------------

console.log();
console.log(c.bold("发版计划"));
console.log(`  当前版本   ${current}`);
console.log(`  目标版本   ${c.green(next)}  ${c.dim(`(${kind})`)}`);
console.log(`  上次 tag   ${lastTag || c.dim("(无)")}`);
console.log(`  本次提交   ${commits.length} 个`);
if (sectionCount) {
  console.log(c.dim("\n  CHANGELOG 条目："));
  console.log(section.split("\n").map((l) => "  " + c.dim(l)).join("\n"));
}

if (DRY_RUN) {
  console.log();
  console.log(c.yellow("这是预览模式，未做任何改动。"));
  console.log(c.dim("  加 --patch / --minor / --major / --set x.y.z 才会真正执行"));
  console.log(c.dim("  再加 --push 会在提交后自动推送提交与 tag"));
  console.log();
  process.exit(0);
}

// 跑测试
console.log();
console.log(c.dim("运行测试…"));
try {
  // Windows 上 npm 是 .cmd，需要走 shell 才能执行；把整个命令拼成一个字符串，
  // 避免 execFileSync 在 shell 模式下把参数和命令拼接产生的 DEP0190 警告。
  if (process.platform === "win32") {
    execFileSync(`npm run test`, { cwd: root, stdio: "pipe", shell: true });
  } else {
    execFileSync("npm", ["run", "test"], { cwd: root, stdio: "pipe" });
  }
  step("测试通过");
} catch (e) {
  const out = e.stdout?.toString() || e.message;
  fail(`测试失败，已中止发版：\n${out.slice(-2000)}`);
}

// 改版本号
writeVersion(next);
step(`版本号已更新：${current} → ${next}（version.ts / package.json / package-lock.json）`);

// 写 CHANGELOG
writeChangelog(section);
step(`CHANGELOG.md 已更新`);

// 提交
git("add", "-A");
git("commit", "-m", `chore: 发布 v${next}`);
step(`已提交：chore: 发布 v${next}`);

// 打 tag
git("tag", "-a", next, "-m", `v${next}\n\n${section}`);
step(`已创建附注 tag：${next}`);

// 推送
if (PUSH) {
  git("push", "origin", ALLOW_BRANCH);
  git("push", "origin", next);
  step(`已推送 master 与 tag ${next}`);
} else {
  console.log();
  console.log(c.yellow("未推送。确认无误后执行："));
  console.log(`  git push origin ${ALLOW_BRANCH} && git push origin ${next}`);
}

console.log();
console.log(c.green(c.bold(`发版完成：v${next}`)));
console.log();
