<p align="center">
  <img src="src/client/assets/elephant.png" width="192" alt="Echo 回音象" />
</p>

# dsh-echo-memory

> DSH（DeepSeek Harness）专用的跨会话持久记忆插件：让 agent 记住你的偏好、项目约束与已定决策，并在后续会话**自动想起**。

记忆**落盘在你本地的 `memory.json`**，人类可读、原子写入、重启不丢。

> **核心定位：极简、纯本地、无向量、无数据库。**

> **兼容性：仅适配 `DSH 0.1.2-alpha.4`（`cordis ^4.0.2`）**。`0.1.10` 起已迁移至 `dsh-client-store / settings.installSection / 3参 intercept`；`0.x` 阶段 API 仍可能 breaking，以 `package.json` 的 peerDependencies 为准。

## ✨ 核心功能

### 🧠 模型侧（Host 半）— 记忆怎么进、怎么出

| 功能 | 说明 |
| --- | --- |
| **5 个记忆工具** | `memory_save` 保存 / `memory_search` 检索 / `memory_forget` 删除 / `memory_restore` 恢复 / `memory_suggest` 提议（Dock 确认后才真存）——模型对话中直接可调 |
| **按需召回注入** | 每次模型请求前，从用户提问抽 query → BM25F 评分 → 相关记忆追加进对话（只注入相关的，非广播式） |
| **自然对话保存** | 直接说「帮我记住 XX」等自然表达，agent 调 `memory_save` 落库（不再依赖固定「记住：」句式） |
| **AI 建议记住** | 每轮提示词让 AI 自主提炼值得记的偏好/约束/决策，调 `memory_suggest` 进 Dock 原点附着卡片，点确认才真存（项目/全局自动判断，若无则不提） |

### 🗄️ 存储与检索

- **纯本地 JSON**（`memory.json`）：无向量库、无需 API Key，BM25F + 标题/标签加权 + 强度/新鲜度
- **同内容强化**：重复保存同一条 → `strength+1` 而非堆重复记录
- **工作区隔离**：按会话 cwd 隔离，全局 `*` 跨项目共享——项目记忆不串台
- **墓碑删除**：删除先进回收站可恢复，或彻底删除（两种模式设置里可配）

### 🖥️ 浏览器 UI（Client 半）

- **全站悬浮原点**：拖选文字/快记保存、双击复位、拖拽移动
- **AI 建议卡片**：AI 觉得值得记时在原点旁弹出（项目/全局自动判断），点确认才真存
- **管理面板**：记忆列表（搜索联想/编辑/删除/复制/工作区过滤）+ 快记保存栏
- **召回历史 tab**：模型刚才引用了哪些记忆，一目了然
- **瞬态召回气泡**：命中时右下角冒泡展示，几秒自动收
- **设置卡片**：注入开关/条数/长度、删除模式——保存即时生效，卡片里有回收站与注入命中率统计

### 🛡️ 可靠性

- **损坏自愈**：记忆文件损坏自动隔离备份 + 空库启动，面板有一次恢复提示
- **失败如实可见**：保存/删除/编辑失败明确提示且不丢输入，不再伪装成「空」

## 🧠 使用

对话里直接说就行，网页上也能直接拖：

```text
帮我记住这个项目用 pnpm workspaces，构建命令是 pnpm run build ← agent 调 memory_save 落库
你还记得这个项目用什么包管理器吗                                ← 新会话也能直接答
搜一下关于部署的记忆                                          ← agent 调 memory_search
把那条关于 xx 的记忆删掉                                      ← agent 先搜出 id 再删
网页上选中一段话 → 拖到右下角原点上松手                        ← 拖选即记，不用打开面板
```

直接对 agent 说「帮我记住……」，它会调 `memory_save` 落库并回一句确认；把网页文字拖到原点也能直接保存。`AGENTS.md` 管项目级常驻约束（手写、git 跟踪），本插件管**个人级、按需召回**的记忆——无关问题零注入，相关才带 1-3 条，不抢 `AGENTS.md` 的预算。

**删除模式**（设置卡片里选，默认墓碑机制）：

| 模式 | 行为 |
| --- | --- |
| **墓碑机制**（默认） | 标记删除，检索/注入立即不可见；数据仍留在文件里，可在设置卡片点「彻底删除墓碑」一次性物理清除 |
| **彻底删除** | 立即物理删除，不可恢复 |

**设置卡片**（4 项，保存即生效）：

- **按需注入**：开关 / 召回条数上限 / 召回文本长度上限（仅相关时注入，`memory_search` 不受此限）
- **删除模式**：墓碑机制 / 彻底删除

## 🟣 原点

> 吉祥物 **Echo 回音象**的落点 —— 右下角一颗可拖动的原点，**所有记忆操作都在这里完成，不用进设置页**。

- **常驻原点**：随手拖到顺手的位置，双击回右下角；不常驻弹层，不挡输入
- **瞬态召回**：只在相关时冒泡 6 秒，无关零打扰
- **召回历史**：气泡消失也能查。原点面板新增「召回历史」标签，最近 20 次“你问了什么→命中了哪几条”都在，点开即看、可复制
- **拖选即记**：选中网页任意文字，**拖到原点或面板上松手即存**。不用点开面板、不用输入、不用回车，1 步顶 3 步；面板没开也能存
- **搜索联想**：面板搜索时输入即联想已有标签与标题，点一下填入，不用猜关键词
- **纯记忆管理**：点原点开面板，搜索 / 列表 / 编辑 / 删除 / 复制 / 底部快记，没有杂项

**为什么顺手：** 别的记忆插件要么得进设置页改，要么得让 agent 帮忙存；原点把“存”和“查”都做成**手边动作**——看到就拖，想查就点。

**和同类插件的区别：** ① 纯本地 BM25，无向量库、无需 API Key 也能用，1 万条 4ms 级检索；② 按工作区隔离 + 全局共享，项目记忆不串台；③ 墓碑可恢复，误删可找回；④ 原点是全局悬浮入口，不占对话区，不跟输入框抢焦点。

## 🔧 安装

> 以 web profile 为例，其他 profile 把 `web` 换成对应名字。已安装 **DSH 0.1.2-alpha.4** 即可，**不需要本地 Node / pnpm**。

把下面的提示词发给 **DSH 的 agent**（新建会话粘贴即可），它会自行判断你的 DSH 安装方式并执行与核验：

````text
请帮我安装 dsh-echo-memory 插件（DeepSeek Harness 跨会话记忆插件）到 web profile：

1. 先判断 DSH 安装方式再执行安装（把 web 换成你的 profile 名）：
   - 若 `dsh --version` 可用（npm 全局安装）：执行 `dsh plugin --profile web add github:JxaMe/dsh-echo-memory`
   - 若在 deepseek-harness 源码检出目录：执行 `pnpm dsh plugin --profile web add github:JxaMe/dsh-echo-memory`
   - 否则（无全局 dsh）：执行 `npx @deepseek-ai/dsh plugin --profile web add github:JxaMe/dsh-echo-memory`
2. 若因构建许可失败，按报错提示把 allowBuilds 条目加入本 profile 的 pnpm-workspace.yaml 后重试同一条命令；
3. 确认 node_modules/dsh-echo-memory/lib/ 存在（index.js 与 client.js，构建产物）；
4. 确认本 profile 的 package.json 里 dsh.profile.bundles 数组已含 "dsh-echo-memory"；
5. 重启 DSH 服务使其生效（按你环境的服务管理方式重启，会中断当前会话），然后确认服务日志出现 [dsh-echo-memory] loaded (memory domain open; tools: memory_save, memory_search, memory_forget, memory_restore, memory_suggest)；

完成后向我报告每步结果，有任何一步失败就停下来说明原因。
````

**验证是否装好**：日志出现 `[dsh-echo-memory] loaded`；设置页出现「记忆（dsh-echo-memory）」卡片；新会话让 agent 用 memory_search 试搜任意词。

## 📦 数据存储

- **位置**：`$DSH_HOME/storages/memory.json`（默认 `~/.dsh/storages/memory.json`，首次保存时创建），可直接打开查看。
- **强化**：同工作区同类型同内容的重复写入 → 强度 +1 并刷新时间，不新增行。
- **墓碑**：墓碑模式下删除的记录留在文件里（带删除标记，可审计）；「彻底删除墓碑」后才从文件消失。
- **损坏自愈**：文件损坏（JSON 解析失败/记录校验失败）时自动隔离备份为 `memory.json.corrupt-<时间戳>` 并用空库启动——数据不丢（备份可手动修复）、插件不瘫痪；打开记忆面板会看到一次恢复提示。

## 🗄️ 为什么不用数据库

1 万条记忆（4.55 MB 真实 json 库）实测：启动加载 65 ms、每轮注入候选 1.7 ms、检索 4.3 ms、保存 45 ms——万级全路径无感，个人使用远到不了这个量级，**不引入数据库**。

## ⚙️ 行配置（可选，一般用不到）

设置卡片覆盖日常使用；以下 4 个键只能通过 `~/.dsh/profiles/web/cordis.patch.yml` 的 memory 条目调整（改后需重启）：

- `injectOrder`：提示词上下文排序序号（默认 10）
- `contentMaxChars`：单条记忆正文长度上限（默认 500）
- `tagsMax`：单条记忆标签数上限（默认 8）
- `defaultWorkspace`：没有工作区时的归属（默认 `*` 全局）

> ⚠️ patch 的 `config` 是整键替换：覆盖时需重述要保留的键，只写想改的键会清掉其余键。

## 🗑️ 卸载

```sh
# 1. 移除依赖
dsh plugin --profile web remove dsh-echo-memory
# 2. 从 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 数组删除 "dsh-echo-memory"
# 3. 重启 DSH 服务生效
```

记忆数据 `memory.json` **不会被自动删除**，想清空就手动删掉该文件；`settings.yaml` 里残留的 `memory:` 段无害，可手动删除。

## License

[MIT](LICENSE)
## 🧹 已知限制与边界

- **minimal preset 不启用 AI 提议记忆**：极简模式下 DSH 的 `persona complete` 会屏蔽 `systemPrompt.context` 注入，因此 `memory_suggest` 提示词不会注入；手动保存、拖选保存仍然可用。
- **仅适配 DSH `0.1.2-alpha.4`**：更高版本的 DSH API 未验证，升级 DSH 前建议先验证。
- **纯本地单表**：无向量库、无数据库、无外部服务；`memory.json` 是唯一数据源。
- **公开 Service API 已移除**：插件对外只提供 tools 与 HTTP routes，不承诺 `ctx.memory` 服务 API 稳定。

## ⬆️ 升级说明

### 0.3.x → 0.4.0

- 启动后会自动执行 `memory.json` v2→v3 迁移：
  - 移除 `embedding` / `embeddingAt` 字段
  - 旧 `source=auto` 统一归一到 `agent`
- 迁移是幂等的；迁移前建议备份 `memory.json`。
- 设置卡片保留 4 项：注入开关 / 注入条数 / 注入长度 / 删除模式。

## 📚 文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — 架构与核心定位边界
- [HTTP_API.md](HTTP_API.md) — HTTP 路由契约
- [DATA_MODEL.md](DATA_MODEL.md) — 数据模型与迁移说明

## 🛠️ 开发与质量门禁

```sh
pnpm run typecheck        # 严格类型检查
pnpm run typecheck:strict # 额外检查未使用变量/参数
pnpm run lint             # ESLint
pnpm run check:boundary   # 核心定位边界检查（极简/纯本地/无向量/无数据库）
pnpm test                 # 单元/集成测试
pnpm run build            # 双半侧构建
```

CI 会在每次 push / PR 自动运行以上全部检查。
