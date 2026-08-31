# dsh-echo-memory

> DSH（DeepSeek Harness）专用的跨会话持久记忆插件——让 agent 记住你的偏好、项目约束与已定决策，并在后续会话**自动想起**。

这不是通用记忆服务。插件完全构建在 DSH 原生机制之上（存储领域、工具注册表、系统提示词组装、会话事件流、设置面板服务），与宿主深度耦合、即装即用：

| 能力 | 使用的 DSH 原生机制 |
| --- | --- |
| 持久化 | `ctx.storageDomain`（json 后端存储领域） |
| 工具 | `ctx.tools.register()` 部署全局层（所有会话可见） |
| 注入 | `ctx.systemPrompt.context`（动态提示词上下文） |
| 捕获 | `ctx.on('session/event')`（非作用域会话事件监听） |
| 配置 | schemasty schema + 设置面板卡片（三层取值） |
| 装配 | `dsh.bundle` patch + profile bundles 组合 |

---

## ✨ 功能总览

| 模块 | 一句话作用 | 使用入口 |
| --- | --- | --- |
| **Agent 记忆工具** | agent 主动保存 / 检索 / 删除记忆 | `memory_save` / `memory_search` / `memory_forget` |
| **自动注入** | 每次模型请求自动带上当前工作区的 Top-N 记忆 | 无需操作，装好即生效 |
| **自动捕获** | 识别「记住：……」句式，自动落库 | 对话里直接说「记住：……」 |
| **设置面板卡片** | WebUI 在线调整运行参数，保存即时生效 | 设置 → 插件 → 插件配置 |
| **服务化接口** | 其他 DSH 插件经 `ctx.memory` 复用记忆能力 | 编程接口 |

---

## 🧠 功能详解

### 1. Agent 记忆工具

注册进 tools 注册表**部署全局层**，所有 agent / 会话可见。对话中对 agent 说「搜一下关于 xx 的记忆」「把那条删掉」即可触发。

#### `memory_save` — 保存 / 强化记忆

适合记住用户偏好、项目约束、已定决策。同一工作区内**类型与正文完全相同**的记忆不会重复存储，而是强化（`strength+1`、刷新新鲜度）——重复提及的事实权重更高。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `content` | ✅ | 要记住的事实/偏好/决策，一句完整的话 |
| `kind` | | `fact` 事实 / `preference` 偏好 / `project` 项目 / `session` 会话结论，缺省 `fact` |
| `tags` | | 检索标签数组（自动小写、去重） |
| `workspace` | | 归属工作区（绝对路径）；缺省当前会话 cwd，未知时 `*`（全局） |

返回 `{ saved, existed, id, strength, workspace }`，其中 `existed=true` 表示命中既有记录走了强化路径。

#### `memory_search` — 关键词评分检索

想回应用户偏好、之前决策或项目约束但记不清细节时使用。**不传 `query` 时返回最近记忆**。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `query` | | 关键词或短语（大小写不敏感），缺省返回最近记忆 |
| `workspace` | | 限定工作区 |
| `kind` | | 限定记忆类型 |
| `limit` | | 返回条数上限 1–50，缺省 8 |

**排序公式**（确定性关键词评分，不引入向量库）：

```
总分 = 关键词评分 × (1 + log2(强度)) × 新鲜度因子
```

| 评分项 | 分值 |
| --- | --- |
| 标签精确命中 | +8 / 个 |
| 标签前缀命中（≥2 字符） | +4 / 个 |
| 正文子串命中 | +2 / 次（最多计 5 次） |

无任何关键词命中（评分 0）的记录不进入结果。

#### `memory_forget` — 按 id 删除

参数 `id`（必填）来自 `memory_search` / `memory_save` 的结果。仅在用户明确要求删除时使用。

**行为随设置面板的「删除模式」**（默认墓碑机制）：

| 模式 | 行为 | 落盘 |
| --- | --- | --- |
| **墓碑机制**（默认） | 标记 `deletedAt`，检索/注入立即不可见，但记录仍占用存储 | 记录留在 `memory.json`（带 `deletedAt` 字段） |
| **彻底删除** | 立即物理删除 + 原子写盘 | 记录从 `memory.json` 消失 |

墓碑模式下，设置卡片提供 **「彻底删除墓碑」** 按钮（点击弹确认框）：确认后把所有被标记删除的记忆一次性物理清除。[更改立即生效，无需重启] → 切换模式即改变下一次 `memory_forget` 的行为；「彻底删除墓碑」按钮是即时动作，不依赖保存草稿。

> 墓碑记录的 `strength` 与正文会保留在文件中直到 purge；**重新保存同内容会新建记录**（墓碑不参与去重强化，删除后重新记住 = 新起点）。

---

### 2. 自动注入（提示词上下文）

每次模型请求组装时，通过 `ctx.systemPrompt.context` 把记忆注入系统提示词。注入内容按 durable user-role 快照写入会话日志，满足 DSH「模型可见 ⟺ 已记录」约定——每次实际注入了什么都可以从会话日志回放核对。

**注入条件**（依次判断，来自 `src/prompt.ts` 与 `src/store.ts` 的实际实现）：

| # | 条件 | 不满足时 |
| --- | --- | --- |
| 1 | 总开关 `injectEnabled` 为真（每次组装现读，设置卡片改了立即生效） | 返回空串，零贡献 |
| 2 | **工作区过滤**：只取 `workspace` 等于当前会话 cwd 的记忆，外加 `*` 全局记忆 | 其他工作区的记忆不进入候选 |
| 3 | 过滤后候选非空 | 空串（空库零开销） |
| 4 | **Top-N 截断**：按 `强度 × 新鲜度` 降序取前 `injectLimit` 条 | 超出排名的落选 |
| 5 | **长度截断**：累计超过 `injectMaxChars` 后停止，末行补省略号 | 无记忆或全部超限 → 空串 |
| 6 | **异常兜底**：提供方抛错只告警一次并返回空串 | 绝不打断提示词组装 |

**排名规则**：

```
排名分 = strength × 新鲜度因子        新鲜度：1（刚更新）→ 0.1（90 天后），线性衰减
```

同分按 `updatedAt` 降序、再按 id 升序（稳定可复现）。

> **与 `memory_search` 的区别**：注入**不做关键词匹配**——它按「强度 × 新鲜度」被动选取，与当前对话内容无关；检索才是按关键词相关性打分。这让注入行为完全确定、零检索开销、可从日志重建。

### 3. 自动捕获「记住」句式

监听 `session/event` 的 `user/message`，用**确定性规则**识别显式记忆意图后落库——不调 LLM、零 Token 开销、行为可预期。

**触发条件**（全部满足才落库）：

1. 事件为用户消息（`user/message` 且来源为真人，agent 自己说的话不捕获）；
2. 消息文本非空；
3. 开关 `captureEnabled` 为真（现读，即时生效）；
4. 消息命中某条 `capturePatterns` 句式（**大小写不敏感的子串匹配**，按配置顺序取第一个命中）；
5. 该会话的捕获计数未达 `captureMaxPerSession`。

**落库规则**：取句式**之后**的文本作为正文（自动剥除前导冒号/逗号等标点；句式后无内容时取整条消息）；类型固定 `fact`、来源 `auto`、工作区取会话 cwd（未知时 `*`）。保存失败仅告警，不打断事件流。

默认句式：`请记住`、`记住：`、`记住:`、`remember that`、`please remember`、`remember:`。

### 4. 设置面板卡片

WebUI 的 **设置 → 插件（左侧第一个「插件」导航）→ 插件配置** 里有「记忆（dsh-echo-memory）」卡片。**默认折叠**（与官方卡片同款手风琴：header 整行可点、有草稿时显示「未保存」、chevron 翻转，草稿在折叠期间保留）。

可在线调整 7 个运行参数，**保存后即时生效，无需重启**：

| 字段 | 设置键 | 说明 |
| --- | --- | --- |
| 提示词注入 | `injectEnabled` | 开关记忆上下文注入 |
| 注入条数上限 | `injectLimit` | 单次注入条数（1–50） |
| 注入文本长度上限 | `injectMaxChars` | 注入文本 UTF-16 长度（100–20000） |
| 自动捕获「记住」句式 | `captureEnabled` | 开关自动捕获 |
| 捕获句式 | `capturePatterns` | 每行一条触发句式（子串匹配） |
| 每会话捕获条数上限 | `captureMaxPerSession` | 单个运行期会话上限（1–1000） |
| 删除模式 | `deletionMode` | `tombstone` 墓碑机制（默认）/ `purge` 彻底删除 |

选择「墓碑机制」时卡片底部出现 **「彻底删除墓碑」** 按钮：点击弹出确认框，确认后物理清除所有被标记删除的记忆（一次原子写盘完成，不可恢复）。切换「彻底删除」后按钮隐藏——该模式下 `memory_forget` 立即物理删除。

字段被用户层覆盖后会显示「重置」按钮，保存重置即回落组合层。

**三层取值**（优先级从低到高）：

```
schema 内置默认  <  cordis.yml 组合层（行配置）  <  用户设置层（卡片保存 → $DSH_HOME/settings.yaml 的 memory: 段）
```

### 5. 服务化接口（供其他插件消费）

插件以 `ctx.memory` Service 暴露与工具相同的入口（外加墓碑清除），其他 DSH 插件可直接依赖消费：

```ts
ctx.memory.save(input)            // Promise<SaveOutcome>
ctx.memory.search(options?)       // SearchHit[]
ctx.memory.forget(id)             // Promise<boolean>（模式现读设置）
ctx.memory.purgeTombstones()      // Promise<number>（彻底清除全部墓碑）
```

---

## 📦 数据模型与存储

`memory` 存储领域（version 1），单表 `memories`，键 = 记录 id。落盘 **`$DSH_HOME/storages/memory.json`**（默认 `~/.dsh/storages/memory.json`，首次写入时创建），人类可读、原子替换、重启不丢。

```ts
interface MemoryRecord {
  id: string               // mem-<createdAt>-<seq>
  workspace: string        // 会话 cwd（绝对路径）；'*' = 跨项目全局
  kind: 'fact' | 'preference' | 'project' | 'session'
  content: string          // 模型可见正文（≤ contentMaxChars）
  tags: readonly string[]  // 小写去重（≤ tagsMax）
  strength: number         // 重复保存 +1，起步 1
  source: 'agent' | 'auto' // 工具写入 / 自动捕获
  createdAt: number
  updatedAt: number
  deletedAt?: number       // 墓碑删除时间；存在 = 已标记删除（可选字段，旧数据无此键）
}
```

- **去重强化**：同工作区 + 同类型 + 同正文的写入命中**未删除**记录 → `strength+1` 并刷新 `updatedAt`，不新增行；墓碑记录不参与查重。
- **墓碑删除**（默认模式）：`memory_forget` 标记 `deletedAt`，检索/注入/召回全部跳过；记录保留在文件中直到「彻底删除墓碑」purge 物理清除。
- **打开即校验**：所有记录在打开领域时经 zod 校验，格式不符即拒绝打开（响亮失败，不静默迁移）。`deletedAt` 是向后兼容的可选字段，不 bump 领域版本。
- **写入串行**：领域写链串行；读取同步（权威内存态）。

---

## 🔧 安装

> 以下以 web profile 为例。其他 profile（headless 等）步骤相同，把 `web` 换成对应 profile 名即可。已安装 DSH 且 `dsh` CLI 可用；**不需要本地 Node / pnpm**——构建由安装过程自动完成。

### 让 DSH 帮你安装

把下面的提示词发给 **DSH 的 agent**（新建会话粘贴即可），它负责执行与核验：

````text
请帮我安装 dsh-echo-memory 插件（DeepSeek Harness 跨会话记忆插件）到 web profile：

1. 在终端执行：dsh plugin --profile web add github:JxaMe/dsh-echo-memory
2. 若因构建许可失败，按报错提示把 allowBuilds 条目加入本 profile 的 pnpm-workspace.yaml 后重试同一条命令；
3. 确认 node_modules/dsh-echo-memory/lib/ 存在（index.js 与 client.js，构建产物）；
4. 确认本 profile 的 package.json 里 dsh.profile.bundles 数组已含 "dsh-echo-memory"；
5. 重启 DSH 服务使其生效（按你环境的服务管理方式重启，会中断当前会话），然后确认：
   - 服务日志出现 [dsh-echo-memory] loaded (memory domain open; tools: memory_save, memory_search, memory_forget)；
   - WebUI 设置 → 插件（第一个「插件」导航）→ 插件配置 出现「记忆（dsh-echo-memory）」卡片。

完成后向我报告每步结果，有任何一步失败就停下来说明原因。
````

### 验证生效

依次检查三点：

1. **日志**：查看 DSH 服务日志并过滤 `dsh-echo-memory`，应看到
   `[dsh-echo-memory] loaded (memory domain open; tools: memory_save, memory_search, memory_forget)`；
2. **设置卡片**：WebUI → 设置 → 插件（第一个）→ 插件配置，可见「记忆（dsh-echo-memory）」卡片；
3. **工具**：新会话让 agent「用 memory_search 搜一下任意词」，工具应可调用。

> 💡 不想动主服务时，可先起独立验证实例：`dsh --profile web --port 3999 --no-open`，按上述三点在该实例验证。

> 💡 开发迭代（改插件源码重启即生效）用 `dsh plugin --profile web add /path/to/dsh-echo-memory`（`link:` 依赖），见「开发」一节。

---

## ⚙️ 配置

所有配置项都有内置默认值，**不配置也能用**。两个配置入口对应三层取值中的两层：

### 行配置（cordis patch 层，10 个键）

在 `~/.dsh/profiles/web/cordis.patch.yml` 中按 id 覆盖：

```yaml
- id: memory
  config:
    injectEnabled: true
    injectLimit: 8
    injectMaxChars: 1500
    injectOrder: 10
    captureEnabled: true
    capturePatterns:
      - 请记住
      - 记住：
      - remember that
    captureMaxPerSession: 20
    contentMaxChars: 500
    tagsMax: 8
    defaultWorkspace: '*'
```

| 键 | 默认 | 范围 | 含义 |
| --- | --- | --- | --- |
| `injectEnabled` | `true` | — | 是否注入记忆上下文 |
| `injectLimit` | `8` | 1–50 | 注入条数上限 |
| `injectMaxChars` | `1500` | 100–20000 | 注入文本长度上限 |
| `injectOrder` | `10` | — | 提示词上下文排序序号 |
| `captureEnabled` | `true` | — | 是否自动捕获 |
| `capturePatterns` | 见上例 | — | 触发句式（大小写不敏感子串） |
| `captureMaxPerSession` | `20` | 1–1000 | 每会话自动捕获上限 |
| `contentMaxChars` | `500` | 20–2000 | 单条正文长度上限 |
| `tagsMax` | `8` | 0–32 | 单条标签数上限 |
| `defaultWorkspace` | `'*'` | — | 无会话 cwd 时的归属工作区 |

> ⚠️ **patch 的 `config` 是整键替换**（不是深合并）：覆盖时必须**重述全部要保留的键**，只写想改的键会把其余键清掉。改完可用 `dsh --profile web --dump-config | grep -A12 'id: memory'` 核对最终生效值。

### 生效时机

- **即时生效**（消费方每次现读）：`injectEnabled`、`injectLimit`、`injectMaxChars`、`captureEnabled`、`capturePatterns`、`captureMaxPerSession`——设置卡片保存或行配置热重载后立刻生效；
- **需重启**（启动时快照）：`injectOrder`、`contentMaxChars`、`tagsMax`、`defaultWorkspace`。

---

## 💬 使用

### 日常：对话即管理

```text
记住：这个项目用 pnpm workspaces，构建命令是 pnpm run build
```

命中「记住」句式 → 自动捕获落库（也可由 agent 调 `memory_save` 完成，返回里能看到 id）。

```text
你还记得这个项目用什么包管理器吗？      ← 自动注入让新会话直接知道
搜一下关于部署的记忆                    ← agent 调 memory_search
把那条关于 xx 的记忆删掉                ← agent 先 search 拿 id，再 memory_forget
```

### 验证一条记忆真的存下来了

```sh
cat ~/.dsh/storages/memory.json        # 首次保存后该文件出现，人类可读
```

### 验证注入在工作

开一个新会话直接问「你还记得 …… 吗」；或核对会话日志——注入内容以 durable user-role 快照记录，可回放核对每次实际注入了哪些条目。

---

## 🗑️ 卸载

```sh
# 1. 移除依赖（转发 pnpm remove，清理 link 与 node_modules）
dsh plugin --profile web remove dsh-echo-memory
```

然后**手动**编辑 `~/.dsh/profiles/web/package.json`：

```jsonc
// 2. 从 dsh.profile.bundles 数组中删除 "dsh-echo-memory" 这一行
```

```sh
# 3. 重启 DSH 服务使其生效（按你环境的服务管理方式重启）
# 4. 验证已卸干净
dsh --profile web --dump-config | grep dsh-echo-memory   # 应无输出
```

**数据去留**：

- 记忆数据 `~/.dsh/storages/memory.json` **不会被自动删除**；想清空记忆就手动删掉它；
- `~/.dsh/settings.yaml` 里若残留 `memory:` 段（卡片曾保存过设置），无害，可手动删除。

---

## 🧑‍💻 开发

```sh
pnpm install          # 依赖安装（构建脚本许可在 pnpm-workspace.yaml 的 allowBuilds）
pnpm run typecheck    # tsc 严格类型检查（含测试）
pnpm test             # node:test 单测（store / capture / card-util，21 条）
pnpm run build        # tsc → lib/types/，tsdown → lib/index.js + lib/client.js
```

### 目录结构

```
dsh-echo-memory/
├── package.json          # dsh.bundle / dsh.client 声明 + 依赖
├── cordis.patch.yml      # bundle patch：insert 一行 memory 挂载
├── .github/workflows/    # release.yml：推送 v* 标签自动构建并发布 tgz
├── src/
│   ├── index.ts          # 宿主半入口：MemoryService 装配（领域 + 工具 + 注入 + 捕获 + 设置分节）
│   ├── domain.ts         # 存储领域定义（zod schema + 类型）
│   ├── store.ts          # MemoryStore：去重强化 / 评分检索 / 注入排序（纯逻辑，可单测）
│   ├── tools.ts          # memory_save / memory_search / memory_forget
│   ├── capture.ts        # session/event 「记住」句式捕获
│   ├── prompt.ts         # systemPrompt 动态上下文提供方
│   ├── settings.ts       # 设置命名空间 schema（Host 与 client 共享类型）
│   └── client/           # 浏览器半：设置卡片注册 / 组件 / 字典
├── tests/                # node:test 单测
└── docs/                 # 踩坑记录（pitfalls.md）与验证截图（screenshots/）
```

### 架构速记

- **双半侧**：Node 宿主半（`lib/index.js`，ESM）+ 浏览器 client 半（`lib/client.js`，CJS closure-factory，经 `dsh.client` 声明进入 Web 启动图）。
- **卡片可见性**：Host `settings.describe` 命名空间 ∩ slot `settings.plugin.item` 的 key——两边必须拼出同一个 `memory`。
- 改动约定与验证流程见项目内 `AGENTS.md`；历史踩坑见 `docs/pitfalls.md`。

---

## ⚠️ 已知限制

- **单宿主进程假设**：json 存储后端无跨进程写锁（DSH 官方限制），不要多进程同时写同一 profile。
- **无全局条数上限**：删除只由用户/agent 显式发起（`memory_forget`）；自动捕获按会话限流兜底。
- **捕获只认显式句式**：不做 LLM 自动提炼（这是特性——零 Token 开销、行为可预期）。
- **检索是确定性关键词评分**：不引入向量库，语义相近但字面不同的内容搜不到。
- **卡片样式**为一次性注入的 `<style>`（类名前缀 `dshm-` 隔离）：本包在官方构建管道之外，无法使用 CSS Modules，数值已逐项对齐官方卡片样式。
- 设置弹窗若出现**第二个**无内容的「插件」导航项，属其他插件注册的分区，与本插件无关。

## 🗺️ Roadmap（均不改变现有契约）

- **语义召回**：接入 embedding 检索，替换/补充关键词评分。
- **LLM 自动提炼**：在会话收尾时生成记忆草稿，写入前经确认。
- **独立记忆管理面板**：当记忆量长大后提供 WebUI 批量浏览/编辑——按服务端分页 + 虚拟化列表设计（设置卡片保持纯配置，不承载数据浏览）。

---

## License

[MIT](LICENSE)
