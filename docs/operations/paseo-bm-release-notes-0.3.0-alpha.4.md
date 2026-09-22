# paseo-bm 0.3.0-alpha.4

Phase 2a-18 của delta 20260921 ([PRD delta](../product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md), REQ-067). Dùng làm `--notes-file` theo [release runbook](./paseo-bm-release-runbook.md).

> **Chưa phát hành.** Owner chốt Q17 b: bản này chỉ lên npm khi `~/.paseo-bm/role-fallback-state.json` có ít nhất một sự cố do provider thật sinh ra, và bộ mẫu nhận đúng loại của nó (REQ-067 c). Owner kiểm điều kiện đó ([checklist 18.1](./paseo-bm-worker-fallback-checklist.md#phase-2a-18--030-alpha4-req-067)) trước bước phát hành của runbook.

## Thay đổi

- **Chế độ "Auto switch".** Màn Roles & models có lựa chọn thứ ba cho chính sách dự phòng của từng vai trò: **Ask me** (mặc định), **Auto switch**, **Off**. Với Auto switch, khi một agent dừng vì gói của provider:
  - giờ reset biết được và còn không quá 30 phút → plugin **chờ** (như bấm **Wait**);
  - không thì có ứng viên → plugin **chuyển** theo đúng đường của vai trò (Worker: tạo Worker thay thế; Reviewer: gửi Worker cha chỉ dẫn; Manager: tạo Manager thay thế);
  - không có ứng viên → sự cố ở lại chờ bạn, như Ask me.
- Quyết định tự động đi qua đúng đường của một lần bấm: cùng khoá, cùng kiểm tra. Chat nhận **một** thẻ, với trạng thái đã chọn — không có thẻ "pending" trước đó.
- Chọn Auto switch hiện cảnh báo chi phí. Với Manager, cảnh báo nói thêm rằng chat bạn đang dùng có thể bị thay.
- Hợp đồng cộng thêm: `roles.save-fallback` nhận `policy: "auto"`.

## Rủi ro đã biết

- Bộ mẫu nhận dạng chưa kiểm trên sự cố thật. Bật Auto switch trước khi mẫu được kiểm: một lần nhận nhầm tạo ra một agent thừa (tốn tiền, sửa code song song). Owner chấp nhận rủi ro này khi chọn Q17 b.
- Không có kiểm hạn mức trước khi tạo agent (REQ-067 d): ứng viên cũng có thể đã hết hạn mức; khi đó sự cố mới của agent thay thế lại đi theo chuỗi.

## Tương thích

- Mọi trường RPC mới là cộng thêm. Policy mặc định vẫn là "Ask me"; file `role-fallback.json` cũ đọc được như trước.
- Cài lại một bản trước trong khi `role-fallback.json` còn `policy: "auto"`: bản trước coi **cả file** là không dùng được (một dòng log) và mọi vai trò về mặc định — "Ask me", không có ứng viên. Vì vậy đổi policy về "Ask me" trước khi cài lại bản trước.

## Hoàn tác

Đặt policy "Ask me" (hoặc "Off") cho từng vai trò trên màn Roles & models; muốn về hẳn bản trước thì làm bước đó rồi mới cài lại: `npx paseo-bm@0.3.0-alpha.3`. Agent đã được tạo tự động: lưu trữ agent nào không dùng nữa.
