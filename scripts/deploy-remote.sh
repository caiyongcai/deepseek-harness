#!/usr/bin/env bash
# 远程部署 DeepSeek Harness Web 服务。
#
# 用法：
#   scripts/deploy-remote.sh --host <IP> --user <用户名> --path <远端目录> \
#     [--password <密码>] [--port 3081] [--bind <远端网卡IP>] [--api-key <sk-...>]
#     [--registry <npm镜像>] [--skip-build] [--skip-install] [--no-migrate]
#     [--trusted-host <host[:port]>...] [--copy-credentials] [--rollback <迁移ID>] [--status] [--logs [行数]] [--stop] [--restart]
#
# 关键设计：
# 1. 代码与数据分离：代码在 <path>/app，数据（DSH_HOME）在 <path>/data/.dsh。
#    打包内容只含仓库与构建产物，本机 ~/.dsh 永不上传，不会覆盖远端数据。
# 2. 表结构（存储 schema）变更：把迁移脚本加进 scripts/migrations/ 即随包上传，
#    部署时自动执行「未应用的迁移」，每个迁移执行前自动备份远端数据目录，
#    迁移失败即中止部署；回滚用 --rollback <迁移ID>（需要对应的 .rollback.sh）。
# 3. 幂等：迁移按记录只跑一次，且必须可安全重复执行（先检查后写入 + 原子替换）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

HOST=""
REMOTE_USER=""
PASSWORD=""
REMOTE_PATH=""
PORT="3081"
BIND_HOST=""
API_KEY=""
REGISTRY="https://registry.npmmirror.com"
SKIP_BUILD="0"
SKIP_INSTALL="0"
NO_MIGRATE="0"
COPY_CREDENTIALS="0"
ACTION="deploy"
ROLLBACK_ID=""
LOG_LINES="80"
TRUSTED_HOSTS=()

usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed -n '3,20p'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --user) REMOTE_USER="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --path) REMOTE_PATH="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --bind) BIND_HOST="$2"; shift 2 ;;
    --api-key) API_KEY="$2"; shift 2 ;;
    --registry) REGISTRY="$2"; shift 2 ;;
    --trusted-host) TRUSTED_HOSTS+=("$2"); shift 2 ;;
    --skip-build) SKIP_BUILD="1"; shift ;;
    --skip-install) SKIP_INSTALL="1"; shift ;;
    --no-migrate) NO_MIGRATE="1"; shift ;;
    --copy-credentials) COPY_CREDENTIALS="1"; shift ;;
    --rollback) ACTION="rollback"; ROLLBACK_ID="$2"; shift 2 ;;
    --status) ACTION="status"; shift ;;
    --logs) ACTION="logs"; [[ "${2:-}" =~ ^[0-9]+$ ]] && { LOG_LINES="$2"; shift; }; shift ;;
    --stop) ACTION="stop"; shift ;;
    --restart) ACTION="restart"; shift ;;
    -h|--help) usage 0 ;;
    *) echo "未知参数：$1"; usage 1 ;;
  esac
done

if [[ -z "$HOST" || -z "$REMOTE_USER" ]]; then
  echo "错误：--host 与 --user 必填。"
  usage 1
fi

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o LogLevel=ERROR)
PASSWORD_AUTH_OPTS=(-o PreferredAuthentications=password -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=1)
NODE_VERSION="${NODE_VERSION:-v24.14.1}"

# 密码登录：优先 sshpass；没有 sshpass（Windows / Git Bash 常见）时退回 SSH_ASKPASS，
# 两者都不需要交互输入。密码写入仅本人可读的临时文件，退出时删除。
USE_SSHPASS="0"
ASKPASS_FILE=""

prepare_password_auth() {
  [[ -z "$PASSWORD" ]] && return 0
  if command -v sshpass >/dev/null 2>&1; then
    USE_SSHPASS="1"
    return 0
  fi
  local dir="${TMPDIR:-/tmp}"
  ASKPASS_FILE="$dir/dsh-askpass.$$.$RANDOM"
  printf '#!/bin/sh\nprintf "%%s\\n" %q\n' "$PASSWORD" > "$ASKPASS_FILE"
  chmod 700 "$ASKPASS_FILE"
  export SSH_ASKPASS="$ASKPASS_FILE" SSH_ASKPASS_REQUIRE=force
  export DISPLAY="${DISPLAY:-:0}"
  trap 'rm -f "$ASKPASS_FILE"' EXIT
}

remote_run() {
  if [[ -n "$PASSWORD" ]]; then
    if [[ "$USE_SSHPASS" == "1" ]]; then
      sshpass -p "$PASSWORD" ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$HOST" "$@"
    else
      ssh "${SSH_OPTS[@]}" "${PASSWORD_AUTH_OPTS[@]}" "$REMOTE_USER@$HOST" "$@"
    fi
  else
    ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$HOST" "$@"
  fi
}

remote_copy() {
  if [[ -n "$PASSWORD" ]]; then
    if [[ "$USE_SSHPASS" == "1" ]]; then
      sshpass -p "$PASSWORD" scp "${SSH_OPTS[@]}" "$1" "$REMOTE_USER@$HOST:$2"
    else
      scp "${SSH_OPTS[@]}" "${PASSWORD_AUTH_OPTS[@]}" "$1" "$REMOTE_USER@$HOST:$2"
    fi
  else
    scp "${SSH_OPTS[@]}" "$1" "$REMOTE_USER@$HOST:$2"
  fi
}

# 密码登录准备（sshpass 或 SSH_ASKPASS 兜底）。
prepare_password_auth

# 本机 Node 版本只影响 --skip-build 之外的构建；仓库要求 >= 24.9。
ensure_local_node() {
  if command -v node >/dev/null 2>&1 \
    && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
    return
  fi
  if [[ -x "/c/Program Files/nodejs/node.exe" ]]; then
    export PATH="/c/Program Files/nodejs:$PATH"
  fi
  node -e 'const v=process.versions.node.split(".").map(Number); if(v[0]<24||(v[0]===24&&v[1]<9)) { console.error("本机 Node 需要 >= 24.9，当前 "+process.versions.node); process.exit(1) }'
}

do_build() {
  echo "==> 本机构建 build:artifacts ..."
  ensure_local_node
  (cd "$REPO_ROOT" && CODEBUDDY_SAFE_DELETE_ENABLED=0 pnpm --config.verify-deps-before-run=false run build:artifacts)
}

do_package() {
  # 注意：本函数的 stdout 只用于返回包路径，进度信息一律走 stderr。
  echo "==> 打包仓库与构建产物 ..." >&2
  # 用仓库内相对路径做中间文件：Windows 下绝对路径含 "C:" 会被 tar 当成远程主机名。
  local stage="$REPO_ROOT/.deploy-tmp"
  rm -rf "$stage" 2>/dev/null || true
  mkdir -p "$stage"
  local work_tar="$stage/dsh-deploy.tar"
  if git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    # 已跟踪文件 + 构建产物（各包 lib/ 与 apps/web/dist/，均被 .gitignore 排除）+ migrations。
    git -C "$REPO_ROOT" archive --format=tar -o "$work_tar" HEAD
    (cd "$REPO_ROOT" && find packages apps vendor native -type d -name node_modules -prune \
      -o -type d \( -name lib -o -name dist \) -prune -print | tar -rf "$work_tar" -T -)
    [[ -d "$REPO_ROOT/scripts/migrations" ]] && (cd "$REPO_ROOT" && tar -rf "$work_tar" scripts/migrations)
  else
    tar -cf "$work_tar" -C "$REPO_ROOT" \
      --exclude=node_modules --exclude=.git --exclude=.workbuddy \
      --exclude=.deploy-tmp --exclude='dsh-anno-test-*' --exclude='*.tar.gz' .
  fi
  gzip -c "$work_tar" > "$stage/dsh-deploy.tar.gz"
  echo "$stage/dsh-deploy.tar.gz"
}

APP_DIR="$REMOTE_PATH/app"
DATA_DIR="$REMOTE_PATH/data"
DSH_HOME_REMOTE="$DATA_DIR/.dsh"
SERVICE_LOG="$REMOTE_PATH/service.log"
SERVICE_PID="$REMOTE_PATH/service.pid"
SERVICE_MODE="nohup"

# /api 浏览器信任围栏：公网域名/IP 访问时必须登记为信任主机。
TRUST_FLAGS=""
for th in "${TRUSTED_HOSTS[@]:-}"; do
  [[ -n "$th" ]] && TRUST_FLAGS="$TRUST_FLAGS --trusted-host $th"
done

start_service() {
  local bind="$1"
  echo "==> 启动远端服务（bind=$bind port=$PORT）..."
  # 优先 systemd（root 直接调用，普通用户需免密 sudo）；都不可用时退回 nohup + pid 文件。
  local is_root="0"
  [[ "$(remote_run 'id -u' 2>/dev/null | tr -d '[:space:]')" == "0" ]] && is_root="1"
  local has_systemd="0"
  remote_run "command -v systemctl >/dev/null 2>&1" && has_systemd="1"

  if [[ "$has_systemd" == "1" ]] \
    && { [[ "$is_root" == "1" ]] || remote_run "sudo -n true >/dev/null 2>&1"; }; then
    local unit_b64 node_bin SUDO
    SUDO="sudo "
    [[ "$is_root" == "1" ]] && SUDO=""
    node_bin="$(remote_run 'if [ -x /usr/local/bin/node ]; then echo /usr/local/bin/node; else bash -lc "command -v node"; fi' | tr -d '[:space:]')"
    [[ -n "$node_bin" ]] || node_bin="/usr/local/bin/node"
    unit_b64="$(cat <<UNIT | base64 -w0
[Unit]
Description=DeepSeek Harness Web
After=network.target

[Service]
User=$REMOTE_USER
WorkingDirectory=$APP_DIR
Environment=DSH_HOME=$DSH_HOME_REMOTE
EnvironmentFile=-$APP_DIR/.env
ExecStart=$node_bin --import tsx/esm apps/cli/src/bin.ts web --no-open --host $bind --port $PORT$TRUST_FLAGS
StandardOutput=append:$SERVICE_LOG
StandardError=append:$SERVICE_LOG
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
)"
    remote_run "echo '$unit_b64' | base64 -d | ${SUDO}tee /etc/systemd/system/dsh-web.service >/dev/null \
      && ${SUDO}systemctl daemon-reload \
      && ${SUDO}systemctl enable dsh-web >/dev/null \
      && ${SUDO}systemctl restart dsh-web"
    SERVICE_MODE="systemd"
  else
    remote_run "if [[ -f '$SERVICE_PID' ]]; then kill \"\$(cat '$SERVICE_PID')\" 2>/dev/null || true; fi; sleep 1"
    remote_run "cd '$APP_DIR' && DSH_HOME='$DSH_HOME_REMOTE' nohup node --import tsx/esm apps/cli/src/bin.ts web --no-open --host '$bind' --port '$PORT' $TRUST_FLAGS >> '$SERVICE_LOG' 2>&1 & echo \$! > '$SERVICE_PID'"
    SERVICE_MODE="nohup"
  fi
}

wait_healthy() {
  local bind="${1:-}"
  local target="${bind:-127.0.0.1}"
  echo "==> 健康检查（http://$target:$PORT/）..."
  local code=""
  for _ in $(seq 1 30); do
    code="$(remote_run "curl -s -m 3 -o /dev/null -w '%{http_code}' http://$target:$PORT/ 2>/dev/null || echo 000")"
    [[ "$code" == "401" || "$code" == "200" ]] && break
    sleep 2
  done
  if [[ "$code" != "401" && "$code" != "200" ]]; then
    echo "错误：服务未就绪（最后一次响应码 $code）。查看日志：$0 --host ... --logs"
    exit 1
  fi
  echo "服务已就绪（HTTP $code，401 为预期的 token 鉴权页）。"
}

print_url() {
  remote_run "grep -m1 'dsh web:' '$REMOTE_PATH/service.log' 2>/dev/null || true; \
    systemctl status dsh-web --no-pager -n 0 2>/dev/null | head -1 || true" | sed 's/^/  /'
}

case "$ACTION" in
  status)
    remote_run "if command -v systemctl >/dev/null 2>&1 && systemctl status dsh-web >/dev/null 2>&1; then systemctl status dsh-web --no-pager -n 3; else ps -fp \"\$(cat '$SERVICE_PID' 2>/dev/null)\" 2>/dev/null || echo '未运行（nohup 进程不存在）'; fi; curl -s -m 3 -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:$PORT/ || true"
    exit 0
    ;;
  logs)
    remote_run "if command -v systemctl >/dev/null 2>&1 && systemctl is-active dsh-web >/dev/null 2>&1; then journalctl -u dsh-web -n '$LOG_LINES' --no-pager; else tail -n '$LOG_LINES' '$SERVICE_LOG' 2>/dev/null || echo '无日志'; fi"
    exit 0
    ;;
  stop)
    remote_run "if systemctl is-active dsh-web >/dev/null 2>&1; then sudo systemctl stop dsh-web; elif [[ -f '$SERVICE_PID' ]]; then kill \"\$(cat '$SERVICE_PID')\" 2>/dev/null || true; fi; echo stopped"
    exit 0
    ;;
  restart)
    remote_run "if systemctl is-active dsh-web >/dev/null 2>&1; then sudo systemctl restart dsh-web; else echo 'nohup 模式请重新 deploy'; fi"
    exit 0
    ;;
  rollback)
    [[ -n "$ROLLBACK_ID" ]] || { echo "错误：--rollback 需要迁移 ID，如 --rollback 001-example-schema-note"; exit 1; }
    echo "==> 回滚迁移 $ROLLBACK_ID（先自动备份远端数据目录）..."
    remote_run "cd '$APP_DIR' && bash scripts/migrations/runner.sh --home '$DSH_HOME_REMOTE' --rollback '$ROLLBACK_ID'"
    echo "==> 重启服务使回滚生效 ..."
    start_service "$BIND_HOST"
    exit 0
    ;;
esac

# ---------- deploy 主流程 ----------
[[ -n "$REMOTE_PATH" ]] || { echo "错误：--path 必填（远端部署根目录）。"; usage 1; }
command -v ssh >/dev/null 2>&1 || { echo "错误：本机缺少 ssh。"; exit 1; }
command -v scp >/dev/null 2>&1 || { echo "错误：本机缺少 scp。"; exit 1; }

remote_run "echo ok" >/dev/null || { echo "错误：无法连接 $REMOTE_USER@$HOST。"; exit 1; }

if [[ "$SKIP_BUILD" != "1" ]]; then
  do_build
else
  echo "==> 跳过本机构建（--skip-build），使用现有 lib/ 产物。"
fi

TARBALL="$(do_package)"
echo "==> 上传包到 $REMOTE_PATH ..."
remote_run "mkdir -p '$APP_DIR' '$DATA_DIR' '$DSH_HOME_REMOTE'"
remote_copy "$TARBALL" "$REMOTE_PATH/dsh-deploy.tar.gz"
remote_run "cd '$APP_DIR' && tar xzf '$REMOTE_PATH/dsh-deploy.tar.gz' \
  --exclude='.workbuddy' --exclude='dsh-anno-test-*' \
  && (git init -q 2>/dev/null || true) && rm -f '$REMOTE_PATH/dsh-deploy.tar.gz'"
rm -f "$TARBALL" 2>/dev/null || true

if [[ "$SKIP_INSTALL" != "1" ]]; then
  # 远端缺少 Node >= 24.9 时自动安装（幂等：已满足则直接返回）。
  echo "==> 检查远端 Node 运行时 ..."
  remote_copy "$SCRIPT_DIR/remote-install-node.sh" "/tmp/dsh-install-node.sh"
  remote_run "NODE_VERSION='$NODE_VERSION' REGISTRY='$REGISTRY' bash /tmp/dsh-install-node.sh"

  echo "==> 远端安装依赖（首次约需几分钟）..."
  remote_run "cd '$APP_DIR' \
    && node -e 'const v=process.versions.node.split(\".\").map(Number); if(v[0]<24||(v[0]===24&&v[1]<9)) { console.error(\"远端 Node 需要 >= 24.9，当前 \"+process.versions.node); process.exit(1) }' \
    && if ! command -v pnpm >/dev/null 2>&1; then \
         npm i -g pnpm@11.28.5 --registry='$REGISTRY' \
         && ln -sf \"\$(npm prefix -g)/bin/pnpm\" /usr/local/bin/pnpm; \
       fi \
    && pnpm --version \
    && pnpm install --frozen-lockfile --registry='$REGISTRY'"
else
  echo "==> 跳过远端依赖安装（--skip-install）。"
fi

# 远端 .env：不存在才创建，绝不覆盖远端已有配置。
remote_run "test -f '$APP_DIR/.env' || printf 'DEEPSEEK_API_KEY=\n' > '$APP_DIR/.env'"
if [[ -n "$API_KEY" ]]; then
  remote_run "grep -q '^DEEPSEEK_API_KEY=' '$APP_DIR/.env' \
    && sed -i 's#^DEEPSEEK_API_KEY=.*#DEEPSEEK_API_KEY=$API_KEY#' '$APP_DIR/.env' \
    || echo 'DEEPSEEK_API_KEY=$API_KEY' >> '$APP_DIR/.env'"
fi

# 凭据隔离：默认不复制本机凭据；显式要求且远端不存在时才复制。
if [[ "$COPY_CREDENTIALS" == "1" ]]; then
  local_cred="$HOME/.dsh/.credentials.yaml"
  if [[ -f "$local_cred" ]]; then
    remote_run "test -f '$DSH_HOME_REMOTE/.credentials.yaml'" \
      || remote_copy "$local_cred" "$DSH_HOME_REMOTE/.credentials.yaml"
    echo "已复制本机凭据到远端（远端原本不存在）。"
  else
    echo "本机不存在 ~/.dsh/.credentials.yaml，跳过凭据复制。"
  fi
fi

if [[ "$NO_MIGRATE" != "1" ]]; then
  echo "==> 执行待应用的 schema 迁移（每个迁移前自动备份远端数据目录）..."
  remote_run "cd '$APP_DIR' && bash scripts/migrations/runner.sh --home '$DSH_HOME_REMOTE'"
fi

# 绑定地址：默认用远端第一块非回环网卡 IP（服务拒绝 0.0.0.0 通配绑定）。
if [[ -z "$BIND_HOST" ]]; then
  BIND_HOST="$(remote_run "hostname -I 2>/dev/null | awk '{print \$1}' || ip route get 1 2>/dev/null | awk '{print \$NF; exit}'")"
  BIND_HOST="$(echo "$BIND_HOST" | tr -d '[:space:]')"
fi

start_service "$BIND_HOST"
wait_healthy "$BIND_HOST"
print_url
rm -rf "$REPO_ROOT/.deploy-tmp" 2>/dev/null || true

echo
echo "部署完成。进程管理方式：$SERVICE_MODE"
echo "代码目录：$APP_DIR"
echo "数据目录（与本地完全隔离）：$REMOTE_PATH/data/.dsh"
echo "迁移备份目录：$DSH_HOME_REMOTE/backups"
