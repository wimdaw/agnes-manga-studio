/**
 * build-exe.mjs — Agnes 漫剧工坊 · 单文件可执行程序
 * ------------------------------------------------------------------
 * Node SEA：把 server.js 作为入口，把 lib/ 与 public/ 内嵌进 blob，
 * 再注入官方 Node 运行时。接收方无需安装 Node，下载即用。
 *
 * 支持在各自平台上原生构建（SEA 不能可靠跨平台产物）：
 *   Windows  → Agnes漫剧工坊.exe      （双击运行）
 *   macOS    → Agnes漫剧工坊          （chmod +x 后运行，已做 ad-hoc 签名）
 *   Linux    → Agnes漫剧工坊
 *
 * 用法：
 *   node tools/build-exe.mjs
 *   node tools/build-exe.mjs --out 自定义名字 --dist 输出目录
 *
 * 依赖：postject（devDependency，npm install 后可用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const NODE = process.execPath;
const PLATFORM = process.platform;
const IS_WIN = PLATFORM === 'win32';
const IS_MAC = PLATFORM === 'darwin';
const DEFAULT_OUT = IS_WIN ? 'Agnes漫剧工坊.exe' : 'Agnes漫剧工坊';
// 旧版本把 postject 放在 WorkBuddy 的共享目录里，保留这个回退以便本机打包
const WORKSPACE = path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy-ai', 'binaries', 'node', 'workspace');
const postjectRequire = createRequire(path.join(ROOT, 'package.json'));

const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT_NAME = valueOf('--out', DEFAULT_OUT);
const OUT_DIR = path.resolve(valueOf('--dist', DIST));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';

const log = (n, s) => console.log(`\n[${n}] ${s}`);
const size = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, base, out);
    else if (ent.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function findFuse(file) {
  const buf = fs.readFileSync(file);
  const m = /NODE_SEA_FUSE_[0-9a-f]+/.exec(buf.toString('latin1'));
  assert(m, '运行时里没有 SEA fuse；请换 Node 20+ 官方构建');
  return m[0];
}

function run(command, args, label, { allowFail = false } = {}) {
  const r = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', windowsHide: false });
  if (r.error) {
    if (allowFail) return false;
    throw new Error(`${label}：${r.error.message}`);
  }
  if (r.status !== 0) {
    if (allowFail) return false;
    throw new Error(`${label}失败，退出码 ${r.status}`);
  }
  return true;
}

/** 从项目或共享目录找 postject；找不到给出明确安装提示 */
function loadPostject() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'postject', 'package.json'),
    path.join(WORKSPACE, 'node_modules', 'postject', 'package.json'),
  ];
  for (const pkg of candidates) {
    if (!fs.existsSync(pkg)) continue;
    return createRequire(pkg)('postject');
  }
  throw new Error('缺少 postject：先执行 npm install（CI 里用 npm ci）');
}

async function main() {
  assert(Number(process.versions.node.split('.')[0]) >= 20, `Node 版本过低：${process.versions.node}`);
  assert(fs.existsSync(path.join(ROOT, 'server.js')), '缺少 server.js');
  assert(fs.existsSync(path.join(ROOT, 'public', 'index.html')), '缺少 public/index.html');
  const postject = loadPostject();

  fs.mkdirSync(BUILD, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`  平台 ${PLATFORM}/${process.arch} · Node ${process.versions.node} · 版本 ${VERSION}`);

  // 1. 收集静态资源。数据目录不打进发行包，避免把用户数据污染进去。
  log(1, '收集内嵌资源');
  const assets = {};
  for (const rel of walk(path.join(ROOT, 'lib'))) assets[`lib/${rel}`] = path.join(ROOT, 'lib', rel);
  for (const rel of walk(path.join(ROOT, 'public'))) assets[`public/${rel}`] = path.join(ROOT, 'public', rel);
  const assetList = Object.keys(assets);
  const assetBytes = Object.values(assets).reduce((n, file) => n + fs.statSync(file).size, 0);
  console.log(`  ${assetList.length} 个资源，总计 ${size(assetBytes)}`);

  // 2. SEA 配置。主脚本直接用源码 server.js；资源通过 assets 字段注入。
  log(2, '生成 SEA blob');
  const mainPath = path.join(BUILD, 'main.cjs');
  const configPath = path.join(BUILD, 'sea-config.json');
  const blobPath = path.join(BUILD, 'sea-prep.blob');
  fs.writeFileSync(mainPath, fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({
    main: mainPath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets,
  }, null, 2), 'utf8');
  run(NODE, ['--experimental-sea-config', configPath], 'SEA blob');
  assert(fs.existsSync(blobPath), 'SEA blob 没有生成');
  console.log(`  blob ${size(fs.statSync(blobPath).size)}`);

  // 3. 复制运行时并注入。
  log(3, '注入 Node 运行时');
  const tmpBin = path.join(BUILD, `AgnesStudio-${process.pid}${IS_WIN ? '.exe' : ''}`);
  const outBin = path.join(OUT_DIR, OUT_NAME);
  fs.copyFileSync(NODE, tmpBin);
  fs.chmodSync(tmpBin, 0o755);
  const fuse = findFuse(tmpBin);
  console.log(`  fuse ${fuse}`);

  // macOS 的 Node 是可执行文件且带签名：先去掉原签名，注入后重新 ad-hoc 签名，
  // 否则 arm64 上内核会直接拒绝执行（"killed: 9"）。
  if (IS_MAC) {
    run('codesign', ['--remove-signature', tmpBin], '移除原签名', { allowFail: true });
  }

  await postject.inject(tmpBin, 'NODE_SEA_BLOB', fs.readFileSync(blobPath), {
    sentinelFuse: fuse,
    // Mach-O 必须指定段名，PE/ELF 会忽略这个选项
    ...(IS_MAC ? { machoSegmentName: 'NODE_SEA' } : {}),
  });

  if (IS_MAC) {
    run('codesign', ['--sign', '-', '--force', tmpBin], 'ad-hoc 签名');
  }

  fs.copyFileSync(tmpBin, outBin);
  fs.chmodSync(outBin, 0o755);
  console.log(`  产物 ${outBin}`);
  console.log(`  大小 ${size(fs.statSync(outBin).size)}`);

  // 4. Windows 便携标记：双击后数据落在 exe 同级 data/。
  //    macOS 固定落到 ~/Library/Application Support/AgnesStudio（下载目录常常只读）。
  if (IS_WIN) {
    const portable = path.join(OUT_DIR, 'portable');
    if (!fs.existsSync(portable)) fs.writeFileSync(portable, '', 'utf8');
  }

  console.log('\n✓ 打包完成');
  console.log(`  运行：${outBin}`);
  console.log(`  数据：${IS_WIN ? path.join(OUT_DIR, 'data') : '~/Library/Application Support/AgnesStudio'}`);
}

main().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
});
