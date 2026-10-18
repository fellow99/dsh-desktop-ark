#!/usr/bin/env bash
# 投放 Node 运行时（libnode.so + libc++_shared.so）到 entry/libs/arm64-v8a。
# 二进制不入库；由 ohos-node-bridge/tools/provision.mjs 统一投放并做七项 ELF 门禁。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROVISION="$ROOT/../ohos-node-bridge/tools/provision.mjs"
OUT="$ROOT/entry/libs/arm64-v8a"

if [ ! -f "$PROVISION" ]; then
  echo "[provision-runtime] 找不到 $PROVISION" >&2
  exit 2
fi

if node "$PROVISION" --check >/dev/null 2>&1; then
  node "$PROVISION" --out "$OUT"
  echo "[provision-runtime] ok -> $OUT"
  exit 0
fi

if [ "${ALLOW_MISSING:-0}" = "1" ]; then
  echo "[provision-runtime] 运行时未就位，ALLOW_MISSING=1 → 跳过（HAP 不含 libnode.so，无法运行 Node）" >&2
  exit 0
fi

cat >&2 <<'EOF'
[provision-runtime] 运行时未就位。
获取方式（任选其一）：
  1) node ../ohos-node-bridge/tools/provision.mjs --download   # 从上游 Release 拉取并校验
  2) node ../ohos-node-bridge/tools/provision.mjs --from <dir> # 从本地缓存/制品库拉取
校验通过后重跑本脚本。只想先编译 HAP 可设 ALLOW_MISSING=1。
EOF
exit 2
