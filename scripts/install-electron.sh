#!/usr/bin/env bash
#
# 手动安装 Electron 二进制。
#
# 为什么需要这个脚本：
#   pnpm 10+ 默认拦截依赖的 postinstall，且 @electron/get@5 只认
#   ~/Library/Caches/electron（不再支持 ELECTRON_CACHE 环境变量）。
#   在受限环境或 GitHub 不可达时，官方安装流程会失败。
#   本脚本直接从镜像下载 → 校验官方 sha256 → 解压到 dist → 写 path.txt。
#
# 用法：
#   bash scripts/install-electron.sh
#   ELECTRON_MIRROR=https://github.com/electron/electron/releases/download/ bash scripts/install-electron.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PKG_DIR="node_modules/electron"
[ -f "$PKG_DIR/package.json" ] || { echo "找不到 $PKG_DIR，先跑 pnpm install"; exit 1; }

VERSION="$(node -p "require('./$PKG_DIR/package.json').version")"

case "$(uname -s)" in
  Darwin) PLATFORM="darwin" ;;
  Linux)  PLATFORM="linux" ;;
  *)      echo "暂不支持的系统：$(uname -s)"; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64" ;;
  *)             echo "暂不支持的架构：$(uname -m)"; exit 1 ;;
esac

ZIP="electron-v${VERSION}-${PLATFORM}-${ARCH}.zip"
MIRROR="${ELECTRON_MIRROR:-https://registry.npmmirror.com/-/binary/electron/}"
URL="${MIRROR}v${VERSION}/${ZIP}"
CACHE_DIR="${ELECTRON_CACHE:-$ROOT/.electron-cache}"
ZIP_PATH="$CACHE_DIR/$ZIP"

echo "版本   : $VERSION"
echo "目标   : $PLATFORM-$ARCH"
echo "下载源 : $URL"

mkdir -p "$CACHE_DIR"

if [ -f "$ZIP_PATH" ]; then
  echo "复用已下载的压缩包：$ZIP_PATH"
else
  echo "下载中…"
  curl -fSL --retry 3 --retry-delay 2 -o "$ZIP_PATH.part" "$URL"
  mv "$ZIP_PATH.part" "$ZIP_PATH"
fi

# 用官方 checksums.json 校验完整性
EXPECTED="$(node -p "require('./$PKG_DIR/checksums.json')['$ZIP'] || ''")"
if [ -n "$EXPECTED" ]; then
  ACTUAL="$(shasum -a 256 "$ZIP_PATH" | awk '{print $1}')"
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "sha256 校验失败！"
    echo "  期望 $EXPECTED"
    echo "  实际 $ACTUAL"
    rm -f "$ZIP_PATH"
    exit 1
  fi
  echo "sha256 校验通过"
else
  echo "⚠️  checksums.json 里没有 $ZIP 的记录，跳过校验"
fi

echo "解压到 $PKG_DIR/dist …"
rm -rf "$PKG_DIR/dist"
mkdir -p "$PKG_DIR/dist"
# macOS 上用 ditto：它能正确还原 .app 包内的符号链接、权限与扩展属性。
# （unzip 本次也能用，但 ditto 是 macOS 上的正确工具。）
if command -v ditto >/dev/null 2>&1; then
  ditto -x -k "$ZIP_PATH" "$PKG_DIR/dist"
else
  unzip -q -o "$ZIP_PATH" -d "$PKG_DIR/dist"
fi

# electron/index.js 会读 path.txt，并与 dist/ 拼成可执行文件路径。
# ⚠️ 这里**不能**带 `dist/` 前缀：electron 44 的 index.js 是
#    path.join(__dirname, 'dist', pathTxt 内容)；写成 dist/... 会拼成 dist/dist/...
#    官方 install.js 的 getPlatformPath() 也是不带前缀的。
case "$PLATFORM" in
  darwin) printf 'Electron.app/Contents/MacOS/Electron' > "$PKG_DIR/path.txt" ;;
  linux)  printf 'electron' > "$PKG_DIR/path.txt" ;;
esac

chmod +x "$PKG_DIR/dist/Electron.app/Contents/MacOS/Electron" 2>/dev/null || true

echo
echo "完成：$(cat "$PKG_DIR/path.txt")"
node -e "console.log('可执行文件：' + require('electron'))"
