# paseo-bm 0.3.0-alpha.4

Bản prerelease **gộp** của cả delta 20260921 ([PRD delta](../product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md), REQ-062 → REQ-067), cộng một bản vá cho ứng dụng di động. Dùng làm `--notes-file` theo [release runbook](./paseo-bm-release-runbook.md).

> **Bản đầu tiên kể từ `0.2.0-alpha.1`.** Sáu phase 2a-13 → 2a-18 mỗi phase đã soạn sẵn một ghi chú riêng, nhưng **không bản nào trong số đó lên npm**: `0.2.0-alpha.2` và `0.3.0-alpha.0` → `0.3.0-alpha.3` chưa từng tồn tại trên registry. Tất cả nằm trong bản này. Ghi chú của từng phase vẫn giữ nguyên làm lịch sử, liên kết ở dưới.

**Cài bản này:** `npx paseo-bm@next`, hoặc ghim cứng `npx paseo-bm@0.3.0-alpha.4`. Lệnh `npx paseo-bm` trần đi theo dist-tag `latest`, **chưa** trỏ vào bản này; `npm view paseo-bm dist-tags` cho biết hiện `latest` ở đâu.

## Thay đổi

### Vai trò và model

- **Tôn trọng profile của bạn** ([2a-13](./paseo-bm-release-notes-0.2.0-alpha.2.md)). Thinking và feature bạn đặt cho profile `bm-worker` / `bm-reviewer` được áp cho mọi agent tạo sau đó. `npx paseo-bm install` giờ **gộp** vào các mục `bm-*` thay vì thay nguyên: thinking, mode, feature, icon, `paseoTools.disabledTools` bạn đặt đều còn.
- **Mọi provider cho mọi vai trò** ([2a-14](./paseo-bm-release-notes-0.3.0-alpha.0.md)). Manager, Worker và Reviewer chạy được trên mọi provider Paseo đang `available`, gồm OpenCode và Pi. Kèm cảnh báo `BM-TOOLS` khi agent vừa tạo thiếu công cụ Paseo, cột skill Pi và OpenCode trên màn Setup, và định giá theo `metadata.cost` cho model không có trong bảng giá sẵn.
- **Màn "Roles & models"** ([2a-15](./paseo-bm-release-notes-0.3.0-alpha.1.md)) trong Beads Manager → Setup: mỗi vai trò một dòng provider · model · thinking · mode, lưu thẳng vào cấu hình Paseo qua `config.patch`. Thay đổi áp cho agent tạo sau khi lưu; agent đang chạy giữ giá trị cũ.

### Dự phòng khi provider hỏng

- **"Ask me" cho Worker** ([2a-16](./paseo-bm-release-notes-0.3.0-alpha.2.md)). Worker dừng vì gói của provider (hết hạn mức, billing, đăng nhập, provider không chạy) → plugin nhận ra ngay khi lượt đóng và hiện thẻ. Chuỗi dự phòng tối đa 3 mục đặt trên màn Roles & models. Loại lỗi nhận bằng mẫu chữ, sửa được trong `role-fallback.json`; rate limit tạm thời **không** kích hoạt dự phòng.
- **Reviewer và Manager** ([2a-17](./paseo-bm-release-notes-0.3.0-alpha.3.md)). Cùng ba nút. **Wait** gửi `BM-RESUME` cho chính agent cũ khi hạn mức reset; **I'll handle it** để bạn tự xử.
- **Chế độ "Auto switch"** (2a-18, REQ-067). Lựa chọn thứ ba cho từng vai trò, bên cạnh **Ask me** (mặc định) và **Off**. Với Auto switch, khi một agent dừng vì gói của provider:
  - giờ reset biết được và còn không quá 30 phút → plugin **chờ** (như bấm **Wait**);
  - không thì có ứng viên → plugin **chuyển** theo đúng đường của vai trò (Worker: tạo Worker thay thế; Reviewer: gửi Worker cha chỉ dẫn; Manager: tạo Manager thay thế);
  - không có ứng viên → sự cố ở lại chờ bạn, như Ask me.

  Quyết định tự động đi qua đúng đường của một lần bấm: cùng khoá, cùng kiểm tra. Chat nhận **một** thẻ, với trạng thái đã chọn — không có thẻ "pending" trước đó. Chọn Auto switch hiện cảnh báo chi phí; với Manager, cảnh báo nói thêm rằng chat bạn đang dùng có thể bị thay. Hợp đồng cộng thêm: `roles.save-fallback` nhận `policy: "auto"`.

### Sửa lỗi

- **Nút Beads trên di động mở đúng workspace của nó.** Trước đây mọi nút Beads trên header đều mở workspace cuối cùng trong danh sách Paseo trả về, vì Hermes cho các closure tạo trong một vòng lặp cùng nhìn thấy giá trị cuối. Bản trên máy tính không bị.

## Rủi ro đã biết

- **Auto switch chỉ mới được kiểm một phần.** Điều kiện phát hành REQ-067 (c) đã đạt: một sự cố thật do Anthropic từ chối sinh ra được bộ mẫu phân loại đúng (`L4`, [checklist 18.1](./paseo-bm-worker-fallback-checklist.md)). Nhưng các mục nghiệm thu còn lại của Auto switch (18.2 → 18.6: chuyển tự động, chờ tự động, không ứng viên) **chưa đo trên daemon thật**. Auto switch mặc định **tắt**; bật riêng từng vai trò.
- **Không kiểm hạn mức trước khi tạo agent** (REQ-067 d): ứng viên cũng có thể đã hết hạn mức; khi đó sự cố mới của agent thay thế lại đi theo chuỗi.
- Một lần nhận nhầm loại lỗi sẽ tạo ra một agent thừa — tốn tiền, và hai agent sửa code song song.

## Tương thích

- Mọi trường RPC mới là cộng thêm. Policy mặc định vẫn là "Ask me"; `install.json` không đổi hình dạng.
- `roles[]` trong `install.json` giờ nghĩa là "trình cài đã ghi gì lần cuối"; cấu hình có hiệu lực là cấu hình Paseo.
- **Cài lại không còn đưa các mục `bm-*` về mặc định.** Ai từng dùng cài lại để "reset" vai trò thì nay dùng `--role` hay `--reconfigure`.
- **`policy: "auto"` an toàn với mọi bản `0.3.0-alpha.*`.** Schema của `role-fallback.json` đã nhận `"auto"` từ phase 2a-16, và mã trước 2a-18 đọc mọi policy khác `"off"` thành "Ask me" (chú thích ghi rõ điều đó nằm trong `plugin/client/setup-model.ts` **ở bản 2a-17**; bản 2a-18 thay dòng ấy bằng hỗ trợ `auto` thật, nên tìm trong mã hiện tại sẽ không thấy). Chuỗi dự phòng giữ nguyên, không mất gì. Ghi chú của các phase trước nói bản cũ "coi cả file là không dùng được" — điều đó **không đúng**. Dù sao cũng không có bản `0.3.0-alpha.*` nào khác trên npm để hạ xuống.

## Hoàn tác

Cách nhẹ nhất là **không hạ bản**: đặt policy "Ask me" hoặc "Off" cho từng vai trò trên màn Roles & models. Agent đã được tạo tự động thì lưu trữ agent nào không dùng nữa.

Muốn về hẳn bản trước thì phiên bản duy nhất có trên npm là **`0.2.0-alpha.1`** — `0.2.0-alpha.2` và `0.3.0-alpha.0` → `.3` chưa từng được phát hành. Đó là một bước lùi **đắt**: `0.2.0-alpha.1` không chứa một dòng mã dự phòng hay Roles & models nào, nên `npx paseo-bm@0.2.0-alpha.1` bỏ **toàn bộ** REQ-062 → REQ-067 — tôn trọng profile, mọi provider cho mọi vai trò, màn Roles & models, và dự phòng cho cả ba vai trò. `role-fallback.json` khi đó chỉ nằm im, không ai đọc.

Nếu vẫn muốn hạ: đặt policy về "Ask me" hay "Off" **trước**, vì `0.2.0-alpha.1` không có màn hình nào để đặt lại.
