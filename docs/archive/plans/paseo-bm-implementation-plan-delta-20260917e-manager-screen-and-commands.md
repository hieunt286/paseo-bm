# Delta plan — Màn hình Beads Manager và hai slash command

| Trường | Giá trị |
|---|---|
| Mã | `plan-delta-20260917e-manager-screen-and-commands` |
| Plan gốc | [Implementation Plan v2](paseo-bm-implementation-plan-v2.md) (Active, Plan-ready PASS) — **không sửa tại chỗ**; delta này thêm WP-236 → WP-241 vào Phase 2a-5 |
| Status | **Completed** (2026-09-25) — mọi bead của plan đã đóng; từ nay tài liệu sống thay cho chuỗi delta (xem `AGENTS.md`, mục Process). Trạng thái trước: **Active** |
| Plan-ready | **PASS — 2026-09-17 — hieu.nt10** (Claude tự chấm; xem §6 để biết từng mục và những chỗ đã phải sửa trước khi đạt) |
| Owner | hieu.nt10 |
| Created | 2026-09-17 |
| Source design | [design-delta-20260917e-manager-screen-and-commands](../design/paseo-bm-delta-20260917e-manager-screen-and-commands.md) (Accepted) — nguồn duy nhất cho hành vi, hợp đồng và tám kết quả kiểm chứng nền tảng P1–P8 |
| Source PRD | [PRD](../../product/paseo-bm-prd.md) REQ-026f (lan truyền dừng); [PRD Dashboard](../../product/paseo-bm-dashboard-prd.md) REQ-041, REQ-057 |
| Routing decision | Brownfield, rủi ro **vừa**: không đụng lược đồ kho, không đụng đường tạo agent, không đụng ngân sách review. Điểm rủi ro thật nằm ở một cử chỉ UI chưa từng làm trong sản phẩm này và ở một luật trình bày vừa sửa hôm nay |
| Phase | Phase 2a-5 (nhãn bead `phase:2a-5`) |

## 1. MVP-Lock

- **Trong phạm vi:** toàn bộ §4 và §5 của delta thiết kế.
- **Ngoài phạm vi:**
  - sửa lỗi `settings.paseo-bm.read` (ghi nhận ở thiết kế §9, là bead riêng ngoài delta này);
  - đổi `requestId`, đổi cách Worker báo cáo, đổi ngân sách review (owner chốt Q23: chỉ Dashboard tách);
  - thêm đường tạo Worker thứ hai (owner chốt Q24: đi qua Manager);
  - `/bm-worker-stop-all` phạm vi toàn máy (owner chốt Q28: chỉ workspace hiện tại);
  - đổi ba mức, năm skill bắt buộc, hay bất cứ phần nào của vòng lặp ba vai ngoài một lối trả lời `BM-STOP` trong `worker.md`.
- **Điều kiện ra của delta:**
  1. `npm run verify` mã 0.
  2. Bốn mục của owner chạy được trên daemon thật, owner tự xác nhận bằng mắt.
  3. Toàn bộ test của delta 20260917d vẫn xanh (luật gộp theo Manager và khoá chống trùng không bị phá).
  4. `AGENTS.md` có P1–P3; hai tài liệu thiết kế có errata trỏ về delta này.

## 2. Thứ tự và vì sao

Một phụ thuộc thật và chỉ một: **WP-237 (kéo-thả) cần WP-236 (nơi lưu thứ tự)**, vì cử chỉ không có chỗ ghi thì không kiểm chứng được gì.

WP-237 mở đầu bằng một **spike** cho chính rủi ro 1 của thiết kế (cử chỉ tranh chấp với cuộn trang). Spike nằm **trong** WP-237 chứ không tách thành WP riêng: nó không có kết quả độc lập nào để bàn giao, và kết luận của nó chỉ đổi hình dạng của đúng WP đó.

WP-238, WP-239, WP-240 độc lập với nhau và với hai cái trên. WP-241 đóng delta, phụ thuộc cả năm.

```
WP-236 ──> WP-237 ─┐
WP-238 ────────────┤
WP-239 ────────────┼──> WP-241
WP-240 ────────────┘
```

## 3. Work packages

### WP-236 — Nơi lưu thứ tự ghim

**Kết quả:** hai RPC `launcher.order.get` / `launcher.order.set` đọc và ghi `<install home>/ui/launcher-order.json`, đi qua đúng bộ kiểm no-follow và mutex của kho vết.

**Phạm vi:** `plugin/server/` (module mới cho file thứ tự), hợp đồng ở `plugin/shared/contracts.ts`, đăng ký RPC ở `plugin/index.server.ts`. Không có UI.

**Nghiệm thu:**
- Ghi rồi đọc lại trả đúng danh sách; file chưa tồn tại → `{ pinned: [] }`, không phải lỗi.
- File hỏng hoặc JSON sai lược đồ → trả `{ pinned: [] }` kèm một notice, **không** ném lỗi và **không** ghi đè file của người dùng.
- `schemaVersion` mới hơn plugin hiểu → đọc thành rỗng và **từ chối ghi**, cùng cách kho vết đang làm.
- Đường dẫn có symlink ở bất kỳ thành phần nào → từ chối, có test.
- `npm run verify` mã 0.

**Không thuộc WP này:** dọn id workspace không còn tồn tại (đó là việc của lớp hiển thị, WP-237).

### WP-237 — Kéo-thả để ghim, trên màn hình Beads Manager

**Kết quả:** người dùng nhấn giữ một dòng, kéo, thả; dòng đó thành đã ghim và nằm đúng chỗ. Khối ghim ở trên theo thứ tự đã đặt, phần còn lại vẫn `activity_at desc`.

**Phụ thuộc:** WP-236.

**Bước đầu là spike (bắt buộc, làm trước khi viết UI thật):** dựng một danh sách kéo-thả tối giản trong surface, cài lên daemon thật, xác định cử chỉ có sống chung được với `ScrollView` không. Ghi kết quả vào bead. **Nếu không sống chung được**, lùi về nút lên/xuống trên mỗi dòng — vẫn đạt mục đích ưu tiên — và ghi lệch đó vào thiết kế §4.1. Không được im lặng đổi hướng.

**Phạm vi:** `plugin/client/launcher.tsx` và một component kéo-thả dùng lại được.

**Nghiệm thu:**
- Ghim hai workspace → đúng thứ tự đã đặt, ở trên; phần còn lại vẫn theo hoạt động.
- Bỏ ghim → dòng rơi về khối dưới, file được ghi lại.
- Id trong file mà không còn trong danh sách → bỏ qua khi hiển thị, dọn khỏi file ở **lần ghi kế tiếp** chứ không phải lúc đọc.
- Một lần `paseo.workspaces.list` lỗi **không** làm mất thứ tự đã ghim.
- `useNativeDriver: false` ở mọi hoạt ảnh (P3), và cuộn được khoá trong lúc kéo rồi mở lại.
- `npm run verify` mã 0.

### WP-238 — Dấu hiệu "đang làm việc"

**Kết quả:** `workspaces.overview` trả thêm `runningAgents { manager, worker, reviewer }`; màn hình hiện chấm nhấp nháy khi tổng > 0.

**Phạm vi:** `plugin/server/dashboard-rpc.ts` (nơi đang tính `runningWorkers`), `plugin/shared/contracts.ts`, `plugin/client/launcher.tsx`.

**Nghiệm thu:**
- `runningAgents` đếm đúng cả ba vai; `runningWorkers` **giữ nguyên giá trị cũ** cho mọi đầu vào (đây là trường cộng thêm, không thay).
- Ca "chỉ Reviewer đang chạy" làm chấm động — ca này đỏ nếu ai đó lùi về chỉ đếm Worker.
- Tổng bằng 0 → chấm đứng yên và mờ.
- Bật giảm chuyển động → chấm đặc, không hoạt ảnh.
- `npm run verify` mã 0.

### WP-239 — Dashboard tách một request thành các đoạn

**Kết quả:** danh sách Metric hiện một dòng cho mỗi **đoạn**; đoạn mở ra ở mỗi lượt Manager có tin nhắn đầu là lời người dùng thật (`origin === "user"`).

**Phạm vi:** `plugin/server/traces.ts`, hợp đồng `ReconstructedTrace`, `plugin/client/dashboard-*`.

**Nghiệm thu:**
- Một request, ba lượt Manager (người dùng / báo cáo Worker `origin: agent` / người dùng) → **hai** đoạn; báo cáo ở lượt giữa thuộc **đoạn 1**.
- Bản ghi **không có** `origin` → đúng **một** đoạn (không suy sự vắng mặt thành `user`, P7).
- Thông báo của plugin (`BM-BUDGET`, `BM-STOP`) **không** mở đoạn.
- Ngân sách review vẫn tính theo `requestId`, không theo đoạn — có test cho chính điều này.
- Biểu đồ "request mỗi ngày" vẫn đếm **request** (Q27), và nhãn nói rõ; dòng đoạn mang nhãn `· lượt N`.
- Toàn bộ test của delta 20260917d vẫn xanh.
- `npm run verify` mã 0.

### WP-240 — Hai slash command

**Kết quả:** gõ `/bm-worker-new <yêu cầu>` và `/bm-worker-stop-all` trong Paseo chạy đúng như §4.4.

**Phạm vi:** `plugin/index.client.tsx` (đăng ký lệnh), RPC mới `agents.stop-all` ở `plugin/server/`, `plugin/server/notices.ts` (tiền tố `BM-STOP`), `plugin/roles/worker.md` (một lối trả lời `BM-STOP` trong `## Stop`) và test nội dung vai trò.

**Nghiệm thu:**
- `/bm-worker-new "x"`: `manager.ensure` gọi **đúng một lần**, Manager nhận **đúng chữ `x`**, chat Manager được mở.
- `/bm-worker-new` với args rỗng: **không gửi gì**, chỉ mở chat.
- `agents.stop-all` chỉ gửi cho Worker và Reviewer `running` **của workspace đó**; bỏ qua agent đã lưu trữ hoặc đã đóng (P5); **không đụng Manager**; trả về số đã gửi và số đã bỏ qua.
- `isPluginNotice("BM-STOP …")` đúng, nên thông báo không bị ghi thành lời người dùng.
- `worker.md` có lối trả lời `BM-STOP`: ngừng việc, không gọi thêm công cụ, gửi một `BM-REPORT` cuối `phase: blocked`; xoá câu đó thì test đỏ.
- Chữ báo cho người dùng nói **"đã yêu cầu dừng"**, không nói "đã dừng" (P4 — đây là hợp tác, không cưỡng chế).
- `npm run verify` mã 0.

### WP-241 — Đóng delta

**Kết quả:** tài liệu khớp mã, và delta chuyển `Applied`.

**Phụ thuộc:** WP-236 → WP-240.

**Nghiệm thu:**
- `AGENTS.md` có P1 (slash command), P2 (`agents.ref().send` từ client), P3 (renderer Expo + `react-native-web`, có `PanResponder`/`Animated`).
- `docs/design/paseo-bm-dashboard.md`: errata cho `workspaces.overview` và luật tách đoạn ở §4.
- `docs/design/paseo-bm.md`: hai slash command và RPC `agents.stop-all`.
- Thiết kế delta ghi mọi chỗ lệch thực tế (đặc biệt kết luận của spike WP-237), Status → `Applied`.
- Một bead riêng được mở cho lỗi `settings.paseo-bm.read`, **không** đóng ké vào delta này.

## 4. Kiểm thử chung

Mỗi WP tự mang test của nó (§3). Ba luật xuyên suốt:

1. **Đối chứng âm là bắt buộc** cho mỗi luật mới: xoá luật đi thì phải có test đỏ. Đây là chỗ hai delta gần nhất bắt được test yếu.
2. **Không test nào của delta 20260917d được đỏ.** WP-239 đụng đúng vùng đó.
3. **Không có bài test nào cho cử chỉ chạy trong `jsdom`** thay cho bằng chứng thật: WP-237 phải có quan sát trên daemon thật ghi vào bead, vì `jsdom` không chứng minh được `PanResponder` sống chung với cuộn.

## 5. Rủi ro và cách chặn

| Rủi ro | Chặn bằng |
|---|---|
| Cử chỉ tranh chấp cuộn trang | Spike mở đầu WP-237, có đường lùi đã định sẵn (nút lên/xuống) |
| WP-239 phá lại lỗi 9 của WP-214 | Luật dựa trên `origin`, không dựa câu chữ; test đối chứng âm đúng ca báo cáo Worker |
| `BM-STOP` bị hiểu là cưỡng chế | Câu chữ trong `worker.md` và trong phản hồi lệnh nói "đã yêu cầu dừng" |
| Số dòng danh sách lệch số của biểu đồ | Q27 đã chốt; nhãn biểu đồ và nhãn `· lượt N` phải nói rõ |
| Xây trên `useSettings` đang hỏng | WP-236 dùng install home, không dùng settings |

## 6. Cổng `plan-ready-for-beads`

| Mục | Kết quả |
|---|---|
| Mỗi WP có kết quả quan sát được | PASS |
| Nghiệm thu cụ thể, kiểm được bằng lệnh hoặc quan sát | PASS |
| Phụ thuộc thô đã nêu, không vòng | PASS — một cạnh WP-236 → WP-237, một điểm hội tụ ở WP-241 |
| Không còn quyết định sản phẩm treo | PASS — Q23–Q28 đã chốt; câu hỏi mở duy nhất (`settings.paseo-bm.read`) đã đẩy ra ngoài phạm vi |
| Ngoài phạm vi viết rõ | PASS |
| Đủ căn cứ để viết bead tự chứa | PASS — P1–P8 ở thiết kế cho đường dẫn tệp, tên API và ràng buộc cụ thể |

**Đã phải sửa trước khi đạt:** lần chấm đầu FAIL hai mục. (a) Spike ban đầu là một WP riêng nhưng không có kết quả bàn giao độc lập — gộp vào WP-237 và ghi rõ đường lùi. (b) WP-241 ban đầu chỉ ghi "cập nhật tài liệu", không kiểm được — đổi thành danh sách từng tệp và từng sự thật phải có mặt.
