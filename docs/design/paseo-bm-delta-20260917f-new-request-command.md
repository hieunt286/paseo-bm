# Delta-change — `/bm-worker-new` phải mở việc mới, và Manager không được thay thế lượt Worker đang chạy

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260917f-new-request-command` |
| Tài liệu gốc | [delta 20260917e](./paseo-bm-delta-20260917e-manager-screen-and-commands.md) §4.4; [Technical Design](./paseo-bm.md) §9.x; `plugin/roles/manager.md` bước 2 |
| Status | **Accepted** — owner báo lỗi và chốt Q29–Q30 ngày 2026-09-17 |
| Routing | Brownfield, mức **Vừa**: một file vai trò, một lệnh client, một chỗ ghi của bộ gom. Không đụng lược đồ kho, không đụng đường tạo agent |

## 1. Owner báo gì

> Tôi thử nghiệm lệnh bm-worker-create, nhưng nó lại làm hành động chỉ ném vào agent Worker đang làm, và như vậy khiến cho mục đích làm của tôi từ nhanh lại thành bị chậm.

Tên lệnh thật là `/bm-worker-new`; `/bm-worker-create` không tồn tại. Nhưng lời phàn nàn đúng và không phụ thuộc vào tên.

## 2. Hai lỗi, đo trên workspace `paseo-bm-site` của owner

| # | Lỗi | Bản chất |
|---|---|---|
| A | `/bm-worker-new` gửi lời người dùng cho Manager như một tin nhắn thường, **không mang tín hiệu nào** nói đây là việc mới. `manager.md` bước 2 quy định "việc nối tiếp của một request đã có thì gửi cho Worker đó", nên khi workspace đang có request sống thì **mọi** tin nhắn đều thành nối tiếp | **Lệnh không làm điều tên nó hứa.** delta 20260917e §4.4 viết lệnh "gửi `args` cho Manager" và dừng ở đó, không hề nói làm sao Manager biết đây là request mới |
| B | Manager chuyển tiếp vào Worker **đang chạy**, mà `send()` lên agent đang chạy **thay thế lượt hiện tại** | **Kiến thức đã có nhưng đặt sai chỗ.** Chính `manager.md` viết đúng câu này ở mục `BM-BUDGET` — *"đừng gửi gì cho Worker — nó đang làm, một tin nhắn sẽ thay thế lượt nó đang ở trong"* — nhưng đường chuyển tiếp ở bước 2 không có cảnh báo đó |

**Bằng chứng.** Worker `b334d30e` nhận 8 tin nhắn vào, tất cả mang tiền tố `Continue req-20260917T065802Z.`: mọi việc bị dồn vào một request và một Worker chạy tuần tự. Kho vết cho thấy Worker đó có 18 lượt, trong đó **1 lượt kết thúc `canceled`** — phần việc dở bị vứt.

## 3. Quyết định của owner

| # | Câu hỏi | Chốt |
|---|---|---|
| Q29 | Nhắn tiếp khi Worker đang chạy | **Đợi Worker xong rồi mới gửi.** Không ngắt, không vứt việc dở |
| Q30 | Số Worker song song | **Không giới hạn, nhưng Manager phải nói đang có mấy Worker chạy** |

## 4. Sửa

### 4.1 Lệnh nói rõ "đây là việc mới"

`/bm-worker-new` gửi cho Manager một tin nhắn mà **dòng đầu** là `BM-NEW-REQUEST`, các dòng sau là lời người dùng nguyên văn.

`manager.md` thêm một luật: tin nhắn có dòng đầu là `BM-NEW-REQUEST` **luôn luôn** là request mới — cấp `requestId` mới, tạo **Worker mới**, kể cả khi đang có Worker khác chạy, và **không bao giờ** chuyển nó cho Worker đã có. Yêu cầu của người dùng là toàn bộ phần sau dòng đầu. Khi xác nhận, Manager nói rõ đang có mấy Worker chạy song song (Q30).

**Vì sao không dùng `isPluginNotice`.** Hàm đó khớp theo tiền tố và khiến bộ gom ghi tin nhắn là `origin: "agent"`. Nếu thêm `BM-NEW-REQUEST` vào danh sách ấy thì **Dashboard sẽ mất luôn lời yêu cầu** — vì `firstUserText` bỏ qua mọi thông báo của plugin. Đây là tin nhắn **của người dùng**, chỉ mang thêm một dòng cờ. Nên bộ gom **cắt bỏ dòng cờ** khi ghi và giữ nguyên `origin: "user"`.

### 4.2 Không thay thế lượt của Worker đang chạy

`manager.md` bước 2 thêm: trước khi chuyển tiếp, đọc trạng thái Worker. Nếu nó `running` thì **chưa gửi** — nói cho người dùng biết lời của họ đang được giữ, và gửi khi Paseo đánh thức Manager lúc Worker kết thúc lượt (`notifyOnFinish` mặc định bật, nên Manager luôn được đánh thức).

Luật này **không** áp cho `BM-NEW-REQUEST`: việc mới không đi vào Worker cũ nên không có gì để chờ.

## 5. Không đổi

Hợp đồng RPC; lược đồ kho vết; `agents.stop-all`; ngân sách review (vẫn theo `requestId`, nên nhiều request song song thì mỗi request có ngân sách riêng — đúng, vì chúng là việc khác nhau); quyết định Q24 (lệnh vẫn đi qua Manager, plugin vẫn không tự tạo Worker).

## 6. Kiểm thử

| Kết quả | Test | Đối chứng âm |
|---|---|---|
| 4.1 lệnh | `/bm-worker-new "x"` gửi tin nhắn có dòng đầu `BM-NEW-REQUEST` và dòng sau là đúng `x`; args rỗng vẫn không gửi gì | Bỏ dòng cờ → đỏ |
| 4.1 bộ gom | Tin nhắn có cờ được ghi **không còn dòng cờ**, `origin` vẫn `user`; `isPluginNotice` trả `false` cho nó | Thêm cờ vào `isPluginNotice` → test "Dashboard vẫn thấy lời yêu cầu" đỏ |
| 4.1 vai trò | `manager.md` nói cờ này luôn là request mới, tạo Worker mới, không chuyển cho Worker cũ, và báo số Worker đang chạy | Xoá câu → đỏ |
| 4.2 vai trò | `manager.md` nói không gửi vào Worker `running`, giữ lại và gửi khi Worker kết thúc lượt | Xoá câu → đỏ |

## 7. Rủi ro

1. **Nhiều Worker song song trên cùng một repo có thể giẫm chân nhau** — hai Worker sửa cùng file. Delta này **không** giải quyết; owner chốt không giới hạn và nhận cảnh báo. Ghi lại để lần sau cân nhắc khoá theo file hoặc theo bead.
2. **Manager phải nhớ lời đang giữ qua nhiều lượt.** Nếu nó quên, lời người dùng biến mất — tệ hơn là bị gửi muộn. Câu chữ phải nói rõ: nhắc lại cho người dùng biết đang giữ gì.
