#!/usr/bin/env bash
# 构建 HAP：同步载荷 → ohpm install（中心仓依赖）→ hvigorw assembleHap。
#
# 用法：
#   bash scripts/build-hap.sh [--debug|--release] [--node-mode jit|compat]
#   119-jitless：--node-mode 会先调用 scripts/set-node-mode.mjs（同步 BuildConfig 常量与
#   module.json5 的 JIT 声明面），再构建；不传则沿用当前源码里的形态。
# 环境：
#   OHOS_CLT        工具链根：既可是 **Command Line Tools**（<root>/bin + <root>/sdk + <root>/tool/node），
#                   也可是 **DevEco Studio 安装根**（<root>/tools/{hvigor,ohpm,node}/bin + <root>/sdk + <root>/jbr）；
#                   默认 D:/oh-workspace/command-line-tools。两种布局自动识别。
#   DEVECO_SDK_HOME SDK 根（默认 $OHOS_CLT/sdk）
#
# 注意（签名失败的坑）：hvigor 的 SignHap 任务不指定 java，取 PATH 里的第一个 java。
# 机器上若装了别的 JDK（如 sdkman 的 Temurin），签名会报
#   ERROR: 11012006 File IO failed / Invalid CEN header (invalid zip64 extra data field size)
# 这与 HAP 内容无关。脚本会把 DevEco 自带 **JBR** 前置到 PATH，规避该问题。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLT="${OHOS_CLT:-D:/oh-workspace/command-line-tools}"
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
# 工具链布局自适应：Command Line Tools 是 <root>/bin + <root>/sdk + <root>/tool/node；
# DevEco Studio 是 <root>/tools/{hvigor,ohpm,node}/bin + <root>/sdk + <root>/jbr。
# 两种都支持，避免换机器/换安装方式就要手改脚本。
first_exist() { local c; for c in "$@"; do [ -e "$c" ] && { printf '%s
' "$c"; return 0; }; done; return 1; }

HVIGORW="$(first_exist "$CLT/bin/hvigorw.bat" "$CLT/tools/hvigor/bin/hvigorw.bat" || true)"
OHPM_BAT="$(first_exist "$CLT/bin/ohpm.bat" "$CLT/tools/ohpm/bin/ohpm.bat" || true)"
NODE_DIR="$(first_exist "$CLT/tool/node" "$CLT/tools/node" || true)"
SDK_DIR="$(first_exist "$CLT/sdk" || true)"
[ -n "$HVIGORW" ]  || { echo "[build-hap] 找不到 hvigorw.bat（CLT 或 DevEco Studio 布局）" >&2; exit 2; }
[ -n "$OHPM_BAT" ] || { echo "[build-hap] 找不到 ohpm.bat（CLT 或 DevEco Studio 布局）" >&2; exit 2; }

export DEVECO_SDK_HOME="${DEVECO_SDK_HOME:-$SDK_DIR}"
if [ -n "$NODE_DIR" ]; then export PATH="$(cygpath -u "$NODE_DIR"):$PATH"; fi

# 签名工具（hap-sign-tool.jar）必须用 DevEco 自带 JBR 运行：hvigor 的 SignHap 任务不指定 java，
# 而是取 PATH 里的第一个 java。若机器上装了其它 JDK（如 sdkman 的 Temurin 21），
# zip 解析行为不同，签名会报极具误导性的
#   ERROR: 11012006 File IO failed / Invalid CEN header (invalid zip64 extra data field size)
# 而同一命令用 JBR 执行则完全正常。与 dsh-desktop-hos 的 build-hap.ps1 保持同一口径。
# 探测 JBR 是否存在（Windows 下文件是 java.exe，`-x …/jbr/bin/java` 会漏判）。
find_jbr_java() {
  local cand
  for cand in "$1/jbr/bin/java" "$1/jbr/bin/java.exe"; do
    [ -f "$cand" ] && { printf '%s\n' "$1/jbr"; return 0; }
  done
  return 1
}
JBR=""
JBR="$(find_jbr_java "$CLT" || true)"
if [ -z "$JBR" ]; then JBR="$(find_jbr_java "$(dirname "$CLT")/deveco-studio-6" || true)"; fi
if [ -z "$JBR" ]; then JBR="$(find_jbr_java "$(dirname "$CLT")/deveco-studio-24" || true)"; fi
if [ -n "$JBR" ]; then
  # PATH 里必须放 POSIX 形式（cygpath -u），否则 MSYS bash 查不到 java.exe
  export PATH="$(cygpath -u "$JBR/bin"):$PATH"
  export JAVA_HOME="$JBR"
  echo "[build-hap] 签名 java → $JBR/bin"
else
  echo "[build-hap] 警告：未找到 DevEco JBR，签名可能因 PATH 里的其它 JDK 而失败（见脚本注释）" >&2
fi

# 119-jitless：形态切换放到 PATH 就绪之后，保证 node 可用
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

# 1) 载荷脚本同步（resfile）
node "$ROOT/scripts/sync-payload.mjs"
node "$ROOT/scripts/package-payload.mjs"

# 2) ohpm install（中心仓依赖：@fellow99/node-bridge + @fellow99/node-runtime）
cd "$ROOT"
echo "[build-hap] ohpm install"
cmd //c "$(cygpath -w "$OHPM_BAT")" install

# 3) 构建
HWIGOR_WIN="$(cygpath -w "$HVIGORW")"
cmd //c "$HWIGOR_WIN --mode module -p product=default -p buildMode=$BUILD_MODE assembleHap --no-daemon"

echo "[build-hap] done:"
ls -l "$ROOT/entry/build/default/outputs/default/" 2>/dev/null || true
