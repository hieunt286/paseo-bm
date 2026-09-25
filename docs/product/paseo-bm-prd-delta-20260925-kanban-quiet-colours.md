# PRD delta — Kanban cho beads, chữ đậm/nhạt thay màu, tab cho Setup, đếm lỗi ở Metric

| Trường | Giá trị |
|---|---|
| Mã | `prd-delta-20260925-kanban-quiet-colours` |
| PRD gốc | [Dashboard PRD](./paseo-bm-dashboard-prd.md) — REQ-060 (g)(h)(j)(k)(n). **Không sửa tại chỗ trước khi delta này được duyệt** |
| Status | **Accepted** — owner chốt Q1 a, Q2 a, Q3 a, Q4 a của request `req-20260925T015709Z` (2026-09-25) |
| Owner | hieu.nt10 |
| Created | 2026-09-25 |
| Thiết kế | [design-delta-20260925-kanban-quiet-colours](../design/paseo-bm-delta-20260925-kanban-quiet-colours.md) |
| Nguồn | Chủ repo, 2026-09-25: "trong màn hình theo dõi Beads / Metric … hãy thể hiện view theo dạng kanban chia theo trạng thái, lưu ý hỗ trợ responsive"; "chỉ cần đơn giản màu text đậm và nhạt thôi để phân biệt đóng và chưa làm, bỏ các màu cam, đỏ, xanh lá ở text đi vì nhìn nhiều màu rất mỏi mắt"; "việc chia cấu hình Skill, br/bv, cấu hình Agent chia thành các Tab cho thuận tiện"; "màn metric cần thống kê số lần request bị error (vì bất kể lý do gì) cho dễ tracking" |

## REQ-069 — Kanban theo trạng thái, chữ yên tĩnh, tab cho Setup, đếm lỗi ở Metric

- **(a) Bốn cột theo trạng thái.** Màn Beads (cả trong tab "Beads" của workspace) chia bead thành bốn cột: In progress → Blocked → Ready → Closed, mỗi cột có tên kèm số lượng. Cột rỗng vẫn hiện và nói rõ là rỗng, để bố cục không nhảy khi lọc.
- **(b) Responsive.** Bố cục rộng (web, cửa sổ lớn) hiện các cột cạnh nhau, vừa bao nhiêu cột thì hiện bấy nhiêu trên một hàng. Bố cục hẹp (điện thoại, cửa sổ web hẹp) hiện một cột mỗi lần, chọn bằng dãy tab trạng thái có số lượng; tab đọc được bằng trình đọc màn hình (vai trò tab, trạng thái chọn). Không chức năng nào mất ở bố cục hẹp: tìm kiếm, bộ lọc, cách sắp, chi tiết bead và ba hành động vẫn tới được.
- **(c) Bead đã đóng hiện sẵn.** Closed là một cột như các cột khác và hiện ngay khi mở màn; nút mắt vẫn ẩn/hiện nó kèm số lượng, và lựa chọn đó nhớ trong phiên app rồi về mặc định (hiện) sau khi tải lại.
- **(d) Trạng thái nói bằng chữ, không bằng màu.** Ở mọi chỗ hiện bead — màn Beads, tab "Beads", panel "Beads in this chat", chip bead trong thẻ chat, các con số trên dòng workspace của danh sách Workspaces (bead tổng, đang làm, block, và số Worker đang chạy) — trạng thái chỉ dùng chữ và độ tương phản: bead chưa xong màu chữ thường (`foreground`), bead đã đóng màu chữ mờ (`foregroundMuted`). Không cam, không đỏ, không xanh lá. Tên bead vẫn **không in đậm** (REQ-060 (i) giữ nguyên): "đậm/nhạt" làm bằng độ tương phản, không bằng nét chữ. Chữ của chip vẫn ghi đủ Ready / In progress / Blocked / Closed, nên trạng thái không bao giờ chỉ nằm ở màu.
- **(e) Ngoài các chỗ hiện bead, màu giữ nguyên.** Dòng lỗi (đỏ) và cảnh báo (vàng) ở màn Metric, màn Setup, thẻ chat và thẻ fallback không đổi: lỗi thật vẫn phải đập vào mắt.
- **(f) Setup chia ba tab.** Màn chính "Beads Manager" chia cấu hình thành ba tab — **Beads tools** (`br`, `bv`), **Agent skills**, **Agents** (Roles & models + Additional instructions) — mỗi lần hiện một phần, thay cho một trang cuộn dài. Dòng tình trạng chung và các cảnh báo về công cụ nằm **trên** dãy tab, nên không tab nào che được một vấn đề. Dãy tab đọc được bằng trình đọc màn hình.
- **(g) Thẻ "Errors" ở màn Metric.** Màn Metric có một thẻ tổng quan đếm **số lần request bị lỗi, bất kể lý do**: turn kết thúc `failed`, agent kết thúc ở trạng thái `error`, và mỗi sự cố fallback của nhà cung cấp (hết hạn mức, mất đăng nhập, provider không dùng được). Thẻ cho biết tổng số lần lỗi và số request bị ảnh hưởng; bằng 0 thì nói rõ chưa ghi nhận lỗi nào. Mỗi lần lỗi chỉ được đếm **một** lần: dù request có nhiều lượt hỏi, và dù một lần chết được nhiều nguồn ghi nhận (ví dụ hết hạn mức làm turn chết vừa là turn `failed` vừa sinh một sự cố fallback thì vẫn là một lỗi).

- **(h) Hành động trên bead khi bead đổi cột.** Sau khi bấm Assign a Worker / Close / Delete, dòng kết quả (kèm nút mở Beads Manager) vẫn còn khi bead chuyển sang cột khác ở lần refresh sau — đó là thứ [delta 20260918f](../design/paseo-bm-delta-20260918f-ui-review.md) F9 mua được và nó phải còn. Riêng thẻ xác nhận đang mở (chưa bấm "Yes") thì đóng lại khi bead đổi cột: người dùng bấm lại, không mất bằng chứng gì.

### Errata cho REQ-060

Delta này thay các ý sau của REQ-060 (Dashboard PRD), do owner chốt Q1 a và Q4 a:

| Ý của REQ-060 | Trước | Sau |
|---|---|---|
| (g) | Tên bead mang màu trạng thái: chưa làm accent, đang làm vàng, block đỏ, đã đóng xanh lá | Tên bead dùng `foreground` khi chưa xong, `foregroundMuted` khi đã đóng — REQ-069 (d) |
| (h) | Chip trạng thái cùng màu với tên | Chip cùng độ tương phản với tên, không màu hue — REQ-069 (d) |
| (j) | Bead đã đóng mặc định **ẩn** | Mặc định **hiện**, nút mắt vẫn ẩn/hiện — REQ-069 (c) |
| (k) | Danh sách chia bốn nhóm dọc, mỗi nhóm một vạch ngăn | Bốn **cột** kanban, responsive — REQ-069 (a), (b) |
| (n) | Số bead đang làm vàng, số block đỏ trên dòng workspace | Hai số đó, và số Worker đang chạy (trước đây xanh lá), dùng `foreground` khi lớn hơn 0 và xám khi bằng 0 — REQ-069 (d) |

Các ý khác của REQ-060 giữ nguyên, kể cả (i) "tên bead không in đậm".

**Tiêu chí đo:** `npm run verify` mã 0; owner tự xem trên daemon thật, trên máy tính và trên điện thoại: bốn cột ở bố cục rộng, dãy tab trạng thái ở bố cục hẹp, không còn chữ cam/đỏ/xanh lá ở chỗ hiện bead, ba tab của Setup, thẻ Errors ở màn Metric.
