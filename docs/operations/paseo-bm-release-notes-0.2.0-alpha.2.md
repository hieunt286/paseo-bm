# paseo-bm 0.2.0-alpha.2

Phase 2a-13 của delta 20260921 ([PRD delta](../product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md), REQ-062). Dùng làm `--notes-file` theo [release runbook](./paseo-bm-release-runbook.md).

## Thay đổi

- **Thinking và feature của profile tới Worker và Reviewer.** Mức thinking và các feature bạn đặt cho profile **Worker** (`bm-worker`) hay **Reviewer** (`bm-reviewer`) trong Settings → Agent profiles của Paseo nay được áp cho mọi Worker và Reviewer tạo sau đó. Thinking chỉ được áp khi agent chạy đúng model của profile, vì mỗi model có bộ mức thinking riêng. Giá trị do bên tạo truyền vào vẫn thắng.
- **Cài lại không xoá cấu hình bạn đặt.** `npx paseo-bm install` giờ gộp vào các mục `bm-*` trong cấu hình Paseo thay vì thay nguyên: thinking, mode, feature, icon hay `paseoTools.disabledTools` bạn đặt đều còn nguyên. `--role` và `--reconfigure` chỉ đổi provider gốc, model và tên của đúng vai trò được nêu; đổi model thì mức thinking cũ bị bỏ.
- **`doctor` báo vai trò đã đổi trong app.** Một kiểm mới `roles.changed-in-app` (mức `ok`, không đổi mã thoát) nói khi provider gốc hay model của một vai trò khác lần ghi cuối của trình cài.

## Tương thích

- `install.json` không đổi hình dạng. `roles[]` giờ nghĩa là "trình cài đã ghi gì lần cuối"; cấu hình có hiệu lực là cấu hình Paseo.
- Người từng dùng cài lại để đưa vai trò về mặc định: dùng `--role` hay `--reconfigure`.

## Hoàn tác

Cài lại bản trước: `npx paseo-bm@0.2.0-alpha.1`. Không có dữ liệu nào phải dọn.
