# paseo-bm 0.3.0-alpha.3

Phase 2a-17 của delta 20260921 ([PRD delta](../product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md), REQ-066). Dùng làm `--notes-file` theo [release runbook](./paseo-bm-release-runbook.md).

## Thay đổi

- **Dự phòng cho Reviewer.** Reviewer dừng vì gói của provider → thẻ trong chat Manager, cùng ba nút như Worker. **Switch** không để plugin tạo agent: Worker cha nhận chỉ dẫn chính xác để tự tạo Reviewer thay thế trên `bm-reviewer-fallback-<n>` (không có công cụ Paseo) và gửi nó nguyên văn tin review cũ. Tin gửi lại đó **không** tính là một lượt review mới. Nếu thông báo bị mất khi plugin nạp lại, thẻ có nút **Resend to Worker**.
- **Dự phòng cho Manager.** Manager dừng vì gói của provider → thẻ ngay trong chat của nó. **Switch** tạo Manager thay thế trong cùng workspace, với lời bàn giao dựng bằng mã (các Worker đang sống và báo cáo cuối, câu hỏi đang chờ, sự cố đang mở, ba tin gần nhất bạn gõ — đã che bí mật). Beads Manager mở Manager thay thế; mọi Worker đang sống được báo id Manager mới qua `BM-SETTINGS`. Manager cũ vẫn còn cho tới khi bạn lưu trữ nó.
- **Roles & models** hiện chuỗi dự phòng cho cả ba vai trò.
- **Wait** và **I'll handle it** áp cho mọi vai trò (Wait gửi `BM-RESUME` cho chính agent cũ khi hạn mức reset).
- Hợp đồng cộng thêm: `fallback.act` có action `resend`.

## Chưa có

- **Chế độ Tự động** (phase 2a-18) chưa mở: điều kiện vào phase là có ít nhất một sự cố thật được nhận đúng loại, và lúc đóng phase này chưa có sự cố nào.

## Rủi ro đã biết

- Reviewer thay thế chỉ được tính đúng khi Worker gắn nhãn `bm.replaces`; thiếu nhãn thì tin gửi lại bị đếm và có thể sinh `BM-BUDGET` (lỗi an toàn: Manager hỏi bạn).
- Sau khi Manager được thay, các sự cố còn mở của workspace vẫn hiện ở chat Manager cũ.

## Tương thích

- Mọi trường RPC mới là cộng thêm.

## Hoàn tác

Đặt policy "Off" cho Manager và Reviewer trên màn Roles & models, hoặc cài lại bản trước: `npx paseo-bm@0.3.0-alpha.2`. Manager đã bị thay: lưu trữ Manager nào không dùng nữa.
