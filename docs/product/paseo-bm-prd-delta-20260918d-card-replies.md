# Delta-change — Manager không nhắc lại thẻ, câu trả lời đi qua ô Reply, thẻ câu hỏi dễ đọc

| Trường | Giá trị |
|---|---|
| Mã | `prd-delta-20260918d-card-replies` |
| Tài liệu gốc | [paseo-bm PRD](paseo-bm-prd.md) REQ-059 (b)–(f); [prd-delta-20260918c-question-cards](paseo-bm-prd-delta-20260918c-question-cards.md) — **không sửa tại chỗ khi chưa duyệt** |
| Status | **Accepted, Applied** — owner xác nhận trước khi implement (Q6–Q8, §1.2); áp vào [PRD gốc](paseo-bm-prd.md) REQ-059 ngày 2026-09-18 (WP-258) |
| Owner | hieu.nt10 |
| Created | 2026-09-18 |
| Request | `req-20260918T041426Z` |
| Thiết kế | [design-delta-20260918d-card-replies](../design/paseo-bm-delta-20260918d-card-replies.md) |
| Plan | [plan-delta-20260918d-card-replies](../plans/paseo-bm-implementation-plan-delta-20260918d-card-replies.md) |

## 0. Routing Decision

- Variant preset: brownfield
- Triggered risks: **nhiều thành phần độc lập** (chỉ dẫn Manager; thẻ chat phía client: đường gửi và bố cục); **hành vi người dùng đang dựa vào** (cách trả lời câu hỏi trong thẻ, REQ-059 đã Accepted)
- Required artifacts/gates: PRD delta này + `prd-ready` → design delta + `design-ready` → plan delta + `plan-ready-for-beads` → beads → `feature-done` (hồ sơ standard)
- Execution path: plan → converter
- Exceptions: none
- Decided: 2026-09-18 — Beads Worker, cỡ **Large**: Manager đoán, Worker xác nhận theo luật 1 (nhiều thành phần). Owner chọn không tách file chỉ dẫn (Q2), nhưng ba ý về thẻ thêm vào cùng request vẫn giữ mức Large
- Supersedes: none

## 1. Owner nói gì

Trong chat Manager, sau khi Manager in lại toàn bộ câu hỏi đã có trên thẻ (hai lần):

> Nếu đã hiển thị trong Card rồi thì không cần phải in hết lại một lần nữa ra màn hình chat, nhìn dài dòng thừa thãi

Yêu cầu:

> Hãy sửa Manager để điều chỉnh cho phù hợp.
> Ngoài ra tôi cũng đang thắc mắc nếu file md quá dài, có nên tạo thêm refererence, template độc lập để Agent tham chiếu khi làm việc tránh dài dòng không ? Nếu việc đấy có thể làm được thì nên quy hoặc thêm các sub folder cho Agent Instruction , tối ưu riêng cho Claude Code, OpenCode, Codex

Sau khi trả lời vòng hỏi đầu trong thẻ:

> 1. Tôi thấy có bug, tôi đã chọn trong Action Card rồi, nhưng lúc gửi message sang cho Worker không đẩy các option sang.
> 2. Nên bỏ cái Button "Send answer to Worker . Manage card-only answer v.v... mà khi tôi tick chọn thì hãy tự concat message vào ô nhập Reply to Worker thì phù hợp hơn
> 3. Cách hiển thị Question và Option answer nhìn hơi ríu rít lại khá khó đọc và lựa chọn, trình bày lại cho phù hợp

### 1.1 Quyết định của owner (2026-09-18)

Owner trả lời bằng khối `BM-ANSWERS`: Q1 a, Q2 a, Q3 a, Q4 a, Q5 a. Các mã này là của request `req-20260918T041426Z`, không phải Q1–Q5 của request khác.

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q1 | Manager nói gì khi thẻ đã hiện báo cáo | **(a)** Mọi báo cáo: không nhắc lại gì thẻ đã hiện. Chỉ 1–2 dòng về điều thẻ không có: Worker nào chờ câu nào (`A · <Worker> · <requestId>: Q6, Q7`), skill còn thiếu, số gợi ý chưa làm. Báo cáo kiểu cũ (thẻ không có nút) vẫn liệt kê đủ |
| Q2 | Tách file chỉ dẫn thành reference/template riêng và thư mục theo provider | **(a)** Chưa tách; ghi đánh giá vào tài liệu của request ([thiết kế §9](../design/paseo-bm-delta-20260918d-card-replies.md#9-đánh-giá--tách-chỉ-dẫn-thành-referencetemplate-và-thư-mục-theo-provider-q2)) |
| Q3 | Ghi thay đổi REQ-059 thế nào | **(a)** Delta mới `20260918d` (PRD + thiết kế + plan); xong thì áp vào REQ-059 của PRD gốc kèm dòng revision |
| Q4 | Thẻ gửi câu trả lời thế nào khi bỏ nút "Send answers to Worker" | **(a)** Mỗi lần tick, "Use recommendations" hay gõ "Other" thì thẻ viết lại khối `BM-ANSWERS` ở đầu ô Reply (ô tự mở); người dùng gõ thêm lời bên dưới; một nút Send; câu chưa trả lời vẫn mở và Worker hỏi lại; Send tìm đúng Worker của request và không gửi khi Worker đang chạy — áp cho mọi Reply |
| Q5 | Trình bày lại câu hỏi | **(a)** Mỗi câu một khối: dòng đậm `Q1 · <chủ đề>`, câu hỏi chữ thường ở dòng dưới; mỗi lựa chọn một hàng rộng hết thẻ cách nhau 8px, `○  a  <nội dung>` với khoá đậm và nội dung xuống dòng thẳng hàng, tag "recommended" cuối hàng; "Other…" là hàng cuối cùng danh sách; vạch ngăn giữa các câu |

### 1.2 Xác nhận trước khi implement (2026-09-18)

Owner trả lời bằng khối `BM-ANSWERS`: Q6 a, Q7 b, Q8 a.

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q6 | Các điểm thêm ngoài lời owner | **(a)** Đồng ý cả năm điểm của thiết kế: Send cũng không gửi khi người nhận đang khởi tạo, đã đóng hay không xác định được; chữ phía trên khối được đưa xuống dưới, chữ sửa tay trong khối bị viết đè; nút lựa chọn tắt kèm lý do khi không xác định được Worker; dòng "Answered at…" chỉ hiện khi chữ gửi còn nguyên khối; Manager giữ `received` một dòng và ở `finished` nói số gợi ý chưa làm |
| Q7 | Ai nạp bản mới lên daemon | **(b)** Worker cài và reload **một lần** sau khi batch `b3` pass, chỉ khi mọi agent `bm-*` khác đang idle; Worker gửi `finished` trước, vì lượt của nó có thể bị ngắt ngay sau lệnh |
| Q8 | Bắt đầu implement | **(a)** Có: từng bead theo thứ tự `.1`, `.2`, `.5`, `.3`, `.4`; không commit; review implementation ở batch `b3`. Manager đang mở giữ chỉ dẫn cũ; muốn dùng chỉ dẫn mới thì mở Manager mới sau khi nạp lại plugin |

### 1.3 Sau khi xong — trình bày thẻ (2026-09-18, batch `b4`)

Owner dùng bản đã nạp lên daemon, rồi gửi:

> 1. Card có quá nhiều màu xanh cả về border lần chữ, bỏ viền xanh card phía bên trái đi.
> 2. Tên worker khi ấn vào thì mở Worker đang chạy
> 3. Danh sách beads liên quan mà quá nhiều thì có hiển thị 2 cái và dòng tiếp theo là thẻ chip "..."  ấn vào để xem thêm hiển thị all beads
> 4. Message mà đã phản hồi thì ẩn nút Reply to Worker đi , thêm thẻ chip Answer nhỏ nhỏ ở góc trên bên phải dưới trạng thái block là được
> 5. Fix thời gian hiển thị mesage ở dưới Tên thay vì một đòng dài
> 6. Phía trên khu vực chat, ngoài hiển thị Sub-agent working, Git diff thì có thêm các chip thể hiện các câu đang block và cần phẩn hồi, khi click vào thì scroll về Card cần trả lời để thuận tiện theo dõi

Owner trả lời bằng khối `BM-ANSWERS`: Q11 a, Q12 a, Q13 a, Q14 a. Ý 3 và ý 5 không cần hỏi.

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q11 | Bớt màu xanh (ý 1) | **(a)** Bỏ viền trái; tên người gửi dùng màu chữ thường; chỉ biểu tượng vai trò còn màu |
| Q12 | Bấm tên Worker để mở Worker (ý 2) — Paseo 0.8 chỉ cho surface và panel `openAgent`, không cho thẻ chat | **(a)** Chưa làm; ghi thành đề nghị gửi Paseo (cho thẻ chat nhận `navigation`) |
| Q13 | Chip câu đang chờ phía trên khung chat (ý 6) — Paseo có composer pill nhưng không cuộn được tới thẻ | **(a)** Tách thành request riêng, làm sau khi Worker beads-tab (`req-20260918T043115Z`) xong: mỗi Worker đang chờ một pill, bấm mở popover hiện câu hỏi để trả lời ngay |
| Q14 | "Đã phản hồi" (ý 4) — thẻ chỉ biết câu trả lời gửi từ chính nó trong phiên app | **(a)** Sau khi gửi từ ô Reply của thẻ: ẩn nút "Reply to …", hiện chip nhỏ "Answered" dưới chip trạng thái; bấm chip để mở lại ô Reply |

### 1.4 Chip câu đang chờ phía trên khung chat (2026-09-18, batch `b5`)

Sau khi batch `b4` xong, owner gửi lại khối trả lời Q11–Q14 với **Q13 đổi từ (a) sang (b)**: làm chip ngay trong request này. Worker không làm theo câu trả lời cho một câu đã đóng, và hỏi lại bằng Q15. Owner trả lời "Q15: b".

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q15 | Làm ngay chip "câu đang chờ" phía trên khung chat? | **(b)** Làm ngay trong request này (batch `b5`): bổ sung thiết kế, bead, implement. Chấp nhận sửa chồng lên `index.client.tsx` đang có thay đổi chưa commit của Worker `req-20260918T043115Z`, và chấp nhận vượt số lượt review của mức Large |

Hành vi theo Q13 (b): mỗi Worker đang chờ có một pill; bấm vào mở popover hiện câu hỏi để trả lời ngay. Paseo 0.8 không cho plugin cuộn khung chat tới một thẻ, nên popover thay cho việc cuộn.

### 1.5 Đồng bộ trạng thái "đã trả lời" và nút "Mark as answered" (2026-09-18, batch `b6`)

Owner dùng bản có pill (batch `b5`), rồi gửi:

> 1. Khi tôi đã trả lời nhanh Worker từ khu vực phía chat mới thể hiện thì trong màn hình chat vẫn hiển thị như là chưa trả lời hãy đồng bộ lại cho phù hợp
> 2. Bổ sung thêm button Mark as answer để không hiển thị theo kiểu nhìn như chưa trả lời nữa

Nguyên nhân của ý 1: popover của pill và thẻ trong chat là hai bản của cùng một thẻ. Chúng dùng chung bảng "đã trả lời" của phiên app, nhưng thẻ trong chat chỉ đọc bảng đó lúc được vẽ.

Owner trả lời bằng khối `BM-ANSWERS`: Q16 a, Q17 a, Q18 b.

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q16 | Nhớ dấu "Mark as answered" ở đâu | **(a)** Lưu vào một file nhỏ trong thư mục cài paseo-bm qua một RPC mới (như thứ tự launcher); dấu còn sau khi tải lại app |
| Q17 | Thẻ tự biết câu hỏi đã được trả lời (Worker đã chạy tiếp hoặc đã báo cáo mới hơn) | **(a)** Có: thẻ đọc lại mỗi 15 giây, hiện "đã trả lời" dù trả lời ở đâu, kể cả sau khi tải lại app |
| Q18 | "Mark as answered" có ẩn pill | **(b)** Không: pill còn cho tới khi Worker chạy lại hoặc báo cáo khác |

### 1.6 Thẻ `finished` đọc được ngay và dễ nhận ra (2026-09-18, request `req-20260918T074311Z`)

Owner gửi:

> Đối với việc finished thì cũng hiển thị block thông tin kết quả để tôi có thể đọc, riêng với finish thì cần thiển thị luôn, không cần phải ấn show message,
> Về tổng thể thì nên có thể hiện hơi khác biệt một chút để dễ nhận diện

Hôm nay mọi thẻ đều gập tin nhắn sau nút "Show message". Vì ý (f), Manager không nhắc lại thứ thẻ đã có, nên muốn đọc kết quả của một báo cáo `finished` thì người dùng phải bấm mở thẻ.

Owner trả lời bằng khối `BM-ANSWERS`: Q1 a, Q2 a, Q3 a, Q4 a. Các mã câu dưới đây là của request `req-20260918T074311Z`, khác Q1–Q18 ở trên.

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q1 | Thẻ `finished` hiện sẵn gì | **(a)** Mở sẵn toàn bộ tin nhắn, đúng thứ "Show message" đang hiện (vài dòng của Worker và khối `BM-REPORT` dạng danh sách). Nút thành "Hide message" để gập lại. Áp ở mọi chat vẽ thẻ này |
| Q2 | "Khác biệt để dễ nhận diện" | **(a)** Chỉ thẻ `finished` có viền màu success bao quanh cả thẻ; các thẻ khác giữ nguyên. Đây là ngoại lệ có chủ ý của Q11 (bỏ viền màu), và chỉ cho thẻ này |
| Q3 | Ghi thay đổi ở đâu | **(a)** Thêm vào delta 20260918d như các batch `b4`–`b6`: mục này, ý (l) ở §5, thiết kế §4.10, và các dòng lịch sử |
| Q4 | Thứ tự với request rà soát UI `req-20260918T063746Z` (cũng sửa `chat-card.tsx`) | **(a)** Sửa code ngay. Mốc nền của request rà soát UI chờ request này xong và được owner commit, như Q15 của request đó |

## 2. Bối cảnh — vì sao bây giờ

REQ-059 (thẻ câu hỏi) chạy thật lần đầu trên daemon của owner ngày 2026-09-18, và lộ ra ba chỗ hỏng:

1. **Manager lặp lại thẻ.** REQ-059(f) dặn Manager hiện mọi câu hỏi kèm lựa chọn. Thẻ đã hiện đúng những thứ đó, nên chat dài gấp đôi. Ở lần đo, Manager in cả danh sách **hai lần** ngay dưới thẻ.
2. **Câu trả lời chọn trong thẻ không tới Worker.** Thẻ có hai đường gửi tách rời:
   - nút "Send answers to <Worker>" gửi các lựa chọn;
   - ô "Reply to Worker" chỉ gửi chữ gõ vào.

   Owner tick lựa chọn, gõ "OK" vào ô Reply rồi gửi. Worker chỉ nhận được "OK" và phải hỏi lại cả năm câu. Ô Reply cũng **không** kiểm Worker có đang chạy không, nên một tin gửi lúc đó thay mất lượt đang chạy.
3. **Thẻ khó đọc.** Câu hỏi viết bằng chữ monospace; lựa chọn là các ô nhỏ nằm sát nhau.

Câu hỏi của owner về việc tách file chỉ dẫn (Q2) được trả lời bằng một đánh giá, không đổi file nào.

## 3. Tác nhân

N/A — cùng các tác nhân của [prd-delta-20260918c §3](paseo-bm-prd-delta-20260918c-question-cards.md#3-tác-nhân): người dùng (owner), Beads Manager, Beads Worker. Không có tác nhân mới.

## 4. Mục tiêu và bằng chứng thành công

1. **Manager không lặp lại thẻ.** Trả lời một báo cáo có thẻ trong **tối đa 2 dòng**, và **0** dòng câu hỏi hay lựa chọn khi báo cáo có khối `BM-QUESTIONS`.
   *Bằng chứng:* luật trong `test/roles-content.test.ts`; owner tự kiểm trên daemon thật với một Manager mới.
2. **Không lựa chọn nào bị mất.** Mọi lựa chọn đang tick đều nằm trong chữ được gửi đi, trừ khi người dùng tự xoá chúng khỏi ô Reply.
   *Bằng chứng:* test các hàm thuần của thẻ; owner tick rồi gửi trên daemon thật và Worker nhận đúng khối `BM-ANSWERS`.
3. **Không Reply nào thay mất một lượt đang chạy.** Mọi nút Send của thẻ đọc lại trạng thái người nhận ngay trước khi gửi.
   *Bằng chứng:* test đường gửi với người nhận `running` lúc bấm, cho báo cáo, review và tin thường.
4. **Đồng ý mọi đề xuất vẫn chỉ tốn 2 cú bấm** ("Use recommendations", "Send"), như REQ-059.
   *Bằng chứng:* test logic thẻ.
5. **Thẻ đọc được.** Câu hỏi chữ thường, mỗi lựa chọn một hàng rộng hết thẻ.
   *Bằng chứng:* owner xác nhận trên daemon thật (đánh giá bằng mắt, không có số đo).

## 5. Yêu cầu

REQ-059 giữ số và giữ các ý (a), (g), (h). Delta này thay các ý (b), (c), (d), (e), (f):

| ID | Tên | Ưu tiên | Tiêu chí chấp nhận |
|---|---|---|---|
| REQ-059 (sửa) | Câu hỏi có cấu trúc và thẻ trả lời có lựa chọn | P2 | Các ý (b)–(f) mới ngay dưới bảng; (a), (g), (h) như cũ. |

- **(b) Thẻ hiện câu hỏi (Q5).**
  - Mỗi câu là một khối riêng:
    - dòng đầu in đậm `Q<n> · <chủ đề>`; câu không có chủ đề thì chỉ `Q<n>`;
    - câu hỏi bằng chữ thường (không monospace) ở dòng dưới.
  - Mỗi lựa chọn là một hàng rộng hết thẻ, các hàng cách nhau 8px. Trong hàng:
    - dấu chọn `○` / `●`, rồi khoá chữ cái in đậm;
    - nội dung lựa chọn xuống dòng thẳng hàng với dòng đầu của nó;
    - tag "recommended" ở cuối hàng của đúng lựa chọn Worker đề xuất.
  - "Other…" là hàng cuối của cùng danh sách, cùng kiểu hàng.
  - Giữa hai câu có một vạch ngăn.
  - Thẻ vẫn hiện tên Worker đang hỏi và request id. Không lựa chọn nào được chọn sẵn.
- **(c) Chọn và gửi (Q4).**
  - Không còn nút "Send answers to <Worker>".
  - Mỗi lần người dùng chọn một lựa chọn, bấm "Use recommendations" hay "Clear", hoặc gõ vào "Other", thẻ **viết lại khối `BM-ANSWERS` ở đầu ô "Reply to <Worker>"**:
    - mở ô nếu đang đóng;
    - lời người dùng gõ ngoài khối được giữ nguyên.
  - Khối luôn phản ánh các lựa chọn hiện tại; sửa tay bên trong khối sẽ bị viết đè ở lần chọn sau.
  - "Use recommendations" chỉ điền, không gửi.
  - Có **một** nút Send, bật khi ô có chữ. Câu chưa trả lời không có dòng trong khối; câu đó vẫn mở và Worker hỏi lại ở lần `blocked` sau (REQ-059g).
- **(d) Gửi đúng người, cho mọi Reply (Q4).**
  - Nút Send của **mọi** thẻ (báo cáo, review, tin thường) đọc lại trạng thái **ngay trước khi gửi**.
  - Tin chỉ gửi tới người nhận do plugin xác định: với thẻ câu hỏi là Worker duy nhất của request; không bao giờ tới một id đọc từ nội dung tin.
  - Không gửi, và nói lý do, khi:
    - không xác định được đúng một người nhận;
    - người nhận đang chạy hoặc đang khởi tạo;
    - người nhận đã đóng.
  - Gửi lỗi (agent đã bị xoá, mất kết nối) → thẻ hiện lỗi, giữ nguyên chữ trong ô và các lựa chọn.
  - Gửi xong một Reply có khối với ít nhất một đáp án → thẻ hiện đã trả lời những câu nào, cho ai, lúc nào. Bộ câu hỏi đó không chọn lại được trong phiên app đang mở.
- **(e) Dạng câu trả lời.**
  - Khối `BM-ANSWERS` giữ định dạng cũ, nhưng chỉ có một dòng cho mỗi câu **đã** trả lời:
    - `Q<n>: <chữ cái> — <nguyên văn lựa chọn>`;
    - `Q<n>: other — <nguyên văn lời người dùng>`.
  - Tin gửi từ thẻ gồm dòng đầu `Reply from the user about <requestId>:` như mọi Reply, tiếp theo là khối, rồi lời người dùng nếu có.
  - Trả lời qua Manager thì như cũ: `Continue <requestId>.` rồi khối.
- **(f) Manager không nhắc lại thẻ (Q1).**
  - Mọi `BM-REPORT` tới Manager đều hiện thành thẻ. Manager **không nhắc lại** thứ thẻ đã hiện: câu hỏi và lựa chọn của khối `BM-QUESTIONS`, bead, file, kết quả kiểm, tier.
  - Manager chỉ nói **1–2 dòng** về điều thẻ không có:
    - `blocked`: mỗi Worker còn chờ một dòng `A · <Worker> · <requestId>: Q6, Q7` (mã câu hỏi như Worker viết, đúng lời owner chốt ở Q1), kèm cách trả lời: trong thẻ, hoặc gõ `A6 a, B1 b` ở chat Manager (A6 = câu Q6 của Worker A — nhãn này chỉ dùng để trả lời trong chat);
    - `beads-done` của request Large: Worker đang chờ người dùng xác nhận;
    - `finished`: có bao nhiêu gợi ý chưa làm (người dùng quyết có thành việc mới không), và skill nào mà tier yêu cầu nhưng còn thiếu.
  - **Báo cáo kiểu cũ** (không có khối `BM-QUESTIONS`, nên thẻ không có nút): Manager vẫn liệt kê đủ câu hỏi, lựa chọn và đề xuất, lấy từ `blockers`, như hôm nay.
  - Nhóm theo chữ cái, đọc câu trả lời `A6 a` theo danh sách gần nhất, chỉ chuyển cho mỗi Worker phần của nó, hỏi lại khi không khớp, không tự chọn thay: tất cả **giữ nguyên**.
- **(i) Trình bày thẻ (batch `b4`, §1.3).** Áp cho mọi thẻ chat của paseo-bm:
  - thẻ không có viền màu bên trái; tên người gửi dùng màu chữ thường, chỉ biểu tượng vai trò mang màu (Q11);
  - giờ gửi nằm ở dòng ngay dưới tên người gửi, không nằm cuối hàng tiêu đề (ý 5);
  - có hơn 2 bead liên quan thì chỉ hiện 2 chip, dòng dưới là chip "…"; bấm "…" hiện đủ (ý 3);
  - gửi xong một Reply từ thẻ thì nút "Reply to …" ẩn đi, và một chip nhỏ "Answered" hiện ngay dưới chip trạng thái ở góc trên bên phải; bấm chip mở lại ô Reply. Thẻ chỉ nhớ điều này trong phiên app đang mở (Q14).
- **(j) Chip câu đang chờ (batch `b5`, §1.4).**
  - Trong khung chat của Manager, cạnh các pill của Paseo ("Sub-agent working", "Git diff"), mỗi Worker đang chờ người dùng trả lời có **một** pill mang tên Worker và số câu hỏi.
  - Worker "đang chờ" khi báo cáo mới nhất nó gửi Manager đó là `blocked` có khối `BM-QUESTIONS`, và Worker đang rảnh (không chạy, không khởi tạo, chưa đóng).
  - Bấm pill mở một popover hiện đúng thẻ của báo cáo đó: câu hỏi, lựa chọn và ô Reply, với cùng đường gửi và cùng kiểm tra trạng thái của thẻ (REQ-059 c, d, e).
  - Pill tự biến mất khi Worker bắt đầu chạy (đã nhận câu trả lời) hoặc gửi báo cáo khác. Độ trễ tối đa bằng một chu kỳ đọc lại (15 giây).
  - Không cuộn khung chat tới thẻ: Paseo 0.8 không có cách nào cho plugin làm việc đó.
- **(k) Trạng thái "đã trả lời" đồng bộ, và nút "Mark as answered" (batch `b6`, §1.5).**
  - Mọi bản của cùng một thẻ trong app đang mở (thẻ trong chat, thẻ trong popover của pill) đổi trạng thái cùng lúc khi một bản gửi câu trả lời, gửi Reply hay được đánh dấu.
  - Thẻ câu hỏi trong chat Manager hiện là **đã trả lời** khi một trong các điều sau đúng:
    - câu trả lời đã được gửi từ một bản của thẻ trong phiên app này;
    - người dùng đã bấm "Mark as answered" (dấu được lưu, còn sau khi tải lại app);
    - `chat.waiting` (đọc lại mỗi 15 giây) cho thấy báo cáo của thẻ không còn chờ: Worker đang chạy, đã báo cáo mới hơn, hay không còn.
  - Thẻ đã trả lời không hiện phần chọn nữa, mà hiện một dòng nói vì sao (đã gửi gì cho ai lúc nào / đã đánh dấu / Worker không còn chờ), cùng chip "Answered" thay nút Reply như ý (i).
  - Thẻ câu hỏi chưa trả lời có nút "Mark as answered" cạnh "Use recommendations" và "Clear".
  - Pill phía trên chat **không** đổi theo dấu (Q18): pill vẫn đi theo `chat.waiting`.
- **(l) Thẻ `finished` (request `req-20260918T074311Z`, §1.6).** Áp cho thẻ của một báo cáo `BM-REPORT` có `phase: finished`, ở mọi chat vẽ nó thành thẻ (chat Manager nhận, chat Worker gửi):
  - thẻ mở sẵn toàn bộ tin nhắn, như sau khi bấm "Show message". Nút ghi "Hide message" và gập tin lại được (Q1 a);
  - thẻ có viền màu success bao quanh cả thẻ, cùng độ dày với viền thường. Thẻ khác (báo cáo `received`, `beads-done`, `blocked`, review, tin thường) giữ viền thường và vẫn gập tin như cũ (Q2 a);
  - viền này là ngoại lệ duy nhất của ý (i). Thẻ `finished` vẫn không có viền trái, tên người gửi vẫn màu chữ thường, và mọi thẻ khác vẫn đúng như ý (i).

## 6. Yêu cầu phi chức năng

- **Bảo mật:**
  - người nhận luôn do plugin xác định qua `chat.peers` (agent paseo-bm cùng workspace), không bao giờ là id lấy từ nội dung tin;
  - không đọc, lưu hay in bí mật;
  - không gọi mạng.
- **Dữ liệu:**
  - Câu trả lời gửi từ thẻ và Reply đã gửi chỉ sống trong phiên app (như REQ-059d).
  - Batch `b6` (Q16 a) thêm **một** dữ liệu lưu bền: dấu "Mark as answered", trong file `<thư mục cài>/ui/answer-marks.json` (chỉ khoá của thẻ và thời điểm, tối đa 500 dấu), đọc và ghi theo đúng các luật an toàn của file thứ tự launcher.
  - Trạng thái "Worker không còn chờ" không lưu gì: thẻ đọc lại từ `chat.waiting`.
- **Hiệu năng:** viết lại khối sau mỗi lần chọn chỉ làm việc trên chữ trong ô (vài KB), không có độ trễ thấy được. Bộ đọc câu hỏi và các giới hạn độ dài của nó không đổi.
- **Sẵn sàng:** lỗi khi gửi hiện ngay trên thẻ; chữ trong ô và các lựa chọn không mất.
- **Khả năng tiếp cận:** mỗi lựa chọn và hàng "Other…" là một nút có trạng thái "đã chọn".

## 7. Ngoài phạm vi

- Tách `plugin/roles/*.md` thành reference/template hay thư mục theo provider (Q2 — chỉ có đánh giá).
- Sửa `worker.md` hay `reviewer.md`. Worker đọc được tin mới như hôm nay (thiết kế §4.6).
- Câu trả lời của Manager cho thông báo `BM-BUDGET` và cho lượt Worker kết thúc không kèm báo cáo.
- Thẻ câu hỏi trong chat Worker hay Reviewer (REQ-059 giữ nguyên). Các thẻ ở đó chỉ nhận thêm bước kiểm "người nhận đang chạy" của (d).
- Lưu câu trả lời hay Reply đã gửi từ thẻ qua lần tải lại app (chỉ dấu "Mark as answered" được lưu, Q16 a; sau khi tải lại, thẻ vẫn biết đã trả lời qua `chat.waiting`); báo Manager khi người dùng trả lời trong thẻ.
- Dashboard, kho vết, `chat.peers`, bộ đọc `BM-REPORT` / `BM-QUESTIONS`.
- Nâng phiên bản gói, phát hành, commit, cài hay nạp lại plugin trên daemon của owner.
- Bấm tên Worker trên thẻ để mở Worker: Paseo 0.8 không cho thẻ chat mở agent; thay vào đó là một đề nghị gửi Paseo (Q12, `docs/operations/paseo-upstream-request-timeline-navigation.md`).
- Cuộn khung chat tới thẻ khi bấm chip câu đang chờ: Paseo 0.8 không có API (§1.4); popover thay thế.

## 8. Ranh giới và phụ thuộc

- **Phụ thuộc Paseo 0.8:**
  - timeline renderer (đã dùng cho thẻ chat);
  - `paseo.agents.ref(id).send()`;
  - RPC `chat.peers`, trả trạng thái của các agent paseo-bm cùng workspace.
- **Phụ thuộc hành vi:** Manager làm theo chỉ dẫn là ràng buộc hành vi; plugin không ép được (như REQ-037). Chỉ dẫn chỉ tới Manager **tạo sau** khi nạp lại plugin; Manager đang mở giữ chỉ dẫn cũ.
- **Không sở hữu:** nội dung câu hỏi (Worker), quyết định trả lời (người dùng), cơ chế chat và trạng thái agent của Paseo.

## 9. Lộ trình

| Phase | Phạm vi | Điều kiện ra |
|---|---|---|
| Phase 2a-8 MVP (đợt này) | REQ-059 (b)–(f) sửa theo §5 | 1. `npm run verify` mã 0. 2. Owner tự kiểm trên daemon thật với một Manager mới: tick lựa chọn thì khối hiện trong ô Reply; gửi tới đúng Worker; Worker đang chạy thì không gửi; Manager trả lời báo cáo có thẻ trong ≤ 2 dòng, không lặp câu hỏi; thẻ đọc được. 3. REQ-059 của PRD gốc được cập nhật kèm dòng revision |

## 10. Câu hỏi mở

| ID | Câu hỏi | Owner | Trạng thái |
|---|---|---|---|
| Q1–Q5 (`req-20260918T041426Z`) | Vòng hỏi đầu và ba ý về thẻ | hieu.nt10 | **answered (2026-09-18)** — §1.1 |
| Q6–Q8 (`req-20260918T041426Z`) | Xác nhận trước khi implement | hieu.nt10 | **answered (2026-09-18)** — §1.2 |
| Q11–Q14 (`req-20260918T041426Z`) | Trình bày thẻ, batch `b4` | hieu.nt10 | **answered (2026-09-18)** — §1.3 |
| Q15 (`req-20260918T041426Z`) | Chip câu đang chờ, batch `b5` | hieu.nt10 | **answered (2026-09-18)** — §1.4 |
| Q16–Q18 (`req-20260918T041426Z`) | Đồng bộ "đã trả lời", Mark as answered, batch `b6` | hieu.nt10 | **answered (2026-09-18)** — §1.5 |
| Q1–Q4 (`req-20260918T074311Z`) | Thẻ `finished` mở sẵn và có viền success | hieu.nt10 | **answered (2026-09-18)** — §1.6 |

## 11. Revision History

| Ngày | Người | Thay đổi |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Request `req-20260918T074311Z` (Q1–Q4, §1.6): thêm ý (l) — thẻ `finished` mở sẵn tin nhắn và có viền success, là ngoại lệ của ý (i) chỉ cho thẻ này |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Theo review b6: §6 "Dữ liệu" và §7 nói đúng dữ liệu lưu bền mới (dấu "Mark as answered", Q16 a); câu trả lời gửi từ thẻ vẫn chỉ sống trong phiên |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b6` (Q16–Q18, §1.5): thêm ý (k) — đồng bộ trạng thái "đã trả lời" giữa các bản của thẻ, thẻ tự biết Worker không còn chờ, nút "Mark as answered" lưu bền |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b5` (Q15, §1.4): thêm ý (j) — chip câu đang chờ và popover trả lời; bỏ dòng "request riêng" ở §7 |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b4` (Q11–Q14, §1.3): thêm ý (i) — trình bày thẻ và chip "Answered"; ý 2 thành đề nghị gửi Paseo, ý 6 thành request riêng |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Áp vào PRD gốc (REQ-059 (b)–(f)) và trỏ từ delta 20260918c; Status → Accepted, Applied |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Owner xác nhận Q6–Q8 (§1.2); Status → Accepted |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | `prd-ready` PASS sau review b1 pass; Status giữ Review tới khi owner xác nhận trước khi implement |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Theo review b1: dòng `blocked` của Manager dùng mã câu `Q6, Q7` đúng lời owner chốt ở Q1 (§5 ý f) |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Tạo delta: REQ-059 (b)–(f) sửa theo Q1, Q4, Q5; đánh giá Q2 nằm ở thiết kế §9; Routing Decision |
