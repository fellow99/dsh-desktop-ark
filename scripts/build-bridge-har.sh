#!/usr/bin/env bash
# 构建并投放 @fellow99/node-bridge HAR（跨工程消费必须用 HAR：useNormalizedOHMUrl 拒绝源码相对导入）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLT="${OHOS_CLT:-D:/oh-workspace/command-line-tools-6}"
BRIDGE="$(cd "$ROOT/../ohos-node-bridge" && pwd)"
HAR_OUT="$BRIDGE/library/build/default/outputs/default/library.har"
DEST="$ROOT/libs/@fellow99/node-bridge.har"

if [ ! -f "$CLT/bin/hvigorw.bat" ]; then
  echo "[build-bridge-har] 找不到 hvigorw：$CLT/bin/hvigorw.bat（用 OHOS_CLT 指定）" >&2
  exit 2
fi

export DEVECO_SDK_HOME="${DEVECO_SDK_HOME:-$CLT/sdk}"
export PATH="$CLT/tool/node:$PATH"

HWIGOR_WIN="$(cygpath -w "$CLT/bin/hvigorw.bat")"
echo "[build-bridge-har] hvigor: $HWIGOR_WIN"
(cd "$BRIDGE" && cmd //c "$HWIGOR_WIN --mode module -p module=library@default assembleHar --no-daemon")

if [ ! -f "$HAR_OUT" ]; then
  echo "[build-bridge-har] 构建结束但未找到 HAR：$HAR_OUT" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
cp "$HAR_OUT" "$DEST"
echo "[build-bridge-har] $(ls -l "$DEST" | awk '{print $5" bytes -> "$9}')"
