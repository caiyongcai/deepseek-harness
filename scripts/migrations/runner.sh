#!/usr/bin/env bash
# Schema 迁移执行器（在远端由 deploy-remote.sh 调起，也可手动执行）。
#
# 用法：
#   scripts/migrations/runner.sh --home <DSH_HOME目录> [--dir <迁移目录>] [--list]
#                                [--force <迁移ID>] [--rollback <迁移ID>]
#
# 约定：
# - 迁移脚本命名：NNN-短描述.migrate.sh；回滚脚本：NNN-短描述.rollback.sh（可选但强烈建议）。
# - 每个迁移执行前自动把数据目录打包备份到 <home>/backups/pre-<ID>-<时间戳>.tar.gz。
# - 应用记录写在 <home>/.migrations-applied（每行一个 ID）；已应用的迁移不再执行。
# - 幂等要求：迁移脚本即使重复执行也必须安全（先检查后写入、临时文件 + mv 原子替换）。
# - 永不修改会话日志（session.v4.jsonl.zstd 为追加型格式、按代际提交，禁止改写历史代）；
#   存储域变更走「新增版本命名的后继文件」而非原地改写。
set -euo pipefail

HOME_DIR=""
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIST="0"
FORCE_ID=""
ROLLBACK_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --home) HOME_DIR="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --list) LIST="1"; shift ;;
    --force) FORCE_ID="$2"; shift 2 ;;
    --rollback) ROLLBACK_ID="$2"; shift 2 ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
done

[[ -n "$HOME_DIR" ]] || { echo "错误：--home 必填（DSH_HOME 数据目录）。"; exit 1; }
mkdir -p "$HOME_DIR/backups"
STATE="$HOME_DIR/.migrations-applied"
touch "$STATE"

applied() { grep -Fxq "$1" "$STATE" 2>/dev/null; }

backup_data() {
  local id="$1"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  local target="$HOME_DIR/backups/pre-${id}-${stamp}.tar.gz"
  tar czf "$target" -C "$HOME_DIR" --exclude='backups' --exclude='cache' --exclude='.migrations-applied' .
  echo "已备份：$target"
}

mark_applied() { grep -Fxq "$1" "$STATE" 2>/dev/null || echo "$1" >> "$STATE"; }
unmark_applied() { sed -i "\#^${1}\$#d" "$STATE" 2>/dev/null || true; }

if [[ "$LIST" == "1" ]]; then
  echo "待应用："
  for f in "$DIR"/*.migrate.sh; do
    [[ -e "$f" ]] || continue
    id="$(basename "$f" .migrate.sh)"
    applied "$id" && echo "  [已应用] $id" || echo "  [待应用] $id"
  done
  exit 0
fi

if [[ -n "$ROLLBACK_ID" ]]; then
  local_rollback="$DIR/$ROLLBACK_ID.rollback.sh"
  [[ -f "$local_rollback" ]] || { echo "错误：找不到回滚脚本 $ROLLBACK_ID.rollback.sh"; exit 1; }
  backup_data "rollback-$ROLLBACK_ID"
  echo "==> 执行回滚 $ROLLBACK_ID ..."
  bash "$local_rollback" "$HOME_DIR"
  unmark_applied "$ROLLBACK_ID"
  echo "回滚完成。如需再次应用：runner.sh --home ... --force $ROLLBACK_ID"
  exit 0
fi

status="0"
for f in "$DIR"/*.migrate.sh; do
  [[ -e "$f" ]] || continue
  id="$(basename "$f" .migrate.sh)"
  if [[ "$id" == "$FORCE_ID" ]]; then
    echo "==> 强制重跑 $id（迁移自身必须幂等）"
  elif applied "$id"; then
    continue
  fi
  backup_data "$id"
  echo "==> 应用迁移 $id ..."
  if bash "$f" "$HOME_DIR"; then
    mark_applied "$id"
    echo "==> $id 完成"
  else
    echo "错误：迁移 $id 失败，已中止（数据未损坏，可回滚）。" >&2
    echo "回滚命令：runner.sh --home ... --rollback $id" >&2
    status="1"
    break
  fi
done
exit "$status"
