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

每个有意义的状态转移都写入**只增不改**的事件日志（`events` 表）：`subject.registered`、`proposal.submitted`（含 `predecessorId`）、`proposal.replaced`（前序被后继替代，含随之失效的豁免）、`proposal.superseded`、`evidence.applied`、`evidence.ignored`（含忽略原因）、`decision.committed`（含依据的豁免 id）、`waiver.requested`、`waiver.confirmed`、`waiver.rejected`、`waiver.revoked`、`waiver.expired`（含到期原因）、`waiver.lapsed`（因候选被替代而按原作用域失效）。工作台底部实时展示该日志，`GET /api/events` 可按序号增量拉取。

---

## 限时豁免（双人复核、精确作用域、可到期/撤销）

有些消费方会在发布窗口内**暂时离线**。限时豁免让发布得以继续，同时**不稀释**候选摘要与不可变决策快照。

设计要点：

- **精确作用域**：一项豁免只能覆盖它命名的 `(候选摘要 candidateDigest, 消费方 consumerId, 环境 environment, 兼容方向 compatDirection)` 四元组。作用域在申请时固定、不可变，且**不参与、也不改变候选摘要**——豁免是叠加在不变候选身份之上的独立实体。申请时会校验候选存在且为 OPEN、消费方属于该主题、且请求的兼容方向与候选实际静态结果一致（避免为温和变更写的豁免日后覆盖更危险的候选）。
- **双人复核（dual control）**：豁免由一名复核人 `requestWaiver` 提出，进入 `REQUESTED`，此时**不参与**门禁；必须由**另一名不同的**复核人 `confirmWaiver` 才转为 `ACTIVE` 并开始参与。确认/拒绝是对 `REQUESTED` 的比较并设置（CAS），重复或并发确认不会重复激活。
- **只覆盖缺席/陈旧，绝不覆盖 FAIL**：豁免只能把 `MISSING` 或 `STALE` 的消费方标记为 `WAIVED`（视为已满足）。消费方一旦明确报送 `FAIL`（真实的不兼容信号），门禁始终 `BLOCKED`，豁免无法掩盖它。
- **到期 / 撤销后不再参与**：每项豁免带绝对到期时刻（`expiresAt = 申请时刻 + ttlMs`）。到期（`EXPIRED`）或被 `revokeWaiver` 撤销（`REVOKED`）后立即成为终态，**不再进入任何新决策**。系统在每次评估 / 决策 / 快照前做惰性到期扫描（`expireWaivers`），且只扫 `ACTIVE` 行，因此幂等。
- **环境限定**：决策针对某个环境作出（默认 `production`），豁免绑定到单一环境。为 staging 授予的豁免不会泄漏到 production 门禁；不同环境产生不同的证据指纹。
- **历史快照保持原样**：决策时冻结的 `gateSnapshot` 记录了它**依据的具体豁免**（`appliedWaivers`）。此后该豁免到期或被撤销，只改变**实时**评估，**绝不**改动已经形成的历史快照与已决结论。证据指纹把「应用了哪些豁免」一并纳入，所以「凭豁免批准」与「无豁免批准」是两个不同的决策依据。

豁免的完整生命周期（申请、复核、拒绝、撤销、到期原因）都写入因果审计链（见上一节的事件类型），并随 SQLite 重启完整恢复。

---

## 后继提案与谱系（上游修正候选）

上游可能在等待期间修正候选契约。系统支持从当前提案创建**后继提案**，并展示清晰谱系：

- **新内容 = 新摘要 = 新提案**：后继候选的内容不同，产生**新的候选摘要**（`digest.ts` 基于内容，天然不同）。它以独立提案存在，通过 `predecessorId` 显式链接到前序；工作台展示「后继自 …」/「已被后继替代 …」的谱系链，`proposal.replaced` 事件记录替代关系。
- **旧证据不自动沿用**：构建证据以**前序提案的 `proposalId`** 存储，后继提案从零开始收集——不会继承任何 `PASS`。因此后继一提交即处于 `COLLECTING`，必须重新取证。
- **上一轮豁免按原精确作用域失效**：前序被替代时，其 `REQUESTED`/`ACTIVE` 豁免统一转为终态 `LAPSED`（`waiver.lapsed` 审计）。由于豁免绑定**旧候选摘要**，即使后继有同名消费方缺席，旧豁免也**不因名称相同而被继承**——既因作用域不匹配，也因已 `LAPSED`。
- **并发到达的旧结果仍归原提案，且不放行后继**：针对旧候选摘要的迟到 / 并发结果解析到那个（现为 `SUPERSEDED` 的）原提案，`applied=false` 存档（`evidence.ignored`，原因点明「已被后继替代」），**绝不**参与后继门禁——它甚至不指向后继的摘要。
- **并发创建后继的保护**：`submitCandidate` 可携带 `expectedPredecessorId`。若当前开放提案已不是调用者所设想的那个（例如另一个后继先落地），提交被拒（`409 CONFLICT`），避免误替换了另一个候选。
- **相同内容仍幂等**：重复提交同一内容（同摘要）仍返回既有提案，不产生并列提案。

谱系、替代、豁免失效、迟到忽略都写入因果链并随 SQLite 重启完整恢复。

---

## 分阶段发布（波次、绑定决策快照、暂停/重试/回退）

候选一旦通过门禁并被**批准**，负责人就可以把它接到**分阶段发布流程**：按环境安排一串**连续波次**（canary → half → full 等）。部署适配器为每个波次尝试回传一条回执（`SUCCESS` / `FAILURE` / `UNKNOWN`）。纯领域规则在 `src/domain/rollout.ts`，服务编排在 `control-center-service.ts` 的发布相关方法。

设计要点：

- **绑定同一决策快照**：一个 rollout 从某个 `APPROVE` 决策创建，逐字绑定该决策快照的身份——`decisionId`、`proposalId`、`candidateDigest`、`evidenceFingerprint`、`environment`。每个 `(主题, 环境)` 至多有一个未终结的 rollout（SQLite 局部唯一索引 + 服务校验双重保证）。
- **回执只推进当前波次尝试**：回执分类是纯函数（`classifyReceipt`）。**只有**同时满足「rollout 处于 `IN_PROGRESS`」「回执指纹等于所绑定决策指纹」「命中当前 `IN_PROGRESS` 的波次」「尝试号等于该波次的存活尝试号」的**首见**回执才会推进。其余一律为惰性：
  - **重复**：同一 `receiptId` 至多生效一次（存储层按 id 幂等，重投返回既有记录）；
  - **乱序 / 陈旧**：命中非当前波次、或旧 / 未来尝试号的回执，`applied=false` 存档并记录忽略原因；
  - **指纹不匹配**：指向别的决策快照（因此也指向别的候选 / 后继）的回执**永远**不会推进本 rollout——后继提案有自己的决策与指纹，回执无法跨 rollout。
- **`UNKNOWN` 非决定性**：适配器无法判定结果时回传 `UNKNOWN`，波次保持 `IN_PROGRESS`，等待负责人重试或后续确定性回执。
- **连续波次**：一次只跑一个波次；仅当当前波次以 `SUCCESS` 结算后才能 `startNextWave` 启动下一个。最后一个波次成功即 rollout `COMPLETED`。
- **暂停 / 重试**：`pauseRollout` 后所有回执惰性、不能启动新波次；`resumeRollout` 恢复。`retryWave` 把波次的 `attempt` **加一**并重开波次——由此**上一尝试的所有回执（含失败尝试的迟到重复）都按尝试号变陈旧**，无法结算重试后的波次。
- **回退指向上一个已知版本（仅部署）**：`rollback` 面向「上一个已知良好」的候选摘要（该摘要须此前在同环境被 `APPROVE` 过），创建一个新的 `ROLLBACK` 类型 rollout 重新部署它，并把被它取代的 rollout 置为 `ROLLED_BACK`。**回退是纯部署动作**：它**不调用** `commitDecision`、**不改写**任何契约决策快照、**也不复活**任何已 `LAPSED`/`EXPIRED` 的豁免。原契约决策保持 `APPROVED` 原样。
- **进程重启 + 回执丢失**：新增故障点 `rollout.receipt.after-write-before-reply`——回执在事务中持久化后、回复前崩溃。客户端得到 `503`（回执丢失）；重启后波次已按持久化状态结算，携带相同 `receiptId` 的重试命中幂等分支返回 `DUPLICATE`，效果只发生一次。全部 rollout / 波次 / 回执状态随 SQLite 完整恢复。

发布生命周期写入因果链：`rollout.created`、`rollout.wave.started`、`rollout.receipt.applied`、`rollout.receipt.ignored`（含忽略原因）、`rollout.wave.retried`、`rollout.paused`、`rollout.resumed`、`rollout.rolled_back`。工作台按环境展示每个 rollout 的波次表、尝试号、部署回执（是否推进及原因）与暂停/重试/回退操作。

---

## 故障恢复边界（明确说明能与不能）

真实链路会重复、乱序、丢响应，服务也可能在**写入后、回复前崩溃**。系统的边界如下：

- **崩溃点是可替换的故障点**：`src/ports/faults.ts` 定义了命名故障点，服务在「已持久化提交之后、回复之前」询问是否应崩溃。生产使用 `NoFaults`；测试 / e2e 使用 `ArmableFaults` 精确触发：
  - `evidence.after-write-before-reply`
  - `decision.after-commit-before-reply`
  - `rollout.receipt.after-write-before-reply`
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
| `dual-controlled-waiver-covers-offline-consumer-then-expires` | 双人复核豁免覆盖离线消费方，到期后历史决策不变 |
| `waiver-cannot-mask-a-fail` | 豁免绝不掩盖真实 FAIL |
| `successor-proposal-does-not-inherit-evidence-or-waivers` | 后继提案新摘要、不沿用证据、旧豁免按作用域失效、并发旧结果不放行后继 |
| `staged-rollout-receipts-bound-to-decision-with-pause-retry-rollback` | 分阶段发布：回执绑定决策快照与波次尝试；重复/乱序/指纹不匹配惰性；暂停、失败重试、写入后崩溃幂等、回退到上一个已知版本且不改写契约决策 |

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
    rollout.ts            分阶段发布回执分类（纯函数：绑定决策快照 + 当前波次尝试）
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
| `POST /api/subjects/:id/candidates` | 提交候选 / 后继：`{ baselineSchema, candidateSchema, submittedBy, expectedPredecessorId? }`（相同内容幂等；不同内容则成为当前提案的后继） |
| `POST /api/evidence` | 报送证据：`{ reportId, subjectId, targetDigest, consumerId, verdict, producedAt, detail? }` |
| `POST /api/proposals/:id/decision` | 决策：`{ expectedDigest, expectedFingerprint?, environment?, type, decidedBy, note? }` |
| `POST /api/waivers` | 申请豁免：`{ subjectId, candidateDigest, consumerId, environment?, compatDirection, reason, requestedBy, ttlMs }` |
| `POST /api/waivers/:id/confirm` | 第二名复核人确认：`{ confirmedBy }`（须不同于申请人） |
| `POST /api/waivers/:id/reject` | 第二名复核人拒绝：`{ rejectedBy, reason }` |
| `POST /api/waivers/:id/revoke` | 撤销 ACTIVE 豁免：`{ revokedBy, reason }` |
| `GET  /api/waivers/:id` | 单个豁免记录（完整生命周期） |
| `POST /api/rollouts` | 从批准决策创建发布：`{ decisionId, waves[], createdBy, note? }`（绑定该决策快照） |
| `POST /api/rollouts/:id/start-wave` | 启动下一个待发波次（须无进行中波次、未暂停） |
| `POST /api/rollouts/:id/pause` / `.../resume` | 暂停 / 恢复发布 |
| `POST /api/rollouts/:id/waves/:waveId/retry` | 重试波次（`attempt` 加一，使旧尝试回执陈旧） |
| `POST /api/rollbacks` | 回退到上一个已知版本：`{ subjectId, environment?, targetDigest, waves[], createdBy, note? }`（仅部署，不改写决策/豁免） |
| `POST /api/receipts` | 部署适配器回执：`{ receiptId, rolloutId, waveId, attempt, result, evidenceFingerprint, detail? }` |
| `GET  /api/rollouts/:id` | 单个发布详情（rollout + 波次 + 回执） |
| `GET  /api/subjects/:id/rollouts` | 某主题的全部发布 |
| `GET  /api/proposals/:id?environment=` | 单个提案视图（含实时门禁、决策、豁免列表） |
| `GET  /api/snapshot?environment=` | 一致快照（工作台使用，源自持久化存储） |
| `GET  /api/events?since=<seq>` | 因果事件日志（增量） |
| `*    /api/control/*` | **仅** `CONTROLLABLE=1` 时存在：逻辑时钟 / 故障点控制 |

状态码约定：`201` 新建（提案 / 证据应用 / 决策成功 / 豁免状态转移成功 / 发布创建 / 波次启动 / 重试 / 回执推进）、`200` 幂等或忽略（含暂停/恢复成功、重复或惰性回执）、`409` 冲突（决策竞争 / 已终态）、`422` 前置条件不满足（门禁未就绪 / 摘要或指纹不匹配 / 豁免被拒绝，如双人复核违规、作用域或方向不符、已过期 / 发布操作被拒，如非 APPROVE 决策、已有进行中发布、波次不可重试、回退目标未曾批准）、`503` 注入崩溃。

---

## 本地操作流程（典型）

1. `npm install && npm run build`
2. `npm start`，浏览器打开 `http://127.0.0.1:8080/`
3. 开发者通过 `POST /api/subjects` 注册主题，`POST /api/subjects/:id/candidates` 提交基线与候选，得到稳定摘要与兼容性结果。
4. 构建代理对该候选持续 `POST /api/evidence` 报送各消费方结果（可重试，幂等）。
5. 工作台实时显示依赖消费方就绪度、证据新鲜度、阻塞原因；**批准按钮仅在门禁 `READY` 时可用**。
6. 若某消费方在发布窗口内暂时离线（`MISSING`/`STALE`），复核人 A 可对精确作用域 `申请豁免`；复核人 B（不同人）`确认`后该消费方变为 `WAIVED`，门禁可达 `READY`。豁免不覆盖 `FAIL`，过期/撤销后自动退出。
7. 发布负责人批准 / 驳回，结论以不可变快照落库（含依据的豁免）；之后的迟到证据或豁免到期/撤销都不改变结论。
8. 批准后，负责人在工作台「分阶段发布」区按环境安排连续波次；部署适配器 `POST /api/receipts` 回传每个波次尝试的结果。可暂停 / 恢复、失败重试（尝试号加一使旧回执陈旧），或**回退到上一个已知版本**（仅重新部署，不改写契约决策，也不复活已失效豁免）。
9. 需要复现异常时序时，用 `CONTROLLABLE=1` 启动并通过 `npm run e2e` 或模拟器 CLI 脚本化重放。

---

## 测试与验证

- `npm test`：79 个单元 / 集成用例，覆盖摘要稳定性、兼容性分档、门禁规则、幂等、迟到 / 未知隔离、新鲜度过期、并发冲突、注入崩溃、SQLite 重启恢复；豁免：双人复核、精确作用域、绝不覆盖 FAIL、到期/撤销退出、决策快照不可变、审计链与重启恢复；后继提案：新摘要、证据不沿用、豁免按原作用域失效、并发旧结果不放行后继、`expectedPredecessorId` 冲突保护、替代/失效/迟到的因果记录与恢复；分阶段发布：纯回执分类、绑定决策快照、幂等/乱序/陈旧/指纹不匹配惰性、连续波次、暂停/重试、失败后重试使旧尝试回执陈旧、跨提案隔离、回退不改写契约决策/不复活豁免、回执写入后崩溃 + 重启幂等恢复。
- `npm run e2e`：编译后启动**真实服务进程**，用**真实代理模拟器**通过 HTTP 跑完所有内置场景（含 `dual-controlled-waiver-covers-offline-consumer-then-expires`、`waiver-cannot-mask-a-fail`、`successor-proposal-does-not-inherit-evidence-or-waivers`、`staged-rollout-receipts-bound-to-decision-with-pause-retry-rollback`，全程逻辑时钟无真实等待），随后**硬杀并重启**服务，断言决策 + 因果日志从磁盘恢复、重连快照一致、迟到证据不改动已决快照，并**专门覆盖发布回执写入后崩溃 / 回执丢失 + 进程重启**：波次按持久化状态结算、重投回执幂等为 `DUPLICATE`。
