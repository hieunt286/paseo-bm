# ADR-005 — Beads Manager là một agent, plugin chỉ là lối vào và bảng quan sát

| Trường | Giá trị |
|---|---|
| Status | Accepted |
| Date | 2026-09-15 |
| Owner | hieu.nt10 |
| Liên quan | [PRD REQ-020, REQ-021, REQ-026](../product/paseo-bm-prd.md#6-functional-requirements) · [ADR-006](ADR-006-role-registration.md) · [Technical Design](../design/paseo-bm.md) |

## Context

Yêu cầu của owner: người dùng **chat** với Beads Manager; Manager **giao ngay** việc xuống một Beads Worker; Manager chịu trách nhiệm quản lý, kiểm soát và trả lời về tiến độ các agent; người dùng **chat thẳng được với Worker**; và **chỉ người dùng** mới đóng hoặc xoá Worker.

Có hai cách hiện thực hoá, và chúng dẫn tới hai sản phẩm khác hẳn nhau:

1. **Manager là giao diện của plugin** — một panel có ô nhập, mã phía daemon nhận yêu cầu rồi gọi SDK tạo Worker.
2. **Manager là một agent** — người dùng chat với nó như mọi agent khác; nó tự quyết định và tự gọi công cụ để tạo, theo dõi, nhắc việc.

Dữ kiện đã kiểm chứng trên daemon thật (Paseo 0.8.0, 2026-09-15):

- Agent do một agent khác tạo ra vẫn là **agent hạng nhất trong workspace**: nó xuất hiện trong danh sách agent, chỉ mang thêm nhãn `paseo.parent-agent-id`. Có sẵn `paseo agent open|send|stop|archive|delete`.
- Nghĩa là người dùng mở, chat, dừng, lưu trữ hay xoá một agent con **trực tiếp** được — quan hệ cha con chỉ là dữ liệu mô tả, không phải bức tường.
- Paseo cấp cho agent một bộ công cụ để tạo và theo dõi agent khác khi quyền được mở (xem ADR-006).

Plugin Paseo **không đọc được khung chat** của agent khác; nó chỉ nhận cái người dùng chủ động gửi cho nó. Vì vậy phương án 1 buộc người dùng phải nhập yêu cầu vào một ô riêng thay vì chat bình thường, và mọi trao đổi làm rõ qua lại sẽ phải tự dựng lại từ đầu trong giao diện plugin.

## Decision

1. **Beads Manager là một agent**, chạy trong workspace của người dùng, dùng công cụ và model do người dùng cấu hình lúc cài.
2. **Plugin không thay Manager làm việc.** Vai trò của plugin thu về ba việc:
   - **Lối vào:** một mục sidebar và một mục Command Center để mở Manager cho workspace hiện tại; chưa có thì tạo, có rồi thì mở lại.
   - **Bảng quan sát:** hiển thị cây agent của paseo-bm trong workspace (Manager → Worker → Reviewer) kèm trạng thái, để người dùng thấy toàn cảnh mà không phải tự lần trong danh sách agent.
   - **Cài đặt:** đăng ký vai trò và chỉ dẫn (ADR-006).
3. **Manager giao ngay, không tự làm.** Nhận yêu cầu là tạo Worker; bản thân Manager không viết tài liệu, không tạo bead.
4. **Worker và Reviewer là agent hạng nhất.** Người dùng chat thẳng, dừng, lưu trữ, xoá được.
5. **Vòng đời do người dùng quyết.** Không agent nào được **lưu trữ hay xoá** agent. Manager **được phép dừng** một Worker đang đi lạc hoặc treo, vì dừng là thao tác khôi phục được còn xoá thì mất lịch sử; dừng một Worker phải kéo theo dừng Reviewer mà nó đang chạy. Xong việc thì Worker báo cáo rồi nghỉ, chờ người dùng xử lý. *(Làm rõ 2026-09-15 sau khi lượt review chỉ ra REQ-020d và REQ-026f mâu thuẫn nhau.)*
6. **Worker dừng lại hỏi** trước những việc có tính quyết định: sửa tài liệu đã đóng băng, mở rộng phạm vi, xoá hay gộp bead đang có.

## Consequences

**Tích cực**
- Trao đổi làm rõ diễn ra tự nhiên trong khung chat, đúng chỗ người dùng đã quen, thay vì trong một ô nhập tự chế.
- Manager thừa hưởng miễn phí mọi thứ Paseo đã làm tốt: lịch sử hội thoại, phê duyệt quyền, thông báo, giao diện di động.
- Ranh giới trách nhiệm rõ: plugin lo cài đặt và quan sát, agent lo suy luận. Mã phía plugin không phải đoán ý người dùng.
- Người dùng can thiệp được ở mọi tầng, kể cả nói thẳng với Worker khi Manager hiểu sai.

**Tiêu cực / phải chấp nhận**
- **Tốn thêm một phiên model** cho Manager, dù phần lớn việc nó làm chỉ là chuyển tiếp và tóm tắt. Đây là cái giá của việc chat được và tự quyết được.
- Hành vi kém xác định hơn một đoạn mã: Manager có thể diễn giải sai yêu cầu. Giảm thiểu bằng bộ chỉ dẫn vai trò đóng gói sẵn (REQ-032) thay vì để người dùng tự viết mỗi lần.
- Plugin phải mở đúng quyền công cụ cho Manager và Worker, mà đó là quyền tạo và dừng agent khác — một ranh giới an ninh thật (ADR-006).
- Manager không đọc hội thoại của agent khác. Vì vậy "nắm tiến độ" đứng trên hai chân: **báo cáo có cấu trúc do Worker chủ động gửi về** ở từng mốc (REQ-034), cộng với trạng thái và dòng hoạt động mà công cụ Paseo trả về. Thiếu chân thứ nhất thì Manager chỉ biết agent còn sống hay không, chứ không biết nó đã làm gì — đây là khoảng trống mà lượt review ngày 2026-09-15 chỉ ra và REQ-034 lấp vào.
- Chi phí tăng theo số yêu cầu: mỗi yêu cầu ít nhất ba phiên (Manager đã có, cộng Worker, cộng Reviewer).

## Alternatives considered

| Phương án | Lý do loại |
|---|---|
| Manager là giao diện plugin cộng mã phía daemon | Rẻ hơn và dễ đoán hơn, nhưng người dùng phải nhập yêu cầu vào một ô riêng và không chat qua lại được; mọi việc làm rõ yêu cầu phải tự dựng lại. Trái thẳng với yêu cầu của owner |
| Manager là agent nhưng Worker là agent con bị che, chỉ nói chuyện qua Manager | Mất khả năng chat thẳng với Worker mà owner yêu cầu; và thực tế Paseo vẫn phơi agent con ra như agent hạng nhất nên che là tự làm khó |
| Không có Manager: người dùng tự tạo Worker từ profile | Mất hẳn phần quản lý và trả lời tiến độ; người dùng lại phải tự nhớ quy trình — đúng vấn đề sản phẩm này muốn xoá |
| Manager tự dọn Worker khi xong | Trái yêu cầu của owner, và xoá mất lịch sử làm việc mà người dùng có thể còn cần đọc lại |
