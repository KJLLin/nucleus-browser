'use strict';
/**
 * Windows 打包脚本（Linux 上交叉构建，全程不依赖 wine）。
 *
 * @electron/packager 在 win32 目标下会强制调用 rcedit（需要 wine），
 * 所以这里改成手动组装：
 *   1. 下载 Electron 22.3.27 win32-x64 运行时（最后一个支持 Win7 的版本）
 *   2. 解压 → 重命名 electron.exe → 打包 app.asar → 清理默认应用
 *   3. 用 resedit 纯 JS 写入图标与版本信息
 *   4. 打 zip
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { NtExecutable, NtExecutableResource, Resource, Data } = require('resedit');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const STAGE = path.join(ROOT, '.cache', 'stage');
const APP_NAME = 'Nucleus';
const ELECTRON_VERSION = '22.3.27';
const VERSION = require(path.join(ROOT, 'package.json')).version;

const log = (...a) => console.log('[pack]', ...a);

function ensureElectronZip() {
  const cacheDir = path.join(ROOT, '.cache', 'electron');
  fs.mkdirSync(cacheDir, { recursive: true });
  const zip = path.join(cacheDir, `electron-v${ELECTRON_VERSION}-win32-x64.zip`);
  if (fs.existsSync(zip) && fs.statSync(zip).size > 50 * 1024 * 1024) {
    log('复用已下载的 Electron 运行时');
    return zip;
  }
  const url = `https://npmmirror.com/mirrors/electron/${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-win32-x64.zip`;
  log('下载', url);
  execFileSync('curl', ['-L', '--fail', '--retry', '3', '-o', zip, url], { stdio: 'inherit' });
  log('下载完成', (fs.statSync(zip).size / 1024 / 1024).toFixed(1), 'MB');
  return zip;
}

function prepareStage() {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  fs.cpSync(path.join(ROOT, 'src'), path.join(STAGE, 'src'), { recursive: true });
  // 配置 profile 随包发布：没有这一层，--profile=minimal 之类会在发行版里失效
  fs.cpSync(path.join(ROOT, 'profiles'), path.join(STAGE, 'profiles'), { recursive: true });
  // 文档随包发布：README 里引用了 docs/WINDOW-UI.md，缺了它链接就是断的
  const docsDir = path.join(ROOT, 'docs');
  if (fs.existsSync(docsDir)) fs.cpSync(docsDir, path.join(STAGE, 'docs'), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // 运行期不需要任何依赖：删掉脚本与开发依赖，让 asar 干净
  delete pkg.devDependencies;
  delete pkg.scripts;
  pkg.main = 'src/main/main.js';
  fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(pkg, null, 2));
}

function buildAppDir(zipPath) {
  const appDir = path.join(OUT, `${APP_NAME}-win32-x64`);
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(appDir, { recursive: true });
  log('解压运行时…');
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', appDir]);

  const exeFrom = path.join(appDir, 'electron.exe');
  const exeTo = path.join(appDir, `${APP_NAME}.exe`);
  fs.renameSync(exeFrom, exeTo);

  // 移除 Electron 的默认应用，避免它被当作 fallback 加载
  const defaultApp = path.join(appDir, 'resources', 'default_app.asar');
  if (fs.existsSync(defaultApp)) fs.rmSync(defaultApp);

  // 刻意不用 app.asar：Cordis 是 ESM，Node 的 ESM 解析器不认 asar 虚拟路径，
  // 从 asar 里 import('file://...app.asar/...') 会直接失败。
  // 直接发布 resources/app 目录，代价只是多几十个文件，换来可读的源码。
  log('写入 resources/app…');
  const appOut = path.join(appDir, 'resources', 'app');
  fs.rmSync(appOut, { recursive: true, force: true });
  fs.cpSync(STAGE, appOut, { recursive: true });

  // 老版本的 default_app 不能留，否则会被当成兜底应用加载
  const legacyAsar = path.join(appDir, 'resources', 'app.asar');
  if (fs.existsSync(legacyAsar)) fs.rmSync(legacyAsar);

  return { appDir, exePath: exeTo };
}

/** 用纯 JS 改写 PE 资源（图标 + 版本信息），不需要 wine */
function patchExe(exePath) {
  if (!fs.existsSync(exePath)) throw new Error(`找不到 ${exePath}`);
  const exe = NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  const icoPath = path.join(ROOT, 'build', 'icon.ico');
  if (fs.existsSync(icoPath)) {
    const iconFile = Data.IconFile.from(fs.readFileSync(icoPath));
    Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      1,
      1033,
      iconFile.icons.map((item) => item.data)
    );
    log('图标已写入');
  }

  const viList = Resource.VersionInfo.fromEntries(res.entries);
  if (viList.length) {
    const vi = viList[0];
    vi.setStringValues({ lang: 1033, codepage: 1200 }, {
      CompanyName: 'Nucleus Project',
      FileDescription: `${APP_NAME} Browser`,
      FileVersion: VERSION,
      InternalName: APP_NAME,
      LegalCopyright: 'MIT License',
      OriginalFilename: `${APP_NAME}.exe`,
      ProductName: APP_NAME,
      ProductVersion: VERSION,
      Comments: 'Chromium 108.0.5359.215 · Windows 7+',
    });
    vi.outputToResourceEntries(res.entries);
    log('版本信息已写入');
  } else {
    log('未找到版本资源，跳过');
  }

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
}

function copyDocs(appDir) {
  for (const f of ['README.md', 'LICENSE']) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(appDir, f));
  }
}

function main() {
  log(`构建 ${APP_NAME} ${VERSION} · Electron ${ELECTRON_VERSION} · win32-x64`);
  const zip = ensureElectronZip();
  prepareStage();
  const { appDir, exePath } = buildAppDir(zip);
  patchExe(exePath);
  copyDocs(appDir);

  const size = execFileSync('du', ['-sh', appDir]).toString().split('\t')[0];
  log('应用目录就绪：', appDir, `(${size})`);
  const zipPath = packageZip(appDir);
  log('完成：', zipPath);
}

main();

// ---------- 追加：打包成 zip ----------

function packageZip(appDir) {
  const pkgRoot = path.join(OUT, 'package');
  fs.rmSync(pkgRoot, { recursive: true, force: true });
  fs.mkdirSync(pkgRoot, { recursive: true });

  log('整理交付目录…');
  fs.cpSync(appDir, path.join(pkgRoot, 'Nucleus'), { recursive: true });

  // 附带源码，方便二次开发
  const srcOut = path.join(pkgRoot, 'source');
  fs.mkdirSync(srcOut, { recursive: true });
  for (const item of ['src', 'build', 'profiles', 'test-extensions', 'package.json', 'README.md', 'LICENSE']) {
    const from = path.join(ROOT, item);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(srcOut, item), { recursive: true });
  }

  // 使用说明：放在包根目录，双击解压后第一眼就能看到
  const readme = path.join(ROOT, 'build', 'START-HERE.txt');
  if (fs.existsSync(readme)) fs.copyFileSync(readme, path.join(pkgRoot, 'START-HERE.txt'));

  const zipName = `${APP_NAME}-${VERSION}-win7-x64.zip`;
  const zipPath = path.join(OUT, zipName);
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  log('压缩中（这一步较慢）…');
  execFileSync('zip', ['-r', '-9', '-q', zipPath, 'Nucleus', 'source', 'START-HERE.txt'], { cwd: pkgRoot });
  const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
  log(`交付包：${zipPath} (${mb} MB)`);
  return zipPath;
}
