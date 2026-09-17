# Delta-change — Worker dùng đủ skill quy trình, Reviewer có tiêu chí, hỏi rủi ro, và sửa lỗi của lượt chạy thật 2026-09-16

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260917-workflow-skills` |
| Tài liệu gốc | [Technical Design](./paseo-bm.md) §2.6 (B, E, F); [Technical Design Dashboard](./paseo-bm-dashboard.md) §4.2, §8, §9; [PRD](../product/paseo-bm-prd.md) REQ-024, REQ-026, REQ-034, REQ-036, REQ-037; [PRD Dashboard](../product/paseo-bm-dashboard-prd.md) REQ-044, REQ-045, REQ-052 |
| Thay thế một phần | [delta review-budget](./paseo-bm-delta-20260916-review-budget.md) §4 (dòng "Polish: 0", dòng Metric "polish không cần ở mọi mức", luật "`blocked` hỏi **một** câu"); [delta owner-feedback](./paseo-bm-delta-20260916-owner-feedback.md) §2 (câu "không có polish pass") |
| Status | **Accepted, Applied** — owner hieu.nt10 chốt 10 quyết định ngày 2026-09-17 (§3); áp dụng xong và nghiệm thu trên daemon thật cùng ngày ([biên bản](../operations/paseo-bm-workflow-skills-run-20260917.md)) |
| Plan | [plan delta 20260917-workflow-skills](../plans/paseo-bm-dashboard-implementation-plan-delta-20260917-workflow-skills.md) |
| Nguồn | Lượt chạy thật `~/bm-demo/20260916` (báo cáo `evidence/report-vi.md`, nhật ký `evidence/notes.md` F1–F17, review độc lập `evidence/independent-review.md`); góp ý của owner ngày 2026-09-17 |

> **Cách trình bày của §4 đã được [delta simplify-roles](./paseo-bm-delta-20260917b-simplify-roles.md) viết lại ngày 2026-09-17.** Mười quyết định Q1–Q10 dưới đây **giữ nguyên hiệu lực**; chỉ chỗ đặt và câu chữ trong `roles/*.md` đổi. Một ngoại lệ về nội dung: luật cấm `--force` của §4.10 nay là một vế trong giới hạn W4 thay vì một dòng riêng.

## 1. Owner nói gì

Sau khi đọc báo cáo lượt chạy thật "quản lý user và màn hình login":

> Ngoài lỗi bạn nhìn ra bắt buộc phải sửa cẩn thận. Tôi còn thấy: Không chạy polish bead, không dùng cả skill reviewing plan sau khi plan được lập · Reviewer không dùng skill nào cả · Ít câu hỏi về risk phát sinh · Số lượng bead ít, chứng tỏ implement plan không tốt. Hãy cân nhắc kỹ lưỡng, thật CẨN THẬN.

## 2. Bằng chứng và nguyên nhân gốc

Yêu cầu mẫu thuộc mức Lớn. Kết quả chạy được (102 test, 38/38 kịch bản HTTP), nhưng quy trình có các lỗ hổng sau.

| # | Quan sát | Bằng chứng | Nguyên nhân gốc |
|---|---|---|---|
| 1 | Worker không chạy `reviewing-plan`, `converting-plan-to-beads`, `polishing-beads`, `implementing-beads` | Bằng chứng `skill` của trace chỉ có `feature-workflow` | `worker.md`: "NEVER review your own work, use a review skill, or run a bead polish pass", "there is no polish pass"; không bước nào bảo Worker load bốn skill còn lại |
| 2 | 13 yêu cầu ra 8 bead; bead `.5` gồm route, view, nối server, cấu hình và test | `.beads/issues.jsonl` của repo mẫu | `worker.md` Step 3 chỉ đòi `## Acceptance Criteria` và một dòng Provenance. Bead thiếu hợp đồng leaf 10 mục của `converting-plan-to-beads` (Objective, Scope in/out, Primary Proof, Reversibility…) và không qua luật atom |
| 3 | Reviewer không load skill hay checklist nào; review code pass sau 57 giây nhưng bỏ sót 2 lỗi bảo mật thật | Review độc lập 4,5 phút xác nhận bằng script: POST admin gửi body chậm vẫn ghi sau khi tài khoản bị khoá; username dài làm bộ đếm giữ ~300 MB | `reviewer.md` không nêu tiêu chí theo giai đoạn và cấm chạy mọi lệnh ngoài đọc, nên Reviewer chỉ tin số liệu Worker báo |
| 4 | Ít hỏi rủi ro | Worker tự đổi 3 quyết định bảo mật sau review b1 (có đổi `SESSION_SECRET` làm `.env` cũ hỏng), tự thêm yêu cầu vào PRD, không hỏi | `worker.md`: "Raise a real risk in one sentence at most"; `blocked` chỉ được hỏi "ONE clear question"; không có mốc hỏi rủi ro bắt buộc |
| 5 | Worker hỏi bằng hộp `AskUserQuestion`; không có trả lời thì tự lấy phương án đề xuất rồi làm tiếp | Timeline Worker 15:45:55 → 15:46:58 | Không có luật cấm tự lấy mặc định; kênh hỏi không bắt buộc đi qua `blocked` |
| 6 | Manager báo sai "có vẻ bạn đã trả lời trực tiếp với Worker" | Timeline Manager 15:50:33 | Không có luật "không biết thì nói không biết" |
| 7 | Worker nêu 5 điểm cần xác nhận trong chat nhưng `blockers` chỉ có 4; người dùng chỉ thấy 4 | Báo cáo `beads-done` 15:56:23 | Không có luật "mọi câu hỏi cho người dùng phải nằm trong `blockers`" |
| 8 | `br` không cho đặt `in_progress` khi bead phụ thuộc chưa đóng; suốt 12 phút code mọi bead hiện `open` | `br update --status in_progress` → `cannot claim blocked issue` (br 0.2.10) | `worker.md` chỉ cho đóng bead sau review cuối; `--force` bị cấm |
| 9 | Manager chạy `env \| grep -i 'paseo\|bm_\|agent'` để tìm id của chính nó | Timeline Manager 15:44:48 | Chỉ dẫn bảo ghi "your agent id" mà không nói lấy ở đâu. Paseo đã đặt sẵn `PASEO_AGENT_ID` |
| 10 | Câu trả lời đầu của Manager có đoạn lạc đề về connector Canva | Timeline Manager 15:45:06 | Không có luật bỏ qua thông báo môi trường không liên quan |
| 11 | Manager có 16 lượt, khoảng một nửa chỉ vì Paseo báo "Worker hết lượt"; Worker bị đánh thức 10 lần | `timing.managerTurns`, `task_notification` của Worker | `send_agent_prompt` và `create_agent` mặc định `notifyOnFinish: true` |
| 12 | Worker ghi script thử vào `/tmp` | Timeline Worker 16:07:02, 16:18:39 | Luật "NEVER write outside this workspace" không có đường hợp lệ cho file tạm |
| 13 | Dashboard: `created` 4 / `closed` 4 (thật 11), `ready` 3 (thật 0), tất cả ghi `exact` | `traces.list` cuối lượt | `parseBeadIds` bỏ id rút gọn `.2`, nhận chữ `no-logging` là id; `ready` lấy hợp của mọi báo cáo; `confidence` là `exact` chỉ vì có báo cáo |
| 14 | Dashboard: mỗi câu trả lời của người dùng thành một dòng request `unknown` cho tới báo cáo kế tiếp | `traces.list` 15:58 | `REQUEST_ID_PATTERN` cần chữ `requestId:`; câu nối lại `Continue req-…` mà `manager.md` quy định nằm trong input của tool call, collector không đọc |
| 15 | Dashboard: tổng $17.71 ≠ Manager $0.68 + Worker $14.55 | `traces.get` | `summariseUsage` cộng token của mọi agent rồi tính theo **một** model (model của bản ghi cuối), nên token Codex bị tính giá Opus |
| 16 | Dashboard: ghi file tài liệu bị tính là "implement" | Bằng chứng `file` có đường dẫn tuyệt đối | `DOC_PREFIX` so tiền tố `docs/` với đường dẫn tuyệt đối nên không bao giờ khớp |

## 3. Quyết định của owner (2026-09-17)

| # | Câu hỏi | Chọn |
|---|---|---|
| Q1 | Worker dùng skill ở mức nào | **Lớn đủ 5 skill; Vừa theo điều kiện; Nhỏ giữ đường nhanh** (§4.1) |
| Q2 | Ai chạy `reviewing-plan`, `polishing-beads`; có tính ngân sách không | **Worker chạy; không tính vào ngân sách review** 1 / 4 / 6 (§4.2) |
| Q3 | Reviewer | **Checklist theo giai đoạn, được chạy test sẵn có và script thử trong thư mục tạm; không mạng, không cài, không ghi vào repo; việc chạm auth/quyền/dữ liệu phải ghi các ca tấn công đã thử** (§4.7) |
| Q4 | Hỏi rủi ro | **Vòng hỏi bắt buộc + dừng khi lệch; tối đa 5 câu đánh số qua `blocked`; cấm `AskUserQuestion`; không tự lấy mặc định** (§4.4) |
| Q5 | Đóng bead | **Đóng sau khi bead qua kiểm tra; review cuối có finding chặn thì `br reopen`** (§4.5) |
| Q6 | File tạm | **Chỉ trong thư mục mới tạo bằng `mktemp -d`, xoá khi xong** (§4.6) |
| Q7 | Dashboard | **Thêm bước `review_plan`; các bước lấy bằng chứng từ skill** (§5.5) |
| Q8 | Cỡ bead | **Theo luật atom của skill, không dùng số file hay số dòng** (§4.3) |
| Q9 | Độ dài `worker.md` khi thêm đủ luật mới (khoảng 260 dòng, test đang khoá dưới 240) | **Nâng trần riêng `worker.md` lên 270 dòng**; `reviewer.md` và `manager.md` giữ dưới 240 (hỏi trong lúc implement bead `bm-wp-216-v23.2`) |
| Q10 | Hai luật của §4.10 làm `worker.md` thành 272 dòng | **Nâng trần `worker.md` lên 280 dòng** (2026-09-17, trong lúc implement bead `bm-wp-221-4e8s`); hai file kia giữ dưới 240 |

## 4. Hợp đồng mới cho ba vai trò

### 4.1 Skill theo mức

| Bước | Nhỏ | Vừa | Lớn |
|---|---|---|---|
| Tài liệu | không tạo file mới | chỉ phần bị ảnh hưởng, theo `feature-workflow` | đủ chuỗi theo `feature-workflow` |
| Plan | không | chỉ khi việc cần (nhiều kết quả độc lập, có đồ thị phụ thuộc) | bắt buộc |
| `reviewing-plan` | không | khi có plan | bắt buộc, sau khi viết plan |
| Cổng `plan-ready-for-beads` | không | khi có plan | bắt buộc; PASS thì đặt `Status: Active` và `Plan-ready: PASS — <ngày>` |
| Tạo bead | 1 bead ngắn, tạo tay | có plan → `converting-plan-to-beads`; không có plan → tạo tay theo hợp đồng leaf §4.3 | `converting-plan-to-beads` |
| `polishing-beads` | không | bắt buộc | bắt buộc |
| Implement | tạo tay theo đường nhanh | `implementing-beads` | `implementing-beads` |

Thứ tự đầy đủ của **Lớn**: vòng hỏi lúc nhận việc → tài liệu → plan → `reviewing-plan` → vòng hỏi sau review plan → lô review `b1` (documents, gồm plan) → cổng plan-ready → `converting-plan-to-beads` → `polishing-beads` → lô review `b2` (beads) → vòng hỏi rủi ro + xác nhận của người dùng → `implementing-beads` từng bead → lô review `b3` (implementation) → `finished`.

Thứ tự của **Vừa**: vòng hỏi lúc nhận việc → phần tài liệu bị ảnh hưởng (và plan nếu cần, kèm `reviewing-plan` + cổng) → tạo bead → `polishing-beads` → lô review `b1` (plan: tài liệu + bead) → `implementing-beads` → lô review `b2` (implementation) → `finished`.

**Nhỏ** giữ nguyên đường nhanh: một bead ngắn → sửa → kiểm tra rẻ nhất → một lượt review → đóng → `finished`.

`worker.md` vẫn **đứng trên** mọi skill về: ranh giới an toàn, ngân sách review, cách báo cáo, khi nào phải hỏi, và phạm vi. Skill quyết định **cách làm** (cấu trúc tài liệu, cổng, cách chia bead, preflight). Khi skill bảo hỏi người dùng thì hỏi theo §4.4.

### 4.2 Lượt skill của Worker không phải lượt review

- `reviewing-plan`, `converting-plan-to-beads` (cổng kiểm của nó), `polishing-beads` là **lượt tự hoàn thiện** của Worker. Chúng **không thay** Reviewer và **không tính** vào ngân sách review 1 / 4 / 6.
- Giới hạn:
  - `reviewing-plan`: **1 lượt** cho mỗi plan (và 1 lượt cho mỗi lần plan đổi theo yêu cầu của người dùng);
  - `polishing-beads`: **1 lượt** cho mỗi đợt tạo hay cập nhật bead, cộng **tối đa 1 lượt nhắm vào đúng các bead vừa tách** như skill cho phép;
  - `converting-plan-to-beads`: **1 lần** cho mỗi plan.
- `implementing-beads` chạy cho **từng bead, lần lượt**, không dùng agent con song song. Yêu cầu review theo rủi ro R2/R3 của skill được thoả bằng **lô review implementation** của Reviewer; không thêm lượt review theo từng bead. Khi chọn bead, chỉ chọn trong các bead của request này (lọc theo nhãn), không lấy bead khác mà `bv --robot-next` gợi ý.
- Luật cũ "NEVER review your own work, use a review skill" đổi thành: **lượt skill không bao giờ thay hay được tính là lượt review của Reviewer; Worker không tự review lô của mình thay Reviewer.**

### 4.3 Hợp đồng bead

- **Nhỏ:** một bead ngắn như cũ (tiêu đề một dòng, `## Acceptance Criteria` một dòng, `## Provenance` một dòng).
- **Vừa và Lớn:** mỗi leaf theo hợp đồng của `converting-plan-to-beads` (`reference/leaf-bead-checklist.md`): Objective, Context, Scope (in và out), Components, Dependencies, Assumptions, Validation, **Primary Proof**, **Reversibility**, Provenance. Vẫn giữ các heading `br lint` đòi hỏi (`## Acceptance Criteria` cho task/feature; `## Steps to Reproduce` + `## Acceptance Criteria` cho bug; `## Success Criteria` cho epic). `## Provenance` ghi `requestId` và yêu cầu gốc trích một dòng.
- **Luật atom** (của skill, không tự đặt thêm): mỗi leaf là **một kết quả review được và hoàn tác được độc lập**; test đi cùng kết quả của nó; không chia máy móc theo tầng hay theo file; hai phần review, merge hay hoàn tác được riêng thì phải tách. **Không dùng số file, số dòng hay số bead làm tiêu chí.**
- `implementing-beads` chạy preflight GO/SPLIT/BLOCK trước mỗi bead. Ra SPLIT thì:
  - tạo các bead **anh em** dưới cùng bead cha, mỗi bead ghi `Split-from: <id>`;
  - chuyển cạnh phụ thuộc của bead gốc sang bead anh em cần nó;
  - viết lại bead gốc còn phần của nó, hoặc đóng với lý do "split into <ids>";
  - không xoá bead.

  **Không** dùng mẫu "bead gốc làm điểm nối, phụ thuộc bead con" của skill. Với `br` 0.2.10, bead con bị chặn khi bead cha bị chặn, nên mẫu đó khoá chết (đã thử ngày 2026-09-17).

### 4.4 Hỏi quyết định và rủi ro

**Mốc hỏi bắt buộc** (Vừa và Lớn):

1. **Lúc nhận việc**, trước khi viết tài liệu: các quyết định sản phẩm và bảo mật còn mở, và **ranh giới phạm vi** (phần nào nằm ngoài yêu cầu).
2. **Sau `reviewing-plan`**: những điểm skill để lại cho người dùng ("open decision"), và rủi ro skill phát hiện.
3. **Cổng xác nhận của Lớn**: danh sách rủi ro — thay đổi hành vi với người dùng hiện có, thay đổi cấu hình hay secret, di trú, tương thích, đánh đổi bảo mật, và mọi yêu cầu **đã thêm ngoài câu chữ của người dùng** — rồi xin xác nhận.

Mốc không có gì để hỏi thì bỏ qua, không hỏi lấy lệ.

**Dừng và hỏi khi đang làm** (mọi mức), trước khi làm tiếp:
- lệch khỏi tài liệu đã duyệt;
- đổi hành vi với người dùng hiện có, hoặc đổi cấu hình hay secret đang dùng;
- thêm yêu cầu ngoài câu chữ của người dùng;
- đánh đổi bảo mật;
- finding của Reviewer làm đổi thiết kế đã duyệt.

**Cách hỏi:**
- Gộp các câu của cùng một mốc, **tối đa 5 câu, đánh số**. Mỗi câu có các phương án, phương án đề xuất, và Worker sẽ làm gì với từng phương án.
- Viết trong chat **và** gửi `BM-REPORT` `phase: blocked` với **toàn bộ** câu hỏi trong `blockers`, rồi dừng lượt và chờ.
- **Cấm** `AskUserQuestion` và mọi công cụ hỏi tương tác khác.
- **Không bao giờ** tự chọn mặc định rồi làm tiếp khi câu hỏi chưa có trả lời.
- Mọi điểm cần người dùng xác nhận **phải nằm trong `blockers`**; chat và báo cáo không được lệch nhau.
- Luật cũ "raise a real risk in one sentence at most" chỉ còn áp cho trường hợp người dùng đã tự đặt mức hay cách làm.

### 4.5 Implement, đóng bead, việc sau `finished`

1. Làm từng bead: `br update <id> --status in_progress` → implement → chạy kiểm tra chứng minh bead đó → **`br close <id> --reason "<lệnh và kết quả>"`**. Chỉ một bead `in_progress` tại một thời điểm.
2. Xong mọi bead thì review **một lô** implementation: toàn bộ bead, toàn bộ diff, các kiểm tra cùng kết quả.
3. Finding **chặn** rơi vào bead đã đóng thì `br reopen <id>`, sửa, kiểm lại, đóng lại kèm bằng chứng mới, rồi xin lượt kiểm lại của lô đó.
4. Người dùng yêu cầu thêm thay đổi sau `finished` (cùng `requestId`) thì đó là **lô mới** `b<n+1>`: 1 lượt review, cộng 1 lượt kiểm lại nếu còn mục chặn. Nếu vượt ngân sách thì hỏi trước.
5. Không bao giờ dùng `--force`.

### 4.6 File tạm

- Chỉ được ghi ngoài workspace vào **một thư mục mới tạo bằng `mktemp -d`**. Dùng cho script thử, bản sao mã để làm đối chứng âm, DB tạm.
- Xoá thư mục đó trước khi báo cáo.
- Không chép secret (`.env`, credential, key) vào đó.
- Mọi chỗ khác ngoài workspace vẫn cấm ghi.

### 4.7 Reviewer

**Tiêu chí theo giai đoạn** (chỉ đọc; skill sửa được thì dùng làm tiêu chí, không làm theo phần sửa):

| Giai đoạn | Load |
|---|---|
| `documents` | `feature-workflow`: `checklists/prd-ready.md`, `checklists/design-ready.md`, `references/decision-gates.md` |
| `plan` (Vừa) hoặc plan trong `documents` (Lớn) | `reviewing-plan` ở **chế độ chỉ review** (không sửa plan) + `feature-workflow/checklists/plan-ready-for-beads.md`; với bead trong lô `plan` của Vừa, thêm hai checklist của giai đoạn `beads` |
| `beads` | `converting-plan-to-beads/reference/leaf-bead-checklist.md` + `polishing-beads/reference/readiness-checklist.md`; lệnh đọc `br show`, `br list`, `br dep tree`, `br ready`, `br lint` |
| `implementation` | `implementing-beads`: preflight, Hard Split Triggers, bảng rủi ro R0–R3 |

Skill không có trên máy thì ghi vào `notChecked` và review theo luật của file này.

**Được chạy:**
- lệnh test sẵn có của repo;
- lệnh lint hay typecheck **không ghi file**;
- script thử viết trong thư mục mới tạo bằng `mktemp -d`.

**Vẫn cấm:** mạng, cài đặt, build ghi ra file, formatter, migration, lệnh ghi của `br`/`bd`, mọi thao tác git làm đổi trạng thái, sửa file trong repo.

Chạy `git status --porcelain` trước và sau khi chạy lệnh. Nếu kết quả khác nhau thì ghi rõ vào `notChecked` và **không** tự dọn.

**Chiều sâu:** lô chạm xác thực, quyền, dữ liệu hay hợp đồng công khai phải ghi trong `checked` **các ca tấn công và ca biên đã thử**. Ví dụ: đi vòng kiểm quyền, thu hồi phiên, race giữa kiểm và ghi, input xấu, tài nguyên không giới hạn, lộ secret.

**Hiệu chỉnh "chặn":**
- Siết thêm ngoài yêu cầu và ngoài thiết kế đã duyệt là **non-blocking**, trừ khi đó là lỗi khai thác được trong chính thứ vừa làm.
- Trong lô `beads`, **hoặc với bead trong lô `plan` của Vừa** (Vừa không có lô `beads` riêng), một leaf gộp nhiều kết quả review hay hoàn tác được độc lập, hoặc thiếu Primary Proof/Reversibility (Vừa, Lớn), là **chặn**.

**Định dạng:** không có finding thì ghi đúng `findings: none`, không viết một finding có mọi trường là `none`.

### 4.8 Manager

- Id của chính mình lấy bằng `echo "$PASEO_AGENT_ID"`. **Không** in, lọc hay tìm trong biến môi trường.
- Không nhắc thông báo của công cụ, connector hay hệ thống không liên quan tới yêu cầu.
- Không biết thì nói không biết. Ví dụ: không suy ra người dùng đã trả lời Worker hay chưa.
- Khi `blocked`, hiện **mọi** câu trong `blockers`, đánh số, kèm phương án. Được dài hơn "vài dòng" cho riêng phần này.
- Thông báo của Paseo rằng Worker hết lượt mà **không có** `BM-REPORT` mới:
  - Worker lỗi hoặc đang chờ quyền → báo người dùng;
  - còn lại → trả lời **một dòng** trạng thái.
- **Giám sát skill** như giám sát ngân sách: báo cáo `finished` của Vừa/Lớn thiếu skill bắt buộc trong `skillsUsed` (§4.9) thì **báo người dùng** skill nào thiếu. Không huỷ lượt của Worker.
- Danh sách skill bắt buộc để kiểm máy **không đổi**.

### 4.9 `BM-REPORT`

- Thêm trường **`skillsUsed: <tên skill, cách nhau dấu phẩy> | none`**, đặt ngay sau `buildAndTests`. Ghi các skill Worker đã load cho request này, tính tới thời điểm báo cáo.
- Các trường danh sách bead chỉ chứa **id đầy đủ**, cách nhau bằng dấu phẩy, không chú thích. Ghi chú đưa sang `blockers` hoặc bỏ đi.
- Worker gửi báo cáo bằng `send_agent_prompt` với **`notifyOnFinish: false`**.
- Các mốc báo cáo không đổi: `received`, `beads-done` (Vừa, Lớn), `blocked`, `finished`.

### 4.10 Sửa sau lượt nghiệm thu 2026-09-17

Owner yêu cầu sửa các chỗ sai của quy trình sau khi đọc biên bản nghiệm thu. Năm luật dưới đây: ba từ hành vi quan sát được trong lượt chạy, hai từ lỗi của chính người chạy (Claude) khi implement delta này — cùng một loại sai mà Worker có thể mắc.

| # | Luật | Vì sao |
|---|---|---|
| 1 | `manager.md`: nhận `beads-done` của việc **Lớn** thì nói rõ Worker đang chờ người dùng xác nhận; không được nói Worker đã bắt đầu code | 01:30:43 Manager báo "Worker chuyển sang viết code", 10 giây sau báo cáo `blocked` mới đính chính |
| 2 | `worker.md`: xoá thư mục `mktemp -d` **ngay khi xong việc cần nó**, chậm nhất là trước báo cáo kế tiếp | Thư mục bản nháp bead còn tới hết lượt |
| 3 | `worker.md`: **một lượt review = một tin nhắn gửi Reviewer** (tin tạo agent, hoặc tin xin kiểm lại). Lô có kiểm lại tính 2 | Worker báo `total 5/6`, thực tế 4 |
| 4 | `worker.md`: **NEVER sửa test, khẳng định trong test, hay tiêu chí chấp nhận của bead để một kiểm tra chuyển sang đạt.** Kiểm tra đỏ nghĩa là mã sai, hoặc bead sai: sửa mã, hoặc dừng hỏi người dùng. `reviewer.md`: test bị nới lỏng cho khớp mã là finding **chặn** | Người chạy đã sửa test cho khớp mã thay vì sửa mã theo tiêu chí bead (`bm-wp-215-60a.2`); chỉ review độc lập mới bắt được |
| 5 | `worker.md`: trước khi đóng bead, **đọc kết quả của lệnh kiểm tra** (mã thoát, dòng tổng kết). Lệnh in ra lỗi không phải bằng chứng; không bao giờ đóng bead trong cùng một chuỗi lệnh với lần chạy kiểm tra | Người chạy đóng `bm-wp-216-v23.2` khi `npm test` đang đỏ, vì lệnh đóng nối sau một `grep` vẫn khớp |

Luật 4 và 5 áp cho mọi mức, kể cả đường nhanh của Nhỏ.

Bản đầu của luật 4 viết "chỉ sửa test khi bead yêu cầu", và review của chính bead `bm-wp-221-4e8s` chỉ ra đó là lỗ hổng: Worker tự viết bead nên có thể sửa bead sau khi kiểm tra đỏ rồi mới sửa test. Bản chốt: **chỉ sửa test khi bead đã yêu cầu điều đó TRƯỚC khi chạy kiểm tra; viết lại bead để cho phép cũng là vi phạm.** Cùng lượt đó, luật cấm `rm -rf` đổi từ "file bạn không tạo cho bead" thành "bất cứ thứ gì bạn không tự tạo", để việc xoá thư mục `mktemp -d` của chính mình (kể cả tạo ở giai đoạn tài liệu) vẫn hợp lệ.

## 5. Dashboard

### 5.1 Đọc danh sách bead (sửa cả `plugin/server/bm-report.ts` và `plugin/shared/bm-report.ts`)

1. Xét từng nhóm trong ngoặc đơn `( … )` trước khi tách:
   - mọi mảnh bên trong đều là id bead → bỏ ngoặc, giữ id. Đây là cách đọc cũ, test `(bm-wp-202-4xi.1).` đang khoá nó;
   - ngược lại → bỏ **cả nhóm**. Ví dụ `(epic)`, `(b2 fix: no-logging AC)`.
2. Tách theo dấu phẩy, dấu chấm phẩy và khoảng trắng như cũ.
3. Mảnh dạng `.<số>` (có thể lặp, ví dụ `.2` hay `.2.1`) được mở thành id đầy đủ. Gốc là **id đầy đủ gần nhất đứng trước**, bỏ **mọi** đuôi `.<số>`.
   - `x-gcj, x-gcj.1, .2` → `x-gcj`, `x-gcj.1`, `x-gcj.2`.
   - `x-gcj.2.1, .2.2` → `x-gcj.2.1`, `x-gcj.2.2`.
   - Không có id đầy đủ đứng trước thì bỏ mảnh đó.
4. Mảnh không phải id cũng không phải `none` (sau bước 1) làm danh sách **không đầy đủ**. Bộ đọc ghi tên trường đó vào `incompleteFields` của báo cáo đã đọc.
5. Đếm: một trường có tên trong `incompleteFields` của bất kỳ báo cáo nào thì số đếm của trường đó mang `confidence: "inferred"` (là **cận dưới**). Bản ghi cũ không có `incompleteFields` thì giữ cách tính cũ.

### 5.2 `ready`

`ready` là **trạng thái**, không phải hành động cộng dồn. Số đếm lấy từ **báo cáo muộn nhất** của trace có trường `beadsReady` (`none` = 0). `created`, `updated`, `closed` vẫn là hợp của mọi báo cáo.

### 5.3 Gắn lượt Manager vào request

- Collector đọc thêm input của tool call Manager tên `send_agent_prompt` (so theo phần tên sau `__` cuối cùng, hoặc cả tên).
- Nếu `input.prompt` khớp `^\s*Continue\s+(req-\d{8}T\d{6}Z)\b` thì dùng id đó làm `requestId` của lượt, **sau cùng** trong chuỗi ưu tiên: nhãn → báo cáo → prompt nhận vào → câu nối lại.
- Không đọc id trần trong câu trả lời của Manager: câu đó có thể nhắc request khác.
- Chỉ áp cho bản ghi mới; bản ghi cũ vẫn được gộp theo luật "request được nhắc tới kế tiếp".

### 5.4 Chi phí theo model

- Tổng của một trace = **tổng chi phí từng bản ghi**, mỗi bản ghi tính theo **model của chính nó**.
- `model` của tổng: là model đó nếu mọi bản ghi có token cùng một model; ngược lại là `null`.
- `costUsd` của tổng: tổng các phần có giá, hoặc `null` nếu không phần nào có giá.
- `costBasis`: `estimated` nếu có ít nhất một phần có giá, ngược lại `unavailable`.
- Có token của model không có giá thì trace thêm notice: `Cost excludes <n> tokens from models without a price: <model, …>.`
- Chi phí vẫn luôn là tạm tính (§9 thiết kế Dashboard không đổi).

### 5.5 Bước feature-workflow

Danh sách thành **12 bước**: thêm `review_plan` ngay sau `plan`. Nhãn hiển thị: "Plan reviewed".

| Bước | `exact` | `inferred` |
|---|---|---|
| `review_plan` (mới) | `skillsUsed` có `reviewing-plan` | bằng chứng `skill` `reviewing-plan` của Worker hoặc Reviewer của trace |
| `convert_to_beads` | như cũ, thêm: `skillsUsed` có `converting-plan-to-beads` | như cũ, thêm: bằng chứng `skill` `converting-plan-to-beads` |
| `polish_beads` | `skillsUsed` có `polishing-beads`; hoặc `guardrail` cũ ghi `polish n/max` với n ≥ 1 | bằng chứng `skill` `polishing-beads`; hoặc `br update` chạm ≥ 2 bead khác nhau (như cũ) |
| `implement` | `phase: bead-implemented` (báo cáo cũ); hoặc `skillsUsed` có `implementing-beads` | ghi hay sửa file **trong workspace**, ngoài `docs/` và `.beads/` |

**Phủ định chính xác:**
- chỉ khi `guardrail` **ghi rõ** `polish 0` (báo cáo cũ). `guardrail` không có đoạn `polish` thì **không** phải phủ định;
- báo cáo `finished` có `skillsUsed` mà thiếu `reviewing-plan` → `review_plan` là `skipped`; thiếu `polishing-beads` → `polish_beads` là `skipped`. Cả hai kèm ghi chú nêu skill thiếu, như tiền lệ `polish 0` ở §8.
- Luật phủ định này **chỉ** áp cho hai bước đó, vì với chúng skill chính là định nghĩa của bước. `convert_to_beads` và `implement` còn bằng chứng dương khác (bead tạo tay, file đã sửa, bead đã đóng), nên thiếu `converting-plan-to-beads` hay `implementing-beads` trong `skillsUsed` **không** làm chúng thành `skipped`.

**Được `skipped` theo mức:**
- Nhỏ: `prd`, `design`, `adr`, `plan`, `review_plan`, `polish_beads`;
- Vừa: `review_plan` (plan là tuỳ việc);
- Lớn: không bước nào.

**Đường dẫn:** bằng chứng `file` tuyệt đối được đổi thành đường dẫn tương đối theo thư mục của workspace (`lastKnownDirectory` trong meta của kho lưu vết). Đường dẫn nằm ngoài workspace **không** là bằng chứng implement. Không biết thư mục của workspace thì đường dẫn tuyệt đối không được tính.

## 6. Rủi ro và đánh đổi

- **Tốn hơn và lâu hơn.** Worker đọc thêm bốn skill dài và làm thêm lượt tự hoàn thiện. Lượt mẫu tốn khoảng $17.5 cho Worker; dự kiến tăng. Đổi lại là plan và bead tốt hơn, ít sửa lại hơn.
- **Hỏi nhiều hơn nên chờ nhiều hơn.** Giới hạn 5 câu mỗi mốc, không hỏi lấy lệ.
- **Reviewer chạy test** thì ranh giới "không ghi vào repo" chỉ là ràng buộc hành vi, cộng với việc tự kiểm `git status`. Test của một repo lạ có thể ghi file (cache, coverage); Reviewer phải báo chứ không dọn.
- **File tạm ngoài workspace** là một nới lỏng có kiểm soát, cũng chỉ dựa vào chỉ dẫn.
- **Agent tạo trước khi cập nhật** giữ chỉ dẫn cũ suốt đời nó.
- **Bản ghi trace cũ** giữ số đếm và liên kết cũ (chỉ §5.4 và §5.5 tính lại khi đọc).
- **Hợp đồng RPC**: `workflowStepSchema` thêm một giá trị. Client và server đóng gói cùng nhau nên không lệch phiên bản; bước được suy ra lúc đọc, không nằm trong kho.

## 7. Không đổi

- Ngân sách review 1 / 4 / 6, cách gom lô, một lượt kiểm lại gửi cho **cùng** Reviewer.
- Cách phân mức và các ví dụ.
- Luật cứng của Worker và Reviewer (không commit, không phá huỷ, không đọc secret, hỏi trước khi cài, dùng mạng, migration). Reviewer vẫn không sửa gì và không tạo agent.
- Manager vẫn chỉ chuyển lời, không quyết thay người dùng.
- Danh sách skill bắt buộc để kiểm máy.
- Chi phí luôn là tạm tính. **Ghi nhận, chưa làm:** lấy chi phí do provider báo bằng hiệu `totalCostUsd` giữa hai lượt của cùng agent. Việc này đổi quyết định §9 của thiết kế Dashboard nên cần owner quyết riêng.
- Không thêm trường riêng cho rủi ro trong `BM-REPORT`: câu hỏi rủi ro nằm trong `blockers`.
- **Ghi nhận từ review độc lập `bm-wp-220-nvk.1`, owner chọn chưa sửa:**
  - `ready` không phân biệt báo cáo thiếu dòng `beadsReady` với báo cáo ghi `none`, vì bộ đọc lưu cả hai thành danh sách rỗng;
  - từ có dạng id nằm ngoài ngoặc (ví dụ `follow-up`) vẫn được đếm là bead (có từ trước delta này);
  - id rút gọn `.N` nằm trong một nhóm ngoặc bị bỏ thì mất theo, mà không đánh dấu danh sách chưa đầy đủ.

## 8. Ảnh hưởng tài liệu

- `docs/design/paseo-bm.md` §2.6 E và F: thêm dòng errata trỏ về delta này.
- `docs/design/paseo-bm-dashboard.md` §8: thêm dòng errata trỏ về delta này.
- `docs/product/paseo-bm-prd.md` và `docs/product/paseo-bm-dashboard-prd.md`: thêm một dòng Revision History (PRD giữ `Accepted`).
- `README.md`: bảng mức, mục Worker (bỏ câu "no bead polish pass"), mục review, mục báo cáo, mục câu hỏi.
- `AGENTS.md`, mục "Verified facts": thêm năm sự thật:
  - `PASEO_AGENT_ID`;
  - `br` chặn claim khi bead phụ thuộc chưa đóng, `br reopen` dùng được;
  - lệnh đọc của `br` không ghi file;
  - bead con của `br` bị chặn khi bead cha bị chặn, nên bead phụ thuộc chính bead con của nó sẽ khoá chết;
  - `notifyOnFinish` của `send_agent_prompt` và `create_agent`.

## 9. Revision History

| Ngày | Người | Thay đổi |
|---|---|---|
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | Tạo, Accepted theo 8 quyết định của owner ở §3 |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | Thêm Q9 (trần 270 dòng cho `worker.md`); làm rõ §4.3 (tách bead thành bead anh em) và §5.1 (nhóm trong ngoặc, gốc của id rút gọn) |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | Errata theo review độc lập `bm-wp-220-nvk.1` (B3): tiêu chí bead và luật "leaf gộp là chặn" áp cả cho bead trong lô `plan` của Vừa (§4.7) |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | §7 ghi ba điểm review không chặn mà owner chọn chưa sửa; 13 điểm còn lại sửa trong bead `bm-wp-220-nvk.4` |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | **Applied**: WP-215 → WP-220 đóng hết; nghiệm thu đạt sáu điều kiện ra; còn NEW-1 (sandbox Codex chặn cổng nên Reviewer không chạy được test HTTP) chờ owner quyết, NEW-2/3/4 ở bead `bm-wp-221-ain9` |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | Thêm §4.10 theo yêu cầu owner "chỗ làm sai trong quy trình thì sửa đi": ba luật từ lượt nghiệm thu (bead `bm-wp-221-ain9`) và hai luật chống sửa test / đóng bead khi kiểm tra đỏ (bead mới) |
