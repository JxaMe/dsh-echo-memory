# dsh-echo-memory 架构与边界

## 核心定位

**极简、纯本地、无向量、无数据库。**

本插件是一个 DSH 专用跨会话记忆插件，坚持：
- 数据只落在本地 `memory.json`
- 单表、人类可读、原子写入
- 不引入数据库、向量库、外部服务
- 不增加不必要的依赖
- 不扩大 DSH 兼容范围（当前基准：`DSH 0.1.2-alpha.4`）

## 半侧结构

- **Host 半**（Node）：`src/index.ts` 装配 MemoryService，提供 tools / HTTP routes / 召回 / AI 建议。
- **Client 半**（浏览器）：`src/client/index.ts` 注册设置卡片与全局 Dock。

## 存储

- 唯一存储：`$DSH_HOME/storages/memory.json`
- 领域版本：`v3`
- 记录 schema：`src/domain.ts`
- 迁移：`src/migrate.ts`，旧 `auto` 来源统一归一到 `agent`，移除 `embedding` / `embeddingAt`

## 对外接口

- Tools：`memory_save` / `memory_search` / `memory_forget` / `memory_restore` / `memory_suggest`
- HTTP Routes：`/api/dsh-echo-memory/*`
- 不提供公开 Service API（`ctx.memory` 不作为稳定对外契约）

## 禁止事项

- 禁止引入数据库客户端 / 向量库 / 外部服务依赖
- 禁止新增存储后端
- 禁止在 schema 中重新加入 `embedding` / 向量字段
- 禁止扩大 DSH 兼容范围到未验证版本
- 禁止修改 DSH 源码
