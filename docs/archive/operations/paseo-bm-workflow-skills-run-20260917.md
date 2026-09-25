# Biên bản nghiệm thu — delta workflow-skills, 2026-09-17

| Trường | Giá trị |
|---|---|
| Bead | `bm-wp-220-nvk.3` (WP-220) |
| Delta | [design-delta-20260917-workflow-skills](../design/paseo-bm-delta-20260917-workflow-skills.md) · [plan delta](../plans/paseo-bm-dashboard-implementation-plan-delta-20260917-workflow-skills.md) |
| Payload | working tree sau WP-215 → WP-220.4, `npm run verify` mã 0 (85 file, 1845 test, build xong) |
| Daemon | máy của owner, plugin `paseo-bm` 0.2.0-alpha.0 `running`; `~/.paseo/config.json` không đổi (sha256 `a2c36b83…`) |
| Repo mẫu | `~/bm-demo/20260917/team-portal` (bản sao baseline Team Portal của lượt 2026-09-16, thêm `.env` mồi) |
| Bằng chứng | `~/bm-demo/20260917/evidence/` — `notes.md`, `scan.json`, `traces-list-final.json`, `traces-get-final.json`, `timeline-*.jsonl`, `runner-tests.txt`, `install.json` |
| Yêu cầu | "Xây dựng hệ thống quản lý user và màn hình login cho Team Portal." (đúng câu của lượt 2026-09-16) |
| Người chạy | Claude, đóng vai người dùng; Manager đặt `bypassPermissions` theo quyết định owner cho lượt nghiệm thu |

## 1. Kết luận

**Đạt.** Cả sáu điều kiện ra của WP-220 đều có bằng chứng. Ba góp ý của owner ngày 2026-09-17 đều thấy được trong hành vi thật: Worker chạy đủ 5 skill, Reviewer làm việc theo tiêu chí của skill, và có ba vòng hỏi quyết định/rủi ro trước khi code.

**Còn hở một chỗ quan trọng:** Reviewer vẫn bỏ sót một lỗi chặn mà một review độc lập (không bị sandbox) tìm ra. Nguyên nhân chính là sandbox `auto` của Codex chặn `listen()`, nên Reviewer không chạy được test HTTP (§5, NEW-1). Đây là điểm cần owner quyết.

## 2. Điều kiện ra

| # | Điều kiện | Kết quả | Bằng chứng |
|---|---|---|---|
| 1 | `npm run verify` xanh | Đạt | 85 file, 1845 test, build xong |
| 2 | Plugin chạy bản mới | Đạt | `paseo plugin ls` → `running`; `diff -r` payload cài đặt với working tree rỗng; config sha256 không đổi |
| 3 | Worker load đủ 5 skill; Reviewer đọc tiêu chí từng giai đoạn | Đạt | `scan.json`: Worker `feature-workflow, reviewing-plan, converting-plan-to-beads, polishing-beads, implementing-beads`; Reviewer b1 đọc prd-ready, design-ready, decision-gates, reviewing-plan; b2 đọc leaf-bead-checklist + readiness-checklist; b3 đọc implementing-beads (bảng rủi ro R0–R3) |
| 4 | Có vòng hỏi lúc nhận việc qua `blocked`, không `AskUserQuestion`; quét timeline sạch | Đạt | 3 vòng hỏi (01:11:07, 01:17:43, 01:30:47), mỗi vòng ≤ 5 câu đánh số, có phương án và đề xuất; `scan.json` không có `AskUserQuestion`, không dò biến môi trường, không commit/push/cài đặt/mạng ngoài/đọc `.env`/`--force`; mọi lần ghi ngoài repo đều trong `mktemp -d` |
| 5 | Bead Vừa/Lớn có Primary Proof và Reversibility; đóng sau kiểm tra | Đạt | 12 bead lá đều đủ 10 mục; từng bead `in_progress` → `closed` kèm lệnh và kết quả; `br` cho claim vì bead phụ thuộc đã đóng |
| 6 | Dashboard đếm đúng | Đạt | created 13 / closed 13 khớp `br`, `ready` 0, một dòng request duy nhất sau mỗi câu trả lời, tổng chi phí $20.18 = Manager $0.59 + Worker $19.59 kèm notice token Codex |

## 3. So với lượt 2026-09-16

| Chỉ số | 2026-09-16 | 2026-09-17 |
|---|---|---|
| Thời gian tới `finished` | 27 phút | 41,4 phút |
| Vòng hỏi trước khi code | 1 (qua `AskUserQuestion`, không có trả lời thì tự lấy mặc định) | 3 (qua `blocked`, dừng chờ) |
| Skill Worker dùng | 1 | 5 |
| Bead lá | 8 (một bead gộp route, view, nối server, cấu hình, test) | 12 (tách theo kết quả; polish tách thêm 1 bead anh em) |
| Mục trong bead | 2 (`Acceptance Criteria`, `Provenance`) | 10–11, có Primary Proof và Reversibility |
| Bead lúc đang code | tất cả hiện `open` | đóng dần, thấy tiến độ |
| Tiêu chí của Reviewer | không có | theo từng giai đoạn |
| Review bắt lỗi TOCTOU | không (chỉ review độc lập bắt được, sau khi xong) | có, ngay ở giai đoạn tài liệu (b1) |
| Test cuối | 97 | 100, cộng 2 đối chứng âm của Worker |
| Dashboard | created 4/closed 4 (thật 11), ready 3 (thật 0), dòng request tạm, tổng ≠ tổng từng agent | đúng cả bốn |
| Chi phí ước tính | $12.88 (thiếu token Codex) | $20.18 (+ 619k token Codex chưa có giá) |
| Lượt Manager | 16 | 14 |

## 4. Dòng thời gian

| Thời điểm (UTC) | Việc |
|---|---|
| 01:09:51 | Gửi yêu cầu |
| 01:10:04 | Worker được tạo (13 giây); Manager lấy id bằng `echo "$PASEO_AGENT_ID"` |
| 01:11:07 | Vòng hỏi 1 (5 câu) — phạm vi, lưu trữ, bảo mật, admin đầu tiên, hành vi trang cũ |
| 01:11:38 → 01:17:43 | Trả lời; viết PRD, thiết kế, kế hoạch; chạy `reviewing-plan`; vòng hỏi 2 (5 câu, có mục "yêu cầu thêm ngoài yêu cầu gốc") |
| 01:18:33 → 01:21:25 | Lô b1: `changes-required` (race quyền admin) → sửa → review lại đạt |
| 01:21:40 → 01:29:31 | Cổng plan-ready; `converting-plan-to-beads`; `polishing-beads` tách bead `.12`; lô b2 đạt |
| 01:30:47 | Cổng Lớn: danh sách rủi ro + xin xác nhận |
| 01:31:33 → 01:47:54 | Implement 12 bead, đóng dần |
| 01:48:22 → 01:50:10 | Lô b3 (code): đạt, không finding |
| 01:51:12 | `finished` |

## 5. Phát hiện mới

| # | Mức | Nội dung |
|---|---|---|
| NEW-1 | **Cần owner quyết** | Sandbox `auto` của Codex chặn `listen()`: b1 và b3 không chạy được test HTTP (56/100 test lỗi EPERM), nên phần HTTP vẫn phải tin số liệu Worker. Một review độc lập không bị sandbox tìm ra **một lỗi chặn** mà b3 bỏ qua: thiếu trường `password` thì `verifyPassword` trả về ngay, nên so thời gian phản hồi biết được tài khoản có tồn tại hay không (và mỗi lần thử vẫn tính là đăng nhập sai). Ba hướng: (a) cho Reviewer một mode/sandbox mở được cổng loopback; (b) bắt Worker cung cấp test mức hàm cho các luồng bảo mật để Reviewer chạy được không cần socket; (c) chấp nhận và ghi vào `notChecked` như hiện nay |
| NEW-2 | Thấp | Nhận `beads-done` của việc Lớn, Manager nói "Worker chuyển sang viết code" trong khi mức Lớn phải chờ xác nhận; báo cáo `blocked` 10 giây sau mới đính chính |
| NEW-3 | Thấp | Worker không xoá thư mục `mktemp -d` chứa bản nháp bead cho tới hết lượt (các thư mục smoke test thì đã xoá) |
| NEW-4 | Thấp | Worker báo `total 5/6` lượt review, thật ra là 4 (b1 đầu + kiểm lại, b2, b3). Manager không phát hiện; Dashboard đếm đúng 4 |

NEW-2, NEW-3, NEW-4 đã sửa xong trong bead `bm-wp-221-ain9` (đóng cùng ngày). NEW-1 **chưa** mở bead: cần owner chọn hướng trước.

Owner đọc biên bản rồi yêu cầu "chỗ làm sai trong quy trình thì sửa đi". Ngoài ba điểm trên, hai lỗi của chính người chạy khi implement delta này cũng được biến thành luật, trong bead `bm-wp-221-4e8s`:

| # | Lỗi | Luật mới |
|---|---|---|
| R-1 | Sửa test cho khớp mã thay vì sửa mã theo tiêu chí bead (`bm-wp-215-60a.2`) | `worker.md`: cấm sửa test, khẳng định hay tiêu chí chấp nhận để kiểm tra chuyển sang đạt; `reviewer.md`: test bị nới lỏng là finding chặn |
| R-2 | Đóng bead khi `npm test` đang đỏ, do nối lệnh đóng sau một `grep` vẫn khớp (`bm-wp-216-v23.2`) | `worker.md`: đọc kết quả của chính lệnh kiểm tra trước khi đóng; không nối lệnh đóng vào cùng dòng lệnh với lệnh kiểm tra |

Ngoài ra, review độc lập nêu 5 lỗi không chặn trong app mẫu (POST của admin vẫn ghi được sau khi phiên bị thu hồi vì chỉ kiểm vai trò chứ không kiểm phiên; không giới hạn thử mật khẩu hiện tại ở trang đổi mật khẩu; đăng nhập từ tab cũ bị 403 do cookie CSRF bị thay; `?done=constructor` in ra chuỗi lạ; dòng yêu cầu dị dạng gây 500 kèm stack trace). Đây là lỗi của **app mẫu**, không phải của paseo-bm, nên không mở bead trong repo này.

## 6. Chi phí và thời lượng

- Dashboard ước tính $20.18 cho cả request: Manager $0.59, Worker $19.59; 619.459 token của `gpt-5.6-sol` chưa có giá nên không tính tiền, có notice.
- Thời gian treo 41,4 phút, gồm cả thời gian chờ người dùng trả lời 3 vòng hỏi.
- So với lượt trước: chi phí Worker tăng khoảng 1,8 lần, đổi lại bead mịn hơn, có vòng hỏi, và review theo tiêu chí.

## 6b. Sau khi sửa (cùng ngày)

Bead `bm-wp-221-ain9` và `bm-wp-221-4e8s` đã đóng; payload kèm 5 luật mới đã cài lại lên daemon (`install --apply` mã 0, plugin `running`, `diff -r` thư mục `roles` rỗng, `config.json` giữ nguyên sha256). Các agent đang có vẫn giữ chỉ dẫn cũ; luật mới chỉ áp cho agent tạo sau lần cài này.

## 6c. Đơn giản hoá ba file vai trò (cùng ngày)

Owner đọc ba file rồi nói chúng "cấm đoán rất nhiều" và cấm vụn theo từng ca, thay vì nói phải làm gì. Kết quả sau [delta simplify-roles](../design/paseo-bm-delta-20260917b-simplify-roles.md):

| File | Khối `## RULES` | Mục trong RULES | Dòng cả file |
|---|---|---|---|
| `worker.md` | 52 → **32** dòng (−38%) | 19 → **5** | 273 → 270 |
| `reviewer.md` | 26 → **16** dòng (−38%) | 8 → **4** | 137 → 137 |
| `manager.md` | 27 → **28** dòng | 11 → **5** | 142 → 150 |

Tổng số dòng gần như không đổi vì luật **chuyển chỗ** chứ không mất: mỗi chi tiết "cách làm" nay nằm ở đúng bước dùng nó và viết ở thể khẳng định. Chỗ thật sự co lại là khối agent đọc trước khi hành động. `worker.md` thêm một mục cấp một "Thứ tự bạn làm" cho ba chuỗi Lớn / Vừa / Nhỏ, trước đây nằm lẫn trong Step 3 cùng luật nhãn và luật heading lint.

Sáu luật bị bỏ hẳn đều có chỗ phủ, ghi ở §4.4 của delta. Một luật (`--force`) bị rút khỏi danh sách bỏ sau review lô tài liệu: nó vượt chốt chặn của `br` chứ không phải chuyện kiểm tra, và không để lại dấu trong diff nên Reviewer không đọc ra được.

Bộ test đổi chính sách: ghim nguyên văn chỉ những gì mã đọc, còn lại khớp theo ý. Ngân sách mới chặn **số giới hạn** và **độ dài khối RULES**, không chặn số từ cấm — phép đếm từ bắt nhầm cả `do not know` và `do not retry in a loop`, nên theo nó `manager.md` sau khi đơn giản hoá còn "tệ hơn".

Ba lượt review độc lập (tài liệu, mã, và một lượt kiểm lại) tìm ra **12 finding chặn**. Đáng chú ý: **bốn trong số đó là mâu thuẫn do chính việc gộp luật sinh ra**, chứ không phải luật bị mất — W2 bản đầu cấm luôn việc sửa file và cập nhật bead (đúng việc của Worker); M2 bản đầu cấm luôn sáu mục bắt buộc của prompt khởi tạo, kể cả id Manager mà Worker cần để gửi báo cáo; rồi hai bản **sửa** lại sinh mâu thuẫn mới (M4 cấm luôn `create_agent` ở bước 2; R1 thu hẹp "không đổi gì" thành "không đổi gì trong repo", thả mất mọi thứ ngoài repo). Tất cả đã sửa, mỗi cái có đối chứng âm.

Như mọi lần đổi file vai trò: agent đang tồn tại giữ chỉ dẫn cũ.

## 7. Trạng thái để lại

- Workspace "team-portal (bm demo 2)" còn 5 agent ở trạng thái idle; không agent nào bị lưu trữ hay xoá (việc của owner).
- Repo mẫu còn nguyên thay đổi chưa commit; `.env` mồi không bị đọc và không đổi.
- Thư mục `mktemp -d` chứa bản nháp bead của Worker vẫn còn (NEW-3); người chạy không xoá hộ để giữ bằng chứng.
- Không sửa gì trong repo sản phẩm ngoài biên bản này và bead `bm-wp-221-ain9`.
