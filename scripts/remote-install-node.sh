#!/usr/bin/env bash
# 在远端 Linux 上安装 Node.js（>= 24.9），供部署脚本调用。
# 幂等：已存在满足版本要求的 node 时直接退出；重复执行不会重复下载安装。
#
# 环境变量：
#   NODE_VERSION  目标版本，默认 v24.14.1
#   REGISTRY      npm 镜像，用于拼 Node 二进制镜像地址，默认 npmmirror
#   NODE_PREFIX   安装根目录，默认 /usr/local/lib/nodejs
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-v24.14.1}"
REGISTRY="${REGISTRY:-https://registry.npmmirror.com}"
NODE_PREFIX="${NODE_PREFIX:-/usr/local/lib/nodejs}"

min_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const v=process.versions.node.split(".").map(Number); process.exit(v[0]>24||(v[0]===24&&v[1]>=9)?0:1)' 2>/dev/null
}

# 把 Node 私有目录下的可执行文件（node/npm/npx/pnpm/...）链到 /usr/local/bin，
# 保证非登录 shell 也能直接调用；重复执行安全。
link_bins() {
  local entry
  [[ -d "$NODE_PREFIX/current/bin" ]] || return 0
  for entry in "$NODE_PREFIX/current/bin/"*; do
    [[ -e "$entry" ]] || continue
    ln -sf "$entry" "/usr/local/bin/$(basename "$entry")"
  done
}

if min_ok; then
  link_bins
  echo "已有 Node $(node -v)（满足 >= 24.9），跳过安装。"
  exit 0
fi

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch_tag="x64" ;;
  aarch64|arm64) arch_tag="arm64" ;;
  *) echo "错误：不支持的架构 $arch" >&2; exit 1 ;;
esac

pkg="node-${NODE_VERSION}-linux-${arch_tag}"
urls=(
  "${REGISTRY}/-/binary/node/${NODE_VERSION}/${pkg}.tar.gz"
  "https://mirrors.aliyun.com/nodejs-release/${NODE_VERSION}/${pkg}.tar.gz"
  "https://nodejs.org/dist/${NODE_VERSION}/${pkg}.tar.gz"
)

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

echo "下载 ${pkg}.tar.gz ..."
ok=0
for url in "${urls[@]}"; do
  echo "  尝试 $url"
  if curl -fL --retry 2 --connect-timeout 10 -m 600 -o "$workdir/node.tar.gz" "$url"; then
    ok=1
    break
  fi
done
if [[ "$ok" != "1" ]]; then
  echo "错误：Node 二进制下载失败（已尝试 ${#urls[@]} 个地址）。" >&2
  exit 1
fi

mkdir -p "$NODE_PREFIX"
rm -rf "$NODE_PREFIX/$pkg"
tar -xzf "$workdir/node.tar.gz" -C "$NODE_PREFIX"
ln -sfn "$NODE_PREFIX/$pkg" "$NODE_PREFIX/current"

link_bins

echo "已安装 Node $(node -v)（$NODE_PREFIX/current）"
