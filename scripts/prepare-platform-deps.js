#!/usr/bin/env node
/**
 * Fetch the native pieces a cross-platform build needs.
 *
 * Two separate problems, both invisible until someone runs the installer:
 *
 * 1. `npm install` only downloads the optional dependency for the host machine,
 *    so a macOS checkout has no `@fugood/node-whisper-win32-x64`. The Windows
 *    build would then start and fail to load the engine.
 * 2. `ffmpeg-static` ships exactly one binary, chosen for the host arch. A
 *    darwin-x64 build would silently package the arm64 ffmpeg and die on Intel
 *    Macs with "bad CPU type in executable".
 *
 * This script caches every binary we may need and installs the whisper binding
 * for each requested target. `scripts/after-pack.js` then copies the matching
 * ffmpeg into each packaged app.
 *
 *   node scripts/prepare-platform-deps.js win32-x64 darwin-x64 darwin-arm64
 */

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const CACHE = path.join(ROOT, ".cache", "platform-deps");
const NODE_MODULES = path.join(ROOT, "node_modules");

const WHISPER_VERSION = "1.2.0-rc.1";
const FFMPEG_RELEASE = "b6.1.1";

/** Binaries that differ per target and must be swapped at package time. */
function ffmpegCachePath(platform, arch) {
  const exe = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return path.join(CACHE, `ffmpeg-${platform}-${arch}`, exe);
}

function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return Promise.resolve(dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    const go = (target, redirects = 0) => {
      if (redirects > 6) return reject(new Error("too many redirects"));
      https
        .get(target, { headers: { "user-agent": "voice-scribe-build" } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return go(new URL(res.headers.location, target).toString(), redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`${target} -> HTTP ${res.statusCode}`));
          }
          const expected = Number(res.headers["content-length"] || 0);
          const tmp = `${dest}.part`;
          const file = fs.createWriteStream(tmp);
          res.pipe(file);
          file.on("finish", () => {
            file.close(() => {
              const got = fs.statSync(tmp).size;
              if (expected && got !== expected) {
                fs.rmSync(tmp, { force: true });
                return reject(new Error(`truncated: ${got}/${expected} bytes`));
              }
              fs.renameSync(tmp, dest);
              resolve(dest);
            });
          });
          file.on("error", reject);
        })
        .on("error", reject);
    };
    go(url);
  });
}

async function ensureWhisper(platform, arch) {
  const name = `node-whisper-${platform}-${arch}`;
  const dest = path.join(NODE_MODULES, "@fugood", name);
  if (fs.existsSync(path.join(dest, "index.node"))) {
    console.log(`  ${name}: already present`);
    return;
  }
  const tarball = path.join(CACHE, `${name}-${WHISPER_VERSION}.tgz`);
  const url = `https://registry.npmjs.org/@fugood/${name}/-/${name}-${WHISPER_VERSION}.tgz`;
  console.log(`  ${name}: downloading`);
  await download(url, tarball);

  const stage = path.join(CACHE, `${name}-extract`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  execFileSync("tar", ["xzf", tarball, "-C", stage]);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(path.join(stage, "package"), dest, { recursive: true });
  console.log(`  ${name}: installed`);
}

async function ensureFfmpeg(platform, arch) {
  const dest = ffmpegCachePath(platform, arch);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) {
    console.log(`  ffmpeg ${platform}-${arch}: already present`);
    return;
  }
  const gz = path.join(CACHE, `ffmpeg-${platform}-${arch}.gz`);
  const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_RELEASE}/ffmpeg-${platform}-${arch}.gz`;
  console.log(`  ffmpeg ${platform}-${arch}: downloading`);
  await download(url, gz);
  // The release asset is a bare gzip stream (not .tar.gz): decompress straight
  // into the binary and keep the executable bit.
  const buf = execFileSync("gunzip", ["-c", gz], { maxBuffer: 512 * 1024 * 1024 });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  if (platform !== "win32") fs.chmodSync(dest, 0o755);
  console.log(`  ffmpeg ${platform}-${arch}: installed (${(buf.length / 1e6).toFixed(0)} MB)`);
}

async function main() {
  const targets = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const wanted = targets.length ? targets : [`${process.platform}-${process.arch}`];

  for (const target of wanted) {
    const [platform, arch] = target.split("-");
    if (!platform || !arch) {
      console.error(`bad target "${target}", expected e.g. win32-x64`);
      process.exit(1);
    }
    console.log(`preparing ${platform}-${arch}`);
    await ensureWhisper(platform, arch);
    await ensureFfmpeg(platform, arch);
  }
  console.log("done");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { ffmpegCachePath };
