# Delta-change — Kanban theo trạng thái, chữ yên tĩnh, tab cho Setup, đếm lỗi ở Metric

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260925-kanban-quiet-colours` |
| Tài liệu gốc | [Technical Design Dashboard](./paseo-bm-dashboard.md) (màn Beads, màn Metric, surface Beads Manager); các delta đang sống mà delta này chạm tới: [20260916-beads-screen](./paseo-bm-delta-20260916-beads-screen.md) (danh sách, bộ lọc, chi tiết), [20260918e-beads-tab](./paseo-bm-delta-20260918e-beads-tab.md) §4.1–§4.4 (tab Beads, Setup là màn chính, màu trạng thái, bốn nhóm, nút mắt), [20260918f-ui-review](./paseo-bm-delta-20260918f-ui-review.md) (một dòng phẳng cho danh sách), [20260916-setup-screen](./paseo-bm-delta-20260916-setup-screen.md) (các phần của Setup), [20260921-worker-fallback-and-role-settings](./paseo-bm-delta-20260921-worker-fallback-and-role-settings.md) §4.4 (sự cố fallback). **Không sửa tại chỗ** |
| PRD | [prd-delta-20260925-kanban-quiet-colours](../product/paseo-bm-prd-delta-20260925-kanban-quiet-colours.md) — REQ-069, errata REQ-060 (g)(h)(j)(k)(n). Status Accepted (owner chốt Q1–Q4) |
| Plan | [plan-delta-20260925-kanban-quiet-colours](../plans/paseo-bm-implementation-plan-delta-20260925-kanban-quiet-colours.md) |
| Status | **Active** |
| Owner | hieu.nt10 |
| Created | 2026-09-25 |
| ADR | N/A — không thêm công nghệ hay phụ thuộc, không đảo ADR nào. ADR-007 (trace store chỉ đọc ở client) giữ nguyên: phần đếm lỗi chỉ đọc bản ghi đã có |
| Request | `req-20260925T015709Z` |

**Thiết kế này sở hữu:** bố cục kanban của màn Beads (§3.1), cách nói trạng thái bằng chữ thay cho màu ở mọi chỗ hiện bead (§3.2), ba tab của màn Setup (§3.3), trường `errors` của một dòng trace và cách đếm (§3.4), thẻ "Errors" của màn Metric (§3.5).

**Không sở hữu:** `plugin/roles/*.md` và chỉ dẫn vai trò; cách thu bản ghi trace (collector); nội dung chi tiết bead và ba hành động; bộ lọc, cách sắp, các thẻ tổng quan hiện có của màn Beads (giữ nguyên, chỉ phần danh sách đổi thành cột).

## 0. Routing Decision

- **Variant preset:** brownfield — sửa bốn màn đang chạy trong payload đã phát hành.
- **Triggered risks:**
  - đổi hành vi người dùng đang dựa vào và **đang được ghi trong PRD Accepted**: REQ-060 (g)(h)(j)(k)(n);
  - đổi một hợp đồng đang được tiêu thụ: `traceSummarySchema` thêm `errors` (§3.4). Người tiêu thụ duy nhất là client của chính plugin, và hai phía ship chung một bundle; trường là optional nên payload cũ vẫn parse;
  - bốn kết quả độc lập trong một request, chạm cả `client/`, `server/` và `shared/`.
- **Artifacts và cổng:** PRD delta (REQ-069 + errata) + `prd-ready`; delta này + `design-ready`; plan delta + `plan-ready-for-beads`; bead theo plan; review trước khi code (batch `b1`) và review toàn bộ diff (batch `b2`); `feature-done` profile standard.
- **Execution path:** plan → converter (sáu gói việc, một chuỗi thẳng).
- **Exceptions:** none.
- **Decided:** 2026-09-25 — hieu.nt10 (Q1 a, Q2 a, Q3 a, Q4 a của `req-20260925T015709Z`), Beads Worker soạn.
- **Supersedes:** none. Errata cho REQ-060 nằm ở PRD delta, không sửa delta 20260918e.

## 1. Owner chốt gì (2026-09-25)

| Mã | Câu hỏi | Owner chốt |
|---|---|---|
| Q1 | Phạm vi bỏ màu chữ | **(a)** Chỉ các chỗ hiện bead: chưa xong = chữ đậm (tương phản đầy), đã đóng = chữ mờ, trạng thái vẫn ghi bằng từ. Các màn khác giữ đỏ/vàng cho lỗi và cảnh báo |
| Q2 | Tài liệu | **(a)** PRD delta + design delta + plan delta, rồi áp PRD delta vào REQ-060 kèm một dòng Revision History, và cập nhật `GUIDE.md` |
| Q3 | "Errors" đếm gì | **(a)** Mọi lần lỗi: turn kết thúc `failed`, agent kết thúc ở trạng thái `error`, và mỗi sự cố fallback nhà cung cấp. Thẻ đọc "N errors · M requests". Thêm một trường tuỳ chọn vào dòng trace |
| Q4 | Cột Closed | **(a)** Closed là một cột như các cột khác và hiện sẵn; nút mắt vẫn ẩn/hiện nó |

Ba điều Worker tự quyết (owner có thể đảo): ba tab của Setup đúng ba cấu hình owner kể (§3.3); kanban đọc bề rộng đo được để chọn tab hay cột (§3.1); "đậm/nhạt" làm bằng **độ tương phản**, không bằng nét chữ, để REQ-060 (i) — "tên bead không in đậm", cũng vì mỏi mắt — vẫn đứng (§3.2).

## 2. Hiện trạng

| Chỗ | Hôm nay | Vì sao phải đổi |
|---|---|---|
| `client/beads-screen.tsx` | `beadListItems(groupBeads(...))` trả một dòng phẳng: tiêu đề nhóm rồi các dòng bead, bốn nhóm xếp dọc | Trên màn rộng, ba phần tư bề ngang trống; bốn nhóm dọc phải cuộn mới thấy hết |
| `client/beads-model.ts` `STATUS_TONE` | Bốn trạng thái bốn màu (accent, vàng, đỏ, xanh lá), dùng cho tên bead, chip, tiêu đề nhóm | Owner: "nhìn nhiều màu rất mỏi mắt" |
| `client/dashboard-view.ts` `workspaceStats` | Số đang làm vàng, số block đỏ, số Worker chạy xanh lá | Cùng lý do, cùng một dòng người dùng nhìn |
| `client/setup-screen.tsx` | Bốn phần (Beads tools, Agent skills, Roles & models, Additional instructions) trong một `ScrollView` dài | Owner: "scroll kéo dài cả cái cấu hình nhìn rất khó" |
| `client/dashboard.tsx` + `dashboard-model.ts` | Sáu thẻ tổng quan; lỗi chỉ thấy ở badge "Failed" của từng dòng | Không có chỗ nào nói "request bị lỗi mấy lần" |
| `server/traces.ts` `stateOf` | Đã biết `record.outcome === "failed"` và agent `status === "error"`, nhưng chỉ dùng để suy ra một trạng thái | Trạng thái là **hiện tại**: request lỗi rồi chạy lại xong đọc là "Completed", số lần lỗi mất hẳn |

## 3. Thiết kế

### 3.1 Kanban của màn Beads

Mọi quyết định nằm trong `client/beads-model.ts` (thuần, test không cần renderer); `beads-screen.tsx` chỉ vẽ.

```ts
/** Bao nhiêu px một cột cần để còn đọc được. */
export const KANBAN_MIN_COLUMN = 260;
/** Bao nhiêu dòng một cột vẽ trước khi nói "+N more". */
export const KANBAN_COLUMN_LIMIT = 100;

export interface KanbanLayout {
  /** `tabs`: một cột mỗi lần, chọn bằng dãy tab. `columns`: các cột cạnh nhau. */
  mode: "tabs" | "columns";
  /** Bao nhiêu cột một hàng chứa được; 1 khi ở chế độ tab. */
  perRow: number;
}

/**
 * `width` là bề ngang đo được của vùng danh sách (`onLayout`), `null` khi chưa
 * đo xong — lúc đó đi theo `compact` của host.
 */
export function kanbanLayout(width: number | null, compact: boolean, buckets: number): KanbanLayout;

export interface KanbanColumn {
  bucket: StatusBucket;
  /** Chữ của chip trạng thái, để cột và bead trong nó đọc giống nhau. */
  label: string;
  /** Mọi bead của cột sau bộ lọc, kể cả phần không vẽ. */
  total: number;
  beads: BeadRow[];
  /** Bao nhiêu bead bị giới hạn dòng cắt bớt; mỗi cột tự nói con số của mình. */
  hidden: number;
  /** Câu nói cột rỗng, để bố cục không nhảy khi lọc. */
  empty: string;
}

/** Bốn cột theo `STATUS_GROUP_ORDER`; Closed chỉ có khi `showClosed`. Cột rỗng vẫn trả về. */
export function kanbanColumns(
  beads: readonly BeadRow[],
  options: { showClosed: boolean; limit?: number },
): { columns: KanbanColumn[]; visible: number; closed: number };

/** Cột mở sẵn ở chế độ tab: cột đầu tiên có bead, nếu không thì cột đầu. */
export function defaultKanbanBucket(columns: readonly KanbanColumn[]): StatusBucket;
/** Cột đang chọn, hay `defaultKanbanBucket` khi cột đó đã biến mất (đổi bộ lọc, tắt Closed). */
export function visibleKanbanBucket(columns: readonly KanbanColumn[], selected: StatusBucket | null): StatusBucket;
```

- **Thứ tự cột** giữ nguyên `STATUS_GROUP_ORDER`: `in_progress` → `blocked` → `ready` → `closed` (quyết định cũ của owner ở delta 20260918e, không có lý do đổi).
- **Giới hạn dòng** đổi từ "200 dòng cho cả danh sách, chi theo thứ tự nhóm" (`groupBeads`) sang **`KANBAN_COLUMN_LIMIT` dòng mỗi cột**: một cột Closed dài không được phép ăn hết chỗ của cột In progress. `groupBeads`/`beadListItems` không còn ai gọi thì xoá cùng test của chúng. Không còn con số `truncated` cho cả bảng: giới hạn nay tính theo từng cột nên mỗi cột tự nói `hidden` của mình, ngay chỗ người đọc đang nhìn (errata sau review b2).
- **`mode`**: `width === null` → theo `compact`; `width < 2 * KANBAN_MIN_COLUMN` → `tabs`; còn lại `columns` với `perRow = min(buckets, floor(width / KANBAN_MIN_COLUMN))`.
- **Vẽ**: một `View` hàng có `flexWrap`, mỗi cột nằm trong một ô `flexBasis: (100 / perRow)%` với `padding` làm khoảng cách — phần trăm cộng đúng 100% nên không tràn hàng. Chế độ `tabs`: một `View` `accessibilityRole="tablist"`, mỗi tab `accessibilityRole="tab"` + `accessibilityState={{ selected }}`, chữ `"<tên> <số>"`.
- **F9 của delta 20260918f phải được giữ bằng cách khác.** Hôm nay mọi dòng bead là em của MỘT cha và khoá theo id bead, nên một bead đổi trạng thái sau lần refresh vẫn giữ dòng của nó và khung chi tiết đang mở. Chia cột nghĩa là các dòng nằm dưới nhiều cha khác nhau: bead đổi cột thì React tháo dòng cũ và dựng dòng mới, nên state trong `BeadDetailPanel` (`pending`, `busy`, `result`) mất — đúng lúc người dùng vừa bấm Assign / Close / Delete và đang đọc dòng kết quả kèm nút "Open the Beads Manager". Thứ F9 mua được vẫn phải còn, nên **dòng kết quả của hành động chuyển sang một sổ theo phiên** trong `beads-model.ts`:

```ts
export interface SessionMap<T> {
  /** Trả về đúng object đã lưu, nên ổn định giữa các lần render: `useSyncExternalStore` đọc thẳng nó, không cần snapshot. */
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  clear(key: string): void;
  subscribe(listener: () => void): () => void;
}
export function createSessionMap<T>(): SessionMap<T>;
/** Khoá của một bead trong sổ: hai workspace có thể cùng một id bead. */
export function beadResultKey(workspaceId: string, beadId: string): string;
/** Kết quả hành động cuối trên một bead, sống qua lần dựng lại dòng khi bead đổi cột. */
export const beadActionResults: SessionMap<{ text: string; managerId: string | null; tone: Tone }>;
```

  `BeadDetailPanel` đọc sổ bằng `useSyncExternalStore` (giống `closedBeadsVisibility`), ghi khi một hành động xong, và `clear` khi người dùng mở một hành động mới. `pending` và `busy` vẫn là state trong panel: chúng chỉ sống vài giây xác nhận, và mất chúng khi bead đổi cột không xoá bằng chứng gì. Hai test đang ghim F9 (`test/plugin-beads-screen.test.ts`, các ca quanh dòng 505 và 526) được **thay** bằng test của sổ này, không phải xoá trắng.
- **Phần vẽ không dùng hook**: `KanbanBoard` (các cột) và `StatusTabs` (dãy tab) nằm cùng chỗ với các thành phần chung ở `client/ui.tsx`, nhận dữ liệu đã tính sẵn. Không hook là điều kiện để `renderTree` của `test/helpers/element-tree.ts` dựng được — cùng cách delta 20260918f kiểm `BeadRowCard` và `WorkspaceScreenHeader`. `BeadsScreen` giữ phần trạng thái (bề ngang đo được, cột đang chọn) và vẫn là thành phần duy nhất cho cả surface lẫn tab "Beads".
- **Dòng bead** vẫn là `BeadRowCard` như hôm nay: bấm để mở chi tiết ngay trong thẻ, cùng ba hành động. Không đổi gì trong chi tiết.
- **Bead đã đóng hiện sẵn**: `closedBeadsVisibility = createSessionToggle(true)`. Nút mắt, số lượng và câu "mọi bead khớp đều đã đóng" giữ nguyên, chỉ mặc định đổi.
- **Phần trên màn giữ nguyên**: thẻ tổng quan, Progress, hai biểu đồ, thẻ Time, ô tìm kiếm, chip bộ lọc, dãy Sort, dòng `N of M beads` và nút mắt.

### 3.2 Trạng thái nói bằng chữ, không bằng màu

- `toneColor` nhận thêm một tone **`"plain"` → `theme.colors.foreground`**. Đây là cách duy nhất thêm vào bảng màu: không có mã màu nào viết cứng, vẫn đúng ở theme sáng và tối.
- `STATUS_TONE` bị thay bằng:

```ts
export type BeadEmphasis = "strong" | "dim";
/** Bead chưa xong đọc rõ, bead đã đóng đọc mờ (REQ-069 d). */
export const STATUS_EMPHASIS: Readonly<Record<StatusBucket, BeadEmphasis>> = {
  ready: "strong", in_progress: "strong", blocked: "strong", closed: "dim",
};
export function beadEmphasis(bead: Pick<BeadRow, "status" | "ready">): BeadEmphasis;
/** Tone của chữ theo độ nhấn: `strong` → `plain`, `dim` → `muted`. */
export function emphasisTone(emphasis: BeadEmphasis): Tone;
```

- `statusBadge(bead)` trả `{ text, tone: emphasisTone(beadEmphasis(bead)) }` — chữ chip không đổi, nên chip và tên vẫn luôn cùng độ tương phản (bất biến cũ của REQ-060 (h), giữ nguyên hình dạng, đổi giá trị).
- `beadTitleStyle(styles, theme, emphasis)` nhận `BeadEmphasis | null` thay cho `Tone | null`: `fontWeight` vẫn `"400"`, chỉ `color` đổi (`foreground` / `foregroundMuted`). `beadTitleTone` bị thay bởi `beadEmphasis`.
- Tiêu đề cột kanban và tab trạng thái: `styles.sectionTitle` không tô màu (đậm là vì nó là tiêu đề, không phải vì trạng thái).
- `workSummary(...).tone`: `running` → `"plain"`, còn lại → `"muted"` (bỏ `info`/`warning`). Chữ vẫn nói Worker đang chạy, đã nghỉ hay không còn trong Paseo.
- `workspaceStats`: `inProgress`, `blocked` và `running` dùng `"plain"` khi lớn hơn 0, `"muted"` khi bằng 0.
- "Clear all" của dãy chip bộ lọc: chữ `plain` thay cho đỏ (nó không xoá dữ liệu gì, chỉ bỏ bộ lọc).
- **Giữ nguyên**: dòng lỗi RPC (đỏ), cảnh báo store (vàng), chip "+N more"/"show less" (accent), mọi màu ở màn Metric, thẻ chat, thẻ fallback, nút Delete (Q1 a).

### 3.3 Ba tab của màn Setup

`client/setup-model.ts` (thuần):

```ts
export type SetupTab = "tools" | "skills" | "agents";
export const SETUP_TABS: ReadonlyArray<{ key: SetupTab; label: string; hint: string }> = [
  { key: "tools",  label: "Beads tools",  hint: "br and bv on the daemon's PATH" },
  { key: "skills", label: "Agent skills", hint: "skills each role needs" },
  { key: "agents", label: "Agents",       hint: "models, modes and extra instructions" },
];
export const DEFAULT_SETUP_TAB: SetupTab = "tools";
```

- `SetupScreen` giữ `useState<SetupTab>(DEFAULT_SETUP_TAB)` — đúng cách tab con của `BeadsTabPanel` đang làm; mở lại surface thì về tab đầu.
- Thứ tự ở trên dãy tab, **không nằm trong tab nào**: tiêu đề, nút "Workspaces", câu giới thiệu, dải trạng thái, spinner, dòng lỗi, `setupHeadline`, `paseoToolsWarnings`. Một công cụ thiếu vì thế không bao giờ bị tab che.
- Trong tab: `tools` → các `ToolCard` + dòng "Newest versions as of …"; `skills` → nút Test + thẻ skill + `CommandLine`; `agents` → `RolesSection` + "Additional instructions" + các `RoleCard`.
- Dòng `paseo-bm <version>` ở cuối màn, ngoài tab.

### 3.4 Đếm lỗi: bản ghi đã có, chỉ chưa ai cộng

`shared/contracts.ts`:

```ts
/**
 * Lỗi của một dòng trace, bất kể lý do (REQ-069 g). Ba trường **không chồng
 * nhau**, nên cộng lại là số lần lỗi thật, không phải ba góc nhìn của cùng một
 * lần chết.
 */
export const traceErrorsSchema = z.object({
  /** Turn của **dòng này** kết thúc `failed`. */
  failedTurns: z.number().int().nonnegative(),
  /**
   * Agent của request đang ở trạng thái `error` của Paseo **mà không có** bản
   * ghi turn `failed` nào trong trace này (agent bị giết trước khi kịp ghi).
   * Chỉ đặt ở dòng mở request.
   */
  agentErrors: z.number().int().nonnegative(),
  /**
   * Sự cố fallback nhà cung cấp của request này **mà turn vẫn kết thúc
   * `completed`** (`signal: "completed"` — lượt chạy xong mà không làm gì).
   * Sự cố có `signal: "failed"` đã nằm trong `failedTurns`, nên không tính lại.
   * Chỉ đặt ở dòng mở request.
   */
  fallbacks: z.number().int().nonnegative(),
});
// traceSummarySchema thêm:
errors: traceErrorsSchema.optional(),
```

`optional()` để payload của server cũ vẫn parse, đúng luật tương thích hai chiều của Dashboard PRD.

- **`failedTurns`** đếm trong `summarise` từ `trace.records` — `summariseSegments` truyền records của từng lượt, nên một lượt hỏi lỗi được tính cho đúng dòng của nó.
- **`agentErrors`** và **`fallbacks`** thuộc cả request chứ không thuộc một lượt, nên `summariseSegments` chỉ đặt chúng ở dòng `index === 1` và để 0 ở các dòng sau — cùng cách `requestsPerDay` chỉ đếm dòng mở request. Nhờ vậy cộng cả danh sách không đếm trùng.
- **`agentErrors` không đếm trùng**: một agent `error` gần như luôn đã ghi một turn `failed`; chỉ khi không có bản ghi nào của agent đó trong trace này (bị giết trước khi ghi) thì nó mới là một lần lỗi chưa được đếm. Vì `errorsOf` chỉ thấy các bản ghi được đưa cho nó, `summariseSegments` lấy `agentErrors` và `fallbacks` của dòng mở **từ bản tóm tắt cả trace**, không từ đoạn: một Worker chết ở lượt hỏi thứ hai mà vẫn ở trạng thái `error` sẽ bị đếm hai lần nếu đọc theo đoạn (review `b2`).
- **Nguồn `fallbacks`**: `SummariseDeps` thêm `fallbacksOf?: (requestId: string | null) => number` (thiếu thì đọc 0). `server/dashboard-rpc.ts` dựng nó từ `role-fallback-state.json`: `readTraceContext` đọc file **một lần** bằng `incidentsIn(home)` mới, đưa danh sách cho `reviewerReplacementIds` (đang gọi `reviewerReplacementsIn`, cũng đọc file đó) và cho `fallbackCountsOf(incidents, workspaceId)` trả `Map<requestId, số sự cố>`. Mọi trạng thái (`pending`, `switched`, `waiting`, ...) đều tính, nhưng **chỉ sự cố `signal: "completed"`**: sự cố `signal: "failed"` sinh ra từ đúng một turn đã `failed`, và turn đó đã được `failedTurns` đếm (`server/fallback-detect.ts`: N1 = turn failed, N2 = turn completed mà không làm gì). Sự cố của Manager (`requestId` null) không thuộc request nào và không được tính.
- Không đổi collector, không đổi file trace: chỉ cộng những gì đã ghi.

### 3.5 Thẻ "Errors" ở màn Metric

`client/dashboard-model.ts`:

```ts
export interface ErrorTally {
  total: number; requests: number;
  failedTurns: number; agentErrors: number; fallbacks: number;
}
/** Cộng `errors` của các dòng đang hiện; dòng không có trường đọc là 0. */
export function errorTally(traces: readonly TraceSummary[]): ErrorTally;
/** Thẻ tổng quan: giá trị là `total`, hint nói số request và phân loại. */
export function errorCard(tally: ErrorTally): OverviewCard;
```

- `overviewCards` trả thẻ "Errors" ngay sau "Requests" (bảy thẻ).
- Chữ: `total = 0` → giá trị `0`, hint `"no error recorded"`. Ngược lại hint `"<n> request(s) with an error · <a> failed turn(s) · <b> agent error(s) · <c> provider fallback(s)"`, bỏ phần bằng 0. Chữ "request(s) with an error" nói rõ đơn vị: thẻ "Requests" bên cạnh đếm **dòng** (một dòng mỗi lượt hỏi từ delta 20260917e), còn số này đếm **request** theo `traceId`, nên hai con số không bao giờ bị đọc lẫn.
- Vì ba trường của `errors` không chồng nhau (§3.4), `total` là số lần lỗi thật: một lần hết hạn mức làm turn chết được đếm **một** lần, ở `failedTurns`.
- Thẻ không tô màu: nó là con số để theo dõi, không phải báo động, và màn Metric không nằm trong phạm vi Q1 a.

## 4. Hợp đồng công khai

| Hợp đồng | Đổi gì | Ai chịu ảnh hưởng |
|---|---|---|
| `traceSummarySchema` / `traceDetailSchema` | Thêm `errors` (optional) | Client của chính plugin; hai chiều tương thích |
| RPC `traces.list`, `traces.get` | Thêm trường trong payload, không đổi đầu vào | Như trên |
| Hàm client `STATUS_TONE`, `beadTitleTone`, `groupBeads`, `beadListItems` | Bị thay/bỏ | Chỉ code trong `plugin/client` và test |
| Lệnh, cờ, mã thoát CLI; file trace; `.beads/` | Không đổi | — |

## 5. Tiêu chí nghiệm thu

| Mã | Tiêu chí | Bằng chứng |
|---|---|---|
| A1 | Ở bố cục rộng, màn Beads vẽ bốn cột In progress → Blocked → Ready → Closed, mỗi cột có tên kèm số lượng; cột rỗng vẫn có mặt và nói rõ là rỗng | test `kanbanColumns` (có Closed, không Closed, cột rỗng, giới hạn dòng) |
| A2 | `kanbanLayout`: hẹp → `tabs`; rộng → `columns` với `perRow` đúng theo bề ngang; chưa đo được → theo `compact` | test theo bảng bề ngang (null/360/600/800/1200) |
| A3 | Ở chế độ tab, cột mở sẵn là cột đầu tiên có bead; cột đang chọn biến mất thì quay về mặc định | test `defaultKanbanBucket`, `visibleKanbanBucket` |
| A4 | Bead đã đóng hiện sẵn; nút mắt vẫn ẩn/hiện và nhớ trong phiên | test `closedBeadsVisibility` mặc định `true` |
| A5 | Không còn hue ở chỗ hiện bead: `beadEmphasis` chỉ trả `strong`/`dim`; `statusBadge().tone` luôn là `plain` hay `muted`; `workspaceStats` và `workSummary` cũng vậy; chữ chip vẫn ghi đủ bốn trạng thái | test ánh xạ cho cả bốn trạng thái + bất biến "chip cùng độ nhấn với tên"; test `workspaceStats` |
| A6 | Tên bead vẫn không in đậm (`fontWeight: "400"`) | test `beadTitleStyle` |
| A7 | Setup có ba tab đúng tên; mỗi lần một phần; `setupHeadline` và `paseoToolsWarnings` nằm ngoài tab | test `SETUP_TABS`/`DEFAULT_SETUP_TAB` + test cấu trúc màn (regex trên file: dãy tab trước phần thân, `accessibilityRole="tab"`) |
| A8 | `errors` có trên mọi dòng: `failedTurns` theo từng lượt, `agentErrors`/`fallbacks` chỉ ở dòng mở; payload không có trường đọc là 0 | test `summarise`/`summariseSegments` với bản ghi `failed`, agent `error`, và `fallbacksOf` |
| A9 | Thẻ "Errors" đọc đúng: 0 → "no error recorded"; có lỗi → "<n> request(s) with an error" (đếm theo `traceId`) và phân loại, không đếm trùng qua nhiều lượt; một lần hết hạn mức làm turn chết chỉ ra **một** lỗi | test `errorTally`, `errorCard`, `overviewCards`, và một ca "sự cố fallback `signal: failed` + turn failed của cùng một lượt" |
| A10 | `npm run verify` mã 0; `br lint -s all` không cảnh báo bead đợt này; `br dep cycles` sạch | lệnh chạy, ghi trong close reason |
| A11 | F9 của delta 20260918f vẫn đứng qua bố cục cột: dòng kết quả của hành động trên một bead sống qua lần dựng lại dòng khi bead đổi cột, không lẫn sang workspace khác, và mất đi khi người dùng mở hành động mới | test `beadActionResults` (ghi rồi đọc lại bằng một người đọc mới, theo từng workspace và bead, `clear` khi có hành động mới) — thay cho hai ca F9 cũ |

Mỗi tiêu chí về hành vi có **một đối chứng đỏ** đã chạy trước khi sửa (ví dụ: `kanbanColumns` bỏ cột rỗng thì A1 đỏ; `summariseSegments` đặt `fallbacks` ở mọi lượt thì A8 đỏ).

## 6. Gói việc (chi tiết ở plan)

UI-1 kanban → UI-2 chữ yên tĩnh → UI-3 tab Setup → UI-4 `errors` phía server → UI-5 thẻ Errors → UI-6 tài liệu. Chuỗi thẳng: UI-1 và UI-2 cùng sửa `beads-model.ts` và `beads-screen.tsx`; UI-5 cần trường của UI-4; UI-6 chỉ ghi lại thứ đã chạy.

## 7. Tư thế hoàn tác

Mọi gói lùi được bằng `git revert`: không có migration, không có file mới ở máy người dùng, không đổi hình dạng file trace. Bản cũ của plugin đọc payload mới bình thường (trường `errors` optional), và bản mới đọc payload cũ ra 0 lỗi. Bỏ delta này thì màu cũ và danh sách dọc trở lại y như trước.

## 8. Ngoài phạm vi (gợi ý, không làm)

- Kéo-thả bead giữa các cột: sẽ là **ghi** vào bead store từ UI, mà màn Beads theo thiết kế chỉ đọc.
- Biểu đồ "lỗi theo ngày" ở màn Metric, hay bộ lọc "chỉ request lỗi".
- Nhớ tab Setup và cột kanban đang chọn qua các lần mở app (cần chỗ lưu cài đặt).
- Đổi màu ở màn Metric, thẻ chat, thẻ fallback (owner chốt Q1 a giữ nguyên).

## 9. Câu hỏi mở

Không còn. Q1–Q4 đã được trả lời ngày 2026-09-25.

## Revision History

| Ngày | Thay đổi | Người |
|---|---|---|
| 2026-09-25 | Tạo, Status Active, theo Q1–Q4 của `req-20260925T015709Z` | hieu.nt10 (Beads Worker soạn) |
| 2026-09-25 | Sau review `b2`: §3.4 nói rõ `summariseSegments` lấy `agentErrors`/`fallbacks` của dòng mở từ **cả trace**, không từ đoạn (một Worker chết ở lượt sau bị đếm hai lần); sổ kết quả hành động khoá theo `workspaceId:beadId`; `kanbanColumns` bỏ con số `truncated` cho cả bảng (mỗi cột tự nói `hidden`) | hieu.nt10 (Beads Worker thực hiện) |
| 2026-09-25 | Errata khi làm UI-1: `SessionMap` bỏ `snapshot()`. `get(key)` trả đúng object đã lưu nên đã ổn định giữa các lần render, `useSyncExternalStore` đọc thẳng nó; thêm `snapshot()` chỉ để có thành viên không ai gọi | hieu.nt10 (Beads Worker thực hiện) |
| 2026-09-25 | Sau review `b1`: §3.1 nêu F9 của delta 20260918f và cách giữ nó (`beadActionResults`, tiêu chí A11); §3.4 định nghĩa ba trường `errors` không chồng nhau (agent `error` không có bản ghi failed; sự cố fallback chỉ tính `signal: completed`); §3.5 nói rõ đơn vị "request(s) with an error" | hieu.nt10 (Beads Worker soạn) |
