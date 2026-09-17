# Delta-change — Ba file vai trò: ít luật cấm hơn, luồng làm việc rõ hơn

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260917b-simplify-roles` |
| Tài liệu gốc | [Technical Design](./paseo-bm.md) §2.6; [PRD](../product/paseo-bm-prd.md) REQ-022, REQ-024, REQ-026, REQ-034, REQ-037 |
| Sửa cách trình bày của | [delta workflow-skills](./paseo-bm-delta-20260917-workflow-skills.md) §4.1–§4.10 (giữ nguyên **nội dung** mọi quyết định Q1–Q10; chỉ đổi chỗ đặt và cách viết), [delta review-budget](./paseo-bm-delta-20260916-review-budget.md), [delta owner-feedback](./paseo-bm-delta-20260916-owner-feedback.md) |
| Status | **Accepted, Applied** — owner hieu.nt10 chốt 4 quyết định ngày 2026-09-17 (§3); áp dụng xong cùng ngày, `npm run verify` mã 0 |
| Plan | [plan delta 20260917b-simplify-roles](../plans/paseo-bm-implementation-plan-delta-20260917b-simplify-roles.md) |
| Nguồn | Góp ý của owner ngày 2026-09-17 sau khi đọc ba file vai trò |

## 1. Owner nói gì

> Hiện tại tôi thấy ràng buộc về việc không làm gì, không được gọi command gì ... trong Worker và Reviewer cấm đoán rất nhiều. Việc cấm nhiều như vậy không tốt bằng việc làm gì và nói cho agent khác nắm. Hãy đơn giản hoá hơn, tối ưu cho Agents nắm về luồng làm việc và hướng dẫn làm. Cách rule thì nên hãy cấm những thứ thật sự lớn thay vì lắt nhắt case by case như các nội dung instruction hiện tại.

Ba ý: (a) cấm quá nhiều và quá vụn; (b) nên viết **phải làm gì** thay vì **cấm gì**, và để các vai biết việc của nhau; (c) file phải tối ưu cho việc nắm **luồng** và **cách làm**.

## 2. Hiện trạng đo được

| File | Dòng | Từ cấm (`never` / `do not` / `don't`) | Khối RULES | Gạch đầu dòng trong RULES |
|---|---|---|---|---|
| `worker.md` | 273 | 37 | dòng 11–62 (19% file) | 19 |
| `reviewer.md` | 137 | 20 | dòng 10–35 (19% file) | 8 |
| `manager.md` | 142 | 28 | dòng 7–33 (19% file) | 11 |
| **Tổng** | **552** | **85** | | **38** |

Bốn nguyên nhân gốc, tất cả nằm ở **cách viết**, không ở nội dung quyết định:

1. **Mỗi lỗi quan sát được đẻ ra một dòng cấm riêng.** Bảy delta liên tiếp, mỗi delta thêm vài luật ở đúng chỗ dễ thêm nhất là khối RULES. Không lần nào gộp lại.
2. **Lẫn ba loại nội dung trong cùng một khối:** ranh giới an toàn thật (`NEVER read secret files`), chi tiết công cụ (`NEVER use SendMessage`), và văn phong (`Keep reports and replies to a few lines`). Agent phải đọc cả 19 gạch đầu dòng mới biết cái nào là ranh giới.
3. **Cấm theo ca, không theo loại.** `git reset --hard`, `git clean`, `git checkout --`, `git restore`, `rm -rf`, xoá nhánh, xoá database là **một** loại: phá thứ mình không tạo ra. Liệt kê bảy ca vừa dài vừa hở: ca thứ tám không có trong danh sách trông như được phép.
4. **Luồng làm việc bị chôn trong gạch đầu dòng.** Chuỗi Lớn và chuỗi Vừa — thứ agent cần nhất — nằm giữa Step 3 cùng với luật nhãn và luật heading lint.

`test/roles-content.test.ts` (555 dòng) ghim gần như từng câu, nên mỗi lần đơn giản hoá đều phải sửa test hàng loạt. Chính comment đầu file đã cảnh báo điều này: *"a test that pins every sentence would make the next simplification just as hard"* — và đó là chuyện đã xảy ra.

## 3. Quyết định của owner (2026-09-17)

| # | Câu hỏi | Quyết định |
|---|---|---|
| Q11 | Đơn giản hoá tới mức nào | **Gộp thành giới hạn theo loại, và bỏ hẳn những điểm mà vai khác đã chặn.** Không chỉ dồn chữ: điểm nào một vai khác đã bắt được thì xoá khỏi vai này |
| Q12 | Bố cục | **Giới hạn cứng rút gọn vẫn đứng đầu file**, phần còn lại là luồng làm việc và hướng dẫn làm |
| Q13 | Phạm vi | **Cả ba vai**, để văn phong và cách đọc giống nhau |
| Q14 | Test | **Viết lại theo hành vi**: ghim nguyên văn chỉ những gì mã phụ thuộc; mỗi giới hạn cứng một khẳng định theo ý, không theo câu chữ |

## 4. Thiết kế

### 4.1 Nguyên tắc

1. **Giới hạn cứng nói theo LOẠI hành vi, không theo tên lệnh.** Tên lệnh chỉ xuất hiện trong ngoặc như ví dụ, tối đa bốn cái, và luôn kèm chữ "ví dụ" để agent không đọc danh sách đó như danh sách đóng.
2. **Mọi thứ không phải giới hạn cứng đều viết ở thể khẳng định, đặt đúng bước dùng nó.** "NEVER use `SendMessage`" biến thành, ở mục Báo cáo: "gửi bằng `send_agent_prompt` của Paseo (không phải `SendMessage`)". Cùng một thông tin, nhưng agent gặp nó đúng lúc cần, và đọc như hướng dẫn chứ không như lệnh cấm.
3. **Một điểm chỉ được nêu ở một vai.** Nếu vai khác đã có nghĩa vụ bắt lỗi đó, vai này không nhắc lại (§4.4).
4. **Luồng làm việc là một mục cấp một**, đứng ngay sau bảng phân mức.
5. **Không thêm, không bớt quyết định nào.** Delta này chỉ đổi cách trình bày. Mọi quyết định Q1–Q10 của delta workflow-skills giữ nguyên hiệu lực; bảng §4.3 chứng minh từng luật hiện tại đi về đâu.

### 4.2 Giới hạn cứng

**Worker — 5 giới hạn:**

| # | Giới hạn | Gộp từ |
|---|---|---|
| W1 | **KHÔNG GÌ RA KHỎI WORKSPACE NÀY** nếu người dùng chưa nói rõ "được": commit, push, pull request, deploy, publish, mạng, cài hay nâng cấp gói, **chạy migration trên dữ liệu thật**, quyền nâng cao, ghi file ra ngoài workspace — **trừ đúng một chỗ: thư mục vừa tạo bằng `mktemp -d`, có nói rõ ngay trong W1 và trỏ sang Bước 4** | commit/push/PR; ghi ngoài workspace; khối ASK FIRST (gói, mạng, migration trên dữ liệu thật, deploy, quyền) |
| W2 | **KHÔNG PHÁ, KHÔNG HOÀN TÁC THỨ MÌNH KHÔNG TẠO RA** (động từ "đụng" bị review lô b2 bác: nó cấm luôn việc sửa file và cập nhật bead trong phạm vi yêu cầu — chính là việc của Worker; giới hạn nay nói thẳng "sửa file hay cập nhật bead trong phạm vi yêu cầu là công việc, xoá sổ nó thì không"): file, lịch sử git, nhánh, database, bead, và **mọi thay đổi đã có sẵn trong working tree lúc bạn bắt đầu — không hoàn tác, không định dạng lại, không `git add`, không bỏ đi**. Agent là của người dùng: không lưu trữ, không kết thúc, không xoá agent nào kể cả chính mình (huỷ lượt chạy của Reviewer khi bị dừng thì khác, và nằm ở mục Dừng). Cần thì dừng lại và hỏi | lệnh phá huỷ (7 ca); hoàn tác/định dạng lại/stage/bỏ thay đổi có sẵn; lưu trữ/kết thúc/xoá agent |
| W3 | **KHÔNG ĐỌC, KHÔNG CHÉP BÍ MẬT** (`.env`, thông tin đăng nhập, token, khoá) | đọc file bí mật; không chép bí mật vào thư mục tạm |
| W4 | **KHÔNG LÀM CHO MỘT KIỂM TRA TRÔNG NHƯ ĐÃ ĐẠT**: không nới lỏng hay xoá test, khẳng định, tiêu chí chấp nhận để nó đạt; không đóng hay nhận bead bằng cách **ghi đè một chốt chặn của công cụ** (`--force`) hay bằng một kiểm tra bạn chưa thấy đạt. Kiểm tra đỏ nghĩa là mã sai hoặc bead sai — sửa mã, hoặc gửi `blocked` | luật §4.10-4 và §4.10-5 của delta trước; luật cấm `--force` |
| W5 | **KHÔNG QUYẾT THAY NGƯỜI DÙNG**: yêu cầu là phạm vi, ngoài nó đều là đề xuất chứ không phải việc. Có quyết định, rủi ro hay mâu thuẫn chắn đường thì gửi `blocked` và chờ — không bao giờ đi tiếp bằng mặc định bạn tự chọn. Mục Hỏi phải nói thẳng `blocked` là kênh duy nhất và hộp hỏi kiểu `AskUserQuestion` không trả về gì ở đây | phạm vi là yêu cầu; mọi thứ ngoài là đề xuất; cấm `AskUserQuestion`; cấm tự lấy mặc định |

**Reviewer — 4 giới hạn:**

| # | Giới hạn | Gộp từ |
|---|---|---|
| R1 | **BẠN KHÔNG ĐỔI GÌ TRONG REPO.** (Thêm sau review b2: thư mục tạm bạn tự tạo không tính là thay đổi, và câu "kiểm tra nào cần thứ mà bốn giới hạn này chặn thì ghi `notChecked`" phải phủ cả bốn, không chỉ giới hạn về thay đổi.) Bạn đọc và chạy kiểm tra. Không sửa file, bead, git; **không đụng vào agent nào — không tạo, không nhắn, không dừng, không lưu trữ, không xoá**. Có công cụ không đồng nghĩa được dùng. Kiểm tra nào sẽ làm thay đổi thứ gì thì bỏ qua và ghi vào `notChecked` | sửa file; đổi bead; thao tác agent; đụng git (7 động từ); build ghi ra file, formatter, migration, `br` ghi |
| R2 | **KHÔNG GÌ RA KHỎI MÁY NÀY**: không mạng, không cài, không tải | mạng/cài/tải |
| R3 | **KHÔNG ĐỌC BÍ MẬT.** Lô có thêm bí mật thì báo chặn mà không nhắc lại giá trị | như cũ |
| R4 | **MỘT LÔ, MỘT KẾT QUẢ.** Chỉ xem đúng phạm vi được giao, không xin thêm vòng review | ngoài phạm vi; xin thêm vòng |

**Manager — 5 giới hạn:**

| # | Giới hạn | Gộp từ |
|---|---|---|
| M1 | **BẠN KHÔNG LÀM VIỆC THAY.** Không viết tài liệu, không tạo/sửa/đóng bead, không đổi mã. Giao việc | như cũ |
| M2 | **BẠN LÀ ĐƯỜNG TRUYỀN, KHÔNG PHẢI NGƯỜI QUYẾT.** Chuyển nguyên văn yêu cầu và câu trả lời của người dùng; mệnh đề "và không gì khác" chỉ áp cho lúc **chuyển tiếp** và lúc **nối lại** — **prompt đầu tiên là ngoại lệ, đi theo công thức ở bước 2** (review b2: bản gộp đầu đã cấm luôn sáu mục bắt buộc của `initialPrompt`, kể cả `$PASEO_AGENT_ID` mà Worker cần cho mọi `BM-REPORT`); không thêm yêu cầu, kiểm tra hay ràng buộc của riêng bạn; không duyệt, chỉnh hay bác kế hoạch của Worker — người dùng quyết | "DO NOT ADD WORK"; "YOU ARE A RELAY, NOT A DECIDER" |
| M3 | **KHÔNG NÓI QUÁ NHỮNG GÌ BẠN THẤY.** Nguồn duy nhất là `BM-REPORT` và công cụ trạng thái/hoạt động; không đọc hội thoại của agent khác; không biết thì nói không biết | không đọc hội thoại; không đoán |
| M4 | **AGENT LÀ CỦA NGƯỜI DÙNG.** Không lưu trữ, không xoá, không duyệt xin quyền hộ ai. Thao tác agent duy nhất bạn **được** làm là huỷ lượt chạy của Worker (`cancel_agent`), và **chỉ khi** nó kẹt, lệch hướng hoặc vượt ngân sách mà chưa xin phép — luôn nói lý do (tên công cụ và chữ "chỉ khi" bị mất ở bản gộp đầu, review b2 bắt được) | lưu trữ/xoá agent; duyệt quyền; quyền huỷ (giữ ở dạng cho phép) |
| M5 | **KHÔNG ĐỌC HAY IN BÍ MẬT**, kể cả biến môi trường. Id của chính bạn: `echo "$PASEO_AGENT_ID"` | không in/lọc/tìm biến môi trường |

Câu "file này đè lên mọi skill ở phần an toàn, ngân sách review, báo cáo, lúc hỏi và phạm vi" **giữ nguyên** trong `worker.md`: nó là hợp đồng ưu tiên, không phải lệnh cấm.

### 4.3 Bảng chuyển — từng luật hiện tại đi về đâu

Không luật nào biến mất mà không có chỗ đến. `→ Wn/Rn/Mn` là gộp vào giới hạn cứng; `→ <mục>` là chuyển thành câu khẳng định trong mục đó; `→ bỏ` xem §4.4.

**worker.md**

| Luật hiện tại | Đi đâu |
|---|---|
| commit / push / pull request | → W1 |
| lưu trữ, kết thúc, xoá agent | → W2 |
| lệnh phá huỷ (`rm -rf`, `git reset --hard`, `git clean`, `git checkout --`/`restore`, force, xoá database, xoá nhánh) | → W2, ví dụ rút còn 4 |
| đọc file bí mật | → W3 |
| ghi ngoài workspace + ngoại lệ `mktemp -d` + thời điểm xoá | → W1; câu hướng dẫn thư mục tạm chuyển xuống Bước 4 |
| không chép file bí mật vào thư mục tạm | → W3 |
| không hoàn tác/định dạng lại/stage/bỏ thay đổi có sẵn | → W2 |
| chạy `git status` trước lần ghi đầu | → Bước 4, câu khẳng định |
| lượt chạy skill không thay được review | → mục Review: "một lượt review là một tin nhắn bạn gửi cho Reviewer; lượt chạy skill là việc của bạn" |
| không sửa test/khẳng định/tiêu chí để kiểm tra đạt | → W4 |
| mệnh đề "chỉ khi bead ĐÃ yêu cầu trước lúc chạy kiểm tra" | → bỏ (D3) |
| không dùng `SendMessage` | → mục Báo cáo |
| không dùng `AskUserQuestion`; không tự lấy mặc định | → W5; cách hỏi nằm ở mục Hỏi |
| ASK FIRST: gói, mạng, migration dữ liệu thật, deploy, quyền | → W1 |
| yêu cầu là phạm vi; ngoài yêu cầu là đề xuất | → W5; định dạng `none. Suggestion (not done): …` ở mục Báo cáo |
| chỉ làm bead của yêu cầu này | → Bước 4 |
| kiểm tra rẻ nhất mà vẫn chứng minh được | → Bước 4 |
| theo mức/cách người dùng đặt, nêu rủi ro một câu | → Bước 1 |
| trả lời ngắn, theo ngôn ngữ người dùng | → mục "Cách bạn nói" |
| hỏi trước khi sửa tài liệu đã đóng băng / mở rộng phạm vi / xoá bead | → mục Hỏi (danh sách dừng-và-hỏi) |
| `--force` khi đóng bead | → W4 (ghi đè chốt chặn của công cụ) — **không còn bị bỏ**, xem §4.4 |
| lệnh đóng không đi chung dòng với lệnh kiểm tra | → bỏ (D2) |

**reviewer.md**

| Luật hiện tại | Đi đâu |
|---|---|
| thao tác agent; sửa file; đổi bead; đụng git (7 động từ) | → R1 |
| build ghi ra file, formatter, migration, `br` ghi, tải về | → R1 (ghi) và R2 (tải) |
| mạng / cài đặt | → R2 |
| `YOU MAY RUN …` | → mục "Bạn được chạy gì", giữ nguyên nội dung |
| `git status --porcelain` trước và sau | → cùng mục đó |
| đọc bí mật | → R3 |
| ngoài phạm vi; xin thêm vòng review | → R4 |

**manager.md**

| Luật hiện tại | Đi đâu |
|---|---|
| viết tài liệu / bead / mã | → M1 |
| lưu trữ hoặc xoá agent; duyệt xin quyền | → M4 |
| đọc hội thoại agent khác; đoán điều không thấy | → M3 |
| in/lọc/tìm biến môi trường; `$PASEO_AGENT_ID` | → M5 |
| nhắc thông báo hệ thống không liên quan | → mục "Cách bạn nói", thể khẳng định |
| hai nguồn mâu thuẫn thì nói rõ nguồn nào nói gì, không bịa tiến độ | → mục "Báo cáo và ngân sách", thể khẳng định (giữ nguyên câu đang có) |
| không thêm việc; đường truyền không phải người quyết | → M2 |
| được huỷ lượt chạy của Worker | → M4 |
| trả lời ngắn, theo ngôn ngữ người dùng, `blocked` thì hiện đủ | → mục "Cách bạn nói" |

### 4.4 Bỏ hẳn — và ai chặn thay

Theo quyết định Q11. Một điểm chỉ được bỏ khi nó đã được phủ bởi **một giới hạn theo loại trong chính file này**, hoặc bởi **một nghĩa vụ của vai khác bắt được bằng cách ĐỌC** (diff, bead, báo cáo) chứ không phải bằng cách chạy — vì Reviewer có thể bị sandbox chặn không chạy được (NEW-1 của biên bản nghiệm thu 2026-09-17). D3 là điểm **duy nhất** phụ thuộc vào vai khác; năm điểm còn lại tự phủ trong file.

| # | Bỏ khỏi | Nội dung | Ai chặn thay |
|---|---|---|---|
| ~~D1~~ | — | ~~"Không bao giờ dùng `--force`"~~ | **Rút khỏi danh sách bỏ** sau review lô b1: `--force` vượt chốt chặn của `br` (nhận bead còn blocker), không phải chuyện "kiểm tra trông như đạt", và **không để lại dấu trong diff** nên Reviewer không đọc ra được. Nay là một vế theo loại trong W4: không ghi đè chốt chặn của công cụ |
| D2 | worker | "Lệnh đóng không đi chung dòng lệnh với lệnh kiểm tra" | W4 giữ nguyên nguyên tắc; cơ chế cụ thể là ví dụ của một ca, đúng loại "lắt nhắt" owner nêu |
| D3 | worker | "Chỉ sửa test khi bead ĐÃ yêu cầu trước lúc chạy kiểm tra; viết lại bead để cho phép cũng là vi phạm" | W4 viết "để nó đạt", nên sửa test vì bead vốn yêu cầu vẫn hợp lệ; Reviewer chặn "test/khẳng định/tiêu chí bị nới lỏng hay xoá để một kiểm tra đạt" — đọc được từ diff |
| D4 | worker | "Không chép file bí mật vào thư mục tạm" | W3 cấm cả đọc lẫn chép |
| D5 | worker | 3 trong 7 ví dụ lệnh phá huỷ | W2 nói theo loại; ví dụ còn lại đủ để nhận dạng |
| D6 | reviewer | Liệt kê 5 loại lệnh ghi và 7 động từ git | R1 nói theo loại |
| D7 | worker | "Không chụp ảnh nền, không thêm bộ khẳng định" (`No baseline snapshots, no extra assertion suites`) | W5 (ngoài yêu cầu là đề xuất) cộng câu "chứng minh bằng kiểm tra rẻ nhất mà thật sự chứng minh được" ở Bước 4 — đúng loại liệt kê hai ca mà owner nêu |

Không bỏ: mọi luật liên quan tới bí mật, tới việc ra khỏi workspace, tới hỏi người dùng. Ba nhóm này không có vai nào khác chặn được.

### 4.5 Bố cục mới

| | `worker.md` | `reviewer.md` | `manager.md` |
|---|---|---|---|
| 1 | Bạn là ai (3 dòng) + câu đè lên skill | Bạn là ai + "review theo yêu cầu, không theo sự hoàn hảo" | Bạn là ai + giao việc ngay |
| 2 | `## RULES` — 5 giới hạn | `## RULES` — 4 giới hạn | `## RULES` — 5 giới hạn |
| 3 | `## Bước 1 — Phân mức` (bảng mức giữ nguyên) | `## Bạn kiểm gì và kiểm thế nào` (bảng giai đoạn, tiêu chí từ skill, được chạy gì) | `## Với mỗi yêu cầu mới` |
| 4 | **`## Bước 2 — Thứ tự bạn làm`** ← chuỗi Lớn / Vừa / Nhỏ tách ra thành mục riêng | `## Chặn hay không chặn` | `## Báo cáo và ngân sách` |
| 5 | `## Bước 3 — Tài liệu, bead, nhãn` (gộp luật nhãn cũ vào đây) | `## Kết quả` | `## Khi nào dừng và báo` |
| 6 | `## Bước 4 — Làm tới khi xong` | `## Dừng` | `## Cách bạn nói` |
| 7 | `## Hỏi và rủi ro` | | |
| 8 | `## Review` · `## Dừng` · `## Báo cáo cho Manager` · `## Cách bạn nói` | | |

Mục "Thứ tự bạn làm" là thay đổi lớn nhất về cách đọc: ba chuỗi (Lớn, Vừa, Nhỏ) đang nằm lẫn trong Step 3 cùng luật nhãn và luật heading lint, nay đứng riêng ngay sau bảng phân mức — đúng chỗ agent tìm khi hỏi "giờ tôi làm gì tiếp".

**Số đo sau khi viết lại** (con số ≤ 240 đặt ra trước khi viết đã KHÔNG đạt, xem dưới):

| File | Dòng trước → sau | Khối `## RULES` trước → sau | Mục trong RULES trước → sau | Trần |
|---|---|---|---|---|
| `worker.md` | 273 → **270** | 52 → **32** (−38%) | 19 → **5** | 276 dòng, RULES ≤ 34 |
| `reviewer.md` | 137 → **137** | 26 → **16** (−38%) | 8 → **4** | 145 dòng, RULES ≤ 18 |
| `manager.md` | 142 → **150** | 27 → **28** | 11 → **5** | 157 dòng, RULES ≤ 29 |

*(Số đo cuối, sau lượt review b2 và lượt review lại — §9. Trước hai lượt đó là 266 / 135 / 147 dòng với khối RULES 30 / 14 / 25; các lần sửa đều là thêm lại mệnh đề bị mất hoặc gỡ mâu thuẫn, nên số dòng tăng chứ không giảm.)*

Tổng số dòng gần như không đổi, và `manager.md` còn dài thêm 5 dòng. Đó là hệ quả thẳng của lời hứa ở §4.3: luật **chuyển chỗ** chứ không biến mất, nên chữ vẫn còn, chỉ nằm đúng bước dùng nó. Chỗ co lại thật là khối `## RULES` — thứ agent đọc trước khi hành động và là thứ owner chỉ vào. Ép xuống 240 sẽ phải cắt vào quyết định chứ không phải cắt văn xuôi, đúng kiểu ép cho kiểm tra chuyển sang đạt mà W4 cấm, nên trần lấy theo **số đo cộng 10 dòng**.

### 4.6 Chính sách test mới

`test/roles-content.test.ts` viết lại theo hai tầng:

1. **Ghim nguyên văn — chỉ những gì mã hoặc người khác phụ thuộc:** khối `BM-REPORT` (đủ tên trường, đúng thứ tự, `skillsUsed` ngay sau `buildAndTests`), khối `BM-REVIEW`, dòng `BM-REVIEW STOPPED`, câu thông báo `STOP: The Beads Worker…`, tên nhãn `bm.role`/`bm.requestId`/`bm.batchId`/`bm.version`, `feature:<slug>`, `Continue <requestId>.`, provider `bm-worker/`…, `bm-reviewer/`…, các con số ngân sách **1 / 4 / 6**, tên các phase báo cáo, `Plan-ready: PASS`.
2. **Theo hành vi — mỗi giới hạn cứng một khẳng định theo Ý:** khớp bằng vài từ khoá thay thế được cho nhau, không bằng nguyên câu. Đổi chữ trong giới hạn không làm đỏ test; **xoá** một giới hạn thì đỏ.

Thêm hai khẳng định cấu trúc chống tái phát:

- **Trần dòng 240** cho cả ba file.
- **Ngân sách RULES:** mỗi file phải có **đúng** số giới hạn đã chốt (Worker 5, Reviewer 4, Manager 5), khối `## RULES` không dài quá trần ở §4.5, và **không có gạch đầu dòng nào** lẫn trong khối đó. Thêm một lệnh cấm mới ở delta sau thì phải bỏ một cái đang có, hoặc nâng trần một cách có chủ đích và nói lý do trong tài liệu của chính delta đó. Đối chứng âm: thêm một mục thứ năm vào `reviewer.md`, dù viết dạng số hay dạng gạch đầu dòng, đều làm test đỏ.
- **Đã thử và đã bỏ — đếm từ cấm.** §4.6 bản đầu đề xuất chặn số từ `never` / `do not` / `don't` (22 / 12 / 14). Hai lý do bỏ: (a) review lô b1 đo được riêng phần ngoài khối RULES đã là 22 / 8 / 15, nên con số đặt trước bất khả thi; (b) phép đếm bắt nhầm cả `do not know`, `do not relay it again`, `do not retry in a loop` — đó là **hướng dẫn**, không phải giới hạn quyền của agent. Theo phép đo sai này, `manager.md` sau khi đơn giản hoá còn "tệ hơn" (28 → 30), một kết luận vô nghĩa. Phép đo đúng phải nhìn vào **số giới hạn** và **độ dài khối RULES**, đúng thứ owner chỉ vào. Đây là cách duy nhất khiến ý của owner tự bảo vệ được: delta sau muốn thêm một lệnh cấm thì phải bỏ một cái khác, hoặc phải nâng trần một cách có chủ đích và ghi lại.

## 5. Không đổi

- Ba mức và cách phân mức, bảng skill theo mức, ngân sách review 1 / 4 / 6, các lô `b1`/`b2`/`b3`, `userAllowedExtra`.
- Hợp đồng `BM-REPORT` và `BM-REVIEW` từng chữ, các mốc gửi báo cáo, `notifyOnFinish: false` cho báo cáo.
- Hợp đồng leaf bead 10 mục, luật một-lá-một-kết-quả, luật tách bead anh em.
- Ba mốc hỏi bắt buộc và luật gửi mọi câu hỏi trong `blockers`.
- Tiêu chí theo giai đoạn của Reviewer và danh sách lô nhạy cảm.
- Cách tạo agent (profile, nhãn, `modeId`), luật dừng, `BM-REVIEW STOPPED`.
- Dashboard, `workflowStepSchema`, mọi mã server và client: **không đụng tới**.

## 6. Rủi ro

| # | Rủi ro | Giảm thiểu |
|---|---|---|
| 1 | Gộp làm mất một hành vi đang có | Bảng §4.3 liệt kê **từng** luật hiện tại và chỗ đến; §4.4 liệt kê riêng 6 điểm bỏ hẳn kèm vai chặn thay. Review lô tài liệu đối chiếu hai bảng này với ba file cũ |
| 2 | D3 bị bỏ, mà Reviewer lại bỏ sót | Test bị nới lỏng đọc được từ diff, không cần chạy, nên sandbox không ảnh hưởng; W4 vẫn cấm ở mức nguyên tắc. Ghi nhận là rủi ro đã chấp nhận theo quyết định Q11. (D1 đã được rút khỏi danh sách bỏ sau review b1 vì đúng rủi ro này) |
| 3 | Test lỏng hơn nên lần sau mất chữ mà không ai biết | Tầng 1 ghim nguyên văn mọi thứ mã đọc; tầng 2 vẫn đỏ khi một giới hạn bị xoá. Mỗi bead đổi file vai trò phải kèm một đối chứng âm |
| 4 | Agent đã tạo vẫn giữ chỉ dẫn cũ | Như mọi lần đổi file vai trò: chỉ áp cho agent tạo sau lần cài lại. Ghi vào biên bản |
| 5 | Viết ngắn đi làm mất sắc thái ở chỗ mơ hồ (ví dụ thế nào là "phá") | Mỗi giới hạn cứng có một vế ví dụ trong ngoặc và một vế "cần thì dừng lại và hỏi" |

## 7. Tài liệu phải cập nhật

- `docs/design/paseo-bm.md` §2.6: một dòng errata trỏ sang delta này (bố cục file vai trò).
- `README.md`: đoạn mô tả Worker/Reviewer nếu có trích luật theo câu chữ.
- `docs/operations/paseo-bm-workflow-skills-run-20260917.md`: thêm mục ghi lần đơn giản hoá này.
- Delta workflow-skills `20260917`: một dòng ở đầu ghi rằng cách trình bày §4 đã được delta này thay, nội dung quyết định giữ nguyên.

## 8. Review lô b1 (tài liệu)

Một lượt review độc lập, phạm vi: ba file vai trò hiện tại đối chiếu §4.3, sáu điểm §4.4, và độ phủ của §4.2. Kết quả `changes-required`, 7 finding chặn.

| # | Finding chặn | Xử lý |
|---|---|---|
| B1 | "chạy migration trên dữ liệu thật" không nằm trong W1 và không test nào bắt | §4.2 W1 thêm; test thêm neo |
| B2 | "stage / định dạng lại" không phải "phá", nên W2 không với tới | §4.2 W2 nói thẳng bốn động từ; test thêm neo |
| B3 | D1 (`--force`) không ai chặn thay: W4 nói về kiểm tra, Reviewer không đọc ra từ diff | Rút D1 khỏi danh sách bỏ; W4 thêm vế "ghi đè chốt chặn của công cụ" |
| B4 | R1 mất "lưu trữ / xoá agent", trong khi đó là bất biến của sản phẩm | §4.2 R1 nêu đủ năm động từ |
| B5 | W5 mất hẳn con trỏ tới `AskUserQuestion` | §4.2 W5 buộc mục Hỏi nói rõ |
| B6 | Trần cấm đoán 22/12/14 bất khả thi trước khi viết | §4.6 đánh dấu tạm, trỏ sang luật đo-rồi-đặt của WP-226 |
| B7 | Khẳng định R/M trong bộ test mới vẫn ghim gần như nguyên văn câu cũ | Mở lại bead WP-222, đổi sang khớp theo từ khoá trước khi viết lại hai file |

Năm finding không chặn được ghi làm đề xuất, không sửa: (1) tiêu đề §4.4 nói quá về bảo đảm — **đã sửa** vì nó là một khẳng định sai chứ không phải văn phong; (2) câu "hai nguồn mâu thuẫn thì nói rõ nguồn nào nói gì" của Manager chưa có chỗ đến — **đã thêm** một dòng vào §4.3 vì tính đủ của §4.3 chính là tiêu chí chấp nhận của delta này; (3) W1 cấm ghi ngoài workspace trong khi Bước 4 cho `mktemp -d` — **đã sửa**, ngoại lệ nằm ngay trong W1; (4) W2 gộp agent vào "không phá" có thể làm Worker từ chối `cancel_agent` mà chính mục Dừng bắt buộc — **đã sửa** bằng một vế trong ngoặc; (5) đưa `.beads/issues.jsonl` vào phạm vi lô `implementation` của Reviewer để thấy được tiêu chí chấp nhận bị viết lại — **không sửa**: đó là đổi nội dung quyết định, ngoài phạm vi delta trình bày này. Đề xuất cho owner.

## 9. Review lô b2 (mã)

Một lượt review độc lập trên ba file đã viết lại, so với bản ngay trước đó. Kết quả `changes-required`, 3 finding chặn — hai trong số đó là mâu thuẫn tôi tự tạo ra khi gộp luật.

| # | Finding chặn | Xử lý |
|---|---|---|
| B8 | W2 dùng động từ "TOUCH" kèm danh từ "files, beads" nên cấm luôn việc sửa file có sẵn và cập nhật bead có sẵn — đúng việc của Worker — mà W2 lại kết bằng "dừng lại và hỏi" | Đổi động từ sang UNDO và nói thẳng: sửa file hay cập nhật bead trong phạm vi yêu cầu là công việc |
| B9 | M2 "và không gì khác" cấm luôn sáu mục bắt buộc của `initialPrompt`, kể cả `$PASEO_AGENT_ID` mà `worker.md` đòi cho mọi `BM-REPORT` | Thu hẹp mệnh đề về đúng lúc chuyển tiếp/nối lại; prompt đầu tiên là ngoại lệ theo công thức bước 2 |
| B10 | Bốn động từ của W2 khớp được với chữ ở chỗ khác trong file (`revert` khớp "reviewed and reverted on its own" ở Bước 3, `stage` khớp "the stage (`documents`…)" ở mục Review), nên xoá cả mệnh đề vẫn xanh | Mọi khẳng định về giới hạn nay chạy trên **khối `## RULES` đã làm phẳng**, không chạy trên cả file |

Bảy finding không chặn: **sửa bốn**, vì mỗi cái là một luật bị mất hoặc một mâu thuẫn chứ không phải văn phong — R1 thiếu ngoại lệ thư mục tạm; R1 thu hẹp chỗ đáp của `notChecked` xuống còn giới hạn về thay đổi; M4 mất tên công cụ `cancel_agent` và chữ "chỉ khi"; `worker.md` mất "hay tiêu chí chấp nhận chưa đạt" và chi tiết cắt dấu `-` cuối slug. **Không sửa ba**: "làm thay đổi nhỏ nhất rồi dừng" đã nằm trong W5; và hai điểm về độ chặt của test cho W3 đã được xử lý gián tiếp khi mọi khẳng định chuyển sang chạy trên khối RULES.

Đây là chỗ đi lệch có ý thức khỏi luật "không sửa finding không chặn" của chính sản phẩm: luật đó dành cho Worker để chặn việc mở rộng phạm vi, còn bốn điểm trên là khuyết tật của chính thay đổi này.

### Lượt review lại: 2 finding chặn nữa, cả hai nằm trong bản sửa

| # | Finding chặn | Xử lý |
|---|---|---|
| B11 | M4 sau khi được thêm lại tên công cụ thành "thao tác agent **duy nhất** … và **chỉ khi** kẹt/lệch/vượt ngân sách", mâu thuẫn với chính file: bước 2 bắt buộc `create_agent`, bước 3 bắt huỷ agent tạo hỏng, và mục "người dùng bảo dừng Worker" bắt huỷ theo yêu cầu | M4 nay nói rõ tạo và nhắn Worker là việc của Manager (bước 2), phần còn lại chỉ là huỷ lượt chạy bằng `cancel_agent`, kèm đủ ba trường hợp hợp lệ |
| B12 | R1 sau khi được sửa thành "KHÔNG ĐỔI GÌ **TRONG REPO**" đã thu hẹp một giới hạn vốn không giới hạn phạm vi: R2 chỉ phủ mạng/cài/tải, nên ghi vào thư mục skill, `git config` toàn cục hay một checkout khác không còn giới hạn nào chặn | Trả về "**YOU CHANGE NOTHING.**", ngoại lệ thư mục tạm để nguyên ở câu ngay sau. Test thêm khẳng định ngữ nghĩa: sau "change nothing" không được có giới từ phạm vi (`in`/`inside`/`within`/`to`/`under`) |

**Bài học ghi lại:** hai lượt review tìm ra 5 finding chặn, và **bốn trong số đó là mâu thuẫn do chính việc gộp luật sinh ra**, không phải luật bị mất. Gộp nhiều lệnh cấm hẹp thành một giới hạn rộng luôn có nguy cơ giới hạn mới **rộng quá** (cấm luôn việc phải làm) hoặc **hẹp quá** (thả mất một vùng). Cách phát hiện duy nhất tỏ ra hiệu quả là đọc lại cả file như một agent sẽ đọc, đối chiếu từng giới hạn với phần thân — không có test nào tự tìm ra được loại lỗi này.
