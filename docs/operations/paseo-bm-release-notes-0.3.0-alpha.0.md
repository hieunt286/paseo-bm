# paseo-bm 0.3.0-alpha.0

Phase 2a-14 của delta 20260921 ([PRD delta](../product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md), REQ-063). Dùng làm `--notes-file` theo [release runbook](./paseo-bm-release-runbook.md).

## Thay đổi

- **Mọi provider cho mọi vai trò.** Manager, Worker và Reviewer chạy được trên mọi provider Paseo đang `available`, gồm OpenCode và Pi. Plugin chọn cách chạy theo khả năng của provider:
  - Claude, Codex: như trước.
  - OpenCode: luôn truyền một agent OpenCode (mode) — agent bạn chọn trên profile, không chọn thì agent đầu tiên Paseo liệt kê. Manager và Worker bật `auto_accept`; **Reviewer không bao giờ tự duyệt**.
  - Pi: không truyền mode. `## Runtime facts` nói "none" để Manager và Worker không truyền mode nào.
- **Báo khi thiếu công cụ Paseo.** Worker vừa tạo mà không có công cụ Paseo (Pi thiếu `pi-mcp-adapter`) → Manager nhận `BM-TOOLS` và báo bạn. Manager vừa tạo mà thiếu → màn Beads Manager hiện cảnh báo. Màn Setup hiện trạng thái gần nhất.
- **Cột skill Pi và OpenCode** trên màn Setup (`~/.pi/agent/skills`, `~/.config/opencode/skill`), chỉ đọc.
- **Đăng nhập Pi:** trình cài in hướng dẫn thay vì chạy lệnh.
- **Giá theo `metadata.cost`:** model không có trong bảng giá sẵn có mà Paseo cung cấp giá (ví dụ model OpenCode) được định giá trên Dashboard. Bản ghi lượt có thêm trường tuỳ chọn `runtime.provider`.

## Rủi ro đã biết (owner chấp nhận, Q7 a)

- Reviewer trên Pi không có lớp duyệt quyền nào; Reviewer trên OpenCode chạy với quyền của agent OpenCode được chọn. Ở hai trường hợp này, luật chỉ đọc của Reviewer chỉ còn trong chỉ dẫn.

## Tương thích

- Mọi trường RPC mới là cộng thêm. Kho vết không di trú.

## Hoàn tác

Cài lại bản trước: `npx paseo-bm@0.2.0-alpha.2`. Alias đã đổi `extends` sang OpenCode hay Pi thì đổi lại bằng `--role`.
