# Delta-change — Thẻ tin nhắn giữa Manager, Worker, Reviewer trong màn chat

| Trường | Giá trị |
|---|---|
| Ngày | 2026-09-16 |
| Trạng thái | Active |
| Gốc | [Technical Design Dashboard](./paseo-bm-dashboard.md); [delta owner-feedback](./paseo-bm-delta-20260916-owner-feedback.md) §7 (icon theo vai trò) |
| Bead | `bm-1fv` |

> **Đã được thay một phần** (errata 2026-09-18, hieu.nt10, soạn bởi Beads Worker, theo [delta 20260918f](./paseo-bm-delta-20260918f-ui-review.md) §4.12): viền theo màu vai trò ở §4 mục 4 đã bỏ, chỉ biểu tượng còn màu vai trò; nút gửi câu trả lời riêng ở §8 đã thay bằng ô Reply với một nút Send. Cả hai theo [delta 20260918d-card-replies](./paseo-bm-delta-20260918d-card-replies.md) (REQ-059 c, i).

## 1. Owner yêu cầu gì

> "tôi cần nhận diện thẻ nhận và phản hồi của 3 agents: Worker, Review và Manager nhìn cho gọn gàng, nhận tin từ ai, phản hồi từ yêu cầu nào. nội dung khi ấn expand show dạng view markdown. Thẻ nhận diện có màu, Icon, Header tên của phiên Agent làm việc. Giúp tôi kiểm soát và trả lời nhanh chóng, chính xác với Worker hơn"

## 2. Paseo 0.8 cho phép gì (đã kiểm trong SDK và bundle của app)

- `addTimelineTransformer({ query: { itemType }, transform({ item, phase }) })`: app chạy hàm này cho **mỗi** mục của chat, ở **mọi** agent. Trả `undefined` thì giữ nguyên mục gốc; trả `{ items }` thì mục gốc được thay bằng các mục `plugin`. Transformer **không biết agent nào** sở hữu khung chat.
- `addTimelineRenderer({ kind, version, schema, Component })`: vẽ mục `plugin`. Component nhận `agentId` của khung chat, `timestamp`, `theme` và `layout`, nhưng **không** nhận `workspaceId` hay `navigation`.
- Chỉ thay đổi phần hiển thị: lịch sử ở daemon và nội dung model đọc giữ nguyên.

## 3. Tin nhắn thật trông ra sao (đo trên workspace `xspace-customer`)

| Khung chat | Tin đến từ agent (`user_message` không có `clientMessageId`) | Tin agent tự viết (`assistant_message`) |
|---|---|---|
| Manager | Khối `BM-REPORT` của Worker | Câu trả lời cho người dùng |
| Worker | Chỉ thị của Manager, văn bản tự do, luôn nêu `req-…` | Tiến độ, đôi khi có `BM-REPORT` |
| Reviewer | Yêu cầu review của Worker, nêu `requestId` và `batchId` | Khối `BM-REVIEW` |

Tin do người dùng gõ trong app có `clientMessageId`.

## 4. Quyết định

1. **Chỉ đổi đúng các tin của paseo-bm.** Transformer chỉ tạo thẻ cho:
   - `user_message` **không** có `clientMessageId` **và** chứa khối `BM-REPORT`, khối `BM-REVIEW` hoặc một request id (`req-YYYYMMDDTHHMMSSZ`);
   - `assistant_message` đã hoàn tất (`phase: complete`) **và** chứa khối `BM-REPORT` hoặc `BM-REVIEW`.

   Mọi mục khác giữ nguyên: tin người dùng tự gõ, câu trả lời thường, tool call, và toàn bộ chat của agent không liên quan. Lúc agent đang stream, tin cũng giữ nguyên để khỏi nhấp nháy.
2. **Dữ liệu thẻ** (`kind: "bm-message"`, `version: 1`, kiểm bằng Zod): loại (`report` / `review` / `message`), chiều (`received` / `sent`), `requestId`, `batchId`, `phase`, `tier`, `verdict`, số finding chặn, `blockers`, số bead tạo/cập nhật/đóng, và nguyên văn tin.
3. **Ai gửi, ai nhận** được suy ra ở renderer. RPC mới `chat.peers({ agentId })` (chỉ đọc) trả agent sở hữu khung chat và các agent paseo-bm cùng workspace kèm `role`, `title`, `status`, `parentId`, `requestId`, `batchId`. Quy tắc:
   - Worker gửi `BM-REPORT` → Worker mang label `bm.requestId` đó.
   - Reviewer gửi `BM-REVIEW` → Reviewer khớp `requestId` và `batchId`.
   - Tin agent đến chat của Worker → Manager (agent cha nếu là Manager).
   - Tin agent đến chat của Reviewer → Worker cha của nó.
   - Tin agent khác đến chat của Manager → Worker của request đó.
   - Tin agent tự viết → gửi từ chính agent đó; người nhận là Manager (với report) hoặc Worker cha (với review).
   - Không xác định được thì ghi vai trò kèm "unknown", không đoán id.
4. **Giao diện thẻ:**
   - viền và icon theo màu vai trò (`ROLE_MARK`);
   - header `<Vai trò> · <tên phiên agent> → <người nhận>`;
   - chip request id, chip phase/verdict (blocked = vàng, finished = xanh, changes-required = vàng);
   - một dòng tóm tắt;
   - bấm để mở toàn văn dạng Markdown. Khối `key: value` được chuyển thành danh sách in đậm tên trường.
5. **Trả lời nhanh và đúng người:**
   - nút **Reply to <vai trò>** mở ô nhập ngay trong thẻ, gửi thẳng cho agent kia bằng `paseo.agents.ref(id).send()`;
   - tin gửi đi tự kèm dòng đầu nêu request id (và batch) để agent biết đang trả lời việc nào;
   - với report `blocked` có hai câu gợi ý điền sẵn ("Continue", "Stop here"), không tự gửi;
   - nút **Open <vai trò>** mở phiên của agent đó nếu app hỗ trợ.

## 5. Rủi ro và giới hạn

- Transformer chạy cho mọi agent. Tin của agent khác chỉ bị đổi khi **cùng lúc** không có `clientMessageId` và chứa `BM-REPORT`/`BM-REVIEW`/`req-…`.
- Renderer không có `navigation`, nên nút "Open" chỉ hiện khi app cung cấp; nếu không, thẻ ghi id để người dùng tự mở.
- Tin trả lời gửi từ thẻ đi thẳng tới agent kia; Manager không tự biết việc này. Đây cũng là cách người dùng vẫn nhắn trực tiếp cho Worker.
- Rollback: gỡ hai dòng đăng ký trong `index.client.tsx`, chat trở về như cũ; không có dữ liệu nào bị ghi.

## 6. Kết quả cài đặt và kiểm tra

- Parser `BM-REPORT`/`BM-REVIEW` chuyển sang `plugin/shared/bm-report.ts` để client dùng chung; `plugin/server/bm-report.ts` chỉ còn re-export.
- **Hai điểm bổ sung phát hiện khi chạy trên dữ liệu thật:**
  - Worker do Manager bản cũ tạo **không có label `bm.requestId`**. `chat.peers` suy ra request của agent từ kho lưu vết bằng đúng quy tắc của Metric (`requestIdOfAgent`). Nhờ vậy cả ba Worker của `xspace-customer` đều được xác định.
  - Yêu cầu review của Worker có dán **mẫu** khối `BM-REVIEW` (`verdict: approved | changes-required`), và tin của Manager có thể trích một khối review. Nay khối nào có giá trị dạng mẫu (`a | b`) được coi là tin thường. Renderer chỉ vẽ thẻ "gửi đi" khi vai trò của chủ khung chat khớp (review → Reviewer, report → Worker); chat không thuộc paseo-bm hoặc khối chỉ là trích dẫn thì hiện nguyên văn dạng Markdown, không có khung thẻ.
- **Chạy code thẻ trên timeline thật** (300 mục gần nhất của mỗi agent):
  - Manager `a508fb27`: 46 thẻ report, tất cả đều ra đúng Worker gửi; 1 tin hiện nguyên văn (Manager trích khối review).
  - Worker `d91ccf32`: 3 thẻ chỉ thị từ "Beads Manager".
  - Reviewer `173a274e`: 1 thẻ yêu cầu review từ Worker "bug PAKD…", 1 thẻ verdict `pass` gửi về đúng Worker đó.
- Chưa kiểm được bằng mắt trong app; phần này để owner xem.

## 7. Mã bead trong chat, và tên lên trước trong danh sách bead

Ngày 2026-09-16, owner yêu cầu:

> "Tại màn hình danh sách task beads đang hiển thị mã, rồi đến tên dẫn đến khó đọc nhanh, hãy đưa tên lên trước. Khi trong màn hình chat Agent, worker hỏi việc liên quan đến beads thì có cách nào để thẻ hiển thị được đó là bead nào, nếu click vào mã beads ở đó thì xem được nội dung beads không?"

- **Danh sách bead:** mỗi dòng hiện tên (tối đa 2 dòng, in đậm) trước; dòng dưới là mã bead, loại, mức ưu tiên và trạng thái.
- **Chip bead trên thẻ chat:**
  - `shared/bead-ids.ts` tìm các chuỗi có dạng mã bead trong tin. Nó bỏ qua request id, đường dẫn, cờ lệnh và URL.
  - RPC mới `beads.lookup({ workspaceId, ids })` (chỉ đọc) giữ lại **chỉ những mã có thật** trong kho bead, nên từ có gạch nối như `feature-workflow` không bao giờ thành chip.
  - Chip ghi `tên · mã`, màu theo trạng thái. Bấm vào thì mở chi tiết bead ngay trong thẻ, dùng lại `BeadDetailPanel` của màn Beads (Markdown, người đang làm, và các nút Assign / Delete / Close).
  - `chat.peers` trả thêm `workspaceId` để thẻ biết tra ở kho bead nào.
- **Giới hạn:** câu hỏi thường của Worker là văn bản chat bình thường. Transformer không biết tin thuộc chat nào (§2), nên đổi các tin đó thành thẻ sẽ làm thay đổi cả chat của agent khác. Vì vậy thêm **panel agent "Beads in this chat"** (`addWorkspacePanel`, `context: "agent"`):
  - RPC mới `chat.beads({ workspaceId, agentId })` (chỉ đọc) đọc 2 trang × 200 mục mới nhất của timeline;
  - lấy mã bead từ tin nhắn và lệnh shell, chỉ giữ mã có thật, đếm số lần nhắc, sắp theo lần nhắc gần nhất, tối đa 30;
  - panel tự làm mới mỗi 15 giây, bấm vào một dòng để mở chi tiết bead.
- **Kiểm trên daemon thật** (Worker `d91ccf32`, xspace-customer): quét 400 mục trong 36 ms, tìm thấy 7 bead; đứng đầu là `cus-contact-uiux-redesign-u9zv.12` (đang làm, nhắc 5 lần). `beads.lookup` loại đúng `feature-workflow` và `nope-1`.

## 8. Câu hỏi có lựa chọn trên thẻ báo cáo (delta 20260918c)

Ngày 2026-09-18, [delta 20260918c-question-cards](./paseo-bm-delta-20260918c-question-cards.md) đổi thẻ báo cáo trong chat **Manager** khi Worker hỏi:

- Worker đặt câu hỏi trong khối `BM-QUESTIONS` ngay sau `BM-REPORT`. Thẻ đọc khối đó và hiện từng câu với các nút lựa chọn, dấu đề xuất, "Other…", "Use recommendations" và "Clear".
- Nút gửi đi **thẳng tới Worker duy nhất của request** (như "Reply to Worker" ở §4.5), sau khi đọc lại `chat.peers`. Tin gửi đi là khối `BM-ANSWERS`. Thẻ không gửi khi Worker đang chạy, đang khởi tạo hay đã đóng.
- Với báo cáo có câu hỏi, dòng tóm tắt là `<n> questions waiting`, và hai câu gợi ý của §4.5 bị ẩn.
- Báo cáo không có khối (Worker tạo trước bản cập nhật), chat Worker và chat Reviewer vẫn như mục 4.
