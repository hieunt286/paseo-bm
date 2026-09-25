# Delta plan — Kanban theo trạng thái, chữ yên tĩnh, tab cho Setup, đếm lỗi ở Metric

| Trường | Giá trị |
|---|---|
| Mã | `plan-delta-20260925-kanban-quiet-colours` |
| Plan gốc | [Implementation Plan v2](paseo-bm-implementation-plan-v2.md) (Active, Plan-ready PASS). **Không sửa tại chỗ** |
| Phase | **Phase 2a-11 — giao diện yên tĩnh và kanban** |
| Status | **Completed** (2026-09-25) — mọi bead của plan đã đóng; từ nay tài liệu sống thay cho chuỗi delta (xem `AGENTS.md`, mục Process). Trạng thái trước: **Active** |
| Plan-ready | **PASS — 2026-09-25 — hieu.nt10** (Beads Worker tự chấm theo `plan-ready-for-beads`; xem §6) |
| Routing decision | [design-delta-20260925-kanban-quiet-colours](../design/paseo-bm-delta-20260925-kanban-quiet-colours.md) §0 |
| Requirements | [prd-delta-20260925-kanban-quiet-colours](../product/paseo-bm-prd-delta-20260925-kanban-quiet-colours.md) — REQ-069 (a)–(g), errata REQ-060 (g)(h)(j)(k)(n) |
| Source design | [design-delta-20260925-kanban-quiet-colours](../design/paseo-bm-delta-20260925-kanban-quiet-colours.md) — nguồn duy nhất cho tên hàm, hình dạng dữ liệu và câu chữ |
| ADR | N/A — không thực thi quyết định ADR mới |
| Owner | hieu.nt10 |
| Created | 2026-09-25 |

## 1. MVP-Lock

### 1.1 Phạm vi Phase 2a-11

Sáu gói việc UI-1 → UI-6, phủ REQ-069 (a)–(g) và các tiêu chí A1–A10 của design §5.

### 1.2 Ngoài phạm vi phase này

- Kéo-thả bead giữa các cột (sẽ là ghi vào bead store từ UI; màn Beads chỉ đọc).
- Biểu đồ "lỗi theo ngày", bộ lọc "chỉ request lỗi", cảnh báo khi số lỗi tăng.
- Nhớ tab Setup / cột kanban đang chọn qua các lần mở app.
- Đổi màu ở màn Metric, thẻ chat, thẻ fallback, nút Delete (owner chốt Q1 a giữ nguyên).
- Cài bản mới lên daemon của chủ repo, phát hành npm, commit. Chủ repo tự quyết sau khi xem diff (AGENTS.md).

### 1.3 Điều kiện ra của phase

1. A1–A9 và A11 của design §5, mỗi tiêu chí có test, và mỗi tiêu chí về hành vi có một đối chứng đỏ đã chạy.
2. A10: `npm run verify` mã 0 (typecheck, typecheck:plugin, lint, test, build).
3. `br lint -s all` không cảnh báo bead của đợt này; `br dep cycles` sạch.
4. Một lượt review độc lập trước khi code (batch `b1`: PRD/design/plan + bead) và một lượt trên toàn bộ diff (batch `b2`); mọi finding chặn đã sửa.
5. PRD delta đã áp vào REQ-060 và REQ-069, `GUIDE.md` nói đúng những gì màn hình làm.

### 1.4 Hành vi người dùng đang dựa vào sẽ đổi

| Trước | Sau |
|---|---|
| Màn Beads: bốn nhóm xếp dọc, mỗi nhóm một vạch ngăn | Bốn cột kanban; hẹp thì một cột mỗi lần, chọn bằng tab trạng thái |
| Bead đã đóng ẩn cho tới khi bấm nút mắt | Hiện sẵn; nút mắt vẫn ẩn/hiện |
| Tên bead và chip mang màu trạng thái (accent/vàng/đỏ/xanh lá) | Chữ `foreground` khi chưa xong, `foregroundMuted` khi đã đóng; chữ vẫn ghi đủ trạng thái |
| Số đang làm vàng, số block đỏ, số Worker chạy xanh lá trên dòng workspace | Ba số đó dùng `foreground` khi > 0, xám khi = 0 |
| Setup: một trang cuộn dài bốn phần | Ba tab: Beads tools / Agent skills / Agents; tình trạng và cảnh báo ở trên dãy tab |
| Màn Metric: sáu thẻ tổng quan | Bảy thẻ; thẻ "Errors" ngay sau "Requests" |
| Giới hạn 200 dòng chia theo thứ tự nhóm | 100 dòng mỗi cột, cột nào cắt bớt thì nói ngay trong cột đó |
| Bead đổi trạng thái: dòng ở lại đúng chỗ, khung chi tiết và dòng kết quả còn nguyên (F9) | Dòng chuyển sang cột khác nên được dựng lại; dòng kết quả của hành động vẫn còn vì nằm trong sổ theo phiên `beadActionResults`, còn thẻ xác nhận đang mở (`pending`) thì đóng lại |

### 1.5 Tư thế hoàn tác (mặc định cho cả phase)

`git revert` cho mọi gói. Không migration, không file mới trên máy người dùng, không đổi hình dạng file trace, không điểm nào không lùi được. Trường `errors` là optional theo cả hai chiều (design §7), nên bản plugin cũ và mới đọc lẫn payload của nhau.

### 1.6 Hợp đồng công khai

Theo design §4. Chỉ một hợp đồng đang tiêu thụ đổi: `traceSummarySchema.errors` (optional, thêm mới). Người tiêu thụ duy nhất là client của chính plugin, ship chung bundle; bằng chứng tương thích là test parse payload **không có** trường đó.

## 2. Thứ tự và vì sao

Chuỗi thẳng UI-1 → UI-6:

- **UI-2 sau UI-1**: cùng sửa `client/beads-model.ts` và `client/beads-screen.tsx`; làm song song sẽ giẫm lên nhau và không tách được đối chứng đỏ.
- **UI-3** độc lập về file (`setup-screen.tsx`, `setup-model.ts`) nhưng xếp sau UI-2 để mỗi lần chỉ có một bead `in_progress`.
- **UI-5 sau UI-4**: thẻ Errors đọc trường `errors` mà UI-4 tạo ra.
- **UI-6 sau UI-1, UI-2, UI-3, UI-5**: tài liệu chỉ ghi lại thứ đã chạy được.

## 3. Gói việc

### UI-1 — Kanban của màn Beads

**Phụ thuộc:** không. **Design:** §3.1. **REQ:** 069 (a), (b), (c) — A1, A2, A3, A4.
**Stack:** plugin client.

- `client/beads-model.ts`: `KANBAN_MIN_COLUMN`, `KANBAN_COLUMN_LIMIT`, `kanbanLayout`, `kanbanColumns`, `defaultKanbanBucket`, `visibleKanbanBucket`; `closedBeadsVisibility` mặc định `true`; `createSessionMap` + `beadActionResults` để giữ F9 của delta 20260918f khi bead đổi cột (design §3.1); bỏ `groupBeads`, `beadListItems`, `BeadGroup`, `BeadListItem` khi không còn ai gọi.
- `client/beads-screen.tsx`: đo bề ngang vùng danh sách bằng `onLayout`, giữ cột đang chọn trong state. Phần **vẽ** nằm trong hai thành phần **không dùng hook** (`KanbanBoard`, `StatusTabs`, đặt cùng chỗ với các thành phần chung ở `client/ui.tsx`): chế độ `columns` vẽ hàng có `flexWrap`, mỗi cột trong ô `flexBasis: (100 / perRow)%`; chế độ `tabs` vẽ `tablist` + `tab` với số lượng; mỗi cột có tiêu đề kèm số, câu "cột rỗng", dòng "+N more" khi bị cắt. Không dùng hook để `renderTree` của `test/helpers/element-tree.ts` dựng được, đúng cách delta 20260918f kiểm các thành phần chung.
- Một thành phần `BeadsScreen` duy nhất nuôi cả hai lối vào (surface "Beads Manager" và tab "Beads" của workspace), nên không có bản vẽ thứ hai phải sửa.
- `client/beads-screen.tsx`: `BeadDetailPanel` đọc/ghi `beadActionResults` bằng `useSyncExternalStore` và `clear` khi mở hành động mới; hai ca F9 cũ của `test/plugin-beads-screen.test.ts` (quanh dòng 505 và 526) được **thay** bằng test của sổ này, không xoá trắng.
- **Ra:** A1–A4 và A11 có test: mô hình trong `test/plugin-beads-screen.test.ts`, phần vẽ trong `test/plugin-workspace-screen.test.ts` (bốn cột đúng thứ tự, cột rỗng vẫn có mặt, tab có `accessibilityRole="tab"` và trạng thái chọn). Đối chứng đỏ: `kanbanColumns` bỏ cột rỗng → test A1 đỏ; `kanbanLayout` chỉ đọc `compact` → test A2 đỏ; `beadActionResults` không giữ kết quả → test A11 đỏ.

### UI-2 — Trạng thái nói bằng chữ, không bằng màu

**Phụ thuộc:** UI-1. **Design:** §3.2. **REQ:** 069 (d), (e), errata REQ-060 (g)(h)(n) — A5, A6.
**Stack:** plugin client.

- `client/dashboard-model.ts`: tone `"plain"` trong `Tone` và `toneColor`.
- `client/beads-model.ts`: `BeadEmphasis`, `STATUS_EMPHASIS`, `beadEmphasis`, `emphasisTone`; `statusBadge` theo độ nhấn; bỏ `STATUS_TONE`, `beadTitleTone`; `workSummary().tone` chỉ `plain`/`muted`.
- `client/ui.tsx`: `beadTitleStyle(styles, theme, emphasis)` giữ `fontWeight: "400"`.
- `client/dashboard-view.ts`: `workspaceStats` dùng `plain`/`muted` cho ba con số.
- `client/beads-screen.tsx`: tiêu đề cột và tab không tô màu; "Clear all" dùng chữ thường. `client/bead-chips.tsx` theo `statusBadge` mới.
- Sửa các test đang ghim màu cũ cho khớp quyết định mới — đây là đổi quyết định có chủ ý, ghi ở PRD delta errata, không phải nới test cho xanh: `test/plugin-beads-screen.test.ts` (ánh xạ trạng thái → màu, bất biến chip cùng màu với tên), `test/plugin-dashboard-view.test.ts` (`STATUS_TONE` của `workspaceStats`), `test/plugin-workspace-screen.test.ts` (đang ghim `{ fontWeight: "400", color: "#statusWarning" }` của tên bead — chính chỗ chứng minh A6).
- **Ra:** A5, A6. Đối chứng đỏ: `statusBadge` trả lại `warning` cho `in_progress` → test bất biến "chỉ `plain`/`muted`" đỏ.

### UI-3 — Ba tab của màn Setup

**Phụ thuộc:** UI-2 (thứ tự làm, không dùng chung file). **Design:** §3.3. **REQ:** 069 (f) — A7.
**Stack:** plugin client.

- `client/setup-model.ts`: `SetupTab`, `SETUP_TABS`, `DEFAULT_SETUP_TAB`.
- `client/setup-screen.tsx`: dãy tab vẽ bằng thành phần **không dùng hook** (`StatusTabs` của UI-1 nếu vừa, không thì một thành phần tab riêng cùng hình dạng) với `tablist`/`tab` và `accessibilityState.selected`; tiêu đề, nút Workspaces, dải trạng thái, `setupHeadline`, `paseoToolsWarnings` ở trên dãy tab; ba phần thân theo tab; dòng phiên bản ở cuối, ngoài tab.
- **Ra:** A7 có test trong `test/plugin-setup-model.test.ts` (tên và thứ tự tab) và `test/plugin-structure.test.ts` hoặc test màn Setup (cảnh báo nằm ngoài tab, có vai trò tab). Đối chứng đỏ: bỏ `paseoToolsWarnings` vào trong một tab → test đỏ.

### UI-4 — `errors` trên mỗi dòng trace

**Phụ thuộc:** không (làm sau UI-3 để giữ một bead `in_progress`). **Design:** §3.4. **REQ:** 069 (g) — A8.
**Stack:** plugin shared + server.

- `shared/contracts.ts`: `traceErrorsSchema`, `traceSummarySchema.errors` optional.
- `server/traces.ts`: `SummariseDeps.fallbacksOf?`; `summarise` đếm `failedTurns`, và `agentErrors` chỉ cho agent `error` **không có** bản ghi turn `failed` trong trace (không đếm trùng); `summariseSegments` chỉ đặt `agentErrors`/`fallbacks` ở lượt `index === 1`.
- `server/dashboard-rpc.ts`: `incidentsIn(home)` đọc `role-fallback-state.json` một lần, dùng cho `reviewerReplacementIds` và `fallbackCountsOf(incidents, workspaceId)` — chỉ đếm sự cố `signal: "completed"`, vì sự cố `signal: "failed"` đã nằm trong `failedTurns`; `readTraceContext` trả `fallbackCounts`; `handleTracesList` và `handleTracesGet` truyền `fallbacksOf`.
- **Ra:** A8 có test trong `test/plugin-traces-segments.test.ts` (chia lượt, agent `error` đã có bản ghi failed thì không tính thêm) và `test/plugin-dashboard-rpc.test.ts` (sự cố fallback vào đúng request, `signal: "failed"` không tính lại) + một test parse payload thiếu `errors`. Đối chứng đỏ: đặt `fallbacks` ở mọi lượt → test "không đếm trùng" đỏ.

### UI-5 — Thẻ "Errors" ở màn Metric

**Phụ thuộc:** UI-4. **Design:** §3.5. **REQ:** 069 (g) — A9.
**Stack:** plugin client.

- `client/dashboard-model.ts`: `ErrorTally`, `errorTally`, `errorCard`; `overviewCards` trả thẻ "Errors" ngay sau "Requests".
- Hint ghi "<n> request(s) with an error" (đếm theo `traceId`), vì thẻ "Requests" bên cạnh đếm dòng (một dòng mỗi lượt hỏi) — hai con số không được đọc lẫn.
- **Ra:** A9 có test trong `test/plugin-dashboard-model.test.ts`. Đối chứng đỏ: `errorTally` cộng cả `agentErrors` của mọi lượt → test "không đếm trùng qua nhiều lượt" đỏ.

### UI-6 — Áp PRD delta và cập nhật GUIDE.md

**Phụ thuộc:** UI-1, UI-2, UI-3, UI-5. **Design:** §0, §5. **REQ:** Q2 a của owner — không thêm REQ mới.
**Stack:** tài liệu.

- [Dashboard PRD](../../product/paseo-bm-dashboard-prd.md): sửa REQ-060 (g)(h)(j)(k)(n) theo bảng errata, thêm dòng REQ-069, thêm một dòng Revision History trỏ về PRD delta. Status giữ **Accepted**.
- `GUIDE.md`: mục "Beads: the workspace's beads" (bốn cột, tab trạng thái khi hẹp, bead đã đóng hiện sẵn, chữ đậm/mờ thay màu), mục "The Beads Manager screen" (ba tab của Setup), mục "Metric" (thẻ Errors và nó đếm gì).
- **Ra:** không còn câu nào trong PRD hay `GUIDE.md` tả màu cũ, danh sách dọc, hay mặc định ẩn bead đã đóng (kiểm bằng `grep`), và `npm run verify` vẫn xanh.

## 4. Phụ thuộc

```
UI-1 → UI-2 → UI-3 → UI-4 → UI-5 → UI-6
```

Cạnh thật: UI-2 cần model kanban của UI-1 (cùng file, tiêu đề cột dùng `emphasis`); UI-5 cần trường `errors` của UI-4; UI-6 cần cả bốn gói code đã chạy để tả đúng. Cạnh UI-2 → UI-3 và UI-3 → UI-4 là **thứ tự thực thi** (một bead `in_progress` mỗi lần), không phải nhu cầu kỹ thuật. Không có vòng.

## 5. Kiểm thử

Theo quy ước repo: Vitest, test mô hình thuần (không renderer) cho mọi quyết định của client — đúng cách `test/plugin-beads-screen.test.ts` và `test/plugin-dashboard-model.test.ts` đang làm; test server dùng trace store thật trong thư mục tạm như `test/plugin-traces-segments.test.ts`. Không thêm công cụ test mới, không snapshot mới. Mỗi tiêu chí hành vi có một đối chứng đỏ chạy trước khi sửa (§3, từng gói).

## 6. `plan-ready-for-beads` — tự chấm

- ✓ Header: Status, Plan-ready, Owner, Routing Decision, REQ và design nguồn, phase có tên.
- ✓ MVP-Lock: phạm vi (§1.1), ngoài phạm vi (§1.2), điều kiện ra (§1.3), tư thế hoàn tác mặc định (§1.5), hợp đồng công khai (§1.6).
- ✓ Mỗi gói có kết quả, REQ/A-code, design ref, phụ thuộc, điều kiện ra kiểm được, stack.
- ✓ Cạnh phụ thuộc có lý do, không vòng; cạnh chỉ vì thứ tự được ghi rõ là thứ tự.
- ✓ Rủi ro: ba rủi ro vật chất, có cách giảm — (1) bỏ `groupBeads` làm đỏ test cũ: UI-1 xoá cùng test của chúng và ghi vào close reason; (2) `errors` sai chỗ làm đếm trùng: A8 có đối chứng đỏ đúng cho việc đó; (3) `onLayout` có thể không bao giờ chạy (tab bị ẩn, host cũ) nên bề ngang là `null`: `kanbanLayout` đi theo `compact` của host trong ca đó, và A2 có một ca `width === null` cho cả hai giá trị `compact`.
- ✓ Không còn câu hỏi mở (design §9).
- ✓ Kiểm thử theo quy ước repo (§5).

## Revision History

| Ngày | Thay đổi | Người |
|---|---|---|
| 2026-09-25 | Tạo, Active, Plan-ready PASS | hieu.nt10 (Beads Worker thực hiện) |
| 2026-09-25 | Sau review `b1`: UI-1 giữ F9 bằng `beadActionResults` (tiêu chí A11, §1.4 có dòng hành vi đổi); UI-4 đếm không chồng nhau; UI-5 sửa câu chữ hint | hieu.nt10 (Beads Worker thực hiện) |
