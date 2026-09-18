# paseo-bm — Dashboard điều phối (Technical Design)

| Trường | Giá trị |
|---|---|
| Status | **Active** (bản 4, duyệt 2026-09-16) — cổng `design-ready` PASS |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Created | 2026-09-16 |
| Requirements source | [PRD Dashboard điều phối](../product/paseo-bm-dashboard-prd.md) (REQ-040 → REQ-057) |
| Design gốc | [paseo-bm — Technical Design](./paseo-bm.md) (Active) — tài liệu này **mở rộng**, không thay thế |
| Related ADRs | [ADR-007](../adr/ADR-007-dashboard-trace-store.md) (Proposed — kho lưu vết) · [ADR-002](../adr/ADR-002-install-ownership-model.md) (quyền sở hữu trong thư mục cài đặt) · [ADR-005](../adr/ADR-005-manager-as-agent.md) (vòng đời agent thuộc người dùng) · [ADR-006](../adr/ADR-006-role-registration.md) |
| Môi trường tham chiếu | `@getpaseo/plugin` 0.8.0, `@getpaseo/client` 0.8.0, `@getpaseo/protocol` 0.8.0; Paseo CLI/daemon 0.8.0; Node ≥ 22 |

## 1. Boundaries

- **Design này sở hữu:** năm RPC mới và hợp đồng Zod của chúng; **kho lưu vết** (vị trí, bố cục, lược đồ, ghi, đọc, xoá, đo dung lượng); bộ thu thập bám hook vòng đời; thuật toán nhóm trace theo yêu cầu; bộ đọc `BM-REPORT` và `BM-REVIEW`; cách đo thời gian; cách suy ra bước feature-workflow kèm độ chắc chắn; bộ đọc `.beads/issues.jsonl`; cách tính token và chi phí; các module client của Dashboard; mã lỗi mới; chiến lược kiểm thử của tính năng.
- **Design này KHÔNG sở hữu:** nội dung `roles/*.md` (thuộc design gốc §2.5, §2.6 — tài liệu này chỉ **yêu cầu thêm hai nhãn** theo REQ-051 và **đọc** khối `BM-REPORT`); trình cài đặt và lệnh gỡ (chỉ nêu yêu cầu, xem §14); cách tạo agent; định dạng `install.json`; nội bộ Paseo; định dạng dữ liệu của `br`; bảng giá của provider.
- **Không đổi gì đang chạy:** ba RPC hiện có (`manager.ensure`, `agents.list`, `roles.describe`), surface và panel hiện có giữ nguyên hành vi.

## 2. Architecture

### 2.1 Module

```
plugin/
  index.client.tsx
    client/launcher.tsx        màn hình Beads Manager: thêm nút "Dashboard"
    client/dashboard.tsx       (mới) màn hình Dashboard, chỉ render
    client/dashboard-model.ts  (mới) logic + text + style, không JSX, test được
    client/settings.tsx        (mới) màn hình cài đặt plugin: ngưỡng cảnh báo dung lượng
  index.server.ts              + 4 RPC mới + 1 bộ thu thập
    server/collector.ts        (mới) hook turn_started/turn_ended → ghi lưu vết
    server/trace-store.ts      (mới) đọc/ghi/xoá/đo kho lưu vết
    server/install-home.ts     (mới) tìm thư mục cài đặt từ cấu hình Paseo
    server/traces.ts           (mới) dựng trace từ kho lưu vết + agent + timeline
    server/bm-report.ts        (mới) đọc khối BM-REPORT / BM-REVIEW
    server/workflow-steps.ts   (mới) suy ra bước quy trình + bằng chứng
    server/beads-store.ts      (mới) đọc .beads/issues.jsonl, tính thống kê
    server/cost.ts             (mới) token → chi phí, theo bảng giá có ngày
    shared/contracts.ts        + hợp đồng Zod của 4 RPC mới
    shared/prices.ts           (mới) bảng giá đi kèm bản phát hành + pricesUpdatedAt
    shared/settings.ts         (mới) defineSettings: ngưỡng cảnh báo, version 1
```

Cách chia bám đúng khuôn đang có: phần thuần (`dashboard-model.ts`) test được không cần renderer như `client/launch-manager.ts`; mỗi module server nhận một **cửa sổ hẹp, tiêm được** của `PaseoApi` và của hệ thống file, như `ManagerPaseo` trong `server/manager.ts`.

### 2.2 Ba quyết định nền

1. **Thu thập theo sự kiện, đọc bù khi mở.** Bộ thu thập bám `on("agent.turn_ended")` (và `turn_started` để lấy mốc bắt đầu) của các agent `bm-*`, ghi ngay vào kho lưu vết. Đây là **hook sự kiện**, không phải cron, watcher hay vòng lặp nền — plugin đã dùng đúng hook này cho việc lan truyền lệnh dừng (bm-wq6), nên ràng buộc "không tác vụ nền" của design gốc §8 vẫn giữ. Khi người dùng mở Dashboard, phần lượt **đang chạy** được đọc bù trực tiếp từ timeline; phần đã xong lấy từ kho.
2. **Lưu vết bền, người dùng xoá được** (ADR-007, REQ-053 → REQ-056). Lý do: vòng đời agent thuộc người dùng (ADR-005), nên nếu chỉ dẫn xuất lúc đọc thì việc người dùng xoá một Worker sẽ xoá luôn lịch sử công việc. Cái giá là paseo-bm bắt đầu **ghi dữ liệu hội thoại lên đĩa**, và cái giá đó được trả bằng ba thứ bắt buộc: che bí mật trước khi ghi, quyền `0600`, và một đường xoá tường minh.
3. **Không chắc thì nói không rõ.** Mỗi con số suy luận đi kèm một trường độ chắc chắn được render ra giao diện.

### 2.3 Luồng dữ liệu

```
AGENT CHẠY (không có người dùng nào đang xem)
  hook turn_started(agent bm-*)  → ghi mốc bắt đầu lượt
  hook turn_ended(agent bm-*)    → che bí mật → nối bản ghi vào
                                    <install home>/traces/<workspaceId>/events-<YYYYMM>.jsonl

NGƯỜI DÙNG MỞ DASHBOARD
  rpc beads.stats  { workspaceId }        → đọc <workspace>/.beads/issues.jsonl (cache mtime+size)
  rpc traces.list  { workspaceId, … }     → đọc kho lưu vết + agents.list (trạng thái hiện tại)
  rpc traces.get   { workspaceId, traceId }→ kho lưu vết + đọc bù timeline cho lượt đang chạy
  rpc traces.delete{ workspaceId, … }     → xoá trong kho lưu vết, không chạm gì khác
```

`traces.list` không đọc timeline khi mọi trace của trang đó đã hoàn tất trong kho — đây là điều giữ D-1 (≤ 3 giây) khả thi kể cả khi kho đã lớn.

## 3. Kho lưu vết

### 3.1 Tìm thư mục cài đặt

Bundle server **không có cwd** và không đọc được `import.meta.url` (errata bm-dnc), lại phải chịu được việc người dùng đổi thư mục cài đặt bằng `--home` hoặc `PASEO_BM_HOME`. Thứ tự giải quyết, dừng ở bước đầu tiên thành công:

1. `paseo.config.get()` → `config.plugins["paseo-bm"]` là `{ source: "directory", path }`. Đường dẫn đó là `<install home>/plugin/<version>`, nên `<install home>` = `dirname(dirname(path))`.
2. Xác nhận bằng sự tồn tại của `<install home>/install.json` và `schemaVersion` đọc được. Không khớp → sang bước 3.
3. Dự phòng `~/.paseo-bm`. Vẫn không có `install.json` → tính năng lưu vết **tắt** kèm một thông báo trên Dashboard; phần đọc thống kê beads vẫn chạy.

`install.json` chỉ được **đọc** (nó không chứa bí mật, theo design gốc §3.2); plugin không bao giờ ghi vào nó.

### 3.2 Bố cục

```
<install home>/traces/                     0700
  meta.json                                0600   { schemaVersion, createdAt, updatedAt }
  <workspaceId>/                           0700
    meta.json                              0600   { lastKnownName, lastKnownDirectory, lastSeenAt }
    events-202609.jsonl                    0600   nối thêm, một bản ghi một dòng
    events-202610.jsonl
```

- **Tách theo `workspaceId`** để xoá theo workspace là xoá một thư mục, để gán lại là di chuyển một thư mục, và để không phải đọc dữ liệu của workspace khác.
- **`meta.json` của mỗi workspace** ghi tên và đường dẫn lần cuối paseo-bm thấy workspace đó, cùng `lastSeenAt`. Đây là thứ duy nhất giúp người dùng nhận ra một `workspaceId` không còn trong Paseo là repo nào (REQ-057a). Bộ thu thập cập nhật nó mỗi khi ghi một lượt, và chỉ khi giá trị đổi.
- **Tách theo tháng** để xoá theo mốc thời gian phần lớn là xoá cả file, và để một file không lớn vô hạn.
- **`schemaVersion`** bắt đầu từ `1`. Bản cao hơn mức hiểu được → đọc ở chế độ hạn chế (chỉ những trường đã biết), hiện thông báo, và **không ghi thêm** vào kho đó (`E_TRACE_STORE_SCHEMA_TOO_NEW`). Không bao giờ ghi đè dữ liệu của bản mới hơn.

### 3.3 Bản ghi

Một dòng JSON, đã che bí mật, mỗi dòng độc lập (file hỏng một dòng vẫn dùng được phần còn lại):

```
{ v: 1, at: ISO, workspaceId, agentId, role, turnId | null,
  kind: "turn",
  requestId | null, parentAgentId | null, agentCreatedAt,
  startedAt, endedAt, outcome: "completed"|"failed"|"canceled",
  sent:    [{ at, text }],            // user_message của lượt, đã cắt và che
  received:[{ at, text }],            // assistant_message của lượt, đã cắt và che
  reports: [ <BM-REPORT đã đọc> ],    // gồm cả unparsedFields
  reviews: [ <BM-REVIEW đã đọc> ],
  evidence:[ <evidence>… ],           // lệnh br, file đã ghi, dấu vết sub_agent
  usage:   { inputTokens, cachedInputTokens, outputTokens, totalCostUsd | null, model | null } | null }
```

*Errata 2026-09-18 ([delta 20260918](paseo-bm-delta-20260918-manager-mode-model-metrics.md) §4.2):* bản ghi có thêm trường **tuỳ chọn** `runtime: { model, thinkingOptionId, modeId } | null` — thứ agent **thật sự chạy** ở lượt đó, lấy từ snapshot của `timeline.refetch`: `runtimeInfo` trước, trường cấu hình (`model`, `effectiveThinkingOptionId` → `thinkingOptionId`, `currentModeId`) chỉ để dự phòng; `null` khi không đọc được snapshot. Là trường cộng thêm: `v` và `schemaVersion` vẫn là 1, không di trú; bản cũ đọc bản ghi mới thì bỏ qua nó. `usage.model` giữ nguồn cũ.

Quy tắc ghi:

- **Nối thêm, không sửa.** Một lượt ghi đúng một dòng; không bao giờ sửa dòng đã ghi. Sửa duy nhất là **xoá** (§3.5).
- **Chống trùng** theo `(agentId, turnId, vân tay nội dung lượt)`: hook có thể chạy lại sau reload, nên bộ đọc bỏ dòng trùng và giữ dòng có `at` muộn nhất. *Errata 2026-09-17:* khoá ban đầu chỉ là `(agentId, turnId)` vì thiết kế giả định turn id không lặp trong một agent; Paseo đánh số lại, nên khoá đó **vứt mất** các lượt thật — xem [delta 20260917d](paseo-bm-dashboard-delta-20260917d-request-attribution.md) §3 B và §4 B.
- **Ghi an toàn:** mọi đường dẫn đi qua bộ kiểm ở §3.8 trước khi mở; mở `O_APPEND` **cộng `O_NOFOLLOW`**, một lần `write` cho một dòng đã kết thúc bằng `\n`, rồi `fsync`. Mọi thao tác sửa kho lấy khoá tuần tự ở §3.8. Ghi lỗi (hết đĩa, không đủ quyền, kho lược đồ mới hơn) thì **bỏ qua, log một dòng**, và không bao giờ ném ra ngoài hook — một lỗi lưu vết không được làm chết lượt của agent (REQ-053c).
- **Trần độ dài** mỗi trường văn bản trước khi ghi (mặc định 8 KB cho một `sent`/`received`, 32 KB cho một bản ghi); phần cắt được ghi rõ bằng hậu tố `…[truncated]`.

### 3.4 Đọc

`traces.list` đọc file của workspace từ mới tới cũ (theo tên tháng), dựng trace theo §5, dừng khi đủ `limit`. `traces.get` đọc mọi dòng thuộc `traceId` rồi bổ sung:

- trạng thái **hiện tại** của từng agent (`agents.list`), để biết cái nào còn sống, cái nào đã lưu trữ hay bị xoá;
- lượt **đang chạy** (nếu có): đọc bù timeline trong cửa sổ `activeTurn.startedAt → nay`.

Cache trong bộ nhớ theo `(workspaceId, file, mtimeMs, size)`; file tháng cũ hầu như không đổi nên cache gần như luôn đúng.

### 3.5 Xoá (REQ-054)

`traces.delete` nhận đúng một trong ba dạng phạm vi:

| Phạm vi | Cách làm |
|---|---|
| `{ traceId }` | Viết lại các file tháng liên quan, bỏ mọi dòng thuộc trace đó (ghi tạm → `fsync` → `rename`, đúng nguyên tắc atomic của design gốc §8) |
| `{ before: ISO }` | Xoá hẳn các file tháng nằm hoàn toàn trước mốc; viết lại đúng một file chứa mốc |
| `{ allOfWorkspace: true }` | Xoá thư mục `<traces>/<workspaceId>` |

- **Xem trước là bắt buộc:** `traces.delete` với `dryRun: true` trả về `{ traces, bytes }` sẽ mất; giao diện luôn gọi `dryRun` trước và hỏi xác nhận, mặc định "Không".
- **Chống thoát thư mục:** đi qua bộ kiểm ở §3.8 — kiểm mẫu `workspaceId`, kiểm tiền tố sau `resolve`, **và `lstat` từng thành phần để từ chối symlink ở mọi cấp**. Không đạt → `E_TRACE_STORE_UNWRITABLE`, không xoá gì.
- Xoá **không** chạm beads, tài liệu, agent, hội thoại Paseo, `install.json`, `config.json` hay bất cứ file nào ngoài `<install home>/traces` (test phủ định, D-9).
- Xoá trace của một yêu cầu **đang chạy**: cho phép, nhưng giao diện cảnh báo trước rằng các lượt sau sẽ được ghi thành một trace mới.

### 3.6 Dung lượng (REQ-055)

`traces.list` trả kèm `store: { traces, bytes, workspaceBytes }`, tính bằng `stat` trên các file — không đọc nội dung.

**Ngưỡng nằm ở phía client, không ở server** (REQ-055d): server trả số byte thô, client đọc ngưỡng bằng `useSettings(...)` rồi tự quyết định có cảnh báo hay không. Lý do: `registerSettings` cho server **khai báo** lược đồ cài đặt, còn ba RPC read/write/reset do Paseo quản lý là để **client** gọi; đặt việc so ngưỡng ở client tránh phải bịa thêm một đường đọc cài đặt phía server.

Cài đặt (`shared/settings.ts`): `defineSettings({ id: "paseo-bm", scope: "host", version: 1, schema: z.object({ warnAboveBytes: z.number().int().positive().default(200 * 1024 * 1024) }) })`. Phạm vi duy nhất Paseo cấp là `"host"`, nên ngưỡng là **một giá trị cho cả máy**, không theo workspace — giao diện phải nói rõ (REQ-055e). Giá trị không hợp lệ bị Zod chặn ở bước ghi và Paseo trả `invalid`; màn hình hiện lỗi và giữ ngưỡng cũ (REQ-055f). `migrate` được khai báo sẵn để `version` sau này đổi được mà không mất giá trị cũ.

**Không tự xoá, không tự nén, không xoay vòng.**

### 3.7 Workspace không còn, và gán lại (REQ-057)

**Phân loại.** Với mỗi `workspaceId` có trong kho, đối chiếu `paseo.workspaces.list()`:

| Tình trạng | Điều kiện | Hiển thị |
|---|---|---|
| `live` | có trong danh sách, `archivingAt` rỗng | như bình thường |
| `archived` | có trong danh sách, `archivingAt` khác rỗng | đứng ở chỗ của nó, nhãn "đã lưu trữ" (REQ-057b) |
| `orphaned` | **không** có trong danh sách | nhóm "workspace không còn", kèm `lastKnownName` và `lastKnownDirectory` từ `meta.json` |

Không bao giờ suy ra `orphaned` từ một lần gọi lỗi: `workspaces.list()` thất bại thì mọi workspace giữ trạng thái `unknown` và không nhóm lại.

**Gán lại** (`traces.reassign`), chỉ do người dùng khởi động, không có cơ chế tự đoán (REQ-057f):

1. Kiểm tra `to` là một workspace **đang có** trong `workspaces.list()`, và `from` khác `to`. Sai → `E_TRACE_REASSIGN_INVALID`, không chạm gì.
2. `dryRun: true` trả `{ traces, bytes }` để giao diện hỏi xác nhận trước.
3. Đích chưa có thư mục → `rename` cả thư mục (một thao tác, không mất dữ liệu nếu bị ngắt).
4. Đích đã có thư mục → gộp theo từng file tháng: đọc cả hai, loại trùng bằng cùng `dedupeRecords` của §3.3, ghi tạm → `fsync` → `rename`, rồi xoá file nguồn. Toàn bộ bước này nằm trong khoá tuần tự ở §3.8, nên **không có bản ghi nào được nối vào nguồn trong lúc gộp**. Bị ngắt vì tiến trình chết thì tệ nhất là còn cả hai bản; bộ đọc loại trùng nên **không nhân đôi** (REQ-057e).
5. `meta.json` của đích giữ giá trị của đích; `meta.json` nguồn bị xoá cùng thư mục nguồn.
6. Không chạm file nào ngoài `<install home>/traces` (REQ-057g), với đúng bộ kiểm đường dẫn ở §3.5.

Gán lại **không** sửa `workspaceId` bên trong từng bản ghi: trường đó ghi lại sự thật lịch sử. Vị trí thư mục là thứ quyết định trace thuộc workspace nào, và `TraceSummary` báo `reassignedFrom` khi hai giá trị khác nhau.

### 3.8 Bộ kiểm đường dẫn dùng chung và tuần tự hoá ghi

Hai cơ chế dưới đây là **bắt buộc và dùng chung** cho mọi thao tác ghi, xoá và gán lại. Chúng nằm trong đúng một module (`server/trace-store.ts`); không module nào được tự dựng đường dẫn vào kho.

**Bộ kiểm đường dẫn (no-follow).** Kiểm tiền tố chuỗi sau `resolve` **không đủ**: một thành phần là symlink vẫn trỏ ra ngoài kho dù đường dẫn trông hợp lệ. Thứ tự kiểm, thất bại ở bất kỳ bước nào → `E_TRACE_STORE_UNWRITABLE` và **không chạm đĩa**:

1. `workspaceId` khớp `^[A-Za-z0-9._-]{1,128}$` và không phải `.` hay `..`.
2. Đường dẫn sau `resolve` nằm trong `<install home>/traces`.
3. `lstat` **từng thành phần** từ `<install home>` xuống tới file đích: thành phần nào là symlink thì từ chối, không đi theo.
4. Mở file đích với `O_NOFOLLOW` (macOS và Linux đều có); file tạm dùng `O_CREAT | O_EXCL | O_NOFOLLOW` và được tạo **trong cùng thư mục** với file nó sẽ thay, để `rename` là thao tác trong một hệ thống file.

Đây là cùng nguyên tắc mà §10 áp cho đường đọc `.beads/issues.jsonl` và `src/paths-guard.ts` áp cho trình cài đặt; điểm khác là ở đây nó áp cho cả đường **ghi** và **xoá**.

**Tuần tự hoá.** Bộ thu thập và mọi handler RPC chạy trong **cùng một tiến trình** plugin server (Paseo fork một worker cho mỗi plugin), nên không cần khoá file:

- Một **mutex bất đồng bộ trong tiến trình, khoá theo `workspaceId`**, bao mọi thao tác **sửa** kho: nối bản ghi, viết lại khi xoá, và `rename`/gộp khi gán lại. Không có hai thao tác sửa nào của cùng một workspace chạy xen nhau.
- **Đọc không lấy khoá.** Kho là dòng-một-bản-ghi nên đọc trong lúc có người nối là an toàn; một dòng cuối bị ghi dở (tiến trình chết giữa `write`) bị bộ đọc bỏ qua và tính vào `skippedLines`.
- Bộ thu thập gặp khoá thì **chờ**, không bỏ bản ghi; chờ quá hạn (mặc định 5 giây) thì bỏ qua lượt đó và log một dòng, đúng nguyên tắc "lỗi lưu vết không bao giờ chặn agent" ở §3.3.

**Tiến trình khác duy nhất có thể ghi vào kho là CLI `paseo-bm` lúc gỡ.** Không dùng khoá cho việc này; dùng **thứ tự**: lệnh gỡ chạy `paseo plugin remove` (plugin dừng) **trước** khi chạm `traces/`, nên không có lời nối nào còn chạy. Điều kiện ra của WP-213 phải chứng minh đúng thứ tự đó.

## 4. Data Model của API

Đặt trong `shared/contracts.ts` bằng Zod, cùng chỗ với ba hợp đồng hiện có; `shared/` vẫn không import Node hay React Native.

### 4.1 Kiểu dùng chung

```ts
confidence = "exact" | "inferred" | "unknown"

evidence = { kind: "report" | "shell" | "file" | "agent" | "timeline",
             detail: string, agentId: string | null, at: string | null }

usage = { inputTokens, cachedInputTokens, outputTokens,
          costUsd: number | null,
          costBasis: "provider" | "estimated" | "unavailable",
          model: string | null, pricesUpdatedAt: string | null }
```

### 4.2 `TraceSummary`

| Trường | Kiểu | Ngữ nghĩa |
|---|---|---|
| `traceId` | string | `<managerAgentId>:<seq của entry yêu cầu>` khi dựng từ timeline Manager; `req:<requestId>` khi requestId đã biết. Bền trong kho lưu vết |
| `requestId` | string hoặc null | `req-<YYYYMMDDTHHMMSSZ>` do Manager sinh |
| `requestedAt` | string | Thời điểm yêu cầu mở đầu |
| `excerpt` | string | Một dòng đầu của yêu cầu, đã cắt và đã che bí mật |
| `state` | enum | `running` , `waiting_user` , `completed` , `stopped` , `failed` , `unknown` (§7.3) |
| `workerIds` / `reviewerIds` | string[] | Agent gán vào trace |
| `reviewCalls` | number hoặc null | **Số lượt gọi review** quan sát được |
| `guardrailReported` | object hoặc null | Bộ đếm Worker tự báo, nguyên văn |
| `durationMs` | number hoặc null | null khi đang chạy hoặc không đo được |
| `usage` | usage | Tổng của mọi agent trong trace |
| `beadCounts` | object | `{ created, updated, closed, ready }`, mỗi số kèm `confidence` |
| `tier` | enum hoặc null | `Small` , `Medium` , `Large` |
| `linking` | confidence | Việc nhóm trace chắc tới đâu |
| `agentsMissing` | string[] | Agent có trong lưu vết nhưng không còn trên máy |
| `workspaceState` | enum | `live` , `archived` , `orphaned` , `unknown` (§3.7) |
| `reassignedFrom` | string hoặc null | `workspaceId` gốc, khi trace đã được gán lại |
| `notices` | string[] | "dữ liệu có thể thiếu", "kho lưu vết tắt", … |
| `usageByModelRole` | `[{ role, model \| null, usage }]` | *Thêm 2026-09-18 ([delta 20260918](paseo-bm-delta-20260918-manager-mode-model-metrics.md) §4.3, REQ-058e).* Token và chi phí theo vai trò × model hiệu lực, cho biểu đồ "Tokens by model × role" ở tổng quan. Tuỳ chọn trong lược đồ, server luôn gửi |

### 4.3 `TraceDetail`

```
TraceDetail = TraceSummary + {
  sent:     { userRequest, workerInitialPrompts[], reviewRequests[] },
  received: { reports[], reviews[], managerReplies[] },
  timing:   { totalMs|null, managerTurns[], workers[], reviewers[], basis: string },
  usageByAgent: [{ agentId, role, usage, runtime?: [{ model, thinkingOptionId, modeId, recorded, turns }] }],
  usageByModel?: [{ model|null, usage }],   // errata 2026-09-18, xem dưới
  beads:    [{ id, title|null, statusNow|null, action, confidence, evidence[] }],
  workflowSteps: [{ step, status: "done"|"skipped"|"unknown", confidence, evidence[], note|null }],
  subAgentTraces:[{ agentId, subAgentType|null, description|null, count }],
}
```

*Errata 2026-09-18 ([delta 20260918](paseo-bm-delta-20260918-manager-mode-model-metrics.md) §4.3, REQ-058a–d):* `usageByAgent[].runtime` gộp các lượt của một agent thành một dòng cho mỗi tổ hợp `(model, thinkingOptionId, modeId, recorded)` kèm số lượt, theo thứ tự gặp đầu tiên. Lượt có `runtime` → `recorded: true`; lượt cũ không có `runtime` nhưng có `usage.model` → giữ model đó, thinking/mode `null`, `recorded: false`; không có cả hai → `model: null`. `usageByModel` là token và chi phí theo model hiệu lực, cộng lại đúng bằng `usage` của trace. Hai trường tuỳ chọn trong lược đồ, server luôn gửi.

`workflowSteps` luôn trả đủ danh sách bước cố định, đúng thứ tự: `classify_tier`, `prd`, `design`, `adr`, `plan`, `convert_to_beads`, `polish_beads`, `implement`, `review_batches`, `build_and_tests`, `close_with_evidence`.

### 4.4 `BeadStats`

```
{ total, open, inProgress, blocked, closed, ready,
  readAt, source, skippedLines, present }
```

## 5. Hợp đồng RPC

| RPC | Input | Output | Ngữ nghĩa |
|---|---|---|---|
| `traces.list` | `{ workspaceId, limit?, cursor? }` | `{ traces: TraceSummary[], nextCursor, truncated, store, notices }` | Danh sách trace của workspace, mới nhất trước. `limit` trần 50 |
| `traces.get` | `{ workspaceId, traceId }` | `{ trace: TraceDetail }` | Đọc sâu một trace; không dựng lại được → `E_TRACE_NOT_FOUND` |
| `traces.delete` | `{ workspaceId, scope: { traceId } \| { before } \| { allOfWorkspace: true }, dryRun? }` | `{ deleted: { traces, bytes }, store }` | `dryRun: true` chỉ đếm, không xoá. Ghi vào đúng kho lưu vết, không nơi nào khác |
| `traces.reassign` | `{ fromWorkspaceId, toWorkspaceId, dryRun? }` | `{ moved: { traces, bytes }, store }` | Gán lại toàn bộ trace của một workspace không còn sang một workspace đang có (§3.7). `dryRun: true` chỉ đếm |
| `beads.stats` | `{ workspaceId }` | `{ stats: BeadStats }` | Đọc `.beads/issues.jsonl` của workspace. Không có file → `present: false`, không lỗi |

**Mã lỗi mới.** Design gốc §4.4 là **bộ mã duy nhất** của sản phẩm ("không được đặt mã tại chỗ"), nên năm mã dưới đây phải được ghi vào đó bằng delta-change ở §14:

| Mã | Khi nào |
|---|---|
| `E_TIMELINE_UNAVAILABLE` | Paseo không trả được timeline của một agent |
| `E_BEADS_STORE_UNREADABLE` | `.beads/issues.jsonl` có nhưng không đọc được: quyền, vượt trần 32 MB, hoặc symlink ra ngoài workspace |
| `E_TRACE_NOT_FOUND` | `traceId` không còn trong kho lưu vết |
| `E_TRACE_STORE_UNWRITABLE` | Không ghi hoặc không xoá được kho: quyền, hết đĩa, `workspaceId` không hợp lệ, đường dẫn thoát ra ngoài |
| `E_TRACE_STORE_SCHEMA_TOO_NEW` | `meta.json` có `schemaVersion` cao hơn mức bản đang chạy hiểu |
| `E_TRACE_REASSIGN_INVALID` | Gán lại vào một workspace không tồn tại, hoặc `from` trùng `to` |

Lỗi được ném dưới dạng `Error` có `message` bắt đầu bằng mã, để client đọc bằng `errorCodeOf` sẵn có.

## 6. Nhóm trace theo yêu cầu

1. **Lấy agent.** `agents.list` theo nhãn (`bm.role=manager|worker|reviewer`), `includeArchived: true`, phân trang 200; lọc theo `agent.workspaceId`. Dựng cây bằng `parentAgentId`; parent không có trong tập thì node là gốc.
2. **Đọc kho lưu vết** của workspace. Bucket **khoá theo `requestId`**, nên N lượt Manager của cùng một request luôn là **một** dòng. Một trace mở ra từ lượt Manager có `sent` không phải `BM-REPORT`, **hoặc** từ lượt Manager đọc được `requestId` — trường hợp sau `requestText` để `null` và dòng đó nói rõ là chưa ghi được lời yêu cầu (plugin chỉ thu từ lúc nó được nạp). Lượt Manager **không** nêu `requestId` thuộc về **request mà chính Manager đó nêu ở lượt kế tiếp của nó**; không có lượt nào sau đó của cùng Manager nêu request thì mới mở một dòng tạm. *Errata 2026-09-17 (b):* một request được **tách thành các đoạn** trên màn hình — mỗi lượt Manager mà tin nhắn đầu là lời người dùng thật (`origin === "user"`) mở một đoạn, và danh sách hiện một dòng cho mỗi đoạn; `requestId`, cách Worker báo cáo và ngân sách review **không đổi** (owner chốt Q23). Biểu đồ vẫn đếm request (Q27). Xem [delta 20260917e](paseo-bm-delta-20260917e-manager-screen-and-commands.md) §4.3. *Errata 2026-09-17 (a):* mã cũ tìm lượt kế tiếp trong **cả workspace**, nên một lượt của Manager đã lưu trữ chui vào request của Manager sau đó, cách 18 giờ — xem [delta 20260917d](paseo-bm-dashboard-delta-20260917d-request-attribution.md) §3 A và §4 A. Xem [delta 20260916-acceptance-fixes](paseo-bm-delta-20260916-acceptance-fixes.md) vị trí 1, 2, 6.
3. **Lấy `requestId`**, dừng ở nguồn đầu tiên có giá trị:
   a. nhãn `bm.requestId` của agent (REQ-051) → `linking: "exact"`;
   b. trường `requestId:` trong một `BM-REPORT` của trace → `"exact"`;
   c. dòng `requestId: req-…` trong prompt khởi tạo Worker (`manager.md` bắt buộc có) → `"exact"`;
   d. không có → nhóm theo thời gian: Worker có `agentCreatedAt` nằm trong lượt Manager của trace và chưa thuộc trace nào → `"inferred"`;
   e. không xếp được → nhóm "không rõ yêu cầu", `"unknown"`; **không** gán bừa vào trace gần nhất.
4. **Gán Reviewer** theo `parentAgentId` = một Worker của trace (hoặc nhãn `bm.batchId` khi có).
4b. **Bản ghi của agent không còn trên máy.** Một bản ghi tự nêu `requestId` của nó, nên nó được gắn vào trace kể cả khi `agents.list` không còn agent đó — người dùng có thể **xoá** Worker, và lưu trữ thì `includeArchived: true` vẫn thấy nhưng xoá thì không. Agent đó vào `agentsMissing` và dòng trace nói rõ "không còn trên máy này". Nếu chỉ gắn qua danh sách agent thì byte vẫn nằm trong kho mà phần việc biến khỏi màn hình ([delta](paseo-bm-delta-20260916-acceptance-fixes.md) vị trí 8, chân thứ ba của D-8).
5. **Đếm hai loại số** (REQ-042b): `reviewerIds.length` là số agent; `reviewCalls` là số lượt, đếm bằng số bản ghi `sent` của Reviewer không phải `BM-REVIEW`. Lệch với `guardrail` Worker tự báo thì hiện cả hai và đánh dấu.

**Bộ đọc `BM-REPORT`** (`server/bm-report.ts`) khoan dung theo REQ-050: tìm mọi khối bắt đầu bằng dòng `BM-REPORT` (có hay không có rào ```), đọc từng dòng `khoá: giá trị`, khoá không phân biệt chữ hoa, khoá lạ vào `unparsedFields`, khoá thiếu để `null`; `none` và chuỗi rỗng là "không có"; id bead tách theo dấu phẩy hoặc khoảng trắng và lọc theo dạng id kho beads. Loại trùng theo `(agentId, phase, requestId, at)` để một báo cáo được trích dẫn lại không bị đếm hai lần.

**Id bead đọc từ lệnh `br`** chỉ lấy ở **tham số vị trí**, tức phần trước cờ đầu tiên và sau khi làm trắng phần trong dấu nháy; `br create` không nêu id nào vì `br` tự sinh id, và `--help`/`--dry-run` không phải hành động. Quét cả dòng lệnh sẽ đọc `-l "feature:format-date"` và văn bản trong `-r "…"` thành id bead (delta vị trí 4).

**"Báo cáo mới nhất"** trong mục này và §7.3 nghĩa là mới nhất **theo thời gian**: báo cáo tới một trace từ nhiều lượt duyệt nên thứ tự mảng là thứ tự tới, không phải thứ tự thời gian.

## 7. Đo thời gian

### 7.1 Mốc đo (cố định, và in ra giao diện)

| Số | Bắt đầu | Kết thúc |
|---|---|---|
| Tổng thời gian của yêu cầu | `startedAt` của lượt Manager mở đầu | Muộn hơn giữa: `endedAt` của lượt Manager cuối, và `at` của `BM-REPORT` `finished` |
| Một lượt | `startedAt` (hook `turn_started`) | `endedAt` (hook `turn_ended`) |
| Một Worker | `agentCreatedAt` | `at` của `BM-REPORT` `finished`; thiếu thì `endedAt` của lượt cuối |
| Một Reviewer | `agentCreatedAt` | `at` của `BM-REVIEW` cuối; thiếu thì `endedAt` của lượt cuối |

### 7.2 Quy tắc bắt buộc

- Lượt còn `activeTurn` → `ms = null`, state `running`, giao diện hiện thời gian đã trôi từ `activeTurn.startedAt`, **không** hiện tổng.
- Đây là **thời gian treo**, gồm cả thời gian chờ người dùng trả lời; giao diện phải nói câu này (REQ-043c).
- Thiếu mốc → `null` và một notice, không bao giờ suy ra 0.

### 7.3 Suy ra `state`

Thứ tự, dừng ở điều kiện khớp đầu tiên: có agent `status = "running"` → `running`; `BM-REPORT` cuối là `blocked` → `waiting_user`; có agent `status = "error"` hoặc lượt cuối `outcome = failed` → `failed`; `BM-REPORT` cuối là `finished` → **`stopped` nếu `blockers` khác rỗng, còn lại `completed`** (`worker.md` gửi `finished` cả khi xong việc lẫn khi bị dừng); Worker tồn tại nhưng không còn `running` và không có `finished` → `stopped`; còn lại → `unknown`.

**Chỉ báo cáo cuối cùng quyết định.** Một lượt `canceled` trước đó là quá khứ, không phải kết luận: F-1 của đợt nghiệm thu bị ngắt bốn lần rồi làm xong, và luật cũ ("có lượt `canceled` bất kỳ → `stopped`") báo một request **đã giao xong** là "Stopped" (delta vị trí 5).

## 8. Suy ra bước feature-workflow (REQ-045)

> Errata 2026-09-17: bảng thành **12 bước** (thêm `review_plan` sau `plan`); `review_plan`, `convert_to_beads`, `polish_beads`, `implement` lấy thêm tín hiệu từ trường `skillsUsed` và bằng chứng `skill`; `guardrail` không có đoạn `polish` không còn là phủ định; Vừa chỉ được bỏ `review_plan`, Lớn không được bỏ bước nào; bằng chứng `file` tuyệt đối được đọc theo thư mục của workspace. Xem [delta workflow-skills](./paseo-bm-delta-20260917-workflow-skills.md) §5.5 (`design-delta-20260917-workflow-skills`).

| Bước | Tín hiệu `exact` | Tín hiệu `inferred` |
|---|---|---|
| `classify_tier` | `tier:` trong `BM-REPORT` | câu phân loại trong lời Worker |
| `prd` | `filesChanged` dưới `docs/product/` | `tool_call` `write`/`edit` dưới `docs/product/` |
| `design` | `filesChanged` dưới `docs/design/` | `write`/`edit` dưới `docs/design/` |
| `adr` | `filesChanged` dưới `docs/adr/` | `write`/`edit` dưới `docs/adr/` |
| `plan` | `filesChanged` dưới `docs/plans/` | `write`/`edit` dưới `docs/plans/` |
| `convert_to_beads` | `beadsCreated` không rỗng, hoặc `phase: beads-done` | `shell` có `br create` |
| `polish_beads` | `guardrail` ghi `polish n/max` với `n ≥ 1`; **và phủ định chính xác:** mọi `guardrail` đọc được đều ghi `polish 0` → bước này **không xảy ra**, thắng mọi suy luận từ timeline | `shell` có `br update` chạm **≥2 bead khác nhau** trong một lượt sau `br create`. Sửa nhiều lần **cùng một** bead là việc thường, không phải polish ([delta](paseo-bm-delta-20260916-acceptance-fixes.md) vị trí 7) |
| `implement` | `phase: bead-implemented` | `write`/`edit` ngoài `docs/` trong workspace |
| `review_batches` | có Reviewer và có `BM-REVIEW` | có agent con `bm.role=reviewer` |
| `build_and_tests` | `buildAndTests` khác `not run` | `shell` chạy lệnh test hoặc build của repo |
| `close_with_evidence` | `beadsClosed` không rỗng và bead đó `closed` trong kho | `shell` có `br close` |

**Quy tắc `skipped`.** Chỉ đặt `skipped` khi cả hai điều đúng: `tier` đọc được, và REQ-036 cho phép mức đó bỏ bước đó (`Small` bỏ `prd`/`design`/`adr`/`plan`/`polish_beads`; `Medium` chỉ được `skipped` cho `polish_beads`, vì "tài liệu không bị ảnh hưởng" không quan sát được). Mọi trường hợp khác là `unknown`. Đây là điều giữ D-5: **không có bằng chứng phủ định thì không kết luận phủ định.** Ngược lại, khi **có** bằng chứng phủ định chính xác — ví dụ `guardrail` ghi `polish 0` — bước đó là `skipped` kèm đúng câu báo cáo làm ghi chú, kể cả ở `Large` (nơi không mức nào được bỏ bước), vì lúc đó ta **biết** chứ không phải suy đoán.

## 9. Token và chi phí (REQ-052)

1. **`lastUsage.totalCostUsd` không dùng được cho một request.** Đo trên 12 lượt Manager thật, nó **chỉ tăng** (0,3956 → 0,4492 → … → 2,2712) trong khi token bên cạnh lên xuống theo từng lượt: đó là **tổng luỹ kế của phiên agent**, không phải chi phí một lượt. Bản ghi lượt vì vậy **không** ghi nó, và chi phí một request **luôn** là số tạm tính ở bước 2 (delta vị trí 3, đổi một phần Q-035).
2. **Tạm tính:** tính từ `shared/prices.ts`, khớp theo model id của agent:
   `cost = inputTokens×in + cachedInputTokens×cacheRead + outputTokens×out`. Tính token cache **riêng** theo đơn giá cache: coi token cache như token vào bình thường sẽ báo đắt hơn thực tế nhiều lần. → `costBasis: "estimated"`.
3. **Model không có trong bảng:** `costUsd: null`, `costBasis: "unavailable"` — giao diện chỉ hiện token.
4. `shared/prices.ts` có `pricesUpdatedAt` và giao diện **luôn** hiện ngày đó cạnh số tiền, kèm nhãn "estimated". **Không gọi mạng để lấy giá.**
5. Bảng giá là dữ liệu sẽ cũ: nguồn sự thật là trang giá công bố của từng provider, và giá trên Amazon Bedrock hoặc Google Vertex **khác** giá API gốc. Vì vậy số tiền luôn là *tạm tính*, không phải hoá đơn (REQ-052f).
6. *Errata 2026-09-18 ([delta 20260918](paseo-bm-delta-20260918-manager-mode-model-metrics.md) §4.3, owner chốt Q38):* mọi phép gộp theo model — tổng tiền của trace, dòng token theo model, biểu đồ model × vai trò — dùng **model hiệu lực** của bản ghi: `runtime.model`, không có thì `usage.model`. Con số chỉ khác trước ở ca profile để trống model: token trước đây "không có giá" nay được định giá theo model đã chạy.

> Khảo sát để điền bảng lần đầu (giá API gốc của Anthropic, kiểm 2026-06-24, USD trên 1 triệu token, in/out): `claude-opus-5` 5/25 · `claude-sonnet-5` 2/10 · `claude-haiku-4-5` 1/5. Phải kiểm lại tại thời điểm implement và ghi đúng `pricesUpdatedAt`; model của provider khác (ví dụ Codex) lấy từ trang giá của chính provider đó.

## 10. Đọc kho beads (REQ-046)

- **Đường dẫn:** `<workspace.directory>/.beads/issues.jsonl`, `directory` lấy từ snapshot workspace của SDK. Không dùng cwd của tiến trình plugin.
- **Chống thoát thư mục:** `resolve` rồi kiểm tra vẫn nằm trong `directory`; `lstat` từng thành phần, symlink trỏ ra ngoài → `E_BEADS_STORE_UNREADABLE`. Bản riêng nhỏ trong `server/`: plugin payload không import `src/`.
- **Đọc:** stream theo dòng; dòng hỏng thì bỏ qua và tăng `skippedLines`; trần 32 MB.
- **Loại trùng:** nhiều dòng cùng `id` thì giữ dòng có `updated_at` muộn nhất.
- **Tính số:** `total` là số id phân biệt; `open`/`inProgress`/`blocked`/`closed` theo `status`; `ready` là `status = "open"` và **mọi** phụ thuộc loại `blocks` trỏ tới bead đã `closed` — `parent-child` không chặn; phụ thuộc trỏ tới id không tồn tại thì coi là chưa đóng.
- **Cache:** theo `(path, mtimeMs, size)`.
- **Chỉ đọc.** Không gọi `br`, không tiến trình con, không ghi, không chạm `beads.db`.

## 11. Hiệu năng

| Chỗ | Cách |
|---|---|
| Ghi lưu vết | Một `write` + `fsync` cho một dòng mỗi lượt; mục tiêu dưới 50 ms, và lỗi không bao giờ chặn agent |
| Đọc lưu vết | Theo file tháng, mới tới cũ, dừng khi đủ `limit` (50); cache theo `mtime`+`size` |
| Timeline | Chỉ đọc bù cho lượt đang chạy, hoặc khi kho lưu vết tắt; trần 2.000 entry mỗi agent mỗi lần |
| Client | `useQuery` như code hiện có, `staleTime` ngắn, refetch khi người dùng bấm; không polling ngầm |
| Không có | Cron, watcher, vòng lặp nền, tính toán nặng ở client |

## 12. Security & Privacy

- **Ranh giới ghi mới, và chỉ một:** `<install home>/traces/**`. Test phủ định chứng minh không ghi vào workspace, `~/.paseo`, thư mục skills, `install.json` hay bất cứ nơi nào khác (REQ-047, D-7).
- **Che bí mật trước khi ghi** (REQ-048b), không phải chỉ trước khi render: dữ liệu đã lên đĩa thì không sửa lại được. Quy tắc lấy từ bộ che của CLI (`src/redact.ts` là nguồn quy tắc; plugin có bản sao hằng số vì không import `src/`).
- **Không ghi `env`.** Hook `agent.create` có thấy `env` nhưng bộ thu thập không dùng hook đó và không có đường nào để `env` vào bản ghi.
- **Quyền:** thư mục `0700`, file `0600`, như `install.json`.
- **Đọc đĩa ngoài kho của mình đúng hai chỗ:** `<workspace>/.beads/issues.jsonl` và `<install home>/install.json` (chỉ đọc, để xác nhận thư mục cài đặt).
- **Xoá là quyền của người dùng** (REQ-054f): không có đường nào trong sản phẩm tự xoá trace, và lệnh gỡ phải hỏi (REQ-056a).
- **Nói rõ với người dùng** rằng màn hình đang hiện lại và đang lưu hội thoại agent (REQ-048d).
- **Không mạng** ở mọi luồng, kể cả việc lấy giá model.

## 13. Reliability

- Agent bị lưu trữ hoặc xoá → trace vẫn đầy đủ phần đã lưu vết; `agentsMissing` liệt kê agent không còn, kèm notice.
- Ghi lưu vết lỗi → bỏ qua, log một dòng, Dashboard hiện "có thể thiếu trace"; agent không bị ảnh hưởng.
- Kho có `schemaVersion` mới hơn → đọc hạn chế, không ghi, không xoá tự động.
- File lưu vết hỏng một dòng → bỏ đúng dòng đó, đếm vào `skippedLines`.
- Plugin reload giữa một lượt → mốc `turn_started` mất; bản ghi vẫn được ghi với `startedAt` suy từ entry đầu của lượt và một notice.
- `reset`, `gap`, `staleCursor` từ timeline → đọc lại một lần và gắn notice.
- Host Paseo thiếu API timeline hoặc thiếu `before`/`on` hook → tắt đúng phần đó kèm thông báo, phần còn lại vẫn chạy (cùng khuôn với cách `role-hook.ts` xử lý host thiếu `before`).

## 14. Ảnh hưởng tới tài liệu đã đóng băng

Kho lưu vết nằm trong thư mục cài đặt, nên tính năng này **phải** đi kèm một delta-change; không sửa tại chỗ (AGENTS.md).

| Tài liệu | Cần sửa gì |
|---|---|
| PRD gốc — REQ-012 (gỡ cài đặt) | Danh sách gỡ có thêm kho lưu vết, được hỏi riêng, và có cờ riêng cho chế độ không tương tác (REQ-056a). Tên cờ còn chờ owner chốt — xem Q-039 |
| PRD gốc — REQ-010 (cập nhật và an toàn khi bị ngắt) | Ghi rõ **cập nhật không bao giờ xoá kho lưu vết**, kể cả `--prune` (REQ-056b) |
| Design gốc §3.1 (bố cục thư mục cài đặt) | Thêm `traces/` |
| Design gốc §3.3 (phân loại quyền sở hữu) | Thêm loại "dữ liệu do paseo-bm tạo, thuộc người dùng, không có hash, không backup, xoá phải hỏi" |
| Design gốc §4.4 (bộ mã lỗi) | Thêm năm mã ở §5 |
| Design gốc §5 (hợp đồng RPC) | Thêm bốn RPC, hoặc một dòng trỏ sang tài liệu này |
| Design gốc §8 (reliability) | Ghi rõ rằng "không tác vụ nền" vẫn giữ: thu thập bằng hook sự kiện, không cron/watcher |
| `roles/manager.md`, `roles/worker.md` | Thêm nhãn `bm.requestId` và `bm.batchId` (REQ-051), kèm bump phiên bản chỉ dẫn |

## 15. Testing Strategy

| Tầng | Nội dung |
|---|---|
| Unit — `bm-report.ts` | Khối `BM-REVIEW`; khối đủ field; thiếu field; field lạ; nhiều khối một tin nhắn; khối bị trích dẫn lại; chữ hoa khác; `none`; id nhiều dấu phân cách; khối của bản chỉ dẫn trước (REQ-050c) |
| Unit — `trace-store.ts` | Ghi rồi đọc lại; dòng trùng `(agentId, turnId, vân tay)`, kể cả turn id bị dùng lại và bản ghi lại đóng dấu giờ ghi; dòng hỏng; **dòng cuối bị ghi dở**; file nhiều tháng; `schemaVersion` mới hơn; hết đĩa và không đủ quyền (lỗi bị nuốt, không ném); cắt trường dài; quyền `0700` cho thư mục và `0600` cho file |
| Unit — bộ kiểm đường dẫn (§3.8) | Symlink tại `traces/`, tại thư mục workspace, tại file tháng, tại file tạm — mọi trường hợp bị từ chối, **đích của symlink không đổi một byte**; `workspaceId` sai mẫu; `.` và `..`; đường dẫn thoát ra ngoài |
| Unit — tuần tự hoá (§3.8) | Dùng barrier: nối bản ghi đồng thời với xoá và với gán lại — không mất bản ghi, không nhân đôi sau khi đọc lại, không ghi vào thư mục nguồn sau khi gán lại xong; collector chờ quá hạn thì bỏ lượt và log |
| Unit — xoá | Ba phạm vi; `dryRun` đếm đúng; `workspaceId` sai định dạng; đường dẫn thoát ra ngoài; xoá trace đang chạy; chứng minh không file nào ngoài `traces/` bị chạm |
| Unit — gán lại | Đích chưa có thư mục (`rename`); đích đã có (gộp + loại trùng); `from` trùng `to`; đích không tồn tại; `dryRun` đếm đúng; bị ngắt giữa lúc gộp thì đọc lại không nhân đôi; `reassignedFrom` đúng |
| Unit — phân loại workspace | `live` / `archived` / `orphaned` / `unknown` khi `workspaces.list()` lỗi; `meta.json` thiếu thì vẫn hiện được nhóm orphan |
| Unit — cài đặt | Lược đồ Zod chặn giá trị âm và không phải số; `migrate` giữ giá trị cũ; thiếu cài đặt thì dùng mặc định 200 MB |
| Unit — `install-home.ts` | Lấy từ `config.plugins`; `--home` khác mặc định; `install.json` thiếu; cấu hình không có mục plugin → tắt tính năng chứ không ném |
| Unit — `collector.ts` | Chỉ ghi cho agent `bm-*`; `outcome` failed/canceled; hook thiếu trên host cũ; lượt không có `turn_started`; giả định **A-2** (timeline của hook có `timestamp` hay không) được test bằng cả hai dạng dữ liệu |
| Unit — `traces.ts` | Nhóm theo nhãn, theo `BM-REPORT`, theo prompt, theo thời gian, và nhóm "không rõ"; Worker mồ côi; Reviewer dùng lại; hai yêu cầu chồng thời gian; agent đã bị xoá |
| Unit — thời gian, `workflow-steps.ts`, `cost.ts`, `beads-store.ts` | Như §7, §8, §9, §10; riêng `cost.ts`: có `totalCostUsd`, không có, model lạ, token cache tính theo đơn giá cache |
| Unit — `dashboard-model.ts` | Text cho từng `state`, `confidence`, `costBasis`; cảnh báo dung lượng; xác nhận xoá mặc định "Không"; `compact` |
| Integration | `PaseoApi` giả + `$HOME` giả: một workspace, một Manager, hai Worker, ba Reviewer, có agent đã lưu trữ; kiểm tra bốn RPC đầu-cuối, gồm cả vòng ghi → đọc → xoá |
| Phủ định | REQ-047: không gọi hàm ghi của SDK, không mạng, không ghi ngoài `traces/`, không đọc file nào khác ngoài hai chỗ ở §12 |
| Bundle | Bổ sung `test/plugin-bundle-cjs.test.ts`: client entry mới không import `server/`; `shared/` không import Node |
| Nghiệm thu trên daemon thật | D-2 → D-11 trên bộ kit nghiệm thu điều phối, ghi run record trong `docs/operations/`; gồm bước kiểm **A-1** và **A-2**, bước xoá trace và bước gán lại đều có ảnh chụp hệ thống file trước–sau, và một lần cập nhật phiên bản để chứng minh kho còn nguyên |

## 16. Backward Compatibility

- Ba RPC hiện có không đổi input, output hay ngữ nghĩa; surface "Beads Manager" giữ nút *Open Beads Manager*.
- Không đổi `install.json`, không đổi khoá nào trong `config.json`; không cần cài lại plugin (cập nhật payload theo REQ-010 là đủ).
- Kho lưu vết có `schemaVersion`: bản mới đọc được kho của bản cũ; bản cũ gặp kho mới hơn thì đọc hạn chế và không ghi.
- Agent tạo bởi bản trước (không có nhãn `bm.requestId`) vẫn hiện, ở mức `inferred`.
- Cập nhật phiên bản **không** xoá kho lưu vết, kể cả `--prune` và kể cả khi lược đồ cần di trú: di trú ghi bản mới rồi mới bỏ bản cũ, không bao giờ xoá trước (REQ-056b).
- Bộ đọc `BM-REPORT` đọc được cả định dạng hiện tại và định dạng sau này (REQ-050b).

## 17. Open Questions

| ID | Question | Ảnh hưởng thiết kế |
|---|---|---|
| Q-039 | Lệnh **gỡ**: giữ hành vi "hỏi rồi xoá" hay luôn giữ kho, và tên cờ cho chế độ không tương tác (đề xuất `--purge-traces`) | Quyết định nội dung delta-change cho PRD gốc REQ-012 (§14). Phần **cập nhật** đã chốt: không bao giờ xoá |
| Q-042 | **Mới:** ngưỡng chỉ có phạm vi toàn máy vì Paseo chỉ cấp `scope: "host"`. Nếu về sau cần ngưỡng theo workspace thì phải tự lưu trong `meta.json` của kho — có cần không? | §3.6 |
| A-1 | Báo cáo gửi bằng `send_agent_prompt` có phải entry `user_message` trong timeline Manager không | §6 bước 2; sai thì đọc `BM-REPORT` từ timeline Worker |
| A-2 | `timeline` của hook `agent.turn_ended` có `timestamp` cho từng item không | §3.3 và §7; thiếu thì bộ thu thập gọi thêm một `timeline.refetch` cho cửa sổ lượt vừa xong |

## 18. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | **Errata theo [delta 20260918](paseo-bm-delta-20260918-manager-mode-model-metrics.md)** (REQ-058, owner chốt Q32, Q38): §3.3 bản ghi thêm trường tuỳ chọn `runtime`; §4.2 `TraceSummary.usageByModelRole`; §4.3 `usageByAgent[].runtime` (một dòng mỗi tổ hợp model/thinking/mode, kèm `recorded` và số lượt; lượt cũ giữ `usage.model`) và `usageByModel`; §9 gộp theo model hiệu lực. Không di trú, `schemaVersion` vẫn 1 |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | **Theo [delta 20260917e](paseo-bm-delta-20260917e-manager-screen-and-commands.md).** §4 bước 2: một request tách thành các đoạn theo lượt người dùng hỏi, dựa vào `origin` chứ không dựa câu chữ; biểu đồ vẫn đếm **request** (Q27). Hai RPC mới `launcher.order.get` / `launcher.order.set` cho thứ tự ghim, lưu trong install home chứ không dùng plugin settings (đường đó đang lỗi). `workspaces.overview` thêm `runningAgents` — errata nằm ở delta 20260916-owner-feedback, nơi RPC đó được định nghĩa |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | **Errata theo [delta 20260917d](paseo-bm-dashboard-delta-20260917d-request-attribution.md)** — lỗi owner báo: câu hỏi vừa gửi không thấy trong Metric. §3.3 và §3.5 bước 4: khoá chống trùng thêm **vân tay nội dung lượt** (Paseo dùng lại turn id trong cùng một agent, nên khoá cũ vứt mất lượt thật). §6 bước 2: lượt Manager vô danh chỉ gộp vào request của **chính Manager đó** (mã cũ tìm trong cả workspace, kéo lượt của Manager đã lưu trữ vào request 18 giờ sau). Sự thật mới: thời điểm tin nhắn trong bản ghi có thể là **giờ lúc ghi**, nên không dùng làm khoá được |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | **Bản 5 — sau nghiệm thu trên daemon thật (WP-214).** Áp dụng [delta 20260916-acceptance-fixes](paseo-bm-delta-20260916-acceptance-fixes.md): §6 (bucket khoá theo `requestId`; trace mở được từ `requestId` không cần lời yêu cầu; lượt Manager vô danh thuộc request được nêu ở lượt sau; id bead chỉ ở tham số vị trí; "mới nhất" là theo thời gian), §7.3 (chỉ báo cáo cuối quyết định; `finished` + `blockers` mới là `stopped`), §6 bước 4b (bản ghi của agent đã bị xoá vẫn thuộc request của nó), §8 (phủ định chính xác của `polish`; polish phải chạm ≥2 bead), §9 (bỏ nguồn `provider` vì `totalCostUsd` là tổng luỹ kế của phiên — đổi một phần Q-035) |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | **Owner duyệt; cổng `design-ready` PASS.** Status Draft → Active. Ngoại lệ "soạn design trước `prd-ready`" đã kết thúc: PRD được duyệt cùng lượt, nên ngoại lệ chỉ còn giá trị lịch sử |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | **Bản 4 — theo lượt review độc lập bằng Codex trên plan Phase 2a.** Review chỉ ra hai lỗ hổng thật ở tầng design: (1) đường **ghi** và **xoá** chỉ kiểm tiền tố chuỗi nên vẫn bị symlink ở một thành phần dẫn ra ngoài kho, dù đường **đọc** ở §10 đã kiểm `lstat`; (2) chưa có hợp đồng tuần tự hoá giữa bộ thu thập và hai thao tác xoá/gán lại. Thêm §3.8 (bộ kiểm no-follow dùng chung + mutex trong tiến trình khoá theo `workspaceId` + thứ tự dừng plugin trước khi lệnh gỡ chạm kho), sửa §3.3, §3.5, §3.7 trỏ vào đó, thêm ba nhóm test ở §15, và sửa header vốn còn ghi REQ-040 → REQ-056 và "bốn RPC" |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | **Bản 3 sau khi owner chốt Q-040, Q-041 và một phần Q-039.** §3.2 thêm `meta.json` cho mỗi workspace (tên và đường dẫn cuối biết được); §3.6 chuyển việc so ngưỡng sang client qua `useSettings` và khai báo `defineSettings` phạm vi `host`; thêm §3.7 (phân loại `live`/`archived`/`orphaned` và thuật toán **gán lại**), RPC `traces.reassign`, mã lỗi `E_TRACE_REASSIGN_INVALID`, hai trường `workspaceState` và `reassignedFrom`; §14 thêm dòng delta cho REQ-010 (cập nhật không xoá kho); thêm test cho gán lại, phân loại workspace và cài đặt |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | **Bản 2 sau khi owner chốt Q-030 → Q-037.** Viết lại quyết định nền: thu thập theo hook sự kiện và **lưu vết bền trên đĩa** thay cho dẫn xuất-khi-đọc; thêm §3 (kho lưu vết: tìm thư mục cài đặt qua `config.plugins`, bố cục theo workspace và theo tháng, bản ghi, ghi atomic, xoá ba phạm vi, đo dung lượng), `traces.delete`, hai mã lỗi mới, §9 (token và chi phí, tính riêng token cache), §14 (danh sách phải delta-change cho tài liệu đã đóng băng). Ghi nhận giả định mới **A-2** về `timestamp` trong timeline của hook |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | Bản Draft đầu tiên, soạn cùng lượt với PRD tính năng theo ngoại lệ đã ghi. Dữ kiện Paseo 0.8 đọc từ khai báo kiểu của `@getpaseo/plugin` 0.8.0, `@getpaseo/client` 0.8.0, `@getpaseo/protocol` 0.8.0 |
