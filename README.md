# 数据契约变更控制中心 (Data Contract Change Control Center)

一个可在 **Windows 本地**运行、**不依赖 Docker / 远程数据库 / 外部托管服务**的数据契约变更控制中心。它解决的核心事故是：几十个服务通过共享事件协作时，一次 JSON Schema 调整常常出现「生产方已发布、某个消费方其实还没兼容」的问题。

系统让：

- **开发者**提交基线（baseline）与候选（candidate）契约，系统计算**稳定的候选摘要**和**静态兼容性结果**；
- **构建代理**持续针对某个候选报送各消费方的验证证据；
- **发布负责人**在网页工作台查看依赖关系、证据新鲜度与阻塞原因，**只能对证据已经齐备的精确候选**做出批准；
- 每次决策保存**不可变快照**，此后到达的新证据不会悄悄改变当时的结论。

技术栈：Node.js 20+、TypeScript、React、Fastify、SQLite（`better-sqlite3`）、JSON Schema 2020-12。

---

## 快速开始（固定入口）

所有操作都通过固定的 npm 脚本完成：

```powershell
npm install      # 安装依赖（含预编译的 better-sqlite3，无需本地编译器）
npm test         # 单元 + 集成测试（node --test，纯领域 + 服务 + 恢复）
npm run build    # 清理并编译服务端(tsc) + 网页工作台(vite)
npm start        # 启动编译后的真实服务（默认 http://127.0.0.1:8080）
npm run e2e      # 端到端：构建 → 启动编译后的真实服务 + 代理模拟器 → 断言全部语义
```

> `npm start` 后用浏览器打开 `http://127.0.0.1:8080/` 即可访问发布负责人工作台。

辅助脚本：

```powershell
npm run dev:server   # tsx 热重载后端（开发用）
npm run dev:web      # vite 开发服务器（代理 /api 到 8080）
npm run sim          # 对运行中的服务运行内置代理模拟场景（见下）
```

环境变量（可选）：

| 变量           | 默认值                              | 说明 |
| -------------- | ----------------------------------- | ---- |
| `PORT`         | `8080`                              | HTTP 端口 |
| `HOST`         | `127.0.0.1`                         | 监听地址 |
| `DB_PATH`      | `./data/control-center.sqlite`      | SQLite 文件路径；`:memory:` 表示内存库 |
| `CONTROLLABLE` | 未设置                              | `=1` 时使用**逻辑时钟 + 可编程故障点**并暴露测试控制面（e2e / 模拟器用） |
| `CLOCK_START`  | `0`                                 | `CONTROLLABLE=1` 时逻辑时钟初始值 |
| `LOG`          | 未设置                              | `=1` 打开 Fastify 日志 |

---

## 核心语义

### 1. 稳定的候选摘要（candidate digest）

候选的身份由其**语义**决定，而非字节排布。`src/domain/digest.ts` 先把 JSON **规范化**（对象键按字典序递归排序、去除无意义空白、数组保序、拒绝非有限数），再取 SHA-256，得到形如 `sha256:<hex>` 的摘要。因此同一份 schema 无论键顺序、缩进如何变化，摘要都相同：

- 重复提交相同候选是**幂等**的——返回同一个 proposal，不会产生并列提案；
- 证据以「主题 + 目标摘要」定位候选，摘要稳定才能精确匹配。

### 2. 静态兼容性（JSON Schema 2020-12）

`src/domain/compatibility.ts` 回答的问题是：**「如果部署候选，基线下合法的数据是否仍然合法？」** 结果分三档：

- `COMPATIBLE`：候选接受的数据是基线的超集（例如新增可选字段、放宽边界、扩大枚举）；
- `BREAKING`：候选拒绝了某些基线合法数据（例如新增必填字段、收紧类型 / 边界、关闭 `additionalProperties`、删除枚举值）；
- `UNKNOWN`：出现组合器 / 引用（`allOf`/`anyOf`/`oneOf`/`not`/`if`/`$ref` 等）等分析器不愿臆测的构造。

分析器**刻意保守**：凡是不能证明「安全」的，都如实标为 `BREAKING` 或 `UNKNOWN`。静态分析用于**收窄风险**，消费方证据用于**最终闭合风险**——`BREAKING`/`UNKNOWN` 会作为「告警（advisory）」呈现，但不会单独阻止一个证据齐备的门禁。

### 3. 门禁状态机（gate）

`src/domain/gate.ts` 是纯函数，根据「必需消费方集合、已应用证据、兼容性结果、当前时间、新鲜度窗口」推导：

- 每个消费方的就绪度：`MISSING` / `STALE` / `PASS` / `FAIL`；
- 整体门禁状态：
  - `COLLECTING`：仍有消费方缺少新鲜的通过证据；
  - `BLOCKED`：有消费方报送了失败；
  - `READY`：所有必需消费方都有**新鲜且通过**的证据；
- `canApprove`：**仅当** `READY` 时为真；
- `evidenceFingerprint`：当前决策相关证据集合的稳定指纹。

关键规则：

- **每个消费方只认最新一条证据**（按 `producedAt` 取最大，再按 `receivedAt`、`reportId` 决胜）。旧的重复 / 迟到证据永远不会覆盖更新的证据；
- 证据相对 `now` 超过新鲜度窗口即 `STALE`，不计入就绪；
- 任一必需消费方 `FAIL` 即 `BLOCKED`；
- 非必需消费方（未知消费方）的证据**从不计入门禁**。

### 4. 决策的不可变性与并发安全

- **只能批准证据齐备的精确候选**：决策携带 `expectedDigest`（意图作用的候选摘要）与可选 `expectedFingerprint`（负责人看到的证据指纹）。摘要不匹配 → 视为视图过期，拒绝；指纹变了 → 拒绝，要求重新评估；门禁非 `READY` 时批准被拒。
- **不可变快照**：决策落库时冻结当时的完整门禁评估（`gateSnapshot`）。此后到达的证据仍会被存储，但**不会**改变这个快照，也不会改变已决结论。
- **并发决策单一结论**：决策通过存储层的**比较并设置（CAS）**提交——一个事务内「仅当 proposal 仍为 `OPEN` 时」翻转其终态并插入决策行。两个并发批准/驳回中只有一个成功，另一个得到 `CONFLICT`。**不可能产生两个互相矛盾的有效结论**。

### 5. 幂等与「迟到 / 未知」隔离

证据摄入（`src/app/control-center-service.ts` 的 `reportEvidence`）在**单个事务**内完成分类：

- **幂等**：同一 `reportId` 至多生效一次。重试的重复投递被确认为 `DUPLICATE` 且无额外影响；若同一 `reportId` 携带了不同内容，保留原件并在返回中提示（不静默接受）。
- **迟到 / 未知隔离**：目标为**未知主题**、**不存在的摘要**、**已被取代 / 已决候选**、或**非必需消费方**的报送，都会**存档用于审计**（`applied=false` 并记录 `ignoredReason`），但**不计入当前提案的门禁**。因此旧候选或未知消费方的迟到结果无法污染当前提案。

### 6. 因果记录与可解释性

每个有意义的状态转移都写入**只增不改**的事件日志（`events` 表）：`subject.registered`、`proposal.submitted`、`proposal.superseded`、`evidence.applied`、`evidence.ignored`（含忽略原因）、`decision.committed`。工作台底部实时展示该日志，`GET /api/events` 可按序号增量拉取。

---

## 故障恢复边界（明确说明能与不能）

真实链路会重复、乱序、丢响应，服务也可能在**写入后、回复前崩溃**。系统的边界如下：

- **崩溃点是可替换的故障点**：`src/ports/faults.ts` 定义了命名故障点，服务在「已持久化提交之后、回复之前」询问是否应崩溃。生产使用 `NoFaults`；测试 / e2e 使用 `ArmableFaults` 精确触发：
  - `evidence.after-write-before-reply`
  - `decision.after-commit-before-reply`
- **写入后崩溃 → 重试收敛为一次效果**：证据写入在事务中提交后才可能崩溃。崩溃使客户端收到 `503`；重试携带相同 `reportId`，命中幂等分支返回 `DUPLICATE`——效果只发生一次。
- **决策提交后崩溃 → 重试得到 CONFLICT**：决策已在事务中提交并关闭 proposal。重试发现 proposal 已终态，返回引用既有决策的 `CONFLICT`——**不会**产生第二个（可能矛盾的）决策。
- **重启后从 SQLite 完整恢复**：状态与因果日志都在 SQLite 中（WAL 日志 + `synchronous=FULL`，可抵御硬杀进程）。重启后 `getProposalView` / `snapshot` / `events` 都从**持久化存储**重建，不依赖任何进程内内存。e2e 会**硬杀（SIGKILL）**服务进程再重启，断言已批准决策、决策快照与事件日志全部幸存。
- **网页重连一致性**：工作台读取 `GET /api/snapshot`——一个完全由持久化存储构建的**一致快照**。因此刷新 / 重连总是得到同一份权威视图，而不是只靠进程内事件流。
- **不在边界内**：本系统不做多节点分布式共识、不做跨机复制、不做真实网络传输保证（这些交由部署环境）。它保证的是**单实例 + 持久化存储**下的幂等、隔离、不可变与可恢复。

---

## 确定性时序复现（不等待真实时间）

`src/domain/clock.ts` 把时间抽象为 `Clock` 端口：生产用 `SystemClock`（墙上时钟），测试 / e2e 用 `LogicalClock`（只在显式 `advance`/`set` 时变化）。当 `CONTROLLABLE=1` 时，服务额外暴露**测试控制面**（生产不含）：

- `POST /api/control/clock/advance` `{ deltaMs }` — 推进逻辑时间（用于让新鲜度窗口过期、精确排序）；
- `POST /api/control/clock/set` `{ ms }`；
- `POST /api/control/faults/arm` `{ point, times }` — 武装故障点；
- `POST /api/control/faults/disarm` `{ point }`。

**构建代理模拟器**（`src/adapters/agent/`）据此重放所有棘手时序：脚本按严格顺序执行步骤，因此「服务端看到的到达顺序」完全由脚本决定——这就是精确复现**重复、乱序、丢响应、写入后崩溃**的方式，全程使用逻辑时钟，无需等待真实时间。

内置场景（`src/adapters/agent/scenarios.ts`）：

| 场景 | 验证的性质 |
| ---- | ---------- |
| `gate-happy-path-and-idempotency` | 证据齐备 → `READY` → 批准；同一报送重试只生效一次 |
| `late-evidence-for-superseded-candidate-is-ignored` | 旧候选的迟到证据不污染当前提案 |
| `evidence-goes-stale-with-logical-time` | 逻辑时间推进使证据变陈旧，批准被阻止 |
| `unknown-consumer-evidence-is-not-counted` | 未知消费方证据不计入门禁 |
| `concurrent-approvals-yield-single-conclusion` | 并发审批只产生一个有效结论 |
| `crash-after-write-then-retry-is-idempotent` | 写入后崩溃 + 重试收敛为一次效果 |

对运行中的可控服务单独跑模拟器：

```powershell
$env:CONTROLLABLE="1"; npm start        # 另开一个终端
node dist/src/adapters/agent/cli.js http://127.0.0.1:8080            # 跑全部场景
node dist/src/adapters/agent/cli.js http://127.0.0.1:8080 <场景名>   # 跑单个场景
```

---

## 架构（端口与适配器，关注点解耦）

```
src/
  domain/                 纯领域核心（无 IO、无框架、时间与故障可替换）
    types.ts              领域词汇
    clock.ts              Clock 端口 + SystemClock / LogicalClock
    digest.ts             规范化 JSON + 稳定候选摘要
    compatibility.ts      JSON Schema 2020-12 静态兼容性分析器（纯函数）
    gate.ts               门禁评估与决策资格状态机（纯函数）
  ports/
    repository.ts         持久化端口（应用层只依赖它，不依赖 SQLite）
    faults.ts             故障注入端口（NoFaults / ArmableFaults）
  app/
    control-center-service.ts  编排：提交 / 摄入证据 / 决策 / 一致快照
  adapters/
    store/sqlite-repository.ts  SQLite 实现（WAL + 同步全量、CAS 决策、事件日志）
    http/server.ts              Fastify 适配器（含仅测试的控制面路由）
    http/main.ts                组合根（生产 vs 可控接线）
    agent/                      可脚本控制的构建代理模拟器 + CLI
web/                      React 发布负责人工作台（vite 构建，Fastify 静态托管）
tests/
  unit/                   领域纯函数测试
  integration/            服务 + 真实 SQLite + 恢复测试
  e2e/run-e2e.ts          启动编译后的真实服务 + 模拟器，含硬杀重启
```

**兼容性与门禁状态机（`domain/`）同 HTTP、存储、界面、代理适配器完全解耦**：领域核心不 import 任何适配器；应用层只依赖 `Clock` / `Repository` / `FaultInjector` 三个端口；时钟与故障点因此都可替换。

---

## HTTP API 摘要

| 方法 & 路径 | 说明 |
| ----------- | ---- |
| `GET  /api/health` | 健康检查 |
| `POST /api/subjects` | 注册主题：`{ subjectId, requiredConsumers[], freshnessWindowMs }` |
| `POST /api/analyze` | 无状态预览：`{ baselineSchema, candidateSchema }` → `{ candidateDigest, compat }` |
| `POST /api/subjects/:id/candidates` | 提交候选：`{ baselineSchema, candidateSchema, submittedBy }` |
| `POST /api/evidence` | 报送证据：`{ reportId, subjectId, targetDigest, consumerId, verdict, producedAt, detail? }` |
| `POST /api/proposals/:id/decision` | 决策：`{ expectedDigest, expectedFingerprint?, type, decidedBy, note? }` |
| `GET  /api/proposals/:id` | 单个提案视图（含实时门禁与决策） |
| `GET  /api/snapshot` | 一致快照（工作台使用，源自持久化存储） |
| `GET  /api/events?since=<seq>` | 因果事件日志（增量） |
| `*    /api/control/*` | **仅** `CONTROLLABLE=1` 时存在：逻辑时钟 / 故障点控制 |

状态码约定：`201` 新建（提案 / 证据应用 / 决策成功）、`200` 幂等或忽略、`409` 冲突（决策竞争 / 已终态）、`422` 前置条件不满足（门禁未就绪 / 摘要或指纹不匹配）、`503` 注入崩溃。

---

## 本地操作流程（典型）

1. `npm install && npm run build`
2. `npm start`，浏览器打开 `http://127.0.0.1:8080/`
3. 开发者通过 `POST /api/subjects` 注册主题，`POST /api/subjects/:id/candidates` 提交基线与候选，得到稳定摘要与兼容性结果。
4. 构建代理对该候选持续 `POST /api/evidence` 报送各消费方结果（可重试，幂等）。
5. 工作台实时显示依赖消费方就绪度、证据新鲜度、阻塞原因；**批准按钮仅在门禁 `READY` 时可用**。
6. 发布负责人批准 / 驳回，结论以不可变快照落库；之后的迟到证据不改变结论。
7. 需要复现异常时序时，用 `CONTROLLABLE=1` 启动并通过 `npm run e2e` 或模拟器 CLI 脚本化重放。

---

## 测试与验证

- `npm test`：40+ 个单元 / 集成用例，覆盖摘要稳定性、兼容性分档、门禁规则、幂等、迟到 / 未知隔离、新鲜度过期、并发冲突、注入崩溃、SQLite 重启恢复。
- `npm run e2e`：编译后启动**真实服务进程**，用**真实代理模拟器**通过 HTTP 跑完所有内置场景，随后**硬杀并重启**服务，断言决策 + 因果日志从磁盘恢复、重连快照一致、迟到证据不改动已决快照。
