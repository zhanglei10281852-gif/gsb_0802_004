# 数据契约变更控制中心

面向“几十个服务通过共享事件协作”的场景：开发者提交基线与候选契约（JSON Schema 2020-12），系统计算稳定的候选摘要与兼容性结果；构建代理持续报送各消费方针对该精确候选的验证证据；发布负责人在网页工作台查看依赖关系、证据新鲜度与阻塞原因，并且只能对证据齐备的精确候选作出决策。每次决策保存不可变快照，之后到达的证据不能悄悄改变当时的结论。

运行时不要求 Docker、远程数据库或外部托管服务：Node.js 20 + TypeScript + Fastify + SQLite（better-sqlite3）+ React（Vite 构建）。

## 固定入口

```bash
npm install        # 安装依赖
npm test           # 单元测试（兼容性 / 门禁状态机 / 存储与恢复）
npm run build      # 编译服务端与代理（tsc）+ 构建网页（vite）到 dist/
npm start          # 启动真实服务：http://localhost:4730
npm run agent -- examples/demo.scenario.json   # 对运行中的服务执行代理模拟场景
npm run e2e        # 端到端：启动编译后的真实服务 + 代理模拟器，全程手动时钟
```

环境变量（`npm start`）：`PORT`（默认 4730）、`DB_PATH`（默认 `./data/control.db`）、`EVIDENCE_TTL_MS`（默认 900000）、`CONTRACT_CLOCK`（`system` 默认 / `manual` 测试用）、`CLOCK_START`（手动时钟起点）。

## 目录结构

```
src/core/      纯领域逻辑，零 I/O：canonical.ts（规范化+SHA-256 摘要）、compat.ts（兼容性判定）、
               gate.ts（门禁状态机）、clock.ts（可替换时钟）
src/server/    适配层：db.ts（SQLite 模式）、store.ts（事务化存储，唯一状态源）、
               app.ts（Fastify REST + SSE）、main.ts（进程入口）
src/agent/     构建代理模拟器（场景 JSON 驱动）
src/scripts/   e2e.ts 端到端入口
web/           React 工作台（Vite 构建到 dist/web，由服务端托管）
test/          vitest 单元测试
examples/      演示场景
```

## 核心语义

**候选摘要**：对候选 Schema 做键序无关的规范化序列化后取 SHA-256。同一候选无论字段顺序如何都得到同一摘要；证据必须精确指向该摘要才算数。

**兼容性方向**：契约描述“生产方会发出什么数据”，因此候选兼容基线当且仅当候选接受的数据集合是基线的子集（收窄安全，放宽破坏）。覆盖 `type/enum/const/数值边界/字符串长度/items/properties/required/additionalProperties` 等构造；`$ref/oneOf/anyOf/allOf/pattern 变更` 等无法静态判定的构造产生 `breaking=false` 的“需人工复核”发现，而不是静默通过。

**门禁状态机**（纯函数，`evaluateGate`）：就绪 = 每个声明的消费方都有针对当前候选摘要的、未超过 TTL 的、`pass` 证据，且兼容性非破坏性。阻塞原因可解释：`missing_evidence`（未报送）、`stale_evidence`（过期）、`failed_evidence`（验证失败）、`breaking_compat`（破坏性变更，批准时可由负责人显式 `acknowledgeBreaking` 豁免）。驳回同样需要证据齐备且新鲜——失败与破坏性恰恰是驳回理由。

**限时豁免**（消费方在发布窗口内暂时离线时）：

- **范围**：每张豁免单精确覆盖四元组（候选摘要、消费方、环境、兼容方向 `backward`/`forward`），且只能针对提案的**当前**候选摘要申请——候选修订后旧豁免自然失效，不会稀释候选摘要语义。
- **四眼原则**：豁免需**两名不同审核人**确认后才生效；申请人不能复核自己的豁免，同一审核人不能重复确认。待复核的豁免可被拒绝（注明原因）。
- **效力**：生效中的豁免仅抵消该消费方在当前候选下的 `missing_evidence` / `stale_evidence` 阻塞（backward 方向），被豁免的阻塞项移入 `gate.waived` 保留痕迹；`failed_evidence` 与 `breaking_compat` **永远不可豁免**。
- **限时与退出**：豁免必须携带 `ttlMs`；到期后由过期扫描物化为 `expired` 并把到期原因写入审计链（`EXEMPTION_EXPIRED`），也可随时 `revoke`。过期、被撤销、被拒绝的豁免**不再参与任何新决策**。
- **快照不可变**：决策快照逐条拷贝决策时实际使用的豁免（`exemptionsUsed`，含复核人），此后豁免被撤销或到期都不改变已形成的历史结论。

**提案谱系**（上游在等待期间修正候选契约时）：

- `POST /api/proposals/:id/successors` 从当前提案派生后继：继承基线（标题/消费方/环境/TTL 可覆盖），新候选产生**新的候选摘要**并重新计算兼容性。
- 原提案仍开放时在同一事务内被**替代关闭**（`superseded`，写入 `PROPOSAL_SUPERSEDED` 因果事件）；已决策的原提案保持原结论与快照，仅记录谱系链接（`predecessorId` / `supersededById`）。
- **不继承**：原提案的构建证据按提案与摘要双重作用域留在原提案，绝不自动沿用；上一轮的豁免绑定原精确四元组，**不会因为消费方名称相同而继承**到后继。
- **迟到隔离**：并发到达的旧候选结果 POST 到原提案时归入原提案存档（`closed`，附 `EVIDENCE_LATE` 因果事件），发往后继时按 `stale_candidate` 隔离——两条路径都不参与后继的门禁，**不得放行后继提案**。
- 谱系保持线性：同一提案只允许一个后继（`superseded_by_id IS NULL` CAS，并发派生返回 409 `ALREADY_SUPERSEDED`）；被替代的提案不能修订也不能决策（409 `PROPOSAL_SUPERSEDED`）。

**分阶段发布**（通过门禁的候选接入部署流程）：

- 已批准的提案可创建一次发布：负责人按环境安排**连续波次**（每波次名称+环境），发布绑定**当时的决策快照**（`decisionId` + 候选摘要），第一波次立即进入部署中。
- 部署适配器回传**成功/失败/未知**回执，携带幂等键与决策快照 id。只有绑定同一决策快照、且指向**当前波次**（部署中）的回执才能推进：成功 → 下一波次开始部署（末波次后发布完成）；失败/未知 → 发布自动暂停等待人工处理。
- **隔离语义**（与证据一致）：重复回执按幂等键去重（`duplicate`）；决策快照不匹配（`stale_decision`）、非当前波次的乱序/迟到回执（`stale_wave`）、暂停期间到达（`paused`）、发布已关闭（`closed`）的回执都被记录但永不推进，并写入 `RECEIPT_LATE` 因果事件。
- **暂停/恢复**：人工暂停期间回执不推进（恢复后需适配器重发）。**重试**：仅失败/结果未知的当前波次可重试（retryCount 递增，发布回到进行中）。**回退**：目标必须是已知版本（已成功的波次，或 0 表示发布前），后续波次标记 `rolled_back`；回退**只改发布/波次状态**——不改写原契约决策快照，也不触碰任何豁免（已失效豁免不会被复活）。
- 适配器模拟器步骤：`rollout`（创建发布）、`receipt`（回执，支持 `loseResponse` 回执丢失重发、`decision:'stale'` 伪造旧决策、`expectOutcome` 断言）、`rolloutControl`（pause/resume/retry/rollback）。e2e 覆盖回执丢失、乱序隔离与**进程重启后从 SQLite 恢复发布状态**。

**决策**：`POST /api/proposals/:id/decisions` 携带 `expectedVersion` 做乐观并发控制。门禁评估、版本 CAS、快照落库在同一 SQLite 事务内完成；并发审批恰好一个生效，其余收到 409。决策快照逐条拷贝当时采用的证据、兼容性结论与门禁结果，落库后无任何更新路径——提案已关闭后到达的证据标记为 `closed`、旧候选证据标记为 `stale_candidate`，都会被记录审计但永远不参与门禁。

## 故障恢复边界

- **重复报送**：证据以 `idempotencyKey` 全局唯一去重。代理“写入后、回复前崩溃”的重试用相同键重试，服务端返回 `duplicate` 与原始记录，效果恰好一次。同键不同内容返回 409。
- **乱序 / 迟到**：同一消费方按（记录时刻, 自增序号）取最新；旧候选摘要或未知消费方（422）的结果被隔离，不污染当前提案。
- **并发审批**：单事务内 CAS（`UPDATE ... WHERE version=? AND status='open'`），不会产生两个互相矛盾的有效结论。
- **进程崩溃**：所有状态迁移先提交事务再返回响应；内存中无业务状态。重启后从 SQLite 完整恢复提案、证据、决策快照与事件游标，幂等键依然有效。
- **网页重连**：SSE 先从 `events` 表按 `Last-Event-ID`/`since` 重放再推送实时事件；工作台在每次 SSE 建立（含自动重连）时调用 `GET /api/snapshot`（单只读事务的一致快照）全量替换本地状态，不依赖进程内事件。
- **时钟**：领域逻辑只依赖注入的 `Clock`。`CONTRACT_CLOCK=manual` 时暴露 `GET /api/clock` 与 `POST /api/clock/advance`，证据过期等时序可在不等待真实时间的情况下复现（e2e 即如此）。

## 代理模拟器

场景是 JSON 步骤数组，逐步执行（JSONL 日志，任一断言失败退出码非零）：

```json
{
  "server": "http://127.0.0.1:4730",
  "steps": [
    { "do": "createProposal", "as": "p1", "title": "...", "baseline": {}, "candidate": {}, "consumers": ["a"] },
    { "do": "evidence", "proposal": "p1", "consumer": "a", "key": "k1", "repeat": 2 },
    { "do": "evidence", "proposal": "p1", "consumer": "a", "key": "k2", "loseResponse": true, "repeat": 2 },
    { "do": "evidence", "proposal": "p1", "consumer": "a", "key": "k3", "digest": "stale", "expectOutcome": "stale_candidate" },
    { "do": "concurrentDecisions", "proposal": "p1", "decisions": [{ "by": "lead-a" }, { "by": "lead-b" }] },
    { "do": "advanceClock", "ms": 2000 },
    { "do": "snapshot" }
  ]
}
```

- `repeat`：相同幂等键重复报送（验证去重）。
- `loseResponse`：第一次请求发出后丢弃响应（模拟写后崩溃），配合 `repeat` 重试。
- `digest: "stale"` 或字面摘要：伪造旧候选/未知候选的迟到结果。
- `expectStatus` / `expectOutcome`：脚本化断言。
- `waitMs`：默认跳过（虚拟时序），传 `--real-time` 才真实睡眠。

## 本地操作流程

1. `npm install && npm run build && npm start`，打开 http://localhost:4730。
2. 在“新建提案”粘贴基线与候选 Schema、填写消费方清单；或运行 `npm run agent -- examples/demo.scenario.json` 自动造一条含噪声（重复、丢响应重试）的演示数据。
3. 工作台查看兼容性发现、证据矩阵新鲜度与阻塞原因；门禁“就绪”后填写决策人批准/驳回（破坏性候选需勾选确认）。
4. 决策后可在详情中查看不可变快照与事件时间线；随时 `Ctrl+C` 停止再 `npm start`，状态完整恢复。

## HTTP API 摘要

| 方法/路径 | 说明 |
| --- | --- |
| `POST /api/proposals` | 创建提案（基线+候选+消费方清单，可选 environment），返回摘要、兼容性与门禁 |
| `POST /api/proposals/:id/revisions` | 提交新候选修订（`expectedVersion` 乐观锁） |
| `POST /api/proposals/:id/successors` | 派生后继提案（谱系链接；原提案开放则替代关闭；证据/豁免不继承） |
| `POST /api/proposals/:id/evidence` | 代理报送证据（幂等键去重；旧候选/已关闭隔离记录） |
| `POST /api/proposals/:id/decisions` | 门禁通过后决策并保存不可变快照（CAS） |
| `POST /api/proposals/:id/exemptions` | 申请限时豁免（当前候选+消费方+环境+兼容方向，必须 ttlMs） |
| `POST /api/exemptions/:id/confirm` | 审核人确认；两名不同审核人确认后生效（申请人除外） |
| `POST /api/exemptions/:id/reject` | 拒绝待复核豁免（注明原因） |
| `POST /api/exemptions/:id/revoke` | 撤销生效中豁免（立即退出新决策，历史快照不变） |
| `POST /api/proposals/:id/rollouts` | 为已批准提案创建分阶段发布（绑定决策快照，每提案至多一个） |
| `POST /api/rollouts/:id/receipts` | 适配器回执（幂等去重；仅当前波次+同决策快照可推进） |
| `POST /api/rollouts/:id/pause` `/resume` | 暂停 / 恢复发布 |
| `POST /api/rollouts/:id/waves/:waveId/retry` | 重试失败/结果未知的当前波次 |
| `POST /api/rollouts/:id/rollback` | 回退到已知版本（已成功波次或 0=发布前；不改决策、不复活豁免） |
| `GET /api/rollouts/:id` | 发布详情（波次、回执、状态） |
| `GET /api/proposals[/:id]` | 列表 / 详情（含证据、阻塞原因、决策快照、事件） |
| `GET /api/snapshot` | 一致快照（单事务），供网页重连恢复 |
| `GET /api/events?since=` | SSE：先重放 SQLite 历史事件再实时推送 |
| `GET/POST /api/clock[/advance]` | 仅手动时钟模式：读取/推进时钟 |
