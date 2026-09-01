# dsh-echo-memory 踩坑记录

本次为插件开发「设置面板卡片」及后续迭代（0.3.x 原点、深模块化）过程中实际遇到的问题与解决方法。按影响排序；每条含现象、根因、解决、教训。留存于插件仓库，后续迭代先读这里。

> 与本文件配套的领域约定：**架构速览与硬性约定以 `AGENTS.md` 为准**（AGENTS.md 在 .gitignore 中，是本地首要约定；本文件记录坑与证据，二者不重复）。

## 验证截图索引（docs/screenshots/）

| 文件 | 内容 |
| --- | --- |
| `10-card-collapsed.png` | 默认折叠态：记忆卡片与官方三卡（终端/Agent 循环/网页搜索）外观一致 |
| `11-card-expanded.png` | 展开态：chevron 翻转，表单完整渲染，「恢复默认」徽标 |
| `12-card-unsaved-draft.png` | 有草稿时 header 显示「未保存」徽标；折叠再展开草稿保留 |
| `30-unrelated-plugin-crash.png` | 附带发现：第二个「插件」导航（其他插件注册的分区）渲染即崩，与本插件无关 |

---

## 1. tsdown 缺宿主半条目 → 运行的是陈旧 lib/index.js（高危，最隐蔽）

- **现象**：插件加载日志正常、三个工具正常，但设置卡片永远不出现；`/api/settings.describe` 返回的 namespaces 里没有 `memory`，且全程零报错。
- **根因**：把 `tsconfig.build.json` 的 `outDir` 从 `lib` 改为 `lib/types`（对齐官方「tsc 出 lib/types、tsdown 出运行时」约定）后，tsc 不再直接产出 `lib/*.js`；而 `tsdown.config.ts` 只配了 client 入口——宿主半 `lib/index.js` 是改布局之前的旧构建，`installSettingsSection` 根本不在运行代码里。实例加载的是文件系统上的旧产物，自然什么都不会发生。
- **定位关键**：`grep -c installSettingsSection lib/index.js` 得 0 + `ls -la` 看到 `lib/*.js`（12:20）与 `lib/client.js`（12:35）mtime 不一致。
- **解决**：`tsdown.config.ts` 改为官方两段式数组：host 条目 `entry: ['lib/types/index.js'] → lib/index.js`（ESM/node，依赖外部化）+ client 条目不变。
- **教训**：改构建输出布局时，必须确认「运行时实际加载的那个文件」被新流水线覆盖。mtime 对比 + 内容 grep 是鉴别陈旧产物最快的手段；「curl 到 200」只证明文件可达，不证明它是新的。

## 2. 设置页有两个同名「插件」导航 → 被别人的崩溃带偏（耗时最大）

- **现象**：点「插件」导航后整个设置分区崩溃（React #130，元素类型 undefined）；把自己 client 的注册代码全部删空、甚至把 Host 的 settings 分节也禁掉，**崩溃依旧**。一度怀疑官方渲染器、Host schema 序列化、竞态，做了多轮二分。
- **根因**：设置弹窗有**两个「插件」导航项**——`nth(1)` 是另一个插件注册的分区，它自身渲染即崩（React #130 是它的问题）；官方 ui-settings-plugins 分区是 `nth(0)`。排查中反复点的都是 `nth(1)`，把别人的崩溃当成了自己的回归。Per-entry 错误边界日志 `slot entry crashed in 'settings.section'` 也确实是「那个分区」在崩，只是我默认了它是官方分区。
- **解决**：对两个导航项分别截图对比——`NAV[0]` 卡片正常渲染零错误，`NAV[1]` 必崩；用户确认 `nth(1)` 是别的插件的、不用管。
- **教训**：
  - 页面存在同名重复入口时，先验证目标唯一性（逐个 `nth(i)` + 截图），再做任何深水区排查。
  - 「删光自己的代码仍复现」是强信号：问题大概率不在自己。这个对照实验应该第一个做，而不是排在最后。

## 3. 保存按钮没绑 saveDisabled（dirty 态不复位）

- **现象**：保存成功后「保存」按钮仍可点（E2E 断言 `AFTER_SAVE_DISABLED: false`），但数据已正确落盘。
- **根因**：`MemoryPluginCard.tsx` 里按钮写的是 `disabled={state.saving}`，而组件里算好的 `saveDisabled`（含 `!state.dirty` 判断）没有被用上。
- **解决**：按钮改绑 `disabled={saveDisabled}`；复验三态——空闲禁用 → 有草稿启用 → 保存后回到禁用。
- **教训**：算了的状态变量就要用上（这类问题 tsc 查不出来，只能靠行为断言）；E2E 要断言按钮禁用态的完整三态迁移，不能只断言写入结果。

## 4. 卡片不可见的排查方法论（机制沉淀）

卡片可见性 = **Host describe 命名空间 ∩ slot 里 key 匹配的卡片**（`ui-settings-plugins` 的 tab-store 求交集），少任何一边都不可见且**无任何报错**。由此沉淀两条：

- **cordis fiber 会静默 pending**：`ctx.inject(['settings'], cb)` 在服务不可达时回调永不执行、无日志（客户端半 `inject` 声明同理）。好在 web boot 的 `assertEntriesActive` 会对仍 pending 的条目响亮抛错——页面能正常渲染基本可排除「客户端 apply 没跑」。
- **有效诊断手段**：监听 `/api/settings.describe` 的响应看 served namespaces；查 `window.__DSH_BOOT__.entries` 看模块清单与 rev（rev 变了才不是浏览器缓存）；对网络请求全量记录判断 bundle 是否真被加载。

## 5. delivery_check 的 page-verify：传 url 反而必挂

- **现象**：给 `delivery_check` 传 `url` + 默认 `requireSmoke: true`，`page-verify` 无条件 FAIL，即使视觉证据齐全。
- **根因**：router-bootstrap v1.23（方案A）起，delivery_check 不再自跑浏览器；页面视觉验证改为**模型自己用 playwright/headless 截图 + read_image 审查并把 reviewed:true 的证据放进 evidence**。该版本里 `url + requireSmoke(默认true)` 组合被硬编码为 FAIL。
- **解决**：截图（真实路径）+ `kind: image/page` + `reviewed: true` 齐备后，`requireSmoke: false` 重跑即 PASS。注意 evidence 的 `run` 项不要带 `target`（会被当路径校验），`page/image` 项的 `target` 必须是**存在的文件路径**（不是 URL）。
- **教训**：检查器的判定语义要看实现（`~/.dsh/.agent-presets/router-standard/router-bootstrap-v34.mjs`），不能只按工具描述的字面猜。

## 6. 环境与工程杂项（一次性坑，避免重踩）

- **TS 严格（NodeNext）**：宿主半相对导入必须 `.js`；`exactOptionalPropertyTypes` 下可选字段要显式 `| undefined`。
- **client 半 TS**：用 `allowImportingTsExtensions: true` + `.ts/.tsx` 相对导入（对齐官方 base 配置，构建靠 `rewriteRelativeImportExtensions`）。
- **client 纯度门禁**：tsdown 会把非基线 `@deepseek-ai/*` 包内联进 client bundle——client 半**不得值导入 Host 包**（跨包命名空间值在浏览器侧拼写，同官方 `SHELL_NS` 约定）；type-only 导入会被擦除，安全。
- **pnpm 11**：`package.json` 的 `pnpm.onlyBuiltDependencies` 被忽略，构建许可改写 `pnpm-workspace.yaml` 的 `allowBuilds`（esbuild）。
- **node --test**：不能直接跑目录，用 `node --import tsx/esm --test "tests/**/*.test.ts"`。
- **playwright**：1.53 不支持 ubuntu 26.04，升 1.62.1 后 `npx playwright install chromium` 正常。
- **Session API**：会话对象暴露的是 `session.header`（cwd/id），没有 `session.meta`。
- **验证实例管理**：用 `timeout` 挂的后台实例到期即死（排查中途连接被拒过一次）；长驻验证实例用 `run_in_background` 任务。:3080 主服务承载当前会话，**永远不要重启它**；插件更新后主 GUI 需用户自行 `dsh-web restart`。
- **pkill/pgrep 误杀自身**：`pkill -f "dsh --profile web --port 3999"` 会匹配到正在执行该字符串的 shell 自身 → shell 被杀、后续命令不执行。用 `ps -eo pid,cmd | grep -E "dsh .*3999" | grep -v grep | awk '{print $1}'` 取 pid 再 kill。
- **隔离实例 onboarding 两步弹窗**：全新 DSH_HOME 首启有「内测声明（继续）」→「API 向导（稍后配置）」两步异步弹窗；点完第一步 mask 会短暂消失再出现第二步——playwright 要循环「点按钮→等 mask 无 + 无待点按钮」双条件才退出，否则第二步挡住设置点击。
- **新增依赖解析**：用 `@deepseek-ai/dsh-client-connection` 的 RPC 类型要在 package.json 声明（peerDependencies 0.1.1-rc.2）后 `pnpm install`，否则 tsc 报 TS2307。
- **探针脚本**：JsonStorageBackend 构造传 root 字符串（`new JsonStorageBackend(path)`）；`unit.loadAll()` 返回 `{tables, global}` 不是数组，记录在 `all.tables.memories`。隔离实例 console 的 `dynamicCordisRunner/syncInspectManifest 404` 是官方扩展探测的环境噪音，与本插件无关。
