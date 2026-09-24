# Delta-change — Worker tự quyết nhiều hơn, mức phân loại theo hệ quả

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260924-worker-autonomy` |
| Yêu cầu sản phẩm | [prd-delta-20260924-worker-autonomy](../product/paseo-bm-prd-delta-20260924-worker-autonomy.md) |
| Tài liệu gốc | [Technical Design](./paseo-bm.md). Các delta bị thay một phần: [20260917b-simplify-roles](./paseo-bm-delta-20260917b-simplify-roles.md) (bảng mức), [20260917c-context-engineering](./paseo-bm-delta-20260917c-context-engineering.md) (ngân sách), [20260917-workflow-skills](./paseo-bm-delta-20260917-workflow-skills.md) (skill theo mức). **Không sửa tại chỗ** |
| Status | **Active** |
| Owner | hieu.nt10 |
| Created | 2026-09-24 |

## Routing Decision

- **Variant preset:** brownfield.
- **Triggered risks:** đổi hợp đồng giữa các vai trò (`worker.md`, `manager.md`) và một con số plugin dùng (`REVIEW_BUDGET`). Không đổi schema, không đổi thông điệp `BM-*`.
- **Artifacts và cổng:** delta PRD, delta này, `design-ready`, `feature-done`.
- **Execution path:** bead viết tay. Delta này có luôn phần kế hoạch (§6), không có file plan riêng. Lý do: bốn phần việc, một chuỗi phụ thuộc thẳng, không cần converter.
- **Exceptions:** không có.
- **Decided:** 2026-09-24 — hieu.nt10.
- **Supersedes:** không có.

## 1. Chủ repo muốn gì, và cách chỉnh đã được đồng ý

**Mong muốn 1: trao thêm quyền quyết cho Worker.** Làm, nhưng cắt theo **loại** câu hỏi, không theo số lượng. Những câu người dùng chọn khác Worker tập trung vào phạm vi, lựa chọn sản phẩm, môi trường và việc đi ra ngoài; những câu đó vẫn hỏi. Việc hoàn tác được thì Worker tự quyết và ghi lại.

**Mong muốn 2: để model tự hiểu mức.** Bỏ danh sách "khớp đầu tiên thắng" và các ví dụ, nhưng **giữ một câu định nghĩa theo hệ quả**. Đồng thời **tháo tài liệu và review khỏi mức**, để phán đoán sai chỉ tốn một lượt review chứ không kéo theo cả chuỗi thủ tục. Không xoá hẳn định nghĩa, vì mức vẫn điều khiển một con số của plugin (ngân sách review). Và "lớn" theo nghĩa thường là khối lượng, không phải rủi ro: một thay đổi một dòng vào phần xác thực vẫn phải là Lớn.

## 2. Mốc đo trước khi đổi

Trace từ 2026-09-18 tới 2026-09-24T02:00Z.

| Chỉ số | project-b | paseo-bm |
|---|---|---|
| Token ngữ cảnh: Manager / Reviewer / Worker | 3% / 8% / 89% | 4% / 6% / 90% |
| Trong phần của Worker: lượt bị đánh thức không có tin nhắn (phần lớn là Reviewer trả kết quả) | 53% | 38% |
| Vòng hỏi người dùng | 37 | 62 |
| Giờ chờ người trả lời / giờ Worker thật sự làm | 88,9 / 18,3 | 60,6 / 20,2 |
| Request Large: số câu hỏi / số lượt Worker / thời gian | 16,8 / 20,3 / 10,2h | 11,9 / 21,6 / 20,3h |
| Request Medium: số câu hỏi / số lượt Worker / thời gian | 4,3 / 9,7 / 3,5h | 2,8 / 9,5 / 1,5h |

Trên toàn bộ trace có 285 câu hỏi đã được trả lời, và người dùng chọn đúng khuyến nghị ở 78%. Phân nhóm theo từ khoá, nên chỉ gần đúng: câu về quy trình 87 (82% chọn khuyến nghị), câu đi ra ngoài 47 (79%), câu về sản phẩm, phạm vi hay sự thật 151 (75%).

**Mốc chính thức (cách đo cố định, `npm run measure`).** Chạy `npm run measure -- <thư mục workspace trong ~/.paseo-bm/traces> --since 2026-09-22T00:00:00Z --until 2026-09-24T02:00:00Z`:

| Chỉ số | project-b | paseo-bm |
|---|---|---|
| Token ngữ cảnh Manager / Worker / Reviewer | 3% / 89% / 8% | 4% / 90% / 6% |
| Ngữ cảnh của Worker ở lượt bị đánh thức không có tin nhắn | 60% | 43% |
| Vòng hỏi; giờ chờ người trả lời / giờ Worker làm | 24; 16,2h / 15,6h | 22; 12,7h / 8,9h |
| Câu đã trả lời; tỉ lệ chọn khuyến nghị | 70; 73% | 47; 79% |
| Large mỗi request: câu hỏi / lượt Worker / lượt Reviewer / ngữ cảnh | 17,3 / 22 / 13,7 / 290M | 9,8 / 21,3 / 8 / 143M |
| Medium mỗi request: câu hỏi / lượt Worker / lượt Reviewer / ngữ cảnh | 4,3 / 9,7 / 5,3 / 111M | 5 / 10 / 3 / 10,5M |

Số "sau" đo bằng cùng lệnh này, trên các request mà Worker được tạo sau khi cài bản mới (PRD delta N5). Các lệnh đo là những script đã dùng trong [chẩn đoán 2026-09-24](../operations/paseo-bm-chan-doan-hoi-lap-20260924.md) §6, chạy trên cùng trace store.

## 3. `worker.md`

| Phần | Trước | Sau |
|---|---|---|
| RULES 5 | "NEVER DECIDE WHAT ONLY THE USER CAN DECIDE … send `blocked` and wait — never continue on a default you chose yourself" | **"ASK ONLY WHAT YOU CANNOT DECIDE"**: tự quyết việc hoàn tác được trong phạm vi và ghi lại; chỉ hỏi vì bốn lý do ở §2 của PRD delta; với bốn lý do đó thì không bao giờ đi tiếp bằng một mặc định tự chọn |
| What you do next | ba nhánh Small / Medium / Large | **một luồng**: phân mức → một vòng hỏi (nếu có) → tài liệu chỉ nơi thay đổi cần → beads → implement → một lô review → `finished` kèm `Decided:` |
| How big is this | luật thứ tự, ví dụ, bảng 6 dòng | định nghĩa theo hệ quả (PRD REQ-036a) và một bảng 2 dòng: tài liệu, review |
| Asking | 8 lý do hỏi, 3 thời điểm bắt buộc, xác nhận trước Large | **Deciding and asking**: tự quyết và ghi lại; bốn lý do được hỏi; gom câu hỏi thành một vòng; phần "cách hỏi" và `BM-ANSWERS` giữ nguyên |
| Reviewing | Small không có lượt review lại; số lô theo mức | mọi mức: một lô implement (1 + 1). Lớn thêm một lô tài liệu cộng beads trước khi implement, stage `plan`. Các mức khác chỉ khi người dùng yêu cầu. Bỏ ngoại lệ Small. Luật "chỉ Worker hỏi về ngân sách" giữ nguyên |
| Reporting | `beads-done` (Medium và Large) | `beads-done` chỉ sau lô review trước khi implement của Lớn; `finished` liệt kê `Decided: …` trong `blockers` |
| Skill | bảng skill bắt buộc theo mức | dùng skill khi bước trước mặt cần: `feature-workflow` cho tài liệu, `reviewing-plan` và `converting-plan-to-beads` khi có plan, `polishing-beads` cho đồ thị đã convert, `implementing-beads` cho vòng bead |

Những phần **không đổi**: RULES 1–4, "what the job is", Splitting the work, Proving a change, cách viết câu hỏi và mẫu `BM-QUESTIONS`, cách tạo và brief Reviewer, mẫu `BM-REPORT`, Stop, và mọi thông điệp của plugin.

## 4. `manager.md`

- **Bước 1:** đoán mức bằng cùng định nghĩa theo hệ quả, bỏ luật thứ tự.
- **`beads-done`:** bỏ "For a Large request say the Worker is waiting for the user's confirmation". Chỉ còn một dòng, như `received`.
- **`finished`:** bỏ luật báo thiếu skill theo mức. Thêm: nói số dòng `Decided:` và rằng người dùng đảo lại được bất kỳ quyết định nào. Vẫn nói số `Suggestion (not done)`.
- **`BM-BUDGET`:** bỏ "(Small 1, Medium 4, Large 6)", vì Manager không cần bảng số.

## 5. Plugin

- `plugin/server/review-budget.ts`: `REVIEW_BUDGET = { Small: 2, Medium: 2, Large: 4 }`. `BM-BUDGET` và `BM-HANDOVER` đọc từ đây nên tự đổi theo.
- `plugin/server/workflow-steps.ts`: `SKIPPABLE_BY_TIER` cho **mọi** mức là `prd`, `design`, `adr`, `plan`, `review_plan`, `polish_beads` (PRD REQ-045d).
- `GUIDE.md`: phần mức và ngân sách viết lại cho khớp.

## 6. Kế hoạch và tiêu chí

| Gói | Việc | Phụ thuộc | Chứng minh |
|---|---|---|---|
| AU-1 | `worker.md` theo §3, generate, `test/roles-content.test.ts` | — | test ghim các câu mới; test ghim RULES 1–4 và cách hỏi còn nguyên; trần số dòng **giảm** |
| AU-2 | `manager.md` theo §4, generate, test | AU-1 (cùng file test) | như trên |
| AU-3 | plugin theo §5, test ngân sách, test workflow-steps, `GUIDE.md` | — | test số mới; test "skipped" ở Medium và Large |
| AU-4 | verify toàn bộ, review độc lập, đóng | AU-1..3 | `npm run typecheck && npm run typecheck:plugin && npm run lint && npm test && npm run build` |

**Tư thế hoàn tác:** mọi phần là văn bản và hằng số, lùi bằng `git revert`. Agent đang chạy giữ chỉ dẫn cũ; chỉ agent tạo sau khi cài mới dùng bản mới.

**Rủi ro đã biết:** Worker sẽ có lúc tự quyết sai.
- Việc không hoàn tác được vẫn do RULES 1–2 chắn.
- Việc hoàn tác được thì có danh sách `Decided:` để người dùng đảo lại.
- Nhóm hay sai nhất theo số đo là phạm vi và lựa chọn sản phẩm, và nhóm này vẫn phải hỏi.

## Revision History

| Ngày | Thay đổi | Người |
|---|---|---|
| 2026-09-24 | Tạo, Active | hieu.nt10 (Claude Code thực hiện) |
