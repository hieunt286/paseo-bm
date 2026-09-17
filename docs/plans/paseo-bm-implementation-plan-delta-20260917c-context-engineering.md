# Delta plan — Ba file vai trò viết lại theo ngữ cảnh

| Trường | Giá trị |
|---|---|
| Mã | `plan-delta-20260917c-context-engineering` |
| Plan gốc | [Implementation Plan v2](paseo-bm-implementation-plan-v2.md) (Active, Plan-ready PASS) — **không sửa tại chỗ**; delta này thêm WP-227 → WP-234 vào Phase 2a-4 |
| Status | **Active** |
| Plan-ready | **PASS — 2026-09-17 — hieu.nt10** (cổng do Claude tự chấm sau một lượt `reviewing-plan`; lần chấm đầu FAIL 4 mục — xem §7) |
| Owner | hieu.nt10 |
| Created | 2026-09-17 |
| Source design | [design-delta-20260917c-context-engineering](../design/paseo-bm-delta-20260917c-context-engineering.md) (Accepted) — nguồn duy nhất cho kiến trúc ba tầng, cấu trúc mục tiêu từng file, và mười kết quả kiểm chứng nền tảng K1–K10 |
| Source PRD | [PRD](../product/paseo-bm-prd.md) **REQ-032** (bộ chỉ dẫn vai trò), **REQ-037** (lan can review — có errata), REQ-026, REQ-034, REQ-036 |
| Routing decision | Brownfield, rủi ro **cao**: viết lại chỉ dẫn hệ thống của ba agent chạy không hỏi quyền, **cộng** thay đổi mã ở đường tạo agent, **cộng** bỏ một trường khỏi hợp đồng `BM-REPORT` mà Dashboard đọc, **cộng** errata một yêu cầu đã ghi. Đi đủ chuỗi và kết bằng một lượt chạy thật để đo |
| Phase | Phase 2a-4 (nhãn bead `phase:2a-4`) |

## 1. MVP-Lock

- **Trong phạm vi:** toàn bộ §4 và §5 của delta thiết kế.
- **Ngoài phạm vi:**
  - nới REQ-022 / `feature-workflow` cho việc phi phần mềm (quyết định Q19: chỉ đổi khung trình bày);
  - đổi ba mức, ngân sách 1/4/6, ba mốc hỏi, năm skill bắt buộc;
  - dùng `mcpServers` để giữ tool khỏi Reviewer (K4 cho thấy `toolPolicy` không chặn được; đường `mcpServers` **chưa kiểm chứng** trên daemon thật);
  - NEW-1 (Reviewer không chạy được test HTTP dưới sandbox `auto`);
  - phát hành npm.
- **Điều kiện ra của delta:**
  1. `npm run verify` mã 0.
  2. Ba file theo đúng cấu trúc §4.3–§4.5; ba ví dụ mẫu có mặt.
  3. Plugin lo mode (K10): hook chọn và hạ mode Reviewer; Manager nhận giá trị mode Worker cụ thể qua dòng *Runtime facts*; không prompt nào còn **luật chọn** mode hay gọi `inspect_provider`.
  4. Plugin đếm ngân sách và báo Manager; `BM-REPORT` không còn `guardrail`.
  5. Một lô review tài liệu và một lô review mã đạt.
  6. **Lượt chạy thật đạt bảng chỉ số và ba kiểm tra đạt/không đạt ở §6 của delta thiết kế**, kể cả một Worker do Manager ở đúng mode cài mặc định tạo ra.
- **Tư thế hoàn tác mặc định:** repo không commit khi chưa được yêu cầu, nên `git` không phải đường hoàn tác. WP-227 chép ba file vai trò cộng `test/roles-content.test.ts` vào một thư mục `mktemp -d` (đường dẫn ghi ở `/tmp/bm-phase-copy-20260917c.txt` và trong lý do đóng bead), giữ tới khi **WP-234** đóng — tức là sau lượt chạy thật, bước duy nhất có thể đòi hoàn lại chữ đã cắt. Thay đổi mã hoàn tác bằng cách đảo từng bead. Không có điểm nào không đảo ngược được.

## 2. Work packages

### WP-227 — Plugin lo mode

- **Phủ yêu cầu / design refs:** REQ-026(c), REQ-032(a) · delta §4.6, K2, K3.
- **Kết quả:** (1) `before("agent.create")` đặt `modeId` cho `bm-worker` và `bm-reviewer` khi người gọi để trống, và hạ mode toàn quyền/`planning` của `bm-reviewer` về `auto`; (2) chỉ dẫn của Manager mang dòng *Runtime facts* với mode Worker cụ thể (delta §4.6, Q22), vì daemon từ chối tạo Worker thiếu mode **trước** khi hook chạy (K10). Không agent nào còn phải gọi `inspect_provider`.
- **Phạm vi:** `plugin/server/role-hook.ts`, nơi dựng chỉ dẫn cho Manager (`manager.ensure` và `before("agent.create")` cho `bm-manager`, cùng chỗ phần chỉ dẫn bổ sung của người dùng được nối), test tương ứng. Cũng tạo bản chép hoàn tác của pha (xem §1).
- **Ràng buộc:** hook **không bao giờ** được làm hỏng việc tạo agent — `listModes` lỗi, không có mode phù hợp, provider lạ → trả nguyên request. Không đụng `systemPrompt` đang có.
- **`bm-manager` không thuộc phạm vi này:** Manager do `manager.ensure` tạo và đã tự đặt mode; hook để nguyên provider đó để không có hai nơi cùng quyết định một giá trị.
- **Điều kiện ra:** test cho bốn ca (mode trống → đặt; mode do người gọi chọn → giữ; Reviewer chọn mode toàn quyền → hạ; `listModes` lỗi → giữ nguyên) xanh; `npm run verify` mã 0.
- **Phụ thuộc:** none.

### WP-228 — Plugin đếm ngân sách review, `BM-REPORT` bỏ `guardrail`

- **Phủ yêu cầu / design refs:** REQ-037 (errata), REQ-034 · delta §4.7, §5, K5.
- **Kết quả:** sau khi bộ gom trace ghi xong lượt của **bất kỳ** agent nào thuộc request (Worker, Reviewer, Manager), plugin tính lại số lần gọi review và gửi Manager **một** thông báo `BM-BUDGET` nguyên văn như delta §4.7 khi vượt ngân sách; thông báo bảo Manager **hỏi người dùng** chứ không tự huỷ (Q21). Worker thôi tự đếm; `guardrail` rời khối `BM-REPORT`; Dashboard vốn đã dùng số suy ra làm số chính (K9).
- **Phạm vi:** một module đếm/báo mới ở `plugin/server/`, `plugin/shared/contracts.ts` (giữ `guardrail` nullable cho trace cũ), `plugin/server/bm-report.ts` + `plugin/shared/bm-report.ts` (hai bản phải giống nhau trừ dòng import), Dashboard đọc số suy ra, test.
- **Ràng buộc quyết định cách gửi:** `PaseoAgentHandle.send()` lên một agent **đang chạy sẽ thay thế lượt hiện tại** của nó (đúng cơ chế `stop-propagation.ts` dùng để ngắt Reviewer). Gửi thẳng cho Manager đang bận sẽ cắt ngang việc nó đang làm với người dùng. Vì vậy: đọc lại trạng thái bằng `agents.ref(id).refresh()` trước, **chỉ gửi khi Manager không `running`**, còn lại hoãn sang lần `turn_ended` kế tiếp. Cùng khuôn với `stop-propagation.ts`.
- **Người tiêu thụ trường `guardrail` phải sửa theo:** `plugin/shared/contracts.ts` (`guardrailReportSchema`, `parsedReportSchema`, `traceRequestSchema`), `plugin/server/bm-report.ts` và `plugin/shared/bm-report.ts` (hai bản phải giống nhau trừ dòng import), `plugin/server/traces.ts` (`guardrailReported`, `reviewCalls`), `plugin/server/workflow-steps.ts`, và phía client đọc số này. Converter không phải tự đi tìm.
- **Ràng buộc:** giữ đúng bản chất lan can của REQ-037 — plugin **báo**, không chặn. `userAllowedExtra` biến mất hoàn toàn. Bản ghi trace cũ vẫn đọc được.
- **Điều kiện ra:** test cho: đếm đúng trên một dòng thời gian mẫu; báo đúng một lần; không báo khi trong ngân sách; **không gửi khi Manager đang `running`, và gửi ở lần kết thúc lượt sau đó**; báo cáo cũ có `guardrail` vẫn phân tích được. `npm run verify` mã 0.
- **Phụ thuộc:** none (song song được với WP-227, nhưng làm tuần tự).

### WP-229 — Viết lại `worker.md`

- **Phủ yêu cầu / design refs:** REQ-032(a)(b), REQ-036, REQ-022 · delta §4.2, §4.3, §4.8.
- **Kết quả:** file theo cấu trúc §4.3: mở đầu bằng kết quả phải giao và câu "bead là dụng cụ"; một mục **"việc tiếp theo"** duy nhất gộp Step 1→4 và mốc báo cáo; 12 trigger gộp thành một nguyên tắc kèm ba ví dụ; **một bead mẫu** và **một bộ câu hỏi mẫu**; brief gửi Reviewer mang tiêu chí giai đoạn; việc phi phần mềm đi lọt mọi bước; đoạn chọn mode và dòng `guardrail` biến mất.
- **Phạm vi:** `plugin/roles/worker.md`, file sinh lại, `test/roles-content.test.ts`.
- **Ràng buộc:** tiếng Anh; `## RULES` vẫn là heading đầu, đúng 5 giới hạn; không đổi bảng mức, ngân sách, ba mốc hỏi, nội dung hợp đồng leaf bead, khối `BM-REPORT` (trừ `guardrail`).
- **Bead mẫu phải lấy từ một bead thật** của đồ thị repo này (rút gọn cho vừa), không được bịa: mục đích là cho thấy hình dạng đạt chuẩn đã tồn tại, và tránh việc ví dụ mẫu tự nó thành một tiêu chuẩn thứ hai lệch với `converting-plan-to-beads`.
- **Điều kiện ra:** lý do đóng bead đi hết từng mục của §4.3 và nói rõ mỗi nội dung cũ nay ở đâu; hai ví dụ mẫu có mặt; test xanh.
- **Phụ thuộc:** WP-227 (bỏ được đoạn mode), WP-228 (bỏ được `guardrail`).

### WP-230 — Viết lại `reviewer.md`

- **Phủ yêu cầu / design refs:** REQ-032(a)(b), REQ-024(e) · delta §4.4, §4.8, K6.
- **Kết quả:** bỏ bảng tiêu chí bốn giai đoạn (Worker đưa vào brief) và mục Dừng (thông báo dừng đã đủ); thêm **cặp đối chiếu chặn / không chặn**; dự phòng khi brief không nêu tiêu chí.
- **Phạm vi:** `plugin/roles/reviewer.md`, file sinh lại, test.
- **Ràng buộc:** `BM-REVIEW` không đổi một ký tự; 4 giới hạn giữ nguyên; `BM-REVIEW STOPPED` vẫn phải xuất hiện trong file vì đó là chuỗi thông báo dừng yêu cầu.
- **Điều kiện ra:** như WP-229, cho §4.4; cặp đối chiếu có mặt.
- **Phụ thuộc:** WP-229 (brief do `worker.md` định nghĩa).

### WP-231 — Viết lại `manager.md`

- **Phủ yêu cầu / design refs:** REQ-032(a)(b), REQ-020(d), REQ-037 (errata) · delta §4.5.
- **Kết quả:** mục "việc tiếp theo" bốn hành động; công thức tạo Worker nén lại, không còn chọn mode; bảng ngân sách và đoạn giám sát thay bằng một câu về thông báo của plugin; mục "nói với người dùng" mở rộng vì đó là việc thật của Manager.
- **Phạm vi:** `plugin/roles/manager.md`, file sinh lại, test.
- **Ràng buộc:** giữ `Continue <requestId>.`, provider `bm-worker/<model>`, tên nhãn, 5 giới hạn.
- **Điều kiện ra:** như WP-229, cho §4.5.
- **Phụ thuộc:** WP-227, WP-228.

### WP-232 — Test, trần theo số đo, tài liệu

- **Phủ yêu cầu / design refs:** REQ-032(c), REQ-037 · delta §4.9, §5.
- **Kết quả:** khẳng định mới cho vòng làm việc, ba ví dụ mẫu, khung "bead là dụng cụ", thông báo `BM-BUDGET` và dòng *Runtime facts*; trần dòng lấy theo số đo + 10; errata REQ-037 trong PRD (theo §5 mới); errata §2.6 thiết kế; README. **Không** chuyển `Applied`, **không** xoá bản chép hoàn tác — việc của WP-234.
- **Phạm vi:** `test/roles-content.test.ts`, `docs/product/paseo-bm-prd.md`, `docs/design/paseo-bm.md`, `README.md`, `AGENTS.md` (thêm K8, K10 vào mục sự thật đã kiểm chứng).
- **Điều kiện ra:** `npm run verify` mã 0 đọc từ mã thoát.
- **Phụ thuộc:** WP-229, WP-230, WP-231.

### WP-233 — Lượt chạy thật để đo

- **Phủ yêu cầu / design refs:** delta §6.
- **Kết quả:** biên bản so ba lượt trên bảng chỉ số §6, kèm kết luận đạt / không đạt và, nếu chất lượng tụt, danh sách phần phải hoàn lại.
- **Phạm vi:** cài lại payload lên daemon của owner (**xin phép riêng trước khi cài**), chạy đúng đề bài cũ, thu bằng chứng, viết biên bản.
- **Ràng buộc:** sao lưu `~/.paseo/config.json` trước; kiểm không có agent `bm-*` nào đang chạy; không lưu trữ hay xoá agent nào.
- **Điều kiện ra:** biên bản có đủ các chỉ số và ba kiểm tra đạt/không đạt của §6 cho lượt mới, kể cả **một Worker do Manager ở đúng mode cài mặc định tạo ra** (các lượt trước đều chạy Manager không-hỏi-quyền nên chưa từng đi qua K10).
- **Phụ thuộc:** WP-232.

### WP-234 — Đóng delta

- **Phủ yêu cầu / design refs:** feature-workflow `feature-done` · delta §6.
- **Kết quả:** theo kết luận của WP-233: đạt → delta và plan chuyển `Applied` kèm số đo cuối, xoá bản chép hoàn tác; không đạt → dùng bản chép để hoàn lại đúng phần WP-233 chỉ ra, ghi lại, và **không** chuyển `Applied`.
- **Phạm vi:** delta + plan này, biên bản, bản chép hoàn tác.
- **Điều kiện ra:** `npm run verify` mã 0; trạng thái hai tài liệu khớp kết luận của WP-233.
- **Phụ thuộc:** WP-233.

## 3. Thứ tự và lô review

```
WP-227 ──┬─────────────┐
WP-228 ──┴── WP-229 ── WP-230 ──┐
              └────── WP-231 ───┴── WP-232 ── WP-233 ── WP-234
```

Yêu cầu mức **Lớn** theo bảng của chính sản phẩm: đổi hợp đồng `BM-REPORT`, đổi đường tạo agent, errata một yêu cầu. Ba lô review: `b1` tài liệu (delta + plan + bead), `b2` mã (hook + bộ đếm), `b3` chỉ dẫn (ba file vai trò + test + tài liệu).

## 4. Ranh giới rủi ro

- **Không** đổi con số, tên trường, tên nhãn, tên phase, tên mode nào ngoài việc bỏ `guardrail`.
- **Không** bỏ giới hạn cứng nào của ba vai.
- Mọi chữ trong `plugin/roles/*.md` là **tiếng Anh**; tên mục tiếng Việt trong delta là mô tả.
- Mỗi bead sửa file vai trò phải chạy `npm run generate:role-instructions` trước khi đóng.
- Làm **tuần tự**, không sub-agent song song: ba WP viết lại file đều đụng `test/roles-content.test.ts`.
- WP-233 đụng daemon thật: **xin phép owner trước**, sao lưu config, không đụng agent đang có.

## 5. Chiến lược kiểm thử

| Tầng | Chạy gì | Bắt lỗi gì |
|---|---|---|
| Hành vi chỉ dẫn | `test/roles-content.test.ts` — khớp theo ý trên khối `## RULES`, cộng khẳng định cho vòng làm việc, ví dụ mẫu và khung "bead là dụng cụ" | Một giới hạn hoặc một ví dụ bị xoá khi viết lại |
| Hợp đồng máy đọc | cùng file — ghim nguyên văn `BM-REPORT`, `BM-REVIEW`, `BM-REVIEW STOPPED`, tên nhãn | Đổi ký tự trong thứ mã đọc |
| Hook | test mới cho `role-hook.ts` | Đặt sai mode, hoặc làm hỏng việc tạo agent khi provider lạ |
| Bộ đếm | test mới cho module đếm | Đếm sai, báo nhiều lần, báo khi chưa vượt |
| Tương thích ngược | test phân tích một `BM-REPORT` cũ có `guardrail` | Bản ghi trace cũ hỏng |
| Đồng bộ payload | `test/plugin-bundle-cjs.test.ts` | Quên sinh lại file nhúng |
| Toàn bộ | `npm run verify` | Hồi quy nơi khác |
| **Hành vi thật** | **WP-233, lượt chạy trên daemon** | **Chỉ dẫn đọc hay mà chạy dở** |

**Đối chứng âm bắt buộc từng bead sửa nội dung:** chép file sang `mktemp -d`, lấy đi hành vi, trỏ test vào bản sao, thấy đỏ, xoá thư mục. Với hai bead mã: một ca hỏng được xây riêng cho mỗi nhánh.

Không đặt mục tiêu độ phủ dòng cho phần Markdown.

## 6. Rủi ro và câu hỏi mở

Bảy rủi ro và cách giảm nằm ở §7 của delta thiết kế; rủi ro nặng nhất là **đổi khung làm loãng kỷ luật bead**, đo bằng ngưỡng ≥ 12 bead lá ở WP-233.

| Câu hỏi mở | Chủ | Trạng thái |
|---|---|---|
| `mcpServers` có giữ được tool khỏi Reviewer không, để lệnh cấm thành bất khả thi về cấu trúc? | hieu.nt10 | **Chưa kiểm chứng**, để ngoài phạm vi delta này. Không chặn WP nào |

## 7. Kết quả cổng `plan-ready-for-beads`

Chấm ngày 2026-09-17 sau một lượt `reviewing-plan`.

```
Lần 1 — FAIL (4 mục)
  ✗ WP-228 đổi hợp đồng được tiêu thụ mà không liệt kê người tiêu thụ
  ✗ WP-228 không nêu rủi ro send() thay thế lượt đang chạy của Manager
  ✗ WP-227 không nói gì về bm-manager, để converter tự đoán
  ✗ Thiếu mục rủi ro và câu hỏi mở ở chính plan

Lần 2 — PASS
  ✓ MVP-lock: phạm vi = §4 và §5 delta thiết kế; 6 điều kiện ra; ngoài phạm vi 5 mục
  ✓ 7 work package, mỗi WP có kết quả, độ phủ REQ, design refs, ràng buộc,
    điều kiện ra, phụ thuộc
  ✓ Phụ thuộc: 8 cạnh, không chu trình; WP-229 phụ thuộc cả hai WP mã vì
    chỉ khi mã xong thì văn bản mới mô tả đúng hiện thực
  ✓ Hợp đồng tiêu thụ: người tiêu thụ `guardrail` liệt kê đủ, tương thích ngược
    có test riêng
  ✓ Ranh giới an toàn: mode do REQ-026(c) quyết, hook chỉ thi hành; bốn ca test
  ✓ Hoàn tác: bản chép mktemp -d cho văn bản, đảo bead cho mã, sao lưu config
    cho lượt chạy thật
  ✓ Kiểm thử: 8 tầng, đối chứng âm bắt buộc từng bead, cộng một lượt chạy thật
  ✓ Sẵn sàng phân rã: mọi cấu trúc mục tiêu đã có ở §4.3–§4.5 delta thiết kế

Cảnh báo (không chặn)
  - 7 WP trong một pha: dưới ngưỡng 8
  - WP-228 và WP-232 mỗi cái gói hai kết quả tách rời được → converter tách đôi

Verdict: PASS → converting-plan-to-beads
```

## 8. Revision history

| Ngày | Thay đổi |
|---|---|
| 2026-09-17 | Tạo (Draft) từ delta thiết kế `20260917c-context-engineering` |
| 2026-09-17 | Một lượt `reviewing-plan`: thêm ràng buộc **chỉ gửi thông báo khi Manager không `running`** (chặn — `send()` thay thế lượt đang chạy); liệt kê đủ người tiêu thụ trường `guardrail` để converter không phải đoán; nói rõ `bm-manager` ngoài phạm vi WP-227; buộc bead mẫu lấy từ bead thật |
| 2026-09-17 | Cổng `plan-ready-for-beads`: FAIL lần 1 (4 mục), bổ sung người tiêu thụ hợp đồng, rủi ro `send()`, phạm vi `bm-manager`, mục rủi ro và câu hỏi mở; PASS lần 2 → `Status: Active` |
| 2026-09-17 | Lượt `polishing-beads` (chỉ phân rã, không đổi phạm vi): bead "bỏ `guardrail`" của WP-228 gộp vào bead bộ đếm vì parser và client đã chịu được dòng thiếu (delta K9); bead WP-227 nhận quy tắc chọn mode chép từ bm-msy, kèm kết quả dò chỉ-đọc `listModes` (delta K8); bead bộ đếm nhận nguồn id Manager (`parentAgentId`), hàm đếm dùng lại (`reviewCallsOf`) và rủi ro thứ tự handler. WP-228 còn một bead lá, tổng cộng 8 bead lá |
| 2026-09-17 | Sau review lô b1 (7 chặn, 5 không chặn — delta thiết kế §9) và hai quyết định owner Q21, Q22: WP-227 thành "plugin lo mode" và nhận thêm dòng *Runtime facts* cho Manager vì daemon chọn mode trước hook (K10); WP-228 kiểm cả khi lượt của Manager kết thúc, thông báo có nguyên văn và bảo Manager hỏi người dùng; WP-232 thôi đánh dấu `Applied` và thôi xoá bản chép; thêm **WP-234 đóng delta** sau lượt chạy thật; WP-233 kiểm thêm Manager ở mode cài mặc định. Không đổi phạm vi của delta thiết kế — chỉ sửa cho khớp nền tảng thật |
