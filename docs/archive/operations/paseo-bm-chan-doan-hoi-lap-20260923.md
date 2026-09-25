# Chẩn đoán: vòng hỏi lặp trong giao tiếp của paseo-bm

| Trường | Giá trị |
|---|---|
| Mã | `chan-doan-hoi-lap-20260923` |
| Status | **Active** — chẩn đoán đã xong, chưa sửa gì |
| Owner | hieu.nt10 |
| Created | 2026-09-23 |
| Yêu cầu | `req-20260923T132222Z`: "Tôi thấy ở project project-b đang chạy có tình trạng liên tục bị hỏi lặp lại, việc quản lý giao tiếp có vẻ không ổn, hãy xem bên đó và nắm xem plugin có vấn đề gì" |
| Bead | `bm-chan-doan-hoi-lap-lfz1` |
| Hiện trường | Workspace `wks_project_b` (`<project-b>`), Manager `f839eec7`, 8 Worker, 21 Reviewer, từ 2026-09-22T10:52Z |
| Nguồn đã đọc | `~/.paseo-bm/traces/wks_project_b/events-202609.jsonl` (353 bản ghi turn lúc đọc, 13:33Z); `~/.paseo/20260923-2008-01-daemon.log`; mã: `plugin/shared/bm-format.ts`, `plugin/server/format-check.ts`, `plugin/server/review-budget.ts`, `plugin/server/collector.ts`, `plugin/client/chat-cards.ts`, `plugin/roles/manager.md`, `plugin/roles/worker.md`, `plugin/index.server.ts` |
| Đã KHÔNG làm | không gửi tin nhắn cho agent nào của project-b, không commit |
| Đã cài | 2026-09-24T01:55Z: payload `0.3.0-alpha.6` cài vào install home, daemon trỏ lại, plugin nạp lại sạch (`Plugin stopped 01:55:03.878` → `Plugin ready 01:55:05.972`, cùng pid 6971 nên daemon không khởi động lại). `doctor`: 22 ok / 0 cảnh báo / 0 lỗi. Worker `9e3b2ce9` bên project-b đang chạy giữa chừng vẫn chạy tiếp, không đứt lượt. Payload cũ `0.2.0-alpha.1` giữ nguyên trong install home làm đường lùi |
| Quyết định của chủ repo | 2026-09-23, Q2 b: mở bead sửa cho mục 1, 2, 3, 5 của §5. Năm bead đã mở, xem §5. Mục 4, 6, 7 vẫn là đề xuất để ngỏ |

## 1. Người dùng thấy gì — đo trong ngày 2026-09-23

| Hiện tượng | Số đo |
|---|---|
| Bộ câu hỏi bị hỏi lại y nguyên | **4 lần** (`Q1–Q4` req-…011704Z; `Q4` req-…021315Z; `Q10–Q12` req-…070427Z; `Q6` req-…122743Z); khoảng cách giữa hai tin nhắn, đo bằng chính dấu thời gian của chúng: 18,8 / 22,7 / 47,9 / 42,3 giây — tức **19–48 giây** |
| Câu trả lời của người dùng bị gửi trùng cho Worker | **1 lần** (`Q10–Q12` lúc 11:04:55Z và 11:13:44Z) |
| Cùng một cảnh báo ngân sách review hỏi lại | **1 lần** (req-…021315Z lúc 05:20:49Z và 06:07:29Z, y hệt "5 review calls; the Medium budget is 4") |
| Nhắc sai định dạng `BM-FORMAT` plugin gửi cho agent | **11 lượt** trong ngày (15 lượt trong toàn trace: 8 tới Worker, 7 tới Reviewer) |
| Lượt turn bị huỷ giữa chừng | **7** (4 Worker, 3 Manager) |
| Lượt turn của Manager không có tin nhắn nào đến | **21 / 93** — mỗi lượt vẫn sinh đúng một tin nhắn gửi người dùng |

Cảm giác "hỏi lặp lại liên tục" là **thật và đo được**, không phải do agent lười đọc lịch sử.

## 2. Chuỗi nhân quả

```
Worker gửi BM-REPORT(blocked) + BM-QUESTIONS
        │
        ├─► Manager dựng thẻ câu hỏi cho người dùng                (lần 1)
        │
        └─► plugin kiểm mẫu khối, thấy 1 dòng sai regex
                 └─► BM-FORMAT: "gửi lại TOÀN BỘ khối"
                          └─► Worker gửi lại BM-REPORT + BM-QUESTIONS
                                   └─► Manager dựng thẻ MỚI        (lần 2)
                                            └─► người dùng trả lời cả hai thẻ
                                                     └─► BM-ANSWERS tới Worker 2 lần
                                                              └─► lần 2 cắt ngang lượt
                                                                  Worker đang chạy
```

Nút thắt: **`BM-QUESTIONS` đi kèm `BM-REPORT` như một khối duy nhất**, nên một lỗi chính tả ở dòng `tier:` cũng kéo theo cả bộ câu hỏi ra trước mặt người dùng lần nữa. Xem `plugin/server/format-check.ts` hàm `unitsOf`: khi gặp `BM-QUESTIONS` ngay sau `BM-REPORT` nó gộp hai khối thành một đơn vị, và `formatNotice` yêu cầu "Send the whole corrected block again".

## 3. Từng lỗi một

### L1 — `BM-FORMAT` kéo theo cả bộ câu hỏi ra hỏi lại

- **Người dùng thấy:** đúng bộ câu hỏi đó xuất hiện lần hai sau vài chục giây, không thêm thông tin gì.
- **Cơ chế:** `plugin/server/format-check.ts` `unitsOf()` gộp `BM-REPORT` + `BM-QUESTIONS` thành một đơn vị; `formatNotice()` bảo người gửi gửi lại nguyên khối. Manager không có cách nào biết khối thứ hai chỉ là bản sửa chính tả của khối thứ nhất.
- **Bằng chứng (req-20260923T070427Z):** 10:55:43.947Z Worker `f472260` gửi `blocked` + `Q10–Q12` → Manager đăng thẻ 10:55:49.985Z. 10:56:03.772Z plugin gửi `BM-FORMAT` (sai `tier` và `reviewFindingsOpen`) → 10:56:31.882Z Worker gửi lại nguyên khối → Manager đăng thẻ thứ hai 10:56:35.019Z, tự nó cũng viết: *"Worker gửi lại đúng ba câu đó, vẫn đang chờ bạn."*
- **Loại:** lỗi thiết kế giao thức trong mã plugin.

### L2 — Hai trường bị bắt lỗi quá chặt so với chính mẫu trong `worker.md`

9 trong 87 khối `BM-REPORT` (10,3 %; tính đến mốc chốt `CUT` ở §6) trượt mẫu, và **tất cả** chỉ vì hai trường:

| Trường | Regex (`plugin/shared/bm-format.ts`) | Cái agent thật sự viết |
|---|---|---|
| `tier` | `^(Small\|Medium\|Large) \(changed: (no\|from (Small\|Medium\|Large), .+)\)$` | `Large (changed: no — stays Large; đợt 3 ý 3 mở rộng ra ~26 màn…)`; `Small (changed: from Large (preliminary guess), reason: …)` |
| `reviewFindingsOpen` | `^b\d+: \S.*$`, các mục cách nhau bởi `;`, hoặc đúng chữ `none` | `none (b1 verdict pass; 2 finding non-blocking…)`; `none — b1 had 5 blocking…`; `b4 đang chạy, chưa có kết quả` |

- **Vì sao agent viết như vậy:** `plugin/roles/worker.md` cho phép **đúng kiểu đó** ở trường ngay bên cạnh — *"after `none` when nothing is blocking: `none. Suggestion (not done): …`"* — nên việc thêm một chú thích ngắn sau `none` là cách đọc tự nhiên của mẫu. Dòng mẫu `tier: Small | Medium | Large (changed: no | from <old tier>, reason)` cũng đọc như thể `reason:` là một nhãn để điền, trong khi regex lại cấm bất kỳ ngoặc đơn nào sau tên tier.
- **Loại:** mẫu trong chỉ dẫn vai trò và regex trong mã **không khớp nhau**; lỗi nằm ở cả hai phía. Phía Reviewer có đúng một lỗi cùng loại: xem **L8**.

### L3 — Thẻ câu hỏi ghi nhớ "đã trả lời" theo toàn văn tin nhắn

- **Người dùng thấy:** trả lời thẻ thứ nhất xong, thẻ thứ hai vẫn trắng nút như chưa ai đụng vào, nên trả lời tiếp; Worker nhận câu trả lời hai lần.
- **Cơ chế:** `plugin/client/chat-cards.ts:699` — `answeredKey = agentId|requestId|các mã câu hỏi|hash(TOÀN VĂN thẻ)`. Bản gửi lại sau `BM-FORMAT` khác đúng một hai dòng (`tier`, `reviewFindingsOpen`), nên `hash` khác, khoá khác, và bộ nhớ "đã trả lời" của thẻ cũ không áp cho thẻ mới dù **cùng requestId và cùng mã câu hỏi**.
- **Bằng chứng:** 11:04:55.682Z `BM-ANSWERS Q10–Q12` tới Worker `f472260`; 11:13:44.738Z **đúng khối đó** tới lần nữa; Worker phải trả lời *"Q10–Q12 tôi đã nhận ở lượt trước và đã áp dụng rồi"* — mất trọn một lượt.
- **Loại:** lỗi mã phía giao diện.

### L4 — Kiểm định dạng đọc nhầm tin nhắn đang viết dở

- **Người dùng thấy:** Reviewer làm xong rồi phải chạy thêm một lượt nữa chỉ để "gửi lại khối đúng mẫu", tuy khối nó gửi đã đúng.
- **Bằng chứng (không cãi được):** Reviewer `2453248` kết thúc lượt lúc 06:52:28.987Z; tin nhắn cuối của nó trong trace là **một mục duy nhất, 4 429 ký tự, không bị cắt**, mở đầu `…\n```\nBM-REVIEW\nrequestId: req-20260923T021315Z\nbatchId: b6\n…` — hoàn toàn đúng mẫu. Vậy mà 06:52:48Z plugin gửi `BM-FORMAT`: *"line \"requ\" is not a field of the template"* cộng với cả 7 trường "is missing". Chữ `requ` là chỗ dòng `requestId:` bị cắt ngang. Trường hợp khác cùng loại: Reviewer `bfe4f54` bị báo `requestId: must look like req-YYYYMMDDTHHMMSSZ (got "req-20260923")` trong khi dòng thật là `requestId: req-20260923T070427Z`.
- **Giải thích khớp với mã (chưa dựng lại được bằng test):** `format-check.ts` đọc thẳng `event.timeline` mà hook trao cho nó — tức ảnh chụp bộ nhớ `timelineStore` tại đúng khoảnh khắc `agent.turn_ended` bắn. Ngược lại `collector.ts` (dòng 379–388) coi `timeline.refetch()` là **nguồn ưu tiên** và chỉ lấy payload của hook làm phương án dự phòng — nên trace giữ được toàn văn còn bộ kiểm định dạng thì không. Các điểm cắt đều rơi vào 1–2 dòng đầu ngay sau chữ `BM-REVIEW` và mỗi lần một chỗ khác nhau, đúng dáng của một tin nhắn đang chảy dở.
- **Hệ quả kéo dài:** khoá của mục chờ là `người-gửi|requestId|loại-khối`. Khối bị cắt không đọc ra `requestId` nên mang khoá `…|?|BM-REVIEW`, còn khối đầy đủ hợp lệ lại xoá khoá `…|req-…|BM-REVIEW`. Hai khoá khác nhau ⇒ **khối hỏng vẫn nằm chờ và vẫn được gửi đi dù bản đúng đã tới**: Reviewer `bfe4f54` nhận `BM-FORMAT` lúc 07:49:09.716Z ngay sau khi vừa gửi một khối `BM-REVIEW` hoàn toàn hợp lệ.
- **Một nghi ngờ đã loại:** bản sao trong trace của tin nhắn Reviewer `4fee6d8` lúc 21:57:48Z chỉ dài 526 ký tự và mang cờ `truncated`. Đó **không** phải dấu vết của timeline đọc dở: `trace-store.ts:350` cắt lại **mọi** tin nhắn xuống 512 ký tự khi cả bản ghi vượt `MAX_RECORD_CHARS` (32 KB), và 526 = 512 + 14 ký tự của `...[truncated]`. Cách cắt của kho trace và cách cắt mà bộ kiểm định dạng nhìn thấy là hai chuyện khác nhau.
- **Loại:** lỗi mã plugin. Trong 7 lượt `BM-FORMAT` gửi cho Reviewer: **6 lượt thuần L4**, còn **lượt thứ bảy mang cả hai lỗi** cùng lúc (xem L8) — nên đừng đọc thành "6 và 1" hai đường tách rời.

### L5 — Cảnh báo ngân sách review quên sạch khi plugin nạp lại

- **Người dùng thấy:** bị hỏi "tiếp tục hay huỷ Worker?" hai lần cho cùng một lần vượt, cùng con số. Chính Manager đã phải mách nước: *"Nếu bạn muốn khỏi bị hỏi lại mỗi lần, nói một câu 'cho phép vượt ngân sách review cho Worker này đến khi xong'."*
- **Cơ chế:** `plugin/index.server.ts:124` — `const budgetTold = new Set<string>()` nằm trong bộ nhớ tiến trình, tạo lại mỗi lần plugin nạp. `review-budget.ts:168–175` chỉ dựa vào Set đó để biết "đã báo rồi".
- **Bằng chứng:** `BM-BUDGET` cho req-…021315Z lúc **05:20:49.354Z**; daemon log ghi `Plugin stopped 05:54:01.597Z` (pid 95805) → `Loading plugin 05:54:15.695Z` → `Plugin ready 05:54:17.290Z` (pid **6971** — tiến trình daemon đã đổi, tức lần này là khởi động lại daemon chứ không chỉ nạp lại plugin); `BM-BUDGET` y hệt lại tới lúc **06:07:29.794Z**, vẫn "5 review calls", tức số lượt không hề tăng. Một lần `paseo plugin reload` cũng cho kết quả như vậy vì Set nằm trong closure của `contribute()`.
- **Loại:** lỗi mã plugin (trạng thái đáng lẽ phải bền như `answer-marks.json`).

### L6 — Mọi tin nhắn và mọi tiếng gọi "xong việc" đều **cắt ngang** lượt đang chạy

Đây là thứ làm cho mấy lỗi trên đắt hơn nhiều so với vẻ ngoài.

- **Reviewer làm xong ⇒ huỷ lượt của Worker đang chạy.** `worker.md` cố tình giữ `notifyOnFinish` mặc định cho các lượt gọi Reviewer ("so a verdict wakes you"). Kết quả đo được:
  - Reviewer `c0ad51d` (b4) kết thúc 11:07:08.669Z → lượt Worker `f472260` mở từ 11:04:55.682Z bị **canceled** lúc 11:07:09.375Z, đúng lúc nó đang dựng đồ thị bead cho câu trả lời người dùng vừa gửi.
  - Reviewer `914f950` (b3) kết thúc 05:20:42.707Z → lượt Worker `4b260e4` mở từ 05:16:31.790Z bị **canceled** lúc 05:20:43.535Z — lượt đó đang xử lý `BM-ANSWERS Q5`.
- **Manager cũng bị cắt giữa câu.** 04:49:03.839Z Manager nhận `blocked` và bắt đầu viết cho người dùng; Worker `d224224` kết thúc lượt lúc 04:49:05.962Z; lượt Manager bị **canceled** lúc 04:49:06.081Z rồi lượt kế tiếp (không có tin nhắn đến) viết lại gần như cùng nội dung lúc 04:49:15.336Z — **người dùng đọc hai lần cùng một lời nhắn "đang chờ Q1–Q3"**.
- **Manager gửi cho Worker đang chạy.** Lượt Worker `4b260e4` mở từ 04:48:52.586Z bị **canceled** lúc 04:49:32.644Z ngay khi nó vừa viết xong bản tổng kết, vì Manager gửi tiếp "3 điểm sửa thêm" (Manager tự thuật lúc 04:49:39.509Z). Đây đúng là điều `manager.md` bước 2 cấm — luật đã được thêm từ bead `bm-wp-242-manager-dywt` (17/09) — nhưng nó chỉ là một câu chữ trong chỉ dẫn, **không có gì trong mã chặn lại**.
- **Vì sao luật cũ không đủ:** `bm-wp-242-manager-dywt` chỉ phủ **đường relay của Manager**. Hai nguồn cắt ngang đo được hôm nay — Reviewer kết thúc, và người dùng bấm trả lời trên thẻ — **không đi qua đường đó**, nên không luật nào của plugin chạm tới được.
- **Loại:** hành vi nền tảng của Paseo; phần plugin chịu trách nhiệm là **chỉ dẫn vai trò và số lượng tin nhắn tự phát** mà nó bắn ra.

### L7 — Manager nói với người dùng ở **mỗi** lần bị đánh thức

- **Người dùng thấy:** dòng thông báo liên tục, nhiều dòng chỉ lặp lại điều vừa nói.
- **Cơ chế:** `plugin/roles/manager.md` — *"A Paseo notice that the Worker ended a turn WITHOUT a new `BM-REPORT` is not news: … otherwise reply with ONE status line."* Một dòng mỗi lần, nhưng mỗi Worker kết thúc **bất kỳ** lượt nào là một lần đánh thức.
- **Bằng chứng:** 21/93 lượt Manager trong ngày không có tin nhắn đến, và cả 21 lượt đều sinh ra một tin nhắn cho người dùng, trong đó có *"Worker đã dừng và chờ Q1–Q4 như mình vừa báo ở trên. Không có gì mới."* (01:20:55Z) và *"Worker dừng chờ Q10–Q12 như mình vừa báo."* (10:56:08Z).
- **Loại:** hệ quả của chỉ dẫn vai trò, không phải lỗi mã.

### L8 — Giá trị nhiều dòng trong `BM-REVIEW` bị bắt lỗi từng dòng một

Anh em song sinh của L2, ở phía Reviewer. Nó lộ ra ở lượt `BM-FORMAT` **duy nhất mang hai lỗi cùng lúc** (2026-09-22T17:24, cũng là lượt sớm nhất trong 7 lượt gửi cho Reviewer): 7 dòng bị nêu tên là của L8, 2 dòng còn lại là của L4.

- **Người dùng thấy:** review đã xong vẫn phải chạy thêm một lượt để gửi lại, và bản gửi lại **mất bớt cấu trúc** — Reviewer phải ép một danh sách 7 mục xuống thành một dòng duy nhất.
- **Cơ chế:** `plugin/shared/bm-format.ts` `checkReview()` chỉ chấp nhận dòng thụt lề `khoá: giá trị` khi đang ở **trong** `findings:` (nhánh `inFindings && nested`). Ngoài vùng đó — tức trong `checked:` và `notChecked:` — mỗi dòng đều phải khớp `FIELD`, một regex neo ở cột 0, nên **mọi dòng tiếp nối đều thành "line … is not a field of the template"**. Trong khi đó `plugin/roles/reviewer.md` chỉ viết `checked: <what you read and ran: …>` và không hề nói giá trị phải nằm gọn một dòng.
- **Bằng chứng:** 2026-09-22T17:24:21.527Z Reviewer `756eb81` gửi khối `BM-REVIEW` dài 2 956 ký tự, **không bị cắt** (`truncated=false`: bản thân tin nhắn 2 956 ký tự, dưới trần 8 192 của mỗi tin nhắn; cả bản ghi 9 183 ký tự, dưới trần 32 768 của cả bản ghi nên không bị cắt lại xuống 512), hợp lệ về mọi mặt trừ việc `checked:` có 7 dòng thụt lề `Fix 1:` … `Fix 7:`. `BM-FORMAT` lúc 17:24:21.589Z nêu **đủ cả bảy dòng** đó là "not a field" — đấy là L8. 17:24:30.195Z Reviewer gửi lại, dài 2 478 ký tự, **ngắn hơn 478 ký tự**, vì bảy mục đã bị gộp thành văn xuôi một dòng.
- **Và cũng chính lượt đó chứng minh L4:** hai dòng cuối của `BM-FORMAT` là `notChecked: is missing` và `finding 1: is missing "suggestedFix"`. `checkReview` chỉ báo như vậy khi **không đọc thấy** hai dòng ấy (`bm-format.ts` nhánh trường thiếu và nhánh kiểm từng finding), trong khi bản đầy đủ trong trace có `suggestedFix:` ở dòng 19 và `notChecked:` ở dòng 20. Bản mà bộ kiểm đọc được đã đứt ở đâu đó giữa dòng 18 và 19. Vậy một tin nhắn có thể dính **cả hai** lỗi: 9 dòng phàn nàn = 7 của L8 + 2 của L4.
- **Loại:** cùng loại với L2 — mẫu trong chỉ dẫn vai trò và regex trong mã không khớp nhau. Sửa L4 (đọc lại timeline) **không** chạm tới lỗi này.

## 4. Đã kiểm và **không** phải nguyên nhân

- **Câu trả lời không bị mất.** 17 khối `BM-ANSWERS` trong ngày đều tới đúng Worker của đúng `requestId`; không có bộ câu hỏi nào bị hỏi lại **sau khi** đã được trả lời (mọi cặp trùng đều nằm gọn trong 48 giây và đều xảy ra TRƯỚC câu trả lời).
- **Không phải Worker quên.** Chỉ dẫn `worker.md` có luật "câu chưa được trả lời thì hỏi lại ở lần `blocked` kế tiếp", nhưng trong ngày không có ca nào rơi vào luật này: mọi lần lặp đều do `BM-FORMAT` kích hoạt.
- **Không phải người dùng bấm nhầm hai lần.** Hai thẻ là hai tin nhắn khác nhau do Worker gửi, có dấu thời gian và nội dung `blockers:` khác nhau.
- **Không phải trace store hỏng.** 353/353 bản ghi đọc được; thứ bị cắt là bản sao mà bộ kiểm định dạng đọc, không phải bản ghi.

## 5. Đề xuất sửa

Xếp theo tỉ lệ (hiệu quả ÷ rủi ro), từ cao xuống thấp. Chủ repo đã chốt ngày 2026-09-23 (Q2 b): **mục 1, 2, 3 và 5 đã có bead**; mục 4, 6 và 7 vẫn là đề xuất để ngỏ, chưa ai quyết.

| Mục | Lỗi | Bead | Trạng thái |
|---|---|---|---|
| 1 | L1 | `bm-format-khong-keo-questions-aqxs` | đã làm (2026-09-24) |
| 2a | L2 | `bm-tier-reviewfindings-mau-q5oy` | đã làm (2026-09-24) |
| 2b | L8 | `bm-bmreview-nhieu-dong-hk4g` | đã làm (2026-09-24) |
| 3 | L3 | `bm-the-nho-da-tra-loi-6v2y` | đã làm (2026-09-24) |
| 5 | L5 | `bm-ngan-sach-song-qua-nap-lai-qyag` | đã làm (2026-09-24) |
| 4, 6, 7 | L4, L7, L6 | chưa có bead | chưa quyết |

Toàn bộ nằm trong working tree, chưa commit. Một điểm đổi khác với đề xuất ban đầu của mục 5: xem §5 mục 5.

1. **Không gửi lại `BM-QUESTIONS` vì một lỗi ở `BM-REPORT`.** Gỡ đúng L1 — nguồn của cả 4 lần lặp trong ngày. Bead `bm-format-khong-keo-questions-aqxs` đã thử và **loại hai hướng** trước khi chốt, cả hai đều do review b2 bác:
   - *"Chỉ xin gửi lại `BM-REPORT`"* — bất khả: `bm-format.ts` nhánh `phase === "blocked"` BẮT BUỘC báo cáo `blocked` phải kèm `BM-QUESTIONS` trong cùng tin nhắn, mà cả 4 lần lặp đều là báo cáo `blocked`. Gửi lại mỗi báo cáo sẽ đẻ ra một `BM-FORMAT` thứ hai mâu thuẫn với cái thứ nhất.
   - *"Hoãn lời nhắc tới khi có câu trả lời"* — chỉ đổi lúc nào gửi, không đổi nó đòi gì; Worker vẫn đăng lại bộ câu hỏi, lần này SAU KHI người dùng đã trả lời, tức tạo ra đúng lớp lỗi mà §4 ghi nhận là chưa từng xảy ra.
   - **Hướng đã chốt:** lời nhắc cho khối có câu hỏi kèm theo trở thành **chỉ để báo** — nêu đủ trường sai, nói thẳng đừng gửi lại, áp dụng cho báo cáo kế tiếp. Đánh đổi: báo cáo sai mẫu nằm lại nguyên trạng trong hồ sơ.
2. **Nới ba chỗ kiểm mẫu cho khớp với chính mẫu đang dạy agent** — cùng một loại lỗi, nhưng đã mở thành **hai bead riêng**, vì hai hàm khác nhau, hai bộ bằng chứng khác nhau và hai cách hoàn tác khác nhau:
   a. cho phép chú thích sau `none` ở `reviewFindingsOpen` và sau `(changed: no…)` ở `tier`; hoặc sửa mẫu trong `worker.md` cho khít regex (L2 — nguồn của 9/9 khối `BM-REPORT` trượt mẫu);
   b. cho `checkReview` nhận dòng thụt lề như phần tiếp nối của `checked:` / `notChecked:` y như nó đã làm trong `findings:`; hoặc nói thẳng trong `reviewer.md` rằng mỗi giá trị phải nằm một dòng (L8). Nếu chọn nói thẳng thì phải chấp nhận Reviewer mất chỗ trình bày danh sách — ca 17:24 cho thấy bản gửi lại ngắn đi 478 ký tự.
3. **Khoá bộ nhớ "đã trả lời" theo `agentId|requestId|các mã câu hỏi`**, bỏ `hash` toàn văn ra khỏi khoá (L3).
4. **Cho `format-check` đọc timeline bằng `timeline.refetch()` như collector**, hoặc bỏ qua khối mà dòng cuối bị cắt ngang chừng, và gộp mục chờ theo người gửi + loại khối thay vì theo `requestId` đọc được (L4). Lưu ý: mục này **không** gỡ L8. Lấy đúng lượt 17:24 làm thước: sửa L4 chỉ bỏ đi 2 trong 9 dòng phàn nàn, 7 dòng của L8 vẫn còn và `BM-FORMAT` vẫn cứ được gửi. Muốn lượt đó biến mất thì phải làm cả mục 2b.
5. **Ghi `budgetTold` xuống đĩa** cạnh `answer-marks.json` (L5). **Đã làm, nhưng KHÁC đề xuất ban đầu một điểm:** đề xuất đầu tiên định lưu kèm số lượt để một lần vượt MỚI vẫn báo lại. Khi làm mới thấy điều đó đụng một quyết định đã chốt và đã ghim bằng test — `index.server.ts` viết "tells the Manager once per request", `test/plugin-review-budget.test.ts` ghim "A later turn of the Worker or of a new Reviewer does not repeat it". Nới test đó ra cho vừa đề xuất là làm một check trông có vẻ xanh, nên giữ nguyên luật cũ và chỉ làm cho nó sống qua lần nạp lại. Hệ quả: lần báo "9 lượt" của req-…135101Z sẽ không còn — nó đi được **chỉ vì** daemon khởi động lại lúc 05:54, tức tai nạn chứ không phải luật. Có nên báo lại ở mốc vượt cao hơn hay không là quyết định sản phẩm, **chưa ai quyết**.
6. **Bớt lời khi không có tin gì mới:** cho phép Manager im lặng ở lần đánh thức không kèm `BM-REPORT` mới, nếu lần trước nó đã nói đúng nội dung đó (L7).
7. **L6 phải hỏi Paseo, plugin không tự sửa được.** `docs/operations/paseo-upstream-request-agent-cancel.md` (Draft — chưa gửi) đã xin quyền **huỷ** một lượt chạy; L6 là mặt còn lại của cùng một vùng API: một tin nhắn hay một tiếng gọi "xong việc" **tự huỷ** lượt đang chạy của agent nhận. Nên gom số đo của ngày này vào cùng một yêu cầu gửi lên Paseo. Phần plugin tự làm được ngay là bớt số tin nhắn tự phát (mục 1, 5, 6 ở trên).

## 6. Kiểm chứng lại

Trace của project-b vẫn dài thêm khi các Worker bên đó còn chạy, nên mọi lệnh dưới đây đều **cắt tại `CUT = 2026-09-23T13:33:00Z`** — chạy lúc nào cũng ra đúng những con số ở §1 và §3. Đoạn này chỉ đọc, không ghi:

```sh
F="$HOME/.paseo-bm/traces/wks_project_b/events-202609.jsonl"
CUT="2026-09-23T13:33:00Z"   # trace vẫn dài thêm; mọi số dưới đây chốt tại đây
DAY="2026-09-23T00:00:00Z"

# tổng số bản ghi turn tính đến mốc chốt  -> 353
jq -r --arg cut "$CUT" 'select(.at<=$cut) | .at' "$F" | wc -l

# BM-FORMAT theo vai trò: cả trace -> 8 worker + 7 reviewer; riêng trong ngày -> 6 + 5
jq -r --arg cut "$CUT" '. as $t | select($t.at<=$cut)
       | .sent[]? | select(.text|startswith("BM-FORMAT")) | $t.role' "$F" | sort | uniq -c
jq -r --arg cut "$CUT" --arg day "$DAY" '. as $t | select($t.at>=$day and $t.at<=$cut)
       | .sent[]? | select(.text|startswith("BM-FORMAT")) | $t.role' "$F" | sort | uniq -c

# bộ câu hỏi bị đăng trùng trong ngày, kèm hai dấu thời gian để tính khoảng cách -> 4 cặp
jq -r --arg cut "$CUT" --arg day "$DAY" '. as $t | select($t.at>=$day and $t.at<=$cut)
       | .sent[]? | select(.text|test("BM-QUESTIONS"))
       | "\($t.requestId)|" + ([ (.text|split("\n")[]|select(test("^Q\\d+:"))|split(":")[0]) ]|join(",")) + "|\(.at)"' \
  "$F" | sort | awk -F'|' '{k=$1"|"$2; if(k==pk) print k, prev, $3; pk=k; prev=$3}'

# lượt turn bị huỷ, theo vai trò -> 3 manager + 4 worker
jq -r --arg cut "$CUT" --arg day "$DAY" 'select(.at>=$day and .at<=$cut)
       | select(.outcome=="canceled") | .role' "$F" | sort | uniq -c

# lượt Manager không có tin nhắn đến -> 21 trên tổng 93
jq -r --arg cut "$CUT" --arg day "$DAY" 'select(.agentId=="f839eec7-8eb8-495f-abda-c1ac554db050")
       | select(.at>=$day and .at<=$cut)
       | if (.sent|length)==0 then "khong-co-tin-nhan-den" else "co-tin-nhan-den" end' "$F" | sort | uniq -c

# các lần BM-BUDGET -> 6 dòng, trong đó req-…021315Z lặp y hệt
jq -r --arg cut "$CUT" '. as $t | select($t.at<=$cut) | .sent[]? | select(.text|startswith("BM-BUDGET"))
       | "\($t.at) \($t.requestId) :: " + (.text|split("\n")[1])' "$F"

# plugin nạp lại (pid đổi 95805 -> 6971, tức daemon khởi động lại)
grep -a "Loading plugin\|Plugin ready\|Plugin stopped" "$HOME/.paseo/20260923-2008-01-daemon.log"

# khối BM-REPORT trượt mẫu, bằng chính hai regex của plugin/shared/bm-format.ts
# -> 87 khối có dòng tier | tier sai 3 | reviewFindingsOpen sai 7 | khối sai (không trùng) 9
node -e '
const fs=require("fs");
const TIER=/^(Small|Medium|Large) \(changed: (no|from (Small|Medium|Large), .+)\)$/;
const FIND=/^b\d+: \S.*$/;
const cut=process.argv[2];
let tot=0,tierBad=0,findBad=0;const blocks=new Set();
for(const l of fs.readFileSync(process.argv[1],"utf8").trim().split("\n")){const t=JSON.parse(l);
 if(t.at>cut) continue;
 for(const m of (t.sent||[])){ if(!/^BM-REPORT/m.test(m.text)) continue;
  const ls=m.text.split("\n");
  const tier=ls.find(x=>x.startsWith("tier: "));
  const rf=ls.find(x=>x.startsWith("reviewFindingsOpen: "));
  if(tier){tot++; if(!TIER.test(tier.slice(6).trim())){tierBad++;blocks.add(t.at);}}
  if(rf){const v=rf.slice(20).trim();
   if(!(v.toLowerCase()==="none"||v.split(";").every(p=>FIND.test(p.trim())))){findBad++;blocks.add(t.at);}}}}
console.log("khối có dòng tier:",tot,"| tier sai:",tierBad,"| reviewFindingsOpen sai:",findBad,
            "| khối sai (không trùng):",blocks.size);
' "$F" "$CUT"
```


Độ dài các tin nhắn `BM-REVIEW` ở L4 và L8 **không** có sẵn thành một trường trong trace — phải tự tính bằng `.text|length`:

```sh
# 2 956 (khoi 17:24 cua L8) va 9 183 (ca ban ghi do)
jq -r 'select(.agentId=="756eb81b-3b51-43f5-bd75-5d527efbe648") | select(.turnId=="foreground-turn-6")
       | "msg=\(.received[0].text|length) truncated=\(.received[0].truncated) record=\(tostring|length)"' "$F"
# 4 429 (khoi 06:52 cua L4) va 2 478 (ban gui lai cua L8)
jq -r 'select(.at=="2026-09-23T06:52:28.987Z" or .at=="2026-09-22T17:24:30.217Z")
       | "\(.at) len=\(.received[-1].text|length)"' "$F"
```

Riêng ranh giới cắt 512 / 8 192 / 32 768 ký tự đọc thẳng trong mã: `plugin/server/trace-store.ts:300–350`.

> Bỏ `CUT` ra khỏi các lệnh thì số sẽ lớn hơn: đó là việc mới xảy ra sau lúc chẩn đoán, không phải sai lệch.
