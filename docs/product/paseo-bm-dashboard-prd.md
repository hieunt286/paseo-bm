# paseo-bm — Dashboard điều phối (PRD tính năng)

| Trường | Giá trị |
|---|---|
| Status | **Accepted** (2026-09-16, bản 4) |
| Accepted | 2026-09-16 — owner hieu.nt10; cổng `prd-ready` PASS |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Created | 2026-09-16 |
| PRD gốc | [paseo-bm PRD](./paseo-bm-prd.md) — Accepted; tính năng này nằm trong **Phase 2** của [§9 Roadmap](./paseo-bm-prd.md#9-roadmap) |
| Technical Design | [paseo-bm — Dashboard điều phối](../design/paseo-bm-dashboard.md) (Draft, chưa qua `design-ready`) |
| ADR | [ADR-007](../adr/ADR-007-dashboard-trace-store.md) — lưu vết trace trong thư mục cài đặt, người dùng xoá được (Proposed) |
| Routing decision | [§0](#0-routing-decision) (canonical owner của tính năng này; PRD gốc [§0](./paseo-bm-prd.md#0-routing-decision) là quyết định mẹ) |
| Requirement mẹ được hiện thực | REQ-030 (lịch sử phiên làm việc) và phần "bảng theo dõi và báo cáo tiến độ bead trong Paseo" của Phase 2 |

> **Vì sao là một PRD riêng, không sửa PRD gốc:** PRD gốc đang `Accepted` và theo quy ước repo (AGENTS.md) không được thêm phạm vi vào tài liệu đã đóng băng. Tính năng này có journey và chỉ số riêng (quan sát, không điều phối) nên đi theo đường "new PRD" của variant brownfield, liên kết ngược về PRD gốc thay vì sao chép nội dung.

## 0. Routing Decision

- Variant preset: brownfield (mở rộng một plugin đang chạy)
- Triggered risks:
  - **Hợp đồng công khai mới:** năm RPC plugin mới (`traces.list`, `traces.get`, `traces.delete`, `traces.reassign`, `beads.stats`) và các mã lỗi kèm theo → Technical Design + `design-ready`
  - **Hợp đồng đang tiêu thụ trở thành công khai:** khối `BM-REPORT` trong `roles/*.md` vốn chỉ dành cho Manager đọc, nay bị một giao diện phân tích. Đổi định dạng block sẽ làm hỏng Dashboard → cần cam kết tương thích ngược hai chiều
  - **Lược đồ dữ liệu mới và ranh giới ghi mới (owner chốt Q-030):** plugin **ghi** một kho lưu vết lên đĩa, có phiên bản lược đồ, và có lệnh xoá. Đây là lần đầu payload plugin ghi file, và là dữ liệu chứa nguyên văn hội thoại → Technical Design + `design-ready` + **ADR-007** + kế hoạch xoá/di trú
  - **Ranh giới đọc dữ liệu mới:** plugin server đọc `.beads/issues.jsonl` trong repo của người dùng và đọc timeline của các agent
  - **Quyền riêng tư:** nội dung hội thoại agent nay **nằm trên đĩa** chứ không chỉ trong bộ nhớ → quyền file, che bí mật trước khi ghi, và quyền xoá thuộc người dùng
  - **Ảnh hưởng tới tài liệu đã đóng băng:** kho lưu vết nằm trong thư mục cài đặt nên chạm vào bố cục (design gốc §3.1), phân loại quyền sở hữu (§3.3) và phạm vi lệnh gỡ (PRD gốc REQ-012) → **phải có một delta-change** cho PRD gốc và design gốc; tuyệt đối không sửa tại chỗ
  - **Hiệu năng:** timeline của một Manager sống lâu có thể rất dài, và kho lưu vết sẽ phình theo thời gian → phải phân trang, có trần, và có đường xoá
- Required artifacts/gates: PRD tính năng này [`prd-ready`] → Technical Design [`design-ready`] + ADR-007 → delta-change cho PRD gốc và design gốc → Implementation Plan [`plan-ready-for-beads`] → Beads → `feature-done` (standard)
- Execution path: plan → converter. Lý do bắt buộc có plan: năm kết quả độc lập (danh sách trace, chi tiết trace, kho lưu vết kèm xoá, suy ra bước feature-workflow, thống kê beads), một thay đổi chỉ dẫn vai trò kèm bump phiên bản, và một đợt nghiệm thu trên daemon thật
- Exceptions: **Technical Design được soạn Draft trước khi `prd-ready` chạy**, vì phần lớn câu hỏi của tính năng là "Paseo 0.8 có cho đọc dữ liệu đó không". Đây là **ngoại lệ có ghi nhận, không phải PASS**: design chỉ vào cổng `design-ready` sau khi PRD này được duyệt (ghi nhận 2026-09-16)
- Decided: 2026-09-16 — hieu.nt10 (Claude đề xuất, owner chốt Q-030 → Q-037)
- Supersedes: none

## 1. Bối cảnh

Sau Phase 1, người dùng đã có vòng lặp điều phối chạy được: chat với Beads Manager, Manager tạo Beads Worker, Worker gọi Reviewer, Worker đi tới khi implement xong. Nhưng **toàn bộ thứ nhìn thấy được về vòng lặp đó là hội thoại**:

- Màn hình "Beads Manager" hiện chỉ có nút *Open Beads Manager* cho từng workspace.
- Panel "Beads agents" hiện cây agent kèm vai trò và trạng thái, nhưng không biết agent nào sinh ra từ yêu cầu nào.
- Muốn biết "yêu cầu hôm qua đã tạo bead nào, chạy bao lâu, bỏ bước nào của feature-workflow" thì phải mở từng agent, đọc lại hội thoại, tự đếm.

Manager có trả lời được khi được hỏi, nhưng đó là câu trả lời của một model: không tái lập, không so sánh được giữa các lần, và mất luôn nếu agent bị lưu trữ hoặc xoá.

Trong khi đó dữ liệu để trả lời những câu đó **đã có sẵn** và có cấu trúc:

- Worker bắt buộc gửi khối `BM-REPORT` ở mọi mốc (REQ-034), gồm `requestId`, phase, file đã đổi, bead created/updated/closed/ready, trạng thái build và test, và bộ đếm lan can.
- Reviewer trả khối `BM-REVIEW`.
- Paseo 0.8 cho đọc timeline từng agent kèm `timestamp` và `turnId` cho từng entry, và cho lọc agent theo nhãn `bm.role`.
- `.beads/issues.jsonl` ở gốc repo là nguồn sự thật của kho beads.

Tính năng này biến dữ liệu đó thành một màn hình đọc được, và **giữ lại** nó: vòng đời agent thuộc người dùng (ADR-005), nên lịch sử công việc không được chết cùng với agent. Nó đúng bằng phần Phase 2 mà PRD gốc đã hứa (REQ-030 + bảng theo dõi tiến độ bead), chỉ cụ thể hoá thêm.

**Vì sao bây giờ:** Phase 1 vừa đóng, đây là lúc duy nhất mà khối `BM-REPORT` và nhãn agent còn dễ bổ sung. Càng để lâu càng nhiều lịch sử được tạo bởi bản chỉ dẫn cũ, và Dashboard càng phải đoán nhiều.

## 2. Mục tiêu & chỉ số thành công

**Mục tiêu**

1. Trả lời được bốn câu hỏi bằng mắt, không cần đọc hội thoại: *một yêu cầu phân rã ra bao nhiêu Worker và bao nhiêu lượt Reviewer? gửi gì, nhận gì, mất bao lâu, tốn bao nhiêu? có tạo bead không, bead nào? đi qua những bước feature-workflow nào?*
2. Cho thấy tình hình kho beads của workspace ngay cạnh đó, để người dùng quyết định có giao việc mới hay không.
3. **Giữ lịch sử** qua reload plugin, khởi động lại daemon và cả việc người dùng xoá agent — nhưng để người dùng **xoá được** khi không cần nữa.
4. Không mở thêm rủi ro nào: Dashboard không tạo agent, không gửi prompt, không ra mạng, và chỉ ghi vào đúng kho lưu vết của nó.

**Chỉ số (đo trong đợt nghiệm thu trên daemon thật, dùng bộ kit nghiệm thu điều phối hiện có)**

| ID | Chỉ số | Ngưỡng |
|---|---|---|
| D-1 | Mở Dashboard từ màn hình Beads Manager | Đúng 1 lần bấm; danh sách trace hiện đầy đủ trong **≤ 3 giây** với workspace có ≤ 20 agent và kho lưu vết ≤ 500 trace |
| D-2 | Số Worker và số Reviewer của mỗi yêu cầu | Khớp **5/5** yêu cầu mẫu với số đếm tay trên giao diện Paseo; đếm riêng *số agent Reviewer* và *số lượt gọi review* |
| D-3 | Thời gian xử lý | Lệch **≤ 1 giây** so với tính tay từ `timestamp` của timeline, trên 5/5 yêu cầu; màn hình ghi rõ mốc đo |
| D-4 | Bead sinh ra từ yêu cầu | Danh sách bead created/updated/closed khớp **5/5** với chênh lệch `.beads/issues.jsonl` trước–sau của đúng yêu cầu đó |
| D-5 | Bảng bước feature-workflow | **0** ô ghi "đã làm" mà không kèm bằng chứng cụ thể, và **0** ô ghi "không làm" khi không có phát biểu của Worker cho phép bỏ bước đó; phần còn lại ghi "không rõ" |
| D-6 | Thống kê beads | Khớp tuyệt đối với `br stats` (tổng, open, in_progress, blocked, closed) và `br ready` trên **3** repo khác nhau, trong đó có 1 repo không có `.beads/` |
| D-7 | Bằng chứng phủ định | Trong cả đợt nghiệm thu: **0** file bị ghi ngoài kho lưu vết của paseo-bm, **0** agent được tạo/dừng/lưu trữ bởi Dashboard, **0** lời gọi mạng, **0** lần ghi vào repo người dùng |
| D-8 | Lưu vết bền | Trace của 5/5 yêu cầu mẫu vẫn đọc được nguyên vẹn sau: reload plugin, khởi động lại daemon, **và** sau khi người dùng lưu trữ rồi xoá Worker tương ứng |
| D-9 | Xoá trace | Xoá 1 trace và xoá toàn bộ trace của workspace: trace biến khỏi màn hình, dung lượng kho giảm tương ứng, và **0** file nào khác trên máy bị thay đổi (ảnh chụp hệ thống file trước–sau) |
| D-10 | Token và chi phí | Khi provider báo chi phí, số hiển thị khớp tuyệt đối; khi không báo, số được đánh nhãn "tạm tính" kèm ngày của bảng giá, và model không có trong bảng thì **chỉ** hiện token, không hiện tiền |
| D-11 | Gán lại trace của workspace không còn | Sau khi gán lại: **100%** bản ghi xuất hiện đúng ở workspace đích, **0** bản ghi mất hoặc bị nhân đôi, và **0** file nào ngoài kho lưu vết bị thay đổi |

## 3. Ngoài phạm vi

- **Tạo hoặc điều khiển agent.** Không tạo, dừng, lưu trữ, xoá agent; không gửi prompt; không sửa bead; không đổi cấu hình Paseo. Vòng đời agent thuộc người dùng (ADR-005).
- **Ghi vào repo của người dùng.** Kho lưu vết nằm trong thư mục cài đặt của paseo-bm, không bao giờ trong workspace.
- **Tự động xoá ngầm.** Kho lưu vết không tự xoá theo tuổi hay theo dung lượng; nó **cảnh báo** và để người dùng quyết định (REQ-055).
- **Tác vụ nền theo đồng hồ.** Không cron, không watcher, không vòng lặp nền. Việc thu thập chỉ xảy ra trong hook sự kiện của Paseo mà plugin đã dùng sẵn, và khi người dùng mở màn hình.
- **Đồng bộ kho lưu vết giữa nhiều máy**, xuất báo cáo, biểu đồ theo thời gian, thông báo đẩy, gộp số liệu nhiều workspace. (Việc **gán lại** trace của một workspace không còn sang một workspace đang có thì **nằm trong** phạm vi — REQ-057.)
- **Hoá đơn.** Số tiền là *tạm tính theo bảng giá đi kèm bản phát hành* hoặc là số do provider báo; nó không phải hoá đơn và màn hình phải nói thế.
- Sửa hay bổ sung bước cho feature-workflow. Dashboard chỉ **quan sát** quy trình.
- Hiển thị sub-agent nội bộ của provider như một node đầy đủ. Paseo SDK cấp cho plugin không liệt kê được chúng (chỉ `DaemonClient` nội bộ có); Dashboard chỉ đếm dấu vết của chúng trong timeline và nói rõ đó là dấu vết.

## 4. Personas / Affected Actors

Không có persona mới. Hai vai trò sẵn có dùng tính năng này:

- **Người giao việc, ở vai trò người quan sát** (owner và đồng nghiệp)
  - *Bối cảnh:* vừa giao một hoặc nhiều yêu cầu cho Manager, hôm sau quay lại.
  - *Mục tiêu:* biết mỗi yêu cầu đã thành cái gì, mà không phải đọc lại ba hội thoại; và dọn được log cũ khi máy bắt đầu nặng.
  - *Nỗi đau:* hiện phải mở từng agent; agent đã lưu trữ hay xoá thì coi như mất dấu; không biết Worker có bỏ bước review hay không.
- **Maintainer phát hành, ở vai trò chẩn đoán**
  - *Mục tiêu:* khi có báo lỗi "Worker chạy mãi không xong" thì thấy ngay yêu cầu nào, dừng ở phase nào, bao nhiêu lượt review, tốn bao nhiêu, đang vướng gì.

**Actor không phải người (là nguồn dữ liệu, không phải người dùng):** Manager, Worker, Reviewer. Điểm mới cần chú ý: `BM-REPORT` của Worker từ nay có **hai** bên tiêu thụ — Manager và Dashboard.

## 5. User / Operational Journeys

- **J-9 Xem một yêu cầu đã phân rã thế nào:**
  1. Owner mở màn hình Beads Manager, bấm **Dashboard**.
  2. Chọn workspace; màn hình hiện danh sách trace, mới nhất trên cùng: thời điểm, trích yêu cầu, trạng thái, 1 Worker, 3 Reviewer / 4 lượt review, 12 phút, 2 bead tạo, ~0,42 USD (tạm tính).
  3. Owner bấm vào dòng đó. Chi tiết hiện: nguyên văn yêu cầu gửi Manager, prompt khởi tạo Worker, các `BM-REPORT` theo mốc, câu trả lời cuối, và cây Manager → Worker → từng Reviewer kèm thời gian và token riêng.
- **J-10 Điều tra một yêu cầu chạy lâu:**
  1. Owner thấy một dòng trace trạng thái "đang chạy", 2 giờ 10 phút.
  2. Mở ra: `BM-REPORT` cuối là `blocked`, `blockers` ghi một câu hỏi đang chờ người dùng từ 1 giờ 50 phút trước.
  3. Owner bấm link mở Worker và trả lời thẳng trong hội thoại. Dashboard không gửi gì thay owner.
- **J-11 Xem tình hình beads trước khi giao việc mới:**
  1. Owner mở Dashboard, đọc khối thống kê: tổng 93 bead, 4 đang làm, 11 chưa làm, 2 bị chặn, 76 đã đóng, 3 sẵn sàng làm, dữ liệu đọc lúc 09:12 từ `.beads/issues.jsonl`.
  2. Thấy đang có 4 bead dở, owner quyết định không giao thêm yêu cầu mới.
- **J-12 Yêu cầu cũ mà agent đã bị xoá:**
  1. Owner mở một trace của tuần trước; Worker đã bị xoá khỏi Paseo.
  2. Trace vẫn hiện **đầy đủ** phần đã được lưu vết lúc nó chạy, kèm ghi chú "agent không còn trên máy; không đọc thêm được gì mới".
  3. Không có lỗi, không có ô trống không giải thích.
- **J-13 Dọn log cho đỡ nặng:**
  1. Màn hình Dashboard hiện dung lượng kho lưu vết: "412 trace · 86 MB", kèm cảnh báo vì đã vượt ngưỡng.
  2. Owner chọn xoá: một trace, hoặc mọi trace cũ hơn một mốc thời gian, hoặc toàn bộ trace của workspace này.
  3. Công cụ hiện **đúng những gì sẽ bị xoá** kèm số lượng và dung lượng, và hỏi xác nhận; mặc định là "Không".
  4. Sau khi xác nhận, trace bị xoá thật; màn hình cập nhật dung lượng mới. Beads, tài liệu, agent và hội thoại trong Paseo **không** bị ảnh hưởng — chỉ bản lưu vết của paseo-bm mất.
- **J-14 Workspace cũ mở lại:**
  1. Owner đã xoá workspace của một repo khỏi Paseo từ tháng trước, nhưng trace của nó vẫn còn trong kho.
  2. Dashboard hiện chúng trong nhóm **"workspace không còn"**, kèm tên và đường dẫn cuối cùng biết được, để owner nhận ra đó là repo nào.
  3. Tháng sau owner mở lại workspace của chính repo đó. Trong nhóm "workspace không còn", owner chọn **gán lại** sang workspace mới.
  4. Công cụ hiện trước số trace sẽ được gán và hỏi xác nhận. Sau khi đồng ý, trace nằm chung với trace mới của workspace đó, không bản ghi nào mất hay bị nhân đôi.

## 6. Functional Requirements

Priority: **P2** = bắt buộc cho Phase 2a MVP (đợt này); **P3** = để sau, không chặn.

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| REQ-040 | Lối vào Dashboard | P2 | (a) Màn hình "Beads Manager" có thêm nút **Dashboard**, đặt cùng chỗ với *Open Beads Manager* và không làm mất nút đó (owner chốt Q-036: cùng surface, đổi khung hiển thị). (b) Có thêm một mục Command Center *Open Beads Dashboard* theo ngữ cảnh workspace, mở thẳng Dashboard của workspace đang mở. (c) Máy chưa có workspace nào, hoặc workspace chưa có dữ liệu nào, thì hiện trạng thái rỗng kèm một câu giải thích, không phải lỗi. (d) Dashboard mở được cả trên host Paseo không có `navigation.openAgent`; khi thiếu, các link "mở agent" bị ẩn và có một dòng giải thích, phần còn lại vẫn dùng được. |
| REQ-041 | Danh sách trace theo yêu cầu | P2 | (a) Một dòng = **một yêu cầu người dùng gửi cho Manager**; báo cáo của Worker gửi về Manager không bao giờ là một dòng riêng. (b) Mỗi dòng có: thời điểm nhận, trích yêu cầu một dòng, `requestId` khi biết, trạng thái (`đang chạy` / `hoàn tất` / `đang chờ người dùng` / `đã dừng` / `lỗi` / `không rõ`), số Worker, số agent Reviewer, số lượt gọi review, tổng thời gian, số bead tạo/cập nhật/đóng, và token kèm chi phí. (c) Sắp xếp mới nhất trước, phân trang, có trần số trace đọc mỗi lần (REQ-049) và nút tải thêm. (d) Mỗi dòng ghi **độ chắc chắn của việc nhóm**: `khớp requestId` / `suy luận` / `không rõ`; không bao giờ trình bày suy luận như dữ kiện. |
| REQ-042 | Phân rã một yêu cầu | P2 | (a) Hiện cây Manager → Worker → Reviewer của đúng yêu cầu đó. (b) Phân biệt rõ hai con số: **số agent Reviewer** và **số lượt gọi review** (một Reviewer có thể được dùng lại, và lan can REQ-037 đếm theo lượt gọi). (c) Hiện bộ đếm lan can mà Worker tự báo (`guardrail` trong `BM-REPORT`) cạnh số đếm quan sát được; hai số lệch nhau thì hiện cả hai và đánh dấu lệch, không tự chọn số nào. (d) Worker mồ côi (Manager đã bị xoá) vẫn hiện, ở nhánh "không có Manager". (e) Dấu vết sub-agent nội bộ của provider, nếu có trong timeline, được đếm riêng và ghi rõ là "sub-agent của công cụ, không phải agent Paseo". |
| REQ-043 | Chi tiết một dòng trace | P2 | (a) **Thông tin gửi đi:** nguyên văn yêu cầu người dùng, prompt khởi tạo Worker, và từng yêu cầu review Worker gửi cho Reviewer. (b) **Thông tin nhận lại:** các khối `BM-REPORT` theo mốc (nhận việc → tài liệu → beads → từng bead implement → vướng → kết thúc), các khối `BM-REVIEW`, và câu trả lời cuối của Manager cho người dùng. (c) **Thời gian:** tổng thời gian của yêu cầu, thời gian từng lượt của Manager, thời gian sống của từng Worker và từng Reviewer; mỗi số kèm **định nghĩa mốc đo hiển thị ngay trên màn hình**, và ghi rõ đây là thời gian treo, gồm cả thời gian chờ người dùng trả lời. (d) Lượt đang chạy hiện "đang chạy" kèm thời gian đã trôi, không hiện một con số tổng giả. (e) Văn bản dài bị cắt kèm nút mở rộng; có cách copy nguyên văn. |
| REQ-044 | Yêu cầu này có tạo bead không | P2 | (a) Hiện danh sách bead **đã tạo / đã cập nhật / đã đóng / đang sẵn sàng làm** của yêu cầu, mỗi bead kèm id, tiêu đề và trạng thái hiện tại đọc từ kho beads. (b) Nguồn ưu tiên là `BM-REPORT`; thiếu thì suy từ bằng chứng lệnh `br` trong timeline và **đánh dấu là suy luận** (owner chốt Q-032). (c) Chỉ được kết luận "**không** tạo bead" khi có một `BM-REPORT` nói đúng điều đó (ví dụ `beadsCreated: none` ở phase `finished`). Không có bằng chứng → ghi "**không rõ**", tuyệt đối không suy ra "không tạo". (d) Bead có trong báo cáo nhưng không còn trong kho beads thì hiện kèm ghi chú "không còn trong kho", không làm hỏng màn hình. |
| REQ-045 | Bước feature-workflow nào đã làm, bước nào không | P2 | (a) Một bảng cố định các bước: phân loại mức (Nhỏ/Vừa/Lớn), PRD, Technical Design, ADR, Implementation Plan, chuyển thành beads, polish beads, implement, review từng lô, build và test, đóng bead kèm bằng chứng. (b) Mỗi bước có đúng một trong ba trạng thái: **đã làm** / **không làm (hợp lệ theo mức)** / **không rõ**, kèm **bằng chứng** dẫn ra được (file đã đổi, id bead, phase của báo cáo, số lượt review, lệnh build hoặc test đã chạy). (c) "Đã làm" phải có ít nhất một bằng chứng cụ thể. (d) "Không làm" chỉ dùng khi mức phân loại của yêu cầu cho phép bỏ bước đó theo REQ-036 **và** Worker đã nói rõ mức đó; nếu không thì là "không rõ". (e) Bảng nêu mức phân loại của yêu cầu và ai đặt mức đó (Worker tự phân loại, hay người dùng ghi đè). |
| REQ-046 | Thống kê beads của workspace | P2 | (a) Hiện: **tổng số bead**, **đang làm** (`in_progress`), **chưa làm** (`open`), **bị chặn** (`blocked`), **đã đóng** (`closed`), và **sẵn sàng làm** (open và mọi phụ thuộc chặn đã đóng). (b) Số liệu khớp `br stats` và `br ready` tại cùng thời điểm. (c) Nguồn dữ liệu duy nhất là `<workspace>/.beads/issues.jsonl` (owner chốt Q-031: không gọi `br`), hiện rõ đường dẫn và thời điểm đọc. (d) Workspace không có `.beads/` → trạng thái rỗng kèm giải thích, không phải lỗi. (e) File có dòng hỏng thì bỏ qua đúng dòng đó, vẫn thống kê phần còn lại, và báo số dòng bỏ qua. |
| REQ-047 | Chỉ ghi phần của mình, không ra mạng | P2 | Có test phủ định chứng minh trong mọi luồng của Dashboard: **không** tạo/dừng/lưu trữ/xoá agent, **không** gửi prompt, **không** sửa cấu hình Paseo, **không** gọi mạng, **không** ghi vào workspace hay thư mục skills, và toàn bộ việc ghi chỉ xảy ra bên trong kho lưu vết của paseo-bm. Bề mặt **đọc** đĩa đúng hai đường: `<workspace>/.beads/issues.jsonl` trong workspace, và `<install home>/install.json` ngoài workspace — chỉ để xác nhận thư mục cài đặt (bundle server không có cwd nên không có cách nào khác). Không đọc file cấu hình, file credential hay file nào khác. |
| REQ-048 | Giới hạn dữ liệu nhạy cảm | P2 | (a) Dashboard không hiển thị và không lưu biến môi trường, không đọc file cấu hình agent, không đọc file nào trong `~/.paseo` ngoài đường sẵn có của plugin. (b) Bộ che bí mật được áp **trước khi ghi** vào kho lưu vết, không phải chỉ trước khi render — dữ liệu đã lên đĩa thì không sửa lại được. (c) File lưu vết có quyền `0600`, thư mục `0700`. (d) Màn hình nói rõ rằng nội dung hiển thị và lưu lại là hội thoại agent, để người dùng biết mình đang chia sẻ gì khi chụp ảnh màn hình. |
| REQ-049 | Trần, phân trang và chịu lỗi | P2 | (a) Trần theo quyết định Q-034: **50** trace mỗi trang, **2.000** entry timeline mỗi agent mỗi lần đọc, **32 MB** cho một lần đọc `issues.jsonl`. Chạm trần thì hiện "còn dữ liệu cũ hơn" kèm nút tải thêm, không âm thầm cắt. (b) Agent đã lưu trữ hoặc đã bị xoá → hiện phần đã lưu vết kèm ghi chú. (c) Timeline bị Paseo thay thế hoặc có khoảng trống (`reset`, `gap`) → đọc lại và ghi "dữ liệu có thể thiếu". (d) RPC lỗi → thông báo kèm mã lỗi, phần còn lại của màn hình vẫn dùng được. |
| REQ-050 | `BM-REPORT` là hợp đồng đang được tiêu thụ | P2 | (a) Bộ đọc `BM-REPORT` phải khoan dung: thiếu field, thêm field lạ, thứ tự khác, nhiều khối trong một tin nhắn, chữ hoa chữ thường khác — đều không được làm hỏng trace; field không đọc được thì báo "không rõ". (b) Đổi định dạng khối trong `roles/*.md` là **thay đổi hợp đồng**: phải cập nhật bộ đọc trong cùng lần, và bộ đọc vẫn phải đọc được khối của bản chỉ dẫn trước đó. (c) Có test cho cả hai phiên bản khối. |
| REQ-051 | Nhãn `bm.requestId` khi tạo agent | P2 | (owner chốt Q-033: làm, và bump phiên bản chỉ dẫn.) (a) `roles/manager.md` yêu cầu Manager gắn nhãn `bm.requestId` khi tạo Worker; `roles/worker.md` yêu cầu Worker gắn `bm.requestId` và `bm.batchId` khi tạo Reviewer. (b) Phiên bản payload và phiên bản chỉ dẫn được bump theo, và `bm.version` của agent mới phản ánh bản mới. (c) Agent tạo bởi bản cũ (không có nhãn) vẫn nhóm được ở mức "suy luận"; agent mới nhóm ở mức "khớp requestId". (d) Nhãn thiếu hoặc sai định dạng không bao giờ làm mất trace. |
| REQ-052 | Token và chi phí | P2 | (owner chốt Q-035: hiện, chi phí là **tạm tính theo model**.) (a) Mỗi trace và mỗi agent trong trace hiện: token vào, token vào từ cache, token ra, và chi phí. (b) Có số chi phí do provider báo thì dùng đúng số đó và ghi "theo công cụ báo". (c) Không có thì tạm tính từ **bảng giá đi kèm bản phát hành**, tính riêng token cache theo đơn giá cache, và nhãn hiển thị là "tạm tính" kèm **ngày của bảng giá** và model id. (d) Model không có trong bảng giá → **chỉ** hiện token, không hiện tiền. (e) Không bao giờ gọi mạng để lấy giá. (f) Màn hình nêu rõ đây không phải hoá đơn. |
| REQ-053 | Kho lưu vết bền | P2 | (owner chốt Q-030: có lưu vết.) (a) Trace được ghi lại tại thời điểm nó xảy ra, nên vẫn đọc được sau reload plugin, khởi động lại daemon, và sau khi agent bị lưu trữ hoặc xoá (D-8). (b) Kho nằm trong thư mục cài đặt của paseo-bm, tách theo workspace, quyền `0600`/`0700`, ghi atomic, và có **phiên bản lược đồ**: bản lược đồ cao hơn mức hiểu được thì đọc ở chế độ hạn chế kèm thông báo, không bao giờ ghi đè. (c) Ghi lỗi (hết đĩa, không đủ quyền) không được làm hỏng agent đang chạy: hook bỏ qua, ghi log một dòng, Dashboard hiện cảnh báo "có thể thiếu trace". (d) Kho không chứa bí mật (REQ-048b) và không chứa nội dung file của repo ngoài những gì agent đã nói. |
| REQ-054 | Xoá trace | P2 | (a) Người dùng xoá được: **một trace**, **mọi trace cũ hơn một mốc thời gian**, hoặc **toàn bộ trace của một workspace**. (b) Trước khi xoá, hiện đúng số trace và dung lượng sẽ mất; câu xác nhận mặc định là "Không". (c) Xoá là xoá thật trên đĩa, không phải ẩn đi. (d) Việc xoá **không** chạm vào beads, tài liệu, agent, hội thoại Paseo hay bất cứ file nào ngoài kho lưu vết (D-9). (e) Xoá trace của một yêu cầu đang chạy thì phải cảnh báo trước rằng phần còn lại của yêu cầu sẽ được ghi lại như một trace mới. (f) Không có chức năng nào xoá thay người dùng. |
| REQ-055 | Dung lượng, cảnh báo và cấu hình | P2 | (a) Dashboard hiện số trace và dung lượng kho của workspace đang xem, và tổng của cả kho. (b) Vượt ngưỡng thì hiện cảnh báo kèm lối vào chức năng xoá. (c) **Không tự xoá, không tự nén, không tự xoay vòng.** Đây là quyết định có chủ ý: dữ liệu này là lịch sử công việc của người dùng. (d) (owner chốt Q-040) Ngưỡng do **người dùng cấu hình trong phần cài đặt của plugin** ngay trong Paseo, mặc định 200 MB; đổi ngưỡng có hiệu lực ngay, không cần cài lại hay reload. (e) Cơ chế cài đặt của Paseo chỉ có phạm vi **toàn máy**, nên ngưỡng là một giá trị chung cho mọi workspace; màn hình nói rõ điều đó. (f) Giá trị cài đặt không hợp lệ (âm, bằng 0, không phải số) bị từ chối kèm thông báo, và ngưỡng đang dùng không đổi.
| REQ-056 | Gỡ cài đặt, cập nhật và quyền sở hữu kho lưu vết | P2 | (a) Kho lưu vết là dữ liệu do paseo-bm tạo nhưng **thuộc người dùng**: lệnh gỡ liệt kê nó riêng, nêu số trace và dung lượng, và **hỏi** trước khi xoá; chế độ không tương tác chỉ xoá khi có một cờ riêng dành đúng cho việc này. (b) (owner chốt Q-039) **Cập nhật phiên bản tuyệt đối không xoá kho**, kể cả khi payload đổi thư mục phiên bản, kể cả với `--prune`, và kể cả khi lược đồ kho cần di trú — di trú thì đọc và ghi bản mới, không xoá bản cũ trước khi ghi xong. (c) Có test chứng minh: cài lại, cập nhật lên phiên bản mới, và `--prune` đều để kho nguyên vẹn. (d) Việc này chạm bố cục thư mục cài đặt, phân loại quyền sở hữu và phạm vi lệnh gỡ của tài liệu đã đóng băng, nên **phải đi kèm một delta-change** cho PRD gốc (REQ-010, REQ-012) và design gốc (§3.1, §3.3) — không sửa tại chỗ.
| REQ-057 | Trace của workspace không còn, và gán lại | P2 | (owner chốt Q-041.) (a) Trace có `workspaceId` không còn xuất hiện trong danh sách workspace của Paseo được hiện trong một nhóm riêng **"workspace không còn"**, kèm tên và đường dẫn cuối cùng mà paseo-bm biết, để người dùng nhận ra đó là repo nào. (b) Workspace chỉ bị **lưu trữ** (vẫn liệt kê được) thì không vào nhóm này; nó được đánh nhãn "đã lưu trữ" và vẫn đứng ở chỗ của nó. (c) Trace trong nhóm này đọc được, xoá được như mọi trace khác. (d) Người dùng **gán lại** được toàn bộ trace của một workspace không còn sang một workspace đang có: có bước xem trước nêu số trace, có xác nhận, và sau khi gán thì trace nằm chung với trace của workspace đích. (e) Gán lại không được làm mất hay nhân đôi bản ghi; trùng `(agentId, turnId)` thì giữ một bản. (f) Chỉ người dùng gán lại; **không** có cơ chế tự động đoán workspace nào là workspace cũ. (g) Gán lại không chạm bất cứ file nào ngoài kho lưu vết.
| REQ-058 | Agent nào chạy bằng model, mức thinking và mode nào | P2 | (Delta [`prd-delta-20260918-manager-mode-model-metrics`](paseo-bm-prd-delta-20260918-manager-mode-model-metrics.md), owner chốt Q32, Q38.) (a) Mỗi agent trong sơ đồ một request (Worker, Reviewer; Manager nằm trong phần chi tiết request) hiện **model**, **mức thinking/effort** và **mode** mà nó thật sự chạy, lấy từ các lượt đã ghi — không lấy từ cấu hình profile. (b) Giá trị đổi giữa các lượt thì hiện đủ mọi giá trị kèm số lượt của từng cái, không chọn một. (c) Lượt ghi bởi bản cũ không có trường này thì hiện **"không ghi nhận"**, không suy đoán; mức thinking không đặt thì hiện "mặc định của provider". (d) Phần chi tiết request có dòng **token và chi phí theo model**, cùng quy tắc giá của REQ-052 (model không có giá thì chỉ hiện token); chi phí gộp theo model agent **thật sự chạy**. (e) Phần tổng quan có thẻ **token và chi phí theo model × vai trò**, cộng trên đúng tập request mà các thẻ tổng quan khác đang dùng. (f) Không gọi mạng, không đọc thêm quyền nào ngoài những gì bộ thu thập đang đọc. |
| REQ-060 | Tab "Beads" trong menu "+", Setup là màn chính của Beads Manager, cách bead nói trạng thái, bố cục danh sách bead | P2 | (Delta [`prd-delta-20260918e-beads-tab`](paseo-bm-prd-delta-20260918e-beads-tab.md), owner chốt Q1–Q12 và batch `b5`; (g), (h) sửa và (j)–(m) thêm ở batch `b4`; (m) mở rộng và (n) thêm ở batch `b5`; (a) errata và (o) thêm ở batch `b6`, owner chốt Q14 a của request `req-20260918T043115Z`; (e) bỏ ghim theo delta [`prd-delta-20260918f-remove-pinning`](paseo-bm-prd-delta-20260918f-remove-pinning.md), owner chốt Q11 c và duyệt Q14 a; (g), (h), (j), (k), (n) sửa theo delta [`prd-delta-20260925-kanban-quiet-colours`](paseo-bm-prd-delta-20260925-kanban-quiet-colours.md) — kanban theo trạng thái và chữ đậm/mờ thay màu, owner chốt Q1 a và Q4 a của request `req-20260925T015709Z`; xem REQ-069.) (a) Menu "+" của thanh tab workspace có đúng một mục mới "Beads" (nhóm của plugin, trước "Beads agents"), mở một tab của chính workspace đó (desktop; app mobile của Paseo 0.8 không có "+", xem (o)). (b) Tab có hai tab con Beads và Metric, mở ra ở Beads; nội dung là màn Beads và màn Metric hiện có; không nút ←, không tên workspace. (c) Xem được ở bố cục hẹp (`layout.compact`): không gì bị cắt mất chức năng, cuộn dọc được; tab con đọc được bằng trình đọc màn hình (vai trò tab, trạng thái chọn). (d) Surface "Beads Manager" mở ra ở Setup (công cụ beads, agent skills, chỉ dẫn thêm từng vai), tiêu đề "Beads Manager", không nút ←, dòng phiên bản ở cuối. (e) Nút "Workspaces" mở danh sách workspace như trước (chấm đang chạy, số bead, Go to / Metric / Beads, lịch sử workspace đã đóng), **xếp theo hoạt động gần nhất, không ghim**, với ← về màn chính; Metric/Beads mở từ danh sách có ← về danh sách. (f) Không mất lối vào nào (hai mục Command Center, `/bm-worker-new`, `/bm-worker-stop-all`); thông báo của slash command và trạng thái mở Manager hiện ở màn chính và ở danh sách workspace. (g) Trong danh sách của màn Beads và panel "Beads in this chat", **tên** bead nói trạng thái bằng độ tương phản, không bằng màu hue: chưa xong = `foreground`, đã đóng = `foregroundMuted`; dòng không tô, không vạch trái; màu lấy từ theme. *(Trước 2026-09-25: chưa làm = accent, đang làm = vàng, block = đỏ, đã đóng = xanh lá — bỏ vì nhiều màu gây mỏi mắt.)* (h) Chip trạng thái cùng **độ tương phản** với tên ở mọi chỗ hiện bead (màn Beads, panel "Beads in this chat", chip bead trong thẻ chat); chữ của chip giữ nguyên, nên trạng thái không bao giờ chỉ nằm ở màu. *(Trước 2026-09-25: cùng màu hue với tên.)* (i) Tên bead ở các danh sách đó và ở khung chi tiết mở từ chip không in đậm. (j) Nút mắt ở đầu màn Beads ẩn/hiện bead đã đóng, kèm số lượng; **mặc định hiện** (Closed là một cột như các cột khác); nhớ trong phiên app, tải lại app thì về hiện; mọi bead khớp đều đã đóng mà đang ẩn thì màn hình nói rõ. *(Trước 2026-09-25: mặc định ẩn.)* (k) Màn Beads chia bead thành bốn **cột** In progress → Blocked → Ready → Closed (xem REQ-069 (a), (b)), mỗi cột có tên kèm số lượng; trong cột giữ cách sắp đang chọn; bộ lọc áp trước; cột rỗng vẫn hiện và nói rõ là rỗng; giới hạn 100 dòng mỗi cột. *(Trước 2026-09-25: bốn nhóm xếp dọc, mỗi nhóm một vạch ngăn, giới hạn 200 dòng cho cả danh sách.)* (l) Dòng đầu màn Beads, cạnh Refresh, hiện `✓ <đã đóng> / <tổng> done`, đếm như thẻ Progress (không đếm epic, không theo bộ lọc). (m) Không còn biểu đồ "Created / closed, last 14 days" ở màn Beads, và tổng quan màn Beads không còn tính số tạo/đóng theo ngày. (n) Trên dòng workspace của danh sách Workspaces, số bead đang làm, số bead block và số Worker đang chạy dùng `foreground` khi lớn hơn 0 và xám khi bằng 0 (cùng cách đọc với tên bead); tổng số bead vẫn xám. *(Trước 2026-09-25: số đang làm màu vàng, số block màu đỏ, số Worker đang chạy màu xanh lá.)* (o) Header của mỗi workspace đang mở có nút "Beads" (chỉ biểu tượng danh sách) mở tab Beads của chính workspace đó, trên mobile (nằm ngay trên header) và desktop (header phải); nút theo danh sách workspace đang mở, đọc lỗi thì giữ nguyên. |
| REQ-069 | Kanban theo trạng thái, chữ đậm/mờ thay màu, tab cho Setup, đếm lỗi ở Metric | P2 | (Delta [`prd-delta-20260925-kanban-quiet-colours`](paseo-bm-prd-delta-20260925-kanban-quiet-colours.md), owner chốt Q1 a, Q2 a, Q3 a, Q4 a của request `req-20260925T015709Z`; sửa REQ-060 (g), (h), (j), (k), (n).) (a) Màn Beads chia bead thành bốn cột In progress → Blocked → Ready → Closed, mỗi cột có tên kèm số lượng; cột rỗng vẫn hiện và nói rõ là rỗng. (b) Bố cục rộng hiện các cột cạnh nhau, vừa bao nhiêu cột thì hiện bấy nhiêu trên một hàng; bố cục hẹp hiện một cột mỗi lần, chọn bằng dãy tab trạng thái có số lượng và đọc được bằng trình đọc màn hình; không chức năng nào mất ở bố cục hẹp. (c) Closed là một cột như các cột khác và hiện sẵn; nút mắt vẫn ẩn/hiện nó, nhớ trong phiên app. (d) Ở mọi chỗ hiện bead — màn Beads, tab "Beads", panel "Beads in this chat", chip bead trong thẻ chat, các con số trên dòng workspace — trạng thái chỉ dùng chữ và độ tương phản (`foreground` khi chưa xong, `foregroundMuted` khi đã đóng); không cam, không đỏ, không xanh lá; tên bead vẫn không in đậm (REQ-060 (i)). (e) Ngoài các chỗ hiện bead, dòng lỗi và cảnh báo giữ màu như cũ. (f) Màn chính "Beads Manager" chia ba tab Beads tools / Agent skills / Agents, mỗi lần một phần; dòng tình trạng và cảnh báo công cụ nằm trên dãy tab nên không tab nào che được một vấn đề; dãy tab đọc được bằng trình đọc màn hình. (g) Màn Metric có thẻ "Errors" đếm số lần request bị lỗi bất kể lý do (turn kết thúc `failed`, agent kết thúc ở trạng thái `error`, sự cố fallback nhà cung cấp), kèm số request bị ảnh hưởng; bằng 0 thì nói rõ chưa ghi nhận lỗi nào; mỗi lần lỗi chỉ đếm một lần, dù request nhiều lượt hỏi và dù nhiều nguồn cùng ghi nhận một lần chết. (h) Sau khi bấm Assign a Worker / Close / Delete, dòng kết quả vẫn còn khi bead chuyển sang cột khác; thẻ xác nhận đang mở thì đóng lại. |

## 7. Non-Functional Requirements

| Nhóm | Yêu cầu |
|---|---|
| Hiệu năng | Đạt D-1. Ghi lưu vết là thao tác nối thêm, không được làm chậm lượt của agent quá mức cảm nhận được (mục tiêu: dưới 50 ms mỗi lượt) và không bao giờ chặn agent khi lỗi. Đọc theo trang, có trần. Không cron, không watcher, không vòng lặp nền. |
| Chính xác hơn đầy đủ | Khi không chắc thì phải nói "không rõ". Một con số sai đáng tin làm hỏng niềm tin vào cả màn hình; một ô "không rõ" thì không. |
| Lưu trữ | Kho lưu vết có phiên bản lược đồ và đường di trú; dữ liệu của bản cũ không bị mất khi nâng cấp. Ghi atomic để bản ghi dở không làm hỏng file. |
| An toàn và riêng tư | Che bí mật **trước khi ghi**; quyền `0600`/`0700`; không credential; không biến môi trường; không ghi ra ngoài kho; không mạng. |
| Tương thích | Không đổi ba RPC hiện có (`manager.ensure`, `agents.list`, `roles.describe`); không đổi cấu trúc `install.json` theo cách làm hỏng bản cũ; không cần cài lại plugin để dùng tính năng này (cập nhật payload theo REQ-010 là đủ). Host Paseo thiếu API thì tắt đúng phần đó kèm thông báo, không làm sập plugin. |
| Giao diện | Chỉ primitive React Native, mọi màu lấy từ `theme.colors`, có nhãn trợ năng cho mọi thành phần bấm được, dùng được ở chế độ `compact`. Văn bản trên giao diện viết bằng **tiếng Anh** như phần giao diện hiện có. |
| Kiểm thử | Logic nhóm trace, đọc `BM-REPORT`, tính thời gian, suy ra bước quy trình, đọc và ghi kho lưu vết, xoá trace, tính chi phí đều nằm trong module thuần, test được không cần renderer. Thêm một đợt nghiệm thu trên daemon thật cho D-2 → D-10. |
| Quan sát được | Mọi thông báo lỗi trên giao diện kèm mã lỗi trong bộ mã chung. |

## 8. Boundaries & Dependencies

- **Phụ thuộc Paseo 0.8:** lọc agent theo nhãn, đọc timeline theo trang kèm `timestamp` và `turnId`, snapshot agent kèm `lastUsage`, hook `agent.turn_started` / `agent.turn_ended`, và `config.get()` để tìm thư mục plugin đã đăng ký. Chi tiết và nguồn kiểm chứng ở [§11](#11-phụ-lục--dữ-kiện-đã-kiểm-chứng-về-paseo-08).
- **Phụ thuộc chỉ dẫn vai trò:** chất lượng của REQ-044 và REQ-045 tỉ lệ thuận với việc Worker gửi `BM-REPORT` đầy đủ, và REQ-051 phụ thuộc việc agent gắn nhãn theo chỉ dẫn. Đây là ràng buộc hành vi, giống lan can REQ-037: Dashboard không thể bắt buộc, chỉ có thể hiện "không rõ" khi thiếu. Hạn chế đã biết và được chấp nhận.
- **Phụ thuộc `br`:** định dạng `.beads/issues.jsonl` (các trường `status`, `labels`, `dependencies`, `updated_at`). Dashboard chỉ **đọc**; không bao giờ ghi, đúng quy ước "không hand-edit issues.jsonl". Không phụ thuộc việc máy có cài `br`.
- **Phụ thuộc bảng giá model** cho REQ-052: bảng đi kèm bản phát hành, có ngày, và sẽ cũ dần. Nguồn sự thật là trang giá công bố của từng provider; số trên Bedrock hoặc Vertex khác số của API gốc. Đây là lý do số tiền luôn mang nhãn "tạm tính".
- **Không sở hữu:** trình cài đặt, cách tạo agent, nội dung `roles/*.md` (tài liệu này chỉ yêu cầu thêm nhãn ở REQ-051), nội bộ Paseo, định dạng dữ liệu của `br`.
- **Liên quan tới các REQ Phase 2 khác:** REQ-030 và phần bảng theo dõi bead được tính năng này hiện thực. REQ-016, REQ-017, REQ-028, REQ-029 **không** thuộc tính năng này.

## 9. Phase Scope

| Phase | Scope | Exit criteria |
|---|---|---|
| Phase 2a MVP (đợt này) | REQ-040 → REQ-057 | Mọi AC P2 đạt; D-1 → D-11 đạt trong một đợt nghiệm thu trên daemon thật, có run record trong `docs/operations/`; ADR-007 Accepted; delta-change cho PRD gốc và design gốc được owner duyệt; typecheck, lint, test, build sạch |
| Phase 2b MVP | Tách nhóm theo nhãn `phase:*` và `wp:*`, gộp nhiều workspace, xuất báo cáo, biểu đồ theo thời gian | Không chặn 2a |

## 10. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-030 | Có lưu vết riêng trên đĩa không? | hieu.nt10 | **answered (2026-09-16)** — **Có lưu vết**, kèm chức năng xoá trace để không phình theo thời gian. Xem REQ-053, REQ-054, REQ-055 và [ADR-007](../adr/ADR-007-dashboard-trace-store.md) |
| Q-031 | Nguồn thống kê beads | hieu.nt10 | **answered (2026-09-16)** — đọc trực tiếp `.beads/issues.jsonl`, không gọi `br` (REQ-046c) |
| Q-032 | Nguồn sự thật cho REQ-044 và REQ-045 | hieu.nt10 | **answered (2026-09-16)** — `BM-REPORT` cộng bằng chứng suy luận, luôn ghi rõ độ chắc chắn |
| Q-033 | Có thêm nhãn `bm.requestId` / `bm.batchId` không | hieu.nt10 | **answered (2026-09-16)** — có, và chấp nhận bump phiên bản chỉ dẫn (REQ-051) |
| Q-034 | Các trần cụ thể | hieu.nt10 | **answered (2026-09-16)** — lấy mức tối đa đã đề xuất: 50 trace mỗi trang, 2.000 entry timeline mỗi agent, 32 MB mỗi lần đọc `issues.jsonl` (REQ-049a) |
| Q-035 | Có hiện token và chi phí không | hieu.nt10 | **answered (2026-09-16)** — có; chi phí **tạm tính theo model** khi provider không báo (REQ-052) |
| Q-036 | Dashboard nằm ở đâu | hieu.nt10 | **answered (2026-09-16)** — cùng surface "Beads Manager" (REQ-040a) |
| Q-037 | Có cần ADR không | hieu.nt10 | **answered (2026-09-16)** — có: [ADR-007](../adr/ADR-007-dashboard-trace-store.md), trạng thái Proposed, chờ duyệt cùng PRD này |
| Q-039 | Lệnh gỡ và lệnh cập nhật xử lý kho lưu vết thế nào | hieu.nt10 | **answered một phần (2026-09-16)** — **cập nhật phiên bản không bao giờ xoá kho** (REQ-056b). Còn chờ chốt: lệnh **gỡ** có giữ nguyên hành vi "hỏi rồi mới xoá" (đề xuất, REQ-056a) hay luôn giữ lại kho, và **tên cờ** cho chế độ không tương tác (đề xuất `--purge-traces`) |
| Q-040 | Ngưỡng cảnh báo dung lượng | hieu.nt10 | **answered (2026-09-16)** — người dùng cấu hình trong phần cài đặt của plugin, mặc định 200 MB (REQ-055d). Hệ quả kỹ thuật: cơ chế cài đặt của Paseo chỉ có phạm vi toàn máy nên ngưỡng là giá trị chung cho mọi workspace (REQ-055e) |
| Q-041 | Workspace bị xoá khỏi Paseo thì trace của nó ở đâu | hieu.nt10 | **answered (2026-09-16)** — vào nhóm "workspace không còn", và người dùng gán lại được sang một workspace đang có khi mở lại repo (REQ-057) |

## 11. Phụ lục — dữ kiện đã kiểm chứng về Paseo 0.8

Kiểm ngày **2026-09-16** trên `@getpaseo/plugin` 0.8.0, `@getpaseo/client` 0.8.0, `@getpaseo/protocol` 0.8.0 trong `node_modules` của repo (đọc khai báo kiểu, không đoán).

| Dữ kiện | Ý nghĩa cho tính năng |
|---|---|
| `paseo.agents.list({ filter: { labels, includeArchived }, page: { limit ≤ 200, cursor } })`; bộ lọc **không có** khoá workspace | Lọc được agent theo `bm.role`, kể cả agent đã lưu trữ; workspace phải tự khớp theo `agent.workspaceId` như `manager.ts` đang làm |
| `paseo.agents.ref(id).timeline.refetch({ direction, cursor, limit, projection })` trả về từng entry gồm `item`, **`timestamp`**, **`turnId`**, `seqStart`/`seqEnd`, cùng `epoch`, `reset`, `gap`, `hasOlder`, `hasNewer` | Đọc được hội thoại theo trang, và **đo được thời gian** theo mốc thật của từng entry; có cờ để biết dữ liệu bị thay thế hay thiếu khoảng |
| Snapshot agent có `createdAt`, `updatedAt`, `lastUserMessageAt`, `activeTurn.startedAt`, `status`, `labels`, `parentAgentId`, `archivedAt`, **`lastUsage`** (`inputTokens`, `cachedInputTokens`, `outputTokens`, `totalCostUsd`, `contextWindowUsedTokens`) | Đủ để dựng cây, biết lượt đang chạy, và hiện token (REQ-052). **Đo trên daemon thật 2026-09-16:** ba trường token là **của từng lượt**, nhưng `totalCostUsd` là **tổng luỹ kế của cả phiên agent** — qua 12 lượt Manager nó chỉ tăng (0,3956 → … → 2,2712) trong khi token bên cạnh lên xuống. Vì vậy chi phí một request **luôn** là số tạm tính từ token, xem [delta 20260916-acceptance-fixes](../design/paseo-bm-delta-20260916-acceptance-fixes.md) vị trí 3 (đổi một phần Q-035) |
| Kiểu entry timeline gồm `user_message`, `assistant_message`, `reasoning`, `tool_call`, `todo`, `error`, `notification`, `compaction`, `plugin`; `tool_call.detail` có các dạng `shell` (kèm `command`, `output`, `exitCode`), `edit`/`write` (kèm `filePath`), `search`, `sub_agent`, `plan` | Nguồn bằng chứng cho REQ-044 và REQ-045: lệnh `br` nào đã chạy, file tài liệu nào đã bị ghi, có dấu vết sub-agent nào |
| Hook `on("agent.turn_started")` và `on("agent.turn_ended")` cấp `turnId`, `outcome` và **toàn bộ timeline của lượt** | Đây là đường thu thập cho REQ-053: ghi lưu vết ngay khi lượt kết thúc, nên trace sống sót cả khi agent bị xoá. Đó là **hook sự kiện**, không phải tác vụ nền; plugin đã dùng đúng hook này cho việc lan truyền lệnh dừng (bm-wq6) |
| Hook `before("agent.create")` nhận `{ config, env }`; `config` **không có** trường nhãn và **không có** prompt khởi tạo | Plugin **không thể** tự gắn nhãn `requestId`, nên REQ-051 phải đi qua `roles/*.md` |
| `paseo.config.get()` trả về cấu hình daemon, trong đó `plugins["paseo-bm"]` là `{ source: "directory", path }` | Đây là cách plugin biết thư mục payload đang chạy, và từ đó suy ra thư mục cài đặt để đặt kho lưu vết — cần thiết vì bundle server **không có cwd** và không đọc được `import.meta.url` (errata bm-dnc), lại phải chịu được cả trường hợp người dùng đổi thư mục cài đặt bằng `--home` |
| `registerSettings({ id, scope: "host", version, schema })` ở server, `addSettingsScreen(...)` và hook `useSettings(definition)` ở client, cùng ba RPC read/write/reset do Paseo quản lý (ghi có `revision` để chống ghi đè song song). Phạm vi duy nhất là **`"host"`** — không có phạm vi theo workspace | Chỗ đặt ngưỡng cảnh báo dung lượng (REQ-055d) mà không phải tự ghi file cấu hình riêng; và là lý do ngưỡng chỉ là một giá trị chung cho cả máy (REQ-055e) |
| `paseo.workspaces.list()` trả về workspace kèm `archivingAt`; `workspaces.archive(...)` là cách Paseo bỏ một workspace | Phân biệt được "đã lưu trữ" (vẫn liệt kê được) với "không còn trong danh sách" — đúng hai trạng thái mà REQ-057a và REQ-057b cần |
| `listProviderSubagents` chỉ có trên `DaemonClient` nội bộ, **không** có trên `PaseoApi` mà plugin nhận | Sub-agent nội bộ của provider chỉ đếm được qua dấu vết `tool_call.detail.type === "sub_agent"` trong timeline |
| Client entry của plugin không đọc được hệ thống file; server entry là Node | Việc đọc `.beads/issues.jsonl` và việc ghi kho lưu vết bắt buộc nằm ở server entry, ra giao diện qua RPC |
| `.beads/issues.jsonl` mỗi dòng có `id`, `status`, `issue_type`, `labels`, `dependencies` (gồm loại `blocks` và `parent-child`), `created_at`, `updated_at`, `closed_at` | Tính được đủ số của REQ-046, gồm cả "sẵn sàng làm" |

**Giả định còn phải kiểm:**

- **A-1:** báo cáo Worker gửi cho Manager bằng `send_agent_prompt` xuất hiện trong timeline của Manager dưới dạng entry `user_message`. Các bản nghiệm thu Phase 1 đều lấy `BM-REPORT` từ "timeline Manager hoặc Worker" nên điều này gần như chắc, nhưng **chưa xác nhận đúng kiểu entry**. Cách kiểm: một lần đọc timeline Manager trên daemon thật, khoảng 10 phút. Nếu sai, phương án đỡ là đọc `BM-REPORT` từ timeline của Worker.
- **A-2:** `timeline` mà hook `agent.turn_ended` cấp có đủ entry của lượt đó kèm `timestamp` (kiểu khai báo là `readonly AgentTimelineItem[]`, tức **không** có `timestamp` như entry của `timeline.refetch`). Nếu đúng là thiếu, bộ thu thập phải gọi thêm một lần `timeline.refetch` cho cửa sổ của lượt vừa xong — vẫn khả thi, chỉ tốn một lời gọi mỗi lượt. Phải kiểm trước khi chốt design.

## 12. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-25 | hieu.nt10 (soạn bởi Beads Worker) | **Áp dụng delta [`prd-delta-20260925-kanban-quiet-colours`](paseo-bm-prd-delta-20260925-kanban-quiet-colours.md)** (owner chốt Q1 a, Q2 a, Q3 a, Q4 a; request `req-20260925T015709Z`): thêm REQ-069 — kanban bốn cột có responsive, trạng thái nói bằng chữ đậm/mờ thay vì màu, ba tab cho màn Setup, thẻ "Errors" ở màn Metric; errata REQ-060 (g), (h), (j), (k), (n) theo đó. (i) "tên bead không in đậm" giữ nguyên. Status giữ Accepted |
| 2026-09-19 | hieu.nt10 (soạn bởi Beads Worker) | **Áp lại delta [`prd-delta-20260918e-beads-tab`](paseo-bm-prd-delta-20260918e-beads-tab.md) sau batch `b6`** (owner chốt Q14 a của request `req-20260918T043115Z`): REQ-060 (a) errata — app mobile của Paseo 0.8 không có "+"; thêm (o) — nút "Beads" trên header của workspace. Status giữ Accepted |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | **Áp dụng delta [`prd-delta-20260918f-remove-pinning`](paseo-bm-prd-delta-20260918f-remove-pinning.md)** (owner chốt Q11 c, duyệt Q14 a; request `req-20260918T063746Z`): REQ-060 (e) bỏ "ghim" — danh sách Workspaces xếp theo hoạt động gần nhất, không ghim. Status giữ Accepted |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | **Áp lại delta [`prd-delta-20260918e-beads-tab`](paseo-bm-prd-delta-20260918e-beads-tab.md) sau batch `b5`**: REQ-060 (m) — bỏ luôn phần tính số tạo/đóng 14 ngày; thêm (n) — số đang làm và số block trên dòng workspace dùng màu vàng và đỏ. Status giữ Accepted |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | **Áp lại delta [`prd-delta-20260918e-beads-tab`](paseo-bm-prd-delta-20260918e-beads-tab.md) sau batch `b4`** (owner chốt Q8–Q12): REQ-060 (g) màu ở tên thay cho cả dòng, (h) chip cùng màu với tên; thêm (j) nút mắt ẩn/hiện bead đã đóng, (k) bốn nhóm, (l) `✓ đã đóng / tổng done`, (m) bỏ biểu đồ 14 ngày. Status giữ Accepted |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | **Áp dụng delta [`prd-delta-20260918e-beads-tab`](paseo-bm-prd-delta-20260918e-beads-tab.md)** (owner chốt Q1–Q7, request `req-20260918T043115Z`): thêm REQ-060 — tab "Beads" trong menu "+" với hai tab con Beads / Metric; Setup là màn chính của Beads Manager, danh sách workspace sau nút "Workspaces"; màu cả dòng và chip theo trạng thái, tên bead không in đậm. Status giữ Accepted |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | **Áp dụng delta [`prd-delta-20260918-manager-mode-model-metrics`](paseo-bm-prd-delta-20260918-manager-mode-model-metrics.md)** (owner chốt Q32, Q38): thêm REQ-058 — model, mức thinking và mode của từng agent; token theo model; thẻ model × vai trò; chi phí theo model thật sự chạy. Status giữ Accepted |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | **Áp dụng delta `design-delta-20260917-workflow-skills`**: REQ-045 thêm bước **review plan** (12 bước) và lấy bằng chứng từ skill; REQ-044 — `ready` lấy từ báo cáo muộn nhất, danh sách id đọc không trọn thì số đếm là suy luận; REQ-048 — lượt Manager nối lại bằng `Continue <requestId>` được gắn đúng request; REQ-052 — tổng chi phí tính theo model của từng bản ghi, token của model không có giá được nêu riêng. Status giữ Accepted |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | **Owner duyệt PRD; cổng `prd-ready` PASS.** Status Review → Accepted. Q-039b (hành vi lệnh gỡ và tên cờ) và Q-043 (`doctor`) vẫn mở và được ghi là điều kiện chặn WP-213 của plan, không chặn phần còn lại |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | **Bản 4 — theo lượt review độc lập bằng Codex.** REQ-047 vốn ghi "file duy nhất được đọc bên ngoài Paseo là `.beads/issues.jsonl`", trái với chính design §3.1 và §12 (phải đọc `install.json` để biết thư mục cài đặt); nay nêu đủ hai đường đọc và giữ nguyên lệnh cấm mọi file khác. Sửa số RPC mới ở §0 từ bốn thành năm (thiếu `traces.reassign` khi thêm REQ-057) |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | **Bản 3 sau khi owner chốt Q-040, Q-041 và một phần Q-039.** Thêm REQ-057 (nhóm "workspace không còn" và chức năng gán lại trace), D-11, J-14; REQ-055 thêm phần cấu hình ngưỡng trong cài đặt plugin kèm ghi nhận cơ chế cài đặt của Paseo chỉ có phạm vi toàn máy; REQ-056 viết lại quanh nguyên tắc **cập nhật phiên bản không bao giờ xoá kho** (gồm cả `--prune` và đường di trú lược đồ). Phần còn mở của Q-039: hành vi mặc định của lệnh gỡ và tên cờ cho chế độ không tương tác |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | **Bản 2 sau khi owner chốt Q-030 → Q-037.** Đổi quyết định nền: **có lưu vết trên đĩa** kèm chức năng xoá — thêm REQ-053 (kho lưu vết bền), REQ-054 (xoá trace), REQ-055 (dung lượng và cảnh báo), REQ-056 (gỡ cài đặt và quyền sở hữu); REQ-047 đổi từ "chỉ đọc" sang "chỉ ghi phần của mình"; REQ-048 yêu cầu che bí mật **trước khi ghi**; REQ-051 và REQ-052 lên P2 (nhãn `bm.requestId`, token và chi phí tạm tính); REQ-049 điền số trần đã chốt. Thêm D-8 → D-10, J-13, ADR-007, và ba câu hỏi mới Q-039 → Q-041. Ghi nhận việc **phải có delta-change** cho PRD gốc REQ-012 và design gốc §3.1/§3.3 |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | Tạo PRD tính năng cho Dashboard điều phối theo yêu cầu của owner (bốn hạng mục: luồng trace và phân rã, chi tiết từng trace, bead và bước quy trình đã làm, thống kê beads). Đặt ở Phase 2 của PRD gốc, hiện thực REQ-030 và phần bảng theo dõi bead. Status Review |
