# 历史求职文案迁移运行手册

迁移脚本只读取历史 `application_intelligence.json`，不会覆盖原始岗位或旧草稿。输出目录是独立 staging，可先小批量检查，再把结果接入工作台。

```powershell
python scripts/migrate_application_outreach.py `
  --input-root data `
  --output-dir tmp/application-migration-smoke `
  --candidate-profile profiles/candidate_profile.json `
  --offset 0 `
  --limit 20 `
  --no-codex-runtime
```

输出包括：

- `application_intelligence.json`：当前规则重生成的完整结果；
- `application_outreach_migration_audit.json`：逐岗位旧/新主题、正文长度、哈希、证据 ID、岗位要求映射与 `content_quality`；
- `migration_manifest.json`：输入文件、去重数量、批次范围和只读来源声明。

验收顺序：先看 `content_quality.batch_ready`，再抽检 `requirement_matches` 与 `used_evidence_ids`，最后在批量投递工作台执行 Dry Run。质量门禁未通过的记录不会进入批量预览或发送队列。
