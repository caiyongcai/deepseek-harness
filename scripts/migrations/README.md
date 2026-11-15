# Schema 迁移（scripts/migrations）

本目录存放「表结构 / 存储格式」变更脚本，随 `scripts/deploy-remote.sh` 打包上传到远端，
部署时自动执行尚未应用的迁移。

## 执行模型

- 执行器：`scripts/migrations/runner.sh --home <DSH_HOME>`（部署脚本自动调用）。
- 应用记录：`<DSH_HOME>/.migrations-applied`（每行一个迁移 ID），保证每个迁移只应用一次。
- 自动备份：每个迁移应用前，把数据目录打包到 `<DSH_HOME>/backups/pre-<ID>-<时间戳>.tar.gz`。
- 失败即中止：迁移失败会停止部署流程，数据目录保持迁移前状态（配合备份可整体还原）。
- 回滚：`deploy-remote.sh --rollback <迁移ID>`，先备份再执行同名 `.rollback.sh` 并清除应用记录。

## 编写规范（保证幂等与可回滚）

1. 命名：`NNN-短描述.migrate.sh`，可选 `NNN-短描述.rollback.sh`；NNN 全局递增，不改旧编号。
2. 迁移脚本接收一个参数：`$1` = DSH_HOME 数据目录绝对路径。
3. **先检查后写入**：重复执行必须无害（目标已存在即跳过）。
4. **原子替换**：写临时文件（同目录 mktemp）后 `mv` 覆盖，避免进程中断留下半截文件。
5. **不改会话日志**：`sessions/*/session.v4.jsonl.zstd` 是追加型、按代际提交的日志，
   任何迁移都不得改写已提交的历史代；格式演进按仓库规则新增版本命名的后继代。
6. **存储域变更**：`storages/<domain>/` 下的 JSON 记录可迁移，但建议只做「新增可选字段」
   与「新增文件」两类安全操作；删除字段前先写读取兼容（旧数据缺字段时使用默认值）。
7. 回滚脚本与迁移脚本一样幂等，且只回滚本迁移引入的变更。
8. 上线前先在远端手动演练一次：`runner.sh --home ... --force <ID>`（配合备份验证）。

## 手动操作速查

```sh
# 查看待应用
scripts/migrations/runner.sh --home /opt/dsh/data/.dsh --list
# 手动应用
scripts/migrations/runner.sh --home /opt/dsh/data/.dsh
# 回滚某个迁移（先自动备份）
scripts/migrations/runner.sh --home /opt/dsh/data/.dsh --rollback 001-example-schema-note
```
