# ADR-011 — Manager tự điều phối Worker trong phạm vi người dùng đã quyết

| Trường | Giá trị |
|---|---|
| Status | Accepted |
| Date | 2026-09-25 |
| Owner | hieu.nt10 |
| Liên quan | [PRD REQ-021, REQ-025, REQ-026](../product/paseo-bm-prd.md#6-functional-requirements) · [ADR-005](ADR-005-manager-as-agent.md) (mở rộng quyết định 3 và 5) · [Technical Design §10](../design/paseo-bm.md) · `plugin/roles/manager.md` |
| Quyết định của chủ repo | 2026-09-25: Q1 (c), Q2 (a) của `req-20260925T051841Z` |

## Context

Manager là agent duy nhất nhìn thấy toàn bộ Worker của một workspace, và nó đã được phép đọc trạng thái lẫn dòng hoạt động của chúng (quyết định chủ repo P2-3, 2026-09-24). Nhưng nó không được phép **làm gì** với những thứ nó thấy ngoài việc kể lại cho người dùng.

Ngày 2026-09-25 chuyện đó thành lỗi thật. Người dùng chốt `B7 a` cho Worker B (`req-20260925T045037Z`): tạm hoãn tới khi Worker A xong và đã commit. Worker B gửi báo cáo `finished` ở trạng thái tạm hoãn rồi nghỉ. Worker A (`req-20260925T033834Z`) làm xong bản phát hành 0.3.0 và gửi báo cáo `finished`. Manager **đọc được** báo cáo đó, nói đúng rằng điều kiện đã đủ — rồi vẫn nhắn "bạn nhắn một câu là tôi đánh thức nó" và đứng chờ người dùng gõ "Chạy tiếp đi". Người dùng trở thành đường truyền cho một sự thật Manager đã nắm trong tay.

Nguyên nhân nằm trong chính chỉ dẫn vai trò, không phải ở dữ kiện: luật 2 (`YOU ARE A RELAY, NOT A DECIDER`) được đọc thành "không bao giờ gửi cho Worker thứ người dùng chưa gõ", và phần "Talking to the user" bảo để một Worker đã `finished` ở trạng thái nghỉ. Manager thiếu quyền, không thiếu thông tin.

## Decision

1. **Manager là người điều phối, không chỉ là đường truyền.** Nó được tự nhắn cho Worker để tiếp tục công việc: đánh thức một Worker đang chờ, và sắp thứ tự các Worker chạm cùng file, bead hay lịch sử git — kể cả khi người dùng chưa nêu điều kiện nào.
2. **Chỉ hành động trên thứ đã kiểm chứng.** Điều kiện phải được thấy bằng một nguồn đọc được: báo cáo của Worker khác, `get_agent_status`, `git`, hay `br`. Suy đoán, hay "chắc là xong rồi", không phải căn cứ.
3. **Sự thật thì tự trả lời, quyết định thì hỏi.** Một câu hỏi của Worker chỉ hỏi một sự thật Manager đọc được thì Manager tự trả lời (khối `BM-ANSWERS`, kèm nguồn). Phạm vi, cách làm, đánh đổi, việc người dùng phải tự làm, và mọi thứ ở REQ-026 (d) vẫn chuyển cho người dùng — Manager không bao giờ chọn thay.
4. **Giao việc vẫn ngay lập tức.** Điều phối chỉ áp cho việc đánh thức và tiếp tục; nó không hoãn việc tạo Worker (REQ-021, chỉ số M-10 ≤ 60 giây giữ nguyên). Giữ một Worker lại nghĩa là **nói cho nó biết ngay lúc tạo** rằng nó chờ ai và chờ điều gì — không phải giữ yêu cầu lại; trong lúc chờ nó tự quyết làm được gì.
5. **Nói trước và nói sau.** Thấy một Worker sẽ phải chờ thì Manager báo ngay rằng chính nó sẽ đánh thức và theo điều kiện nào — không bao giờ "bạn nhắn một câu rồi tôi làm". Gửi xong thì một dòng: đã thấy gì, đã gửi gì. Người dùng lật lại được mọi lần đánh thức.
6. **Không đổi phần còn lại.** Manager vẫn không tự làm việc (ADR-005 quyết định 3), không lưu trữ hay xoá agent, không duyệt quyền thay người dùng, không thêm yêu cầu của riêng nó vào lời người dùng, và không gửi vào lượt một Worker đang chạy.

**Chỗ ghi luật, và ngân sách của nó.** Quyền mới nằm trong `plugin/roles/manager.md` và chỉ ở đó. Khối `## RULES` của tệp đó giữ nguyên ngân sách đang có — đúng 5 giới hạn đánh số, tối đa 30 dòng: phần thuộc về luật là **một câu** trong luật 2 (thứ Manager đã đọc được về tình trạng công việc thì nó gửi được, kèm nguồn), mua bằng cách siết chính lời luật 2; cách làm nằm ở một mục riêng bên dưới. Ngân sách ấy là thứ giữ cho phần đầu tệp còn đọc được ở lượt thứ mười; thêm một quyền không phải lý do để nới nó. Chỉ dẫn của Worker cũng phải nhận được khối `BM-ANSWERS` do Manager viết: một mục `other` nay có thể là lời người dùng **hoặc** một sự thật Manager đã kiểm chứng kèm nguồn, và thứ đọc ra như phạm vi hay cách làm thì Worker hỏi lại dưới số mới thay vì coi là quyết định của người dùng.

## Consequences

**Tích cực**
- Người dùng thôi làm đường truyền cho những sự thật Manager đã nắm; đúng tình huống 2026-09-25 nay chạy hết mà không cần họ gõ gì.
- Nhiều Worker trong một workspace có người giữ thứ tự. Chúng dùng chung một working tree và một kho bead, nên thứ tự là việc có thật, và Manager là chỗ duy nhất nhìn thấy đủ để giữ.
- Quyền quyết định nội dung công việc không dịch chuyển: ranh giới mới nằm giữa **sự thật** và **quyết định**, không phải giữa Manager và Worker.

**Tiêu cực / phải chấp nhận**
- Manager có thể đánh thức nhầm vì đọc sai một báo cáo hay một dòng `git log`. Giảm thiểu bằng ba ràng buộc: phải có bằng chứng đọc được, phải nói cho người dùng ngay sau khi gửi, và không chắc thì hỏi.
- Manager tốn thêm lượt đọc trạng thái, nên tốn thêm token cho mỗi yêu cầu có nhiều Worker.
- Đây là lan can hành vi trong chỉ dẫn, không phải mã: không có lớp chặn nào của Paseo ngăn Manager gửi một câu nó không nên gửi (REQ-026 c).
- Một Worker được đánh thức bằng lời của Manager chứ không phải lời người dùng, nên dòng lịch sử chat của Worker không còn chỉ toàn lời người dùng. Manager phải ghi rõ nguồn trong chính câu nó gửi.

## Alternatives considered

- **Giữ nguyên đường truyền tuyệt đối.** Đơn giản và dễ kiểm, nhưng đó chính là lỗi người dùng báo: sản phẩm bắt họ gõ lại điều máy đã biết.
- **Chỉ thi hành điều kiện người dùng đã nêu** (Q1 a của yêu cầu này). Đủ cho tình huống 2026-09-25 và ít rủi ro hơn, nhưng vẫn để Manager đứng yên khi hai Worker va nhau mà người dùng chưa kịp nghĩ tới. Chủ repo chọn (c).
- **Plugin tự đánh thức bằng mã** (một hook đếm điều kiện rồi gửi hộ). Xác định hơn, nhưng trái ADR-005 quyết định 2: plugin không đoán ý người dùng, phần suy luận thuộc về agent.
