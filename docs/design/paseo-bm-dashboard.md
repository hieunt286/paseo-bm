# paseo-bm — Dashboard điều phối (Technical Design)

| Trường | Giá trị |
|---|---|
| Status | **Active** — cổng `design-ready` PASS 2026-09-16 |
| Tài liệu sống | Từ 2026-09-25 tài liệu này được **sửa tại chỗ** và luôn tả hiện trạng; mỗi lần sửa thêm một dòng Revision History, git là vết kiểm tra. Các delta cũ đã gộp vào đây chỉ còn là hồ sơ lịch sử (bảng [Lịch sử](#lịch-sử)) |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Created | 2026-09-16 |
| Requirements source | [PRD Dashboard điều phối](../product/paseo-bm-dashboard-prd.md) (REQ-040 → REQ-069); REQ-059 (thẻ câu hỏi) nằm ở [PRD gốc](../product/paseo-bm-prd.md) |
| Design gốc | [paseo-bm — Technical Design](./paseo-bm.md) — tài liệu này **mở rộng** nó: thư mục cài đặt, vai trò, chỉ dẫn, fallback, slash command ở đó |
| Related ADRs | [ADR-007](../adr/ADR-007-dashboard-trace-store.md) (kho lưu vết) · [ADR-002](../adr/ADR-002-install-ownership-model.md) · [ADR-005](../adr/ADR-005-manager-as-agent.md) (vòng đời agent thuộc người dùng) · [ADR-006](../adr/ADR-006-role-registration.md) · [ADR-012](../adr/ADR-012-plugin-is-the-product.md) (plugin là toàn bộ sản phẩm; thiết lập máy trên Setup) |
| Môi trường tham chiếu | `@getpaseo/plugin` 0.8.0, `@getpaseo/client` 0.8.0, `@getpaseo/protocol` 0.8.0; Paseo CLI/daemon 0.8.0; Node ≥ 22. **(0.4.0)** Paseo ≥ 0.9.0 |

## 1. Phạm vi

**Tài liệu này sở hữu:**

- kho lưu vết (vị trí, bố cục, lược đồ, ghi, đọc, xoá, gán lại, đo dung lượng) và bộ thu thập bám hook vòng đời;
- cách dựng trace theo request, bộ đọc `BM-REPORT` / `BM-REVIEW` / `BM-QUESTIONS` / `BM-ANSWERS`, cách đo thời gian, suy ra trạng thái, đếm lỗi, suy ra bước feature-workflow, tính token và chi phí;
- bộ đọc `.beads/issues.jsonl` và các hành động giao việc từ màn Beads;
- mọi màn hình client của plugin: surface "Beads Manager" (Setup kể cả màn "Roles & models", Workspaces, Metric, Beads), tab "Beads" và nút header, thẻ chat, thẻ câu hỏi, thẻ sự cố dự phòng, pill câu đang chờ và pill dự phòng, panel "Beads in this chat" và "Beads agents";
- các RPC nuôi những thứ trên (§5) và mã lỗi của chúng.

**Không sở hữu** (ở [design gốc](./paseo-bm.md) hoặc delta còn sống của nó): nội dung `plugin/roles/*.md` (kể cả luật Worker viết `BM-QUESTIONS`, cách Manager chuyển câu trả lời, nhãn `bm.requestId`/`bm.batchId`); trình cài đặt và CLI (kể cả `--install-beads-tools`; **(0.4.0)** CLI chuyển đổi); bố cục thư mục cài đặt (**(0.4.0)** thư mục dữ liệu, `setup-state.json`); hợp đồng server, luật ghi và mã lỗi của thiết lập máy (`setup.ensure-roles`, `setup.grant-agent-tools`, `setup.install-skills`, `setup.cleanup`, trường `setup` của `setup.status` — design gốc §7.13); cách tạo agent và hook `agent.create`; `manager.ensure`, `agents.list`, `roles.describe`, `agents.stop-all`; hợp đồng server của cài đặt vai trò, model và fallback (`roles.settings`, `roles.options`, `roles.save-settings`, `roles.save-fallback`, `fallback.*`, luật phát hiện và xử lý sự cố); sổ câu hỏi–trả lời (qa-ledger); công cụ agent của plugin (ADR-010); hai slash command `/bm-worker-new` và `/bm-worker-stop-all`. Tài liệu này chỉ tả chỗ các phần đó hiện lên màn hình.

## 2. Kiến trúc

### 2.1 Module

```
plugin/
  index.client.tsx            đăng ký surface, sidebar, Command Center, settings screen,
                              2 timeline transformer + 1 renderer, 3 workspace panel,
                              nút header, composer pill
    client/launcher.tsx         surface "Beads Manager": chọn view, dải trạng thái, danh sách Workspaces
    client/setup-screen.tsx     màn Setup (màn chính của surface), ba tab, "Roles & models"
    client/dashboard.tsx        màn Metric       client/dashboard-actions.tsx  xoá / gán lại trace
    client/beads-screen.tsx     màn Beads (kanban, bộ lọc, chi tiết, hành động)
    client/beads-tab.tsx        panel workspace "Beads" với hai tab con
    client/beads-header-button.ts  nút "Beads" trên header workspace
    client/tree.tsx             panel "Beads agents"     client/agent-tree.ts   logic của nó
    client/chat-card.tsx        thẻ chat, thẻ câu hỏi, thẻ sự cố dự phòng (vẽ)   client/chat-cards.ts   logic thuần
    client/bead-chips.tsx       chip bead trên thẻ, khung chi tiết, panel "Beads in this chat"
    client/waiting-pills.tsx    composer pill           client/waiting-pills-model.ts
    client/answer-state.ts      trạng thái "đã trả lời" trong phiên app
    client/ui.tsx               view dùng chung, không hook
    client/*-model.ts, dashboard-view.ts, launch-manager.ts, slot.ts   logic thuần
    client/settings.tsx         màn cài đặt ngưỡng dung lượng
  index.server.ts
    server/collector.ts         hook turn_started / turn_ended → ghi lưu vết
    server/trace-store.ts       đọc/ghi/xoá/gán lại/đo kho; bộ kiểm đường dẫn; mutex
    server/install-home.ts      tìm thư mục cài đặt; hằng số UI_DIR_NAME = "ui"
    server/traces.ts            dựng trace, tách đoạn, trạng thái, đếm lỗi
    server/workflow-steps.ts    bước feature-workflow     server/cost.ts   token → chi phí
    server/beads-store.ts       đọc .beads/issues.jsonl   server/bead-work.ts   ai đang làm bead
    server/bead-actions.ts      beads.list/get/action     server/shell.ts   đọc lệnh br
    server/dashboard-rpc.ts     RPC của Metric, Beads, Workspaces
    server/chat-rpc.ts          chat.peers, chat.beads, beads.lookup
    server/chat-peers.ts        peersOfWorkspace, workspaceRecordsReader
    server/chat-waiting.ts      chat.waiting              server/answer-marks.ts  answers.mark(s)
    server/live-timeline.ts     readTimelinePages (dùng chung)
    server/setup-rpc.ts, setup-tools.ts, setup-skills.ts, role-extras.ts   màn Setup
    server/setup-roles.ts, setup-machine.ts, setup-state.ts, data-home.ts   (0.4.0) thiết lập máy, design gốc §5, §7.13
  shared/contracts.ts           hợp đồng Zod của mọi RPC
  shared/bm-report.ts           bộ đọc BM-REPORT/BM-REVIEW (server/bm-report.ts chỉ re-export)
  shared/bm-questions.ts        bộ đọc/soạn BM-QUESTIONS/BM-ANSWERS
  shared/bead-ids.ts, sole-worker.ts, order.ts, prices.ts, settings.ts
```

Khuôn chung: mọi quyết định nằm trong module thuần (không React, không React Native), test được không cần renderer; `.tsx` chỉ nối và vẽ. Module server nhận một cửa sổ hẹp, tiêm được, của `PaseoApi` và của hệ thống file.

### 2.2 Ba quyết định nền

1. **Thu thập theo sự kiện, đọc bù khi mở.** Bộ thu thập bám `on("agent.turn_ended")` (và `turn_started` để lấy mốc bắt đầu) của agent `bm-*`, ghi ngay vào kho. Đây là hook sự kiện, không phải cron, watcher hay vòng lặp nền. Lượt **đang chạy** được đọc bù từ timeline khi người dùng mở màn hình.
2. **Lưu vết bền, người dùng xoá được** (ADR-007). Vòng đời agent thuộc người dùng (ADR-005): nếu chỉ dẫn xuất lúc đọc thì xoá một Worker là mất lịch sử. Cái giá (ghi hội thoại lên đĩa) được trả bằng: che bí mật trước khi ghi, quyền `0600`, và một đường xoá tường minh.
3. **Không chắc thì nói không rõ.** Mỗi con số suy luận kèm một độ chắc chắn (`exact` / `inferred` / `unknown`) hiện ra giao diện.

### 2.3 Luồng dữ liệu

```
AGENT CHẠY
  hook turn_started(bm-*)  → ghi mốc bắt đầu lượt (trong bộ nhớ)
  hook turn_ended(bm-*)    → timeline.refetch lấy timestamp → che bí mật → nối một dòng vào
                             <install home>/traces/<workspaceId>/events-<YYYYMM>.jsonl

NGƯỜI DÙNG MỞ MÀN HÌNH
  traces.list / traces.get      kho lưu vết + agents.list (+ đọc bù timeline cho lượt đang chạy)
  beads.list / beads.stats      <workspace>/.beads/issues.jsonl (cache mtime+size)
  chat.peers / chat.waiting     agents.list + timeline Manager + kho lưu vết khi thiếu nhãn
```

`traces.list` không đọc timeline khi mọi trace của trang đã xong trong kho — điều giữ D-1 (≤ 3 giây) khi kho lớn.

### 2.4 Luật chung cho client

- Chỉ primitive React Native; mọi màu lấy từ theme qua `toneColor(theme, tone)`, `Tone = "muted" | "plain" | "info" | "warning" | "danger" | "success"` (`plain` = `foreground`, `muted` = `foregroundMuted`, `info` = `accent`, ba tone còn lại là `status*`). Không mã màu viết cứng, không ghép kênh alpha vào chuỗi màu: tô nhạt làm bằng một `View` phủ tuyệt đối với `opacity`.
- Chữ giao diện bằng tiếng Anh; mọi thứ bấm được có nhãn trợ năng; dùng được ở `layout.compact` (padding 12 thay 24).
- Phần vẽ dùng chung là **view không hook** trong `ui.tsx` (`WorkspaceScreenHeader`, `BeadRowCard`, `StatusTabs`, `KanbanBoard`, `StatCards`, `BarChart`, `Chip`, `RoleMark`, `RoleLegend`), để `test/helpers/element-tree.ts` dựng được cây mà không cần renderer.
- Trạng thái sống qua việc gỡ component nhưng không qua lần tải lại app thì nằm ở module, đọc bằng `useSyncExternalStore`: `createSlot<T>()` (`slot.ts`), `createSessionToggle`, `createSessionMap` (`beads-model.ts`), `answer-state.ts`. Trạng thái phải qua được lần tải lại thì nằm ở server, trong `<install home>` (**(0.4.0)** thư mục dữ liệu, design gốc §5.1).
- Không polling ngầm, trừ các nhịp có chủ ý: danh sách Workspaces 10 s (chỉ khi đang hiện), `chat.waiting` 15 s, nút header 15 s, panel "Beads in this chat" 15 s, panel "Beads agents" 5 s, thẻ sự cố dự phòng 15 s (chỉ khi sự cố `pending`/`waiting`).

## 3. Kho lưu vết

### 3.1 Tìm thư mục cài đặt

Bundle server không có cwd và không đọc được `import.meta.url`, lại phải chịu được `--home` / `PASEO_BM_HOME`. Thứ tự hôm nay, dừng ở bước đầu thành công:

1. `paseo.config.get()` → `config.plugins["paseo-bm"]` là `{ source: "directory", path }` với `path` = `<install home>/plugin/<version>`, nên `<install home>` = `dirname(dirname(path))`.
2. Xác nhận bằng `<install home>/install.json` đọc được `schemaVersion`. Không khớp → bước 3.
3. Dự phòng `~/.paseo-bm`. Vẫn không có `install.json` → lưu vết **tắt** kèm thông báo; phần đọc beads vẫn chạy.

`install.json` chỉ được đọc, không bao giờ ghi.

**(0.4.0)** Thay bằng `resolveDataHome()` của design gốc §5.1: `PASEO_BM_HOME` → con trỏ `~/.paseo-bm/home.json` → `~/.paseo-bm`; plugin **tự tạo** thư mục (`0700`) ở lần ghi đầu và không còn đọc `install.json`. Lưu vết chỉ tắt khi `resolveDataHome` trả `home: null` (thư mục không an toàn, con trỏ hỏng); lý do hiện ở thông báo của Metric như hôm nay và ở khối "This install" của Setup (§11.3). Mọi đường dẫn `<install home>` trong tài liệu này từ 0.4.0 đọc là `<thư mục dữ liệu>`.

### 3.2 Bố cục

```
<install home>/traces/                     0700
  meta.json                                0600   { schemaVersion, createdAt, updatedAt }
  <workspaceId>/                           0700
    meta.json                              0600   { lastKnownName, lastKnownDirectory, lastSeenAt }
    events-202609.jsonl                    0600   nối thêm, một bản ghi một dòng
<install home>/ui/                         0700   trạng thái giao diện phải qua được lần tải lại
  answer-marks.json                        0600   (§15.6)
<install home>/role-extras.json            0600   (§11.3)
```

- Tách theo `workspaceId`: xoá theo workspace là xoá một thư mục, gán lại là di chuyển một thư mục. Tách theo tháng: xoá theo mốc phần lớn là xoá cả file.
- `meta.json` của workspace là thứ duy nhất giúp nhận ra một workspace không còn trong Paseo (REQ-057a); bộ thu thập cập nhật nó khi giá trị đổi.
- `schemaVersion` = `TRACE_STORE_SCHEMA_VERSION` = 1. Kho có bản cao hơn → đọc hạn chế, thông báo, **không ghi** (`E_TRACE_STORE_SCHEMA_TOO_NEW`). Bản ghi mới chỉ được **thêm** trường tuỳ chọn; không di trú.
- `ui/launcher-order.json` có thể còn trên máy từ tính năng ghim đã bỏ: không đọc, không ghi, không xoá.

### 3.3 Bản ghi (`traceRecordSchema`)

```
{ v: 1, kind: "turn", at, workspaceId, agentId, role, turnId | null,
  requestId | null, parentAgentId | null, agentCreatedAt | null,
  startedAt | null, endedAt, outcome: "completed" | "failed" | "canceled",
  sent:     [traceMessage],   // tin đến của lượt, đã cắt và che
  received: [traceMessage],   // assistant_message của lượt, đã cắt và che
  reports:  [parsedReport],   reviews: [parsedReview],
  evidence: [evidence],       // lệnh shell, file đã ghi, sub_agent, skill đã load
  usage:    usage | null,
  runtime?: { model, thinkingOptionId, modeId, provider? } | null }

traceMessage = { agentId | null, at, text, truncated, origin?: "user" | "agent" }
```

- **`origin`**: `user` khi tin mang `clientMessageId` (người dùng gõ trong app), `agent` khi một agent gửi bằng `send_agent_prompt`. Bản ghi cũ không có trường này **không bao giờ** được coi là lời người dùng.
- **`runtime`**: thứ agent thật sự chạy ở lượt đó, lấy từ snapshot của `timeline.refetch` — `runtimeInfo` trước, trường cấu hình (`model`, `effectiveThinkingOptionId` → `thinkingOptionId`, `currentModeId`) chỉ để dự phòng; `null` khi không đọc được snapshot. `provider` (thêm bởi delta fallback 20260921) để định giá model không có trong bảng giá. `usage.model` giữ nguồn cũ.
- **Bằng chứng `skill`**: Claude Code load skill là `tool_call` tên `Skill` với `detail.label` = tên skill; provider khác thì đọc `<skill>/SKILL.md` (suy luận); `ls`/`test -f` không tính.
- **Thời điểm tin nhắn có thể là giờ lúc ghi.** Tin chỉ mang giờ của timeline khi `timeline.refetch` thành công; khi lỗi (agent đã lưu trữ là ca hiển nhiên) cả bản ghi đóng dấu `now()`. Không mã nào được coi thời điểm tin trong bản ghi là giờ thật, hay dùng nó làm khoá.

Quy tắc ghi:

- **Nối thêm, không sửa.** Một lượt một dòng. Sửa duy nhất là xoá (§3.5).
- **Chống trùng** (`dedupeRecords`) theo `(agentId, turnId, vân tay nội dung lượt)`, giữ dòng có `at` muộn nhất. Vân tay = 16 ký tự hex đầu của sha1 trên chữ của `sent` rồi `received`, theo thứ tự; bản ghi không có tin nào dùng khoá `(agentId, turnId)`. Lý do: hook có thể chạy lại sau reload (cùng nội dung → cùng khoá), còn Paseo **dùng lại turn id trong cùng một agent** cho lượt khác (khác nội dung → giữ cả hai). Rủi ro chấp nhận: lần ghi lại rơi vào đường dự phòng và cắt ra tập tin hơi khác thì thừa một dòng, không mất dữ liệu. `messageId` của timeline đúng bản chất hơn nhưng `traceMessage` không lưu nó (thêm vào là đổi lược đồ kho), nên dùng vân tay chữ; các chữ ghép có tiền tố độ dài (`<len>:<text>`) để hai tin không tách lại thành cặp khác. Bản ghi `turnId: null` không có khoá nên luôn được giữ hết.
- **Ghi an toàn:** đường dẫn qua bộ kiểm §3.8; mở `O_APPEND | O_NOFOLLOW`, một `write` cho một dòng kết thúc bằng `\n`, rồi `fsync`; mọi thao tác sửa kho lấy mutex §3.8. Ghi lỗi (hết đĩa, quyền, lược đồ mới hơn) → bỏ qua, log một dòng, **không bao giờ** ném ra ngoài hook.
- **Trần độ dài:** 8 KB cho một tin, 32 KB cho một bản ghi; phần cắt có hậu tố `…[truncated]`.

### 3.4 Đọc

`traces.list` đọc file của workspace từ mới tới cũ (theo tên tháng), dựng trace theo §6, dừng khi đủ `limit`. `traces.get` đọc mọi dòng thuộc trace rồi bổ sung trạng thái hiện tại của từng agent (`agents.list`) và lượt đang chạy (đọc bù timeline trong cửa sổ `activeTurn.startedAt → nay`). Cache theo `(workspaceId, file, mtimeMs, size)`.

### 3.5 Xoá (`traces.delete`)

| Phạm vi | Cách làm |
|---|---|
| `{ traceId }` | Viết lại các file tháng liên quan, bỏ mọi dòng của trace (file tạm → `fsync` → `rename`) |
| `{ before: ISO }` | Xoá file tháng nằm hoàn toàn trước mốc; viết lại đúng một file chứa mốc |
| `{ allOfWorkspace: true }` | Xoá thư mục `<traces>/<workspaceId>` |

- Giao diện luôn gọi `dryRun: true` trước (trả `{ traces, bytes, running }`) rồi hỏi xác nhận, mặc định "Không". `running` là số request trong phạm vi còn agent `running`; > 0 thì cảnh báo rằng các lượt sau sẽ thành một trace mới.
- Đi qua bộ kiểm §3.8; không đạt → `E_TRACE_STORE_UNWRITABLE`, không xoá gì. Không chạm beads, tài liệu, agent, hội thoại Paseo, `install.json`, `config.json` hay bất cứ gì ngoài `<install home>/traces`.
- Dòng không đọc được được **giữ nguyên** khi viết lại: không xoá dữ liệu mình không hiểu.

### 3.6 Dung lượng

`store = { bytes, workspaceBytes }` trả kèm `traces.list`, `traces.delete`, `traces.reassign`, tính bằng `stat` — không đọc nội dung, nên không có số trace.

Ngưỡng cảnh báo ở **client**: server trả byte thô, client đọc ngưỡng bằng `useSettings(...)`. Lý do: `registerSettings` ở server chỉ khai báo lược đồ; ba RPC read/write/reset do Paseo quản lý dành cho client. Cài đặt (`shared/settings.ts`): `defineSettings({ id: "paseo-bm", scope: "host", version: 1, schema: z.object({ warnAboveBytes: z.number().int().positive().default(200 * 1024 * 1024) }) })`. Paseo chỉ có `scope: "host"`, nên ngưỡng là một giá trị cho cả máy và màn cài đặt nói rõ (`HOST_SCOPE_NOTICE`). Giá trị sai bị Zod chặn, Paseo trả `invalid`, ngưỡng cũ giữ nguyên. **Không tự xoá, không tự nén, không xoay vòng.**

### 3.7 Workspace không còn, và gán lại

| Tình trạng | Điều kiện |
|---|---|
| `live` | có trong `paseo.workspaces.list()`, `archivingAt` rỗng |
| `archived` | có trong danh sách, `archivingAt` khác rỗng |
| `orphaned` | không có trong danh sách |
| `unknown` | `workspaces.list()` lỗi — một lần gọi lỗi không bao giờ thành kết luận "không còn" |

**Gán lại** (`traces.reassign`), chỉ do người dùng khởi động:

1. `to` phải đang có trong `workspaces.list()` và khác `from`; sai → `E_TRACE_REASSIGN_INVALID`, không chạm gì.
2. `dryRun: true` trả `{ traces, bytes }` để hỏi xác nhận.
3. Đích chưa có thư mục → `rename` cả thư mục.
4. Đích đã có → gộp từng file tháng bằng cùng `dedupeRecords`, file tạm → `fsync` → `rename`, rồi xoá file nguồn; dòng không đọc được được giữ. Toàn bộ nằm trong mutex §3.8; bị ngắt thì tệ nhất còn cả hai bản, và bộ đọc loại trùng nên không nhân đôi.
5. `meta.json` của đích giữ giá trị của đích.

Gán lại không sửa `workspaceId` trong bản ghi (sự thật lịch sử); thư mục quyết định trace thuộc đâu, và `TraceSummary.reassignedFrom` báo khi hai giá trị khác nhau.

### 3.8 Bộ kiểm đường dẫn và tuần tự hoá

Dùng chung cho mọi thao tác ghi, xoá, gán lại, và nằm trong đúng `server/trace-store.ts`; không module nào tự dựng đường dẫn vào kho. Thất bại ở bất kỳ bước nào → `E_TRACE_STORE_UNWRITABLE`, không chạm đĩa:

1. `workspaceId` khớp `^[A-Za-z0-9._-]{1,128}$` và không phải `.` hay `..`.
2. Đường dẫn sau `resolve` nằm trong `<install home>/traces`.
3. `lstat` **từng thành phần** từ `<install home>` xuống file đích; symlink ở bất kỳ cấp nào bị từ chối (kiểm tiền tố chuỗi không đủ).
4. File đích mở với `O_NOFOLLOW`; file tạm `O_CREAT | O_EXCL | O_NOFOLLOW`, trong cùng thư mục với file nó thay.

File trong `<install home>/ui/` dùng cùng khuôn (`assertNoSymlinkOnPath`, `writeStoreFileAtomically`).

**Tuần tự hoá:** bộ thu thập và mọi handler chạy trong cùng tiến trình plugin, nên dùng một **mutex bất đồng bộ trong tiến trình, khoá theo `workspaceId`** cho mọi thao tác sửa kho. Đọc không lấy khoá; dòng cuối ghi dở bị bỏ qua và tính vào `skippedLines`. Bộ thu thập gặp khoá thì chờ, quá 5 giây thì bỏ lượt và log một dòng. Tiến trình khác duy nhất có thể ghi kho là CLI lúc gỡ; lệnh gỡ chạy `paseo plugin remove` **trước** khi chạm `traces/`.

## 4. Data model

Mọi hợp đồng ở `plugin/shared/contracts.ts` bằng Zod; `shared/` không import Node hay React Native. Trường thêm sau luôn là tuỳ chọn để payload cũ vẫn parse (client và server ship cùng bundle, nhưng hai chiều vẫn phải đọc được).

### 4.1 Kiểu dùng chung

```ts
confidence = "exact" | "inferred" | "unknown"
evidence   = { kind: "report" | "shell" | "file" | "agent" | "timeline" | "skill",
               detail: string, agentId: string | null, at: string | null }
usage      = { inputTokens, cachedInputTokens, outputTokens, costUsd: number | null,
               costBasis: "provider" | "estimated" | "unavailable",
               model: string | null, pricesUpdatedAt: string | null }
traceState = "running" | "waiting_user" | "completed" | "stopped" | "failed" | "unknown"
tier       = "Small" | "Medium" | "Large"
```

`costBasis: "provider"` còn trong lược đồ nhưng server không bao giờ đặt nó (§9).

### 4.2 `TraceSummary` (một dòng của danh sách)

| Trường | Ngữ nghĩa |
|---|---|
| `traceId` | `req:<requestId>` khi biết request; ngược lại `<managerAgentId>:<seq>`. Bền trong kho |
| `requestId` | `req-<YYYYMMDDTHHMMSSZ>` do Manager sinh, hoặc `null` |
| `requestedAt`, `excerpt` | Thời điểm và một dòng đầu của lời hỏi (đã cắt, đã che); `excerpt: null` khi chưa ghi được lời hỏi |
| `turn` | `{ index, total }` khi request có nhiều lượt người dùng hỏi (§6.2); `null` khi chỉ một |
| `state` | §7.3 |
| `workerIds`, `reviewerIds` | Agent gán vào trace |
| `reviewCalls` | Số **lượt** gọi review quan sát được (khác số agent Reviewer) |
| `guardrailReported` | Bộ đếm Worker tự báo, nguyên văn |
| `durationMs` | `null` khi đang chạy hoặc không đo được |
| `usage` | Tổng của mọi agent |
| `messageCount`, `userMessageCount` | Tin gửi và nhận; tin người dùng gõ thẳng cho một agent của request |
| `workerUsage` | `[{ agentId, title, usage }]` — cho biểu đồ Worker tốn token nhất |
| `usageByModelRole?` | `[{ role, model, usage }]` theo model hiệu lực — cho biểu đồ model × vai trò |
| `errors?` | §7.4 |
| `beadCounts` | `{ created, updated, closed, ready }`, mỗi số `{ count, confidence }` |
| `tier`, `linking` | Mức Worker tự phân loại; độ chắc của việc nhóm |
| `agentsMissing` | Agent có trong lưu vết nhưng không còn trên máy |
| `workspaceState`, `reassignedFrom` | §3.7 |
| `notices` | "dữ liệu có thể thiếu", "kho lưu vết tắt", … |

### 4.3 `TraceDetail` = `TraceSummary` + …

```
sent:     { userRequest, workerInitialPrompts[], reviewRequests[] (+ batchId) }
received: { reports[], reviews[], managerReplies[] }
timing:   { totalMs | null, managerTurns[], workers[], reviewers[], basis }
usageByAgent: [{ agentId, role, usage, runtime?: [{ model, thinkingOptionId, modeId, recorded, turns }] }]
usageByModel?: [{ model | null, usage }]
beads:    [{ id, title | null, statusNow | null, action: created|updated|closed|ready, confidence, evidence[] }]
workflowSteps: [{ step, status: done|skipped|unknown, confidence, evidence[], note | null }]  // luôn đủ 12 bước
subAgentTraces: [{ agentId, subAgentType | null, description | null, count }]
userMessages: [traceMessage]              // tin người dùng gõ thẳng cho agent của request
skills: [{ agentId, skill, at | null }]   // skill mỗi agent đã load
```

- `sent.userRequest` là đúng tin mà bước dựng lại đã chọn làm lời hỏi, không phải tin đầu của lượt Manager đầu (có thể là một `BM-REPORT`).
- `runtime` gộp các lượt của một agent thành một dòng cho mỗi tổ hợp `(model, thinkingOptionId, modeId, recorded)`, theo thứ tự gặp đầu. Lượt có `runtime` → `recorded: true`; lượt cũ chỉ có `usage.model` → thinking/mode `null`, `recorded: false` (giao diện: `not recorded`); `recorded: true` với `thinkingOptionId: null` là `provider default`.
- `usageByModel` cộng lại đúng bằng `usage` của trace.

### 4.4 Beads

```
BeadStats = { total, open, inProgress, blocked, closed, ready, readAt, source, skippedLines, present }
BeadRow   = { id, title | null, status, issueType, priority: 0..4 | null, labels[], createdAt, updatedAt,
              closedAt, ready, parentId | null, work: { started, last } | null }
BeadDetail = BeadRow + { description, closeReason, blockedBy[], children[] }
work mark = { agentId, at, title | null, status | null }   // status null: Paseo không còn liệt kê agent
```

`present: false` = workspace không có `.beads/issues.jsonl`: trạng thái rỗng, không phải lỗi.

## 5. Hợp đồng RPC

Tên RPC phải khớp `^[a-z][a-z0-9._-]*$` (SDK). Mọi RPC dưới đây chỉ đọc, trừ những dòng ghi rõ.

| RPC | Input → Output | Ghi chú |
|---|---|---|
| `traces.list` | `{ workspaceId, limit?, cursor? }` → `{ traces, nextCursor, truncated, store, notices }` | Mới nhất trước; `limit` trần `TRACE_LIST_LIMIT` = 50 |
| `traces.get` | `{ workspaceId, traceId }` → `{ trace: TraceDetail }` | Không dựng lại được → `E_TRACE_NOT_FOUND` |
| `traces.delete` | `{ workspaceId, scope, dryRun? }` → `{ deleted: { traces, bytes, running }, store }` | **Ghi** kho (§3.5); `scope` là đúng một trong ba dạng |
| `traces.reassign` | `{ fromWorkspaceId, toWorkspaceId, dryRun? }` → `{ moved: { traces, bytes }, store }` | **Ghi** kho (§3.7) |
| `traces.workspaces` | `{}` → `{ workspaces: [{ workspaceId, state, lastKnownName, lastKnownDirectory, lastSeenAt, bytes }] }` | Mọi workspace có lịch sử; lối vào lịch sử của workspace đã đóng |
| `beads.stats` | `{ workspaceId }` → `{ stats }` | §10 |
| `beads.list` | `{ workspaceId }` → `{ beads: BeadRow[], stats }` | §10 |
| `beads.get` | `{ workspaceId, id }` → `{ bead: BeadDetail }` | Id không có → `E_BEAD_NOT_FOUND` |
| `beads.action` | `{ workspaceId, id, action: implement\|delete\|close }` → `{ managerId, created }` | **Gửi** một yêu cầu cho Manager (§13.4) |
| `beads.lookup` | `{ workspaceId, ids (≤ 100) }` → `{ beads }` | Chỉ giữ id có thật trong kho |
| `workspaces.overview` | `{}` → `{ workspaces: [{ workspaceId, beads: { total, inProgress, blocked, ready } \| null, runningWorkers, runningAgents: { manager, worker, reviewer } }] }` | Mọi workspace chưa lưu trữ; `runningWorkers` = `runningAgents.worker`, giữ cho bản đọc cũ |
| `chat.peers` | `{ agentId }` → `{ owner, peers, workspaceId }` | §15.2 |
| `chat.beads` | `{ workspaceId, agentId }` → `{ beads: [{ bead, mentions, lastMentionedAt }], scannedItems }` | §15.7 |
| `chat.waiting` | `{}` → `{ waiting: WaitingWorker[], fallback: [{ managerId, workspaceId, incident }] }` | §15.5, §15.8; `fallback` = sự cố `pending` của Manager sống (luật server: design gốc §7.10) |
| `answers.marks` | `{}` → `{ keys, notices }` | §15.6 |
| `answers.mark` | `{ key (1–400 ký tự), marked }` → `{ keys, notices }` | **Ghi** `ui/answer-marks.json` |
| `setup.status` | `{}` → tools, skills, extras, … | §11.3; chỉ chạy `--version` |
| `setup.install-tool` | `{ tool: br\|bv, confirmed: true }` → `{ command, code, tail }` | **Chạy** trình cài; `confirmed` bắt buộc là `true` |
| `setup.ensure-roles` **(0.4.0)** | `{ resume? }` → `{ created, baseProvider, model, skipped }` | **Ghi** cấu hình Paseo khi thiếu vai trò; Setup gọi mỗi lần mở, trước `setup.status`. Hợp đồng: design gốc §7.13.2 |
| `setup.grant-agent-tools` **(0.4.0)** | `{ confirmed: true }` → `{ injectIntoAgents: true, changed }` | **Ghi** `daemon.mcp.injectIntoAgents`; design gốc §7.13.3 |
| `setup.install-skills` **(0.4.0)** | `{ confirmed: true }` → `{ command, code, tail, missingBefore, missingAfter }` | **Chạy** CLI `skills`; design gốc §7.13.4 |
| `setup.cleanup` **(0.4.0)** | `{ confirmed: true, deleteData }` → `{ removedProviders, removedProfiles, agentTools, data, nextCommand }` | **Xoá** mục `bm-*`, trả công tắc tool, tuỳ chọn xoá dữ liệu; design gốc §7.13.7 |
| `roles.instructions` | `{ role }` → `{ base, extra, full, path \| null, maxChars }` | §11.3 |
| `roles.save-extra` | `{ role, text }` → `{ extra, full }` | **Ghi** `role-extras.json` |

**Mã lỗi** (`DASHBOARD_ERROR_CODES`, ghi vào bộ mã chung của design gốc; lỗi ném dạng `Error` có `message` bắt đầu bằng mã, client đọc bằng `errorCodeOf`):

| Mã | Khi nào |
|---|---|
| `E_TIMELINE_UNAVAILABLE` | Paseo không trả được timeline của một agent |
| `E_BEADS_STORE_UNREADABLE` | `.beads/issues.jsonl` có nhưng không đọc được: quyền, vượt 32 MB, symlink ra ngoài workspace |
| `E_TRACE_NOT_FOUND` | `traceId` không còn trong kho |
| `E_TRACE_STORE_UNWRITABLE` | Không ghi/xoá được kho: quyền, hết đĩa, `workspaceId` sai, đường dẫn thoát ra ngoài |
| `E_TRACE_STORE_SCHEMA_TOO_NEW` | `meta.json` có `schemaVersion` cao hơn mức hiểu |
| `E_TRACE_REASSIGN_INVALID` | Gán lại vào workspace không tồn tại, hoặc `from` trùng `to` |
| `E_BEAD_NOT_FOUND` | Id bead không có trong kho |
| `E_ROLE_EXTRA_INVALID` | Chỉ dẫn thêm sai (vượt 8 000 ký tự) |
| `E_TOOL_PRESENT` | `setup.install-tool` cho công cụ đã có |
| `E_TOOL_INSTALL_FAILED` | Lệnh cài chạy lỗi |
| `E_SETUP_ROLES_FAILED` **(0.4.0)** | Không tạo được vai trò còn thiếu (không có provider/model dùng được, Paseo từ chối) |
| `E_SETUP_WRITE_FAILED` **(0.4.0)** | Paseo từ chối lần bật tool agent hay lần gỡ cấu hình |
| `E_SKILLS_PRESENT` **(0.4.0)** | `setup.install-skills` khi không thiếu skill nào |
| `E_SKILLS_INSTALL_FAILED` **(0.4.0)** | CLI `skills` lỗi hay quá 300 giây |
| `E_DATA_HOME_UNAVAILABLE` **(0.4.0)** | Thư mục dữ liệu không dùng được, hay không ghi được `setup-state.json` |

Các mã `E_ROLE_SETTINGS_*` và `E_FALLBACK_*` trong cùng danh sách thuộc các RPC ở design gốc (§7.3.6, §7.10); màn hình hiện chúng theo §11.3 và §15.8.

## 6. Dựng trace theo request

### 6.1 Nhóm

1. **Lấy agent.** `agents.list` mọi agent (`includeArchived: true`, trang 200); vai trò lấy từ nhãn `bm.role`, thiếu nhãn thì theo provider `bm-*` (`roleOfAgent`, `labelled: false`); lọc theo `agent.workspaceId`. Cây theo `parentAgentId`; parent không có trong tập thì node là gốc.
2. **Đọc kho** của workspace. Bucket **khoá theo `requestId`**, nên mọi lượt Manager của một request là một trace. Trace mở ra từ lượt Manager có tin đến không phải `BM-REPORT`, **hoặc** lượt Manager đọc được `requestId` (khi đó lời hỏi `null` và dòng nói rõ là chưa ghi được — plugin chỉ thu từ lúc được nạp).
3. **Lượt Manager không nêu `requestId`** thuộc request mà **chính Manager đó** nêu ở lượt kế tiếp của nó; không có thì mở một dòng tạm. Phạm vi là một Manager, không phải cả workspace: báo cáo tiến độ của Worker tới Manager y như lời người dùng, nên lời của chính Manager ở lượt sau là bằng chứng; tìm trong cả workspace từng kéo lượt của một Manager đã lưu trữ vào request của Manager khác 18 giờ sau. Không thêm ngưỡng thời gian.
4. **Lấy `requestId`**, dừng ở nguồn đầu tiên có giá trị: nhãn `bm.requestId` của agent → `exact`; `requestId:` trong một `BM-REPORT` của trace → `exact`; dòng `requestId: req-…` trong prompt khởi tạo Worker → `exact`; id `req-…` viết trần mà tin gửi tới agent nhắc nhiều hơn mọi id khác cộng lại → `inferred` (Manager 0.1.0 viết id trần và không gắn nhãn; tin Worker cũng dẫn request khác); Worker có `agentCreatedAt` nằm trong lượt Manager của trace và chưa thuộc trace nào → `inferred`; không xếp được → nhóm "không rõ yêu cầu", `unknown`, **không** gán bừa vào trace gần nhất.
5. **Reviewer** theo `parentAgentId` = một Worker của trace (hoặc nhãn `bm.batchId`). Một báo cáo nêu request **khác** không bao giờ là bằng chứng của request này, dù nằm trong bản ghi nào (`reportsBelongingTo`); lời hỏi của request là tin người dùng **sớm nhất** trong các lượt đã gộp.
6. **Bản ghi của agent không còn trên máy** vẫn gắn vào trace theo `requestId` của chính nó; agent đó vào `agentsMissing` và dòng nói "không còn trên máy này" (xoá Worker thì `includeArchived` cũng không thấy nó).
7. **Hai loại số:** `reviewerIds.length` là số agent; `reviewCalls` đếm tin `sent` của Reviewer không phải `BM-REVIEW` và không phải thông báo STOP plugin gửi. Lệch với `guardrail` Worker tự báo thì hiện cả hai và đánh dấu.
8. **Tin người dùng** (`origin: "user"`) gửi cho Worker/Reviewer vào `userMessages` theo vai trò của agent nhận, kể cả khi agent đã bị xoá.

### 6.2 Tách đoạn theo lượt người dùng hỏi

Một request được tách thành **các đoạn** trên màn hình: mỗi lượt Manager mà tin đầu là lời người dùng thật (`origin === "user"`, không dựa câu chữ) mở một đoạn, và danh sách hiện một dòng cho mỗi đoạn với `turn: { index, total }` (`summariseSegments`). Các dòng của một request dùng chung `traceId`, nên khoá danh sách là `traceId#index`. `requestId`, cách Worker báo cáo và ngân sách review không đổi. Biểu đồ và số "request có lỗi" đếm **request** (dòng `index === 1` hoặc `turn: null`), không đếm dòng.

### 6.3 Bộ đọc `BM-REPORT` / `BM-REVIEW` (`shared/bm-report.ts`)

- Khoan dung: mọi khối bắt đầu bằng dòng `BM-REPORT` (có hay không có rào ```), đọc từng dòng `khoá: giá trị`, khoá không phân biệt hoa thường, khoá lạ vào `unparsedFields`, khoá thiếu `null`; `none` và chuỗi rỗng là "không có". Khối kết thúc ở dòng đầu tiên không có dạng `key: value` — nên một khối `BM-QUESTIONS` ngay sau không làm báo cáo đọc sai.
- `requestId` trong văn xuôi đọc dễ dãi với markdown (`REQUEST_ID_PATTERN`: "- `requestId`: `req-…`" vẫn khớp). Lượt Manager không mang `requestId` lấy nó từ tin trả lời của chính Manager (`managerRequestId`: Manager sinh id trong lượt mở request, nên tin đến chưa có), **không** từ lệnh `date -u +req-%Y%m%dT%H%M%SZ` (đó là chuỗi định dạng).
- Id bead tách theo dấu phẩy, chấm phẩy hoặc khoảng trắng, lọc theo dạng id; nhóm `( … )` chỉ chứa id thì mở ra, nhóm khác là chú thích và bị bỏ cả nhóm (`(b2 fix: no-logging AC)` không sinh bead `no-logging`). Dạng rút gọn `.N` (`.2`, `.2.1`) mở theo gốc của id đầy đủ gần nhất đứng trước (`x-gcj, x-gcj.1, .2` → `x-gcj.2`); rút gọn không có id đứng trước bị bỏ và làm danh sách không trọn. Cắt ở trần thì bỏ luôn mảnh bị cắt ngang (`…60a.435` cắt thành `…60a.4` là bead khác); trường danh sách chặn ở `MAX_LIST_CHARS` = 8 000 ký tự; danh sách đọc không trọn vào `incompleteFields` (số đếm là cận dưới, suy luận).
- Loại trùng theo `(agentId, phase, requestId, at)`. Khối có giá trị dạng mẫu (`a | b`, như `verdict: approved | changes-required`) là tin thường, không phải báo cáo.
- `BM-REVIEW`: `batchId`, `verdict`, `blockingCount` đếm từ dòng `- severity: blocking`.
- "Báo cáo mới nhất" luôn là mới nhất **theo thời gian**, không phải phần tử cuối mảng.

### 6.4 Id bead trong lệnh `br` (`server/shell.ts`)

Chỉ lấy ở **tham số vị trí**: phần trước cờ đầu tiên, sau khi làm trắng phần trong dấu nháy. `br create` không nêu id nào (`br` tự sinh), `--help`/`--dry-run` không phải hành động, `br close` trong chuỗi trích dẫn không phải đóng bead. Đếm bead và bảng bước quy trình dùng chung module này. Quét cả dòng lệnh từng đọc `-l "feature:format-date"` và chữ trong `-r "…"` thành id bead. **Đếm bead** (`beadCounts`): `created`/`updated`/`closed` là hợp của mọi báo cáo (theo thời gian) và lệnh `br create`/`update`/`close`; `ready` là **trạng thái**, không phải hành động, nên chỉ lấy từ báo cáo **mới nhất** (báo cáo `beads-done` cũ nói 3 bead sẵn sàng không được thắng `finished` nói `beadsReady: none`). Có báo cáo → `exact`, danh sách đọc không trọn → `inferred`; chỉ có lệnh `br` → `inferred`; không có gì → `unknown`. Không lọc bằng cách tra kho `.beads`: bead vừa tạo có thể chưa vào kho, nên "không có trong kho" không đủ để loại; luật vị trí phân biệt ngay tại nguồn.

## 7. Thời gian, trạng thái và lỗi

### 7.1 Mốc đo (cố định, in ra giao diện)

| Số | Bắt đầu | Kết thúc |
|---|---|---|
| Tổng của request | `startedAt` của lượt Manager mở đầu | Muộn hơn giữa `endedAt` lượt Manager cuối và `at` của `BM-REPORT` `finished` |
| Một lượt | `startedAt` (hook `turn_started`) | `endedAt` (hook `turn_ended`) |
| Một Worker | `agentCreatedAt` | `at` của `BM-REPORT` `finished`; thiếu thì `endedAt` lượt cuối |
| Một Reviewer | `agentCreatedAt` | `at` của `BM-REVIEW` cuối; thiếu thì `endedAt` lượt cuối |

Lượt còn `activeTurn` → `ms = null`, hiện thời gian đã trôi, không hiện tổng. Đây là thời gian treo, gồm cả lúc chờ người dùng, và giao diện nói câu đó. Thiếu mốc → `null` kèm notice, không bao giờ 0.

### 7.2 Plugin reload giữa lượt

Mốc `turn_started` mất; bản ghi vẫn ghi với `startedAt` suy từ entry đầu của lượt kèm notice.

### 7.3 `state`

Dừng ở điều kiện khớp đầu tiên: có agent `running` → `running`; `BM-REPORT` mới nhất là `blocked` → `waiting_user`; có agent `error` hoặc lượt cuối `failed` → `failed`; `BM-REPORT` mới nhất là `finished` → `stopped` nếu `blockers` khác rỗng, còn lại `completed`; Worker tồn tại, không `running`, không có `finished` → `stopped`; còn lại `unknown`. Chỉ báo cáo cuối quyết định: một lượt `canceled` trước đó là quá khứ (một request bị ngắt bốn lần rồi làm xong vẫn là `completed`).

### 7.4 Đếm lỗi (`TraceSummary.errors`)

`state` là trạng thái **hiện tại**, nên một request lỗi rồi chạy lại xong đọc là Completed và số lần lỗi mất. `errors` giữ con số đó, cộng từ bản ghi đã có, không đổi bộ thu thập hay file trace:

```ts
traceErrorsSchema = z.object({
  failedTurns: nonneg,  // lượt của DÒNG NÀY kết thúc `failed`
  agentErrors: nonneg,  // Worker/Reviewer của request (không tính Manager) ở `error` mà KHÔNG có bản ghi lượt failed nào trong trace
  fallbacks:   nonneg,  // sự cố fallback của request có `signal: "completed"`
})
```

- Ba số **không chồng nhau**, nên cộng lại là số lần lỗi thật: một lần hết hạn mức ghi một lượt failed, để agent ở `error` và mở một sự cố fallback, và phải đọc là **một** lỗi. Sự cố `signal: "failed"` sinh từ đúng một lượt đã failed nên không tính lại; sự cố của Manager (`requestId` null) không thuộc request nào.
- `failedTurns` đếm theo từng đoạn (§6.2). `agentErrors` và `fallbacks` thuộc cả request: chỉ đặt ở dòng `index === 1`, lấy từ bản tóm tắt **cả trace** (đọc theo đoạn thì một Worker chết ở lượt sau bị đếm hai lần), các dòng sau để 0.
- Nguồn `fallbacks`: `SummariseDeps.fallbacksOf(requestId)`; `dashboard-rpc.ts` đọc `role-fallback-state.json` **một lần** (`incidentsIn`) cho cả `fallbackCountsOf(incidents, workspaceId)` lẫn việc nhận ra Reviewer thay thế. Mọi trạng thái sự cố đều tính.

## 8. Bước feature-workflow

Bảng luôn đủ 12 bước, đúng thứ tự: `classify_tier`, `prd`, `design`, `adr`, `plan`, `review_plan`, `convert_to_beads`, `polish_beads`, `implement`, `review_batches`, `build_and_tests`, `close_with_evidence`.

| Bước | `exact` | `inferred` |
|---|---|---|
| `classify_tier` | `tier:` trong `BM-REPORT` | — |
| `prd` / `design` / `adr` / `plan` | `filesChanged` dưới `docs/product/` / `docs/design/` / `docs/adr/` / `docs/plans/` | `write`/`edit` dưới thư mục đó (đường dẫn tuyệt đối đọc theo thư mục workspace) |
| `review_plan` | `skillsUsed` có `reviewing-plan` | Worker/Reviewer load skill `reviewing-plan` |
| `convert_to_beads` | `beadsCreated` không rỗng, `phase: beads-done`, hoặc `skillsUsed` có `converting-plan-to-beads` | load skill đó; hoặc `br create` |
| `polish_beads` | `skillsUsed` có `polishing-beads`; hoặc `guardrail` ghi `polish n/max` với `n ≥ 1` | load skill đó; hoặc `br update` chạm **≥ 2 bead khác nhau** trong một lượt (sửa nhiều lần cùng một bead là việc thường) |
| `implement` | `phase: bead-implemented`, hoặc `skillsUsed` có `implementing-beads` | `write`/`edit` ngoài `docs/` và `.beads/` trong workspace |
| `review_batches` | có Reviewer và có `BM-REVIEW` | có agent con `bm.role=reviewer` |
| `build_and_tests` | `buildAndTests` khác "not run" | `shell` chạy lệnh test/build của repo |
| `close_with_evidence` | `beadsClosed` không rỗng (ghi chú thêm "confirmed closed in the store" khi kho nói bead đã `closed`) | `shell` có `br close` |

**Phủ định chính xác** thắng mọi suy luận và cho `skipped` (`confidence: exact`) kèm câu làm ghi chú: mọi `guardrail` có đoạn polish đều ghi `polish 0` (guardrail không có đoạn polish không nói gì); báo cáo `finished` mới nhất liệt kê `skillsUsed` mà thiếu skill của bước (`review_plan`, `polish_beads`; `skillsUsed` đọc không trọn thì không chứng minh gì). Thiếu `converting-plan-to-beads` hay `implementing-beads` **không** bao giờ là phủ định. Mọi báo cáo `finished` ghi `beadsCreated` (hay `beadsClosed`) rỗng thì `br create` (hay `br close`) trong timeline không được tính là bằng chứng của `convert_to_beads` (hay `close_with_evidence`). `build_and_tests` suy luận chỉ khi lệnh test/build đứng **đầu** một đoạn lệnh (một `grep 'pytest'` không phải chạy test); `buildAndTests` dạng "not run / none / n/a / skipped / no" không phải bằng chứng.

**`skipped` theo mức:** khi `tier` đọc được, mọi mức (Small, Medium, Large) đều được bỏ `prd`, `design`, `adr`, `plan`, `review_plan`, `polish_beads` (`SKIPPABLE_BY_TIER`) — tài liệu đi theo thay đổi, không theo mức (REQ-022d). Mức Small còn được bỏ `convert_to_beads`, `review_batches`, `close_with_evidence`: thay đổi Small không có bead và không review trừ khi người dùng yêu cầu (REQ-022c, REQ-024c); có bằng chứng thì vẫn là `done`. `implement` và `build_and_tests` không bao giờ `skipped` theo mức. `skipped` theo mức mang `confidence: exact` và ghi chú nêu lý do (`skippedNote`). Không có bằng chứng và không được bỏ → `unknown` (không có `tier` thì ghi chú "no tier was reported, so nothing can be called skipped"): không có bằng chứng phủ định thì không kết luận phủ định.

## 9. Token và chi phí

1. **`lastUsage.totalCostUsd` không dùng được**: đó là tổng luỹ kế của phiên agent (đo trên 12 lượt Manager: chỉ tăng 0,3956 → … → 2,2712 trong khi token lên xuống). Bản ghi lượt không ghi nó; chi phí một request **luôn** là số tạm tính.
2. **Tạm tính** từ `shared/prices.ts` theo model: `inputTokens×in + cachedInputTokens×cacheRead + outputTokens×out` — token cache tính riêng theo đơn giá cache. → `costBasis: "estimated"`. Model không có trong bảng thì thử danh sách model của provider (`runtime.provider`; `metadata.cost` của `listModels`).
3. Không định giá được → `costUsd: null`, `costBasis: "unavailable"`, giao diện chỉ hiện token.
4. Giao diện luôn hiện `pricesUpdatedAt` cạnh số tiền kèm nhãn "estimated"; số tiền là tạm tính, không phải hoá đơn (giá Bedrock/Vertex khác giá API gốc). **Không gọi mạng lấy giá.**
5. Mọi phép gộp theo model (tổng tiền, dòng theo model, biểu đồ model × vai trò) dùng **model hiệu lực**: `runtime.model`, không có thì `usage.model`.

## 10. Đọc kho beads

- **Thư mục workspace** lấy từ snapshot SDK theo thứ tự `directory`, `workspaceDirectory`, `cwd`, và chỉ với workspace không phải worktree mới thêm `projectRootPath`. Worktree **không bao giờ** dùng `projectRootPath` làm dự phòng: đó là bản checkout chính, và các worktree sẽ thấy chung beads của nó. Không dùng cwd của plugin.
- **Đường dẫn** `<dir>/.beads/issues.jsonl`: `resolve` rồi kiểm vẫn trong `dir`; `lstat` từng thành phần, symlink ra ngoài → `E_BEADS_STORE_UNREADABLE`. Bản riêng trong `server/` (payload không import `src/`).
- **Đọc** theo dòng, trần 32 MB; dòng hỏng bỏ qua và tăng `skippedLines`; nhiều dòng cùng `id` giữ `updated_at` muộn nhất. Cache theo `(path, mtimeMs, size)`.
- **Số:** `total` = số id phân biệt; `open`/`inProgress`/`blocked`/`closed` theo `status`; `ready` = `open`, không phải epic, và **mọi** phụ thuộc `blocks` trỏ tới bead `closed` (`parent-child` không chặn; id không tồn tại coi là chưa đóng).
- **Chỉ đọc**: không gọi `br`, không tiến trình con, không ghi, không chạm `beads.db`.
- **Ai đang làm bead** (`BeadRow.work`, chỉ cho bead `in_progress`, `server/bead-work.ts`): `br` không ghi thời điểm bắt đầu và Worker không đặt `assignee`, nên suy từ kho lưu vết, chỉ lượt của Worker. `started` = lệnh gần nhất đưa bead sang `in_progress` (`--status in_progress`, `--status=in_progress`, `-s in_progress`, `--claim`); `last` = lệnh hoặc `BM-REPORT` gần nhất nhắc id (khớp nguyên id: `x.1` không khớp `x.12`). Không có lệnh đặt trạng thái → "start not recorded"; Worker khác nhận bead sau thì hiện Worker mới với giờ hoạt động của nó, không mượn giờ bắt đầu cũ. Không có kho lưu vết thì chỉ thiếu tên Worker.

## 11. Surface "Beads Manager"

### 11.1 View và đường quay lại

`DashboardViewName = "setup" | "workspaces" | "dashboard" | "beads"`; surface mở ở `SURFACE_HOME_VIEW = "setup"`.

| View | `backOf` | `backLabelOf` (nhãn trợ năng của ←) |
|---|---|---|
| `setup` | `null` (không có ←) | `null` |
| `workspaces` | `setup` | "Back to Beads Manager setup" |
| `dashboard`, `beads` | `workspaces` | "Back to workspaces" |

```
sidebar / Command Center "Open Beads Manager"
  → setup ──(Workspaces)──> workspaces ──(Metric | Beads)──> dashboard | beads
Command Center "Open Beads Metric" → dashboard ──(←)──> workspaces ──(←)──> setup
```

Command Center và slash command không truyền được gì vào surface, nên dùng **ô chờ một chỗ** `createSlot<string>()`: `launchRequests` (mở Manager), `dashboardRequests` (mở Metric của workspace), `launcherNotices` (thông báo của slash command). `take()` báo cho người nghe **chỉ khi thật sự xoá một giá trị**, nên bấm để ẩn thông báo ẩn ngay và không có vòng lặp. `runPendingRequest` trả `null` **trước** `take()` khi launcher đang `pending`, và effect của surface chạy lại khi trạng thái launcher đổi, nên yêu cầu mở Manager đến giữa chừng không bị rơi (ô một chỗ: yêu cầu mới nhất thắng).

### 11.2 Dải trạng thái

`launcherStatusLines({ commandNotice, canOpenAgents, state })` trả theo thứ tự: thông báo slash command (tone `muted`, `dismissable`, nhãn trợ năng `"<text>. Dismiss."`); `OLD_HOST_WARNING` khi host thiếu `navigation.openAgent` (tone `warning`); các dòng `describeLauncherState(state)`: `pending` → "Opening Beads Manager…"; `opened` → "Started a new…" / "Reopened the existing Beads Manager…" (`muted`), rồi tone `warning` cho Manager sống khác (`otherManagerIds`, "…nothing was archived or deleted."), `modeNotice`, `toolsNotice`, **(0.4.0)** `setupNotice` (nguyên văn server, design gốc §7.3, §7.13.2); `error` → `danger` "Could not open Beads Manager (<code>). <message>", với `<message>` là thông điệp của server đã bỏ lớp vỏ của daemon (`Request failed: … requestType=… code=…` của `DaemonRpcError`) và bỏ mã ở đầu khi mã đã nằm trong ngoặc (`withoutCode`); không có mã thì "Could not open Beads Manager. <message>". Dòng không ẩn được là `Text` có `accessibilityLiveRegion="polite"`. `LauncherStatus` được dựng **một lần** trong `ManagerLauncherSurface` và đặt ở mọi view của surface (Setup, Workspaces, Metric, Beads) — slash command có thể mở surface ở bất kỳ view nào. Tab "Beads" (§14) không có dải này.

### 11.3 Màn Setup (màn chính)

```
[Beads Manager ............................ (Workspaces)]
Setup for this machine: beads tools, agent skills, and each role's model and extra instructions.
<dải trạng thái> · spinner · lỗi · setupHeadline · paseoToolsWarnings
<banner chuyển đổi>                            ← (0.4.0) chỉ khi install.kind = installer-directory
<thẻ "Set up paseo-bm">                         ← (0.4.0) chỉ khi còn việc thiếu
[Beads tools] [Agent skills] [Agents]          ← StatusTabs, một tab mỗi lần
<nội dung tab>
paseo-bm <version>
<khối "This install">                           ← (0.4.0) thư mục dữ liệu, nút gỡ cấu hình
```

- Tab: `SETUP_TABS` = `tools` "Beads tools" · `skills` "Agent skills" · `agents` "Agents"; `DEFAULT_SETUP_TAB = "tools"`, là `useState` nên mở lại surface thì về tab đầu. Mỗi tab có `hint` (vd. "br and bv on the daemon's PATH"), làm nhãn trợ năng `"<label>: <hint>"`. Mọi thứ báo vấn đề (`setupHeadline`, `paseoToolsWarnings`) nằm **trên** dãy tab, để không tab nào che được một công cụ thiếu. Tab `agents` gồm "Roles & models" rồi "Additional instructions".
- Nút "Workspaces" (`secondaryButton`, nhãn trợ năng "Open the workspace list: Beads Manager, metrics and beads of each workspace").

**Beads tools** (`setup.status`, `setup-tools.ts`):

- Tìm `br`, `bv` (và `bd`, chỉ thông tin) trên `PATH` của daemon cộng `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.cargo/bin`, `~/go/bin`; chạy `--version` song song (timeout 5 s). Không bao giờ chạy `bv` trần (TUI). `br` chỉ tính là có khi đúng tên `br`.
- Mỗi công cụ hiện trạng thái, đường dẫn (PATH của daemon có thể khác terminal), phiên bản, bản mới nhất đã biết (`LATEST_KNOWN`, hằng số có ngày kiểm, không tra mạng), lệnh cài và lệnh cập nhật với nút Copy (về chữ "Copy" sau 2 s).
- Lệnh cài: có `brew` → `brew install dicklesworthstone/tap/<tool>`; không có, `br` → script `beads_rust/main/install.sh | bash -s -- --skip-skills` (để paseo-bm không ghi vào thư mục skill); không có, `bv` → script `beads_viewer` ghim commit `a43b8e85a39664381566abdfd85dc8fcbfdcb773`. Lệnh này phải trùng lệnh của CLI (test khoá; `src/` và `plugin/` không dùng chung code).
- Nút Install chỉ hiện khi thiếu. Hộp xác nhận nêu nguyên văn lệnh và cảnh báo lệnh tải mã từ mạng. `setup.install-tool` chạy lệnh trong shell đăng nhập (`/bin/zsh -lc` nếu `SHELL` là zsh, còn lại `/bin/bash -lc`), timeout 300 s, trả mã thoát và 40 dòng cuối. Công cụ đã có → `E_TOOL_PRESENT`; lỗi → `E_TOOL_INSTALL_FAILED`. Cập nhật không chạy từ màn hình. Plugin không bao giờ tự cài.

**Thiết lập máy (0.4.0)** (`setup-screen.tsx`, logic thuần ở `setup-model.ts`; hợp đồng server ở design gốc §7.13). Không còn dòng chữ nào của màn trỏ tới `npx paseo-bm`, trừ banner.

- **Khi mở màn:** gọi `setup.ensure-roles {}` rồi mới `setup.status` (một chuỗi, spinner chung). `created` khác rỗng → dải trạng thái có dòng `success` "paseo-bm created its roles with defaults (<provider> · <model>). Change them in Agents." (ẩn được). `E_SETUP_ROLES_FAILED` → dòng `danger` kèm mã và lời server, nút "Try again" gọi lại `setup.ensure-roles`. `skipped: "cleaned-up"` → không có thẻ thiết lập; thay bằng dòng `warning` "paseo-bm's settings were removed. Remove the plugin with `paseo plugin remove paseo-bm`, or set it up again." kèm nút "Set up again" (`setup.ensure-roles { resume: true }`).
- **Banner chuyển đổi** (`status.setup.install.kind === "installer-directory"`, tone `warning`): "This copy of paseo-bm was installed by the old npx installer. Switch it to the paseo.cafe install once: `npx paseo-bm@0.4.0`. Your roles, settings and history stay." Lệnh có nút Copy. Không ẩn được.
- **Thẻ "Set up paseo-bm"** (`setupChecklist(status)`, trả các dòng còn thiếu theo thứ tự dưới; không còn dòng nào thì thẻ không hiện). Mỗi dòng: tên, một câu trạng thái, nút hành động (nếu có). Đặt **trên** dãy tab như `setupHeadline`, để không tab nào che được việc còn thiếu.

  Câu trạng thái của từng dòng (nguyên văn): Roles — "Not created: <Manager, Worker, Reviewer>. <lời server của `E_SETUP_ROLES_FAILED`, không có thì bỏ>"; Agent tools — "Off — no new Beads Manager starts until you allow them." (cùng câu của khối trên "Roles & models"); Agent skills — "Required skills for the Worker (<Claude Code | Codex | …>): <k>/5. The Worker works with lower quality without them."; Beads tools — "Missing <br | bv | br and bv> — the Worker cannot manage beads without it" (cùng câu của `setupHeadline`); Sign-in — câu ở cột cuối.

  | Dòng | Thiếu khi | Nút | Hộp xác nhận (nguyên văn, tiếng Anh) |
  |---|---|---|---|
  | Roles | `setup.roles.missing` khác rỗng (ensure vừa hỏng) | "Try again" | — (không cần: chỉ tạo mục `bm-*` của paseo-bm) |
  | Agent tools | `setup.agentTools.injectIntoAgents === false` | "Allow agent tools…" | Tiêu đề "Allow Paseo's agent tools for every agent?". Thân: "The Manager and the Worker need Paseo's agent tools to create and message other agents. Paseo has one switch for this (daemon.mcp.injectIntoAgents), and it applies to **every agent on this machine**, not only paseo-bm's: any agent can then create, message and stop other agents. paseo-bm records the current value so "Remove paseo-bm's settings" can turn it back off." Nút "Allow for every agent" / "Cancel" (mặc định). Gọi `setup.grant-agent-tools { confirmed: true }` |
  | Agent skills | agent của provider mà vai `bm-worker` đang dùng (Claude Code cho `claude`, Codex cho `codex`) thiếu skill bắt buộc; provider khác (Pi, OpenCode) thì theo cột của nó nếu có, không có thì không hiện dòng này | "Install skills…" | Tiêu đề "Run the third-party skills CLI?". Thân: lệnh nguyên văn (`status.skills.installCommand`), rồi "This downloads the skills from github.com/cuongntr/agent-skills (another author) with the `skills` CLI, a third-party tool with its own data collection. paseo-bm never writes to your skills folders itself. It can take up to 5 minutes." Nút "Run it" / "Cancel" (mặc định). Gọi `setup.install-skills { confirmed: true }`; kết quả hiện mã thoát và 40 dòng cuối như Install của `br`/`bv`, rồi đọc lại `setup.status` |
  | Beads tools | `br` hoặc `bv` thiếu | "Open Beads tools" (chuyển tab) | Hộp xác nhận Install sẵn có của tab |
  | Sign-in | một dòng `logins` có `state: "logged-out"` | không có nút chạy | Chỉ chữ: "`<provider>` (used by <roles>) is not signed in. Sign in with: `<loginCommand>`" + Copy; Pi: `guidance`. `unknown` không làm hiện dòng |

- Mọi hộp xác nhận: nút huỷ là mặc định và nhận phím Escape; nút đồng ý không bao giờ được focus sẵn; bấm đồng ý mới gửi RPC (schema buộc `confirmed: true`). Lỗi của RPC hiện ngay dưới dòng, kèm mã.

**Agent skills:** `setup.status` đọc (chỉ đọc) thư mục skill của tiến trình daemon (`~/.agents/skills`, `~/.claude/skills` theo `CLAUDE_CONFIG_DIR`, `~/.codex/skills` theo `CODEX_HOME`, và thư mục của Pi/OpenCode khi có). Claude Code chỉ tính thư mục của nó; Codex tính `~/.agents/skills` hoặc thư mục của nó. Nút **Test** đọc lại từng `SKILL.md`: đọc được, có frontmatter `name:` trùng tên thư mục → `ok` / `missing` / `broken` kèm giờ kiểm. Màn hiện lệnh `skills add` tương đương; plugin không cài skill. **(0.4.0)** Tab có thêm nút "Install skills…" (cùng hộp xác nhận và RPC với thẻ thiết lập) khi có agent thiếu skill bắt buộc, và dòng "Last run: <thời điểm> · exit <code>" từ `setup.skillsRun`; nhãn dòng lệnh đổi theo design gốc §7.13.10. Cột Pi/OpenCode vẫn chỉ đọc.

**Roles & models** (`setup-screen.tsx`, logic ở `setup-model.ts`; hợp đồng server và luật kiểm ở design gốc §7.3.6):

- `RolesSection` đọc `roles.settings` (khoá `ROLES_SETTINGS_KEY`) và `roles.options` của mọi provider gốc trong vai và chuỗi dự phòng (`rowOptionProviders`). Mỗi vai một hàng: `RoleMark`, tên vai, `roleSettingText` = `<Provider> · <model label> · thinking <id | provider default>[ · mode <label>]`, nút Edit/Close. Dưới thẻ: `warnings` của `roles.settings` (tone `warning`, một lần cho cả thẻ) và `ROLES_APPLY_NOTICE` "Changes apply to agents created after you save. Running agents keep their model and thinking."
- **Form Edit** (`RoleEditForm`, `roleFormView`): chip Provider từ `roles.settings.providers` (không alias `bm-*`; provider đang lưu luôn có mặt); Model từ `roles.options`, dưới đó giá `~$<in> / $<out> per 1M tokens` khi có; Thinking ẩn khi model không có mức, lựa chọn đầu "Provider default (<mức>)"; Mode ẩn khi `capability: none`, lựa chọn đầu "Not set", Reviewer trên `tiered` không thấy mode `dangerous`/`planning`; `capability: unknown` mà đang có mode → cảnh báo lưu sẽ xoá mode. Save bật khi nháp đủ provider + model và khác bản lưu. Form giữ `revision` lúc mở: `E_ROLE_SETTINGS_CONFLICT` → "The configuration changed elsewhere; reopen Roles & models." và đọc lại `roles.settings`. Lưu xong: "Saved." kèm từng `warnings` dưới hàng (`notified` không hiện).
- **(0.4.0) Trên "Roles & models":** `setup.roles.created` khác `null` → dòng `muted` "Created by paseo-bm on <ngày> with defaults (<provider> · <model>). Change them here." Dưới thẻ vai: khối **Paseo agent tools** — "On for every agent" (kèm "turned on by paseo-bm" khi `setBy` có) hoặc "Off — no new Beads Manager starts until you allow them" với nút "Allow agent tools…" (cùng hộp xác nhận ở trên); và khối **Sign-in**, một dòng mỗi provider gốc của ba vai: `<provider>` · "used by Manager, Worker" · "Signed in" / "Not signed in — sign in with `<lệnh>`" (Copy) / "Unknown"; Pi hiện `guidance`. Không có nút nào chạy lệnh đăng nhập.
- **Chuỗi dự phòng** (`FallbackBlock`) dưới mỗi vai có trong `roles.settings.fallback`: `On a usage limit:` chip Ask me / Auto switch / Off; Auto switch → cảnh báo chi phí (Manager thêm "The chat you use may be replaced."). Mỗi mục `Fallback <n>  <Provider> · <model> · thinking …[ · mode …]`, nút ↑ ↓ Edit Remove, dòng giá; "+ Add fallback" khi dưới `MAX_FALLBACK_ENTRIES` (3). Form mục dùng đúng luật form vai. Sửa chỉ nằm ở máy khách tới khi bấm "Save fallbacks" (`roles.save-fallback` cả chuỗi, `revision` lúc bắt đầu sửa) hoặc "Discard".

**Additional instructions** (`role-extras.ts`):

- Lưu ở `<install home>/role-extras.json` (`0600`, file tạm rồi rename, chặn symlink): `{ "version": 1, "roles": { "manager", "worker", "reviewer" } }`, mỗi vai tối đa `MAX_EXTRA_CHARS` = 8 000 ký tự. Là dữ liệu người dùng: không hash trong `install.json`, cập nhật và `--prune` không đụng.
- **Chỉ nối thêm**: đầy đủ = gốc + `---` + `## Additional instructions from the user` + `These add to the rules above and never override a RULES item.` + nội dung. Áp cho agent tạo sau khi lưu (hook `agent.create` cho Worker/Reviewer, `manager.ensure` cho Manager); file không đọc được thì dùng bản gốc, không chặn việc tạo agent. Plugin settings của Paseo không dùng được cho việc này vì server không đọc được chúng.
- Preview hiện toàn văn bản đầy đủ dạng Markdown.

**Khối "This install" (0.4.0)**, dưới dòng `paseo-bm <version>`, ngoài các tab:

- "Data folder: `<path>`" và nguồn (`default` / "set by PASEO_BM_HOME" / "from ~/.paseo-bm/home.json"); `path: null` → dòng `danger` với `reason`, và các nút cần thư mục (lưu chỉ dẫn thêm, lưu chuỗi dự phòng, bật tool agent) báo `E_DATA_HOME_UNAVAILABLE` / mã sẵn có khi bấm.
- "If paseo-bm does not load at all, check `paseo plugin ls` and `paseo plugin logs paseo-bm`." (thay cho `doctor`, vì khi plugin không nạp thì không có màn nào hiện).
- Nút **"Remove paseo-bm's settings…"** (tone `danger`, nhãn trợ năng "Remove paseo-bm's roles and settings from Paseo"). Xác nhận **lớp một**: "This removes every bm-* provider and agent profile from Paseo (the three roles and their fallbacks)<, and turns Paseo's agent tools back off (paseo-bm turned them on)>. Agents already running on these roles will fail on their next turn: archive them first. Skills, br and bv stay." Nút "Remove settings" / "Cancel" (mặc định). Xác nhận **lớp hai** (luôn hỏi, mặc định giữ): "Also delete paseo-bm's data in `<path>`: history (traces), extra instructions, fallback settings and incidents? One small file stays so the roles are not re-created before you remove the plugin, and files left by the old installer stay." Nút "Keep my data" (mặc định) / "Delete data". Gửi `setup.cleanup { confirmed: true, deleteData }`. Kết quả: danh sách đã xoá, đã giữ (`data.kept`), trạng thái công tắc ("left on — it was not turned on by paseo-bm" khi `left-on`), rồi dòng cố định "Now remove the plugin: `paseo plugin remove paseo-bm`" + Copy. Sau đó màn chuyển sang trạng thái `skipped: "cleaned-up"` ở trên.

### 11.4 Danh sách Workspaces

- Dòng đầu `[←] Workspaces`, câu giới thiệu một dòng, dải trạng thái, rồi một dòng cho mỗi workspace theo **đúng thứ tự `workspaces.list` trả về** (`activity_at desc`); không ghim, không kéo-thả.
- Mỗi dòng: tên (1 dòng) và project; `workspaceStats` — bốn con số kèm icon `Layers` tổng, `CircleDot` đang làm, `Ban` bị chặn, `Hammer` Worker đang chạy (tone `plain` khi > 0, `muted` khi 0; tổng luôn `muted`; không kho bead thì một dòng "–"); chấm 8 px cạnh tên (`RunningDot`, `runningDotState`); ba nút nhỏ có icon trên một hàng, cả trên điện thoại: `WORKSPACE_ACTIONS` = Go to (`Bot`), Metric (`ChartColumn`), Beads (`ListChecks`). Go to là nút chính và ẩn khi host thiếu `navigation.openAgent`; Metric và Beads chỉ đọc nên luôn còn (REQ-040d).
- **Chấm đang chạy:** tổng `runningAgents` > 0 → tone `success`, nhấp nháy `Animated.loop` opacity 1 ↔ `DIM_OPACITY` 0,3, mỗi nhịp `PULSE_MS` = 900 ms (`useNativeDriver: false`), kèm chữ `1 Worker, 1 Reviewer`; = 0 → chấm mờ 0,3, tone `muted`, không chữ, nhãn trợ năng "No Beads agent running"; chưa có số liệu → không vẽ. `AccessibilityInfo.isReduceMotionEnabled()` đúng → chấm đặc, không hoạt ảnh (hỏi lỗi coi là sai). Poll chỉ đổi số thì không khởi động lại vòng lặp.
- Danh sách bỏ workspace đang lưu trữ (`archivingAt`). `workspaces.list` và `traces.workspaces` là query một lần, chạy ở mọi view: yêu cầu "Open Beads Metric" cần nhãn từ `workspaces.list` (thiếu thì dùng `workspaceId`).
- `workspaces.overview` chỉ được đọc khi view là `workspaces` (`overviewPolling`: `OVERVIEW_POLL_MS` = 10 000 ms), vì mỗi lần đọc chạm kho bead của mọi workspace.
- Cuối danh sách: "Closed workspaces with history" (`closedWorkspaces`: có trong `traces.workspaces` nhưng không còn được liệt kê, trạng thái khác `unknown`, mới nhất trước), mỗi mục mở màn Metric của lịch sử đó; màn Metric của workspace mới mở lại đề nghị gán lịch sử sang nó.
- Tiêu đề màn Metric/Beads là `screenTitleOf(label, project)`: thêm tên project khi tên workspace khác tên project, để không nhầm hai kho bead.

## 12. Màn Metric

`DashboardPanel(props: WorkspaceScreenProps)`; `WorkspaceScreenProps` = `PluginSurfaceProps` + `workspaceId`, `workspaceLabel?`, `onBack?`, `backLabel?`, `status?`. Đầu màn là `WorkspaceScreenHeader`: ← (khi có `onBack`), tiêu đề `Metric · <tên>` (khi có `workspaceLabel`), nút Refresh; dải trạng thái ngay dưới.

1. **Tổng quan** — `overviewCards`, bảy thẻ: Requests (số **dòng**; hint running · waiting · done), **Errors**, Beads, Agents, Messages, Tokens (in · cached · out), Cost (estimated; số request chưa định giá).
   - `errorTally` cộng `errors` của các dòng đang hiện (dòng không có trường đọc là 0), `requests` đếm theo `traceId`. `errorCard`: tổng 0 → giá trị `0`, hint "no error recorded"; ngược lại hint `"<n> request(s) with an error · <a> failed turn(s) · <b> agent error(s) · <c> provider fallback(s)"`, bỏ phần bằng 0. "request(s) with an error" nói rõ đơn vị vì thẻ Requests bên cạnh đếm dòng. Thẻ không tô màu.
   - Cảnh báo dung lượng (§3.6) ngay dưới hàng thẻ.
2. **Biểu đồ** (khi có dòng): "Requests, last 7 days — each request counted once" (`requestsPerDay`, chỉ dòng mở request); "Top 5 heaviest Workers (tokens)" (`heaviestWorkers`, bấm mở Worker khi host có `navigation.openAgent`); "Tokens by model × role" (`tokensByModelRole`, model không có giá chỉ hiện token).
3. **Các request** — `RoleLegend`, rồi `groupTraces` (nhóm theo `workspaceState` theo thứ tự live → archived → orphaned → unknown, bỏ nhóm rỗng; nhóm orphaned có câu gợi ý gán lại hoặc xoá — đó là cách duy nhất người dùng tìm thấy tính năng gán lại; tên và đường dẫn cuối biết được hiện ở mục "Closed workspaces with history" của danh sách Workspaces). Mỗi dòng một `RequestCard` gọn (`RoleMark` của Manager, lời hỏi 1 dòng, badge trạng thái, dòng phụ `[turn i of n · ]<tier | size ?> · <thời gian> · <n> tokens · <chi phí>[ · 💬 <n> from you]` — phần cuối khi người dùng nhắn thẳng cho agent của request); bấm để mở **graph** Request → Worker → Reviewer (`requestGraph`), chi tiết chỉ tải khi mở. Bấm từng node để xem: đã hỏi gì, trả lời gì, thời gian, token, model/thinking/mode (`runtimeLines`), bead, skill đã load, tin người dùng gửi thẳng (`💬 You → <agent>`), và bước quy trình trên một dòng chip (`stepChip`: xanh lá ✓ exact, xanh ✓~ inferred, xám – không cần, vàng ? không rõ). Các quy tắc trung thực (độ chắc của việc nhóm, số đếm lệch, workspace không còn) nằm ở node Request. Nút "Open agent" chỉ hiện khi host có `navigation.openAgent`.
   - **Dòng model** (`runtimeLines`): mỗi phần tử `runtime` một dòng `Model: <m> · thinking: <id | provider default> · mode: <id | unknown> · <n> turn(s)`; `recorded: false` → `Model: <m> · thinking/mode: not recorded · …`, hay `Model: not recorded · …` khi model `null`. Manager không có node riêng: dòng của nó nằm ở node Request, dạng `Manager <id ngắn> — Model: …`, cùng dòng `Tokens by model: <model> <n> tokens · $… · …` (`tokensByModelLine`; model không có giá chỉ hiện token, model `null` là `unknown model`). Phụ đề node Worker/Reviewer thêm tên model khi agent chạy đúng một model biết tên (`singleModelOf`).
4. **Storage** gập ở cuối: dung lượng, xoá theo trace / cũ hơn `OLDER_THAN_DAYS` = 30 ngày / cả workspace, gán lại (`dashboard-actions.tsx`, `createConfirmationGate`: không có "Yes" mặc định).
5. `PRIVACY_NOTICE` ở cuối: màn hình hiện và lưu hội thoại agent.

Màn gọi `traces.list` một lần, không truyền `cursor` (trang đầu, tối đa 50); `truncated: true` thì màn ghi "Older requests are not shown." **Chưa có nút tải thêm** (REQ-041 (c), REQ-049 (a)) dù server đã trả `nextCursor`.

**Icon vai trò** (`ROLE_MARK`, icon Lucide của `Icon` trong `@getpaseo/plugin/client/react-native` trên nền tròn cùng màu `opacity: 0.16`): request/Manager `BotMessageSquare` tone `info`; Worker `Hammer` tone `success`; Reviewer `ScanEye` tone `warning`. Màu `danger` để dành cho lỗi; hình icon khác nhau nên vẫn phân biệt được khi hai màu gần nhau. Tên icon sai thì Paseo không vẽ gì, không lỗi.

## 13. Màn Beads

`BeadsScreen(props: WorkspaceScreenProps)`, dùng chung cho surface và tab "Beads". Đầu màn: ← · `Beads · <tên>` · `doneText` (`✓ <closed> / <total> done`, nhãn trợ năng "`<closed> of <total> beads done, epics not counted`", chỉ hiện khi có dữ liệu) · Refresh. Rồi dải trạng thái và dòng `Read from <đường dẫn file>` (để hai workspace cùng một bản sao beads không trông như bị lẫn).

### 13.1 Tổng quan (`beadsOverview`)

Năm mục: Status (Total, Ready, In progress, Blocked, Closed); Progress (phần trăm đã đóng, **không tính epic**, không theo bộ lọc — `doneText` đọc cùng số); By type; By priority (P0 → P4, P?); Time (trung vị tạo → đóng, "Longest in progress" tính từ `work.started` nếu biết, Stale = mở và không cập nhật quá 7 ngày). Không có biểu đồ tạo/đóng theo ngày.

### 13.2 Bộ lọc và sắp

Ô tìm theo id và tiêu đề; chip lọc Status / Type / Priority / Labels (`facetsOf`: số của một giá trị là số bead nó sẽ hiện khi kết hợp các bộ lọc khác; nhãn gom theo tiền tố `feature`, `area`, `component`, …, mỗi nhóm hiện `LABEL_PREVIEW` = 5 giá trị trước "+N more"); chip bộ lọc đang bật có ✕ và "Clear all" (tone `plain` — nó chỉ bỏ bộ lọc); Sort theo Updated / Created / Closed / Priority, mới nhất trước, bead thiếu giá trị luôn cuối. Trong một facet chọn nhiều là "hoặc", giữa các facet là "và". Chip Status xếp theo `STATUS_ORDER` (Ready trước), khác thứ tự cột `STATUS_GROUP_ORDER` (§13.3); gộp hai thứ tự là đổi thứ người dùng thấy, phải hỏi owner.

### 13.3 Kanban

Mọi quyết định ở `beads-model.ts`; `KanbanBoard` và `StatusTabs` là view không hook trong `ui.tsx`.

- **Cột** theo `STATUS_GROUP_ORDER` = `in_progress` → `blocked` → `ready` → `closed`. `statusBucket`: `closed`, `in_progress`, `blocked` theo `status`; bead mở mà chưa sẵn sàng hay mang trạng thái lạ (`deferred`) là `blocked`. `kanbanColumns(beads, { showClosed, limit? })` nhận danh sách **đã lọc và đã sắp**, giữ thứ tự trong cột, trả `{ columns, visible, closed }`; mỗi cột `{ bucket, label, total, beads, hidden, empty: "Nothing here." }`. Cột rỗng vẫn trả về và vẽ (bố cục không nhảy khi lọc); Closed chỉ có khi `showClosed`.
- **Giới hạn** `KANBAN_COLUMN_LIMIT` = 100 dòng **mỗi cột**, để cột Closed dài không ăn chỗ của In progress; cột bị cắt nói `+<hidden> more · narrow the filters to see them`.
- **Bố cục** `kanbanLayout(width, compact, buckets)`, `width` đo bằng `onLayout` của vùng danh sách: chưa đo (`null`) → theo `compact` của host (`tabs` / `columns` đủ cột); `width < 2 × KANBAN_MIN_COLUMN` (260) → `tabs`; còn lại `columns` với `perRow = min(buckets, floor(width / 260))`. Mỗi cột trong một ô `flexBasis: (100 / perRow)%` với padding làm khoảng cách (phần trăm cộng đúng 100%, `gap` trên hàng sẽ đẩy ô cuối xuống). Chế độ `tabs`: `StatusTabs` (`accessibilityRole="tablist"`, mỗi tab `"tab"` + `accessibilityState.selected`, chữ `<tên> <số>`), cột mở sẵn là `defaultKanbanBucket` (cột đầu có bead), và `visibleKanbanBucket` quay về mặc định khi cột đang chọn biến mất.
- **Nút mắt** ở dòng `<visible> of <total> beads`: `Eye`/`EyeOff` + `Closed <n>`, `accessibilityState.selected`, nhãn "Show/Hide closed beads (<n>)". `closedBeadsVisibility = createSessionToggle(true)`: **mặc định hiện**, nhớ trong phiên app, dùng chung giữa surface và tab. Mọi bead khớp đều đã đóng mà đang ẩn → "All <n> matching beads are closed. Show them with the eye button." Workspace không có bead → "This workspace has no beads yet."

### 13.4 Dòng bead, chi tiết và hành động

- **Dòng** (`BeadRowCard`, dùng chung với panel "Beads in this chat"): tên trước (tối đa 2 dòng khi gập, ▸/▾), rồi id, chip `P<n> · <type>`, chip trạng thái; bead `in_progress` có thêm dòng `RoleMark` Worker + `workSummary.headline` (`<Worker> · since <giờ> (<bao lâu>) · <trạng thái>`, hoặc "start not recorded"). Bấm để mở chi tiết ngay trong thẻ.
- **Chi tiết** (`BeadDetailPanel`, `beads.get`): mô tả dạng Markdown, lý do đóng, phụ thuộc; khung "Being worked on" với nút "Open the Worker"; các hành động (`actionsFor`: bead đã đóng chỉ có Delete).
- **Hành động** qua Manager của workspace, không tự tạo Worker: `beads.action` gọi `ensureManager` rồi `paseo.agents.ref(managerId).send(actionMessage(...))`; Manager tạo Worker theo `manager.md`. Như vậy `requestId`, nhãn, báo cáo, ngân sách review và trace giữ nguyên, và Metric thấy request như mọi request khác. Tin gửi (tiếng Anh, cho agent):

  ```
  [Beads screen] The user asks: <implement|delete|close> bead <id> ("<title>").
  <chỉ dẫn của hành động>
  The user confirmed this action on the Beads screen. Treat it as a new request from the user. Do not commit or push.
  ```

  Delete và Close là **yêu cầu đánh giá**: Worker xem bead còn cần không / đã đạt tiêu chí chưa, làm nếu được, không thì báo lý do. Plugin không bao giờ ghi kho bead. Mọi hành động qua cổng xác nhận (`actionSpec`: Assign a Worker / Close / Delete; nút huỷ "No, cancel"), vì mỗi hành động tốn quota thật.
- **Dòng kết quả sống qua việc đổi cột.** Mỗi trạng thái là một cột (một cha riêng), nên bead đổi trạng thái sau lần refresh thì React dựng lại dòng. Kết quả hành động (`"Sent to the Beads Manager… It will hand the bead to a Worker."` kèm nút "Open the Beads Manager", hoặc lỗi) vì vậy nằm ở `beadActionResults: SessionMap<{ text, managerId, tone }>`, khoá `beadResultKey(workspaceId, beadId)` = `<workspaceId>:<beadId>` (hai repo có thể cùng tiền tố `br`), đọc bằng `useSyncExternalStore`, `clear` khi người dùng mở hành động mới. `SessionMap.get` trả đúng object đã lưu nên ổn định giữa các lần render, không cần snapshot. `pending`/`busy` vẫn là state của panel: chỉ sống vài giây xác nhận, mất khi bead đổi cột không xoá bằng chứng nào (hộp xác nhận đang mở thì đóng lại).

### 13.5 Cách bead nói trạng thái

Nhiều màu trên một danh sách gây mỏi mắt, nên ở **mọi chỗ hiện bead** (màn Beads, tab "Beads", panel "Beads in this chat", chip bead trên thẻ chat, số trên dòng workspace) trạng thái chỉ nói bằng **chữ và độ tương phản**, không bằng hue:

- `STATUS_EMPHASIS`: `ready`, `in_progress`, `blocked` → `strong`; `closed` → `dim`. `beadEmphasis(bead)`; `emphasisTone`: `strong` → `plain`, `dim` → `muted`.
- `statusBadge(bead)` = `{ text: Ready | In progress | Blocked | Closed, tone: emphasisTone(beadEmphasis(bead)) }`: chip và tên luôn cùng độ tương phản, và trạng thái luôn có chữ.
- `beadTitleStyle(styles, theme, emphasis | null)` = `sectionTitle` với `fontWeight: "400"` (không in đậm) và màu `foreground`/`foregroundMuted`; `null` (khung chi tiết mở từ chip) giữ `foreground`. Dòng không tô nền, không vạch trái.
- Tiêu đề cột dùng `sectionTitle` không màu. Dãy `StatusTabs` là nút: tab đang chọn kiểu `button` (nền accent), tab kia `secondaryButton`, như tab con của tab "Beads"; màu đó nói tab nào đang mở, không nói trạng thái bead. `workSummary.tone`: `running` → `plain`, còn lại `muted`.
- Ngoài chỗ hiện bead, màu giữ nguyên: dòng lỗi RPC (đỏ), cảnh báo (vàng), chip lọc đang bật và "+N more" (accent), màn Metric, thẻ chat, nút Delete.

## 14. Tab "Beads" và nút header

- **Panel** `client.addWorkspacePanel({ id: BEADS_TAB_PANEL_ID ("bm-beads"), title: "Beads", icon: "ListChecks", context: "workspace", Component: BeadsTabPanel })`, đăng ký trước panel "Beads agents"; không khai `locations` (mặc định `["workspace"]`). Paseo đưa mọi panel `context: "workspace"` vào menu "+" của thanh tab và màn "New tab".
- `BeadsTabPanel`: hàng tab con `BEADS_TAB_VIEWS` = Beads, Metric (`accessibilityRole="tab"`, tab chọn kiểu `button`, tab kia `secondaryButton`, cao ~40 px), mở ở `DEFAULT_BEADS_TAB_VIEW = "beads"` (`useState`, sống trong tab). Nội dung là `BeadsScreen` / `DashboardPanel` **không** truyền `onBack`, `workspaceLabel`, `status`: không ←, không tiêu đề, không dải trạng thái; dòng đầu chỉ còn phần bên phải. Đổi tab con thì unmount màn kia; dữ liệu nằm trong cache React Query theo khoá `["paseo-bm", "beads-list", id]`, `["paseo-bm", "traces", id]`. Hai tab "Beads" của cùng workspace dùng chung cache, mỗi tab giữ tab con riêng; mở lại tab cũ hay mở tab mới là việc của Paseo.
- **App mobile của Paseo 0.8 không có "+"** (thanh tab mobile chỉ liệt kê tab đã mở; `onCreateNewTab` chỉ trao cho `WorkspaceDesktopTabsRow` và `SplitContainer`). Lối vào mobile là **nút header**: `registerBeadsHeaderButtons(client)` (`beads-header-button.ts`) đọc `client.paseo.workspaces.list({})` lúc bắt đầu, mỗi `BEADS_HEADER_POLL_MS` = 15 000 ms và mỗi khi `workspaces.subscribe` báo cập nhật (một lần đọc tại một thời điểm; lỗi thì giữ nút; client không có `paseo` không làm hỏng việc nạp). `planHeaderButtons(shown, listed)` → `{ add, remove }` theo workspace đang mở (không `archivingAt`). Mỗi workspace một `client.addHeaderButton({ id: BEADS_HEADER_BUTTON_ID ("bm-beads-open"), workspaceId, button })`, nút chỉ biểu tượng `ListChecks`, title "Open the Beads tab: beads and metrics of this workspace", bấm → `client.openPanel("bm-beads", { workspaceId })`. Ở dạng hẹp (`useIsCompactFormFactor` hoặc rộng < 1100 px) Paseo hiện nút plugin **đầu tiên** thẳng trên header, nút sau vào menu "more"; desktop hiện ở header phải. Paseo khoá nút header theo `id` + `workspaceId` (trùng `id` trong một workspace thì lỗi), nên mọi workspace dùng chung một `id`. `addButton(workspaceId)` nhận workspace làm tham số, không bắt biến vòng lặp: trên Hermes (mobile) mọi closure tạo trong vòng lặp thấy giá trị cuối. Timer `unref`; cleanup gỡ mọi nút.
- **Panel "Beads agents"** (`tree.tsx`, logic ở `agent-tree.ts`, đăng ký sau panel "Beads"): cây Manager → Worker → Reviewer từ `agents.list` (design gốc §7.3), làm mới mỗi `AGENT_TREE_POLL_MS` = 5 000 ms khi panel hiện; agent đã bị thay ghi `<vai> · replaced by <id>`.

## 15. Chat

### 15.1 Paseo cho gì

- `addTimelineTransformer({ query: { itemType }, transform({ item, phase }) })` chạy cho **mỗi** mục chat của **mọi** agent; trả `undefined` giữ mục gốc, trả `{ items }` thay bằng mục `plugin`. Transformer không biết chat thuộc agent nào.
- `addTimelineRenderer({ kind, version, schema, Component })` nhận `agentId` của khung chat, `timestamp`, `theme`, `layout`, **không** có `workspaceId` hay `navigation`.
- Chỉ đổi phần hiển thị; lịch sử ở daemon và thứ model đọc giữ nguyên. Hoàn tác = gỡ hai transformer và renderer trong `index.client.tsx`.

### 15.2 Thẻ chat

Hai transformer `bm-chat-received` (`user_message`) và `bm-chat-sent` (`assistant_message`) gọi `toChatCard(item, phase)`; renderer `CHAT_CARD_KIND` = `"bm-message"`, `CHAT_CARD_VERSION` = 1, `ChatCardView`. `toChatCard` không bao giờ ném.

**Khi nào có thẻ:**

- `user_message` **không** có `clientMessageId` (do agent gửi) và chứa `BM-REPORT`, `BM-REVIEW` hoặc một request id `req-YYYYMMDDTHHMMSSZ`;
- `assistant_message` **đã hoàn tất** (`phase: complete`, để khỏi nhấp nháy khi stream) và chứa `BM-REPORT` hoặc `BM-REVIEW`;
- `user_message` có `clientMessageId` chỉ thành thẻ `reply` khi đó là tin ô Reply của thẻ viết ra (dòng đầu `Reply from the user about …`); lời người dùng tự gõ để nguyên cho Paseo;
- thông báo của chính plugin (tiền tố ở design gốc §7.5) nhận ra theo dòng đầu: `BM-FALLBACK` đọc được `incident` → thẻ `fallback` (§15.8), không đọc được → văn bản; các tiền tố khác → thẻ `notice` (`noticeCardOf`): một dòng tóm tắt thông báo (bỏ tiền tố và `requestId:`), chip `requestId` khi có, toàn văn một chạm; không kiểm mẫu, không có ô Reply.

Khối liệt kê giá trị cho phép (`phase: … | …`) là mẫu định dạng, không phải báo cáo. Mọi mục khác giữ nguyên.

**Dữ liệu** (`chatCardSchema`): `type` (`report` / `review` / `message` / `fallback` / `reply` / `notice`), `direction` (`received` / `sent`), `requestId`, `batchId`, `phase`, `tier`, `verdict`, `blocking`, `blockers`, `beads { created, updated, closed }`, `gist`, `text`, `questions` (§15.3), `formatIssues`, `fallback`, `answers`, `notice`. Thẻ dựng lại từ tin mỗi lần hiện, không lưu ở đâu.

**Ai gửi, ai nhận** (`partiesOf(card, owner, peers)`), dữ liệu từ `chat.peers({ agentId })` → `{ owner, peers, workspaceId }` với `ChatPeer = { id, role, title, status, parentId, requestId, batchId, labelled, archived, replaced }`. `requestId` của Worker lấy từ nhãn, thiếu nhãn thì từ kho lưu vết bằng đúng luật của Metric; kho chỉ được đọc tối đa một lần và chỉ khi thiếu nhãn (`peersOfWorkspace`, `server/chat-peers.ts`).

- Báo cáo nhận được → Worker của request; review nhận được → Reviewer khớp `requestId` và `batchId`; tin khác trong chat Worker → Manager (cha nếu là Manager); trong chat Reviewer → Worker cha; trong chat Manager → Worker của request.
- Tin tự viết: người gửi là chủ khung chat; người nhận là Worker cha (review) hoặc Manager.
- **Worker của request** = `soleWorkerOf(peers, requestId)` (`shared/sole-worker.ts`, dùng chung server và client): agent `worker` **chưa lưu trữ**, không bị thay (`replaced`), mang đúng `requestId`, và là **duy nhất**; không có hoặc nhiều hơn một → không có. `partiesOf` chỉ dùng để gọi tên nên lùi về Worker duy nhất kể cả đã lưu trữ; đường gửi thì không bao giờ.
- Không xác định được thì ghi vai trò kèm "unknown", không đoán id.
- `drawAsCard(card, owner)`: chủ khung chat không phải agent paseo-bm (`owner` null hoặc `unknown`) → sai; thẻ nhận luôn vẽ; thẻ gửi chỉ vẽ khi vai trò chủ khung khớp (review → Reviewer, còn lại → Worker), nên Manager trích một khối thì hiện nguyên văn. Sai → nguyên văn dạng Markdown, không khung thẻ.

**Bố cục:**

- Khung `styles.card`, không viền trái. Hàng tiêu đề: cột trái có `RoleMark` (chỉ biểu tượng mang màu vai trò), tên người gửi (`sectionTitle`, màu `foreground`) `→ <người nhận>`, dòng dưới là giờ gửi `HH:MM`; cột phải căn phải có chip trạng thái (`statusChip`: phase/verdict) và ngay dưới là chip "Answered" khi có.
- **Chip `template error`** (tone `danger`) khi `formatIssues` không rỗng: `checkBlocks(text)` (bộ kiểm mẫu, design gốc §7.6) trên khối của agent khác (thẻ nhận), hoặc trên `BM-REVIEW` của chính Reviewer trong chat nó (Worker trích báo cáo của mình trong chat mình thì chưa gửi gì). Mở toàn văn thì trên cùng là "This message breaks the template:" và từng lỗi một dòng.
- `statusChip`: báo cáo `blocked` → `warning`, `finished` → `success`, phase khác → `info`; review `pass`/`approved` → `success`, `stopped` → `muted`, còn lại `warning`, kèm `· <n> blocking` khi có; thẻ `reply` ghi "Your reply" (`info`); thẻ `notice` ghi thông báo (`muted`).
- Chip `requestId` (tone `muted`) khi thẻ nêu request, rồi một dòng tóm tắt (`summaryOf`), tối đa 2 dòng (`numberOfLines={2}` kể cả khi mở); phần `waiting on: <blockers>` cắt ở `SUMMARY_BLOCKERS_CHARS` = 160 ký tự. Báo cáo có câu hỏi tóm tắt là `<tier> · <n> questions waiting`.
- Bead liên quan: chip bead (§15.7).
- "▸ Show message" / "▾ Hide message" mở toàn văn dạng Markdown (`markdownOf`: khối `key: value` thành danh sách tên trường in đậm; `BM-QUESTIONS`/`BM-ANSWERS` là khối như `BM-REPORT`, dòng `Q<n>:` in đậm, lựa chọn thụt dưới câu).
- **Thẻ `finished`**: `startsOpen(card)` đúng và `outlineTone(card)` = `"success"` chỉ khi `type === "report" && phase === "finished"`, không xét chiều: thẻ mở sẵn toàn văn và khung có `borderColor` success (vẫn `borderWidth: 1`). `open` là state của component, nên thẻ bị gỡ rồi vẽ lại thì mở sẵn lại.

### 15.3 Câu hỏi: `BM-QUESTIONS` và `BM-ANSWERS`

Worker đặt câu hỏi trong khối `BM-QUESTIONS` ngay sau `BM-REPORT`, trong cùng tin `blocked`; `blockers:` chỉ còn trỏ tới khối (luật viết nằm ở `worker.md`):

```
BM-QUESTIONS
requestId: req-20260917T010956Z
Q1: Storage — the request says "save the user list" but not where.
- a: the existing Postgres `users` table: no migration, ready today. (recommended)
- b: a new table: needs a migration, which makes this request Large.
```

Mã `Q<n>` đếm tiếp trong cả request, nên câu trả lời muộn cho lượt cũ không trùng mã câu mới. Câu trả lời:

```
BM-ANSWERS
requestId: req-20260917T010956Z
Q1: a — the existing Postgres `users` table: no migration, ready today.
Q2: other — <lời người dùng, xuống dòng đổi thành dấu cách>
```

**`plugin/shared/bm-questions.ts`** (thuần, client dùng được; tách khỏi `bm-report.ts` để hợp đồng báo cáo không đổi):

```ts
interface QuestionOption { key: string; text: string; recommended: boolean }
interface Question { id: string; text: string; options: QuestionOption[] }
interface QuestionSet { requestId: string | null; questions: Question[] }
function parseQuestions(text: string): QuestionSet | null;          // khối BM-QUESTIONS CUỐI trong tin
type Pick = { key: string } | { other: string };
function answersText(requestId, questions, picks): string;          // ném lỗi khi một câu được truyền thiếu đáp án
```

`parseQuestions` dễ dãi vì đầu vào do model viết: dòng mở `BM-QUESTIONS` chấp nhận `>`, `-`, `**`, rào ```; dòng câu `Q<n>` rồi `:` `.` hay `)` (cả `**Q1:**`, `- Q1:`); lựa chọn phải có gạch đầu dòng hoặc ngoặc (`- a: …`, `- (a) …`, `a) …`, `(a) …`) — văn xuôi `a: …` không phải lựa chọn; `(recommended)`/`[recommended]` bỏ khỏi chữ, hơn một đề xuất trong một câu → coi như không có; dòng thụt ≥ 2 dấu cách nối vào dòng trên; mọi dòng được bỏ tiền tố trích dẫn `>`; khối kết thúc ở dòng mở khối khác, rào đóng (``` hoặc `~~~`), hoặc văn xuôi không thụt **sau** câu đầu tiên (văn xuôi trước câu đầu là lời dẫn, bỏ qua); mã/khoá trùng giữ cái đầu. **Giới hạn:** quét toàn tin từng dòng (một regex neo đầu dòng, không lượng từ lồng nhau, tuyến tính) để tìm dòng mở cuối, rồi chỉ đọc 20 000 ký tự từ đó; tối đa 10 câu × 8 lựa chọn; mỗi đoạn chữ cắt ở 1 000 ký tự. Câu có ít hơn 2 lựa chọn vẫn trả về và chỉ trả lời được bằng "Other".

### 15.4 Thẻ câu hỏi và ô Reply

**Khi nào:** `toChatCard` điền `questions` khi thẻ là `report` và khối có `requestId` trống hoặc bằng `requestId` của báo cáo (khối của request khác bị bỏ). `showsQuestions(card, owner)` đúng khi thẻ `report`, `received`, chủ khung chat là Manager, và có câu hỏi. Chat Worker và Reviewer không có phần này; báo cáo kiểu cũ không có khối thì thẻ như thường.

**Bố cục phần câu hỏi:** mỗi câu một khối (`gap: 6`, `paddingVertical: 8`, từ câu thứ hai có vạch `borderTopWidth: 1` màu `border`); tiêu đề `questionHeading` (`Q6 · Storage`, chủ đề là phần trước ` — ` đầu tiên; không có chủ đề thì `Q6`) in `600`, câu hỏi `styles.body` màu `foreground`; mỗi lựa chọn là một `Pressable` rộng hết thẻ (hàng: `○`/`●` rộng 14, khoá in đậm rộng 16, chữ `flex: 1`, chip `recommended` tone `success` ở cuối; `paddingVertical: 8`, `paddingHorizontal: 10`, `borderRadius: 8`, `borderWidth: 1`; đã chọn: viền `info`, nền `surface2`; `accessibilityRole="button"`, `accessibilityState.selected`); hàng cuối "Other…" (không có khoá) mở ô nhập cho câu đó. Không lựa chọn nào được chọn sẵn: `picks` bắt đầu rỗng. Dưới mọi câu: dòng `Answers go to <Worker> · <requestId>`, dòng lý do (khi có), rồi hàng nút `Use recommendations` (`recommendedPicks`: điền đề xuất cho câu còn trống, không đè, không gửi), `Clear`, `Mark as answered`. Không xác định được người nhận → câu hỏi vẫn hiện; lựa chọn, ô Other, `Use recommendations` và `Clear` tắt (`Mark as answered` vẫn bấm được), kèm lý do. Worker đang chạy **không** làm tắt lựa chọn: người dùng soạn trước được, `sendReply` từ chối lúc bấm Send.

**Lựa chọn viết vào ô Reply** — một đường gửi duy nhất cho mọi thẻ:

- `isAnswered(question, pick)`: khoá có thật của câu có ≥ 2 lựa chọn, hoặc "Other" có chữ sau `trim`.
- `answersDraft(card, picks)` = `answersText` chỉ trên các câu đã trả lời; `""` khi không có câu nào hoặc thẻ không nêu request.
- `withAnswersBlock(text, block)`: vùng khối là dòng `BM-ANSWERS` đầu tiên cộng các dòng liền sau khớp `^\s*(requestId|Q\d+)\s*:`. Chữ người dùng ngoài vùng (trên và dưới) giữ nguyên thứ tự; **khối luôn đứng đầu ô**, một dòng trống, rồi chữ người dùng. Sửa tay bên trong khối bị viết đè ở lần chọn sau.
- Mỗi lần `picks` đổi: `setAnswer(withAnswersBlock(answer, answersDraft(card, next)))` và mở ô Reply.
- Nút **Send** bật khi ô có chữ và không đang gửi, gọi `sendReply({ card, text, refreshPeers, send })` với `refreshPeers` = `peers.refetch({ throwOnError: true })`, `send` = `paseo.agents.ref(id).send(text)` (đường composer của app, tin mang `clientMessageId` như lời người dùng):
  1. ô rỗng → "Write a reply first.", không gọi gì;
  2. đọc lại `chat.peers`; `replyTarget(card, owner, peers)` trả lý do → không gửi;
  3. `send(peer.id, replyText(card, text))` **đúng một lần**, id không bao giờ lấy từ nội dung tin; `replyText` = `Reply from the user about \`<requestId>\`[, batch <id>]:` + dòng trống + chữ;
  4. lỗi của `refreshPeers` hay `send` → lý do; ô và lựa chọn giữ nguyên.
- `replyTarget`: người nhận là `from` (thẻ nhận) hoặc `to` (thẻ gửi) của `partiesOf` và phải có trong `peers`. Lý do chặn: không tìm được ("Cannot tell which Worker asked this: no single Worker has `<requestId>`." cho báo cáo nhận; "Cannot tell which <Role> to send this to." cho thẻ khác); chính mình ("This is your own message."); đã lưu trữ ("<tên> is archived." — tin tới agent lưu trữ sẽ bỏ lưu trữ nó); `running`/`initializing` ("<tên> is working; a message now would replace its turn. Send when it stops."); trạng thái khác ("<tên> is <status>."). Chỉ `idle` và `error` được gửi.
- Gửi xong: "Sent to <tên>.", xoá và đóng ô; nếu `sentSummary(card, picks, text)` khác `null` (khối nằm nguyên trong chữ đã gửi) thì phần câu hỏi thay bằng `Answered at HH:MM → <Worker>: Q6 a, Q7 other` (`answerSummary` chỉ liệt kê câu đã trả lời). Câu chưa trả lời vẫn mở và Worker hỏi lại.
- Báo cáo `blocked` **không** có câu hỏi có hai câu gợi ý điền sẵn (`quickReplies`, không tự gửi); báo cáo có câu hỏi thì không.
- Sau khi đã Reply, nút "Reply to <vai trò>" nhường chỗ cho chip "Answered" (`replyControls(canReply, replied)`: `canReply` sai → không có cả hai); bấm chip mở lại ô Reply.

### 15.5 Câu đang chờ: `chat.waiting` và composer pill

- **Server** (`server/chat-waiting.ts`): với mỗi Manager chưa lưu trữ, chưa đóng, `readTimelinePages(paseo, managerId, { pages: 1, limit: 200 })` rồi `waitingOf(manager, entries, workers, answered)`: lấy `user_message` **không** có `clientMessageId`; báo cáo cuối có `requestId` dạng `req-…` là báo cáo của tin; giữ báo cáo mới nhất mỗi request; chỉ giữ `phase: blocked` có ít nhất một câu hỏi và `requestId` của khối khớp; Worker = `soleWorkerOf` trong cùng workspace, trạng thái `idle` hoặc `error`; câu nào sổ câu hỏi–trả lời đã có đáp án thì vào `answered`, báo cáo đã được trả lời hết thì bỏ. Lỗi đọc một Manager chỉ làm mất Manager đó (`try/catch` quanh `readTimelinePages` được giữ có chủ ý: hàm vẫn có thể ném khi `refetch` không trả gì). Đọc timeline sống, không đọc kho lưu vết: báo cáo chỉ vào kho khi lượt Manager kết thúc, còn pill phải hiện ngay khi câu hỏi tới. Kho lưu vết chỉ được đọc cho workspace **có Manager đang sống** và chỉ khi Worker thiếu nhãn.
- `WaitingWorker = { managerId, workspaceId, workerId, workerTitle, requestId, text, at, answered }`; `text` là nguyên tin báo cáo, để client dựng lại đúng thẻ.
- **Client** (`waiting-pills.tsx`, `waiting-pills-model.ts`): `registerWaitingPills(client)` đọc `chat.waiting` ngay rồi mỗi `WAITING_POLL_MS` = 15 000 ms, không chồng lượt; RPC lỗi thì giữ pill, không báo. `planPills(current, waiting)` → `{ add, update, remove }`; pill id `bm-waiting-<workerId>`, gắn vào composer của chat Manager (`addComposerPill({ id, workspaceId, agentId: managerId, button: { …, behavior: { kind: "popover", Content } } })`; một registration không chuyển chat được, nên đổi Manager thì gỡ rồi thêm lại); không còn câu mở → không có pill; khoá `[managerId, workspaceId, requestId, label, at ?? "", fnv1a32Hex(text), answered]` — có băm nội dung để báo cáo mới cùng số câu (và `at` null) vẫn tới popover. Nhãn `<Worker> · <n> question(s)` (chỉ câu còn mở), title `Questions from <Worker> about <requestId>`, icon `MessageCircleQuestion`. Popover: mỗi pill có **một** `Content` tạo lúc thêm, đọc mục mới nhất từ một `Map` ở module, nên `update` không dựng lại popover đang mở và chữ đang gõ không mất; `Content` vẽ `ChatCardView` với thẻ dựng từ `toChatCard({ type: "user_message", text }, "complete")`, nên có đủ câu hỏi, ô Reply, kiểm trạng thái, chip "Answered". Không có API cuộn chat tới một mục.
- Giới hạn: chỉ 200 mục mới nhất của timeline Manager; báo cáo `blocked` cũ hơn thế trông như "không còn chờ" và không có pill, nhưng vẫn trả lời được bằng ô Reply của thẻ.

### 15.6 Trạng thái "đã trả lời"

- **Trong phiên app** (`answer-state.ts`, không React): bảng `answered` (khoá → `{ at, summary, to }`) và `replied` (khoá → `Date`), `setAnswered`/`setReplied` báo mọi người nghe (`subscribeAnswers`), `answersVersion()` là snapshot; `chat-card.tsx` đọc bằng `useSyncExternalStore`, nên bản trong chat và bản trong popover vẽ lại cùng lúc. Tải lại app thì mất.
- **Khoá** `answeredKey(agentId, card)` = `<chat agentId>|<requestId>|<các mã câu>` — không băm nội dung tin: báo cáo gửi lại với một trường sửa không được sinh thẻ trống thứ hai cho câu đã trả lời. Đổi lại, hai bộ câu khác nhau dùng lại cùng mã trong một request sẽ trùng khoá (Worker đếm tiếp mã nên việc này không nên xảy ra).
- **Dấu "Mark as answered"** lưu bền (`server/answer-marks.ts`): `<install home>/ui/answer-marks.json` = `{ schemaVersion: 1, marks: [{ key, at }] }`; khoá 1–`ANSWER_MARK_KEY_MAX` (400) ký tự, không ký tự điều khiển; giữ tối đa `ANSWER_MARKS_LIMIT` = 500 dấu mới nhất. Đọc/ghi qua bộ kiểm no-follow và ghi nguyên tử như kho lưu vết (§3.8). File hỏng hay đời mới hơn đọc như rỗng kèm `notices`; khoá hỏng trong file bị bỏ kèm `notices`; khoá sai hay file đời mới hơn khi ghi → `E_TRACE_STORE_UNWRITABLE`. Nút gọi `answers.mark` rồi ghi kết quả vào cache `answer-marks`; lỗi hiện trên thẻ.
- **Thẻ tự biết đã trả lời** (chỉ thẻ `showsQuestions`): `useQuery(["paseo-bm", "chat-waiting"], refetchInterval 15 000)` và `answers.marks`, dùng chung cache nên một lần đọc cho mọi thẻ. `stillWaiting` = có mục cùng `managerId`, `requestId` và nguyên văn tin. `answeredHow({ sent, marked, waiting, stillWaitingNow })`: `sent` → "sent" (`Answered at … → …`); `marked` → "marked" ("Marked as answered."); `waiting` đã biết mà thẻ không còn chờ → "moved-on" (`Answered, or <Worker> is working or has reported since.`); `waiting` chưa biết → không suy ra gì. Đã trả lời thì chip "Answered" hiện và nút Reply ẩn.
- **Câu sổ câu hỏi–trả lời đã có đáp án** (`answered` của mục `chat.waiting`): hiện "Answered." (tone `success`) thay cho các lựa chọn, không chọn được; `Use recommendations` bỏ qua nó; lựa chọn đã chọn trước cho câu đó bị gỡ khỏi khối `BM-ANSWERS` trong ô Reply.

### 15.7 Bead trong chat

- **Chip bead trên thẻ:** `shared/bead-ids.ts` tìm chuỗi có dạng id bead (bỏ request id, đường dẫn, cờ lệnh, URL). `BeadChips` nhận **mọi** ứng viên (≤ 100), tra `beads.lookup` (chỉ giữ id có thật, nên `feature-workflow` hay `BM-REPORT` không bao giờ thành chip), **rồi** mới cắt: `beadChipsView(found, expanded)` dùng `visibleBeads` với `BEAD_CHIPS_SHOWN` = 2; phần còn lại sau chip "…" (tone `muted`, nhãn "Show all N beads"), bấm để mở rộng, không có nút thu. Không bead nào có thật → không vẽ gì. Chip ghi `beadChipText` (`<tên, ≤ 48 ký tự> · <id>`), tone theo `statusBadge`; bấm mở chi tiết ngay trong thẻ (`BeadInline`, dùng lại `BeadDetailPanel` với ba hành động). `chat.peers` trả `workspaceId` để biết tra kho nào.
- **Panel "Beads in this chat"** (`addWorkspacePanel`, `id: "bm-chat-beads"`, `context: "agent"`): câu hỏi thường của Worker là văn bản chat, và đổi chúng thành thẻ sẽ đổi cả chat của agent khác, nên bead được gom ở panel. `chat.beads` đọc `CHAT_BEADS_PAGES` = 2 trang × `CHAT_BEADS_PAGE_SIZE` = 200, tức 400 mục mới nhất, lấy id từ tin nhắn và lệnh shell, chỉ giữ id có thật, đếm số lần nhắc, sắp theo lần nhắc gần nhất, tối đa `CHAT_BEADS_LIMIT` = 30. Panel làm mới mỗi 15 s; dòng là `BeadRowCard`, không nhóm, không nút mắt.
- Mọi RPC chat ở `server/chat-rpc.ts` (`registerChatRpcs`), tách khỏi `dashboard-rpc.ts`; vòng đọc timeline dùng chung là `readTimelinePages` (`live-timeline.ts`).

### 15.8 Sự cố dự phòng: thẻ và pill

Luật phát hiện sự cố, ứng viên, `BM-FALLBACK` và `fallback.incidents` / `fallback.act` ở design gốc §7.10; đây chỉ là phần hiện ra.

- **Thẻ** (`fallbackCardOf`: dòng đầu đúng `BM-FALLBACK` và đọc được `incident`). Thẻ chỉ giữ id sự cố; trạng thái, ứng viên, giờ reset lấy từ `fallback.incidents({ ids })`, khoá `["paseo-bm", "fallback-incident", id]` dùng chung với popover của pill, đọc lại mỗi `WAITING_POLL_MS` khi `pending`/`waiting` — chữ của tin không bao giờ là trạng thái.
- **Bố cục:** `RoleMark` + "<Vai> stopped by its provider plan", giờ, chip trạng thái (`pending` → `warning`; `switched`/`resumed` → `success`; `waiting` → `info`; `dismissed`/`expired` → `muted`; `exhausted`/`failed` → `danger`); chip `requestId`; dòng `Usage limit (L1) | Billing (L2) | Login (L4) | Provider unavailable (L5) · <alias> · <model>`; lời provider (mono, 3 dòng).
- **Nút, chỉ khi `pending`:** "Switch to <alias> · <Provider> · <model>[ · ~$in / $out per 1M tokens]" khi có ứng viên (giá: `MODEL_PRICES` rồi `roles.options`); "Wait until <giờ máy>" khi `resetsAt` cách không quá `FALLBACK_MAX_WAIT_MS` (7 ngày), đã qua thì "Resume now (the limit reset at …)"; "I'll handle it" luôn có. Reviewer `switched` chưa có `replacementId` → chỉ "Resend to Worker". Mỗi nút một `fallback.act`; kết quả là trạng thái mới; lỗi → "Could not <việc> (<mã>): …" rồi đọc lại.
- Hết `pending` → một dòng trạng thái (`fallbackStatusLine`); Manager `switched`: "A new Beads Manager is running on … Open Beads Manager from the sidebar or Command Center to continue with it."
- **Pill:** mỗi Manager có sự cố `pending` (từ `chat.waiting.fallback`) một pill `bm-fallback-<managerId>`, icon `FALLBACK_PILL_ICON` = `TriangleAlert`, nhãn `Fallback · <n> decision(s)`, title "An agent stopped by its provider plan waits for your decision" (nhiều: "<n> agents stopped by their provider plan wait for your decision"). Popover vẽ một thẻ cho mỗi sự cố (`fallbackCardOfIncident`), cũ nhất trước, đủ nút. Chung vòng đọc `chat.waiting` và `planPills` với pill câu hỏi; khoá gồm Manager và id các sự cố.

## 16. Hiệu năng

| Chỗ | Cách |
|---|---|
| Ghi lưu vết | Một `write` + `fsync` mỗi lượt; mục tiêu dưới 50 ms; lỗi không bao giờ chặn agent |
| Đọc lưu vết | Theo file tháng, mới tới cũ, dừng khi đủ `limit` (50); cache `mtime`+`size` |
| Timeline | Chỉ đọc bù lượt đang chạy, hoặc khi kho tắt; trần 2 000 entry mỗi agent mỗi lần |
| Kho beads | Trần 32 MB; cache `(path, mtimeMs, size)` |
| Client | `useQuery` với khoá có `workspaceId`; chi tiết trace chỉ tải khi mở; các nhịp polling ở §2.4, không cái nào chạy khi màn của nó không hiện (trừ pill và nút header, vốn gắn với app) |

## 17. Security & Privacy

- **Ranh giới ghi:** `<install home>/traces/**`, `<install home>/ui/**`, `<install home>/role-extras.json`. Không ghi vào workspace, `~/.paseo`, thư mục skills, `install.json`. **(0.4.0)** Thư mục dữ liệu (design gốc §5.1) thay `<install home>`; thêm `ui/setup-state.json`; cấu hình Paseo chỉ qua `config.patch` của design gốc §6.2; xoá chỉ qua `setup.cleanup` và chỉ các mục design gốc §7.13.7 liệt kê.
- **Đọc đĩa ngoài phần của mình:** `<workspace>/.beads/issues.jsonl`, `<install home>/install.json` (chỉ để xác nhận thư mục cài đặt; **(0.4.0)** chỉ để biết nó tồn tại, cho banner chuyển đổi), `role-fallback-state.json` của plugin, và thư mục skill (chỉ `SKILL.md`, cho màn Setup). **(0.4.0)** Thêm `~/.paseo-bm/home.json` (con trỏ).
- **Che bí mật trước khi ghi**, không chỉ trước khi render: quy tắc lấy từ `src/redact.ts`, plugin có bản sao hằng số vì không import `src/`.
- Không ghi `env`: bộ thu thập không dùng hook `agent.create`.
- Quyền: thư mục `0700`, file `0600`.
- Xoá là quyền của người dùng: không đường nào tự xoá trace; lệnh gỡ phải hỏi.
- Màn Metric nói rõ nó hiện và lưu hội thoại agent.
- **Không mạng** ở mọi luồng dashboard. Ngoại lệ có chủ ý: `setup.install-tool` chạy trình cài tải từ mạng, chỉ khi người dùng bấm và xác nhận nguyên văn lệnh (`confirmed: true` bắt buộc ở schema); script `bv` ghim commit, script `br` tự kiểm SHA256. **(0.4.0)** Ngoại lệ thứ hai cùng luật: `setup.install-skills` chạy CLI `skills` (tải từ npm và GitHub); `providers.diagnostic` là daemon hỏi provider của nó, không phải plugin ra mạng.
- Màn Beads và thẻ chat **gửi tin cho agent** (hành động bead, Reply): luôn qua xác nhận hoặc nút gửi tường minh, luôn đọc lại trạng thái người nhận, không bao giờ gửi tới agent đang chạy hay đã lưu trữ. Màn Metric không tạo, dừng hay gửi gì cho agent.

## 18. Reliability

- Agent bị lưu trữ hoặc xoá → trace giữ đủ phần đã lưu; `agentsMissing` kèm notice.
- Ghi lưu vết lỗi → bỏ qua, log một dòng, Dashboard hiện "có thể thiếu trace".
- Kho có `schemaVersion` mới hơn → đọc hạn chế, không ghi.
- File lưu vết hỏng một dòng → bỏ đúng dòng đó, đếm vào `skippedLines`.
- `reset`, `gap`, `staleCursor` từ timeline → đọc lại một lần và gắn notice.
- Host thiếu API timeline hay hook `before`/`on` → tắt đúng phần đó kèm thông báo. Host thiếu `navigation.openAgent` → các nút "Open …" tự ẩn.
- RPC lỗi → mỗi màn hiện dòng đỏ kèm mã và nút Refresh; phần còn lại (kể cả hàng tab con) vẫn dùng được.

## 19. Chiến lược kiểm thử

| Tầng | Nguyên tắc |
|---|---|
| Logic | Mọi quyết định ở module thuần (`*-model.ts`, `chat-cards.ts`, `dashboard-view.ts`, `slot.ts`, `shared/*`, `server/*`), test bằng Vitest không cần renderer. Mỗi tiêu chí hành vi có một đối chứng âm đã chạy đỏ |
| View | View không hook dựng bằng `test/helpers/element-tree.ts`; chỗ đặt (ví dụ dải trạng thái ở mọi view) kiểm bằng assert trên mã nguồn. File trong `test/` không import `react-native` như một giá trị |
| Kho | Ghi rồi đọc lại; trùng khoá kể cả turn id dùng lại và bản ghi lại đóng dấu giờ ghi; dòng hỏng, dòng cuối ghi dở; symlink ở mọi cấp bị từ chối và đích không đổi một byte; barrier cho ghi đồng thời với xoá/gán lại |
| Hợp đồng | Danh sách RPC chính xác trong `test/plugin-bundle-cjs.test.ts` và `test/rpc-list-describe.test.ts`; client entry không import `server/`, `shared/` không import Node |
| Phủ định | Không ghi ngoài ranh giới §17, không mạng, Metric không gọi hàm ghi nào của SDK |
| Dữ liệu thật | Bộ đọc được thử trên chuỗi agent thật viết; nghiệm thu trên daemon thật ghi run record ở `docs/operations/`. Phần nhìn (màu, bố cục, cử chỉ) do owner kiểm trên daemon thật, desktop và điện thoại |

## 20. Tương thích

- Bản mới đọc kho của bản cũ; bản cũ gặp kho mới hơn thì đọc hạn chế, không ghi. Cập nhật phiên bản **không** xoá kho, kể cả `--prune`.
- Trường thêm vào payload (`errors`, `usageByModelRole`, `usageByModel`, `runtime`, `labelled`, `replaced`, `answered`, …) luôn tuỳ chọn hoặc có mặc định.
- Agent tạo bởi bản trước (không nhãn `bm.requestId`) vẫn hiện, ở mức `inferred`.
- Bộ đọc `BM-REPORT` đọc được định dạng hiện tại và trước đó; báo cáo không có `BM-QUESTIONS` cho thẻ như thường. Chỉ dẫn gắn lúc tạo agent, nên Manager/Worker cũ và plugin mới vẫn hiểu nhau: thẻ vẫn có nút vì thẻ là mã plugin.

## 21. Câu hỏi mở

| ID | Câu hỏi | Ảnh hưởng |
|---|---|---|
| Q-042 | Ngưỡng dung lượng chỉ có phạm vi toàn máy vì Paseo chỉ có `scope: "host"`; có cần ngưỡng theo workspace (tự lưu trong `meta.json`) không? | §3.6 |

## 22. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-26 | hieu.nt10 (soạn bởi Claude) | §11.2: dòng lỗi của launcher (và "Could not load …" của cây agent) hiện thông điệp của server không kèm lớp vỏ `Request failed: … requestType=… code=…` mà app nhận từ `DaemonRpcError`, và không lặp mã; trước đây `errorCodeOf` không bao giờ tách được mã trong app |
| 2026-09-26 | hieu.nt10 (soạn bởi Claude) | §11.3: câu trạng thái của tool agent khi tắt thành "Off — no new Beads Manager starts until you allow them", vì từ 0.4.0 `manager.ensure` không tạo Manager khi công tắc tắt (design gốc §7.3); câu cũ nói Manager "may not be able to create a Worker" không còn đúng |
| 2026-09-25 | hieu.nt10 (soạn bởi Claude) | **ADR-012: một nguồn duy nhất — thiết lập máy chuyển lên Setup (bản đích 0.4.0).** §11.3: gọi `setup.ensure-roles` khi mở màn, dòng "created its roles with defaults", banner chuyển đổi, thẻ "Set up paseo-bm" với năm dòng (vai trò, tool agent kèm cảnh báo toàn máy, skills kèm lưu ý bên thứ ba, `br`/`bv`, đăng nhập chỉ hiện lệnh), nút "Install skills…" trên tab skills, khối tool agent và đăng nhập trên "Roles & models", khối "This install" với thư mục dữ liệu và nút "Remove paseo-bm's settings…" có xác nhận thứ hai cho dữ liệu (mặc định giữ). §3.1 trỏ tới thư mục dữ liệu mới; §5 thêm bốn RPC và năm mã lỗi (hợp đồng ở design gốc §7.13); §11.2 `setupNotice`; §1, §2.1, §2.4, §17 cập nhật. §21: bỏ Q-039 (đã trả lời ở ADR-012 QĐ6). Vẫn ba tab, đúng REQ-069 (f). Rà soát `design-ready` độc lập cùng ngày: §11.3 thêm câu trạng thái nguyên văn cho từng dòng của thẻ "Set up paseo-bm" (dùng lại câu sẵn có của `setupHeadline` và khối tool agent) |
| 2026-09-25 | hieu.nt10 (soạn bởi Claude) | Rà soát sau khi gộp: đối chiếu từng delta ở bảng Lịch sử, phần giao diện của bốn delta gốc (17e, 18, 21, qa-ledger) và REQ-059 với code. Thêm: màn "Roles & models" và chuỗi dự phòng (§11.3), chấm đang chạy và dòng trạng thái mở Manager (§11.2, §11.4), dòng model trên graph (§12), thẻ và pill sự cố dự phòng (§15.8), thẻ `notice`, chip `template error`, `statusChip`, `drawAsCard` (§15.2), panel "Beads agents" (§14), luật đếm bead và đọc id rút gọn `.N` (§6.3, §6.4), `managerRequestId` và id `req-…` viết trần (§6.1, §6.3), ảnh hưởng của sổ hỏi–đáp lên thẻ (§15.6), lý do chọn vân tay chữ (§3.3). Sửa theo code: `chat.beads` đọc 400 mục, `agents.list` lấy mọi agent rồi `roleOfAgent`, `close_with_evidence` exact không cần kho xác nhận, thứ tự và phần bị tắt dưới câu hỏi, `StatusTabs` có màu nút, `chat.waiting.fallback`, phạm vi §1 (giao diện Roles & models và dự phòng thuộc tài liệu này). Ghi rõ chưa có nút tải thêm (§12) |
| 2026-09-25 | hieu.nt10 (soạn bởi Claude) | **Gộp thành tài liệu sống.** Gộp 11 delta ở bảng Lịch sử vào đây, viết lại theo màn hình/thành phần và theo mã hiện tại (§2.4, §11–§15 mới; §3.3, §3.6, §4, §5, §6, §8 cập nhật theo code); bỏ §14 cũ "Ảnh hưởng tới tài liệu đã đóng băng" và các giả định A-1, A-2 (đã kiểm: báo cáo tới Manager là `user_message`; bộ thu thập gọi `timeline.refetch` để lấy timestamp). Từ nay sửa tại chỗ |
| 2026-09-25 | hieu.nt10 (soạn bởi Beads Worker) | Theo delta kanban-quiet-colours: kanban bốn cột, trạng thái bead nói bằng chữ và độ tương phản, ba tab cho Setup, `TraceSummary.errors` và thẻ Errors |
| 2026-09-19 | hieu.nt10 (soạn bởi Beads Worker) | Theo delta 20260918e batch `b6`: nút header `bm-beads-open`; app mobile của Paseo 0.8 không có "+" |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Theo delta 20260918f: rà soát UI — ô chờ `createSlot`, yêu cầu mở Manager không rơi, dải trạng thái trên Metric/Beads, số liệu workspace chỉ đọc khi danh sách hiện, chip bead tra trước khi cắt, `chat.peers.archived`, `soleWorkerOf`; gỡ tính năng ghim (`launcher.order.*`) |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Theo delta 20260918e: panel `bm-beads` với hai tab con; Setup là màn chính; bốn nhóm, nút mắt, `doneText`; bỏ biểu đồ 14 ngày |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Errata theo delta 20260918 (manager-mode-model-metrics): `runtime` trong bản ghi, `usageByModelRole`, `usageByAgent[].runtime`, `usageByModel`; gộp theo model hiệu lực |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | Theo delta 20260917e: tách request thành đoạn theo lượt người dùng hỏi; `workspaces.overview.runningAgents` |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | Errata theo delta 20260917d: khoá chống trùng thêm vân tay nội dung lượt; lượt Manager vô danh chỉ gộp trong cùng Manager |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | Bản 5 sau nghiệm thu trên daemon thật (delta acceptance-fixes): tám luật đọc lại trace |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | Owner duyệt; `design-ready` PASS; Draft → Active |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | Bản 2–4: lưu vết bền trên đĩa, xoá, gán lại, bộ kiểm đường dẫn no-follow và mutex theo workspace (sau review độc lập bằng Codex) |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | Bản Draft đầu tiên |

## Lịch sử

Các delta đã gộp vào tài liệu này. File nằm ở `docs/archive/` (mã nguồn trích chúng theo tên và mục) nhưng chỉ là hồ sơ lịch sử; hiện trạng là tài liệu này.

| Delta | Ngày | Đưa vào |
|---|---|---|
| [delta-20260916-acceptance-fixes](../archive/design/paseo-bm-delta-20260916-acceptance-fixes.md) | 2026-09-16 | Tám luật đọc lại trace sau nghiệm thu thật: bucket theo `requestId`, chi phí luôn tạm tính, id bead chỉ ở tham số vị trí, chỉ báo cáo cuối quyết định trạng thái, phủ định chính xác của polish, bản ghi của agent đã xoá vẫn thuộc request |
| [delta-20260916-beads-screen](../archive/design/paseo-bm-delta-20260916-beads-screen.md) | 2026-09-16 | Màn Beads, `beads.list/get/action`, ba hành động giao việc qua Manager, `E_BEAD_NOT_FOUND` |
| [delta-20260916-chat-cards](../archive/design/paseo-bm-delta-20260916-chat-cards.md) | 2026-09-16 | Thẻ chat cho tin giữa Manager, Worker, Reviewer; `chat.peers`; chip bead, `beads.lookup`, panel "Beads in this chat" |
| [delta-20260916-owner-feedback](../archive/design/paseo-bm-delta-20260916-owner-feedback.md) | 2026-09-16 | Metric dạng thẻ + biểu đồ + graph; `origin` và bằng chứng `skill`; icon vai trò; thư mục worktree; ai đang làm bead; `workspaces.overview`; `store` chỉ còn byte (phần chỉ dẫn vai trò không gộp ở đây) |
| [delta-20260916-setup-screen](../archive/design/paseo-bm-delta-20260916-setup-screen.md) | 2026-09-16 | Màn Setup: chỉ dẫn thêm từng vai, kiểm skill, `br`/`bv` và nút Install (phần CLI `--install-beads-tools` không gộp ở đây) |
| [dashboard-delta-20260917d-request-attribution](../archive/design/paseo-bm-dashboard-delta-20260917d-request-attribution.md) | 2026-09-17 | Chống trùng thêm vân tay nội dung lượt; lượt Manager vô danh chỉ gộp trong cùng Manager |
| [delta-20260917e-manager-screen-and-commands](../archive/design/paseo-bm-delta-20260917e-manager-screen-and-commands.md) (phần giao diện; phần còn lại ở design gốc) | 2026-09-17 | Tách request thành đoạn, `runningAgents` và chấm đang chạy, thông báo slash command trên dải trạng thái; bỏ ghim |
| [delta-20260918-manager-mode-model-metrics](../archive/design/paseo-bm-delta-20260918-manager-mode-model-metrics.md) (phần số liệu model) | 2026-09-18 | `runtime`, `usageByAgent[].runtime`, `usageByModel`, `usageByModelRole`, dòng model trên graph, `modeNotice` trên dải trạng thái |
| [delta-20260918c-question-cards](../archive/design/paseo-bm-delta-20260918c-question-cards.md) | 2026-09-18 | Khối `BM-QUESTIONS` / `BM-ANSWERS`, bộ đọc `bm-questions.ts`, thẻ câu hỏi trong chat Manager (luật viết của `worker.md`/`manager.md` không gộp ở đây) |
| [delta-20260918d-card-replies](../archive/design/paseo-bm-delta-20260918d-card-replies.md) | 2026-09-18 | Một đường gửi `sendReply` cho mọi thẻ, lựa chọn viết vào ô Reply, bố cục câu hỏi, chip "Answered", `chat.waiting` và pill, "Mark as answered", thẻ `finished` mở sẵn (phần `manager.md` không gộp ở đây) |
| [delta-20260918e-beads-tab](../archive/design/paseo-bm-delta-20260918e-beads-tab.md) | 2026-09-18 | Tab "Beads" với hai tab con, Setup là màn chính, dải trạng thái, nút mắt, `doneText`, nút header |
| [delta-20260918f-ui-review](../archive/design/paseo-bm-delta-20260918f-ui-review.md) | 2026-09-18 | Rà soát UI: `createSlot`, yêu cầu mở Manager không rơi, `WorkspaceScreenHeader`, `overviewPolling`, gỡ tính năng ghim, chip bead tra trước khi cắt, `soleWorkerOf` và `archived`, pill không dựng lại popover |
| [delta-20260921-worker-fallback-and-role-settings](../archive/design/paseo-bm-delta-20260921-worker-fallback-and-role-settings.md) (phần giao diện) | 2026-09-21 | Màn "Roles & models" và chuỗi dự phòng, thẻ và pill sự cố dự phòng, `replaced by` ở panel "Beads agents", cột skill Pi/OpenCode |
| [delta-20260924-qa-ledger](../archive/design/paseo-bm-delta-20260924-qa-ledger.md) (phần giao diện) | 2026-09-24 | `answered` trên pill và thẻ câu hỏi |
| [delta-20260925-kanban-quiet-colours](../archive/design/paseo-bm-delta-20260925-kanban-quiet-colours.md) | 2026-09-25 | Kanban bốn cột co giãn, trạng thái bead bằng chữ và độ tương phản, ba tab cho Setup, `errors` và thẻ Errors ở Metric, `beadActionResults` |
