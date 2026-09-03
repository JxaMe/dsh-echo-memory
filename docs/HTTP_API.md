# HTTP API

所有路由前缀：`/api/dsh-echo-memory/`

## 路由清单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/stats` | 注入统计与记忆条数 |
| POST | `/purge` | 彻底清除所有墓碑 |
| GET | `/deleted?limit=` | 回收站列表 |
| POST | `/restore` | 恢复一条墓碑 |
| POST | `/purge-one` | 彻底删除一条墓碑 |
| POST | `/update` | 更新记忆正文/标签 |
| GET | `/last-recall` | 最近一次召回 |
| GET | `/recall-history` | 召回历史 |
| GET | `/storage-status` | 存储恢复状态 |
| GET | `/list?limit=&q=` | 记忆列表 / 搜索 |
| POST | `/save` | 保存记忆 |
| POST | `/forget` | 删除记忆 |
| GET | `/suggestions` | 获取待确认建议 |
| POST | `/suggestions/dismiss` | 忽略建议 |
| POST | `/suggestions/confirm` | 确认建议并落库 |

## 通用约定

- 请求/响应均为 JSON。
- 客户端错误返回 `400`，内部错误返回 `500`。
- 带 `Origin` 时要求同源，否则 `400`。
- 请求体上限 64KB。

## 主要响应形状

- `GET /stats`
  ```json
  { "injections": { "requests": 0, "withContent": 0 }, "memories": 0 }
  ```
- `GET /suggestions`
  ```json
  { "items": [{ "id": "sug-...", "content": "...", "workspace": "*", "kind": "fact", "tags": [], "at": 0 }] }
  ```
- `POST /suggestions/confirm`
  ```json
  { "saved": true, "id": "mem-..." }
  ```
