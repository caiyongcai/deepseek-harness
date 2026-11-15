#!/usr/bin/env bash
# 示例迁移的回滚（001-example-schema-note）：删除迁移写入的标记文件。
# 回滚脚本同样必须幂等：目标不存在时直接成功。
set -euo pipefail

HOME_DIR="${1:?用法: NNN-xxx.rollback.sh <DSH_HOME>}"
MARKER="$HOME_DIR/schema/example-schema-note.json"

if [[ -f "$MARKER" ]]; then
  rm -f "$MARKER"
  echo "  已删除 $MARKER"
else
  echo "  $MARKER 不存在，无需回滚"
fi
