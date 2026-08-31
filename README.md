# dsh-memory · DSH 专用记忆插件

给 DSH（DeepSeek Harness）agent 一块**跨会话持久记忆**：用户偏好、项目约束、已定决策可以在会话之间沉淀与复用。插件完全走 DSH 原生机制实现——不是通用记忆服务，而是与 DSH 的插件树、存储领域、工具注册表、提示词组装与会话事件流深度耦合的专属能力。

## 功能

- **持久存储**：记忆写入 DSH 存储领域（`ctx.storageDomain` + json 后端），落盘 `$DSH_HOME/storages/memory.json`，人类可读、原子替换、重启不丢。
- **Agent 记忆工具**（tools 部署全局层，所有会话可见）：
  - `memory_save`：保存/强化记忆（同工作区同正文自动去重，`strength+1`）
  - `memory_search`：关键词评分检索（标签精确 > 标签前缀 > 正文子串）
  - `memory_forget`：按 id 删除
- **自动注入**：每次模型请求通过 `ctx.systemPrompt.context` 注入该会话工作区的 Top-N 记忆（强度 × 新鲜度排序）；空库时零贡献。注入内容作为 durable user-role 快照写入会话日志，满足 DSH「模型可见 ⟺ 已记录」约定。
- **自动捕获**：监听 `session/event` 的 `user/message`，识别「记住 / 请记住 / remember that」等显式句式后自动落库（确定性规则，不调 LLM、零 Token 开销、按会话限流）。
- **服务化**：以 `ctx.memory` Service 暴露 `save/search/forget`，其他 DSH 插件可直接消费。

## 模块划分

```
dsh-memory/
├── package.json        # dsh.bundle 声明 + 依赖（与运行时同版 0.1.1-rc.2 锁定）
├── cordis.patch.yml    # bundle patch：insert 一行 memory 行
├── tsconfig.json       # 严格模式类型检查（strict + noImplicitAny，含测试）
├── tsconfig.build.json # tsc 构建产物（lib/）
├── src/
│   ├── domain.ts       # 记忆领域：zod schema + defineDomain('memory', v1) + 类型
│   ├── store.ts        # 仓储：save/search/forget/rankedForInjection/recallText
│   ├── tools.ts        # memory_save / memory_search / memory_forget（defineTool）
│   ├── capture.ts      # session/event 「记住」句式捕获（可配置、限流）
│   ├── prompt.ts       # systemPrompt.context 注入提供方
│   └── index.ts        # MemoryService 装配（Service.init 打开领域 + 注册全部能力）
└── tests/              # node:test 纯逻辑单测（store/capture）
```

## 数据模型

`memory` 领域（version 1），表 `memories`，键 = 记录 id：

```ts
interface MemoryRecord {
  id: string            // mem-<createdAt>-<seq>
  workspace: string     // 会话 cwd（绝对路径）；'*' = 跨项目全局
  kind: 'fact' | 'preference' | 'project' | 'session'
  content: string       // 模型可见正文（≤ contentMaxChars）
  tags: readonly string[]  // 小写去重（≤ tagsMax）
  strength: number      // 重复保存 +1
  source: 'user' | 'agent' | 'auto' | 'imported'
  createdAt: number
  updatedAt: number
}
```

写入顺序：领域写链串行；读取同步（权威内存态）。所有记录在打开领域时经 zod 校验，格式不符即拒绝打开（响亮失败，不静默迁移）。

## 深度集成点

| 能力 | DSH 机制 | 位置 |
| --- | --- | --- |
| 持久化 | `ctx.storageDomain` 路由到 web profile 已装配的 json 后端 | `src/index.ts` `Service.init` |
| 工具 | `ctx.tools.register(defineTool(...))` 部署全局层（所有 agent/会话可见，ToolRestriction 语义内） | `src/tools.ts` |
| 注入 | `ctx.systemPrompt.context({ name: 'memory', order, text })` | `src/prompt.ts` |
| 自动捕获 | `ctx.on('session/event')` 非作用域监听（收到全部会话事件） | `src/capture.ts` |
| 安装 | `dsh.bundle` + `dsh plugin --profile <name> add`，web/headless/自定义 profile 通用 | `cordis.patch.yml` |

## 接入步骤（web profile）

```sh
# 1. 在插件目录同级执行（dsh plugin 会 pnpm 安装依赖并把 bundle 追加进 profile）
cd /home/los
dsh plugin --profile web add ./dsh-memory

# 2. 先验证配置层已加载（无需启动服务）
dsh --profile web --dump-config | grep -A2 'dsh-memory'

# 3. 重启 web 服务使插件生效
dsh-web restart
```

> 说明：`dsh plugin add` 只改 profile 的依赖与 bundles 清单，不重启服务；插件在下次启动时激活。headless 等其他 profile 安装方式相同，只需把 `web` 换成对应 profile 名。

## 配置（均为可选项，有内置默认）

在 `~/.dsh/profiles/web/cordis.patch.yml` 中覆盖该行配置（patch 按行整体替换 `config`，需重述全部要保留的键）：

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

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `injectEnabled` | `true` | 是否注入记忆上下文 |
| `injectLimit` | `8` | 注入条数上限（1–50） |
| `injectMaxChars` | `1500` | 注入文本长度上限（100–20000） |
| `injectOrder` | `10` | PromptContext 排序序号 |
| `captureEnabled` | `true` | 是否自动捕获 |
| `capturePatterns` | `['请记住','记住：','记住:','remember that','please remember','remember:']` | 触发句式的子串（大小写不敏感） |
| `captureMaxPerSession` | `20` | 每个运行期会话自动捕获上限 |
| `contentMaxChars` | `500` | 单条记忆正文上限（20–2000） |
| `tagsMax` | `8` | 单条记忆标签上限（0–32） |
| `defaultWorkspace` | `'*'` | 无会话 cwd 时的归属工作区 |

## 设置面板卡片

设置 → 插件 → 插件配置 里有「记忆（dsh-memory）」卡片，**默认折叠**（与终端 / Agent 循环 / 网页搜索三卡同款手风琴：header 整行可点展开，有草稿时 header 显示「未保存」，chevron 翻转；展开态为卡片局部 state，草稿独立于折叠保留）。可在线调整 6 个运行参数（保存后**即时生效**，无需重启）：

| 字段 | 对应设置键 | 说明 |
| --- | --- | --- |
| 提示词注入 | `injectEnabled` | 开关记忆上下文注入 |
| 注入条数上限 | `injectLimit` | 单次注入记忆条数（1–50） |
| 注入文本长度上限 | `injectMaxChars` | 注入文本 UTF-16 长度（100–20000） |
| 自动捕获「记住」句式 | `captureEnabled` | 开关自动捕获 |
| 捕获句式 | `capturePatterns` | 每行一条触发句式（子串匹配） |
| 每会话捕获条数上限 | `captureMaxPerSession` | 单个运行期会话上限（1–1000） |

### 三层取值与生效语义

卡片编辑的是用户设置层，优先级：**schema 默认 < cordis.yml 组合层（上表 Config） < 用户设置层（卡片保存）**。注入提供方与捕获监听器每次现读解析值，因此保存即生效；`injectOrder`、`contentMaxChars`、`tagsMax`、`defaultWorkspace` 仍属 cordis.yml 快照，改后需重启。用户层覆盖过的字段会显示「重置」按钮，保存重置即回落组合层（unset）。

### 双半侧架构（官方约定）

- **Host 半**（`src/index.ts`）：`installSettingsSection` 把 `memory` 命名空间注册进 settings 服务（base = 组合层 Config 投影），`settings.describe` 因此向浏览器暴露该命名空间。
- **浏览器半**（`src/client/`）：closure-factory 产物（`window.__ModuleLoader__.load` 契约），`ctx.slots.inject('settings.plugin.item', …)` 注册 keyed 卡片（key = `memory`）；「插件配置」页按 *describe 命名空间 ∩ 卡片 key* 分发渲染。跨插件协作只走 `slots/locale/settingsScope` 服务，无跨包值导入。
- **构建**：官方两段式——`tsc` 产 `lib/types/`（JS+声明），`tsdown` 从中打包宿主半 `lib/index.js`（ESM，依赖外部化）与客户端半 `lib/client.js`（CJS 工厂，基线外部化）。改动后 `pnpm run build` 并重启 web 服务生效。

### 已知限制

- 卡片样式为一次性注入的 `<style>`（类名前缀 `dshm-` 隔离，幂等）：数值逐项对齐官方 `PluginCard.module.css` / `fields.module.css`（背景 layer-3 / 展开 layer-2、边框 l2、圆角 12、字段纵向布局、实心保存按钮），与官方外部插件同款做法；不用 CSS Modules 是因本包在官方构建管道之外。
- 设置弹窗中若出现第二个无内容的「插件」导航项，属其他插件注册的分区，与本插件无关（本插件只挂卡片，不注册分区）。

### 验证截图

见 `docs/screenshots/`（默认折叠、展开态、未保存草稿共 3 张 + 附带发现的无关分区崩溃证据），排查过程与教训见 `docs/pitfalls.md`。

## 在对话中使用

对 agent 说「记住：……」，或让 agent 主动调用工具：

```text
记住：这个项目用 pnpm workspaces，构建命令是 pnpm run build
```

agent 可随时 `memory_search` 回应用户偏好与过往决策；用户明确要求时 `memory_forget` 删除。

## 行为与边界

- 去重强化：同工作区 + 同类型 + 同正文的写入不重复存储，而是 `strength+1` 并刷新新鲜度——重复提及的事实权重更高。
- 召回排序：注入用「强度 × 新鲜度（90 天衰减到 0.1）」；检索用「关键词评分 × 强度 × 新鲜度」。
- 自动捕获只认显式句式，**不做 LLM 自动提炼**（零 Token 开销、行为可预期；提炼作为后续演进）。
- 召回是确定性关键词评分，**不引入向量库**（语义检索作为后续演进）。
- 无全局条数上限：删除由用户/agent 明确发起（`memory_forget`）；自动捕获按会话限流兜底。
- 单宿主进程部署假设：json 后端无跨进程写锁（DSH 官方限制）。

## 开发与验证

```sh
pnpm install          # 安装依赖（注意：需能访问 npm registry）
pnpm run typecheck    # tsc 严格类型检查（含测试）
pnpm run build        # tsc → lib/types/，tsdown → lib/index.js + lib/client.js
pnpm test             # node:test 单测（store/capture/card-util 纯逻辑）
```

## 卸载

```sh
dsh plugin --profile web remove dsh-memory
```

已写入的 `$DSH_HOME/storages/memory.json` 不会被自动删除（保留数据；如需清空手动删除即可）。

## Roadmap（后续演进，均不改变当前契约）

- 语义召回：接入 embedding/向量索引，替换关键词评分。
- LLM 自动提炼：在 compaction/`turn/end` 时经 `ctx.llm` 生成记忆草稿，写入前经工具确认。
- WebUI 管理卡片：客户端半侧（`dsh.client` + settings 卡片）浏览/编辑记忆。