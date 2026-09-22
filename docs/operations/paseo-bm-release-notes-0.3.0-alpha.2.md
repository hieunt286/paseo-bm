# paseo-bm 0.3.0-alpha.2

Phase 2a-16 của delta 20260921 ([PRD delta](../product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md), REQ-065). Dùng làm `--notes-file` theo [release runbook](./paseo-bm-release-runbook.md).

## Thay đổi

- **Worker dự phòng — "Ask me".** Khi một Worker dừng vì gói của provider (hết hạn mức, billing, đăng nhập, provider không chạy), plugin nhận ra ngay khi lượt đó kết thúc và hỏi bạn bằng một thẻ trong chat Manager, kèm pill "Fallback · N decision(s)":
  - **Switch to <ứng viên>**: plugin tạo Worker thay thế trên mục kế tiếp của chuỗi dự phòng, trong cùng thư mục, với lời bàn giao dựng bằng mã (báo cáo cuối, bead, số lượt review, yêu cầu gốc). Worker thay thế không làm lại việc đã xong, không hoàn tác thay đổi đang có. Worker cũ bị đánh dấu "replaced"; Reviewer đang chạy của nó nhận thông báo dừng.
  - **Wait until <giờ reset>**: khi biết giờ reset (Claude, Codex), plugin nhắn chính Worker cũ làm tiếp sau giờ đó.
  - **I'll handle it**: không động tới agent nào.
- **Chuỗi dự phòng trên màn Roles & models**: dưới dòng Worker có "On a usage limit: Ask me / Off" và tối đa 3 mục dự phòng (provider, model, thinking, mode), thêm, xoá, đổi thứ tự.
- **Loại lỗi**: nhận ra bằng mẫu chữ trên lỗi của lượt (sửa được trong `role-fallback.json`, mục `patterns`). Rate limit tạm thời và lỗi khác không kích hoạt dự phòng. Mẫu có lượng từ lồng nhau (ví dụ `(a+)+`) bị bỏ vì có thể treo plugin.
- **File mới** trong thư mục cài đặt, là dữ liệu của bạn: `role-fallback.json`, `role-fallback-state.json`. Alias mới trong config Paseo: `bm-worker-fallback-<n>`.
- RPC mới `roles.save-fallback`, `fallback.incidents`, `fallback.act`; mã lỗi mới `E_FALLBACK_NOT_FOUND`, `E_FALLBACK_NOT_PENDING`, `E_FALLBACK_NO_CANDIDATE`, `E_FALLBACK_NO_RESET`, `E_FALLBACK_CREATE_FAILED`. Thông báo mới của plugin: `BM-FALLBACK`, `BM-HANDOVER`, `BM-RESUME`.

## Rủi ro đã biết

- Mẫu nhận dạng mặc định chưa kiểm trên sự cố thật; lượt hỏng không khớp mẫu thì không có thẻ (như trước).
- Chỉ đọc hạn mức (`listUsage`) **sau khi** đã nhận ra L1 của Claude hay Codex, một lần mỗi sự cố (owner chấp nhận, Q2 a).
- Chuyển sang provider tính tiền theo token có thể tốn tiền; thẻ hiện giá khi biết.

## Tương thích

- Mọi trường RPC mới là cộng thêm. Bản cũ gặp alias `bm-worker-fallback-*` thì không nhận ra vai; gỡ cài đặt vẫn xoá alias đó.

## Hoàn tác

Đặt policy "Off" trên màn Roles & models, hoặc cài lại bản trước: `npx paseo-bm@0.3.0-alpha.1`. Hai file mới ở lại vô hại.
