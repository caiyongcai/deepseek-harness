#!/usr/bin/env bash
# 示例迁移（001-example-schema-note）：在 DSH_HOME 下登记 schema 版本标记文件。
# 此迁移演示标准模式：先检查后写入、原子替换、可重复执行；随包部署时会被自动应用。
# 实际的存储域/表结构变更请复制本文件作为模板，改名 NNN-描述.migrate.sh。
set -euo pipefail

HOME_DIR="${1:?用法: NNN-xxx.migrate.sh <DSH_HOME>}"
SCHEMA_DIR="$HOME_DIR/schema"
MARKER="$SCHEMA_DIR/example-schema-note.json"

# 幂等：已存在即无事可做。
if [[ -f "$MARKER" ]]; then
  echo "  已存在 $MARKER，跳过"
  exit 0
fi

mkdir -p "$SCHEMA_DIR"
# 原子替换：写临时文件再 mv，进程被杀也不会留下半截文件。
tmp="$(mktemp "$SCHEMA_DIR/.tmp-XXXXXX")"
cat > "$tmp" <<JSON
{
  "schema": "example-schema-note",
  "appliedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
mv "$tmp" "$MARKER"
echo "  写入 $MARKER"
