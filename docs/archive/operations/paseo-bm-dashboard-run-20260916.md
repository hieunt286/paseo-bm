# Biên bản nghiệm thu Dashboard điều phối — 2026-09-16

| Trường | Giá trị |
|---|---|
| Bead | `bm-wp-214-jvg.2` (WP-214) |
| Checklist | [paseo-bm-dashboard-checklist.md](./paseo-bm-dashboard-checklist.md) |
| Payload kiểm | `0.2.0-alpha.0` (chưa phát hành), cài vào `~/.paseo-bm` trên daemon thật |
| Môi trường | Paseo CLI/daemon 0.8.0, Node v26.8.2, Darwin arm64, 10 cpu, 32 GB |
| Repo nháp | `/tmp/bm-acc-20260916/repo` (git + `br init`, prefix `repo`), workspace `wks_1a215b77cbcfd5e7` |
| Vai trò | Manager `bm-manager/claude-opus-5` (mode `bypassPermissions`), Worker `bm-worker/claude-opus-5`, Reviewer `bm-reviewer/gpt-5.6-sol` |
| Bằng chứng thô | `/tmp/bm-acc-20260916/` (ảnh trước, output install, các lần đo, timeline) |

## 1. Cách đo phần giao diện

Dashboard lấy dữ liệu từ `traces.list` và `traces.get`, và hai RPC đó chỉ gọi được từ trong plugin. Để đo được D-2 → D-5, D-10 mà không cần người ngồi trước máy, biên bản này chạy **đúng những module server mà hai RPC đó chạy** (`plugin/server/{trace-store,traces,workflow-steps,cost,beads-store}.ts`, đóng gói bằng esbuild) trên **kho lưu vết thật, danh sách agent thật và kho beads thật**. Bộ đo không ghi gì.

Hệ quả phải ghi rõ: **phần render của giao diện không được đo ở đây.** D-1 vì vậy chỉ có số của tầng server; thời gian vẽ màn hình vẫn là việc kiểm bằng mắt, đúng như WP-113 đã ghi nhận cho phần launcher.

## 2. Bốn lỗi đầu tiên, tìm ra trên repo nháp

Đợt nghiệm thu này tìm ra **hai mươi** lỗi: bốn ở mục này, lỗi thứ năm ở §3, và chín lỗi ở §3b. **Không lỗi nào trong số đó bị unit test bắt**, vì tất cả đều sinh ra từ văn bản mà agent thật viết hoặc từ hình dạng dữ liệu mà daemon thật trả về. Đó là toàn bộ lý do tồn tại của đợt nghiệm thu này.

| # | Lỗi | Biểu hiện thật | Sửa |
|---|---|---|---|
| 1 | `requestId` viết dạng markdown bị bỏ sót | Manager và Worker viết `` - `requestId`: `req-20260916T064147Z` ``; regex chỉ khớp dạng trần, nên trace tụt xuống `linking: inferred` dù có nhãn | Một pattern khoan dung duy nhất `REQUEST_ID_PATTERN` trong `bm-report.ts`, dùng chung cho collector và reconstruction; Manager turn mở trace nay đọc được id từ **câu trả lời của chính nó** (`managerRequestId`), và một Worker có nhãn mà không khớp bucket nào sẽ **nhận** request đó khi đúng một cửa sổ chứa nó |
| 2 | `br create --help` bị tính là đã tạo bead | Worker chạy `br create --help` để tự định hướng → bảng bước quy trình báo `convert_to_beads=done/inferred` dù không có bead nào | Bỏ qua `--help`/`-h`/`--dry-run`; và **một phủ định chính xác thắng một suy luận**: nếu báo cáo `finished` nói `beadsCreated: none` thì tín hiệu shell không được ghi đè |
| 3 | Tìm file test bị tính là đã chạy test | `grep -iE 'makefile\|pyproject\|pytest\|tox'` khớp pattern test → `build_and_tests=done` | Neo pattern vào **đầu từng đoạn lệnh**, sau khi làm trắng phần trong dấu nháy; thêm bộ nhận diện "không chạy gì" cho `buildAndTests` (`not run — NOTE: …` trước đây bị tính là đã chạy vì không khớp đúng `not run`) |
| 4 | Một yêu cầu bị đếm thành sáu trace | `measureStore` khoá theo `turnId` khi bản ghi không có `requestId` | Đếm theo **request**, không theo lượt; agent chưa bao giờ báo request id thì đếm một lần theo agent |

Mỗi lỗi có test hồi quy dùng đúng chuỗi lệnh/văn bản thật quan sát được.

Ngoài ra, một **phát hiện vận hành**: chạy `install --apply` và `paseo plugin reload` **trong lúc một agent `bm-*` đang chạy** làm ngắt lượt của nó, và `worker.md` coi lượt bị ngắt là người dùng bấm Stop, nên Worker đứng lại và gửi báo cáo `finished`. Checklist §2 cần một dòng cảnh báo; trong đợt này nó biến F-1 thành một fixture F-5 ngoài kế hoạch (và nhờ đó lộ ra lỗi số 3 dưới đây).

## 3. Lỗi thứ năm: `finished` không có nghĩa là thành công

`worker.md` gửi `phase: finished` **cả khi xong việc lẫn khi bị dừng**. Quy tắc §7.3 của design đọc `finished` thành `completed`, nên một yêu cầu bị dừng giữa chừng — không viết một dòng nào, không tạo bead nào — hiện lên Dashboard là **Completed**. Đó là loại sai tệ nhất mà màn hình này có thể mắc: nó nói một lượt chạy tồi là tốt.

Sửa: `finished` kèm `blockers` khác rỗng, hoặc trace có lượt `canceled`, thì trạng thái là `stopped`. Đo lại trên đúng dữ liệu đó: `state: stopped`, `linking: exact`, và mọi bước chưa tới đều `unknown` thay vì `done` giả.

## 3b. Chín lỗi luật, tìm ra khi đối chiếu với dữ liệu thật

Năm lỗi ở §2–§3 tìm ra từ repo nháp. Chín lỗi dưới đây chỉ lộ ra khi bộ đo chạy trên **workspace thật của chính owner** (`wks_a217b1fc9568ab78`) và trên F-1 sau khi nó chạy xong hẳn. Tám trong chín chạm vào các **luật** của design, nên chúng đi qua [delta 20260916-acceptance-fixes](../design/paseo-bm-delta-20260916-acceptance-fixes.md).

| # | Lỗi | Biểu hiện thật | Sửa |
|---|---|---|---|
| 6 | Kho đếm 4 trace, màn hình hiện **0 dòng** | Trên workspace của owner, 11 bản ghi chứa **hai** `requestId` chính xác nhưng không ra dòng nào: plugin bắt đầu thu khi nó được nạp, nên mọi lượt Manager ở đó chỉ còn `BM-REPORT` của chính nó, và luật cũ đòi phải có tin nhắn người dùng mới mở được trace | Trace mở được từ `requestId` đọc được; không có lời yêu cầu thì dòng đó **nói rõ** là chưa ghi được, thay vì biến mất. Bucket khoá theo `requestId` để N lượt không thành N dòng |
| 7 | Một request tạo 1 bead, đóng 1 bead → báo **2 tạo / 6 đóng** | `br create … -l "feature:format-date,component:invoice"` và `br close repo-37g -r "… a single-line docstring …"`: mọi từ có gạch nối trong dòng lệnh bị đọc thành id bead, kể cả `single-line`, `non-empty`, `bm-reviewer`, `gpt-5.6-sol` | Id bead **chỉ** là tham số vị trí, trước cờ đầu tiên, sau khi làm trắng phần trong dấu nháy. `br create` không nêu id nào |
| 8 | Một request **đã giao xong** hiện là "Stopped" | F-1 bị ngắt bốn lần rồi làm xong: báo cáo cuối `finished` với `blockers` rỗng, nhưng 7 lượt trước đó là `canceled`, và luật "có lượt `canceled` bất kỳ → stopped" thắng | **Chỉ báo cáo cuối cùng quyết định.** Đây đúng là ảnh phản chiếu của lỗi thứ năm ở §3 — và nó cho thấy vì sao phải đo chứ không phải suy luận |
| 9 | Cập nhật tiến độ của Worker mở ra một **request giả** | Worker gửi cập nhật cho Manager bằng `send_agent_prompt`, và chúng tới **y như** tin nhắn người dùng. Dòng "Status update (not a milestone report): the user resumed me…" hiện thành một request không worker, không bead, 11 bước `unknown` | Lượt Manager không nêu `requestId` thuộc về **request mà Manager nêu ở lượt kế tiếp**. Không có dấu hiệu văn bản nào đáng tin; lời của chính Manager ở lượt sau là bằng chứng |
| 10 | Một bản ghi chứa **toàn bộ** hội thoại | Lượt có `turnId` null đi vào nhánh "không lọc" và ghi cả 13 tin nhắn, 10 báo cáo vào một bản ghi; vì tin đầu là lời yêu cầu của F-1, nó gộp vào F-1 và nhân token của request đó lên | Không có `turnId` thì cắt từ tin nhắn người dùng cuối cùng trở đi — đúng luật đã dùng cho payload của hook, nhưng áp lên entry của `refetch` để giữ được `timestamp` |
| 11 | **Chi phí provider là tổng luỹ kế, không phải chi phí một lượt** | Đo trên 12 lượt Manager thật: `lastUsage.totalCostUsd` **chỉ tăng** (0,3956 → 0,4492 → 0,6749 → 0,7948 → … → 2,2712) trong khi token bên cạnh lên xuống theo từng lượt. Cộng nó qua các lượt của một request sẽ nhân chi phí lên nhiều lần | Bản ghi lượt **không** ghi `totalCostUsd`; chi phí một request **luôn** là số tạm tính từ token của từng lượt. Đây là phần **đổi một quyết định đã chốt** (Q-035), nên nó đi qua delta |

Lỗi 11 đáng nói thêm: nó không làm màn hình sai *ngay*, vì bộ tổng hợp đang bỏ qua chi phí provider và tự tạm tính. Nhưng design **ghi** là "provider báo thì lấy số của provider", nên bất kỳ ai sửa code theo đúng design sau này sẽ tạo ra một hoá đơn sai gấp nhiều lần. Lỗi nằm ở tài liệu, và tài liệu đã được sửa.

| 12 | "Beads polished: **Done**" cho một yêu cầu Nhỏ, nơi polish bị **cấm** | F-1 chạy `br update repo-37g` ba lần trong một lượt (sửa description, sửa lại, rồi đổi status) và luật "≥2 lệnh `br update` trong một lượt" đọc đó thành một vòng polish — dù chính Worker báo `polish 0/0` | Hai sửa: (a) một guardrail báo `polish 0` là **phủ định chính xác** và thắng mọi suy luận; (b) vòng polish phải chạm **≥2 bead khác nhau**, vì sửa nhiều lần cùng một bead là việc thường |

| 13 | `meta.json` của workspace nói `lastSeenAt: 06:42` cho một workspace hoạt động tới `07:35` | Bộ ghi meta chỉ so **tên** và **đường dẫn** rồi bỏ qua lần ghi nếu hai cái đó không đổi, nên `lastSeenAt` đóng băng ở lượt đầu tiên | So cả ba trường. Đây là một file **chúng ta phát hành**, và một trường tên là `lastSeenAt` thì phải đúng nghĩa; chi phí là một file nhỏ ghi atomic cạnh một lần append đã xảy ra mỗi lượt |

| 14 | Xoá Worker thì dòng trace **mất phần việc của nó**, dù byte vẫn nằm trong kho | Bản ghi chỉ được gắn vào trace qua **danh sách agent**. Người dùng xoá Worker → `agents.list` không còn gì để khớp → mọi bản ghi của nó rơi ra ngoài. Lưu trữ (archive) thì không sao vì `includeArchived: true` vẫn trả về agent; **xoá** thì mất. Đây đúng là chân thứ ba của D-8, và nó lộ ra khi đọc lại code trước khi chạy D-8 | Một bản ghi **tự nêu request của nó**, thế là đủ để gắn. Bản ghi có `requestId` khớp được gắn vào trace kể cả khi agent không còn, và agent đó vào danh sách "không còn trên máy này" thay vì bị bỏ lặng lẽ |

Kèm theo là một **luật phụ**: "báo cáo mới nhất" phải là mới nhất **theo thời gian**, không phải phần tử cuối mảng — báo cáo tới một trace từ ba lượt duyệt khác nhau. F-1 đọc `state`, `tier` và `guardrail` từ một báo cáo lạc chỗ (nó báo `tier: Medium` cho một request Small).

## 3c. Hai phát hiện vận hành — nằm ngoài Dashboard nhưng quan trọng hơn

Cả hai đều thuộc **vòng điều phối** (`plugin/roles/worker.md`), không thuộc Dashboard. Chúng được ghi ở đây vì đợt nghiệm thu này là lần đầu vòng điều phối chạy dài trên daemon thật, và đây là những gì nó bộc lộ.

### Phát hiện 1 — nạp lại plugin khi có agent đang chạy sẽ ngắt lượt của nó

`install --apply` và `paseo plugin reload` làm ngắt lượt của mọi agent `bm-*` đang chạy, và `worker.md` coi lượt bị ngắt là người dùng bấm Stop. Đã thành "Cảnh báo 2" trong checklist §2. Trong đợt này nó biến F-1 thành fixture F-5 ngoài kế hoạch.

### Phát hiện 2 — Manager chuyển tiếp tin nhắn giữa lượt cũng bị Worker hiểu là Stop

Đây là phát hiện nặng hơn, và nó tái diễn **năm lần** trong đợt này.

`worker.md` nhóm 6 định nghĩa: *"Lượt của bạn bắt đầu ngay sau một lượt bị ngắt — từ thông báo một Reviewer hoặc agent khác đã xong, hoặc không có chỉ dẫn mới nào từ người dùng — hãy coi đó là một lệnh dừng."* Luật đó có lý khi nó được viết: nó chặn Worker tự chạy tiếp sau khi bị dừng.

Nhưng trên daemon thật, **hành vi bình thường của Manager lại khớp đúng điều kiện đó**:

| Điều đã xảy ra | Worker hiểu thành |
|---|---|
| Reviewer chạy xong và Paseo gửi thông báo | Stop → Worker không đóng bead, gửi `finished` |
| Manager chuyển tiếp override tier của người dùng giữa lúc Worker đang làm | Stop → Worker dừng ở bước đầu (F-2, 51k token) |
| Người dùng nhắn cho Manager, Manager nhắn lại cho Worker | Stop |

Hệ quả thực tế quan sát được: F-1 cần **bốn** lượt nhắc của người chạy mới đi hết một việc chỉ gồm thêm một dòng docstring, và ba trong bốn lần dừng xảy ra khi phần việc còn lại đúng **một câu lệnh**. Chính Worker cũng nhận ra và nói ra: *"đây là lần ngắt thứ tư, và ba trong số đó rơi vào lượt mà việc còn lại chỉ là một câu lệnh… nếu những lần dừng đó không phải cố ý, có thể có gì đang kích hoạt Stop của Paseo."*

**Đây không phải lỗi của Dashboard và không sửa trong WP-214.** Nó chạm `roles/worker.md`, tức hành vi sản phẩm mà owner đã chốt, nên nó được ghi thành bead riêng để owner quyết định, không tự sửa. Điều đáng nói là Dashboard **đã làm đúng việc của nó**: chính cột trạng thái và bảng bước quy trình cho thấy một request "finished" mà chưa đóng bead — đó là cách phát hiện này lộ ra.

## 4. Kết quả từng fixture

### F-1 — việc nhỏ, một file (Nhỏ)

Yêu cầu: thêm docstring cho `format_date` trong `src/invoice.py`. `requestId: req-20260916T064147Z`, Manager `06c0c92c`, Worker `dc2f85d3`, Reviewer `f2798994`.

Đo sau khi F-1 chạy xong hẳn và sau khi sửa xong lỗi 6 → 11 (bộ đo chạy đúng các module server mà RPC chạy):

| Mục | Số trên màn hình | Đối chiếu độc lập | Kết quả |
|---|---|---|---|
| Số dòng cho 1 yêu cầu | 1 | 1 | khớp |
| Worker / agent Reviewer | 1 / 1 | `paseo ls`: 1 Worker (`dc2f85d3`), 1 Reviewer (`f2798994`) | khớp (D-2) |
| Lượt review | `reviewCalls: 1` | Worker tự báo `reviews 1/1` | khớp, và hai số hiện riêng (D-2) |
| Nhãn liên kết | `bm.requestId=req-20260916T064147Z`, `bm.batchId=b1` trên Reviewer | đọc từ `list_agents` | khớp → `linking: exact` (D-2) |
| Bead | 1 tạo / 1 cập nhật / 1 đóng, đều `exact`, đều là `repo-37g` | `br list`: `repo-37g` closed; diff `issues.jsonl` trước–sau: đúng 1 bead mới | khớp (D-4) |
| Trạng thái | `completed` | bead đã đóng, báo cáo cuối `finished` không có blocker | khớp (D-5) |
| Tier | `Small` | Worker tự phân loại Small, không override | khớp |
| Bước quy trình | `classify_tier` done/exact · PRD/design/ADR/plan **skipped** · `convert_to_beads` done/exact · `implement` done/exact · `review_batches` done/exact · `build_and_tests` done/exact · `close_with_evidence` done/exact | từng ô có bằng chứng lệnh/báo cáo tương ứng | đạt yêu cầu của F-1: bốn bước tài liệu là **skipped**, không phải `unknown` (D-5) |
| Chi phí | `estimated`, kèm ngày bảng giá `2026-06-24` | Reviewer (`gpt-5.6-sol`) không có trong bảng giá → **chỉ hiện token** | khớp luật mới ở §9 (D-10) |

Một ghi chú thật thà về F-1: bốn lần ngắt do chính người chạy gây ra (xem cảnh báo dưới) làm thời gian tường của nó (`durationMs` ≈ 20 phút) **không** đại diện cho một yêu cầu Nhỏ. Số đó đúng với cái nó đo — thời gian tường từ lúc yêu cầu tới lúc xong — nhưng không dùng để kết luận gì về hiệu năng.

### F-5 — yêu cầu bị dừng giữa chừng (ngoài kế hoạch)

Sinh ra từ chính lần ngắt đầu tiên. Đo trên đúng dữ liệu đó: `state: stopped`, `linking: exact`, và mọi bước chưa tới đều `unknown` thay vì `done` giả. Đây là fixture đã lộ ra lỗi thứ năm.

### F-2 — việc vừa, sửa một tài liệu sẵn có (Vừa)

Yêu cầu: thêm endpoint `GET /invoices/{id}/total`, cập nhật `docs/api.md`, dùng lại `total()`. `requestId: req-20260916T070544Z`, Worker `beb32504`, ba Reviewer `30b6813f` (b1 tài liệu), `52b00b1c` (b2 bead), `e8dd4da8` (b3 implementation).

Đây là fixture cho **phân rã nhiều tầng** mà yêu cầu số 1 của owner nói tới: một yêu cầu → một Worker → **ba** agent Reviewer.

| Mục | Số trên màn hình | Đối chiếu độc lập | Kết quả |
|---|---|---|---|
| Số dòng cho 1 yêu cầu | 1 | 1 | khớp |
| Worker / agent Reviewer | 1 / **3** | `paseo ls`: đúng 3 agent `bm-reviewer` với `paseo.parent-agent-id` = Worker | khớp (D-2) |
| Lượt review | `reviewCalls: 4` | Worker tự báo `total 4/6` | khớp, **và hai số khác nhau được hiện riêng**: 3 agent nhưng 4 lượt (b2 được review hai lần) — đúng điều REQ-042b yêu cầu (D-2) |
| Nhãn liên kết | `bm.requestId` + `bm.batchId` = `b1`/`b2`/`b3` trên ba Reviewer | đọc từ `list_agents` | khớp → `linking: exact`, **0** notice (D-2) |
| Bead | 1 tạo / 1 cập nhật / 1 đóng, đều `exact`, đều là `repo-mvb` | `issues.jsonl` trước–sau: đúng 1 bead mới (`repo-mvb`), đã đóng; `repo-cv6` **không** bị chạm | khớp (D-4) |
| Trạng thái | `completed` | bead đã đóng, `docs/api.md` và `src/invoice.py` đã sửa | khớp (D-5) |
| Tier | `Medium` | Manager ước lượng Large theo rule 1, owner override xuống Medium; Worker ghi nhận override | khớp, và override được ghi đúng |
| Bước quy trình | chỉ `polish_beads` là **skipped**; bốn bước tài liệu là `unknown`; sáu bước còn lại `done/exact` | mỗi ô `done` có lệnh hoặc báo cáo tương ứng | đạt yêu cầu của F-2 (D-5) |
| Chi phí | `estimated` + ngày bảng giá; ba Reviewer Codex **chỉ hiện token** | — | khớp luật mới ở §9 (D-10) |

Ghi chú về bốn ô `unknown` của tài liệu: Worker **có** sửa `docs/api.md`, nhưng bốn bước đó là PRD/design/ADR/plan, và sửa một tài liệu API sẵn có không phải bước nào trong bốn bước ấy. `unknown` ở đây là câu trả lời **đúng**, không phải thiếu sót — và nó chính là điều F-2 dùng để kiểm: một bước không quan sát được thì không bao giờ được báo là `skipped`.

### F-3 — việc lớn, chạm lược đồ dữ liệu (Lớn) — chạy theo hướng dẫn **cũ**

Yêu cầu: đổi `amount` sang số nguyên xu, kèm chuyển đổi dữ liệu cũ và cách quay lại. `requestId: req-20260916T073405Z`, Worker `82710447`. Bị huỷ giữa chừng theo góp ý của owner, rồi cho làm nốt bead cuối.

| Mục | Màn hình | Đối chiếu | Kết quả |
|---|---|---|---|
| Worker / Reviewer | 1 / **9** | `list_agents`: 9 agent `bm-reviewer` mang `bm.requestId` của F-3, batch b1 → b8 (b8 có 2 agent) | khớp (D-2) |
| Lượt review | quan sát **10**, Worker tự báo **16** | — | hai số hiện riêng và bị gắn cờ **lệch** — đúng REQ-042c (D-2) |
| Bead | 3 tạo / 3 đóng `exact` (`repo-xdy`, `repo-x14`, `repo-tr3`) | diff `issues.jsonl`: đúng 3 bead mới, cả 3 đóng | khớp (D-4) |
| Bead "cập nhật" | Worker báo cập nhật cả `repo-cv6` | `updated_at` của `repo-cv6` vẫn là lúc tạo (06:41), trước request (07:34) | **lỗi 15**, xem dưới |
| Bước quy trình | PRD/design/ADR/plan đều `done/exact` (6–7 bằng chứng mỗi bước); `polish_beads` `skipped/exact` vì Worker báo `polish 0` | có đủ 4 file trong `docs/` của repo nháp | đạt: không bước nào bị `skipped` mà không có bằng chứng (D-5) |
| Trạng thái / tier | `completed` / `Large` | 3 bead đã đóng | khớp |
| Chi phí | **$27,07** tạm tính | — | có nhãn và ngày giá (D-10) |

**Lỗi 15 — Dashboard lặp lại một lời báo sai với nhãn `exact`.** Worker liệt kê `repo-cv6` trong `beadsUpdated`, nhưng kho bead cho thấy bead đó không đổi kể từ trước request. Sửa: một bead được báo là "đã cập nhật" mà `updated_at` cũ hơn lúc request bắt đầu sẽ bị hạ xuống `unknown`, và trace ghi rõ tên nó. Có test hồi quy.

**Đây là minh hoạ rõ nhất cho góp ý của owner:** chạy theo hướng dẫn cũ, một yêu cầu trong repo nháp tốn **16** lượt review, 9 Reviewer, gần 2 giờ và khoảng $27.

### F-1b — việc nhỏ, chạy lại theo hướng dẫn **mới**

Manager mới `4c5e26ce`, yêu cầu: thêm docstring cho `total()`, không sửa gì khác.

- Manager trả lời trong vài dòng, không tự thêm ràng buộc.
- Worker `84406e88` phát hiện `total()` **đã có** docstring trong phần sửa chưa commit (F-3 viết vào — do tôi cho hai request chạy song song trên cùng file), **dừng lại và hỏi sau khoảng 20 giây**: không sửa, không tạo bead, không review.
- Sau khi chọn "giữ nguyên", nó đóng request với **0 file, 0 bead, 0 review**.

Ghi nhận thêm: bản rút gọn đầu tiên làm Manager trả lời bằng tiếng Anh; đã thêm luật "trả lời bằng ngôn ngữ của người dùng" và kiểm lại — lần sau Manager trả lời tiếng Việt.

### F-4 — yêu cầu trùng bead đang mở (Vừa)

Yêu cầu: làm tính năng xuất hoá đơn ra CSV, trùng bead mở `repo-cv6`. Worker `6c609ccf` tìm thấy đúng `repo-cv6` qua nhãn `feature:xuat-hoa-don` và báo sẽ **cập nhật bead đó thay vì tạo bead mới**. Nó hỏi 4 câu thiết kế ngắn; owner-runner chọn phương án đề xuất và giữ cỡ Medium.

| Mục | Kết quả |
|---|---|
| Bead | **0 tạo**, `repo-cv6` cập nhật rồi đóng — diff `issues.jsonl` khớp (D-4, đúng tiêu chí F-4) |
| Worker / Reviewer / lượt | 1 / 1 / 1 (D-2) |
| Trạng thái / tier | `completed` / `Medium` (sau lỗi 16) |
| Bước quy trình | chỉ `polish_beads` `skipped`; bước tài liệu `unknown` (D-5) |
| Gợi ý | 4 mục `Suggestion (not done)`, Manager đưa lên thành câu hỏi cho người dùng |

Một điểm lệch nhỏ so với luật mới: Worker tự thêm 2 kiểm tra an toàn không được yêu cầu (chặn sai đơn vị ×100 và CSV injection). Nó có nói rõ, và đó là rủi ro thật, nên không coi là vẽ việc — nhưng cũng cho thấy "chỉ làm đúng yêu cầu" chưa tuyệt đối.

### Sáu lỗi của lượt đo cuối

| # | Lỗi | Sửa |
|---|---|---|
| 15 | Worker báo đã cập nhật `repo-cv6`, kho bead cho thấy không đổi, màn hình vẫn ghi `exact` | Bead báo "cập nhật" mà `updated_at` cũ hơn lúc request bắt đầu → hạ xuống `unknown` kèm ghi chú |
| 16 | Hai request đã xong hiện "Stopped" | `blockers` bắt đầu bằng `none`, hoặc chỉ gồm `Suggestion (not done)`, không còn bị coi là dừng. Lỗi này do chính luật mới gây ra (gợi ý ghi vào `blockers`); `worker.md` nay nói rõ "`none. Suggestion (not done): …`" |
| 17 | Xoá Worker thì mất phần token của nó: 14/14 bản ghi của Worker F-1 không có `requestId` | Collector lấy `bm.requestId` từ nhãn trong snapshot agent (đã có sẵn trong lệnh `refetch`). Kiểm trên daemon: bản ghi mới của Worker F-4 mang đúng id. **Dữ liệu ghi trước bản sửa vẫn thiếu id** |
| 18 | **Nút "Xoá trace này" không xoá gì**: giao diện gửi `req:req-…`, kho so với `req-…`. Test cũ dùng đúng dạng id sai nên không bắt được. Hộp xác nhận cũng ghi "102 traces" cho một workspace 5 request | Server dựng lại trace rồi xoá **đúng các bản ghi dòng đó hiển thị**; mọi con số dùng chung một hàm đếm theo request |
| 19 | Sau khi xoá một trace, Worker của nó (vẫn còn trên máy) bị gắn nhầm sang F-3 theo thời gian | Agent đã nêu request của mình mà request đó không còn thì vào nhóm "không liên kết được", không bao giờ bị đoán sang request khác |
| 20 | F-4 được tính giờ trễ khoảng 4 phút: tin nhắn "(a) giữ nguyên. Yêu cầu mới: xuất CSV" vừa đóng một request vừa mở một request, và bị gắn vào request đang đóng | Nếu một request **mở ra** (báo cáo `received` đầu tiên) trước lượt vô danh kế tiếp, tin nhắn thuộc request vừa mở. Kiểm bằng test dựng đúng chuỗi lượt thật |

### D-8, D-9, D-11 trên kho thật

| ID | Đo | Kết quả |
|---|---|---|
| D-8 reload | 3 lần cài lại/nạp lại plugin; đọc trước–sau: **149 bản ghi, 5 dòng, giống hệt** | **PASS** |
| D-8 lưu trữ Worker | mô phỏng `archivedAt` trên Worker F-1: dữ liệu mọi dòng giữ nguyên, thêm ghi chú "has been archived" | **PASS** |
| D-8 xoá Worker | mô phỏng bỏ Worker khỏi `agents.list` (không xoá agent thật trên daemon của owner). Sau lỗi 17: trạng thái, tier, bead giữ nguyên, Worker được liệt kê "không còn trên máy". Phần token từ bản ghi **ghi trước** bản sửa bị mất | **PASS cho dữ liệu thu sau bản sửa**; dữ liệu cũ là giới hạn đã biết |
| D-8 khởi động lại daemon | không chạy (§5b) | **Exception** |
| D-9 xoá một trace | qua đúng đường của RPC: dòng F-1b biến mất, 4 dòng còn lại **giống hệt**, dung lượng giảm **15.509 byte = bản xem trước**, **0** file ngoài kho đổi | **PASS** (sau lỗi 18, 19) |
| D-11 gán lại | sang workspace khác rồi gán về: **150 → 150 → 150** bản ghi, xem trước = thật, **0** file ngoài kho đổi, không còn thư mục thừa. Nhánh gộp vào đích đã có dữ liệu chỉ kiểm bằng unit test | **PASS** |

## 5. Bảng kết quả D-1 → D-11

Cột "Kết quả" chỉ ghi PASS khi **mọi** phần của ngưỡng đã đo. Ngưỡng nào chưa đủ fixture thì ghi rõ là chưa đủ, không ghi PASS.

| ID | Ngưỡng | Đo được | Kết quả |
|---|---|---|---|
| D-1 | Mở đúng 1 lần bấm; danh sách hiện trong ≤ 3 giây với ≤ 20 agent và ≤ 500 trace | Trên kho thật: **8,7 → 17,2 ms** cho 53 bản ghi / 7 agent. Nhưng kho thật chỉ có **hai** request, thấp hơn ngưỡng ba bậc độ lớn, nên con số đó **không** chứng minh được ngưỡng. Vì vậy dựng đúng trường hợp xấu nhất mà ngưỡng nêu — **500 trace / 1.500 bản ghi / 20 agent** — và đo dựng lại + tóm tắt + **cả 500 bảng bước quy trình**: năm lần chạy cho `46,0 / 35,5 / 30,4 / 24,3 / 23,0 ms`, **tệ nhất 46 ms**. Phần vẽ màn hình **không đo** ở đây (§1) | **PASS ở tầng server, đo đúng quy mô ngưỡng** (46 ms so với 3.000 ms, còn nguyên phần cho I/O và render); phần render là ngoại lệ ở §5b |
| D-2 | Số Worker và số agent Reviewer khớp 5/5 với đếm tay; số **lượt** review hiện riêng | F-1 1/1/1 · F-2 1/**3**/4 · F-3 1/**9**/10 (Worker tự báo 16 → gắn cờ lệch) · F-4 1/1/1 · F-5 cùng agent với F-1. Mọi Reviewer mang `bm.requestId` + `bm.batchId` → `linking: exact` | **PASS 5/5** |
| D-3 | Lệch ≤ 1 giây so với mốc thật | So mốc kết thúc trên màn hình với `updatedAt` của chính agent trong Paseo: F-2 **14 ms**, F-3 **168 ms**. F-4 **lệch khoảng 4 phút** ở mốc bắt đầu (lỗi 20, đã sửa, kiểm bằng test dựng đúng chuỗi lượt thật; kho đã xoá nên không đo lại trực tiếp được). F-1/F-5 lệch do một bản ghi hỏng ghi trước bản sửa lỗi 10 | **PASS 2/5 đo trực tiếp; No cho F-1, F-4 trên dữ liệu cũ** — cả hai nguyên nhân đã sửa |
| D-4 | Bead created/updated/closed khớp 5/5 với diff `issues.jsonl` | F-1 `repo-37g` · F-2 `repo-mvb` · F-3 3 tạo/3 đóng khớp; "cập nhật `repo-cv6`" **sai** → lỗi 15, nay hạ xuống `unknown` · F-4 0 tạo, `repo-cv6` cập nhật + đóng · F-5 0/0/0 `exact` | **PASS 5/5 sau lỗi 15** |
| D-5 | 0 ô "đã làm" không bằng chứng; 0 ô "không làm" khi Worker không báo mức | F-1 bước tài liệu `skipped` · F-2/F-4 chỉ `polish` `skipped`, tài liệu `unknown` · F-3 bốn bước tài liệu `done/exact`, `polish` `skipped` vì Worker báo `polish 0` · F-5 bước chưa tới đều `unknown` | **PASS 5/5** (sau lỗi 12) |
| D-6 | Khớp `br stats` và `br ready` trên 3 repo, một repo không có `.beads/` | Repo nháp: `2/1/0/0/1/1` — **giống từng số**. Repo `paseo-bm`: `130/1/1/1/128/0` — **giống từng số**. `/tmp` (không có `.beads/`): `present: false`, mọi số 0 | **PASS** |
| D-7 | 0 file ghi ngoài `~/.paseo-bm/traces`, 0 agent bị chạm, 0 lời gọi mạng, 0 lần ghi vào repo | Ảnh chụp `~/.paseo-bm`, `~/.paseo` và repo nháp trước–sau khi chạy **mọi** đường đọc của Dashboard: **528 file trước, 528 file sau, 0 file đổi**. `node:net`/`tls`/`http`/`https`/`dgram` bị thay bằng stub **ném lỗi** trước khi nạp module: **0 lần gọi**. Không agent nào bị tạo/dừng/xoá | **PASS** |
| D-8 | Đọc lại nguyên vẹn sau reload, lưu trữ, xoá Worker | Xem mục "D-8, D-9, D-11 trên kho thật" ở §4 | **PASS reload + lưu trữ; PASS xoá cho dữ liệu sau lỗi 17; Exception khởi động lại daemon** |
| D-9 | Xoá 1 trace và cả workspace; 0 file khác đổi | Một trace: xem §4. Cả workspace: xem trước = thật = **1.672.261 byte**, thư mục biến mất, **0** file ngoài kho đổi | **PASS** (sau lỗi 18, 19) |
| D-10 | Chi phí: khớp provider khi provider báo; không báo thì nhãn *estimated* + ngày giá; model ngoài bảng chỉ token | So với provider: `totalCostUsd` là **tổng luỹ kế của phiên**, không phải chi phí request (lỗi 11) → vế "khớp provider" **không thực hiện được** và được đổi qua delta, không phải được chấm đạt. Hai vế còn lại: 5/5 dòng `estimated` + `2026-06-24`; mọi Reviewer `gpt-5.6-sol` chỉ hiện token | **No cho vế provider** (thay bằng quyết định trong delta); **PASS hai vế còn lại** |
| D-11 | Gán lại: 100% tới đích, 0 mất, 0 nhân đôi, 0 file ngoài kho đổi | 150 → 150 → 150 bản ghi, xem trước = thật, 0 file ngoài kho đổi | **PASS** |

### Ghi chú thật thà về D-3 của F-1

Thời gian tường của F-1 trên màn hình (**1.655.284 ms**) **dài hơn** hoạt động thật của nó. Nguyên nhân là **lỗi 10**: một bản ghi hỏng, ghi lúc `07:09:09.930Z` **trước khi** bản sửa được triển khai, mang `requestId` của F-1 nhưng chứa 13 tin nhắn và 10 báo cáo của cả hai request. Nó kéo mốc "hoạt động cuối" của F-1 từ `07:01:43` sang `07:09:09`.

Đã kiểm lại cả kho: **đúng một** bản ghi có dấu hiệu đó, và **không có bản ghi mới nào** sau khi triển khai bản sửa. Tôi **không** thêm luật đọc nào để che dữ liệu hỏng đã biết — làm vậy là đổi thuật toán để hợp với một file sai. Vì vậy D-3 được kết luận trên các fixture thu sau bản sửa (F-2, F-3, F-4), và con số của F-1 được ghi kèm nguyên nhân.

### 5b. Hai ngoại lệ được ghi nhận, không phải PASS

| Ngoại lệ | Nội dung |
|---|---|
| **D-8, chân khởi động lại daemon** | Không chạy. `AGENTS.md` cấm `paseo daemon restart`/`stop` vì có thể giết agent đang chạy. Ngưỡng D-8 được viết ra mà quên luật đó; checklist đã sửa, và chân này thay bằng `paseo plugin reload` cộng lưu trữ rồi xoá Worker |
| **D-1, phần render** | Không đo được từ đây: hai RPC chỉ gọi được từ trong plugin, nên bộ đo chạy tầng server. Đúng cùng loại ngoại lệ mà WP-113 đã ghi cho launcher |

## 6. Dọn dẹp

### 6.1 Một kết quả phụ: Q-039 được kiểm trên đĩa

Quyết định Q-039 của owner — *"cập nhật phiên bản thì cũng không được xóa kho"* — được kiểm bằng chính đợt này, không phải bằng test. Sau **ba** lần `install --apply` lên cùng một thư mục cài đặt:

```
~/.paseo-bm/
  plugin/0.1.0-alpha.0/     ← phiên bản trước của owner, còn nguyên
  plugin/0.2.0-alpha.0/     ← payload đang kiểm
  traces/                   ← kho lưu vết, còn nguyên qua cả ba lần
  backups/                  ← 5 bản sao từ trước đợt này, còn nguyên
```

Hai điều đi kèm: (a) quay về phiên bản trước của owner làm được **từ file local**, không cần mạng, không cần npm; (b) kho lưu vết sống qua cập nhật đúng như ADR-007 nói.

Quyền cũng đúng thiết kế: `traces/` và mỗi thư mục workspace là `drwx------` (0700), mọi file `-rw-------` (0600), `meta.json` mức kho ghi `schemaVersion: 1`.

### 6.2 Nâng phiên bản không đụng vào kho

Một lần nâng phiên bản thật khi đã có kho (0.1.0 → 0.2.0) không làm được trực tiếp: lúc có kho thì owner đang có Worker chạy, và nạp lại plugin sẽ ngắt nó. Bằng chứng thay thế:

- Test tích hợp `test/integration/install.trace-store.test.ts`: kho trace dựng dưới 0.1.0 giữ nguyên **nội dung, thời điểm sửa và quyền** qua lần nâng lên 0.2.0 và một lần cài lại.
- Trên máy thật: file trace của workspace owner (`events-202609.jsonl`, sha1 `e84a4b66…`) có thời điểm sửa 16:25:47 và **không đổi** qua sáu lần `install --apply` sau đó (16:27 → 16:5x), mỗi lần đều cập nhật file payload.

### 6.3 Dọn dẹp

| # | Việc | Kết quả |
|---|---|---|
| 1 | Xoá trace của đợt nghiệm thu | Đã xoá qua đúng hàm xoá của sản phẩm (D-9) |
| 2 | Workspace và repo nháp | Workspace `wks_1a215b77cbcfd5e7` **đã lưu trữ** trong Paseo (21 agent lưu trữ theo); `/tmp/bm-acc-20260916/repo` đã xoá. Bản sao kho trace tạm của tôi cũng đã xoá vì chứa nội dung hội thoại |
| 3 | Cài lại `0.1.0-alpha.0` | **Chưa làm, có chủ ý**: owner đang xem và góp ý chính Dashboard mới, nên để lại `0.2.0-alpha.0`. Quay lại: `npx paseo-bm@0.1.0-alpha.0 install --apply` khi không có agent `bm-*` nào chạy. Thư mục `plugin/0.1.0-alpha.0` vẫn còn nguyên |
| 4 | So `~/.paseo/config.json` với ảnh chụp | Khác **đúng một** chỗ: `plugins.paseo-bm.path` trỏ `0.2.0-alpha.0` (hệ quả của mục 3) |
| 5 | Trace trong workspace thật của owner | **Giữ nguyên** — đó là dữ liệu của owner, xoá được từ Dashboard |

### 6.4 Một sơ suất của người chạy

Ở lần cài cuối, lệnh kiểm "không có agent `bm-*` nào đang chạy" in ra `1` nhưng **không chặn** lệnh cài phía sau (tôi nối bằng `&&` sau một lệnh luôn thoát 0). Agent đang chạy là Worker `d91ccf32` của owner ở `xspace-customer`. Kiểm tra ngay sau đó: nó vẫn `running`, và kho trace của workspace đó không có bản ghi lượt nào mới (thời điểm sửa file không đổi) — tức là lượt của nó **không bị ngắt**. Lần sau phép kiểm phải thoát khác 0 khi có agent chạy.
