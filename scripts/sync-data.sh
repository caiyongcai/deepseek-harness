#!/usr/bin/env bash
# 把本机 DSH_HOME（默认 ~/.dsh）里的对话数据同步到远端已部署实例。
#
# 用法：
#   scripts/sync-data.sh --host <IP> --user <用户名> --path <部署根目录> \
#     [--password <密码>] [--local-home <本机数据目录>] [--no-annotations] [--dry-run]
#
# 同步内容：
#   - sessions/<工作区>/session-*/ 会话日志（追加型，按文件覆盖同名会话）
#   - storages/session_annotations/sessions/*.json 批注记录
# 不同步：.credentials.yaml（远端浏览器鉴权密钥）、.env、settings 等身份/环境相关文件。
#
# 会话落位：本机会话目录名由工作区路径派生（如 D:\harness → --D-harness--），
# 远端工作区路径不同，因此会话会被并入远端工作区的会话目录，并登记到
# 远端 workspace.json 的 sessionIds 中，保证 UI 能列出来。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

HOST=""
REMOTE_USER=""
PASSWORD=""
REMOTE_PATH=""
LOCAL_HOME="${DSH_HOME:-$HOME/.dsh}"
WITH_ANNOTATIONS="1"
DRY_RUN="0"

usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed -n '3,16p'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --user) REMOTE_USER="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --path) REMOTE_PATH="$2"; shift 2 ;;
    --local-home) LOCAL_HOME="$2"; shift 2 ;;
    --no-annotations) WITH_ANNOTATIONS="0"; shift ;;
    --dry-run) DRY_RUN="1"; shift ;;
    -h|--help) usage 0 ;;
    *) echo "未知参数：$1"; usage 1 ;;
  esac
done

[[ -n "$HOST" && -n "$REMOTE_USER" && -n "$REMOTE_PATH" ]] || {
  echo "错误：--host / --user / --path 必填。"; usage 1
}

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o LogLevel=ERROR)
PASSWORD_AUTH_OPTS=(-o PreferredAuthentications=password -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=1)
USE_SSHPASS="0"
ASKPASS_FILE=""

prepare_password_auth() {
  [[ -z "$PASSWORD" ]] && return 0
  if command -v sshpass >/dev/null 2>&1; then USE_SSHPASS="1"; return 0; fi
  local dir="${TMPDIR:-/tmp}"
  ASKPASS_FILE="$dir/dsh-askpass.$$.$RANDOM"
  printf '#!/bin/sh\nprintf "%%s\\n" %q\n' "$PASSWORD" > "$ASKPASS_FILE"
  chmod 700 "$ASKPASS_FILE"
  export SSH_ASKPASS="$ASKPASS_FILE" SSH_ASKPASS_REQUIRE=force
  export DISPLAY="${DISPLAY:-:0}"
  trap 'rm -f "$ASKPASS_FILE"' EXIT
}

remote_run() {
  if [[ -n "$PASSWORD" && "$USE_SSHPASS" == "1" ]]; then
    sshpass -p "$PASSWORD" ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$HOST" "$@"
  elif [[ -n "$PASSWORD" ]]; then
    ssh "${SSH_OPTS[@]}" "${PASSWORD_AUTH_OPTS[@]}" "$REMOTE_USER@$HOST" "$@"
  else
    ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$HOST" "$@"
  fi
}

remote_copy() {
  if [[ -n "$PASSWORD" && "$USE_SSHPASS" == "1" ]]; then
    sshpass -p "$PASSWORD" scp "${SSH_OPTS[@]}" "$1" "$REMOTE_USER@$HOST:$2"
  elif [[ -n "$PASSWORD" ]]; then
    scp "${SSH_OPTS[@]}" "${PASSWORD_AUTH_OPTS[@]}" "$1" "$REMOTE_USER@$HOST:$2"
  else
    scp "${SSH_OPTS[@]}" "$1" "$REMOTE_USER@$HOST:$2"
  fi
}

prepare_password_auth

DSH_HOME_REMOTE="$REMOTE_PATH/data/.dsh"
SERVICE="dsh-web"

# ---------- 前置检查 ----------
[[ -d "$LOCAL_HOME/sessions" ]] || { echo "错误：本机没有会话目录 $LOCAL_HOME/sessions"; exit 1; }

remote_run "test -d '$DSH_HOME_REMOTE'" || {
  echo "错误：远端数据目录 $DSH_HOME_REMOTE 不存在，请先执行 deploy-remote.sh 部署。"; exit 1
}

# 远端工作区：取 sessionIds 最多的那个（通常只有一个），并用它的会话目录名落位。
REMOTE_WORKSPACE="$(remote_run "node -e \"
const fs=require('fs');
const j=JSON.parse(fs.readFileSync('$DSH_HOME_REMOTE/storages/workspace.json','utf8'));
const ids=j.global.workspaceIds||Object.keys(j.tables.workspaces);
const id=ids.map(k=>[k,j.tables.workspaces[k]]).sort((a,b)=>((b[1].sessionIds||[]).length-(a[1].sessionIds||[]).length))[0][0];
const w=j.tables.workspaces[id];
process.stdout.write(JSON.stringify({id, path:w.path, title:w.title}));
\"")"
echo "==> 远端工作区：$REMOTE_WORKSPACE"

REMOTE_KEY="$(remote_run "ls -1 '$DSH_HOME_REMOTE/sessions' 2>/dev/null | head -1")"
REMOTE_KEY="$(echo "$REMOTE_KEY" | tr -d '[:space:]')"
if [[ -z "$REMOTE_KEY" ]]; then
  # 远端还没有任何会话目录：按工作区路径派生（与 Host 的 sanitize 规则一致）。
  REMOTE_KEY="$(echo "$REMOTE_WORKSPACE" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const w=JSON.parse(s);
  const raw=w.path.replace(/^[A-Za-z]:/, m=>m[0].toLowerCase());
  process.stdout.write('--'+raw.replace(/[^A-Za-z0-9]+/g,'-').replace(/^-+|-+\$/g,'')+'--');
});")"
fi
echo "==> 远端会话目录：sessions/$REMOTE_KEY"

LOCAL_SESSIONS="$(find "$LOCAL_HOME/sessions" -mindepth 2 -maxdepth 2 -type d -name 'session-*' 2>/dev/null | wc -l | tr -d ' ')"
echo "==> 本机会话数：$LOCAL_SESSIONS"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "（--dry-run：只打印计划，不执行）"
  find "$LOCAL_HOME/sessions" -mindepth 2 -maxdepth 2 -type d -name 'session-*' | head -5 | sed 's/^/    /'
  [[ "$WITH_ANNOTATIONS" == "1" ]] && ls "$LOCAL_HOME/storages/session_annotations/sessions" 2>/dev/null | wc -l | sed 's/^/    批注文件数：/'
  exit 0
fi

# ---------- 备份远端数据 ----------
STAMP="$(date +%Y%m%d-%H%M%S)"
echo "==> 备份远端数据目录 ..."
remote_run "mkdir -p '$DSH_HOME_REMOTE/backups' && tar czf '$DSH_HOME_REMOTE/backups/pre-sync-$STAMP.tar.gz' \
  -C '$DSH_HOME_REMOTE' --exclude=backups . && ls -lh '$DSH_HOME_REMOTE/backups/pre-sync-$STAMP.tar.gz' | awk '{print \"    \"\$5, \$9}'"

# ---------- 打包本机数据 ----------
echo "==> 打包本机会话与批注 ..."
STAGE="$SCRIPT_DIR/../.sync-tmp"
rm -rf "$STAGE" 2>/dev/null || true
mkdir -p "$STAGE/sessions/$REMOTE_KEY"
find "$LOCAL_HOME/sessions" -mindepth 2 -maxdepth 2 -type d -name 'session-*' -exec cp -r {} "$STAGE/sessions/$REMOTE_KEY/" \;

if [[ "$WITH_ANNOTATIONS" == "1" && -d "$LOCAL_HOME/storages/session_annotations/sessions" ]]; then
  mkdir -p "$STAGE/storages/session_annotations/sessions"
  cp "$LOCAL_HOME/storages/session_annotations/sessions/"*.json "$STAGE/storages/session_annotations/sessions/" 2>/dev/null || true
fi

tar czf "$STAGE/data.tar.gz" -C "$STAGE" sessions storages 2>/dev/null || tar czf "$STAGE/data.tar.gz" -C "$STAGE" sessions

# ---------- 停服务、上传、解包 ----------
echo "==> 停止远端服务（避免并发写入）..."
remote_run "systemctl stop $SERVICE 2>/dev/null || true"

echo "==> 上传并解包 ..."
remote_copy "$STAGE/data.tar.gz" "$REMOTE_PATH/data-sync.tar.gz"
remote_run "cd '$DSH_HOME_REMOTE' && tar xzf '$REMOTE_PATH/data-sync.tar.gz' && rm -f '$REMOTE_PATH/data-sync.tar.gz' \
  && chown -R \$(id -u):\$(id -g) '$DSH_HOME_REMOTE/sessions' '$DSH_HOME_REMOTE/storages' \
  && chmod -R 700 '$DSH_HOME_REMOTE/sessions'"

# ---------- 合并 workspace.json ----------
echo "==> 合并 workspace.json（把同步来的会话登记到远端工作区）..."
remote_run "node -e \"
const fs=require('fs');
const file='$DSH_HOME_REMOTE/storages/workspace.json';
const j=JSON.parse(fs.readFileSync(file,'utf8'));
const ids=j.global.workspaceIds||Object.keys(j.tables.workspaces);
const id=ids.map(k=>[k,j.tables.workspaces[k]]).sort((a,b)=>((b[1].sessionIds||[]).length-(a[1].sessionIds||[]).length))[0][0];
const w=j.tables.workspaces[id];
const dir='$DSH_HOME_REMOTE/sessions/$REMOTE_KEY';
const found=fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}).filter(d=>d.isDirectory()&&d.name.startsWith('session-')).map(d=>d.name):[];
const set=new Set([...(w.sessionIds||[]),...found]);
w.sessionIds=[...set];
w.updatedAt=new Date().toISOString();
fs.writeFileSync(file, JSON.stringify(j,null,2));
console.log('    workspace sessionIds: '+w.sessionIds.length+'（新增 '+(w.sessionIds.length-(w.sessionIds.length-found.length))+' / 扫描到 '+found.length+'）');
\""

rm -rf "$STAGE" 2>/dev/null || true

# ---------- 启动与验证 ----------
echo "==> 启动远端服务 ..."
if remote_run "systemctl is-enabled $SERVICE >/dev/null 2>&1"; then
  remote_run "systemctl start $SERVICE"
else
  echo "警告：未找到 systemd 单元，请手动重启 nohup 进程。"
fi

sleep 6
echo "==> 校验 ..."
remote_run "curl -s -m 5 -o /dev/null -w '    HTTP %{http_code}\n' http://\$(hostname -I | awk '{print \$1}'):3081/ ; \
  echo '    会话目录数：'\$(ls -1 '$DSH_HOME_REMOTE/sessions/$REMOTE_KEY' 2>/dev/null | wc -l); \
  echo '    批注文件数：'\$(ls -1 '$DSH_HOME_REMOTE/storages/session_annotations/sessions' 2>/dev/null | wc -l); \
  echo -n '    访问地址：'; grep -o 'http://[^ ]*token=[A-Za-z0-9_-]*' '$REMOTE_PATH/service.log' | tail -1"

echo
echo "同步完成。远端数据目录：$DSH_HOME_REMOTE"
echo "同步前备份：$DSH_HOME_REMOTE/backups/pre-sync-$STAMP.tar.gz"
