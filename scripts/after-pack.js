/**
 * electron-builder afterPack hook: make the native bits match the target.
 *
 * Two jobs, both about binaries that `npm install` picked for the *host* rather
 * than the target being packaged:
 *
 * 1. `ffmpeg-static` ships exactly one binary. A darwin-x64 build on an arm64
 *    machine would package the arm64 ffmpeg and die on Intel Macs with "bad CPU
 *    type in executable".
 * 2. Every `@fugood/node-whisper-*` optional dependency that happens to be
 *    installed gets copied in, so a mac build carries the Windows binding and
 *    vice versa — several MB of dead weight per installer.
 *
 * On a native runner (GitHub Actions) npm already installed the right ffmpeg
 * and only the matching whisper binding, so the cache is unused and pruning is
 * a no-op.
 */

const fs = require("node:fs");
const path = require("node:path");
const { ffmpegCachePath } = require("./prepare-platform-deps");

const ARCH_NAMES = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

function resourcesDir(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  return electronPlatformName === "darwin"
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : path.join(appOutDir, "resources");
}

function installFfmpeg(resources, platform, archName) {
  const exeName = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const target = path.join(resources, "app.asar.unpacked", "node_modules", "ffmpeg-static");
  const dest = path.join(target, exeName);

  // Prefer the binary cached for this exact target; fall back to whatever npm
  // installed, which is already correct on a native runner.
  const cached = ffmpegCachePath(platform, archName);
  const installed = path.join(__dirname, "..", "node_modules", "ffmpeg-static", exeName);

  let source = null;
  if (fs.existsSync(cached)) source = cached;
  else if (fs.existsSync(installed)) source = installed;
  else {
    throw new Error(
      `missing ffmpeg for ${platform}-${archName}.\n` +
        `Run: node scripts/prepare-platform-deps.js ${platform}-${archName}`,
    );
  }

  fs.mkdirSync(target, { recursive: true });
  // Drop the host's binary when it has the other name: it cannot run on this
  // target and only inflates the installer.
  fs.rmSync(path.join(target, platform === "win32" ? "ffmpeg" : "ffmpeg.exe"), { force: true });

  if (path.resolve(source) !== path.resolve(dest)) fs.copyFileSync(source, dest);
  if (platform !== "win32") fs.chmodSync(dest, 0o755);

  const mb = (fs.statSync(dest).size / 1e6).toFixed(0);
  console.log(`  • ffmpeg  ${platform}-${archName} (${mb} MB)`);
}

function pruneWhisperBindings(resources, platform, archName) {
  const root = path.join(resources, "app.asar.unpacked", "node_modules", "@fugood");
  if (!fs.existsSync(root)) return;

  const wanted = `node-whisper-${platform}-${archName}`;
  for (const entry of fs.readdirSync(root)) {
    // Keep the JS wrapper and the binding for this target only.
    if (entry === "whisper.node" || entry === wanted) continue;
    fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    console.log(`  • pruned  @fugood/${entry}`);
  }
}

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const archName = ARCH_NAMES[context.arch] || "x64";
  const resources = resourcesDir(context);

  installFfmpeg(resources, platform, archName);
  pruneWhisperBindings(resources, platform, archName);
};
