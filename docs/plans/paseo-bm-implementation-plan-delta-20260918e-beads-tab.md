# Delta plan — Tab "Beads" trong menu "+", Setup là màn chính của Beads Manager, màu cả dòng cho bead

| Trường | Giá trị |
|---|---|
| Mã | `plan-delta-20260918e-beads-tab` |
| Plan gốc | [Implementation Plan v2](paseo-bm-implementation-plan-v2.md) (Active, Plan-ready PASS). **Không sửa tại chỗ.** Delta này thêm WP-260 → WP-263 vào Phase 2a-9 |
| Status | **Active** |
| Plan-ready | **PASS — 2026-09-18 — hieu.nt10** (Beads Worker tự chấm sau review b1 pass ở lần re-review). WP-264 thêm ở batch `b4` theo quyết định owner Q12, tự chấm lại cùng ngày; review ở `b4` |
| Owner | hieu.nt10 |
| Created | 2026-09-18 |
| Request | `req-20260918T043115Z` |
| Source design | [design-delta-20260918e-beads-tab](../design/paseo-bm-delta-20260918e-beads-tab.md) — nguồn duy nhất cho id, nhãn, bảng màu, cấu trúc màn và kiểm thử |
| Source PRD | [prd-delta-20260918e-beads-tab](../product/paseo-bm-prd-delta-20260918e-beads-tab.md) — REQ-060 (a)–(i); quyết định Q1–Q3 |
| Routing decision | [PRD delta §0](../product/paseo-bm-prd-delta-20260918e-beads-tab.md#0-routing-decision) — brownfield, **Large**: nhiều thành phần độc lập, hành vi người dùng đang dựa vào |
| Phase | Phase 2a-9 MVP (nhãn bead `phase:2a-9`) |

## 1. MVP-Lock

- **Trong phạm vi:** REQ-060 (a)–(i); toàn bộ §4 của delta thiết kế.
- **Ngoài phạm vi:**
  - đích của mục Command Center "Open Beads Metric";
  - nút Metric / Beads trên dòng workspace;
  - màu các con số trên dòng workspace;
  - màn cài đặt "Beads Dashboard";
  - giữ tab con qua lần tải lại app; cử chỉ kéo-thả;
  - `chat-cards.ts`, `chat-card.tsx`, `contracts.ts`, RPC, mã server, `roles/*.md`;
  - nâng phiên bản gói, phát hành, commit.
- **Điều kiện ra của delta:**
  1. `npm run verify` mã 0.
  2. Owner tự kiểm trên daemon thật, trên máy tính và điện thoại:
     - mục "Beads" trong "+" và hai tab con;
     - Beads Manager mở ra là Setup; nút "Workspaces" và ←;
     - thông báo của `/bm-worker-stop-all` hiện ở màn chính, và dải trạng thái vẫn còn ở danh sách workspace;
     - màu dòng và chip ở theme owner đang dùng.
  3. PRD Dashboard có dòng REQ-060 trỏ về PRD delta (WP-263).

  Điều kiện 2 là việc của owner sau khi Worker báo `finished`; không bead nào chờ nó. Worker không cài hay reload plugin trên daemon của owner.
- **Hợp đồng đang được tiêu thụ:** không có. Delta chỉ đổi cách vẽ phía client và thêm một panel; không RPC, không định dạng tin, không dữ liệu lưu bền nào đổi.
- **Câu hỏi mở:** không còn. Các điểm Worker chọn thêm (thiết kế §9) owner đã xác nhận ở Q4–Q6 (PRD delta §1.2). Bước xác nhận bắt buộc trước khi implement của một request Large vẫn diễn ra sau khi bead xong.
- **Tư thế hoàn tác mặc định:**
  - mỗi WP hoàn tác bằng cách revert đúng các file trong phạm vi của nó;
  - không có dữ liệu lưu bền nào đổi và không có điểm không đảo ngược;
  - plugin chạy trên daemon chỉ đổi khi owner tự nạp lại.

## 2. Thứ tự và vì sao

Không có phụ thuộc thật giữa ba kết quả, vì không WP nào cần mã của WP khác (thiết kế §1). Chúng vẫn làm **lần lượt** theo thứ tự WP-260 → WP-261 → WP-262, để hai WP không cùng sửa một file một lúc. Đó là chuyện tránh xung đột, không phải phụ thuộc:

- WP-260 và WP-261 cùng sửa `beads-screen.tsx`: WP-260 sửa dòng danh sách, WP-261 sửa dòng đầu màn;
- WP-261 và WP-262 cùng sửa `dashboard-view.ts` và `test/plugin-dashboard-view.test.ts`.

WP-263 đóng delta và phụ thuộc cả ba.

```
WP-260 ──┐
WP-261 ──┼──> WP-263 ──> WP-264 (batch b4) ──> WP-265 (batch b5) ──> WP-266 (batch b6)
WP-262 ──┘
```

## 3. Work packages

**Ràng buộc chung cho WP-260 → WP-262.** Đây là quy ước test đang có, không phải thiết kế mới:

- `test/plugin-launcher.test.ts` nạp `index.client.tsx`, và qua đó nạp mọi file `.tsx` của `plugin/client/`, với `vi.mock("react-native")` chỉ có `ActivityIndicator`, `Pressable`, `ScrollView`, `Text`, `View`. Vì vậy một file `.tsx` mới hay đã sửa **không** được dùng giá trị của `react-native` ở cấp module (ví dụ `StyleSheet.create` ngoài component); chỉ dùng trong thân component.
- Root tsconfig không có `jsx`, nên test nạp file `.tsx` qua một specifier không literal, như `clientEntryPath` và `surfacePath` trong test đó.
- Không file nào dưới `test/` import `react-native` như một giá trị (`AGENTS.md`); `import type` thì được.

### WP-260 — Màu cả dòng, chip cùng màu, tên bead không đậm

**Kết quả:**

- mỗi dòng bead ở màn Beads và panel "Beads in this chat" có nền tô nhạt và vạch trái theo bảng màu thiết kế §4.3;
- chip trạng thái ở mọi chỗ dùng cùng bảng đó;
- tên bead ở hai danh sách và ở `BeadInline` không in đậm.

**Nguồn:** REQ-060 (g), (h), (i); thiết kế §2 F5–F6, §4.3, §6 (hai dòng đầu). **Phụ thuộc:** none.

**Phạm vi:**

- `plugin/client/beads-model.ts`:
  - kiểu `StatusBucket`, `STATUS_TONE`, `ROW_TINT_OPACITY`, `beadRowLook`;
  - `statusBadge` lấy tone từ `STATUS_TONE`.
- `plugin/client/ui.tsx`: `TintedCard`, `beadTitleStyle`.
- `plugin/client/beads-screen.tsx`: chỉ khối dòng của danh sách.
- `plugin/client/bead-chips.tsx`: `ChatBeadsPanel` (khung dòng + tên), `BeadInline` (tên).
- `test/plugin-beads-screen.test.ts`: ca bảng màu và ca bất biến chip = dòng.

Không sửa `chat-card.tsx` hay `chat-cards.ts`.

**Điều kiện ra:**

- hai ca mới xanh;
- đối chứng âm đỏ, rồi hoàn lại:
  - đổi `in_progress` về `info` → ca bảng màu đỏ;
  - cho `statusBadge` một tone riêng → ca bất biến đỏ;
- `npm run typecheck:plugin`, `npm run lint` và `npm test -- test/plugin-beads-screen.test.ts test/plugin-chat-beads.test.ts` mã 0.

### WP-261 — Tab "Beads" trong menu "+" với hai tab con Beads / Metric

**Kết quả:**

- plugin đăng ký panel workspace `bm-beads`, tiêu đề "Beads", đứng trước "Beads agents";
- panel có hai tab con, mặc định Beads, vẽ màn Beads và màn Metric hiện có của workspace đó;
- trong tab, hai màn không có nút ← và không có tiêu đề.

**Nguồn:** REQ-060 (a), (b), (c); thiết kế §2 F1–F4, §4.1, §6 (dòng "Tab con" và "Đăng ký"). **Phụ thuộc:** none. Làm sau WP-260 để tránh sửa trùng file.

**Phạm vi:**

- `plugin/client/dashboard-view.ts`: `BEADS_TAB_PANEL_ID`, `BEADS_TAB_VIEWS`, `DEFAULT_BEADS_TAB_VIEW`.
- File mới `plugin/client/beads-tab.tsx`: `BeadsTabPanel`.
- `plugin/client/beads-screen.tsx` và `plugin/client/dashboard.tsx`: `onBack`, `workspaceLabel` thành tuỳ chọn; dòng đầu màn vẽ theo thiết kế §4.1.
- `plugin/index.client.tsx`: một lời gọi `addWorkspacePanel`.
- `test/plugin-launcher.test.ts`: ca đăng ký; danh sách cleanup thêm `panel:bm-beads`.
- `test/plugin-dashboard-view.test.ts`: ca tab con.

**Điều kiện ra:**

- các ca mới xanh; bỏ dòng đăng ký thì ca đăng ký đỏ (đối chứng âm, rồi hoàn lại);
- các ca đăng ký đang có (Command Center, slash command, panel khác) vẫn xanh mà không sửa kỳ vọng nào của chúng;
- `npm run typecheck:plugin`, `npm run lint` và `npm test -- test/plugin-launcher.test.ts test/plugin-dashboard-view.test.ts` mã 0.

### WP-262 — Setup là màn chính của Beads Manager; danh sách workspace thành màn phụ

**Kết quả:**

- surface "Beads Manager" mở ra ở Setup, tiêu đề "Beads Manager", có nút "Workspaces", không có nút ←, và dòng phiên bản ở cuối;
- danh sách workspace mở bằng nút đó, giữ nguyên mọi dòng, và có ← về màn chính;
- Metric / Beads mở từ danh sách có ← về danh sách;
- dải trạng thái (thông báo slash command, cảnh báo host cũ, trạng thái mở Manager) hiện ở cả hai màn.

**Nguồn:** REQ-060 (d), (e), (f); thiết kế §2 F7, §4.2, §6 (dòng "Đường quay lại", "Nội dung dải trạng thái", "Chỗ đặt dải trạng thái" và "Thông báo slash command"). **Phụ thuộc:** none. Làm sau WP-261 để tránh sửa trùng file.

**Phạm vi:**

- `plugin/client/dashboard-view.ts`: `DashboardViewName` mới, `SURFACE_HOME_VIEW`, `backOf`.
- `plugin/client/launch-manager.ts`: `OLD_HOST_WARNING`, `StatusLine`, `launcherStatusLines` (hàm thuần, thiết kế §4.2).
- `plugin/client/launcher.tsx`:
  - view mặc định;
  - component `LauncherStatus`, dựng đúng một lần thành biến `status`, đặt ở `<SetupScreen status={status}>` và `{status}` trong nhánh danh sách;
  - dòng đầu của danh sách: ← thay cho ⚙;
  - ← của Metric / Beads.
- `plugin/client/setup-screen.tsx`: props `onOpenWorkspaces`, `status`; bỏ `onBack`; dòng đầu, câu giới thiệu, dòng phiên bản.
- `test/plugin-dashboard-view.test.ts`: ca `SURFACE_HOME_VIEW` và `backOf`.
- `test/plugin-launcher.test.ts`: ca `launcherStatusLines` và ca chỗ đặt (đọc mã nguồn `launcher.tsx`).

**Điều kiện ra:**

- ca mới xanh cho đủ bốn view;
- ca `launcherStatusLines` xanh cho cả ba loại dòng và cho thứ tự của chúng;
- ca chỗ đặt xanh; bỏ `{status}` khỏi nhánh danh sách thì ca đó đỏ (đối chứng âm, rồi hoàn lại);
- `test/plugin-slash-commands.test.ts` xanh mà không sửa kỳ vọng;
- `npm run typecheck:plugin`, `npm run lint` và `npm test -- test/plugin-dashboard-view.test.ts test/plugin-slash-commands.test.ts test/plugin-launcher.test.ts` mã 0.

### WP-263 — Áp delta vào tài liệu gốc và kiểm cả gói

**Kết quả:**

- `docs/product/paseo-bm-dashboard-prd.md`:
  - có dòng REQ-060 ở §6 (sau REQ-058), tóm tắt (a)–(i) và trỏ về PRD delta;
  - có một mục Revision History.
- `docs/design/paseo-bm-dashboard.md` có một mục Revision History trỏ tới design delta.
- Ba tài liệu delta mang trạng thái cuối:
  - PRD delta `Accepted, Applied`;
  - design delta `Active`;
  - plan delta giữ `Active`, kèm dòng revision ghi các bead đã đóng.
- `npm run verify` mã 0.

**Nguồn:** PRD delta §9 (điều kiện ra); quy tắc "delta, không sửa tại chỗ" của `AGENTS.md`.

**Phụ thuộc:** WP-260, WP-261, WP-262. Tài liệu gốc chỉ ghi REQ-060 khi phần mã đã xong.

**Phạm vi:** chỉ các chỗ nêu trên. Không sửa nội dung REQ khác, không sửa `AGENTS.md`, không sửa tài liệu của delta 20260918d.

**Điều kiện ra:**

- `npm run verify` mã 0, đọc ở dòng tổng kết;
- `br lint -s all` không có cảnh báo cho bead của request này;
- `br dep cycles` báo không có vòng.

### WP-264 — Batch `b4`: màu ở tên, bốn nhóm, ẩn/hiện bead đã đóng, thống kê nhanh, bỏ biểu đồ 14 ngày

Owner yêu cầu sau khi WP-260 → WP-263 đã xong. Quyết định Q8–Q12 ở PRD delta §1.4.

**Kết quả:**

- trong danh sách màn Beads và panel "Beads in this chat", chỉ tên bead mang màu trạng thái; dòng không tô, không có vạch trái; chip vẫn cùng màu;
- danh sách màn Beads chia bốn nhóm In progress → Blocked → Ready → Closed, mỗi nhóm có dòng tách kèm số lượng;
- nút mắt ẩn/hiện bead đã đóng: mặc định ẩn, nhớ trong phiên app;
- dòng đầu màn Beads có `✓ <đã đóng> / <tổng> done`, không đếm epic;
- không còn thẻ "Created / closed, last 14 days";
- dòng REQ-060 của PRD Dashboard được áp lại;
- `npm run verify` mã 0.

**Nguồn:** REQ-060 (g), (h), (j)–(m); thiết kế §4.4 và §6 (các dòng đánh dấu `b4`).

**Phụ thuộc:** WP-263. Batch này sửa mã và tài liệu mà WP-260 → WP-263 đã tạo, nên chỉ bắt đầu khi chúng đã đóng; hiện đã đóng.

**Phạm vi:**

- `plugin/client/beads-model.ts`: `beadTitleTone`, `STATUS_GROUP_ORDER`, `BeadGroup`, `groupBeads`, `doneText`, `closedBeadsVisibility`; bỏ `beadRowLook`, `ROW_TINT_OPACITY`.
- `plugin/client/ui.tsx`: `beadTitleStyle(styles, theme, tone | null)`; bỏ `TintedCard`.
- `plugin/client/beads-screen.tsx`: dòng đầu màn (số liệu), bỏ thẻ 14 ngày, dòng đầu danh sách (nút mắt), các nhóm, câu khi mọi bead khớp đều đã đóng và đang ẩn.
- `plugin/client/bead-chips.tsx`: dòng không tô, tên có màu; `BeadInline` tên không màu.
- `test/plugin-beads-screen.test.ts`: sửa hai ca màu của `b3` sang `beadTitleTone`; thêm ca nhóm, thống kê, ẩn/hiện.
- `docs/product/paseo-bm-dashboard-prd.md`: sửa dòng REQ-060 theo (g), (h), (j)–(m), thêm một dòng revision.
- `docs/design/paseo-bm-dashboard.md`: một dòng revision.

Không sửa `chat-card.tsx`, `chat-cards.ts`, nội dung `beadsOverview`, hay bất cứ file nào của panel "+" và surface.

**Ranh giới hoàn tác.** Ba kết quả hoàn tác độc lập được, nên converter tách chúng thành các leaf riêng, rồi thêm một leaf áp tài liệu và kiểm cả gói:

- màu ở tên (cả hai danh sách);
- nhóm + nút ẩn/hiện (nút ẩn chính nhóm Closed);
- thống kê nhanh + bỏ thẻ 14 ngày (cùng vùng tổng quan).

Hai leaf đầu cùng sửa `beads-screen.tsx` và `beads-model.ts` nên làm lần lượt.

**Điều kiện ra:**

- mọi ca đánh dấu `b4` ở thiết kế §6 xanh;
- ba đối chứng âm `b4` đỏ, rồi hoàn lại;
- `npm run typecheck`, `npm run typecheck:plugin`, `npm run lint` mã 0;
- `npm run verify` mã 0;
- `br lint -s all` không cảnh báo cho bead của batch; `br dep cycles` không có vòng.

### WP-265 — Batch `b5`: bỏ phần tính 14 ngày, màu các con số trên dòng workspace

Owner đồng ý hai gợi ý của Worker sau batch `b4` (PRD delta §1.5).

**Kết quả:**

- `beadsOverview` không còn tính `activity`;
- trên dòng workspace, số đang làm màu vàng và số block màu đỏ, lấy từ `STATUS_TONE`;
- dòng REQ-060 của PRD Dashboard được áp lại;
- `npm run verify` mã 0.

**Nguồn:** REQ-060 (m), (n); thiết kế §4.5 và §6 (các dòng đánh dấu `b5`).

**Phụ thuộc:** WP-264, vì batch này sửa lại mã và tài liệu của nó; hiện đã đóng.

**Phạm vi:**

- `plugin/client/beads-model.ts` và `test/plugin-beads-screen.test.ts` (bỏ `activity`);
- `plugin/client/dashboard-view.ts` và `test/plugin-dashboard-view.test.ts` (màu số);
- dòng REQ-060 và một dòng revision ở `docs/product/paseo-bm-dashboard-prd.md`, một dòng revision ở `docs/design/paseo-bm-dashboard.md`.

**Ranh giới hoàn tác.** Hai thay đổi mã hoàn tác độc lập được, nên thành hai leaf; một leaf thứ ba áp tài liệu và kiểm cả gói.

**Điều kiện ra:**

- các ca `b5` ở thiết kế §6 xanh;
- đối chứng âm `b5` đỏ, rồi hoàn lại;
- `npm run typecheck`, `npm run typecheck:plugin`, `npm run lint` và `npm run verify` mã 0;
- `br lint -s all` không cảnh báo cho bead của batch.

Cài bản mới lên daemon **không** thuộc WP này: đó là việc ngoài workspace, cần owner đồng ý riêng (PRD delta §1.5 mục 3).

### WP-266 — Batch `b6`: nút "Beads" trên header của workspace (mobile)

Owner báo trên điện thoại không có "+" với mục Beads (PRD delta §1.6); owner chọn Q14 a.

**Kết quả:**

- mỗi workspace đang mở có nút "Beads" (chỉ biểu tượng) trên header, bấm mở tab `bm-beads` của workspace đó, trên cả mobile và desktop;
- nút theo danh sách workspace: workspace mới có nút, workspace mất đi thì nút mất;
- dòng REQ-060 của PRD Dashboard áp lại với (a) errata và (o);
- `npm run verify` mã 0.

**Nguồn:** REQ-060 (a) errata, (o); thiết kế §2 errata F2, F8, §4.6, §6 (các dòng `b6`).

**Phụ thuộc:** WP-265 (đã đóng); dùng panel `bm-beads` của WP-261.

**Phạm vi:**

- file mới `plugin/client/beads-header-button.ts` và `test/plugin-beads-header-button.test.ts`;
- một dòng trong `plugin/index.client.tsx`;
- dòng REQ-060 và các dòng revision ở PRD và design Dashboard.

Không sửa `waiting-pills*`, `chat-card*`, hay file nào khác của Worker khác.

**Ranh giới hoàn tác.** Một leaf cho nút (mã + test); một leaf áp tài liệu và kiểm cả gói.

**Điều kiện ra:**

- ca `b6` ở thiết kế §6 xanh, đối chứng âm đỏ rồi hoàn lại;
- các test đăng ký đang có (`plugin-launcher`, `agent-tree`) vẫn xanh mà không sửa kỳ vọng;
- `npm run typecheck`, `npm run typecheck:plugin`, `npm run lint` và `npm run verify` mã 0.

Cài bản mới lên daemon không thuộc WP này: cần owner đồng ý riêng.

## 4. Rủi ro

| Rủi ro | Giảm nhẹ |
|---|---|
| Một Worker khác (`req-20260918T041426Z`, delta 20260918d) đang sửa cùng repo | Không WP nào ở đây sửa file của delta đó (`chat-cards.ts`, `chat-card.tsx`, `roles/*.md`, tài liệu 20260918d). Chạy `git status` trước mỗi bead; file của bead bị sửa ở đoạn khác thì làm tiếp, cùng đoạn thì dừng và hỏi |
| Mobile gốc không hiện mục "Beads" | Thiết kế §8: owner kiểm trên điện thoại; không vá vòng |
| Test đăng ký hỏng vì thêm panel | Chỉ thêm `panel:bm-beads` vào danh sách cleanup; không bỏ kỳ vọng nào đang có |
| Đổi tone chip làm lệch màu ở chỗ khác | Chỉ `statusBadge` đổi, và ca bất biến giữ chip = dòng. Màu trên dòng workspace nằm ngoài phạm vi (PRD delta §7) |

## 5. Kiểm thử của phase

- **Unit:** bảng màu, bất biến chip = dòng, hằng số tab con, `backOf`, đăng ký panel. Tất cả bằng Vitest, theo quy ước của repo.
- **Component `.tsx`:** kiểm bằng `npm run typecheck:plugin` và lần chạy thật của owner. Repo không dựng component React trong test.
- **Toàn gói:** `npm run verify`.
- **Chạy thật:** owner, trên máy tính và điện thoại (§1 điều kiện ra 2).
- **Độ phủ:** không đặt ngưỡng phần trăm (repo không có). Mọi hàm thuần mới có ít nhất một ca đúng và một đối chứng âm đã thấy đỏ.

## 6. Revision History

| Ngày | Người | Thay đổi |
|---|---|---|
| 2026-09-19 | hieu.nt10 (soạn bởi Beads Worker) | WP-266 xong (bead `bm-wp-266-beads-header-hs0u.1`–`.2`); dòng REQ-060 của PRD Dashboard áp lại với (a) errata và (o). Status giữ Active |
| 2026-09-19 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b6`: thêm WP-266 sau WP-265. Status giữ Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | WP-265 xong (bead `bm-wp-265-beads-b5-wjd4.1`–`.3`); dòng REQ-060 của PRD Dashboard áp lại với (m), (n). Status giữ Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b5`: thêm WP-265 sau WP-264. Status giữ Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | WP-264 xong (bead `bm-wp-264-beads-list-bcr2.1`–`.4`); dòng REQ-060 của PRD Dashboard áp lại; `npm run verify` mã 0 (95 file, 2181 test). Review `b4` sau đó. Status giữ Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b4` (owner Q8–Q12): thêm WP-264 sau WP-263; Plan-ready tự chấm lại với WP-264. Status giữ Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | WP-260 → WP-263 xong (bead `bm-wp-260-beads-tab-1cyv.1`–`.4`). `.2` được mở lại một lần: `test/agent-tree.test.ts` cũng ghim danh sách panel đăng ký, nên kỳ vọng chính xác của nó thêm `bm-beads`. `npm run verify` mã 0 (95 file, 2171 test). Điều kiện ra 2 (owner kiểm trên daemon thật, máy tính và điện thoại) còn chờ owner. Status giữ Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | `plan-ready-for-beads` PASS sau review b1 (pass ở lần re-review). Status → Active; phạm vi Phase 2a-9 đóng băng |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Review b1 (hai phát hiện chặn): lệnh test đổi từ `npx vitest run …` sang `npm test -- …` theo luật "không chạy `npx`" của `AGENTS.md`; WP-262 thêm `launcherStatusLines` cùng ca chỗ đặt dải trạng thái kèm đối chứng âm, và mục kiểm của owner |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | `reviewing-plan`: thêm ràng buộc chung về mock `react-native` và cách test nạp `.tsx` (§3), vì leaf bead phải tự chứa điều đó |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Tạo plan delta: WP-260 → WP-263, Phase 2a-9 |
