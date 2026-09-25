# Delta-change — Màn hình Beads và ba hành động giao việc

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260916-beads-screen` |
| Tài liệu gốc | [Technical Design Dashboard](../../design/paseo-bm-dashboard.md) §2, §5 · [PRD Dashboard](../../product/paseo-bm-dashboard-prd.md) |
| Status | Merged — gộp vào [paseo-bm-dashboard.md](../../design/paseo-bm-dashboard.md) ngày 2026-09-25; chỉ còn là hồ sơ lịch sử |
| Owner | hieu.nt10 |

## 1. Owner yêu cầu

1. Nút "Open Beads Manager" đổi thành **Go to**; nút "Dashboard" đổi thành **Metric**.
2. Thêm nút **Beads** mở màn hình danh sách bead của workspace:
   - thẻ và biểu đồ theo dõi trạng thái, tiến độ, thời gian (khoảng 6 mục);
   - danh sách bead, lọc nhanh theo trạng thái, loại, độ ưu tiên, nhãn;
   - bấm một bead để xem chi tiết, với ba hành động: **Giao Worker làm**, **Xoá**, **Close**.

## 2. Quyết định

| # | Quyết định | Vì sao |
|---|---|---|
| 1 | **Đổi nguyên tắc "Dashboard chỉ đọc".** Màn Beads được gửi yêu cầu cho agent. Màn Metric vẫn chỉ đọc | Owner muốn giao việc ngay từ danh sách bead. D-7 ("0 agent bị Dashboard tạo") nay chỉ áp cho màn Metric |
| 2 | **Hành động đi qua Manager của workspace**, không tự tạo Worker. Plugin gọi `ensureManager`, rồi gửi Manager một yêu cầu bằng `agents.ref(id).send`; Manager tạo Worker theo `manager.md` | Chỉ một đường điều phối: `requestId`, nhãn, báo cáo, ngân sách review và trace đều giữ nguyên; màn Metric thấy request như mọi request khác |
| 3 | **Plugin không bao giờ ghi kho bead.** Đóng/xoá do Worker làm bằng `br`, sau khi tự đánh giá | Giữ luật "`br` sở hữu dữ liệu" (Design §10) |
| 4 | **Xoá và Close là yêu cầu đánh giá**, không phải lệnh: Worker xem bead có còn cần không / đã đạt tiêu chí chưa, làm nếu được, không thì báo lý do | Đúng ý owner ("đánh giá và thực hiện", "phân tích xem có đóng được không") và đúng luật Worker hỏi trước khi xoá |
| 5 | **Mọi hành động phải xác nhận** qua cùng cổng xác nhận của thao tác xoá trace (không có "Yes" mặc định) | Mỗi hành động tốn quota thật và có thể dẫn tới xoá dữ liệu |
| 6 | Mã lỗi mới **`E_BEAD_NOT_FOUND`** khi id không có trong kho | Không có mã sẵn nào đúng nghĩa |

Yêu cầu gửi Manager (tiếng Anh, vì dành cho agent) có dạng:

```
[Beads screen] The user asks: <implement | delete | close> bead <id> ("<title>").
<action instruction>
Treat this as a new request from the user. Do not commit or push.
```

## 3. Sáu mục của màn Beads

1. **Trạng thái:** tổng, mở, đang làm, bị chặn, sẵn sàng, đã đóng.
2. **Tiến độ:** phần trăm đã đóng (không tính epic).
3. **Tạo / đóng theo ngày**, 14 ngày gần nhất.
4. **Theo loại** (task, bug, epic, …).
5. **Theo độ ưu tiên** (P0 → P4).
6. **Thời gian:** trung vị từ tạo tới đóng, bead đang làm lâu nhất, số bead mở không đổi quá 7 ngày.

## 4. Hợp đồng mới

- `beads.list { workspaceId }` → danh sách bead rút gọn + thống kê.
- `beads.get { workspaceId, id }` → bead đầy đủ (mô tả, lý do đóng, phụ thuộc).
- `beads.action { workspaceId, id, action: implement | delete | close }` → `{ managerId, created }`.
