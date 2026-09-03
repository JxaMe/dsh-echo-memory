# Data Model

## 存储位置

`$DSH_HOME/storages/memory.json`

## 领域版本

当前版本：`v3`

## 迁移历史

- `v1 → v2`：占位迁移，无实际字段变化
- `v2 → v3`：
  - 移除 `embedding` / `embeddingAt` 字段
  - 旧 `source=auto` 统一归一到 `agent`

## 记录字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 唯一 ID |
| `workspace` | string | 归属工作区，`*` 表示全局 |
| `kind` | `fact` / `preference` / `project` / `session` | 记忆类型 |
| `content` | string | 记忆正文 |
| `tags` | string[] | 检索标签 |
| `strength` | number | 强化次数 |
| `source` | `agent` | 写入来源（旧 `auto` 已迁移） |
| `createdAt` | number | 创建时间 |
| `updatedAt` | number | 最近更新时间 |
| `deletedAt?` | number | 墓碑删除时间 |
