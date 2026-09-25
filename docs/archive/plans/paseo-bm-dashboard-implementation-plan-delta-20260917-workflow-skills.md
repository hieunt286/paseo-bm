# Delta plan — Worker dùng đủ skill, Reviewer có tiêu chí, hỏi rủi ro, sửa lỗi lượt chạy thật 2026-09-16

| Trường | Giá trị |
|---|---|
| Mã | `plan-delta-20260917-workflow-skills` |
| Plan gốc | [Dashboard Implementation Plan](paseo-bm-dashboard-implementation-plan.md) (Active, Plan-ready PASS) — **không sửa tại chỗ**; delta này thêm WP-215 → WP-220 vào Phase 2a-2 |
| Status | **Completed** (2026-09-25) — mọi bead của plan đã đóng; từ nay tài liệu sống thay cho chuỗi delta (xem `AGENTS.md`, mục Process). Trạng thái trước: **Applied** — mọi WP đóng ngày 2026-09-17, nghiệm thu đạt ([biên bản](../operations/paseo-bm-workflow-skills-run-20260917.md)) |
| Plan-ready | **PASS — 2026-09-17 — hieu.nt10** (cổng `plan-ready-for-beads` do Claude tự đánh giá sau một lượt `reviewing-plan`; nội dung theo 8 quyết định owner chốt cùng ngày) |
| Owner | hieu.nt10 |
| Created | 2026-09-17 |
| Source design | [design-delta-20260917-workflow-skills](../design/paseo-bm-delta-20260917-workflow-skills.md) (Accepted) — nguồn duy nhất cho mọi quy tắc, tên trường và định dạng dưới đây |
| Source PRD | [PRD](../../product/paseo-bm-prd.md) REQ-024, REQ-026, REQ-034, REQ-036, REQ-037; [PRD Dashboard](../../product/paseo-bm-dashboard-prd.md) REQ-044, REQ-045, REQ-052 |
| Routing decision | Brownfield, rủi ro **cao**: đổi hợp đồng hành vi của cả ba agent (chỉ dẫn là "mã" chạy trên hệ thống không xác định và không đảo ngược được với agent đã tạo), đổi hợp đồng `BM-REPORT` mà Dashboard đọc, thêm một giá trị vào hợp đồng RPC `workflowStepSchema`, và nới hai ranh giới an toàn (Reviewer chạy test; Worker ghi thư mục tạm). Đi đủ chuỗi: delta thiết kế → delta plan → `reviewing-plan` → cổng `plan-ready-for-beads` → `converting-plan-to-beads` → `polishing-beads` → `implementing-beads` → nghiệm thu thật |
| Phase | Phase 2a-2 MVP (nhãn bead `phase:2a-2`) |

## 1. MVP-Lock

- **Trong phạm vi:** toàn bộ §4 và §5 của delta thiết kế, cùng các cập nhật tài liệu ở §8 của nó.
- **Ngoài phạm vi:**
  - chi phí do provider báo (hiệu `totalCostUsd`), xem delta thiết kế §7;
  - tính lại số đếm của bản ghi trace cũ;
  - đổi ngân sách review;
  - đổi danh sách skill bắt buộc;
  - phát hành lên npm.
- **Điều kiện ra của delta:**
  1. `npm run verify` xanh.
  2. Plugin chạy bản mới trên daemon của máy owner.
  3. Một lượt yêu cầu **Lớn** thật cho thấy:
     - Worker load đủ 5 skill;
     - Reviewer load tiêu chí theo giai đoạn;
     - có vòng hỏi lúc nhận việc;
     - bead có đủ hợp đồng leaf;
     - Dashboard đếm đúng bead và liên kết đúng câu trả lời của người dùng.
- **Tư thế checkpoint mặc định:**
  - Mọi thay đổi nằm trong working tree, không commit (owner tự commit), nên hoàn tác là trả các file của WP về như trước.
  - Plugin chạy trên daemon hoàn tác bằng cách cài lại payload trước đó; `~/.paseo/config.json` được sao lưu trước khi cài (WP-220).
  - **Điểm không đảo ngược:** agent tạo bằng chỉ dẫn mới giữ chỉ dẫn đó suốt đời; muốn quay lại thì tạo agent mới sau khi hoàn tác.
  - Bản ghi trace mới có thêm trường tuỳ chọn; bản cũ của plugin đọc chúng được (trường lạ bị bỏ qua), nên không có bước di trú.

## 2. Work Packages

### WP-215: Hợp đồng `BM-REPORT` mới và bộ đọc

- **Outcome:**
  - Bộ đọc báo cáo (`plugin/server/bm-report.ts` và bản chung `plugin/shared/bm-report.ts`) đọc trường mới `skillsUsed`.
  - Danh sách bead: bỏ đoạn trong ngoặc, mở id rút gọn `.<số>`, và ghi `incompleteFields` khi còn mảnh không đọc được.
  - Hai bản của bộ đọc giữ giống nhau (khác đúng dòng import như hiện nay).
  - `parsedReportSchema` (`plugin/shared/contracts.ts`) thêm `skillsUsed` và `incompleteFields`, đều là mảng chuỗi **mặc định rỗng**. Lý do: kho trace đọc bản ghi qua `traceRecordSchema.safeParse`, và trường không khai báo bị bỏ đi. Không tăng `TRACE_STORE_SCHEMA_VERSION`: thay đổi chỉ thêm, bản ghi cũ vẫn hợp lệ.
  - Thẻ chat (`plugin/client/chat-cards.ts`) không đổi hiển thị; số bead trên thẻ tự đúng hơn nhờ bộ đọc.
- **Requirement / AC coverage:** PRD Dashboard REQ-044 (b)(c), REQ-050 (b); PRD REQ-034 (b).
- **Design refs:** delta thiết kế §4.9, §5.1.
- **Prerequisites:** không.
- **Risk boundaries:**
  - Bản ghi trace lưu báo cáo **đã đọc**, nên thay đổi chỉ tác dụng với bản ghi mới.
  - `incompleteFields` là trường tuỳ chọn: bản ghi cũ không có trường này vẫn đọc được.
  - Không được đổi cách đọc các trường cũ, kể cả `guardrail` có hoặc không có `polish`.
- **Exit condition:** test bộ đọc (cả hai bản) với đúng các chuỗi của lượt chạy mẫu:
  - `beadsCreated: x-gcj (epic), x-gcj.1, .2, .3` → 4 id, không có `incompleteFields`;
  - `beadsUpdated: x-gcj.5 (b2 fix: no-logging AC)` → 1 id;
  - `.2` đứng đầu danh sách → bị bỏ và trường vào `incompleteFields`;
  - `x-a, and x-b` → `incompleteFields`;
  - `skillsUsed: feature-workflow, reviewing-plan` → 2 tên; `skillsUsed: none` → rỗng;
  - báo cáo không có `skillsUsed` → rỗng, không lỗi;
  - một bản ghi trace không có hai trường mới vẫn qua `traceRecordSchema` (với giá trị rỗng);
  - một bản ghi có hai trường đó ghi xuống rồi đọc lại vẫn còn nguyên.

  Test hiện có của bộ đọc vẫn xanh (sửa kỳ vọng nào thì ghi lý do trong test).

### WP-216: Chỉ dẫn ba vai trò theo hợp đồng mới

- **Outcome:** `plugin/roles/worker.md`, `reviewer.md`, `manager.md` viết lại theo delta thiết kế §4.1 → §4.9; chỉ dẫn nhúng được sinh lại; `test/roles-content.test.ts` khoá các **quy tắc** mới.
- **Requirement / AC coverage:** PRD REQ-024, REQ-026, REQ-032 (b), REQ-034, REQ-036 (a)(d)(e), REQ-037 theo delta.
- **Design refs:** delta thiết kế §4 (từng mục), §7.
- **Prerequisites:** WP-215 (tên và vị trí trường `skillsUsed` phải khớp bộ đọc).
- **Risk boundaries:**
  - Đây là "mã" viết bằng tiếng Anh cho một hệ thống không xác định; agent đã tạo giữ bản cũ.
  - Ba file vẫn phải **mở đầu bằng `## RULES`**. `reviewer.md` và `manager.md` **dưới 240 dòng**; `worker.md` **dưới 280 dòng** (owner nâng trần: Q9 rồi Q10 của delta thiết kế). Thêm quy tắc thì phải viết gọn, không lặp.
  - Giữ nguyên văn những gì code phụ thuộc: khối `BM-REPORT` (thêm đúng một dòng `skillsUsed`), khối `BM-REVIEW`, dòng `BM-REVIEW STOPPED`, các nhãn `bm.*`, cách chọn mode.
  - Không nới luật cứng nào ngoài hai chỗ owner đã duyệt (Reviewer chạy test và script thử trong `mktemp -d`; Worker ghi file tạm trong `mktemp -d`).
- **Exit condition:** `test/roles-content.test.ts` khẳng định, cho từng file:
  - **worker.md:**
    - bảng skill theo mức;
    - lượt skill không tính ngân sách và không thay Reviewer; giới hạn lượt;
    - hợp đồng leaf 10 mục cho Vừa/Lớn và luật atom không dùng số file/dòng;
    - bốn mốc hỏi, tối đa 5 câu, cấm `AskUserQuestion`, không tự lấy mặc định, mọi câu hỏi nằm trong `blockers`;
    - đóng bead sau kiểm tra, `br reopen`, không `--force`;
    - lô mới sau `finished`;
    - `mktemp -d`;
    - `notifyOnFinish: false`;
    - id đầy đủ, không chú thích;
    - dòng `skillsUsed` trong khối báo cáo;
    - vẫn còn mọi luật cứng cũ.
  - **reviewer.md:**
    - bảng tiêu chí theo giai đoạn, `reviewing-plan` chế độ chỉ review;
    - lệnh được chạy và lệnh cấm; `git status --porcelain` trước và sau;
    - ghi ca tấn công cho lô nhạy cảm;
    - siết thêm là non-blocking;
    - leaf gộp nhiều kết quả là chặn;
    - `findings: none`;
    - vẫn không sửa gì và không tạo agent.
  - **manager.md:**
    - `PASEO_AGENT_ID`, không in biến môi trường;
    - không nhắc thông báo không liên quan;
    - không biết thì nói không biết;
    - hiện mọi câu trong `blockers`;
    - thông báo không có báo cáo → một dòng;
    - giám sát `skillsUsed`, báo chứ không huỷ.

  Test byte-match của chỉ dẫn nhúng xanh; giới hạn dòng như trên.

### WP-217: Dựng trace — `ready`, câu nối lại của Manager, chi phí theo model

- **Outcome:**
  - `ready` lấy từ báo cáo muộn nhất có trường đó.
  - Số đếm mang `inferred` khi trường có tên trong `incompleteFields`.
  - Collector đọc `Continue <req-id>` ở đầu input `prompt` của tool call `send_agent_prompt` của Manager và dùng làm `requestId` cuối chuỗi ưu tiên.
  - Tổng usage của trace tính giá theo model của từng bản ghi và thêm notice khi có token không có giá.
  - Tổng chi phí ở màn tổng quan không còn gồm token bị tính sai giá.
- **Requirement / AC coverage:** PRD Dashboard REQ-044 (b), REQ-048, REQ-052 (a)(c)(d).
- **Design refs:** delta thiết kế §5.1 (bước 5), §5.2, §5.3, §5.4; thiết kế Dashboard §6, §9.
- **Prerequisites:** WP-215 (`incompleteFields`).
- **Risk boundaries:**
  - Luật "request được nhắc tới kế tiếp" và luật id trần của Worker/Reviewer **không đổi**.
  - Chỉ nhận mẫu có neo đầu chuỗi, để một câu nhắc chéo request khác không làm sai liên kết.
  - Không dùng `totalCostUsd`.
  - Không đổi `usageSchema`; notice dùng mảng `notices` sẵn có.
- **Exit condition:** test:
  - trace có `beads-done` với 3 bead sẵn sàng rồi `finished` với `beadsReady: none` → `ready` = 0;
  - trường có `incompleteFields` → `inferred`;
  - lượt Manager chỉ có tool call `send_agent_prompt` với prompt `Continue req-20260916T154448Z.\n\n…` → bản ghi có `requestId` đó, và trace không còn dòng tạm;
  - prompt có `req-…` ở giữa câu → không gắn;
  - trace có bản ghi `claude-opus-5` và `gpt-5.6-sol` → tổng bằng đúng tổng chi phí từng agent, `model` null, notice nêu `gpt-5.6-sol`;
  - trace chỉ một model → như cũ;
  - bản ghi cuối là model không có giá → tổng vẫn có tiền của phần có giá.

  Test hiện có của collector, dựng trace, chi phí và dashboard model vẫn xanh, hoặc được sửa kỳ vọng kèm lý do.

### WP-218: Bước feature-workflow theo skill, thêm `review_plan`

- **Outcome:**
  - `workflowStepSchema` và `WORKFLOW_STEPS` có 12 bước (thêm `review_plan` sau `plan`); client có nhãn "Plan reviewed".
  - `review_plan`, `convert_to_beads`, `polish_beads`, `implement` dùng tín hiệu `skillsUsed` (exact) và bằng chứng `skill` (inferred).
  - Phủ định `polish` chỉ khi `guardrail` ghi rõ `polish 0`.
  - `finished` có `skillsUsed` thiếu `reviewing-plan` hoặc `polishing-beads` → bước tương ứng là `skipped` kèm ghi chú. Luật này **chỉ** áp cho hai bước đó (delta thiết kế §5.5).
  - `SKIPPABLE_BY_TIER` theo delta.
  - Bằng chứng `file` tuyệt đối được đổi theo thư mục của workspace; ngoài workspace thì không tính.
- **Requirement / AC coverage:** PRD Dashboard REQ-045 (a)(b)(c)(d).
- **Design refs:** delta thiết kế §5.5; thiết kế Dashboard §8.
- **Prerequisites:** WP-215 (`skillsUsed`).
- **Risk boundaries:**
  - Giữ luật D-5: không có bằng chứng phủ định thì không kết luận phủ định.
  - Thêm giá trị enum: client và server đóng gói cùng nhau, bước được suy ra lúc đọc.
  - Nơi hiện danh sách bước trên giao diện phải chịu được 12 bước (một dòng ký hiệu).
- **Exit condition:** test:
  - thứ tự 12 bước;
  - từng tín hiệu exact/inferred mới;
  - `guardrail` không có `polish` không còn làm `polish_beads` thành `skipped`;
  - `guardrail` `polish 0` vẫn `skipped`;
  - Lớn có `finished` với `skillsUsed` thiếu `polishing-beads` → `skipped` kèm ghi chú;
  - Vừa tạo bead bằng tay (`beadsCreated` không rỗng) với `skillsUsed` thiếu `converting-plan-to-beads` → `convert_to_beads` vẫn `done`;
  - Nhỏ bỏ được `review_plan`, Vừa bỏ được `review_plan` nhưng không bỏ được `polish_beads`;
  - ghi `/<ws>/docs/design/x.md` không phải implement, ghi `/<ws>/src/a.js` là implement, ghi `~/.claude/...` không tính;
  - nhãn client đủ 12 bước.

  Test hợp đồng Dashboard, workflow-steps, dashboard-model và render vẫn xanh hoặc được sửa kèm lý do.

### WP-219: Tài liệu và sự thật đã kiểm

- **Outcome:**
  - Errata ở `docs/design/paseo-bm.md` §2.6 E và F, và ở `docs/design/paseo-bm-dashboard.md` §8, trỏ về delta.
  - Mỗi PRD thêm một dòng Revision History.
  - `README.md` cập nhật bảng mức, mục Worker, review, báo cáo và câu hỏi.
  - `AGENTS.md` thêm năm sự thật đã kiểm (delta thiết kế §8).
- **Requirement / AC coverage:** PRD REQ-032 (d) (người dùng đọc được quy trình đang có hiệu lực).
- **Design refs:** delta thiết kế §8.
- **Prerequisites:** WP-216, WP-217, WP-218 (tài liệu tả đúng hành vi đã làm).
- **Risk boundaries:**
  - Không sửa nội dung đã chốt của PRD/design ngoài dòng errata và dòng lịch sử.
  - README viết tiếng Anh (như hiện nay), tài liệu trong `docs/` viết tiếng Việt.
- **Exit condition:**
  - `grep` cho thấy README không còn "There is no bead polish pass" và có bảng skill theo mức;
  - `AGENTS.md` có năm dòng mới;
  - hai PRD và hai design có dòng trỏ về `design-delta-20260917-workflow-skills`.

### WP-220: Nghiệm thu thật

- **Outcome:** Bằng chứng trên daemon thật rằng hợp đồng mới có hiệu lực.
- **Requirement / AC coverage:** điều kiện ra số 2 và 3 ở §1.
- **Design refs:** delta thiết kế §4, §5; memory runner: kit `~/bm-demo/20260916/kit`, gửi tin như app, không tự trả lời hộp câu hỏi.
- **Prerequisites:** WP-215 → WP-219.
- **Risk boundaries:**
  - Cài lại cùng phiên bản lên daemon của owner: owner đã cho phép Claude chạy nghiệm thu trên daemon thật.
  - Sao lưu `~/.paseo/config.json` trước.
  - Không restart daemon.
  - Không lưu trữ hay xoá agent.
  - Repo mẫu mới, nằm ngoài repo sản phẩm.
  - Plugin không lên `running` sau khi cài: dừng nghiệm thu, giữ nguyên hiện trạng và báo owner. Không tự thử cách khác trên daemon.
  - **Đây cũng là bằng chứng âm cho hai ranh giới vừa nới** (Reviewer chạy test; Worker ghi `mktemp -d`).
- **Exit condition:**
  1. `npm run verify` xanh.
  2. `paseo plugin ls` báo `running` với payload mới.
  3. Lượt Lớn mới ("quản lý user và màn hình login" trên baseline Team Portal) có:
     - bằng chứng `skill` của Worker cho đủ 5 skill;
     - trong timeline của từng Reviewer, lệnh đọc đúng file tiêu chí của giai đoạn đó (Codex không có công cụ `Skill`, nên bằng chứng là lệnh đọc file, không phải trường `skills` của trace).
  4. Có vòng hỏi lúc nhận việc qua `blocked`, không `AskUserQuestion`. Quét timeline cho thấy:
     - Worker không ghi ngoài workspace, trừ thư mục `mktemp -d`, và đã xoá thư mục đó;
     - `git status --porcelain` Reviewer ghi trước và sau khi chạy lệnh giống nhau;
     - không agent nào in biến môi trường;
     - không có lệnh bị cấm (commit, push, cài đặt, mạng, đọc `.env`).
  5. Mọi bead Vừa/Lớn có Primary Proof và Reversibility.
  6. Dashboard: `created`/`closed` khớp `br list`, `ready` cuối bằng 0, không có dòng request tạm sau câu trả lời của người dùng, tổng chi phí bằng tổng từng agent.
  7. Có biên bản `docs/archive/operations/paseo-bm-workflow-skills-run-20260917.md`.
  8. Một review độc lập toàn bộ diff của delta không còn lỗi chặn.

## 3. Dependencies

```
WP-215 ──► WP-216 ──┐
   │                │
   ├──► WP-217 ─────┼──► WP-219 ──► WP-220
   │                │
   └──► WP-218 ─────┘
```

WP-216, WP-217 và WP-218 độc lập với nhau sau WP-215. Chúng chạm các file khác nhau: chỉ dẫn vai trò; collector và dựng trace; bước quy trình và client.

## 4. Test Strategy

- **Đơn vị:**
  - bộ đọc báo cáo (hai bản);
  - dựng trace;
  - collector;
  - chi phí;
  - bước quy trình;
  - dashboard model;
  - test nội dung ba file vai trò.
- **Hợp đồng:** `plugin-dashboard-contracts` cho 12 bước.
- **Toàn bộ:** `npm run verify` (typecheck, typecheck plugin, lint, test, build).
- **Độ phủ:** repo không đặt ngưỡng coverage. Yêu cầu tối thiểu: mỗi quy tắc mới trong §5 của delta thiết kế có ít nhất một test, và mỗi luật mới trong ba file vai trò có ít nhất một khẳng định trong `roles-content.test.ts`.
- **Hành vi thật:** WP-220. Test nội dung chỉ chứng minh chỉ dẫn **nói** đúng; chỉ lượt chạy thật chứng minh agent **làm** đúng.

## 5. Risk Modules

| Module | Rủi ro | Giảm thiểu |
|---|---|---|
| `plugin/roles/*.md` | Agent hiểu sai hoặc bỏ qua; chỉ dẫn dài làm luật chính chìm đi | Giữ `## RULES` đầu file, viết hoa luật cứng, dưới 240 dòng; nghiệm thu thật ở WP-220 |
| `bm-report.ts` (hai bản) | Hai bản lệch nhau; đọc sai báo cáo cũ | Test chạy trên cả hai bản với cùng dữ liệu; giữ test cũ |
| `collector.ts` | Gắn nhầm request | Chỉ mẫu có neo đầu chuỗi; chỉ tool call của Manager |
| `workflow-steps.ts` | Kết luận phủ định sai (luật D-5) | Phủ định chỉ từ bằng chứng chính xác; test cho từng trường hợp |
| Ranh giới an toàn | Reviewer chạy test ghi file; Worker ghi ngoài repo | `git status` trước/sau; chỉ `mktemp -d`; nghiệm thu quét timeline |

## 6. Cross-Stack

Không có. Một repo, một payload plugin.

## 7. Risks & Open Questions

| # | Nội dung | Trạng thái |
|---|---|---|
| R-1 | Chi phí và thời gian của một lượt Lớn tăng | Chấp nhận (owner, 2026-09-17); đo ở WP-220 |
| R-2 | Agent đã tạo trước khi cập nhật giữ chỉ dẫn cũ | Chấp nhận; ghi trong README như các lần trước |
| Q-1 | Có lấy chi phí do provider báo (hiệu `totalCostUsd`) không | Ngoài phạm vi; để owner quyết sau WP-220 |
| R-3 | Ba điểm review không chặn được ghi lại, không sửa (delta thiết kế §7): `ready` với dòng thiếu, từ dạng id ngoài ngoặc, id rút gọn trong nhóm ngoặc bị bỏ | Chấp nhận (owner, 2026-09-17) |

## 8. Revision History

| Ngày | Người | Thay đổi |
|---|---|---|
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | Tạo Draft theo delta thiết kế Accepted |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | Một lượt `reviewing-plan`: thêm tư thế checkpoint, hai trường mới vào `parsedReportSchema` (kho trace bỏ trường lạ khi đọc), bằng chứng kiểm được cho tiêu chí của Reviewer, bằng chứng âm cho hai ranh giới vừa nới, mức độ phủ test, và giới hạn luật phủ định theo `skillsUsed` vào hai bước `review_plan`, `polish_beads` |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | Cổng `plan-ready-for-beads` PASS → **Active**; phạm vi WP-215 → WP-220 đóng băng |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | Errata sau `polishing-beads`: sự thật thứ năm về `br` (bead con bị chặn khi bead cha bị chặn) đã ghi ở delta thiết kế §4.3 và §8; WP-219 nêu năm sự thật thay vì bốn. Phạm vi không đổi |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | Errata theo quyết định owner Q9: trần dòng của `worker.md` là 270 (hai file kia giữ 240) |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | Ghi R-3 (ba điểm review không chặn owner chọn chưa sửa) và bead khắc phục `bm-wp-220-nvk.4` trước bước cài đặt. Phạm vi không đổi |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | **Applied**: WP-215 → WP-220 đóng kèm bằng chứng; phát hiện của lượt nghiệm thu chuyển sang bead `bm-wp-221-ain9`, NEW-1 chờ owner |
