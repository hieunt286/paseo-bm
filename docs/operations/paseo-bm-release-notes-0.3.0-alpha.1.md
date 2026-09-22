# paseo-bm 0.3.0-alpha.1

Phase 2a-15 của delta 20260921 ([PRD delta](../product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md), REQ-064; [ADR-008](../adr/ADR-008-role-settings-written-by-plugin.md)). Dùng làm `--notes-file` theo [release runbook](./paseo-bm-release-runbook.md).

## Thay đổi

- **Màn "Roles & models"** trong Beads Manager → Setup. Mỗi vai trò (Manager, Worker, Reviewer) có một dòng: provider · model · thinking · mode, và nút **Edit**. Đổi được mà không cần terminal hay cài lại.
  - Chỉ chọn được giá trị Paseo liệt kê: provider đang `available`, model của provider đó, thinking của model đó, mode của provider đó. Có giá thì form hiện `~$in / $out per 1M tokens`.
  - Reviewer không bao giờ chọn được mode `dangerous` hay `planning`.
  - Cảnh báo, không chặn: Manager và Worker cùng provider gốc; Pi cần `pi-mcp-adapter`; Reviewer trên Pi hay OpenCode.
- **Lưu thẳng vào cấu hình Paseo.** Plugin ghi profile và alias `bm-*` qua `config.patch`, nên Settings → Agent profiles của Paseo luôn hiện đúng giá trị đó. Mục không phải `bm-*` giữ nguyên từng byte. Cấu hình đã đổi ở nơi khác kể từ lúc mở form → không ghi, form báo "reopen".
- **Agent đang sống được báo.** Thay đổi áp cho agent tạo sau khi lưu; agent đang chạy giữ model và thinking cũ. Khi mode của agent con đổi, Manager (với Worker) và Worker (với Reviewer) đang sống nhận `BM-SETTINGS` với dòng mode mới, để lần tạo kế tiếp không bị Paseo từ chối.
- RPC mới: `roles.settings`, `roles.options`, `roles.save-settings`; mã lỗi mới `E_ROLE_SETTINGS_INVALID`, `E_ROLE_SETTINGS_CONFLICT`, `E_ROLE_SETTINGS_WRITE_FAILED`.

## Rủi ro đã biết (owner chấp nhận, Q3 a, Q15 a)

- Paseo thay cả mảng `daemon.agentProfiles` mỗi lần ghi và không có ghi có điều kiện. Một thay đổi làm trong Settings của Paseo rơi đúng vào lúc plugin đang ghi có thể bị đè mà không báo. Plugin chỉ thu hẹp khoảng đó (so `revision` ngay trước khi ghi, một lần ghi, mutex).
- Thông báo `BM-SETTINGS` chờ trong bộ nhớ: nạp lại plugin thì mất, và agent đó quay về hành vi cũ (Paseo từ chối lần tạo, agent gửi `blocked`).

## Tương thích

- Mọi trường RPC mới là cộng thêm. `roles.describe` giữ nguyên. Không di trú dữ liệu.

## Hoàn tác

Cài lại bản trước: `npx paseo-bm@0.3.0-alpha.0`. Cấu hình đã lưu nằm trong config Paseo và vẫn dùng được; muốn đổi lại thì dùng Settings của Paseo hoặc `--role`.
