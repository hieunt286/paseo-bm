# Delta-change — Cách đo và ngưỡng M-10 (Manager là agent LLM)

| Trường | Giá trị |
|---|---|
| Mã | `plan-v2-delta-20260915-m10` |
| Plan gốc | [paseo-bm Implementation Plan bản 2](paseo-bm-implementation-plan-v2.md) (Active, Plan-ready PASS) — **không sửa tại chỗ** |
| Status | **Accepted, Applied** |
| Owner | hieu.nt10 |
| Created | 2026-09-15 |
| Accepted | 2026-09-15 — owner hieu.nt10 chọn (b), ngưỡng 60 giây |
| Applied | 2026-09-15 — vị trí 1–3 (PRD), 4–6 (checklist điều phối), 7 (plan) |
| Bead | `bm-l66` (chặn `bm-wp-117-9vy.2`) |
| Nguồn | [Biên bản nghiệm thu điều phối 2026-09-15](../operations/paseo-bm-orchestration-run-20260915.md) (commit `c047142`) |

Ghi chú quy ước: repo chưa có tài liệu delta nào; tài liệu này theo mẫu `change.md` của feature-workflow, đặt tên theo bead `bm-l66`.

## 1. Tóm tắt

PRD, plan WP-117 và checklist điều phối yêu cầu M-10 **≤ 5 giây từ lúc gửi yêu cầu tới lúc Worker xuất hiện**. Trên daemon thật cả năm fixture đo được 30,8–37,6 giây. Delta này đề xuất **giữ điểm đo là lúc Worker xuất hiện, đổi ngưỡng thành ≤ 60 giây** và ghi thêm, không chấm điểm, các mốc thời gian của Manager để lượt sau có dữ liệu.

## 2. Vấn đề và số đo

Lượt 2 ngày 2026-09-15, Manager và Worker `claude/claude-opus-5`, payload `3cf656d` (F-1: `29ab373`).

| Fixture | Gửi (UTC, tới giây) | Manager `lastUserMessageAt` | Worker `createdAt` | M-10 | Lời hỏi quyền của Manager trước `create_agent` |
|---|---|---|---|---|---|
| F-1 | 12:18:05 | 12:18:08.226 | 12:18:35.789 | **30,8 s** | 0 (Manager đang `bypassPermissions`) |
| F-2 | 12:29:27 | 12:29:29.888 | 12:30:04.552 | **37,6 s** | 1 (được duyệt trong app) |
| F-3 | 12:36:14 | 12:36:16.816 | 12:36:50.613 | **36,6 s** | 5 |
| F-4 | 12:43:03 | 12:43:05.928 | 12:43:40.432 | **37,4 s** | 4 |
| F-5 | 12:50:59 | 12:51:01.633 | 12:51:30.927 | **31,9 s** | 4 |

Lượt 1 của F-1 (trước khi `manager.md` được sắp lại để giao việc trước) mất khoảng **85 giây**.

Bằng chứng:
- `~/bm-acceptance/20260915/evidence-run2/F-n/m10-raw.txt`: mốc gửi, `lastUserMessageAt`, `createdAt`, các bước trước `create_agent`.
- `~/bm-acceptance/20260915/evidence-run2/F-n/permission-decisions.tsv`: thời điểm người chạy trả lời từng lời hỏi quyền.
- `~/bm-acceptance/20260915/evidence-run2/F-n/timeline-manager.txt`: thứ tự tin nhắn và tool call của Manager.
- Lượt 1 của F-1 nằm ở `~/bm-acceptance/20260915/evidence/F-1/`.

### Phản hồi đầu tiên của Manager (chưa đo được chính xác)

`timeline-manager.txt` **không có dấu thời gian** cho từng tin nhắn. Vì vậy **không có số đo** cho thời điểm Manager nhắc lại yêu cầu. Chỉ suy ra được các cận trên sau:

| Fixture | Tin nhắn nhắc lại có đứng trước tool call đầu tiên? | Cận trên, tính từ lúc gửi | Căn cứ |
|---|---|---|---|
| F-1 | Có | ≤ 23 s | Người chạy ghi đã thấy phần nhắc lại lúc 12:18:28Z |
| F-2 | Có | ≤ 26 s | Lời hỏi quyền đầu tiên của Manager được xử lý lúc 12:29:53Z |
| F-3 | Có | ≤ 12,5 s | Quyết định quyền đầu tiên lúc 12:36:26.502Z |
| F-4 | Có | ≤ 17,1 s | Quyết định quyền đầu tiên lúc 12:43:20.077Z |
| F-5 | **Không** | Tin nhắn trả lời đầu tiên xuất hiện **sau** khi Worker đã được tạo, tức muộn hơn 31,9 s | Timeline: `list_profiles`, `inspect_provider`, `create_agent` rồi mới tới văn bản |

Từ lúc gửi tới `lastUserMessageAt` của Manager đã mất khoảng 2,6–3,2 giây. Mốc gửi chỉ ghi tới giây nên con số này có sai số tới 1 giây.

## 3. Nguyên nhân gốc

Theo ADR-005 quyết định 1 và 3, Beads Manager là **một agent LLM**, và nó tạo Worker bằng công cụ `create_agent` của Paseo. Trước lời gọi đó, `plugin/roles/manager.md` bắt Manager làm lần lượt:
1. nhắc lại yêu cầu và đoán sơ bộ quy mô;
2. lấy giờ UTC để dựng `requestId`;
3. gọi `list_profiles` một lần;
4. gọi `inspect_provider` một lần;
5. soạn `create_agent` với prompt khởi tạo dài (nguyên văn yêu cầu, `requestId`, đường dẫn, quy mô sơ bộ, chỉ dẫn báo cáo).

Mỗi bước là một lượt model. Thời gian của từng chặng suy ra từ `permission-decisions.tsv`:

| Chặng | Thời gian quan sát | Ghi chú |
|---|---|---|
| Gửi → Manager nhận tin | 2,6–3,2 s | Có trước khi model bắt đầu chạy |
| Manager nhận tin → tool call đầu tiên được duyệt | 9,2 s (F-5), 9,7 s (F-3), 14,1 s (F-4) | Gồm phần nhắc lại và tìm công cụ |
| Tool call liền trước → `create_agent` được duyệt | 12,0 s (F-5), 12,1 s (F-4), 14,0 s (F-3) | Model soạn prompt khởi tạo; đây là chặng dài nhất |
| `create_agent` được duyệt → Worker `createdAt` | 0,06 s (F-3), 0,07 s (F-5), 0,25 s (F-4) | Phần của daemon không đáng kể |
| Mỗi lời hỏi quyền của Manager | tối đa khoảng 2 s | Chu kỳ poll của `kit/permit-runner.mjs` |

Kết luận:
- **Thời gian nằm ở các lượt model, không nằm ở daemon.** F-1 không có lời hỏi quyền nào mà vẫn mất 30,8 giây.
- Bead `bm-msy` cho Worker và Reviewer chạy ở chế độ không hỏi quyền. Nó không bỏ được lời hỏi quyền **của Manager**, cũng không bỏ được các lượt model của Manager. Dù có bỏ hết lời hỏi quyền, dữ liệu F-1 cho thấy M-10 vẫn khoảng 30 giây.
- Ngưỡng 5 giây không đạt được chừng nào Manager còn là agent LLM tự tạo Worker. Muốn đạt thì phải đổi kiến trúc, tức phương án (c).

## 4. Các phương án

### (a) Giữ 5 giây nhưng đo tới phản hồi đầu tiên của Manager; thêm một ngưỡng lỏng hơn cho lúc Worker xuất hiện

- **Ưu:** 5 giây gần với cảm nhận "được đáp ngay" của người dùng. Vẫn còn một ngưỡng chặn cho việc giao việc thật.
- **Nhược:**
  - **Chưa đo được.** Timeline Paseo không có dấu thời gian cho từng tin nhắn. Đo bằng mắt và đồng hồ bấm thì không lặp lại được.
  - Riêng khâu tin tới được Manager đã tốn 2,6–3,2 giây, nên model chỉ còn khoảng 2 giây để xuất chữ đầu tiên.
  - F-5 cho thấy Manager có thể **không** nhắc lại trước khi gọi công cụ. Muốn chắc thì phải sửa `manager.md`, mà sửa rồi cũng chỉ là lan can hành vi.
  - Cần một chỉ số mới hoặc tách M-10 làm hai. Tên và mã chỉ số do owner quyết; delta này không tự đặt.
- **Rủi ro:** cao. Không có số đo nào chứng minh 5 giây tới phản hồi đầu tiên là đạt được. Đổi sang ngưỡng này có thể lại trượt ở lượt chạy sau, lần này vì thiếu cách đo.

### (b) Giữ điểm đo là lúc Worker xuất hiện, đổi ngưỡng theo dữ liệu (đề xuất ≤ 60 giây)

- **Ưu:**
  - Đo đúng cam kết của REQ-021 (Worker thật sự cầm việc).
  - Cách đo hiện tại dùng lại nguyên vẹn (thời điểm gửi, `createdAt`), lặp lại được.
  - Không đổi kiến trúc hay phạm vi.
- **Nhược:**
  - 60 giây không còn là "tức thì". Trong khoảng đó người dùng dựa vào phần nhắc lại của Manager, và phần này chưa có ngưỡng.
  - Chỉ có 5 mẫu từ một cấu hình duy nhất (`claude-opus-5`); provider hay model khác có thể chậm hơn.
- **Rủi ro:** thấp tới vừa.
  - Lề giữa 37,6 giây (lớn nhất) và 60 giây khoảng 60%, đủ cho dao động của model và vài lời hỏi quyền.
  - Ngưỡng vẫn bắt được lỗi thật: lượt 1 của F-1 (85 giây, khi Manager chưa giao việc trước) sẽ **trượt**.
  - Có thể chọn 45 giây cho chặt hơn, nhưng lề chỉ còn khoảng 20%.

### (c) Đưa việc tạo Worker ra khỏi đường LLM: plugin server tạo Worker

- **Ưu:** thời gian tạo sẽ gần với phần của daemon, vốn đo được 0,06–0,25 giây. Có triển vọng giữ được 5 giây.
- **Nhược:**
  - **Đổi kiến trúc và phạm vi.** Trái ADR-005 quyết định 2 ("Plugin không thay Manager làm việc") và 3 ("Nhận yêu cầu là tạo Worker"), nên cần ADR mới thay thế.
  - Cần sửa Technical Design §2.6 và §9.2, thêm work package vào plan. Theo `change.md` thì đó là trường hợp "Delta + cập nhật design", có khi phải viết plan mới.
  - Chưa kiểm chứng Paseo 0.8 có hook nào cho plugin **bắt được tin nhắn người dùng gửi Manager** hay không. Delta này không giả định là có.
  - Quy mô sơ bộ và prompt khởi tạo do Manager soạn sẽ phải chuyển chỗ hoặc bỏ.
- **Rủi ro:** cao. Phạm vi lớn, phụ thuộc một khả năng chưa kiểm chứng, và lùi thời điểm phát hành Phase 1b.

## 5. Đề xuất

Chọn **(b)**: M-10 đo từ lúc gửi yêu cầu tới `createdAt` của Worker, ngưỡng **≤ 60 giây cho mọi fixture**. Kèm theo, **chỉ ghi nhận, không chấm điểm**:
- `lastUserMessageAt` của Manager;
- số lời hỏi quyền của Manager trước `create_agent`.

Lý do:
1. Đây là phương án duy nhất vừa có số đo chứng minh đạt được (5/5 dưới 38 giây), vừa giữ được cách đo lặp lại được.
2. Ngưỡng vẫn bắt được lỗi thật: Manager làm việc khác trước khi giao, như lượt 1 của F-1.
3. (a) chưa có cách đo tin cậy. (c) là thay đổi kiến trúc, không nên ôm vào để gỡ một chỉ số; nếu owner muốn "tức thì" thật sự thì nên mở một đề xuất riêng.
4. Phần ghi nhận thêm cho owner dữ liệu để quyết định có cần một ngưỡng riêng cho phản hồi đầu tiên trong một delta sau hay không.

## 6. Ảnh hưởng — các dòng sẽ đổi nếu được duyệt (phương án b)

Số dòng tính theo commit `c047142`.

| # | Tài liệu và vị trí | Hiện tại | Đề xuất |
|---|---|---|---|
| 1 | `docs/product/paseo-bm-prd.md` dòng 89 (§2, bảng chỉ số, M-10) | `\| M-10 \| Thời gian từ lúc người dùng giao yêu cầu tới lúc Beads Worker xuất hiện trong workspace \| ≤ 5 giây \| Đo trong demo và trong test với Paseo SDK giả lập \|` | `\| M-10 \| Thời gian từ lúc người dùng gửi yêu cầu cho Beads Manager tới lúc Beads Worker xuất hiện trong workspace (\`createdAt\` của Worker) \| ≤ 60 giây với mọi yêu cầu mẫu \| Đo trong nghiệm thu điều phối trên daemon thật theo checklist điều phối. Test với Paseo SDK giả lập không đo được thời gian suy luận của Manager (agent LLM, ADR-005) nên không dùng cho chỉ số này \|` |
| 2 | `docs/product/paseo-bm-prd.md` dòng 212 (REQ-021, ý e) | `(e) M-10: từ lúc giao tới lúc Worker xuất hiện ≤ 5 giây.` | `(e) M-10: từ lúc giao tới lúc Worker xuất hiện ≤ 60 giây.` |
| 3 | `docs/product/paseo-bm-prd.md` §11 Revision History (bảng bắt đầu ở dòng 322) | — | Thêm một dòng: `2026-MM-DD \| hieu.nt10 \| M-10 đổi ngưỡng từ ≤ 5 giây sang ≤ 60 giây và bỏ cách đo bằng SDK giả lập, theo delta plan-v2-delta-20260915-m10 (số đo 30,8–37,6 giây trên daemon thật)` |
| 4 | `docs/operations/paseo-bm-orchestration-checklist.md` dòng 84 (§4, hàng M-10) | `\| M-10 \| ≤ 5 giây từ lúc gửi yêu cầu tới lúc Worker xuất hiện \| Tất cả \| Ghi thời điểm gửi tin cho Manager (đồng hồ máy, UTC, tới giây). Đọc \`createdAt\` của Worker bằng công cụ đọc trạng thái agent của Paseo. Hiệu số là M-10 \| Thời điểm gửi, \`createdAt\` Worker, hiệu số \|` | `\| M-10 \| ≤ 60 giây từ lúc gửi yêu cầu tới lúc Worker xuất hiện \| Tất cả \| Ghi thời điểm gửi tin cho Manager (đồng hồ máy, UTC, tới giây). Đọc \`createdAt\` của Worker bằng công cụ đọc trạng thái agent của Paseo. Hiệu số là M-10. Ghi thêm, không chấm điểm: \`lastUserMessageAt\` của Manager và số lời hỏi quyền của Manager trước \`create_agent\` \| Thời điểm gửi, \`lastUserMessageAt\` Manager, \`createdAt\` Worker, hiệu số, số lời hỏi quyền \|` |
| 5 | `docs/operations/paseo-bm-orchestration-checklist.md` sau dòng 164 (§6, phiếu từng fixture) | `- Worker id / createdAt:                       → M-10 = … giây` (giữ nguyên) | Chèn thêm dòng: `- Manager lastUserMessageAt / số lời hỏi quyền của Manager trước create_agent:` |
| 6 | `docs/operations/paseo-bm-orchestration-checklist.md` dòng 196 (§8, hàng M-10) | `\| M-10 \| ≤ 5 giây (mọi fixture) \| \| \| \|` | `\| M-10 \| ≤ 60 giây (mọi fixture) \| \| \| \|` |
| 7 | `docs/plans/paseo-bm-implementation-plan-v2.md` §8 Revision History (chèn sau dòng tiêu đề bảng, dòng 334) | — | Thêm một dòng: `2026-MM-DD \| hieu.nt10 \| Áp dụng delta plan-v2-delta-20260915-m10: ngưỡng M-10 mà điều kiện ra của WP-117 dẫn chiếu đổi thành ≤ 60 giây theo PRD; nội dung WP không đổi` |

Các dòng có nhắc M-10 nhưng **không phải sửa chữ**, vì chúng chỉ dẫn chiếu tới ngưỡng trong PRD:
- Plan dòng 30 (`Chỉ số M-10 → M-18.`) và dòng 33 (`M-10 → M-18 đều đạt`).
- Plan dòng 217 (`Ghi lại số đo M-10 → M-16`), dòng 218 (`M-10 → M-18`) và dòng 233 (`**M-10 → M-18 phải ĐẠT ngưỡng**`).
- Design `docs/design/paseo-bm.md` dòng 498, §10 (`Đo **M-10 → M-18**, tất cả phải đạt`). Design không ghi con số của M-10 ở đâu cả.
- PRD dòng 289, Roadmap (`**bộ 5 yêu cầu mẫu đạt M-10 → M-14 trên một repo thật**`).

### Nếu owner chọn (a) thay cho (b)

Phải sửa cùng các vị trí 1–7. Ngoài ra còn:
- thêm một chỉ số cho phản hồi đầu tiên, với tên và mã do owner đặt;
- chỉ ra được cách đo lặp lại được, việc hiện chưa có;
- sửa `plugin/roles/manager.md` để bắt buộc gửi văn bản nhắc lại trước mọi tool call, kèm test nội dung.

### Nếu owner chọn (c)

Delta này không đủ. Cần một ADR thay thế ADR-005 quyết định 2 và 3, errata hoặc sửa đổi Technical Design §2.6 và §9.2, và đánh giá lại có phải viết plan mới hay không.

## 7. Những gì KHÔNG đổi

- REQ-021 (a)–(d), (f): Manager vẫn **giao ngay, không tự làm**. ADR-005 giữ nguyên.
- Thứ tự "giao việc trước" trong `plugin/roles/manager.md`. Không sửa role file nào trong delta này.
- M-11 → M-18, bộ fixture F-1 → F-5, các điều kiện ra khác của WP-117 (kịch bản phủ định, M-13, Q-028, chi phí).
- NFR hiệu năng của PRD (`lệnh kiểm tra ≤ 5 giây`, tức độ trễ `doctor`). Đây là con số khác, không liên quan M-10.
- Phạm vi của `bm-msy` (chế độ quyền của Worker và Reviewer).
- Biên bản `docs/operations/paseo-bm-orchestration-run-20260915.md` giữ nguyên kết luận M-10 "Không" như lịch sử. Lượt chạy lại ghi vào biên bản mới.
- Nội dung plan v2, design và ADR: không sửa ngoài dòng Revision History ở mục 7 của §6.

## 8. Câu hỏi mở cho owner

1. Chọn ngưỡng **60 giây** hay chặt hơn (ví dụ 45 giây, lề khoảng 20%)?
2. Trong nghiệm thu, Manager chạy ở chế độ nào? Nếu người thật duyệt quyền thì thời gian chờ duyệt nằm trọn trong M-10.
   - Có giữ quy tắc người chạy tự trả lời lời hỏi quyền như lượt 2 không?
   - Hay cho Manager chạy chế độ không hỏi quyền? `bm-msy` không phủ phần này.
3. Đổi ngưỡng một chỉ số trong PRD đang Accepted: chỉ cần owner duyệt kèm dòng Revision History, hay phải chuyển PRD về Review và chạy lại phần chỉ số của `prd-ready`?
4. Có muốn một ngưỡng riêng cho phản hồi đầu tiên của Manager sau khi có dữ liệu ghi nhận ở lượt chạy lại (một delta sau) không?

## 9. Duyệt

- [x] Owner chọn phương án **(b)**, ngưỡng **60 giây**
- [x] Câu hỏi mở 2: trong nghiệm thu chạy lại, **Manager cũng chạy chế độ không hỏi quyền** (người chạy đặt mode cho Manager trước khi gửi yêu cầu). Câu hỏi mở 3: **owner duyệt kèm dòng Revision History**, PRD giữ Accepted
- Approved-by: hieu.nt10 (trả lời trong phiên làm việc với Claude), ngày 2026-09-15

Sau khi duyệt:
1. Sửa các vị trí 1–7 ở §6.
2. Đổi Status của tài liệu này thành Accepted, rồi Applied.
3. Đóng `bm-l66` kèm bằng chứng.
4. Chạy lại nghiệm thu dưới `bm-wp-117-9vy.2`.

## 10. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Tạo bản Draft từ biên bản nghiệm thu điều phối 2026-09-15 |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Owner duyệt (b) 60 giây; áp dụng vị trí 1–3 (PRD) và 7 (plan); vị trí 4–6 (checklist) áp dụng cùng `bm-bdk` |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Áp dụng vị trí 4–6 vào checklist điều phối; ghi chế độ Manager khi nghiệm thu vào checklist mục 2 và runbook bước 2 |
