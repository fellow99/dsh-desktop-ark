#!/usr/bin/env bash
# 构建 HAP：同步载荷 → ohpm install（首次）→ hvigorw assembleHap。
#
# 用法：
#   bash scripts/build-hap.sh [--debug|--release] [--node-mode jit|compat]
#   109-jitless：--node-mode 会先调用 scripts/set-node-mode.mjs（同步 BuildConfig 常量与
#   module.json5 的 JIT 声明面），再构建；不传则沿用当前源码里的形态。
# 环境：
#   OHOS_CLT        DevEco Command Line Tools 根（默认 D:/oh-workspace/command-line-tools-6）
#   DEVECO_SDK_HOME SDK 根（默认 $OHOS_CLT/sdk）
#   ALLOW_MISSING=1 允许缺少 libnode.so 时仍产出 HAP（不可运行 Node）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLT="${OHOS_CLT:-D:/oh-workspace/command-line-tools-6}"
BUILD_MODE="debug"
NODE_MODE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --release) BUILD_MODE="release" ; shift ;;
    --debug) BUILD_MODE="debug" ; shift ;;
    --node-mode) NODE_MODE="${2:-}" ; shift 2 ;;
    --node-mode=*) NODE_MODE="${1#*=}" ; shift ;;
    *) echo "[build-hap] 未知参数：$1" >&2; exit 2 ;;
  esac
done
export DEVECO_SDK_HOME="${DEVECO_SDK_HOME:-$CLT/sdk}"
export PATH="$CLT/tool/node:$PATH"

# 109-jitless：形态切换放到 PATH 就绪之后，保证 node 可用
if [ -n "$NODE_MODE" ]; then
  node "$ROOT/scripts/set-node-mode.mjs" "$NODE_MODE"
fi

# 204-plugin-git：调试口按构建类型改写（debug=19229 / release=0；源码默认 0）。
# 放在这里而不是让开发者手改常量：release 构建不依赖任何人记得关。
INSPECT_PORT="0"
if [ "$BUILD_MODE" = "debug" ]; then
  INSPECT_PORT="19229"
fi
node "$ROOT/scripts/set-inspect.mjs" "$INSPECT_PORT"

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
