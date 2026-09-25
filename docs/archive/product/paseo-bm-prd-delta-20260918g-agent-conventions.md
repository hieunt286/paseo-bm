# Delta-change — Plugin bắt buộc quy ước phối hợp giữa các agent

| Trường | Giá trị |
|---|---|
| Mã | `prd-delta-20260918g-agent-conventions` |
| Tài liệu gốc | [paseo-bm PRD](../../product/paseo-bm-prd.md) (Accepted) — REQ-059 (khối `BM-QUESTIONS` / `BM-ANSWERS`, thẻ câu hỏi); [PRD Dashboard](../../product/paseo-bm-dashboard-prd.md) (Accepted) — thẻ chat. **Không sửa tại chỗ** cho tới khi delta này được owner duyệt; sau đó WP-282 thêm REQ-061 vào PRD gốc |
| Status | Merged — gộp vào [paseo-bm-prd.md](../../product/paseo-bm-prd.md) ngày 2026-09-25; chỉ còn là hồ sơ lịch sử |
| Owner | hieu.nt10 |
| Created | 2026-09-18 |
| Request | `req-20260918T071130Z` |
| Thiết kế | [design-delta-20260918g-agent-conventions](../design/paseo-bm-delta-20260918g-agent-conventions.md) |
| Plan | [plan-delta-20260918g-agent-conventions](../plans/paseo-bm-implementation-plan-delta-20260918g-agent-conventions.md) |

## 0. Routing Decision

- Variant preset: brownfield
- Triggered risks: **nhiều thành phần độc lập** (nhận diện agent phía server, thẻ chat phía client, hook vòng đời, chỉ dẫn của ba vai); **hợp đồng tin nhắn giữa các agent** (`BM-REPORT`, `BM-QUESTIONS`, `BM-ANSWERS`, `BM-REVIEW` được plugin kiểm và phản hồi); **hành vi người dùng đang dựa vào** (Beads Manager mở Manager nào, agent nào được dừng)
- Required artifacts/gates: PRD delta này + `prd-ready` → design delta + `design-ready` → plan delta + `plan-ready-for-beads` → beads → `feature-done` (hồ sơ standard)
- Execution path: plan → converter
- Exceptions: none
- Decided: 2026-09-18 — Beads Worker, cỡ **Large** (luật 1: nhiều thành phần, hợp đồng giữa các agent); owner xác nhận Large ở Q5
- Supersedes: Routing Decision của phần điều tra cùng request (Small, bead `bm-llmg`, chỉ trả lời "vì sao")

## 1. Owner nói gì

Yêu cầu đầu, kèm ảnh chat Manager của workspace "Refactor Dependency":

> Tôi đang có 1 Workspace là Refactor Dependency, nhưng việc hiển thị của nó khi làm việc không theo thẻ Card, đây là bug cực kỳ nghiêm trọng. Hãy đánh giá phân tích và trả lời tôi vì sao Plugin không làm việc như kỳ vọng

Sau câu trả lời điều tra (bead `bm-llmg`, review `b1` pass):

> Hãy làm thật chặt về việc thiếu và sai nguyên tắc khi tương tác phối hợp giữa các Agent, việc không tuân thủ convension, template khi truyền đạt thông tin là điệu CỰC KỲ NGUY HIỂM và KHÔNG CHẤP NHẬN

### 1.1 Quyết định của owner (2026-09-18)

Owner trả lời bằng khối `BM-ANSWERS`: Q1 c, Q2 a, Q3 a, Q4 a, Q5 a.

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q1 | Nhận diện agent `bm-*` thiếu nhãn `bm.role` | **(c)** Làm cả hai: (a) plugin nhận vai trò theo provider `bm-*` ở mọi chỗ đang đọc nhãn và cảnh báo "agent này không do paseo-bm tạo" trong chat đó, không đổi gì trên agent; (b) plugin tự gắn nhãn khi agent được tạo, bằng `paseo agent update --label` |
| Q2 | Bắt buộc template | **(a)** Plugin kiểm mỗi khối agent gửi khi lượt kết thúc (đủ trường, giá trị hợp lệ, bead id đầy đủ, `Q<n>` có lựa chọn a/b và đúng một `(recommended)`); sai thì gửi agent đó thông báo `BM-FORMAT` liệt kê lỗi, yêu cầu gửi lại cả khối; thẻ hiện chip "sai template" |
| Q3 | Hiển thị khi không vẽ được thẻ | **(a)** Vẫn trình bày như thẻ: mỗi trường một dòng, câu hỏi và lựa chọn tách dòng |
| Q4 | Prompt Worker thiếu mode Reviewer | **(a)** Sửa trong request này: tìm nguyên nhân; tra cứu mode thất bại thì dùng giá trị dự phòng và ghi log |
| Q5 | Quy mô | **(a)** Large cho Q1–Q4, một bộ delta |

### 1.2 Quyết định sau `reviewing-plan` (2026-09-18)

Owner trả lời bằng khối `BM-ANSWERS`: Q6 a, Q7 a, Q8 a, Q9 a, Q10 a.

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q6 | Agent `bm-*` thiếu nhãn đã tồn tại (`f13a4e4e`, `c8bca1ea`) | **(a)** Quét một lượt khi plugin nạp: gắn nhãn đúng vai cho agent `bm-*` chưa lưu trữ đang thiếu nhãn (Manager kèm `bm.modeSet` = mode hiện tại); chip cảnh báo biến mất |
| Q7 | Độ chặt bộ kiểm | **(a)** Mọi trường của mẫu `BM-REPORT` đúng thứ tự mẫu, và báo cáo `blocked` bắt buộc có khối `BM-QUESTIONS`. Đính chính: câu hỏi viết "13 trường", còn mẫu thực có **12** trường sau dòng `BM-REPORT`. Quyết định là "đủ mọi trường của mẫu, đúng thứ tự"; Worker đã báo owner |
| Q8 | Giới hạn `BM-FORMAT` | **(a)** Tối đa 2 lần cho mỗi người gửi, request và loại khối; mỗi khối cụ thể một lần; quá thì chỉ còn chip và log |
| Q9 | Mode Reviewer dự phòng tĩnh | **(a)** `auto` |
| Q10 | Cài đặt và sửa chồng | **(a)** Trước khi sửa code, có Worker khác đang chạy trong workspace thì Worker báo `blocked` và chờ. Sau khi batch implementation pass, Worker cài và nạp lại plugin **một lần**, khi mọi agent `bm-*` khác idle, và gửi `finished` trước |

### 1.3 Xác nhận trước khi implement (2026-09-18)

Owner trả lời bằng khối `BM-ANSWERS`: Q11 a, Q12 a, Q13 a.

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q11 | Sao lưu trước khi cài | **(a)** Chép payload đang chạy sang `~/.paseo-bm/backups/<stamp>-pre-20260918g` trước khi cài; hoàn tác = chép lại rồi reload; thư mục sao lưu ở lại tới khi owner xoá |
| Q12 | Errata của Q6 | **(a)** Quét một lần mỗi lần nạp, bắt đầu ở sự kiện agent đầu tiên sau khi nạp |
| Q13 | Thay đổi hành vi và bắt đầu implement | **(a)** Đồng ý cả năm điểm: `/bm-worker-stop-all` chạm cả Worker / Reviewer thiếu nhãn (không bao giờ Manager); Beads Manager mở Manager thiếu nhãn và không đổi mode; `BM-FORMAT` đánh thức agent thêm một lượt; plugin chạy `paseo agent update --label`; tổng 6–7 lượt review |

### 1.4 Trong lúc implement (2026-09-18)

Owner trả lời bằng khối `BM-ANSWERS`: Q14 a.

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q14 | Trần số dòng của file vai cho luật `BM-FORMAT` | **(a)** Nâng trần vừa đủ: `worker.md` lên 397, `manager.md` lên 176; ghi lý do trong test như các lần nâng trước; luật giữ nguyên văn |

## 2. Bối cảnh — vì sao bây giờ

Điều tra ngày 2026-09-18 (bead `bm-llmg`, bằng chứng trong lý do đóng bead) tìm ra ba chỗ quy ước không được bảo vệ:

1. **Nhận diện.** Manager `f13a4e4e` của workspace "Refactor Dependency" được mở từ màn tạo agent của Paseo bằng profile "Manager", không qua Beads Manager. Hook `before("agent.create")` vẫn nạp chỉ dẫn Manager, nhưng hook không gắn được nhãn, nên agent có `labels: {}`. Mọi chỗ plugin tìm agent đều lọc theo nhãn `bm.role`, nên plugin coi chat đó "không phải của paseo-bm":
   - thẻ không được vẽ, báo cáo dồn thành một đoạn;
   - thẻ câu hỏi và pill chờ không hiện ở đâu;
   - mở Beads Manager trong workspace đó sẽ tạo Manager thứ hai.

   Workspace paseo-bm có một Manager khác cùng dạng (`c8bca1ea`).
2. **Template không ai kiểm.** Hôm nay báo cáo của Worker vẫn đúng mẫu. Nhưng không có gì bảo đảm điều đó: một báo cáo sai trường, sai giá trị hay thiếu `(recommended)` đi thẳng tới người nhận, và không ai được báo.
3. **Mode Reviewer.** Worker nào tạo trong ngày cũng thiếu mục `## Runtime facts` nêu mode Reviewer, nên lần tạo Reviewer đầu tiên bị Paseo từ chối (`cannot inherit mode 'bypassPermissions' …`).
   - Mã sửa (errata 2026-09-18) đã có trong working tree nhưng chưa bao giờ được cài lên daemon: bản đang chạy `~/.paseo-bm/plugin/0.2.0-alpha.0` còn `if (role !== "manager") return {}`.
   - Ngoài ra, khi tra cứu mode thất bại, `runtimeFactsOf` trả `{}` và **không ghi log**.

## 3. Tác nhân

- **Owner** (người dùng Paseo): mở Manager bằng Beads Manager, bằng `/bm-worker-new`, hoặc bằng màn tạo agent của Paseo; đọc thẻ; trả lời câu hỏi.
- **Manager, Worker, Reviewer**: ba agent của paseo-bm, gửi nhau các khối `BM-*`.
- **Plugin paseo-bm** (server trong daemon, client trong app): nhận diện agent, vẽ thẻ, kiểm khối, gửi thông báo.

## 4. Mục tiêu và bằng chứng thành công

| Mục tiêu | Bằng chứng |
|---|---|
| Một agent `bm-*` được nhận đúng vai dù thiếu nhãn | Test: `chat.peers`, `chat.waiting`, `manager.ensure`, cây agent, `/bm-worker-stop-all` với Manager không nhãn (dữ liệu giống `f13a4e4e`) → nhận ra Manager; thẻ vẽ, câu hỏi có nút |
| Agent `bm-*` tạo thiếu nhãn được gắn nhãn | Test với CLI giả: `agent.created` của một `bm-manager` không nhãn → đúng một lệnh `paseo agent update <id> --label bm.role=manager --label bm.modeSet=<mode>`; CLI lỗi → một dòng log, không ném |
| Khối sai template bị phát hiện và người gửi được báo | Test bộ kiểm: mỗi luật một ca sai, một ca đúng; test luồng: khối sai → đúng một `BM-FORMAT` tới người gửi, không bao giờ gửi vào lượt đang chạy, không quá giới hạn |
| Người dùng thấy khối sai | Test: thẻ của khối sai có chip "template error" và danh sách lỗi |
| Không vẽ được thẻ vẫn đọc được | Test: bản dự phòng dùng cùng cách trình bày Markdown của thẻ |
| Worker luôn biết mode Reviewer | Test: tra cứu thất bại → mục `## Runtime facts` vẫn có mode dự phòng và có một dòng log |

## 5. Yêu cầu

**REQ-061 — Plugin bắt buộc quy ước phối hợp giữa các agent** (P1)

- **(a) Nhận diện.** Vai của một agent do plugin quyết như sau:
  - theo nhãn `bm.role` nếu có;
  - không có nhãn thì theo provider `bm-manager` / `bm-worker` / `bm-reviewer` (kể cả dạng `<provider>/<model>`).

  Điều này áp ở mọi chỗ plugin tìm agent: thẻ chat, pill chờ, Beads Manager (mở hay tạo Manager), cây agent, `/bm-worker-stop-all`, dừng Reviewer khi Worker dừng, Dashboard. Không chỗ nào bỏ sót agent vì danh sách dài: đọc hết mọi trang.
- **(b) Cảnh báo.** Trong chat của agent chỉ được nhận theo provider, mỗi thẻ có chip cảnh báo "Not started by paseo-bm". Cây agent đánh dấu agent đó tương tự.
- **(c) Không tạo Manager thứ hai.** Beads Manager (sidebar, Command Center, `/bm-worker-new`) mở Manager đang sống của workspace kể cả khi nó thiếu nhãn.
  - Manager có nhãn được ưu tiên hơn Manager chỉ nhận theo provider.
  - Plugin không đổi mode của Manager chỉ nhận theo provider.
- **(d) Gắn nhãn khi tạo.** Khi một agent `bm-*` vừa được tạo mà thiếu `bm.role`, plugin gắn nhãn vai cho nó qua Paseo CLI.
  - Với Manager, plugin gắn kèm `bm.modeSet` bằng mode hiện tại, để Beads Manager không đổi mode người dùng đã chọn.
  - Lỗi thì ghi một dòng log và không ném; (a) vẫn bảo đảm nhận diện.
  - Mỗi lần plugin nạp, một lượt quét gắn nhãn theo cùng cách cho mọi agent `bm-*` chưa lưu trữ đang thiếu nhãn (Q6). Lượt quét bắt đầu ở sự kiện agent đầu tiên sau khi nạp, vì plugin chỉ có handle Paseo trong hook (errata thiết kế §4.5).
- **(e) Kiểm template.** Plugin kiểm mọi khối `BM-REPORT`, `BM-QUESTIONS`, `BM-ANSWERS`, `BM-REVIEW` một agent gửi cho agent khác, theo mẫu trong chỉ dẫn các vai:
  - đủ trường, không trường lạ, không trùng; trường của `BM-REPORT` đúng thứ tự mẫu (Q7);
  - giá trị hợp lệ (`phase`, `tier`, `verdict`, `reviewKind`, `severity`, `requestId`);
  - trường bead chỉ gồm bead id đầy đủ hoặc `none`;
  - `BM-QUESTIONS`: 1–5 câu `Q<n>` không trùng, mỗi câu ≥ 2 lựa chọn chữ cái liên tiếp từ `a`, đúng một `(recommended)`, `requestId` khớp báo cáo;
  - báo cáo `blocked` có khối `BM-QUESTIONS` trong cùng tin (Q7).

  Tin người dùng tự gõ (có `clientMessageId`) và thông báo của chính plugin không bao giờ bị kiểm. Danh sách luật đầy đủ nằm ở [thiết kế §4.6](../design/paseo-bm-delta-20260918g-agent-conventions.md).
- **(f) Báo người gửi.** Khối sai thì agent gửi nhận một thông báo bắt đầu bằng `BM-FORMAT`: liệt kê từng lỗi, yêu cầu gửi lại **cả khối** đã sửa cho đúng người nhận, rồi tiếp tục như trước.
  - Thông báo không bao giờ được gửi vào một lượt đang chạy.
  - Chỉ khối mới nhất cùng loại của cùng request được báo.
  - Mỗi khối cụ thể được báo tối đa một lần; mỗi người gửi, request và loại khối tối đa 2 lần; quá thì chỉ còn chip và log (Q8).
- **(g) Chip trên thẻ.** Thẻ của khối sai có chip "template error"; mở tin thì thấy danh sách lỗi.
- **(h) Hiển thị dự phòng.** Khi không vẽ được thẻ, tin vẫn trình bày như trong thẻ: mỗi trường một dòng, câu hỏi và lựa chọn tách dòng.
- **(i) Mode Reviewer.** Chỉ dẫn của Worker luôn có mục `## Runtime facts` nêu mode Reviewer. Tra cứu mode thất bại thì dùng danh sách mode đọc được lần gần nhất, không có thì dùng `auto` (Q9); mọi lần tra cứu thất bại (kể cả lỗi bất ngờ) có một dòng log.
- **(j) Chỉ dẫn vai.** `manager.md`, `worker.md`, `reviewer.md` mỗi file có một luật cho tin `BM-FORMAT`: đó là thông báo của plugin, không phải lời người dùng; gửi lại cả khối đã sửa, không làm lại việc.

## 6. Yêu cầu phi chức năng

- **Bảo mật:**
  - không thêm dependency; không truy cập mạng;
  - lệnh Paseo CLI chạy bằng `execFile`, không qua shell, có timeout; mọi id và nhãn được kiểm trước khi thành tham số (như `plugin/server/paseo-cli.ts`);
  - không đọc hay in bí mật.
- **Hiệu năng:** tìm agent cần một lần liệt kê cho mỗi 200 agent. Thẻ vẫn nhớ kết quả `chat.peers` 30 giây như hôm nay. Kiểm một tin tối đa 20 000 ký tự.
- Mọi hook vòng đời không bao giờ ném; một lỗi chỉ tốn một dòng log.
- Không bao giờ gửi một tin vào lượt đang chạy của agent nào (luật đã có của plugin).
- Thông báo `BM-FORMAT` được nhận là thông báo của plugin: kho vết không ghi nó thành lời người dùng, và bộ đếm review không tính nó là một lượt review.
- Test chạy với Paseo giả, CLI giả và `$HOME` giả; không test nào chạm daemon thật.

## 7. Ngoài phạm vi

- Chặn hay sửa một tin sai **trước khi** nó tới người nhận: Paseo không cho plugin chặn `send_agent_prompt`.
- Đổi chính các mẫu `BM-*` hay bộ đọc của chúng.
- Cách Manager nói về thẻ (REQ-059 f), trừ luật `BM-FORMAT`.
- Nâng phiên bản, phát hành, commit. Cài và nạp lại plugin chỉ một lần, theo Q10.

## 8. Ranh giới và phụ thuộc

- Chạy Paseo CLI từ trong tiến trình daemon **chưa được chứng minh** trên daemon thật (bead `bm-wp-249-5qqp.1`, deferred). Vì vậy (d) là cố gắng tốt nhất, còn (a) là bảo đảm.
- Bản sửa (i) và mọi thứ ở đây chỉ tới được agent sau khi plugin được cài lại và nạp lại trên daemon. Working tree hiện có thay đổi chưa commit của các request khác, nên cài lại cũng mang chúng lên daemon.
- Request khác đang sửa cùng lúc `plugin/client/chat-cards.ts` và tài liệu gốc.

## 9. Lộ trình

**Phase 2a-11**: sáu work package (WP-277 → WP-282) theo [plan delta](../plans/paseo-bm-implementation-plan-delta-20260918g-agent-conventions.md).

Điều kiện ra của phase:

- `npm run verify` mã 0;
- REQ-061 có trong PRD gốc;
- plugin được cài và nạp lại một lần (Q10 a).

Owner tự kiểm trên daemon thật sau `finished`.

## 10. Câu hỏi mở

Không còn câu nào của tài liệu: Q6–Q10 đã chốt (§1.2). Vòng xác nhận trước khi implement (luật Large) vẫn diễn ra sau khi beads xong.

## 11. Revision History

| Ngày | Ai | Thay đổi |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Tạo delta theo Q1–Q5 của `req-20260918T071130Z`; Status Review |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Áp vào PRD gốc: REQ-061 (WP-282); Status Accepted, Applied |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Owner chốt Q14 a (§1.4): nâng trần dòng `worker.md` 397, `manager.md` 176 |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Owner xác nhận trước khi implement (§1.3: Q11 a, Q12 a, Q13 a); Status Accepted |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Errata: lượt quét Q6 bắt đầu ở sự kiện agent đầu tiên sau khi nạp (plugin không có handle Paseo lúc nạp) |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Cổng `prd-ready` PASS sau review `b2` (pass ở lần re-review) |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Owner chốt Q6–Q10 (§1.2): quét gắn nhãn khi nạp, thứ tự trường và `BM-QUESTIONS` bắt buộc cho `blocked`, giới hạn 2 lần, `auto` dự phòng, cài một lần sau khi pass; §10 không còn câu mở |
