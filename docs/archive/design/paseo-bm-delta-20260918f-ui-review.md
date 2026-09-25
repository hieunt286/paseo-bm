# Delta-change — Rà soát và đơn giản hoá phần UI/UX ngày 2026-09-18

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260918f-ui-review` |
| Tài liệu gốc | [Technical Design Dashboard](../../design/paseo-bm-dashboard.md) (surface Beads Manager, màn Metric, màn Beads); [delta 20260917e](./paseo-bm-delta-20260917e-manager-screen-and-commands.md) §4.1–§4.4 (danh sách workspace, ghim, chấm đang chạy, slash command); [delta 20260918c](./paseo-bm-delta-20260918c-question-cards.md) và [delta 20260918d](./paseo-bm-delta-20260918d-card-replies.md) (thẻ chat, pill câu đang chờ); [delta 20260918e](./paseo-bm-delta-20260918e-beads-tab.md) (tab Beads, Setup là màn chính, màn Beads) |
| PRD | [prd-delta-20260918f-remove-pinning](../product/paseo-bm-prd-delta-20260918f-remove-pinning.md) (Status Accepted — owner duyệt Q14 a, đã áp vào REQ-060 e) — chỉ cho việc gỡ tính năng ghim (Q11 c), sửa REQ-060 (e) của [PRD Dashboard](../../product/paseo-bm-dashboard-prd.md). Mọi bản sửa khác không thêm kết quả sản phẩm: mỗi bản đưa hành vi về đúng một REQ hay một câu thiết kế đã duyệt (§3, cột "Đúng theo") |
| Plan | [plan-delta-20260918f-ui-review](../plans/paseo-bm-implementation-plan-delta-20260918f-ui-review.md) |
| Status | Merged — gộp vào [paseo-bm-dashboard.md](../../design/paseo-bm-dashboard.md) ngày 2026-09-25; chỉ còn là hồ sơ lịch sử |
| Owner | hieu.nt10 |
| ADR | N/A — không thêm công nghệ hay phụ thuộc, không đảo quyết định nào. ADR-005 (agent thuộc về người dùng) giữ nguyên: không bản sửa nào gửi tin tới agent đã lưu trữ |
| Request | `req-20260918T063746Z` |

**Thiết kế này sở hữu:**

- các lỗi và phần code thừa được liệt kê ở §3, trong phạm vi owner chốt ở Q2;
- cách sửa từng lỗi (§4), cách chứng minh (§6), cách hoàn tác (§7);
- phần `GUIDE.md` tả các màn đã đổi hôm nay, và các dòng errata trong delta cũ đã lệch với code.

**Không sở hữu:**

- `plugin/roles/*.md` và các file `*-instructions.ts` sinh ra từ chúng (Q2 a);
- code server cũ: `bm-report.ts` trùng giữa `server/` và `shared/`, khoá theo workspace của `manager.ensure`, chặn chạy trùng khi cài tool (Q2 a — ghi ở §8 thành gợi ý);
- batch `b6` của delta 20260918d (trạng thái "đã trả lời" đồng bộ, "Mark as answered"). Request `req-20260918T041426Z` đang làm nó (Q5 a).

## 0. Routing Decision

- Variant preset: **brownfield** cho các bản sửa lỗi (người dùng thấy được), **refactor** cho phần dọn code (không đổi hành vi)
- Triggered risks:
  - nhiều thành phần độc lập: surface Beads Manager, màn Beads/Metric, thẻ chat và pill, hai RPC chat;
  - hợp đồng đang được tiêu thụ đổi:
    - `chat.peers` thêm trường `archived` (§4.9);
    - `launcher.order.get` / `launcher.order.set` bị bỏ (§4.5).

    Người tiêu thụ duy nhất của cả hai là client của chính plugin, và hai phía ship chung một bundle;
  - gỡ một tính năng người dùng đang dùng: ghim workspace (owner chốt Q11 c), nên REQ-060 (e) của PRD Dashboard phải sửa;
  - bàn giao nhiều phiên: phần code chỉ bắt đầu sau khi ba request khác xong và đã commit (Q1 a).
- Required artifacts/gates:
  - PRD: [prd-delta-20260918f-remove-pinning](../product/paseo-bm-prd-delta-20260918f-remove-pinning.md) sửa REQ-060 (e) (bỏ ghim, xếp theo hoạt động gần nhất) + cổng `prd-ready`. Delta ở **Review** cho tới khi owner duyệt ở bước xác nhận trước khi implement. PRD Dashboard không bị sửa tại chỗ trước lúc đó. Sau khi duyệt, plan WP-276 .2 áp delta vào REQ-060 (e), kèm một dòng Revision History;
  - design delta này + `design-ready`;
  - plan delta + `plan-ready-for-beads`;
  - `feature-done` theo profile standard.
- Execution path: plan → converter
- Exceptions: none
- Decided: 2026-09-18 — hieu.nt10 (Q1–Q13 của `req-20260918T063746Z`), Beads Worker soạn
- Supersedes: none

## 1. Owner chốt gì (2026-09-18)

Owner trả lời bằng khối `BM-ANSWERS`: Q1 a, Q2 a, Q3 a, Q4 a, Q5 a.

| Mã | Câu hỏi | Owner chốt |
|---|---|---|
| Q1 | Ba Worker khác đang chạy trong workspace và sửa cùng file | Viết tài liệu và bead ngay. **Không sửa code** cho tới khi các Worker đó báo `finished` và việc của họ đã được commit |
| Q2 | Phạm vi | UI của commit `db7134e` (màn Manager, slash command, ghim/kéo, chấm đang chạy, thẻ câu hỏi, màn metric), phần chưa commit (card replies, pill, tab Beads, Setup là màn chính), và các RPC nuôi chúng. Không gồm role prompt và code server cũ |
| Q3 | Cách gỡ bỏ | Chỉ gỡ code chết và gộp chỗ trùng khi hành vi giữ nguyên. Giữ cả nút ghim lẫn kéo-thả (L1 của delta 20260917e). Tính năng còn ghi là đang dùng thì hỏi trước khi gỡ. Sửa các mục `GUIDE.md` đã cũ |
| Q4 | Lỗi làm đổi thứ người dùng thấy | Sửa hết, mỗi lỗi một bead có test đỏ trước khi sửa. Danh sách ở §3 để owner xác nhận trước khi implement |
| Q5 | Lỗi thẻ chat mà `b6` của card replies đang sửa | Để request đó xử lý. Khi nó xong, chỉ review code cuối và sửa phần nằm ngoài thiết kế của nó |

Vòng hai, sau `reviewing-plan`: Q6 a, Q7 a, Q10 a. Q8 và Q9 được trả lời bằng `other — Xóa đi thôi` ("cứ xoá đi"). Câu trả lời đó chưa chỉ rõ xoá cái gì, và có thể mâu thuẫn với Q3 a (giữ cả nút ghim lẫn kéo-thả), nên được hỏi lại thành Q11, Q12 (§9).

| Mã | Câu hỏi | Owner chốt |
|---|---|---|
| Q6 | Nhãn ← của Metric/Beads trong surface | "Back to workspaces" |
| Q7 | Worker đã lưu trữ cùng `requestId` | Thêm `archived` vào `chat.peers`; người nhận là Worker sống duy nhất; không bao giờ gửi tới agent đã lưu trữ |
| Q10 | Ai commit việc của ba request kia | Owner tự commit sau khi chúng báo `finished` |

Vòng ba: Q11 c, Q12 a.

| Mã | Câu hỏi | Owner chốt |
|---|---|---|
| Q11 | Q8 "Xóa đi thôi, không còn cần thiết": xoá gì? | **Bỏ hẳn tính năng ghim**: ★ ▲▼, kéo-thả, RPC `launcher.order.*`. Danh sách chỉ xếp theo hoạt động gần nhất. F6–F8 biến mất. Sửa REQ-060 (e). File `launcher-order.json` cũ để nguyên, không đọc nữa. Quyết định này thay vế "giữ cả nút ghim lẫn kéo-thả" của Q3 a |
| Q12 | Q9 "Xóa đi thôi": xoá những test nào? | Các ca regex ghim câu chữ code ghim/kéo trong `test/plugin-pinned-order.test.ts`. Với Q11 c, chúng đi cùng tính năng (§4.5) |
| Q13 | Mode của Reviewer. Paseo từ chối Reviewer không có mode, và chỉ dẫn của Worker chưa có dòng "Reviewer mode" | Truyền `auto` cho mọi Reviewer của request này. Chỉ là cách chạy review, không đổi thiết kế |

Xác nhận trước khi implement (sau review b2): Q14 a, Q15 a, Q16 a.

| Mã | Câu hỏi | Owner chốt |
|---|---|---|
| Q14 | Duyệt `prd-delta-20260918f-remove-pinning` | **Duyệt** (2026-09-18). Bead gỡ ghim và bead áp PRD được chạy |
| Q15 | Request `req-20260918T071130Z` (bắt đầu 07:15, cũng chạm thẻ chat) | Mốc nền chờ nó xong và được commit, như ba request kia |
| Q16 | Xác nhận implement | Làm cả 26 leaf như đã review, bắt đầu khi bead nền thấy nền sạch, rồi review implementation (b3) |

Sau đó owner đổi Q10 sang **(b)**: Worker tự commit việc của các request kia, message ghi `requestId`, không push. Việc của sáu request đan xen trong 27 file, nên Worker hỏi lại (Q17). Owner chọn **a**: một commit cho cả sáu request — `4531de8` trên `main`, không push. Tài liệu và bead của request này không nằm trong commit đó.

## 2. Rà soát đã làm

**Đối tượng.** Commit `db7134e` (2026-09-18) cộng working tree lúc 13:40 cùng ngày. Bốn lượt đọc song song, rồi Worker tự kiểm lại từng phát hiện được giữ:

1. thẻ chat, pill, `chat.waiting`, `chat.peers`;
2. tab Beads, màn Beads, màn Metric;
3. surface Beads Manager, màn Setup, ghim, kéo-thả, slash command;
4. quét toàn plugin tìm export không ai dùng, file không tới được, RPC thiếu một đầu.

**Mốc trước khi sửa** (13:41):

- `npm run typecheck` và `npm run typecheck:plugin` qua;
- `vitest run`: 2197 qua, 9 đỏ. Chín ca đỏ đều ở file của Worker khác đang chạy: `plugin-role-hook` (request reviewer mode) và `plugin-answer-marks` (batch `b6`).

**Các tính năng đã bỏ: code đã gỡ sạch.** Grep toàn bộ `plugin/` và `test/`, không còn dấu vết của:

- `activity`, `activityMax` và biểu đồ "Created / closed, last 14 days" (REQ-060 m);
- `TintedCard`, `ROW_TINT_OPACITY`, `beadRowLook` (REQ-060 g);
- `formComplete`, `answerTarget`, `sendAnswers` và nút "Send answers" (REQ-059 c);
- nút ⚙ của danh sách workspace (REQ-060 d);
- viền trái của thẻ chat, và chữ đậm của tên bead (REQ-059 i, REQ-060 i).

Chỗ còn nhắc tới chúng là **chữ**: `GUIDE.md`, vài comment và vài delta cũ (§4.12).

**Tính năng giữ có chủ ý:**

- pill và `chat.waiting` như batch `b5`: owner chốt Q18 b của `req-20260918T041426Z`;
- RPC `answers.marks` / `answers.mark`: chưa có client gọi, vì `b6` đang làm dở. Đó không phải code chết.

**Không tìm thấy:** file không tới được từ hai entry; RPC thiếu handler hay thiếu người gọi; đăng ký trùng id với Paseo.

**Tính năng owner quyết gỡ (Q11 c):** ghim workspace trên danh sách Workspaces, gồm nút ★ ▲▼ (WP-237), kéo-thả (`bm-wp-237-drag-bxrb`) và RPC `launcher.order.*` (WP-236).

## 3. Phát hiện và cách xử lý

"Sửa" = một bead có test đỏ trước khi sửa. "Dọn" = không đổi hành vi, bộ test hiện có phải xanh nguyên như cũ. "Gợi ý" = không làm, ghi ở `Suggestion (not done)`.

### 3.1 Lỗi sẽ sửa (Q4 a)

| Mã | Mức | Ở đâu | Lỗi | Đúng theo |
|---|---|---|---|---|
| F1 | cao | `dashboard-view.ts` `createNoticeQueue().take()`; `launcher.tsx` `onDismiss` | Bấm để ẩn thông báo của slash command không làm gì: `take()` xoá giá trị nhưng không báo cho ai. `useSyncExternalStore` không vẽ lại, và thông báo nằm đó cho tới khi có lần vẽ khác. Setup giờ là màn chính và ít khi vẽ lại, nên lỗi lộ rõ hơn | delta 20260917e §4.4: "bấm để ẩn" |
| F2 | trung bình | `launch-manager.ts` `runPendingRequest` | Một yêu cầu mở Manager (Command Center, `/bm-worker-new`) đến lúc đang có lần mở khác thì bị **rơi**: `take()` chạy trước, rồi `launch()` trả `"busy"` | delta 20260917f: `/bm-worker-new` luôn mở chat |
| F3 | trung bình | `launcher.tsx` nhánh `dashboard` và `beads` | Surface đang ở màn Metric hay Beads thì không có dải trạng thái. Thông báo của `/bm-worker-stop-all` và lỗi mở Manager không hiện ở đó | delta 20260918e §4.2, sơ đồ đường đi: "thông báo hiện ở đó" (view hiện tại) |
| F4 | thấp | `dashboard.tsx` nút ← | Nhãn trợ năng nói "Back to Beads Manager", nhưng từ ngày 18 `backOf` dẫn về danh sách Workspaces | REQ-060 (e) |
| F5 | trung bình | `launcher.tsx` query `workspaces.overview` | Đọc lại số liệu **mọi** workspace (mỗi lần đọc chạm bead store của từng workspace) mỗi 10 giây, kể cả khi đang ở Setup, Metric hay Beads, nơi không hiện số nào | REQ-060 (e): số liệu thuộc danh sách workspace |
| F6 | — | `launcher.tsx` `savePinned` và các nút ghim | Phép ghim chạy trên danh sách đã lưu nhưng dùng chỉ số của danh sách đang thấy; hai lần bấm nhanh mất một thay đổi; ghi lỗi thì không ai biết. **Không sửa: tính năng bị gỡ (Q11 c, §4.5)** | — |
| F7 | — | `launcher.tsx` `pinnedOrder` | `notices` của `launcher.order.*` không được hiện. **Không sửa: tính năng bị gỡ (Q11 c, §4.5)** | — |
| F8 | — | `launcher.tsx` `DragHandle` | `PanResponder` bị tạo lại ở mỗi lần vẽ. **Không sửa: tính năng bị gỡ (Q11 c, §4.5)** | — |
| F9 | thấp–TB | `beads-screen.tsx` danh sách theo nhóm | Mỗi nhóm có một `View` cha riêng. Bead đang mở mà đổi nhóm sau một lần tải lại thì bị dựng lại: khung chi tiết đóng lại và mất kết quả của thao tác vừa làm (cả nút "Open the Beads Manager") | REQ-060 (k): nhóm chỉ là cách xếp |
| F10 | cao | `chat-card.tsx` + `chat-cards.ts` `visibleBeads` | Chip bead cắt còn 2 **trước** khi tra bead thật. `beadIdCandidates` chỉ kiểm hình dạng, nên `BM-REPORT`, `BM-QUESTIONS`, `local-first` đứng đầu danh sách. Kết quả: thẻ hiện 0–1 chip thật, chip "…" ghi sai số ("Show all 7 beads"), và "…" vẫn hiện khi không bead nào có thật | REQ-059 (i): "hơn 2 bead liên quan thì hiện 2 chip" |
| F11 | trung bình | `chat-waiting.ts` | Mỗi 15 giây, với **mọi** Worker không mang nhãn `bm.requestId` ở **mọi** workspace, kể cả workspace không có Manager, handler đọc cả kho vết một cách đồng bộ | delta 20260918d §4.8: đọc timeline của Manager |
| F12 | trung bình | `chat-waiting.ts` và `chat-rpc.ts` + `chat-cards.ts` `partiesOf` | Hai luật "Worker duy nhất của request" khác nhau. `chat.waiting` bỏ agent đã lưu trữ, `chat.peers` thì không. Worker hỏng được Manager tạo lại cùng `requestId`, rồi người dùng lưu trữ bản hỏng: pill hiện, nhưng thẻ trong popover từ chối gửi ("Cannot tell which Worker asked this") | REQ-059 (d), (j) |
| F13 | thấp–TB | `waiting-pills.tsx` `contentFor` | Mỗi lần cập nhật pill tạo một component mới cho popover. Popover đang mở bị dựng lại, chữ đang gõ trong ô Reply mất | REQ-059 (j) |
| F14 | thấp | `waiting-pills-model.ts` khoá pill | Khoá không có `requestId` hay nội dung báo cáo. Khi `at` là `null`, báo cáo mới có cùng số câu hỏi không bao giờ tới popover | REQ-059 (j) |

### 3.2 Dọn, không đổi hành vi (Q3 a)

| Mã | Ở đâu | Dọn gì |
|---|---|---|
| S1 | `launch-manager.ts` `createLaunchRequests`, `dashboard-view.ts` `createDashboardRequests`, `createNoticeQueue` | Ba hàng đợi một-chỗ giống hệt → một `createSlot<T>()` (§4.1). Bỏ `DashboardRequests.peek`, chỉ test dùng |
| S2 | `launch-manager.ts` `toneColor`; `launcher.tsx` import `toneColor as dashboardTone` | Hai hàm tone → màu cho cùng ba tone, cùng màu. Giữ một: `toneColor` của `dashboard-model.ts`; `NoticeTone` thành tập con của `Tone` |
| S3 | `beads-screen.tsx` và `dashboard.tsx` | Hai dòng đầu màn và hai kiểu props giống hệt (`BeadsScreenProps`, `DashboardProps`) → một `WorkspaceScreenHeader` và một `WorkspaceScreenProps` (§4.3) |
| S4 | `beads-screen.tsx` `renderRow`, `bead-chips.tsx` `ChatBeadsPanel` | Hai khung dòng bead giống nhau (tên màu theo trạng thái, ▸/▾, id, chip trạng thái, `BeadDetailPanel`) → một `BeadRowCard` trong `ui.tsx`: view không hook, props `bead`, `open`, `onToggle`, `meta` (phần giữa), `detail` (vẽ khi mở). `BeadDetailPanel` ở lại `beads-screen.tsx` và đi vào qua `detail`, để `ui.tsx` không import `beads-screen.tsx` |
| S5 | `launcher.tsx` | Ba chỗ `setView(backOf(view) ?? SURFACE_HOME_VIEW)` → một hàm `goBack` |
| S6 | `launch-manager.ts` `EnsureManagerOutput` | Kiểu chép tay (và `modeNotice` là tuỳ chọn, trong khi hợp đồng bắt buộc) → `z.infer` của `managerEnsureRpc.output` |
| S7 | `dashboard-model.ts` `dashboardStyles().row` | Style không ai dùng |
| S8 | `chat-waiting.ts` `try/catch` quanh `readTimelinePages` | Không bao giờ bắt được gì: `readTimelinePages` tự bắt lỗi và trả số đã đọc |
| S9 | `beads-tab.tsx` | `workspaceId={workspaceId}` truyền lại sau `{...props}`; padding 12/24 chép tay thay vì `styles.content.padding` |
| S10 | comment và tên test | `beads-screen.tsx:2`, `:342`, `:348` và `test/plugin-beads-screen.test.ts:38`, `:275` còn nói "six" sections (giờ là năm) hay nhắc code đã bỏ; `launch-manager.ts:16-18` nói sidebar mở ra danh sách workspace; `dashboard-view.ts:122` nói "Open Beads Dashboard"; comment `launcher.tsx` "seen wherever the surface is" (đúng sau F3); tên ca `test/plugin-slash-commands.test.ts:215` nói "does not … prefix" trong khi ca kiểm có tiền tố `BM-NEW-REQUEST` |
| S11 | `test/plugin-beads-screen.test.ts` | Ca `closedBeadsVisibility` đổi giá trị cấp module; một assert đỏ trước lệnh trả lại sẽ làm rò `true` sang ca sau. Trả lại trong `afterEach` |
| S12 | `chat-card.tsx` câu "Cannot tell who to send this to." | Nhánh không bao giờ chạy. Kiểm lại trên code cuối sau `b6` (Q5 a) |

### 3.3 Gợi ý, không làm

- `STATUS_ORDER` (Ready trước) và `STATUS_GROUP_ORDER` (In progress trước) làm chip lọc trạng thái xếp khác thứ tự nhóm. Gộp lại là đổi thứ tự người dùng thấy, nên theo Q3 a phải hỏi.
- `beadsOverview` và `new Date()` chạy lại mỗi lần gõ phím ở ô tìm → `useMemo`.
- Dòng thông báo "… for this workspace" của lần mở Manager nằm trên Setup (không gắn workspace nào) và không ẩn được.
- Nháp chỉ dẫn thêm ở Setup mất khi bấm "Workspaces" (trước ngày 18 thì mất khi bấm ←).
- Chip lọc `facetText` tự viết lại chữ trạng thái thay vì dùng `STATUS_TEXT`.
- Ngoài phạm vi Q2: `bm-report.ts` trùng 433 dòng giữa `server/` và `shared/`; `manager.ensure` không khoá theo workspace; `installTool` không chặn chạy trùng; `beads-store` cache không giới hạn; khoá query `reassign-targets` thiếu `workspaceId`; `settings.tsx` đọc `saveError` cũ.
- Pill quay lại sau khi đã trả lời, trong lúc Worker rảnh chờ Reviewer: owner đã chốt giữ pill như `b5` (Q18 b của `req-20260918T041426Z`).
- Khoảng 160 export chỉ test dùng, và khoảng 100 export chỉ dùng trong chính file. Bỏ `export` thì không đổi gì cho người dùng, nên không làm.

## 4. Thiết kế

Luật chung:

- client chỉ dùng React Native primitive, màu từ theme, không import `server/`;
- logic mới là hàm thuần hoặc view **không hook**, để test được bằng bộ dựng cây phần tử có sẵn trong `test/agent-tree.test.ts`. Bộ dựng đó chuyển sang `test/helpers/element-tree.ts` để nhiều file dùng chung.

### 4.1 Một kiểu ô chờ; bỏ thông báo thì ẩn ngay (F1, S1)

File mới `plugin/client/slot.ts`, thuần:

```ts
/** A single-value hand-off between a command and a surface. `take()` tells readers the value is gone. */
export interface Slot<T> {
  put(value: T): void;
  take(): T | null;
  peek(): T | null;
  subscribe(listener: () => void): () => void;
}
export function createSlot<T>(): Slot<T>;
```

- `put` ghi giá trị rồi gọi mọi listener;
- `take` trả giá trị và xoá nó; **chỉ khi thật sự xoá một giá trị** thì gọi mọi listener. Listener gọi lại `take()` sẽ nhận `null` và không gọi ai nữa, nên không có vòng lặp;
- `launchRequests`, `dashboardRequests`, `launcherNotices` đều là `createSlot<string>()`. `request(id)` và `post(text)` đổi thành `put(...)` ở mọi chỗ gọi (`selectFromCommandCenter`, `selectDashboardFromCommandCenter`, `runWorkerStopAll`, test);
- các kiểu `LaunchRequests`, `DashboardRequests`, `NoticeQueue` bị bỏ, thay bằng `Slot<string>`.

### 4.2 Yêu cầu mở Manager chờ lần mở đang chạy, không rơi (F2)

- `runPendingRequest`: nếu `launcher.getState().status === "pending"` thì trả `null` **trước** `take()`, để yêu cầu nằm lại trong ô.
- `ManagerLauncherSurface`: effect chạy `run` khi `launchRequests` đổi **và** khi `managerLauncher` đổi. Lần mở đang chạy kết thúc → trạng thái đổi → yêu cầu đang chờ được chạy.
- Chỉ có một ô, nên nhiều yêu cầu đến trong lúc chờ thì yêu cầu mới nhất thắng. Hành vi đó đúng như `put` hôm nay.

### 4.3 Một đầu màn cho Beads và Metric: dải trạng thái và nút ← đúng (F3, F4, S3)

`plugin/client/ui.tsx`, view không hook:

```ts
export interface WorkspaceScreenProps extends PluginSurfaceProps {
  workspaceId: string;
  workspaceLabel?: string;   // bỏ trong tab "Beads"
  onBack?: () => void;       // bỏ trong tab "Beads"
  backLabel?: string;        // nhãn trợ năng của ←
  status?: ReactNode;        // dải trạng thái của surface; tab "Beads" không truyền
}
export function WorkspaceScreenHeader(props: {
  title: string | null; onBack?: () => void; backLabel?: string;
  right: ReactNode; status?: ReactNode; styles: Styles;
}): JSX.Element;
```

- `BeadsScreen` và `DashboardPanel` nhận `WorkspaceScreenProps` và vẽ `WorkspaceScreenHeader`: tiêu đề `Beads · <tên>` / `Metric · <tên>`, bên phải là phần riêng của từng màn (`✓ … done` + Refresh; Refresh). `status` nằm ngay dưới dòng đầu, như ở Setup.
- `dashboard-view.ts` thêm `backLabelOf(view)`: `workspaces` → `"Back to Beads Manager setup"` (nhãn hiện tại), `dashboard` và `beads` → `"Back to workspaces"`, `setup` → `null`. Mọi nút ← của surface lấy nhãn từ đó.
- `launcher.tsx` truyền `status={status}` và `backLabel` cho hai màn. Tab "Beads" (`beads-tab.tsx`) không truyền gì, nên không đổi.

### 4.4 Số liệu workspace chỉ đọc khi danh sách workspace đang hiện (F5)

- `dashboard-view.ts` thêm `overviewPolling(view): { enabled: boolean; refetchInterval: number | false }`. Kết quả là `{ true, OVERVIEW_POLL_MS }` khi `view === "workspaces"`, còn lại `{ false, false }`.
- Query `workspaces.overview` của `launcher.tsx` dùng đúng hai giá trị đó. Mở lại danh sách thì React Query vẽ số trong bộ nhớ đệm ngay và đọc lại.
- Các query một lần (`workspaces.list`, `traces.workspaces`) giữ nguyên: `workspaces.list` cần cho nhãn của "Open Beads Metric".

### 4.5 Gỡ tính năng ghim (Q11 c; F6–F8 biến mất)

**Gỡ:**

- `plugin/client/pinned-order.ts`: cả file (`orderRows`, `pinAt`, `movePinned`, `unpin`, `prunePinned`, `dropIndex`).
- `plugin/client/launcher.tsx`:
  - `DragHandle`, `PinControls`;
  - query `pinned-order`, `useRpc(launcherOrderGetRpc/SetRpc)`, `savePinned`;
  - `rowHeight`, `dragging`, `scrollEnabled={!dragging}`, `onLayout` đo dòng;
  - import `PanResponder` (nếu không còn ai dùng).
- `plugin/shared/contracts.ts`: `launcherOrderOutput`, `launcherOrderGetRpc`, `launcherOrderSetRpc`.
- `plugin/server/launcher-order.ts`: cả file, **trừ** hằng số `UI_DIR_NAME`. `answer-marks.ts` của batch `b6` đang import nó; hằng số chuyển sang `plugin/server/install-home.ts`, cùng tên, cùng giá trị `"ui"`, và `answer-marks.ts` import từ đó.
- `plugin/server/dashboard-rpc.ts`: hai handler `launcher.order.*`, cùng import của chúng.
- Test:
  - `test/plugin-pinned-order.test.ts` và `test/plugin-launcher-order.test.ts`: cả file. Chủ đề của chúng không còn;
  - `launcher.order.get`, `launcher.order.set` bỏ khỏi danh sách RPC chính xác trong `test/plugin-bundle-cjs.test.ts` và `test/rpc-list-describe.test.ts`.

**Còn lại:**

- danh sách Workspaces vẽ `workspaces.data` đúng thứ tự `workspaces.list` trả về, tức `sort: activity_at desc` như hôm nay cho phần không ghim;
- chấm đang chạy, số bead, Go to / Metric / Beads, lịch sử workspace đã đóng: không đổi.

**Không đụng:**

- file `<install home>/ui/launcher-order.json` trên máy owner. Không đọc, không ghi, không xoá;
- thư mục `ui/`, vì `answer-marks.json` của `b6` cũng nằm ở đó.

**Bằng chứng:**

- `grep -rn "launcher.order\|launcherOrder\|pinned-order\|PinControls\|DragHandle\|savePinned" plugin/ test/` không còn kết quả;
- danh sách RPC chính xác của hai test trên không còn hai tên đó;
- một assert nguồn mới trong `test/plugin-launcher.test.ts`: danh sách vẽ `workspaces.data` theo thứ tự nhận được, không qua hàm xếp nào;
- `npm run verify` mã 0.

### 4.6 (Bỏ) Kéo-thả

Gỡ cùng tính năng ghim (§4.5). F8 không còn.

### 4.7 Màn Beads: bead đang mở giữ nguyên khi đổi nhóm (F9)

- `beads-model.ts` thêm `beadListItems(grouped): Array<{ kind: "group"; key: string; label: string; total: number; tone: Tone } | { kind: "bead"; key: string; bead: BeadRow }>`. Mỗi nhóm cho một mục `group` (khoá `group:<bucket>`), rồi các bead của nó (khoá = id bead). Thứ tự, nhóm rỗng, giới hạn 200 giữ đúng như `groupBeads`.
- `beads-screen.tsx` vẽ các mục đó **ngang hàng dưới một cha**. Mục `group` là vạch ngăn + tên nhóm, như hôm nay. Bead đổi nhóm giữ nguyên khoá và cha, nên React không dựng lại `BeadDetailPanel`.

### 4.8 Thẻ chat: chip bead tra trước, cắt sau (F10)

- `BeadChips` nhận **mọi** ứng viên (`ids`, tối đa 100 như hôm nay) và thêm hai props `expanded: boolean` và `onExpand(): void`.
- Nó tra `beads.lookup` rồi áp `visibleBeads(foundIds, expanded)` lên **danh sách bead tìm thấy**. Chip "…" do `BeadChips` vẽ, với số là `hidden` của danh sách tìm thấy. Không có bead nào → không vẽ gì, kể cả "…".
- `chat-card.tsx` bỏ phần "…" của mình và truyền `beadIds` nguyên vẹn.
- Hàm thuần mới trong `chat-cards.ts`: `beadChipsView(found: readonly BeadRow[], expanded: boolean): { shown: BeadRow[]; hidden: number }`, dùng `visibleBeads` bên trong. Test đi qua hàm này.

### 4.9 Một luật "Worker của request" cho `chat.waiting` và thẻ (F11, F12, S8)

Server — `plugin/server/chat-rpc.ts` thêm:

```ts
/** The paseo-bm agents of one workspace with their request id; trace store read at most once, and only when a label is missing. */
export async function peersOfWorkspace(all, workspaceId, readRecordsOnce): Promise<Array<ChatPeer>>;
```

- `handleChatPeers` và `handleChatWaiting` cùng dùng hàm này.
- `handleChatWaiting` chỉ gọi nó cho workspace **có Manager đang sống**, nên workspace không có Manager không bao giờ làm đọc kho vết (F11).
- `ChatPeer` thêm `archived: boolean`. Đây là thay đổi hợp đồng duy nhất của delta; người tiêu thụ là client của chính plugin, ship cùng bundle.

Luật chung là hàm thuần `soleWorkerOf(peers, requestId)` trong file mới `plugin/shared/sole-worker.ts`, để cả server lẫn client import:

- Worker của request = agent `worker` **chưa lưu trữ** duy nhất mang `requestId` đó;
- không có, hoặc có nhiều hơn một → không có Worker.

Áp dụng:

- `waitingOf` dùng `soleWorkerOf`;
- `chat-cards.ts` dùng nó ở `replyTarget`, tức đường gửi. Gửi tới agent đã lưu trữ thì Paseo bỏ lưu trữ agent đó (P5, ADR-005), nên không bao giờ được chọn agent đã lưu trữ;
- `partiesOf` (chỉ dùng để **gọi tên** người gửi) dùng `soleWorkerOf`, nếu không có thì lấy Worker duy nhất kể cả đã lưu trữ. Thẻ cũ của một Worker đã lưu trữ vẫn có tên.

Dọn kèm: bỏ `try/catch` thừa quanh `readTimelinePages` (S8).

### 4.10 Pill: popover không bị dựng lại, khoá đổi khi nội dung đổi (F13, F14)

- `waiting-pills.tsx`: mỗi id pill có **một** component `Content`, tạo lúc thêm pill. Component đọc mục mới nhất từ một `Map<pillId, WaitingWorker>` ở module và đăng ký nghe thay đổi của map (một `createSlot`-style listener, hay `useSyncExternalStore` trên map). `update` chỉ đổi `title` và `label`, cùng một `Content`, nên popover đang mở giữ nguyên ô Reply.
- `waiting-pills-model.ts`: khoá pill = `[managerId, workspaceId, requestId, label, at ?? "", hash(text)]`. `hash` là hàm băm chuỗi thuần, ngắn (FNV-1a 32 bit, dạng hex), không phụ thuộc thư viện.

### 4.11 Dọn không đổi hành vi (S2, S4–S7, S9–S12)

Như bảng §3.2. Không có test nào bị sửa để cho xanh. Test chỉ đổi khi:

- tên hàm đổi (S1: `request`/`post` → `put`), hoặc kiểu đổi (S6);
- tên ca hoặc comment sai (S10);
- ca cần được cách ly (S11).

Test kiểm `toneColor` của `launch-manager.ts` chuyển sang `toneColor` của `dashboard-model.ts`, với **cùng** kỳ vọng màu cho `muted`, `warning`, `danger`.

### 4.12 `GUIDE.md` và errata tài liệu (Q3 a)

`GUIDE.md` (tiếng Anh, như file đang viết):

- **"The Beads Manager screen":**
  - surface mở ra ở Setup; nút **Workspaces** mở danh sách (← quay về);
  - bỏ "gear button";
  - thêm tab **Beads** trong menu "+" của workspace, với hai tab con Beads / Metric.
- **"Beads: the workspace's beads":**
  - phần tổng quan còn năm mục (bỏ "Created / closed, last 14 days");
  - danh sách chia bốn nhóm, có nút mắt ẩn/hiện bead đã đóng và `✓ closed / total done`;
  - tên bead mang màu trạng thái.
- **"Message cards in the chat":**
  - lựa chọn của thẻ câu hỏi viết khối `BM-ANSWERS` vào ô Reply, một nút Send;
  - 2 chip bead và "…";
  - chip "Answered";
  - pill câu đang chờ;
  - tên người gửi màu chữ thường, chỉ biểu tượng có màu;
  - phần của `b6` chỉ viết nếu `b6` đã ship lúc làm bead này.
- **Troubleshooting:** "Open Beads Manager → ⚙ Setup" đổi thành "Open Beads Manager (it opens on Setup)".

Errata, mỗi file một dòng Revision History, không thêm phạm vi:

- delta 20260916-chat-cards: dòng trỏ tới 20260918d cho viền theo vai trò và nút gửi riêng;
- delta 20260918e: tiêu đề và §1 ý 3 còn nói "màu cả dòng"; §8 và §9 còn nhắc `ROW_TINT_OPACITY` và "0.12 / 4 px"; §8 còn nói màu con số trên dòng workspace nằm ngoài phạm vi;
- prd-delta 20260918e: tiêu đề còn nói "màu cả dòng";
- delta 20260918d: chữ ký `waitingOf(manager, entries, workers)`; `planPills` nằm ở `waiting-pills-model.ts`;
- delta 20260917e: dòng trỏ "§4.1 (ghim, kéo-thả, `launcher.order.*`) bị gỡ bởi delta 20260918f, owner chốt Q11 c";
- PRD Dashboard: áp [prd-delta-20260918f-remove-pinning](../product/paseo-bm-prd-delta-20260918f-remove-pinning.md) vào REQ-060 (e), **chỉ khi** delta đó đã Accepted (owner duyệt), kèm một dòng Revision History.

Technical Design Dashboard thêm một dòng Revision History trỏ về delta này.

## 5. Không đổi

- Mọi RPC và hợp đồng, trừ trường `archived` thêm vào `chat.peers` (§4.9) và hai RPC `launcher.order.*` bị bỏ (§4.5).
- Kho vết, bead store, và file `launcher-order.json` đã có trên máy owner (không đọc, không ghi, không xoá).
- `plugin/roles/*.md`, `*-instructions.ts`, hook `agent.create`, thông báo `BM-*`.
- Tính năng: pill, tab Beads, Setup là màn chính, các slash command, thẻ chat, chấm đang chạy. Tính năng duy nhất bị gỡ là ghim workspace, theo Q11 c.
- Batch `b6` của delta 20260918d.

## 6. Chiến lược kiểm thử

Mỗi lỗi F: test viết trước và **đỏ** trên code cũ, rồi xanh sau khi sửa. Đối chứng âm ghi ở từng bead: hoàn tác phần sửa thì test đó đỏ lại.

| Mã | Test (vitest) | Đối chứng âm |
|---|---|---|
| F1, S1 | `test/plugin-dashboard-view.test.ts`: `take()` sau `put()` gọi listener đúng một lần; `take()` khi trống không gọi; listener gọi lại `take()` không lặp | bỏ lệnh gọi listener trong `take` → đỏ |
| F2 | `test/plugin-launcher.test.ts`: launcher `pending` → `runPendingRequest` trả `null` và yêu cầu còn trong ô; hết `pending` → lần gọi sau mở đúng workspace đó | `take()` trước khi kiểm `pending` → đỏ |
| F3, F4, S3 | test mới `test/plugin-workspace-screen.test.ts`, dựng `WorkspaceScreenHeader` bằng bộ dựng cây: có `status` thì nút ở ngay dưới dòng đầu; có `onBack` thì nhãn trợ năng = `backLabel`; không có `onBack` thì không có ←. `backLabelOf` cho bốn view. Một assert nguồn (như ca đặt chỗ hiện có): hai nhánh `dashboard`/`beads` của `launcher.tsx` truyền `status` | bỏ `status={status}` ở một nhánh → đỏ |
| F5 | `overviewPolling` cho bốn view; assert nguồn: query overview dùng nó | trả `{ true, OVERVIEW_POLL_MS }` cho mọi view → đỏ |
| Gỡ ghim (Q11 c) | `grep` ở §4.5 không còn kết quả; danh sách RPC chính xác trong `test/plugin-bundle-cjs.test.ts` và `test/rpc-list-describe.test.ts` không còn `launcher.order.*`; assert nguồn mới trong `test/plugin-launcher.test.ts`: danh sách vẽ `workspaces.data` theo thứ tự nhận được | thêm lại một mục `launcher.order.get` vào contracts → hai test danh sách RPC đỏ |
| F9 | `beadListItems`: khoá bead = id; một bead đổi nhóm giữ khoá; thứ tự và giới hạn như `groupBeads`; assert nguồn: danh sách vẽ `beadListItems(...)` trực tiếp, không bọc `View` theo nhóm | bọc lại theo nhóm → đỏ |
| F10 | `beadChipsView`: ứng viên `["BM-REPORT","bm-a","local-first","bm-b","bm-c"]`, tìm thấy `[bm-a,bm-b,bm-c]` → hiện `[bm-a,bm-b]`, `hidden` 1; tìm thấy rỗng → không gì | cắt ứng viên trước khi tra → đỏ |
| F11, F12 | `test/plugin-chat-waiting.test.ts`: workspace không có Manager → không đọc kho vết (đếm lần gọi); Worker hỏng đã lưu trữ + Worker mới cùng `requestId` → một pill, và `replyTarget` của thẻ chọn đúng Worker mới. `soleWorkerOf` cho: một, không, hai, một sống + một lưu trữ | `soleWorkerOf` tính cả agent đã lưu trữ → đỏ |
| F13 | `test/plugin-waiting-pills.test.ts`: cập nhật pill giữ **cùng** `Content`; `Content` đọc mục mới nhất | tạo `Content` mới mỗi lần → đỏ |
| F14 | `planPills`: cùng số câu, `at` null, nội dung khác → nằm trong `update` | bỏ băm nội dung khỏi khoá → đỏ |
| S* | bộ test hiện có xanh nguyên, trừ các đổi tên ở §4.11 | — |

**Test gỡ cùng tính năng (Q11 c, Q12 a).** `test/plugin-pinned-order.test.ts` và `test/plugin-launcher-order.test.ts` bị xoá cả file: chúng chỉ kiểm tính năng ghim và file `launcher-order.json`. Không ca nào kiểm tính năng khác nằm trong hai file đó (kiểm lại lúc làm bead: ca nào kiểm thứ khác thì chuyển sang file khác, không xoá). Hai tên RPC bỏ khỏi hai danh sách RPC chính xác là thay đổi có chủ ý theo Q11 c.

Toàn gói: `npm run verify` mã 0 và `br lint -s all` sạch với bead của request này. Phần nhìn thấy trên daemon thật (desktop và điện thoại, sáng và tối) là việc owner tự kiểm sau `finished`. Worker không cài hay nạp lại plugin trên daemon của owner.

## 7. Hoàn tác

Mỗi bead hoàn tác bằng cách revert đúng các file của nó. Không có dữ liệu lưu bền nào đổi, và không có điểm không đảo ngược. Gỡ ghim cũng vậy: file `launcher-order.json` trên máy owner không bị đụng, nên revert bead đó thì thứ tự ghim cũ quay lại nguyên vẹn. Trường `archived` của `chat.peers` là trường thêm vào; revert cả client lẫn server cùng một bead.

## 8. Rủi ro và giới hạn

| Rủi ro | Cách chặn |
|---|---|
| Ba Worker khác đang sửa cùng file | Không sửa code cho tới khi bead nền (plan WP-270) đóng: `git status` sạch trừ file của request này, và `npm run verify` xanh (Q1 a) |
| Code thẻ chat còn đổi sau `b6` | Các bead F10–F14 và S12 kiểm lại từng phát hiện trên code cuối. Phát hiện nào `b6` đã sửa thì đóng bằng bằng chứng "không còn áp dụng". Phát hiện **mới** trên code cuối thì hỏi owner, không tự thêm phạm vi |
| Không có renderer React Native | View không hook + bộ dựng cây phần tử; phần còn lại là assert nguồn như các ca đặt chỗ hiện có. Pixel và cử chỉ thật là việc owner tự kiểm |
| `answer-marks.ts` (batch `b6`) import `UI_DIR_NAME` từ `launcher-order.ts` | Hằng số chuyển sang `install-home.ts`, cùng giá trị `"ui"`; test của `answer-marks` xanh nguyên. Lúc làm bead, grep mọi import từ `launcher-order` trên code cuối sau `b6` |
| `archived` là thay đổi hợp đồng | Chỉ thêm trường; Paseo nạp client và server từ cùng một thư mục plugin; một ca mới cho `chatPeerSchema` trong `plugin-dashboard-contracts` (hôm nay chưa có ca nào cho `chat.peers`) |

## 9. Câu hỏi mở

Không còn. Q1–Q12 đã chốt (§1). Bước xác nhận bắt buộc trước khi implement của request Large vẫn diễn ra sau khi bead xong.

## 10. Revision History

| Ngày | Tác giả | Thay đổi |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Đã implement (bead `bm-wp-270-ui-review-v0o1.1`–`.26`). Lệch nhỏ so với §4: `peersOfWorkspace` và `workspaceRecordsReader` nằm ở file mới `plugin/server/chat-peers.ts` chứ không ở `chat-rpc.ts`, để `chat-rpc.ts` và `chat-waiting.ts` không import lẫn nhau; S8 **không** làm — `readTimelinePages` vẫn có thể ném `TypeError` khi `refetch` không trả gì, nên `try/catch` bên ngoài được giữ; ca "dashboard requests" thấy thêm một lần báo khi `take()` xoá giá trị, đúng luật §4.1. `npm run verify` mã 0 (102 file, 2343 test). Status → Applied |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Review b1 pass ở lần re-review; `design-ready` PASS. Status → Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Review b1 (một phát hiện chặn): sửa REQ-060 (e) đi qua PRD delta mới `prd-delta-20260918f-remove-pinning` (Review, `prd-ready` PASS), không áp thẳng vào PRD đã Accepted; §0 và §4.12 theo đó. Q13 a (Reviewer chạy ở mode `auto`) ghi ở §1 |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Owner chốt Q6 a, Q7 a, Q10 a, rồi Q11 c, Q12 a: gỡ hẳn tính năng ghim (§4.5 viết lại, §4.6 bỏ, F6–F8 không còn), REQ-060 (e) sửa ở WP-276 .2; §0, §5–§9 theo đó |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | `reviewing-plan`: chốt chỗ đặt `BeadRowCard` (`ui.tsx`, `detail` truyền vào) và `soleWorkerOf` (`plugin/shared/sole-worker.ts`); §6 ghi các ca assert nguồn phải đổi theo F6, F8 và ca thay thế; §8 thêm ca hợp đồng cho `chat.peers` |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Tạo bản Draft từ rà soát của `req-20260918T063746Z`, owner chốt Q1–Q5 |
