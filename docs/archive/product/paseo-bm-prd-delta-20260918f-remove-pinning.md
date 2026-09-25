# Delta-change — Bỏ tính năng ghim workspace trên danh sách Workspaces

| Trường | Giá trị |
|---|---|
| Mã | `prd-delta-20260918f-remove-pinning` |
| PRD gốc | [PRD Dashboard](../../product/paseo-bm-dashboard-prd.md) — Accepted. **Không sửa tại chỗ** cho tới khi delta này được owner duyệt; sau đó plan WP-276 .2 áp nó vào REQ-060 (e) |
| Status | Merged — gộp vào [paseo-bm-dashboard-prd.md](../../product/paseo-bm-dashboard-prd.md) ngày 2026-09-25; chỉ còn là hồ sơ lịch sử |
| Owner | hieu.nt10 |
| Created | 2026-09-18 |
| Request | `req-20260918T063746Z` |
| Routing decision | [design delta 20260918f §0](../design/paseo-bm-delta-20260918f-ui-review.md#0-routing-decision) (canonical) |
| Design | [design-delta-20260918f-ui-review](../design/paseo-bm-delta-20260918f-ui-review.md) §4.5 |
| Plan | [plan-delta-20260918f-ui-review](../plans/paseo-bm-implementation-plan-delta-20260918f-ui-review.md) WP-272, WP-276 .2 |

## 1. Owner nói gì

Trong lúc rà soát phần UI làm ngày 2026-09-18, Worker tìm ra ba lỗi ở tính năng ghim (design delta §3.1 F6–F8):

- phép ghim chạy sai vị trí khi file còn id của workspace đã đóng;
- hai lần bấm nhanh mất một thay đổi, và ghi lỗi thì không ai biết;
- cử chỉ kéo bị dựng lại giữa chừng.

Worker hỏi có nên tắt nút ghim trong lúc đang ghi không. Owner trả lời "Xóa đi thôi, không còn cần thiết". Hỏi lại cho rõ (Q11), owner chọn **c**: bỏ hẳn tính năng ghim (★ ▲▼, kéo-thả, RPC `launcher.order.*`), danh sách chỉ xếp theo hoạt động gần nhất, và file `launcher-order.json` cũ để nguyên, không đọc nữa.

## 2. Bối cảnh — vì sao bây giờ

- Tính năng ghim ra đời ngày 2026-09-17 (delta 20260917e §4.1), khi danh sách workspace còn là màn chính của Beads Manager.
- Từ ngày 2026-09-18 (REQ-060 d, e), Setup là màn chính, và danh sách workspace thành màn phụ sau nút "Workspaces".
- Owner đánh giá thứ tự tự chọn không còn cần thiết. Giữ nó thì phải sửa ba lỗi trên, gồm cả một cử chỉ không kiểm được nếu không có người thật kéo chuột.

## 3. Tác nhân

N/A: không có tác nhân mới. Người dùng màn Beads Manager như ở PRD Dashboard §3.

## 4. Mục tiêu và bằng chứng thành công

- Danh sách Workspaces xếp đúng theo hoạt động gần nhất (`activity_at` giảm dần), không có nút ★ ▲▼, không có tay kéo.
- Plugin không còn RPC `launcher.order.get` / `launcher.order.set`. Bằng chứng: hai test danh sách RPC chính xác.
- Plugin không đọc, không ghi, không xoá `<install home>/ui/launcher-order.json`. Bằng chứng: grep không còn tên file đó trong `plugin/`.
- Mọi thứ khác trên dòng workspace giữ nguyên: chấm đang chạy, số bead (màu theo REQ-060 n), Go to / Metric / Beads, lịch sử workspace đã đóng.

## 5. Yêu cầu

**REQ-060 (e), sửa.** Bỏ "ghim" khỏi danh sách thứ có trên màn Workspaces và thêm thứ tự xếp:

> (e) Nút "Workspaces" mở danh sách workspace như trước (chấm đang chạy, số bead, Go to / Metric / Beads, lịch sử workspace đã đóng), **xếp theo hoạt động gần nhất, không ghim**, với ← về màn chính; Metric/Beads mở từ danh sách có ← về danh sách.

Tiêu chí chấp nhận:

1. Mở Beads Manager → Workspaces: không có ★ ▲▼ hay ⣿ trên dòng nào; dòng đầu là workspace có hoạt động mới nhất.
2. Owner đã từng ghim: thứ tự ghim cũ **không** còn áp dụng, và file `launcher-order.json` của owner vẫn còn nguyên trên đĩa.
3. Các ý (a)–(d), (f)–(n) của REQ-060 không đổi.

## 6. Yêu cầu phi chức năng

- **Hiệu năng:** không đổi. Bỏ một lần đọc file lúc mở màn.
- **Bảo mật:** không đổi. Bỏ một đường ghi vào install home.
- **Tính sẵn sàng:** không đổi.
- **Dữ liệu:** không xoá dữ liệu nào của owner. Revert việc gỡ thì thứ tự cũ quay lại nguyên vẹn.

## 7. Ngoài phạm vi

- Dọn `ui/launcher-order.json` khỏi máy owner: file để nguyên (Q11 c).
- Cách xếp khác (theo tên, theo số bead) hay ô lọc danh sách.
- Mọi thay đổi khác của request `req-20260918T063746Z`: đó là sửa lỗi và dọn code, không đổi yêu cầu (design delta §0).

## 8. Ranh giới và phụ thuộc

- Phụ thuộc `paseo.workspaces.list` với `sort: activity_at desc`, như hôm nay.
- Không sở hữu thư mục `ui/` của install home. `answer-marks.json` của delta 20260918d (batch `b6`) cũng nằm ở đó, nên thư mục ở lại.

## 9. Lộ trình và cổng

- **Phase:** Phase 2a-10, cùng plan delta 20260918f.
- **Điều kiện ra:** các tiêu chí ở §5 được chứng minh (design delta §6, dòng "Gỡ ghim"); owner duyệt delta này; WP-276 .2 áp nó vào REQ-060 (e) của PRD Dashboard với một dòng Revision History. Status của PRD Dashboard giữ **Accepted** sau khi áp, vì delta đã được duyệt.
- **Cổng `prd-ready` (tự chấm 2026-09-18): PASS.**
  - Status, owner, routing decision: có.
  - Bối cảnh "vì sao bây giờ": §2.
  - Mục tiêu có bằng chứng quan sát được: §4.
  - Ngoài phạm vi: §7.
  - REQ có ID, mức ưu tiên (P2 như REQ-060) và tiêu chí cụ thể: §5.
  - Yêu cầu phi chức năng: §6.
  - Ranh giới: §8.
  - Phase và điều kiện ra: §9.
  - Câu hỏi mở: §10.
  - Tác nhân và hành trình: N/A có lý do (§3).
  - PRD gốc không bị gắn nhãn Accepted với nội dung sửa đổi đang chờ, vì nó chưa bị sửa.

## 10. Câu hỏi mở

Không còn. Q11 c đã chốt nội dung; owner duyệt delta ở bước xác nhận trước khi implement (Q14 a, 2026-09-18; owner: hieu.nt10; trạng thái: đã trả lời).

## 11. Revision History

| Ngày | Tác giả | Thay đổi |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Owner duyệt (Q14 a): Status → Accepted; áp vào REQ-060 (e) của PRD Dashboard (bead `bm-wp-270-ui-review-v0o1.20`) |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Tạo delta, Status Review, sau review b1 của `req-20260918T063746Z`: việc sửa REQ-060 (e) phải qua `prd-ready` và chờ owner duyệt, không áp thẳng vào PRD đã Accepted |
