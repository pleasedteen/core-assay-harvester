# 本地模拟岩芯化验报告站点 + 采集服务

一个完全本地的 TypeScript / Node.js 演示系统：**模拟站点**发布带编号与修订的岩芯化验报告（正文 + 跨页附表），**采集服务**按快照完整采集，按 JSON Lines 落盘并交付。不访问任何真实外站。

- 站点与采集器都是真实 HTTP 服务，签名、一次性翻页凭证、限流、封禁会话、响应中断都在服务端真实校验/注入。
- 站点是纯本地、确定性内容生成器（固定种子），不访问任何外网，也不依赖时间或随机数来决定报告内容。
- 采集结果以快照为单位物化，进程被杀后可用同一数据目录继续，已完整落盘的报告不会再请求。
- 站点目录内嵌**检测清单（manifest）**，逐报告声明样本与每个样本应有的检测项（同份报告内不同样本的项目可以不同）；采集器对正文与全部附表逐项核对，缺行缺列、重复项顶替、检出限没有数值都会在进度里点名样本和检测项。明确标成缺测（`—`）的结果仍算有效。
- 续跑旧数据目录时**只凭站点目录清单核验缓存**：完好的报告直接跳过正文和附表，核验不过的报告重新采集；本次运行失败时不触碰上一份完整交付。
- 下载接口在采集和恢复期间始终返回上一份完整成果；首次完整交付前明确返回"尚无成果"。
- `npm test` 用真实本地 HTTP 交互覆盖正常采集、会话恢复、响应中断、布局变化、进程重启，通常在 20–40 秒内结束。

## 快速开始

```bash
npm install            # 仅此一步需要网络
npm test               # 真实 HTTP 端到端测试（80 秒上限内）
npm run demo           # 一键演示：建站、采集、中途发布新修订、注入故障、下载
```

手动启动两项服务（两个终端）：

```bash
# 终端 1：模拟站点（默认 http://127.0.0.1:4100）
npm run site

# 终端 2：采集服务（默认 http://127.0.0.1:4200）
npm run collector
```

```bash
# 启动一次采集（返回 202 并立即开始后台执行）
curl -s -X POST http://127.0.0.1:4200/api/collect \
  -H 'content-type: application/json' \
  -d '{"siteUrl":"http://127.0.0.1:4100"}'

# 查询进度
curl -s http://127.0.0.1:4200/api/progress

# 下载最近一次完整成果（JSONL）
curl -s -D - -o result.jsonl http://127.0.0.1:4200/api/download

# 校验每条记录
node -e 'require("fs").readFileSync("result.jsonl","utf8").trim().split("\n").forEach(l=>console.log(JSON.parse(l).reportNo))'
```

环境变量：站点 `SITE_PORT`、`SITE_HOST`、`SITE_LAYOUT=mixed|classic|compact`；采集器 `COLLECTOR_PORT`、`COLLECTOR_HOST`、`COLLECTOR_DATA_DIR`（默认 `data/collector`）、`SITE_URL`（默认 `http://127.0.0.1:4100`）。

## 模拟站点设计

### 页面与入口发现

| 路径 | 说明 |
| --- | --- |
| `GET /reports` | 报告目录。每行有报告编号、修订号、发布日期，链接到正文。这是唯一无需签名的入口，同时下发会话与签名材料。页面内嵌 `#assay-manifest` JSON，逐报告声明样本清单与每个样本的检测项。`?snapshot=snap-0001` 可重新进入历史快照。 |
| `GET /reports/:reportNo` | 报告正文（前 2 个样本），含编号、修订、发布日期与化验表。 |
| `GET /reports/:reportNo/appendix/:page?token=...` | 附表页（每页 1 个样本）。**后续入口只能从页面内容发现**：正文中的附表链接，附表页中的"下一附表"链接。 |

两种 HTML 布局（同一快照内可混合；`/__control/publish` 可整体切换）：

- `classic`：每个样本一行，检测项各占一列，表头形如 `Au / 金 (%)`；含量单元格只写数字，单位在表头。
- `compact`：每个检测项一行，样本号/深度/岩性写在首行，检测项列为 `Au` + `金`，结果列形如 `1.24 %` / `< 0.01 %` / `—`。

含量单位可以是**百分比**或 **mg/kg**（表头或单元格内给出，两种布局都支持）。低于检出限写作 `< 0.5`（"未检出"等写法也识别），缺测写作 `—`。有 2 样本的报告没有附表；5 样本的报告有 3 页附表。

**检测清单与每样本项目差异**：目录页的 `<script id="assay-manifest" type="application/json">` 是站点对快照内容的权威声明，结构为 `{snapshotId, reports:[{reportNo, revision, samples:[{sampleId, items:[{code,name}]}]}]}`。同一报告内不同样本的检测项可以不同（例如部分样本额外含 `Zn/锌`）；经典布局用"并列表头 + 未测单元格（`未测`，带 `data-untested`）"容纳差异，紧凑布局每个检测项单独一行，未承担该项目的样本直接不出该行。解析器会跳过未测单元格，清单核对则以 manifest 为准。

站点内部控制/演示接口（`POST`）：

- `POST /__control/publish` `{"reportNos":["R-0001"],"layout":"compact"}` → 新建快照并使当前修订 +1；`reportNos: []` 只切布局不改修订。
- `POST /__control/fault` → 注入确定性故障：
  - `{"type":"rateLimit","matchPath":"/reports/R-0004","retryAfterMs":40,"times":2}` HTTP 429 + `x-retry-after-ms`。
  - `{"type":"banSession","matchPath":"/reports/R-0002"}` 当前会话立即被封禁（403 `session_banned`）。
  - `{"type":"dropResponse","matchPath":"/appendix"}` 服务端**接受**请求（消耗 nonce 与翻页凭证）后、在写出响应前断开连接。
  - `{"type":"corruptReport","reportNo":"R-0003","times":1}` 返回 200 但正文不是有效报告（解析失败）。
  - `{"type":"unavailableReport","reportNo":"R-0004","times":1}` 该报告在快照中暂不可用（404）。
  - `{"type":"delay","matchPath":"/reports/R-0005","ms":250}` 延迟响应，便于观察进行中的状态。
- 语义内容缺陷（页面仍可解析，但与目录清单不符；manifest 始终声明完好内容）：
  - `{"type":"omitSample","reportNo":"R-0006","sampleId":"S-R-0006-05"}` 从正文/附表中抽掉一个样本行（缺行）。
  - `{"type":"omitItem","reportNo":"R-0006","sampleId":"...","itemCode":"Pb"}` 抽掉某样本的一个检测项（缺列/缺行）。
  - `{"type":"duplicateItem","reportNo":"...","sampleId":"...","itemCode":"Pb","sourceItemCode":"Au"}` 用重复项顶替声明项。
  - `{"type":"limitWithoutValue","reportNo":"...","sampleId":"...","itemCode":"Ag"}` 检出限只给单位、没有数值（如 `< mg/kg`）。
  - 缺陷按"页"确定性生效：目标样本不在当前页时不消耗次数，因此正文页不会提前花掉只作用于附表样本的缺陷；`times` 控制缺陷维持多少个报告渲染周期，`/__control/faults/clear` 可清除。
- `GET /__control/state`、`GET /__control/requests`（含每个请求的状态与会话/快照归属）、`POST /__control/faults/clear`。

### 动态签名（服务端真实校验）

1. `GET /reports` 无需签名，响应头下发：
   - `x-site-session: sess_…`（会话）
   - `x-site-nonce: …`（本会话一次性凭证初值）
   - `x-snapshot-id`、`x-site-alg`
2. 之后每个请求必须带三个头：
   ```
   x-site-session: <sessionId>
   x-site-nonce:   <nonce>
   x-site-signature: sha256(sessionId + "\n" + nonce + "\n" + METHOD + "\n" + target)
   ```
   其中 `target` 是路径 + 查询串（如 `/reports/R-0001/appendix/1?token=…`）。
3. 校验通过后服务端**立即轮换 nonce**，并在响应头返回新 nonce；旧 nonce 再用即 401 `bad_signature`。因此签名依赖"上一次成功响应提供的会话信息"，且请求不可重放、不可乱序。
4. 被拒绝的已认证请求（403 token 错误等）同样已经消耗 nonce，服务端会在响应头返回下一个 nonce，客户端必须采用。

### 一次性翻页凭证

正文中的附表链接形如 `/reports/R-0001/appendix/1?token=tok_…`。token 绑定 `会话 + 报告 + 页码`，只能使用一次：

- 重放 → `409 token_replayed`；
- 其他会话使用 → `403 bad_token`；
- 页码不匹配 → `403 bad_token`。

无论响应是否成功送达（包括被注入的断连），token 都视为已消耗——这正是"已接受翻页请求但响应送达前断开"的场景：客户端必须重新进入会话并从正文重新发现入口，才能拿到新 token。

## 采集服务设计

### HTTP 接口

| 方法/路径 | 说明 |
| --- | --- |
| `POST /api/collect` | body `{"siteUrl":"...","fresh"?:"boolean","snapshotId"?:"string"}`。返回 `202 {accepted, runId, snapshotId, expectedReports}`，后台开始采集。已有未完成运行时默认**续跑**；`fresh:true` 归档旧运行并开始新快照；`snapshotId` 可固定进入某个历史快照。 |
| `GET /api/progress` | `{progress, delivery, downloadUrl}`。`progress` 含 `state`（`idle/running/interrupted/failed/complete`）、`snapshotId`、`expectedReports`、`deliveredReports`、`pending`、`missing[]`、`failed[]`（含原因；清单核对失败还带 `discrepancies[]`，逐条点名 `sampleId/itemCode`）、`lastError`、`resumedFrom`；`delivery` 是当前可下载的上一份完整成果（没有则为 `{available:false}`）。 |
| `GET /api/download` | 返回最近一次**完整**交付的 JSONL（`application/x-ndjson`），响应头含 `x-snapshot-id`、`x-delivery-reports`、`x-delivery-sha256`。首次完整交付前返回 `404 {"error":"no_delivery"}`。 |
| `GET /api/health` | 健康检查。 |

### 快照一致性

- 一次运行开始时从目录读取 `snapshotId`、报告清单与每个报告的修订，随后会话被永久绑定到该快照（服务端所有后续响应都带 `x-snapshot-id`）。站点在此期间发布新修订不影响本次运行：重新进入会话时采集器同样带 `?snapshot=<id>` 回到同一历史快照。
- 每个报告的所有页面（正文 + 全部附表）必须 `reportNo / revision / snapshotId` 一致，样本总数必须等于页面声明的数量；否则记为解析失败，不算交付。
- 布局变化（`classic` ↔ `compact`）不影响语义：解析器以页面内容和表头/单元格单位为依据，两种布局产出完全相同的样本/检测项/值。
- **清单核对（声明驱动）**：进入快照时读取目录 manifest，得到每份报告"应有哪些样本、每个样本应有哪些检测项"。合并完正文与附表后逐项核对，产出结构化差异（`DeclarationDiscrepancy`）：
  - `sample_missing` / `sample_unexpected`：样本行缺失或多出；
  - `item_missing`：某样本缺声明的检测项（缺列/缺行）；随样本一起丢失的检测项会逐一点名；
  - `item_duplicated`：同一检测项在一个样本里出现多次（重复项顶替）；
  - `extra_item`：出现 manifest 未声明的检测项；
  - `limit_without_value`：低于检出限但检出限没有数值。
  - 每条差异都带 `reportNo / sampleId / itemCode`，进度 `failed[].discrepancies` 与 `lastError` 直接点名样本和检测项。明确标记为缺测（`kind: "missing"`，如 `—`）的结果是有效数据，不计为差异。

### 落盘与恢复

```
<dataDir>/
  state.json                     # 当前运行的进度（原子写）
  runs/<runId>.json              # 被新运行取代的旧运行归档
  snapshots/<snapshotId>/reports/<reportNo>.json   # 每个完整报告一个文件
  deliveries/delivery-<snap>-<time>-<rand>.jsonl    # 不可变的交付文件
  current-delivery.json          # 指向最近一次完整交付（原子替换）
```

- 报告写盘使用临时文件 + `fsync` + `rename`，因此只会出现"完整报告"或"没有"。
- 续跑时**只凭站点目录清单核验缓存**：对每个快照/修订，先读目录 manifest，再用它核对磁盘上的报告文件（样本、每样本检测项、检出限数值）。清单完全通过的报告直接标记为已交付，**不再请求正文或附表**；缓存文件缺失或核对不过的报告重新走"正文 → 附表"采集。这也覆盖了"写完报告但状态未落盘即被杀"以及"缓存被旧内容顶替"的窗口。
- 只有当本次运行的全部报告都成功时才生成交付并原子替换 `current-delivery.json`；失败运行不触碰上一份交付，进度为 `failed` 并逐条说明缺失/失败原因（含样本与检测项点名）。
- 收集期间下载接口读取"指针 → 不可变文件"，始终返回上一份完整成果；如果读取瞬间发生替换，会以新指针重读。

### 失败与恢复策略

- 429：按 `x-retry-after-ms` 等待后重试（nonce 未被消耗）。
- 401 / 会话被封禁：重新 `GET /reports?snapshot=<固定快照>` 建立新会话，从该报告的**正文**重新开始，以便取得新的翻页凭证。
- 连接被断开（response dropped）：nonce 与 token 已消耗，丢弃当前会话并重新进入同一快照，重取该报告。
- 404（报告不可用）→ 记为 `missing`；HTML 无法解析/结构校验失败 → 记为 `failed`。两者都会让本次运行以 `failed` 结束，不发布交付，但其余成功报告已在磁盘上，下次续跑只需补齐缺失项。
- 进程被 `SIGKILL`：`state.json` 中留下的 `running` 在下次启动时被识别为 `interrupted`，`POST /api/collect` 默认续跑（`resumedFrom` 记录它从哪次运行恢复）。

## 输出格式（JSON Lines）

每行一个报告，关键字段：

```json
{
  "reportNo": "R-0001",
  "revision": 2,
  "snapshotId": "snap-0001",
  "layout": "classic",
  "title": "R-0001 岩芯化验报告（第 2 修订）",
  "publishedAt": "2026-05-10T08:30:00Z",
  "source": {
    "bodyUrl": "http://127.0.0.1:4100/reports/R-0001",
    "appendixUrls": ["http://127.0.0.1:4100/reports/R-0001/appendix/1?token=…", "…/appendix/2?token=…"]
  },
  "samples": [
    {
      "sampleId": "S-R-0001-02",
      "fromM": "4.9",
      "toM": "6.1",
      "lithology": "粉砂岩",
      "sourceUrl": "http://127.0.0.1:4100/reports/R-0001",
      "items": [
        {
          "code": "Au", "name": "金",
          "measurement": {
            "kind": "value",
            "rawText": "1.52", "rawValue": "1.52", "rawUnit": "pct",
            "mgPerKg": 15200, "mgPerKgExact": "15200",
            "detectionLimitMgPerKg": null, "detectionLimitRaw": null, "detectionLimitUnit": null
          }
        },
        {
          "code": "Ag", "name": "银",
          "measurement": {
            "kind": "below_detection_limit",
            "rawText": "< 0.5", "rawValue": null, "rawUnit": null,
            "mgPerKg": null, "mgPerKgExact": null,
            "detectionLimitMgPerKg": 0.5, "detectionLimitRaw": "0.5", "detectionLimitUnit": "mg/kg"
          }
        },
        {
          "code": "Pb", "name": "铅",
          "measurement": {
            "kind": "missing",
            "rawText": "—", "rawValue": null, "rawUnit": null,
            "mgPerKg": null, "mgPerKgExact": null,
            "detectionLimitMgPerKg": null, "detectionLimitRaw": null, "detectionLimitUnit": null
          }
        }
      ]
    }
  ],
  "collectedAt": "2026-11-18T02:48:03.400Z"
}
```

- `kind` 明确区分 `value` / `below_detection_limit` / `missing`，三者互不折叠。
- `mgPerKg` 是统一单位后的数值；`mgPerKgExact` 是精确十进制字符串（百分比 ×10000 用整数运算，避免浮点误差）。`rawValue` / `rawUnit` 保留发布时的精确表示。
- 低于检出限通常给出 `detectionLimitMgPerKg` 与原始检出限；若发布的检出限没有数值（如 `< mg/kg`），三个检出限字段为 `null` 并由清单核对记为 `limit_without_value`；缺测三项皆为 `null`。
- `source` 记录正文与每个附表页的实际 URL（含一次性 token），每个样本的 `sourceUrl` 标明它发布在正文还是哪一页附表上。

## 自动化测试

`npm test` 使用 Node 内置测试运行器，**全部通过真实本地 HTTP**（随机端口）执行，串行运行以保证确定性：

| 场景 | 覆盖点 |
| --- | --- |
| 正常采集 | 首次下载 404；一次采集完整快照；两种布局；跨页附表（含无附表与 3 页附表）；百分比/mg/kg 精确换算；低于检出限与缺测可区分；交付哈希与报告数。 |
| 清单核对 | 目录 manifest 逐报告声明样本与每样本检测项（同报告内项目可不同，如部分样本含 `Zn`）；两种布局下交付记录逐项等于清单；明确缺测（`—`）不算差异。 |
| 内容缺陷 | 缺样本行、附表页缺检测列、紧凑布局重复项顶替、检出限无数值四类缺陷都让运行 `failed`，且 `failed[].discrepancies` 与 `lastError` 点名报告/样本/检测项；一次性缺陷解除后续跑成功。 |
| 旧缓存续跑 | 完好缓存只凭目录清单核验、不请求正文/附表（按请求日志断言只有 index 请求）；篡改缓存文件后只有该报告重采；持久缺陷期间保留上一份交付，缺陷清除后续跑发布新交付。 |
| 签名/凭证校验 | 无签名 401；nonce 一次性（旧 nonce 重放 401）；翻页 token 重放 409；跨会话使用 token 403；附表入口确实从页面内容发现。 |
| 会话恢复 | 中途封禁会话 + 限流：自动重建会话、继续同一快照，最终 6/6 完整且无重复；断言新会话仍绑定原快照。 |
| 响应中断 | 附表响应在送达前断开：token 已消耗 → 重新进入正文取新 token，数据不缺不重。 |
| 解析失败/暂不可用 | 本次运行 `failed`，逐条列出 `failed`/`missing` 原因，不发布交付也不显示成功；故障解除后同一数据目录续跑成功。 |
| 快照隔离 | 采集中途发布新修订：本次成果完全来自旧快照；新会话可回到历史快照；`fresh` 运行切到新快照且只含新修订。下载始终返回上一份完整成果；失败运行不会覆盖它。 |
| 布局变化 | 同一内容在 `classic` 与 `compact` 下解析结果逐项相等。 |
| 进程重启 | 真实 `spawn` 采集器进程 → `SIGKILL` → 用同一数据目录重启 → 状态为 `interrupted` → 续跑完成；已落盘报告不再请求（按站点请求日志断言每份只取一次）；重启期间发布的新修订不混入；之后 `fresh` 运行进入新快照。 |

测试进程启动的子进程由 esbuild 一次性打包（`packages: external`，仅打包本仓库源码），避免 tsx 冷启动拖慢计时；打包产物写入 `.tmp/`，不影响其它测试。

## 目录结构

```
src/shared/     协议常量与签名算法、单位换算、公共类型（含清单声明与差异类型）
src/site/       模拟站点（内容生成、清单/两种布局渲染、语义内容缺陷、HTTP 服务与故障注入）
src/collector/  采集器（签名客户端、清单 manifest 解析、页面解析器、清单核对、快照运行器、原子存储、HTTP 服务）
scripts/demo.ts 可复现演示
test/           端到端测试与工具
```

## 说明与边界

- 会话、nonce、token 都保存在站点进程内存中，重启站点即丢失（演示用途）；采集数据在采集器数据目录中持久化。
- 采集器对站点每个请求都重新签名并携带最新 nonce；重试遵循上述恢复策略，不盲目重放旧签名。
- `SITE_LAYOUT` 只影响初始快照的布局策略；运行中可通过 `/__control/publish` 切换。
- 仅实现 GET 抓取与控制接口，不涉及登录、Cookie、JavaScript 执行或真实网络访问。
