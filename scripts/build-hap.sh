#!/usr/bin/env bash
# 构建 HAP：同步载荷 → ohpm install（首次）→ hvigorw assembleHap。
#
# 用法：
#   bash scripts/build-hap.sh [--debug|--release]
# 环境：
#   OHOS_CLT        DevEco Command Line Tools 根（默认 D:/oh-workspace/command-line-tools-6）
#   DEVECO_SDK_HOME SDK 根（默认 $OHOS_CLT/sdk）
#   ALLOW_MISSING=1 允许缺少 libnode.so 时仍产出 HAP（不可运行 Node）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLT="${OHOS_CLT:-D:/oh-workspace/command-line-tools-6}"
BUILD_MODE="debug"
for arg in "$@"; do
  case "$arg" in
    --release) BUILD_MODE="release" ;;
    --debug) BUILD_MODE="debug" ;;
    *) echo "[build-hap] 未知参数：$arg" >&2; exit 2 ;;
  esac
done

export DEVECO_SDK_HOME="${DEVECO_SDK_HOME:-$CLT/sdk}"
export PATH="$CLT/tool/node:$PATH"

echo "[build-hap] mode=$BUILD_MODE sdk=$DEVECO_SDK_HOME"

# 1) HAR 依赖（缺失则现场构建）
if [ ! -f "$ROOT/libs/@fellow99/node-bridge.har" ]; then
  echo "[build-hap] 缺少 HAR，先构建 @fellow99/node-bridge"
  bash "$ROOT/scripts/build-bridge-har.sh"
fi

# 2) 运行时（可选缺失：只影响运行，不影响编译）
ALLOW_MISSING="${ALLOW_MISSING:-0}" bash "$ROOT/scripts/provision-runtime.sh" || {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "[build-hap] 运行时投放失败（status=$status）" >&2
    exit "$status"
  fi
}

# 3) 载荷脚本同步（resfile）
node "$ROOT/scripts/sync-payload.mjs"
node "$ROOT/scripts/package-payload.mjs"

# 4) ohpm install（首次或依赖变化）
cd "$ROOT"
if [ ! -d "oh_modules" ]; then
  echo "[build-hap] ohpm install"
  cmd //c "$(cygpath -w "$CLT/bin/ohpm.bat") install"
fi

# 5) 构建
HWIGOR_WIN="$(cygpath -w "$CLT/bin/hvigorw.bat")"
cmd //c "$HWIGOR_WIN --mode module -p product=default -p buildMode=$BUILD_MODE assembleHap --no-daemon"

echo "[build-hap] done:"
ls -l "$ROOT/entry/build/default/outputs/default/" 2>/dev/null || true
