# dsh-echo-memory

> DSH（DeepSeek Harness）专用的跨会话持久记忆插件：让 agent 记住你的偏好、项目约束与已定决策，并在后续会话**自动想起**。

记忆**落盘在你本地的 `memory.json`**，人类可读、原子写入、重启不丢。

## ✨ 功能总览

| 能力 | 怎么触发 |
| --- | --- |
| **记住** | 对话里说「记住：……」自动落库；重复说同一句会强化（权重 +1）而不是重复存储 |
| **检索** | 让 agent「搜一下关于 xx 的记忆」（关键词评分，无需向量库） |
| **删除** | 让 agent「把那条删掉」（删除方式由设置面板的「删除模式」决定） |
| **自动想起** | 每次模型请求自动注入当前工作区的 Top-N 记忆——新会话直接带背景（超过 90 天未更新的记忆不再自动注入，但 `memory_search` 仍可搜到） |
| **设置** | 设置 → 插件 → 插件配置，在线调整、保存即生效 |

## 🧠 使用

对话里直接说就行：

```text
记住：这个项目用 pnpm workspaces，构建命令是 pnpm run build   ← 自动落库，agent 会回一句「已记住 ✅」
你还记得这个项目用什么包管理器吗                                  ← 新会话也能直接答
搜一下关于部署的记忆                                            ← agent 调 memory_search
把那条关于 xx 的记忆删掉                                        ← agent 先搜出 id 再删
```

说「记住：……」后 agent 会用一句话**确认已记住**——看到确认即代表真的落库了（保存失败不会报已记住）。

**删除模式**（设置卡片里选，默认墓碑机制）：

| 模式 | 行为 |
| --- | --- |
| **墓碑机制**（默认） | 标记删除，检索/注入立即不可见；数据仍留在文件里，可在设置卡片点「彻底删除墓碑」一次性物理清除 |
| **彻底删除** | 立即物理删除，不可恢复 |

**设置卡片**（7 项，保存即生效）：

- **自动注入**：开关 / 注入条数上限 / 注入文本长度上限
- **自动捕获**：开关 / 触发句式（默认：`请记住`、`记住：`、`remember that` 等）/ 每会话捕获上限
- **删除模式**：墓碑机制 / 彻底删除

## 🔧 安装

> 以 web profile 为例，其他 profile 把 `web` 换成对应名字。已安装 DSH 即可，**不需要本地 Node / pnpm**。

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

**验证是否装好**：日志出现 `[dsh-echo-memory] loaded`；设置页出现「记忆（dsh-echo-memory）」卡片；新会话让 agent 用 memory_search 试搜任意词。不想动主服务时，可先起独立验证实例：`dsh --profile web --port 3999 --no-open`。

## 📦 数据存储

- **位置**：`$DSH_HOME/storages/memory.json`（默认 `~/.dsh/storages/memory.json`，首次保存时创建），可直接打开查看。
- **强化**：同工作区同类型同内容的重复写入 → 强度 +1 并刷新时间，不新增行。
- **墓碑**：墓碑模式下删除的记录留在文件里（带删除标记，可审计）；「彻底删除墓碑」后才从文件消失。
- **校验**：文件格式损坏时插件会拒绝启动（不静默丢数据）。

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

## ⚠️ 已知限制

- 检索是**确定性关键词评分**：语义相近但字面不同的内容搜不到（语义召回在计划中）。
- 自动捕获只认「记住：」这类**显式句式**，不做 LLM 自动提炼（换来零 Token 开销、行为可预期）。
- 存储无跨进程写锁：不要多个 DSH 进程同时写同一 profile。

## License

[MIT](LICENSE)