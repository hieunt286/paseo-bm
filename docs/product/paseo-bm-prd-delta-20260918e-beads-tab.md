# Delta-change — Tab "Beads" trong menu "+", Setup là màn chính của Beads Manager, màu cả dòng cho bead

> **Errata** (2026-09-18, theo [delta 20260918f](../design/paseo-bm-delta-20260918f-ui-review.md) §4.12): "màu cả dòng" trong tiêu đề là yêu cầu ban đầu; batch `b4` (Q8) chuyển màu sang tên bead — REQ-060 (g).

| Trường | Giá trị |
|---|---|
| Mã | `prd-delta-20260918e-beads-tab` |
| Tài liệu gốc | [PRD Dashboard](paseo-bm-dashboard-prd.md) REQ-040 (lối vào Dashboard), REQ-046 (thống kê beads); [delta 20260916-beads-screen](../design/paseo-bm-delta-20260916-beads-screen.md) (màn Beads); [delta 20260916-setup-screen](../design/paseo-bm-delta-20260916-setup-screen.md) (màn Setup); [delta 20260917e](../design/paseo-bm-delta-20260917e-manager-screen-and-commands.md) §4.1–§4.2, §4.4 (danh sách workspace, slash command). **Không sửa tại chỗ khi chưa duyệt** |
| Status | **Accepted, Applied** — cổng `prd-ready` PASS 2026-09-18 (review b1 pass); owner xác nhận trước khi implement (Q7); áp vào [PRD Dashboard](paseo-bm-dashboard-prd.md) REQ-060 ngày 2026-09-18 (WP-263) |
| Owner | hieu.nt10 |
| Created | 2026-09-18 |
| Request | `req-20260918T043115Z` |
| Thiết kế | [design-delta-20260918e-beads-tab](../design/paseo-bm-delta-20260918e-beads-tab.md) |
| Plan | [plan-delta-20260918e-beads-tab](../plans/paseo-bm-implementation-plan-delta-20260918e-beads-tab.md) |

## 0. Routing Decision

- Variant preset: brownfield
- Triggered risks:
  - **nhiều thành phần độc lập:** một panel workspace mới; surface "Beads Manager"; danh sách bead cùng chip trạng thái dùng chung;
  - **hành vi người dùng đang dựa vào:** màn chính Beads Manager hôm nay là danh sách workspace; màu chip trạng thái của bead.
- Required artifacts/gates: PRD delta này + `prd-ready` → design delta + `design-ready` → plan delta + `plan-ready-for-beads` → beads → `feature-done` (hồ sơ standard)
- Execution path: plan → converter
- Exceptions: none
- Decided: 2026-09-18 — Beads Worker, cỡ **Large**: Manager đoán, Worker xác nhận theo luật 1 (nhiều thành phần độc lập)
- Supersedes: none

## 1. Owner nói gì

> 1. Tôi muốn phát triển chức năng khi ấn dấu + bên trong các Tab ở Workspace thì sẽ mở màn hình Beads (Quản lý bead như hiện tại) và Metric (Xem các màn hình Metric như hiện tại). Lưu ý cần hỗ trợ xem được cả trên Mobile lẫn Desktop
> 2. Đổi lại UX, Màn hình chính của Bead Manager sẽ không thể hiện như hiện tại nữa, mà hãy thể hiện luôn phần config cho Bead Manager
> 3. Phần danh sách beads và hiển thị cần thể hiện màu cả dòng cho dễ nhận diện cái nào chưa làm, cái nào đã đóng, cái nào block để người dùng nhìn nhanh được. Tên của bead cũng không cần viết Bold, nhìn khả mỏi mắt

### 1.1 Quyết định của owner (2026-09-18, vòng hỏi đầu)

Owner trả lời bằng khối `BM-ANSWERS`: Q1 a, Q2 c, Q3 a. Các mã này thuộc request `req-20260918T043115Z`, không phải Q1–Q3 của request khác.

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q1 | Màn chính Beads Manager | **(a)** Màn chính là Setup (công cụ beads, agent skills, chỉ dẫn thêm từng vai), không còn nút ←. Danh sách workspace thành màn phụ, mở bằng nút "Workspaces" trên đầu. Màn phụ giữ đủ ghim, chấm đang chạy, Go to Manager và lịch sử workspace đã đóng, nên không mất gì |
| Q2 | Mục trong menu "+" | **(c)** Một mục **"Beads"** duy nhất trong "+". Bên trong có hai tab con **Beads** và **Metric** |
| Q3 | Màu cả dòng trong danh sách beads | **(a)** Nền cả dòng tô nhạt, kèm vạch màu bên trái: chưa làm = accent, đang làm = vàng, block = đỏ, đã đóng = xanh lá và chữ mờ hơn. Chip trạng thái đổi theo cùng màu ở mọi chỗ hiện bead (màn Beads và panel "Beads in this chat"). Tên bead bỏ in đậm |

### 1.2 Quyết định sau `reviewing-plan` (2026-09-18)

Owner trả lời bằng khối `BM-ANSWERS`: Q4 a, Q5 a, Q6 a. Đây là các điểm Worker thêm ngoài lời owner.

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q4 | Màu dòng và bỏ đậm ra ngoài màn Beads | **(a)** Màn Beads (cả trong tab "Beads") và panel "Beads in this chat" đều có màu cả dòng. Tên không đậm ở hai danh sách đó và ở khung chi tiết mở từ chip trong thẻ chat; khung chi tiết không tô |
| Q5 | Phần đầu màn trong tab "Beads" | **(a)** Chỉ hàng tab con Beads / Metric và nút Refresh; không tiêu đề, không tên workspace |
| Q6 | Chi tiết nhỏ Worker tự chọn | **(a)** Đồng ý tất cả: "Beads" đứng trước "Beads agents" trong "+"; dòng phiên bản ở cuối màn chính; nền tô mờ 12% + vạch trái 4 px; dải thông báo hiện ở cả màn chính và màn Workspaces |

### 1.3 Xác nhận trước khi implement (2026-09-18)

Owner trả lời "Q7 a": bắt đầu implement, từng bead theo thứ tự `.1`, `.2`, `.3`, `.4`; không commit; không reload plugin trên daemon của owner; review implementation ở batch `b3`.

### 1.4 Batch `b4` — điều chỉnh sau khi xong (2026-09-18)

Owner xem bản đã xong rồi yêu cầu:

> 1. Màu của Beads không nên đổi màu cả dòng, hãy chỉ màu của Title thôi cho dễ nhìn 2. Có icon show-hide để ẩn và hiển thị tất cả Beads đã Đóng 3. Hãy có thêm dòng tách hẳn ra về danh sách Bead Block và Danh sách Beads đang làm (hiển thị đang làm trên đầu tiên) 4. Thống kê nhanh Đã làm bao nhiêu / Tổng số bao nhiêu Bead 5. Bỏ create closed 14 days đi

Owner trả lời bằng khối `BM-ANSWERS`: Q8 a, Q9 a, Q10 a, Q11 a, Q12 a. Mục 5 rõ nên không cần hỏi.

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q8 | Chỉ tô màu tên bead | **(a)** Bỏ nền tô và vạch trái. Chỉ tên bead mang màu trạng thái (chưa làm = accent, đang làm = vàng, block = đỏ, đã đóng = xanh lá), ở cả màn Beads và panel "Beads in this chat". Chip vẫn cùng màu. Thay cho Q3 phần "màu cả dòng" |
| Q9 | Nút ẩn/hiện bead đã đóng | **(a)** Nút biểu tượng mắt ở đầu danh sách, kèm số lượng ("Closed 25"). Mặc định **ẩn** bead đã đóng. Nhớ trong phiên app; tải lại app thì về ẩn |
| Q10 | Tách nhóm trong danh sách | **(a)** Bốn nhóm, mỗi nhóm có dòng tiêu đề riêng kèm số lượng: Đang làm → Block → Chưa làm → Đã đóng. Trong nhóm giữ cách sắp đang chọn, bộ lọc vẫn áp, nhóm rỗng không hiện |
| Q11 | Thống kê nhanh "đã làm / tổng" | **(a)** Ở dòng đầu màn, cạnh Refresh: `✓ 12 / 40 done`. Đếm bead đã đóng trên tổng bead của workspace, không đếm epic (như thẻ Progress), không đổi theo bộ lọc |
| Q12 | Ghi tài liệu | **(a)** Ghi tiếp vào tài liệu delta này (sửa REQ-060 (g), thêm (j)–(m), một mục thiết kế, WP-264), rồi áp lại dòng REQ-060 ở PRD Dashboard. Một review `b4` cho cả tài liệu, bead và code |

### 1.5 Batch `b5` (2026-09-18)

Sau batch `b4`, Worker gợi ý hai việc chưa làm. Owner trả lời:

> 1. Bỏ tính activity 14 ngày đi
> 2. Đồng ý đổi màu
> 3. Sao chưa thấy giao diện mới ?

| # | Owner chốt |
|---|---|
| 1 | Bỏ luôn phần tính dữ liệu "tạo/đóng 14 ngày" (`activity`) của `beadsOverview`, vì màn Beads không còn hiện nó. Thêm vào ý (m) |
| 2 | Các con số trên dòng workspace của danh sách Workspaces dùng cùng màu với bead: số đang làm màu vàng, số block màu đỏ. Thêm ý (n); bỏ dòng tương ứng ở §7 |
| 3 | Câu hỏi, không phải yêu cầu. Daemon chạy bản plugin **đã cài** trong install home, nên thay đổi trong repo chỉ hiện sau khi cài lại bản mới. Việc cài lên daemon của owner cần owner đồng ý (hỏi ở cuối batch) |
| Q13 | Owner chọn **(b)**: cài ngay, dù bản cài mang cả phần chưa review của Worker `req-20260918T041426Z`. Worker chạy `node dist/index.js install --apply --yes` lúc 13:28 ngày 2026-09-18, khi không agent bm nào khác đang chạy: 11 file sửa, 3 file mới, plugin nạp lại, trạng thái `running` |

### 1.6 Batch `b6` — mobile không có "+" (2026-09-19)

Owner gửi ảnh điện thoại và viết:

> Đối với bản Mobile tôi không thấy + có menu Beads hãy kiểm tra và fix

Ảnh là sheet "Workspace actions" mở từ nút "…" của workspace, gồm New agent, Copy workspace path, Copy branch name, Import session, Terminal profiles. Không có "Beads".

Worker đọc lại bundle của Paseo.app 0.8.0 và thấy ba điều:

- app mobile **không có nút "+"** để mở tab mới: thanh tab của mobile chỉ liệt kê các tab đã mở;
- sheet "…" có danh sách mục **cố định**, plugin không thêm vào được;
- màn "New tab" có liệt kê panel của plugin, nhưng mobile không có đường nào mở tới màn đó.

Vì vậy câu "mục có trong màn New tab của mobile" ở ý (a) và ở thiết kế F2 là **sai** với mobile. Plugin vẫn tới được mobile bằng một nút trên header của workspace: header mobile có vẽ nút của plugin, và nút đó mở được panel.

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q14 | Lối mở tab Beads trên mobile | **(a)** Nút "Beads" (biểu tượng danh sách) trên header của mỗi workspace, bấm mở tab Beads (hai tab con Beads / Metric). Trên mobile nút nằm ngay trên header cạnh "…"; trên desktop cũng hiện ở header phải, thành một lối nhanh cạnh "+". Plugin tự gắn nút cho từng workspace đang mở |
| Q15 | Cài nút lên daemon | **(a)** Cài ngay. Worker chạy `node dist/index.js install --apply --yes` lúc 11:34 ngày 2026-09-19, khi không agent bm nào khác đang chạy: tạo `client/beads-header-button.ts`, sửa `index.client.tsx`, plugin nạp lại, trạng thái `running` |

### 1.7 Batch `b7` — nút header bị cài đè (2026-09-21)

Owner báo sau khi cài phiên bản paseo-bm mới, điện thoại không còn nút "Beads" trên header. Ảnh chụp: header chỉ có "…" và nút mở panel bên.

Nguyên nhân: bản 0.2.0-alpha.0 đã phát hành được dựng từ commit `65ca95f`, trước khi có batch `b6`, rồi gói đó được cài đè lên daemon. `index.client.tsx` của gói không có dòng đăng ký nút header. Batch `b6` vẫn chưa được commit.

Owner trả lời "Ok, do what we should"; Worker hiểu là chọn hai đề xuất:

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q16 | Khôi phục nút ngay | **(a)** Cài lại từ repo như Q15. Lần cài gói npm 0.2.0-alpha.0 kế tiếp sẽ lại xoá nút, cho tới khi có bản phát hành chứa `b6` |
| Q17 | Đưa `b6` vào bản phát hành | **(a)** Worker commit riêng các file của `b6` lên nhánh mới `feat/beads-header-button` tách từ `main`, không push. Owner (hoặc request phát hành) merge và phát hành 0.2.0-alpha.1 theo quy trình GitHub prerelease |

## 2. Bối cảnh — vì sao bây giờ

- **Beads và Metric ở xa chỗ đang làm.** Hôm nay, muốn xem bead của workspace đang mở, người dùng phải:
  1. rời workspace, mở "Beads Manager" ở sidebar;
  2. tìm dòng của workspace;
  3. bấm "Beads" hoặc "Metric".

  Xem xong phải đi ngược lại, và chat đang làm không còn trên màn hình.
- **Paseo 0.8 đã có sẵn chỗ cho việc này.** Mọi panel workspace của plugin tự hiện trong menu "+" của thanh tab. Điều này đã kiểm trong bundle của Paseo.app 0.8.0 (chi tiết ở thiết kế §2):
  - trên desktop, mục nằm trong menu thả xuống của nút "+";
  - màn "New tab" của mobile dùng cùng danh mục đó.

  Panel "Beads agents" của paseo-bm đã nằm ở đó từ WP-113.
- **Setup bị giấu.** Công cụ `br`/`bv`, agent skills và chỉ dẫn thêm từng vai là những thứ owner chỉnh thường xuyên nhất ở Beads Manager, nhưng lại nằm sau một nút ⚙.
- **Danh sách bead khó quét bằng mắt.** Trạng thái chỉ hiện ở một chip nhỏ cuối dòng. Tên bead in đậm (cỡ 14/16, đậm 600) trên tới 200 dòng thì nặng mắt.

## 3. Tác nhân

| Tác nhân | Muốn gì | Khó ở đâu hôm nay |
|---|---|---|
| Owner trên desktop | Xem bead và số đo của workspace đang làm mà không rời nó | Phải rời workspace sang sidebar rồi quay lại |
| Owner trên điện thoại | Như trên, trên màn hẹp | Như trên; màn "Beads Manager" dài, nhiều nút trên mỗi dòng |
| Owner cấu hình Beads Manager | Mở ra là thấy công cụ, skill, chỉ dẫn | Phải bấm ⚙ mỗi lần |

## 4. Mục tiêu và bằng chứng thành công

1. **Mở Beads của workspace đang làm trong 2 thao tác từ thanh tab**: bấm "+", chọn "Beads". Metric thêm **1** thao tác: bấm tab con "Metric". Đúng trên cả desktop và mobile.
   *Bằng chứng:*
   - test: plugin đăng ký đúng một panel workspace mới tên "Beads";
   - owner kiểm trên daemon thật, trên máy tính và trên điện thoại.
2. **Mở "Beads Manager" là thấy Setup ngay**: 0 thao tác thêm, hôm nay là 1 (bấm ⚙). Mọi chức năng của danh sách workspace còn nguyên, cách **1** thao tác (nút "Workspaces").
   *Bằng chứng:* test cho màn mặc định và đường quay lại; owner kiểm.
3. **Nhìn màu là biết trạng thái** (sửa ở batch `b4`, Q8). Bốn trạng thái có bốn màu khác nhau trên **tên** bead. Chip và tên của cùng một bead luôn cùng màu. Tên bead không in đậm.
   *Bằng chứng:* test ánh xạ trạng thái → màu, và test bất biến "chip cùng màu với tên" cho cả bốn trạng thái; owner kiểm ở theme của mình.
4. **Không làm hỏng cái đang chạy.** Không lối vào nào biến mất:
   - hai mục Command Center;
   - hai slash command;
   - panel "Beads agents" và panel "Beads in this chat";
   - ghim, chấm đang chạy, lịch sử workspace đã đóng.

   *Bằng chứng:* test đăng ký của client entry; `npm run verify` mã 0.
5. **Danh sách tập trung vào việc còn lại** (batch `b4`, Q9–Q11):
   - bead đang làm nằm trên cùng, bead block ngay sau, mỗi nhóm có dòng tách riêng;
   - bead đã đóng ẩn mặc định, hiện lại bằng **1** thao tác;
   - số `đã làm / tổng` thấy ngay ở dòng đầu màn, không cần cuộn.

   *Bằng chứng:* test thứ tự nhóm, nhóm rỗng, ẩn/hiện, và số đếm; owner kiểm.

## 5. Yêu cầu

| ID | Tên | Ưu tiên | Tiêu chí chấp nhận |
|---|---|---|---|
| REQ-060 | Tab "Beads" trong menu "+", Setup là màn chính, màu trạng thái cho bead, danh sách theo nhóm | P2 | Xem các ý (a)–(o) ngay dưới bảng. (g), (h) sửa và (j)–(m) thêm ở batch `b4`; (m) mở rộng và (n) thêm ở batch `b5`; (a) errata và (o) thêm ở batch `b6` |

**Các ý của REQ-060:**

- **(a) Mục "Beads" trong menu "+".**
  - Menu "+" của thanh tab workspace có đúng **một** mục mới tên "Beads", trong nhóm mục của plugin, cạnh "Beads agents".
  - Chọn mục đó thì mở một tab của **chính workspace đang mở**.
  - Mục có trong menu "+" của desktop. *Errata batch `b6`:* app mobile của Paseo 0.8 không có "+" (§1.6), nên trên mobile lối vào là nút header ở ý (o).
- **(b) Hai tab con.**
  - Tab "Beads" có hai tab con "Beads" và "Metric". Mở ra là tab con "Beads".
  - Chuyển tab con không rời tab và không mở màn nào khác.
  - Nội dung tab con là màn Beads và màn Metric **hiện có** của workspace đó: cùng số liệu, bộ lọc, hành động, và cùng đường tới Beads Manager.
  - Trong tab không có nút ← và không lặp lại tên workspace.
- **(c) Xem được trên mobile và desktop.**
  - Ở bố cục hẹp (`layout.compact` của Paseo), không nút hay chữ nào bị cắt mất chức năng, và toàn bộ nội dung cuộn dọc được.
  - Hai tab con là nút đủ lớn để chạm. Trình đọc màn hình đọc chúng là tab, kèm trạng thái đang chọn.
- **(d) Setup là màn chính.**
  - Mở surface "Beads Manager" (sidebar hoặc Command Center) thì thấy Setup ngay, gồm công cụ beads, agent skills và chỉ dẫn thêm từng vai.
  - Tiêu đề là "Beads Manager", không có nút ←, dòng phiên bản `paseo-bm <version>` ở cuối.
- **(e) Danh sách workspace là màn phụ.**
  - Nút "Workspaces" ở đầu màn chính mở danh sách workspace **như hôm nay**: ghim và thứ tự, chấm đang chạy, số bead, Go to / Metric / Beads, lịch sử workspace đã đóng.
  - Nút ← của danh sách quay về màn chính.
  - Metric hay Beads mở từ danh sách có nút ← quay về danh sách.
- **(f) Không mất lối vào.**
  - "Open Beads Manager" và "Open Beads Metric" ở Command Center, `/bm-worker-new` và `/bm-worker-stop-all` chạy như hôm nay.
  - Thông báo mà `/bm-worker-stop-all` để lại hiện ở **màn chính**, nơi lệnh mở surface ra.
  - Trạng thái mở Manager (đang mở, lỗi, cảnh báo, host quá cũ) hiện ở màn chính và ở danh sách workspace.
- **(g) Màu ở tên bead** (sửa ở batch `b4`, Q8; bản trước tô cả dòng).
  - Trong danh sách của màn Beads và của panel "Beads in this chat", **chỉ tên** bead mang màu trạng thái:

    | Trạng thái | Màu của tên |
    |---|---|
    | chưa làm (ready) | accent |
    | đang làm (in progress) | vàng (warning) |
    | block | đỏ (danger) |
    | đã đóng | xanh lá (success) |

  - Dòng không có nền tô, không có vạch màu bên trái.
  - Mọi màu lấy từ theme của Paseo, nên đúng ở cả theme sáng và tối.
- **(h) Chip cùng màu với tên.**
  - Chip trạng thái của một bead dùng đúng màu của tên bead đó ở mọi chỗ hiện bead: màn Beads, panel "Beads in this chat", và chip bead trong thẻ chat.
  - Chữ của chip giữ nguyên (Ready / In progress / Blocked / Closed), nên màu không phải dấu hiệu duy nhất.
- **(i) Tên không in đậm.** Tên bead ở các danh sách trên, và ở khung chi tiết mở từ chip bead trong thẻ chat, không in đậm.
- **(j) Ẩn/hiện bead đã đóng** (batch `b4`, Q9).
  - Ở đầu danh sách của màn Beads có một nút biểu tượng mắt, kèm số bead đã đóng khớp bộ lọc hiện tại (ví dụ "Closed 25").
  - Mặc định bead đã đóng bị **ẩn**. Bấm nút thì hiện, bấm lần nữa thì ẩn.
  - Lựa chọn được nhớ trong phiên app, kể cả khi rời màn rồi quay lại. Tải lại app thì về ẩn.
  - Trình đọc màn hình đọc được nút làm gì và có bao nhiêu bead đã đóng.
  - Mọi bead khớp bộ lọc đều đã đóng mà đang ẩn → danh sách nói rõ điều đó, không để trống không lời.
- **(k) Bốn nhóm trong danh sách** (batch `b4`, Q10).
  - Danh sách của màn Beads chia thành bốn nhóm theo thứ tự: **In progress → Blocked → Ready → Closed** (đang làm → block → chưa làm → đã đóng).
  - Mỗi nhóm bắt đầu bằng một dòng tách hẳn: một vạch ngăn, rồi tên nhóm cùng số bead của nhóm.
  - Trong nhóm, bead sắp theo cách đang chọn (Updated / Created / Closed / Priority). Bộ lọc áp trước khi chia nhóm.
  - Nhóm không có bead nào thì không hiện. Nhóm Closed không hiện khi bead đã đóng đang ẩn (ý (j)).
  - Giới hạn 200 dòng giữ như hôm nay, tính theo thứ tự hiện của các nhóm.
- **(l) Thống kê nhanh** (batch `b4`, Q11).
  - Dòng đầu màn Beads, cạnh nút Refresh, hiện `✓ <đã đóng> / <tổng> done`.
  - Số đếm giống thẻ Progress: mọi bead của workspace trừ epic; không đổi theo bộ lọc, theo nút ẩn/hiện, hay theo nhóm.
  - Có ở cả trong tab "Beads" lẫn trên surface Beads Manager.
- **(m) Bỏ biểu đồ "Created / closed, last 14 days"** khỏi màn Beads (batch `b4`, mục 5 của owner). Các thẻ và biểu đồ khác của màn Beads giữ nguyên. Từ batch `b5`, phần tính dữ liệu cho biểu đồ đó cũng bị bỏ: tổng quan của màn Beads không còn tính số tạo/đóng theo ngày.
- **(n) Màu các con số trên dòng workspace** (batch `b5`). Trong danh sách Workspaces, số bead đang làm dùng màu vàng (warning) và số bead block dùng màu đỏ (danger) khi lớn hơn 0, cùng màu với tên bead ở ý (g). Số bằng 0 vẫn xám; tổng số bead và số Worker đang chạy giữ màu như cũ.
- **(o) Nút "Beads" trên header của workspace** (batch `b6`, Q14).
  - Header của mỗi workspace đang mở có một nút chỉ có biểu tượng (danh sách), tên đọc cho trình đọc màn hình và tooltip là "Open the Beads tab: beads and metrics of this workspace".
  - Bấm nút thì mở tab "Beads" của **chính workspace đó** (hai tab con như ý (b)). Mở tab mới hay đưa về tab đã có là do Paseo quyết định.
  - Trên mobile nút nằm ngay trên header; trên desktop nút ở header phải, cạnh các nút khác.
  - Workspace mới mở có nút chậm nhất sau 15 giây; workspace đã đóng hay đang lưu trữ thì nút biến mất.
  - Không đọc được danh sách workspace (mất kết nối) → các nút đang có giữ nguyên, không nháy.

## 6. Yêu cầu phi chức năng

- **Bảo mật:** không đổi. Không gọi mạng, không thêm RPC, không đọc hay in bí mật; panel mới chỉ gọi các RPC mà hai màn đang dùng.
- **Dữ liệu:** không thêm dữ liệu lưu bền. Tab con đang chọn chỉ sống trong tab đang mở. Lựa chọn ẩn/hiện bead đã đóng chỉ sống trong phiên app (Q9).
- **Hiệu năng:** danh sách vẫn tối đa 200 dòng như hôm nay. Chia nhóm chạy một lượt trên danh sách đã lọc. Chuyển tab con không gọi lại dữ liệu đã có trong bộ nhớ đệm của phiên.
- **Sẵn sàng:** lỗi tải dữ liệu trong tab hiện như ở hai màn hôm nay (một dòng chữ đỏ, nút Refresh), không làm trắng tab.
- **Khả năng tiếp cận:** như ý (c) và (h).

## 7. Ngoài phạm vi

- Đổi đích của mục Command Center "Open Beads Metric" (Q2 chọn (c), không phải (a)): nó vẫn mở Metric trên surface Beads Manager.
- Bỏ nút Metric / Beads trên từng dòng của danh sách workspace (Q1 (a) giữ nguyên danh sách).
- Đưa màn cài đặt "Beads Dashboard" (ngưỡng cảnh báo kho vết, trong Settings của Paseo) vào màn chính.
- Mục "+" cho workspace đã đóng: menu "+" chỉ có trong workspace đang mở. Lịch sử của workspace đã đóng vẫn xem ở danh sách workspace (ý (e)).
- Giữ tab con đang chọn, hay lựa chọn ẩn/hiện bead đã đóng, qua lần tải lại app (Q9); cử chỉ kéo-thả trên danh sách workspace.
- Chia nhóm hay nút ẩn/hiện trong panel "Beads in this chat": panel đó chỉ đổi màu tên (Q8).
- Nâng phiên bản gói, phát hành, commit.

## 8. Ranh giới và phụ thuộc

- **Phụ thuộc Paseo 0.8:**
  - `addWorkspacePanel` với `context: "workspace"`;
  - danh mục tab mới (`useWorkspaceTabLaunchCatalog`) liệt kê panel của plugin cho cả menu "+" và màn "New tab".

  Cả hai đã đọc trong bundle web của Paseo.app 0.8.0. App gốc iOS/Android **chưa** được đọc trực tiếp; lần kiểm của owner trên điện thoại là bằng chứng cho phần đó.
- **Không sở hữu:**
  - thanh tab, menu "+" và màn "New tab" (của Paseo);
  - bảng màu của theme (của Paseo);
  - nội dung màn Beads, màn Metric và màn Setup (không đổi, trừ phần đầu màn, dòng bead và chip nêu ở trên).

## 9. Lộ trình

| Phase | Phạm vi | Điều kiện ra |
|---|---|---|
| Phase 2a-9 MVP (đợt này) | REQ-060 (a)–(o) | `npm run verify` mã 0. Owner tự kiểm trên daemon thật, trên máy tính và điện thoại: mục "Beads" trong "+", hai tab con, màn chính là Setup, nút "Workspaces", thông báo của `/bm-worker-stop-all` ở màn chính và dải trạng thái ở danh sách workspace; màu tên và chip; bốn nhóm, nút ẩn/hiện bead đã đóng, số `đã làm / tổng`, không còn biểu đồ 14 ngày; số đang làm và số block trên dòng workspace có màu vàng và đỏ; trên điện thoại, nút "Beads" trên header workspace mở tab Beads. Delta được áp vào PRD Dashboard (dòng REQ-060) |

## 10. Câu hỏi mở

| ID | Câu hỏi | Owner | Trạng thái |
|---|---|---|---|
| Q1–Q3 | Ba câu vòng hỏi đầu | hieu.nt10 | **answered (2026-09-18)** — §1.1 |
| Q4–Q6 | Các điểm Worker thêm, hỏi sau `reviewing-plan` | hieu.nt10 | **answered (2026-09-18)** — §1.2 |
| Q7 | Bắt đầu implement | hieu.nt10 | **answered (2026-09-18)** — §1.3 |
| Q8–Q12 | Batch `b4`: màu tên, ẩn/hiện bead đã đóng, nhóm, thống kê nhanh, cách ghi tài liệu | hieu.nt10 | **answered (2026-09-18)** — §1.4 |
| — | Batch `b5`: bỏ phần tính 14 ngày, màu các con số trên dòng workspace | hieu.nt10 | **answered (2026-09-18)** — §1.5 |
| Q13 | Cài bản mới lên daemon thế nào | hieu.nt10 | **answered (2026-09-18)** — §1.5 |
| Q14 | Lối mở tab Beads trên mobile | hieu.nt10 | **answered (2026-09-19)** — §1.6 |
| Q15 | Cài nút lên daemon | hieu.nt10 | **answered (2026-09-19)** — §1.6 |
| Q16–Q17 | Khôi phục nút và đưa `b6` vào bản phát hành | hieu.nt10 | **answered (2026-09-21)** — §1.7 |

## 11. Revision History

| Ngày | Người | Thay đổi |
|---|---|---|
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b7` (§1.7): nút header bị bản phát hành 0.2.0-alpha.0 cài đè; quyết định Q16–Q17 |
| 2026-09-19 | hieu.nt10 (soạn bởi Beads Worker) | Ghi quyết định Q15 và lần cài lên daemon lúc 11:34 (§1.6) |
| 2026-09-19 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b6` (§1.6, Q14): errata cho (a) — app mobile của Paseo 0.8 không có "+"; thêm (o) nút "Beads" trên header của workspace; §9 cập nhật. Status giữ Accepted, Applied; dòng REQ-060 của PRD Dashboard được áp lại ở WP-266 |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Errata theo delta 20260918f §4.12: dòng Errata dưới tiêu đề ("màu cả dòng" đã thay ở `b4`). Không đổi yêu cầu |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Ghi quyết định Q13 (cài ngay) và lần cài lên daemon lúc 13:28 (§1.5) |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b5` (§1.5): (m) mở rộng — bỏ luôn phần tính dữ liệu 14 ngày; thêm (n) màu các con số trên dòng workspace; bỏ dòng tương ứng ở §7; §9 cập nhật. Status giữ Accepted, Applied; dòng REQ-060 của PRD Dashboard được áp lại ở WP-265 |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b4` theo yêu cầu owner sau khi xong (Q8–Q12, §1.4): (g) màu ở tên thay cho cả dòng; (h) chip cùng màu với tên; thêm (j) ẩn/hiện bead đã đóng, (k) bốn nhóm, (l) thống kê nhanh, (m) bỏ biểu đồ 14 ngày; mục tiêu 3 sửa, thêm mục tiêu 5; §6, §7, §9 cập nhật. Status giữ Accepted, Applied; dòng REQ-060 của PRD Dashboard được áp lại ở WP-264 |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Áp vào PRD Dashboard (dòng REQ-060 và một dòng revision); Status → Accepted, Applied |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Owner xác nhận trước khi implement (Q7, §1.3); Status → Accepted |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | `prd-ready` PASS sau review b1; Status giữ Review tới khi owner xác nhận |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Review b1: điều kiện ra của phase thêm mục kiểm dải trạng thái ở cả hai màn; không đổi REQ-060 |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Quyết định Q4–Q6 (§1.2); không đổi REQ-060 |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Tạo delta: REQ-060 (a)–(i), quyết định Q1–Q3, Routing Decision |
