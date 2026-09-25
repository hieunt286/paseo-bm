# Đối chiếu README với tài liệu người dùng của Dashboard

| Trường | Giá trị |
|---|---|
| Bead | `bm-wp-214-jvg.1` (WP-214) |
| Yêu cầu | [PRD Dashboard](../../product/paseo-bm-dashboard-prd.md) REQ-040, REQ-048(d), REQ-052, REQ-054, REQ-055, REQ-057 và điều kiện ra số 6 của Phase 2a-2 |
| Đối tượng kiểm | [`README.md`](../../../README.md) ở gốc repo (tiếng Anh, dành cho người dùng npm và GitHub) |
| Ngày | 2026-09-16 |
| Nguồn đối chiếu | PRD Dashboard; [Technical Design Dashboard](../../design/paseo-bm-dashboard.md) §3.2, §3.5, §3.6, §3.7, §9, §12; [ADR-007](../../adr/ADR-007-dashboard-trace-store.md); mã đã implement trong `plugin/client/dashboard*.ts(x)`, `plugin/server/trace-store.ts`, `plugin/server/cost.ts` |
| Mẫu | Theo [đối chiếu REQ-015](./paseo-bm-readme-req015-checklist.md) của WP-118 |

## 1. Bốn hạng mục bắt buộc của bead

| # | Hạng mục | Đạt | Mục README |
|---|---|---|---|
| 1 | Lối vào Dashboard từ Beads Manager và Command Center | [x] | **The Beads Dashboard → Opening it**: nút **Dashboard** cạnh từng workspace trong sidebar item *Beads Manager*, và mục Command Center **Open Beads Dashboard** |
| 2 | Cách xoá trace do người dùng xác nhận, và xoá là không hoàn tác được | [x] | **Trace storage, and deleting it**: ba phạm vi xoá (một yêu cầu / cũ hơn 30 ngày / toàn bộ workspace), bước xem trước nêu số trace và số byte, câu xác nhận mặc định là an toàn, và câu "Deletion is irreversible. There is no undo and no bin." |
| 3 | Vị trí lưu trữ và cảnh báo rõ ràng rằng hội thoại nằm trên đĩa | [x] | **Before you install** gạch đầu dòng "The Dashboard records agent conversation on this machine"; **Trace storage** nêu `~/.paseo-bm/traces/`, bố cục theo workspace và theo tháng, quyền `0700`/`0600`, che bí mật trước khi ghi; bảng **Install home** có dòng `~/.paseo-bm/traces/` ghi rõ đây là *dữ liệu của người dùng*, không có hash, không backup, cài và cập nhật không chạm |
| 4 | Ngưỡng cảnh báo áp cho toàn máy, đặt ở chỗ README nói về cài đặt | [x] | **The storage warning threshold**: đường vào (Paseo settings → Beads Dashboard), mặc định 200 MB, câu "this threshold applies to every workspace on this machine", và giá trị không hợp lệ thì giữ ngưỡng cũ |

## 2. Những điều README nói đúng theo tài liệu đã duyệt

| Phát biểu trong README | Nguồn |
|---|---|
| "paseo-bm never deletes traces on its own" — không có retention, không xoay vòng, không dọn tự động | ADR-007 quyết định 6; REQ-055(c) |
| Xoá không chạm beads, tài liệu, agent hay hội thoại Paseo | REQ-054(d) |
| Cập nhật không bao giờ xoá kho, kể cả `install --prune` | REQ-056(b); PRD gốc REQ-010(f) sau delta |
| Số liệu ghi rõ độ chắc chắn; chỉ nói "No beads were created" khi Worker báo đúng thế | REQ-041(d), REQ-044(c) |
| Thời gian là thời gian treo, gồm cả lúc chờ người dùng | REQ-043(c) |
| Chi phí: số của provider thì dùng nguyên, còn lại là tạm tính kèm ngày bảng giá; token cache tính theo đơn giá cache; model lạ chỉ hiện token; không phải hoá đơn | REQ-052(b)(c)(d)(f) |
| Workspace không còn thì trace vào nhóm riêng, gán lại được, và paseo-bm không tự đoán liên kết | REQ-057(a)(d)(f) |
| Thống kê beads đọc thẳng `.beads/issues.jsonl` và khớp `br stats` / `br ready` | REQ-046(b)(c) |

## 3. Cố ý KHÔNG viết vào README

| Không viết | Lý do |
|---|---|
| Cờ CLI để xoá kho khi gỡ, và hành vi mặc định của lệnh gỡ | Q-039b chưa được owner chốt; WP-213 nằm ngoài phạm vi chuyển thành beads. Đặt tên cờ trong tài liệu người dùng trước khi nó tồn tại là hứa một hợp đồng chưa có |
| Dòng `doctor` về kho lưu vết | Q-043 chưa chốt, mặc định là không có |
| Xuất báo cáo, biểu đồ, gộp nhiều workspace | Phase 2b, chưa tồn tại |

## 4. Kết luận

Bốn hạng mục của bead đều đạt. README không đặt tên bất cứ thứ gì thuộc WP-213 hay Phase 2b, nên không hứa hành vi chưa có. Phần kiểm bằng mắt trên máy thật (đọc README cạnh giao diện thật) thuộc `bm-wp-214-jvg.2`.

## 5. Đối chiếu lại sau khi viết lại README (2026-09-16)

Owner yêu cầu viết lại README cho khớp sản phẩm hiện tại (bead `bm-6zu`): màn hình Beads Manager với ba nút **Go to / Metric / Beads**, màn hình Metric dạng graph, màn hình Beads, và luật mới của các role. Bốn hạng mục ở §1 vẫn đạt, nhưng đã chuyển sang mục mới:

| # | Mục README mới |
|---|---|
| 1 | **The Beads Manager screen** (nút **Metric** cạnh từng workspace, mục Command Center **Open Beads Metric**, danh sách **Closed workspaces with history**) |
| 2 | **Trace storage**: ba phạm vi xoá, bước xem trước nêu số trace, số byte và số request còn chạy, câu "Deletion is irreversible. There is no undo and no bin." |
| 3 | **Before you install**, cảnh báo số 4 "Agent conversation is recorded on this machine"; mục **Trace storage**; dòng `~/.paseo-bm/traces/` trong bảng **Install home** |
| 4 | **The storage warning threshold** (giữ nguyên nội dung) |

Thay đổi so với §2:

- **Chi phí:** README không còn nói "số của provider thì dùng nguyên". Từ lỗi số 11 của đợt nghiệm thu, `totalCostUsd` là tổng cả phiên nên không dùng; chi phí luôn là tạm tính từ token từng lượt, kèm ngày bảng giá.
- **Manager:** README nêu rõ `manager.md` không còn cấm git, phát hành, lệnh phá huỷ hay đọc file credential (quyết định của owner, delta owner-feedback §4).
- **Kho lưu vết khi gỡ:** vẫn không viết (Q-039 chưa chốt), đúng §3.
- Mục "Not available yet" bỏ "lịch sử request" và "dashboard tiến độ bead" vì đã có; thêm giới hạn "bead của workspace đã đóng không hiển thị".
