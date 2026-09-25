# Delta-change — Dự phòng khi hết hạn mức cho mọi vai trò, cấu hình vai trò trong Beads Manager, mọi provider cho mọi vai trò

| Trường | Giá trị |
|---|---|
| Mã | `prd-delta-20260921-worker-fallback-and-role-settings` |
| Tài liệu gốc | [paseo-bm PRD](../../product/paseo-bm-prd.md): REQ-020(b), REQ-026(c), REQ-027(d), REQ-028, REQ-031, NFR **Quyền** và **Riêng tư**, §8, §9. **Không sửa tại chỗ khi chưa duyệt** |
| Status | Merged — gộp vào [paseo-bm-prd.md](../../product/paseo-bm-prd.md) ngày 2026-09-25; chỉ còn là hồ sơ lịch sử |
| Owner | hieu.nt10 |
| Created | 2026-09-21 |
| Request | `req-20260921T111242Z` |
| Nguồn | [Đề xuất 20260921](../design/paseo-bm-proposal-20260921-worker-fallback-and-role-settings.md) (`req-20260921T082908Z`): sự thật đã kiểm ở §1, phương án ở §2–§5 |
| Thiết kế | [design-delta-20260921-worker-fallback-and-role-settings](../design/paseo-bm-delta-20260921-worker-fallback-and-role-settings.md) |
| ADR | [ADR-008](../../adr/ADR-008-role-settings-written-by-plugin.md): plugin ghi cấu hình vai trò qua `config.patch`, có alias dự phòng cho cả ba vai trò. Sửa đổi ADR-004 QĐ1 và ADR-006 QĐ1/QĐ5 |
| Plan | [plan-delta-20260921-worker-fallback-and-role-settings](../plans/paseo-bm-implementation-plan-delta-20260921-worker-fallback-and-role-settings.md) |

## 0. Routing Decision

- Variant preset: brownfield
- Triggered risks:
  - **hợp đồng công khai**: ý nghĩa của `install.json` `roles[]`; RPC mới của plugin; alias mới trong `config.json`.
  - **dữ liệu lưu bền**: plugin ghi `~/.paseo/config.json` qua daemon; hai file mới của paseo-bm; trình cài gộp thay vì thay nguyên.
  - **quyền**: Reviewer trên provider không có mode; OpenCode tự duyệt; một lời gọi mạng mới do daemon thực hiện.
  - **nhiều thành phần độc lập**: CLI, plugin server, plugin client, ba file vai trò.
  - **phát hành theo pha**: sáu phase, mỗi phase một bản prerelease.
- Required artifacts/gates: PRD delta này (duyệt ở §9); design delta + `design-ready`; ADR-008; plan delta + `plan-ready-for-beads`. Beads và `feature-done` thuộc request sau (Q5 a).
- Execution path: plan → converter, ở một request sau.
- Exceptions: none
- Decided: 2026-09-21 — Beads Worker, cỡ **Large** (Manager đoán, Worker xác nhận)
- Supersedes: none. Routing Decision của đề xuất 20260921 chỉ áp cho tài liệu phân tích đó

## 1. Owner nói gì

> Nếu các tài liệu đã xong thì hãy thực hiện viết tài liệu implementation

Yêu cầu gốc của owner (đề xuất 20260921, "Owner nói gì"): Worker có dự phòng khi gặp giới hạn dùng hay lỗi gói đăng ký; chọn model và mức thinking cho Worker trong Beads Manager; hỗ trợ thêm OpenCode và Pi ngoài Claude Code và Codex; cấu hình lại vai trò trong Beads Manager sau khi đã cài.

### 1.1 Quyết định của owner (2026-09-21, vòng hỏi đầu của `req-20260921T111242Z`)

| # | Câu hỏi | Owner chốt | Quyết định đề xuất tương ứng |
|---|---|---|---|
| Q1 | Phạm vi và thứ tự | **a**: cả năm bước của đề xuất §5.1, mỗi bước một phase. Bước 5 chỉ mở khi đã ghi được một sự cố thật | D1 a |
| Q2 | Cơ chế dự phòng và `listUsage` | **a**: plugin phát hiện rồi hiện thẻ "Hỏi tôi" có nút "chờ reset". Chỉ gọi `listUsage` **sau khi** đã phát hiện lỗi, để lấy giờ reset. Chế độ tự động để bước 5 | D2 a, D3 a |
| Q3 | Nơi lưu cấu hình vai trò | **a**: R1. Cấu hình nằm trong config Paseo, plugin ghi qua `config.patch`; chuỗi dự phòng nằm trong file riêng. Viết ADR-008; ADR-004/006 chỉ thêm một dòng "Sửa đổi bởi ADR-008". Owner chấp nhận rủi ro còn lại: ghi `agentProfiles` là thay cả mảng, nên chỉ thu hẹp và báo được việc ghi đè | D4 a |
| Q4 | OpenCode và Pi cho vai trò nào | **other**: *"Người dùng quyết định, Model là ngang hàng cho mọi Agent, ko phân biệt"* | Thay D5–D7 (§1.2) |
| Q5 | Request này dừng ở đâu | **a**: chỉ tài liệu (PRD delta, design delta, ADR-008, plan delta) qua `reviewing-plan`, review lô b1 và cổng `plan-ready-for-beads`. Không bead, không mã | — |

Vòng hỏi thứ hai (sau `reviewing-plan`, 2026-09-21):

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q6 | Nút "Chờ tới giờ reset" cần hẹn giờ trong plugin, trái thiết kế gốc §8 "không tác vụ nền" | **a**: ngoại lệ hẹp — mỗi lần bấm "Chờ" đúng một hẹn giờ, ghi ra file, đặt lại khi plugin nạp, huỷ khi sự cố đổi trạng thái |
| Q7 | Rủi ro Reviewer trên Pi (không lớp duyệt quyền) và trên OpenCode (quyền của agent OpenCode được chọn) | **a**: chấp nhận, cho lưu kèm cảnh báo; Reviewer OpenCode luôn **tắt** tự duyệt, có thể dừng chờ người dùng duyệt quyền trong Paseo |
| Q8 | "Không phân biệt" có áp cho chuỗi dự phòng không | **c**: cả ba vai trò. Dự phòng Manager nghĩa là thay chính agent người dùng đang chat; Manager và Reviewer ở một phase riêng (2a-17) |

### 1.2 Cách hiểu Q4

- **Mọi provider Paseo đang `available` chọn được cho mọi vai trò** (Manager, Worker, Reviewer), gồm Claude, Codex, OpenCode, Pi và provider sau này. Không vai trò nào bị cấm provider nào. Đây tương đương D5 c (OpenCode cho cả Manager), D6 b mở rộng (Pi cho cả ba vai trò), và D7 a (Reviewer OpenCode lưu được khi không có agent chỉ đọc).
- **Khác nhau về khả năng thì màn hình cảnh báo, không chặn.** Ví dụ: Pi cần `pi-mcp-adapter` mới có công cụ Paseo; Pi không hỏi quyền khi chạy công cụ.
- **Lan can an toàn không đổi**: Reviewer không bao giờ chạy mode `dangerous` hay `planning`, và plugin không bao giờ tự bật cơ chế tự duyệt cho Reviewer. Q4 nói về *chọn model*, không nói về quyền. Owner chấp nhận rủi ro còn lại khi chọn Pi hay OpenCode cho Reviewer (Q7 a).
- **"Không phân biệt" cũng áp cho chuỗi dự phòng** (Q8 c): Manager, Worker và Reviewer mỗi vai trò có chuỗi riêng.

## 2. Vì sao

- **Agent hết hạn mức thì việc đứng.** Plugin bỏ qua mọi lượt `failed` (đề xuất M9). Hai vai trò cùng provider gốc thì hết hạn mức cùng lúc (M14, M17). Manager hỏng thì người dùng mất luôn chỗ để hỏi.
- **Chọn thinking cho Worker đã có chỗ trong Paseo, nhưng không tới được Worker.**
  - Thinking đặt trên profile `bm-worker` không được áp khi Manager tạo Worker (M8).
  - Mỗi lần cài lại thì bị xoá (M3).
- **OpenCode và Pi đã có trong Paseo 0.8, nhưng không chạy được với paseo-bm.**
  - Plugin chọn mode theo `colorTier`, mà OpenCode không có `colorTier` còn Pi không có mode nào (M6).
  - Reviewer trên hai provider này bị daemon từ chối tạo (M7).
- **REQ-028 (đổi cấu hình sau khi cài) chưa có đường nào trong sản phẩm.** Người dùng chỉ có `install --reconfigure`, và phải chạy nó trong terminal.

## 3. Requirement mới

Priority theo PRD gốc §6: **P2** = phase sau Phase 1 MVP.

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| REQ-062 | Tôn trọng cấu hình người dùng đặt trên vai trò | P2 | (a) Khi Manager tạo Worker hay Worker tạo Reviewer, agent con nhận **mức thinking** và **feature** đặt trên profile `bm-worker` / `bm-reviewer`. Điều kiện: bên tạo không tự truyền giá trị đó, và model của agent con trùng model của profile (hoặc bên tạo không nêu model). (b) Luật an toàn của Reviewer thắng giá trị trên profile: không mode `dangerous` hay `planning`, không tự duyệt (REQ-063 b). (c) Cài lại hay cập nhật **không xoá** giá trị người dùng đặt trên mục `bm-*`, kể cả khi đặt qua Settings → Agent profiles của Paseo: trình cài chỉ thêm khoá còn thiếu. `--role` / `--reconfigure` chỉ đổi provider gốc, model và tên hiển thị, và chỉ của vai trò được nêu. (d) `doctor` hiện một dòng **thông tin**, không phải lỗi, khi provider gốc hay model đang có khác bản ghi cài đặt. (e) Cài lại không xoá alias dự phòng `bm-worker-fallback-*` (REQ-065). Gỡ cài đặt xoá chúng như mọi mục `bm-*` |
| REQ-063 | Mọi provider cho mọi vai trò | P2 | (a) Người dùng chọn được mọi provider Paseo đang `available` cho Manager, Worker và Reviewer: lúc cài (REQ-027) và trên màn cấu hình (REQ-064). Không vai trò nào bị cấm provider nào (Q4). (b) Plugin chọn cách chạy theo **khả năng** của provider, không theo tên. **Provider có mode phân tầng** (Claude, Codex): như hôm nay. **Provider có mode không phân tầng kèm feature tự duyệt** (OpenCode): Manager và Worker bật tự duyệt, **Reviewer không bao giờ bật**; mode là agent OpenCode người dùng chọn trên profile, không chọn thì agent đầu tiên Paseo liệt kê. **Provider không có mode** (Pi): không truyền mode. (c) Không agent nào bị tạo hỏng vì paseo-bm nêu một mode provider không có. Khi provider không có mode, chỉ dẫn của bên tạo nói rõ "không truyền mode". (d) Một Manager hay Worker vừa tạo mà **không có công cụ Paseo** (ví dụ Pi thiếu `pi-mcp-adapter`) thì người dùng được báo trước khi lượt đầu của agent đó kết thúc: thông báo trong chat Manager (hoặc trên màn Manager nếu chính Manager thiếu), và một dòng trên màn Setup. (e) Màn Setup có thêm cột skill cho **Pi** và **OpenCode**, chỉ đọc. (f) Trình cài không có lệnh đăng nhập nào cho Pi: nó in hướng dẫn thay vì chạy lệnh. (g) Model không có trong bảng giá sẵn có mà Paseo cung cấp `metadata.cost` thì được định giá theo đó: trên Dashboard, thẻ dự phòng và màn cấu hình. Không có cả hai thì chỉ hiện token như hôm nay. (h) Khi lưu cấu hình, màn hình cảnh báo nhưng không chặn ba trường hợp: Pi cho Manager hay Worker ("cần `pi-mcp-adapter`"); Reviewer trên Pi ("Pi không hỏi quyền khi chạy công cụ; luật chỉ-đọc chỉ còn trong chỉ dẫn"); Reviewer trên OpenCode chưa chọn agent ("Reviewer chạy với quyền OpenCode của bạn; paseo-bm không tự duyệt thay") |
| REQ-064 | Màn "Roles & models" trong Beads Manager | P2 | (a) Trong Beads Manager → Setup, người dùng xem và đổi **provider gốc, model, mức thinking và mode** của cả ba vai trò, không cần terminal hay cài lại. Đáp ứng REQ-028 cho người dùng app. (b) Chỉ chọn được giá trị Paseo liệt kê: provider đang `available`, model của provider đó, thinking của model đó, mode của provider đó. (c) Lưu thẳng vào cấu hình Paseo (profile và alias `bm-*`), nên Settings → Agent profiles của Paseo luôn hiện đúng giá trị đó (ADR-008). (d) Thay đổi áp cho agent **tạo sau khi lưu**. Agent đang chạy giữ model và thinking cũ, và màn hình nói rõ điều đó. Manager và Worker đang sống được báo mode mới của agent con, để lần tạo kế tiếp không bị Paseo từ chối. (e) Kiểm khi lưu: mọi giá trị có thật; Reviewer không mode `dangerous` hay `planning`. Khi Manager và Worker cùng provider gốc thì cảnh báo, không chặn: "Worker hết hạn mức thì Manager cũng dừng". (f) Cấu hình đã đổi ở nơi khác kể từ lúc mở màn hình → **không ghi**, báo "mở lại". Sau khi ghi, plugin kiểm chính mục `bm-*` vừa ghi đã vào đúng; không khớp → báo lỗi. Một thay đổi rơi đúng vào khoảng giữa lần đọc và lần ghi vẫn có thể bị đè mà không báo được (owner chấp nhận, Q15 a). Không tự ghi lại. (g) Không đọc, hiện hay lưu credential |
| REQ-065 | Worker dự phòng — chế độ "Hỏi tôi" | P2 | (a) **Loại lỗi dự phòng.** Lượt Worker kết thúc vì hết cửa sổ dùng của gói (L1), hết credit hay gói hết hạn (L2), đăng nhập hết hạn (L4), hoặc provider không chạy được (L5): plugin nhận ra ngay khi lượt đó kết thúc. Nhận ra bằng lượt `failed`, hoặc bằng lượt `completed` không có `BM-REPORT` mà tin cuối khớp mẫu hạn mức. (b) **Loại lỗi không dự phòng.** Rate limit tạm thời (L3), mọi lỗi khác (L6), lượt bị huỷ: không dự phòng. Phân loại không chắc thì coi là L6. (c) **Thẻ.** Chat Manager hiện một thẻ, pill "đang chờ" đếm nó. Thẻ nêu: loại lỗi; nguyên văn thông báo, cắt ngắn; giờ reset nếu biết; ứng viên kế tiếp kèm chi phí nếu có. Ba nút: **Chuyển sang <ứng viên>**, **Chờ tới <giờ reset> rồi làm tiếp** (chỉ khi biết giờ reset), **Để tôi tự xử lý**. (d) **Chuyển.** Plugin tạo Worker thay thế trên ứng viên, cùng request, với lời bàn giao **dựng bằng mã** từ dữ liệu đã lưu. Worker thay thế không làm lại bead đã đóng, không hoàn tác thay đổi đang có. Worker cũ bị đánh dấu "đã thay", thẻ và pill không còn trỏ tới nó. Reviewer đang chạy của Worker cũ nhận thông báo dừng. (e) **Chờ.** Tới giờ reset, plugin nhắn chính Worker cũ làm tiếp. Lời hẹn còn nguyên qua một lần nạp lại plugin hay khởi động lại daemon. (f) **Chuỗi dự phòng.** Tối đa 3 mục, khai trên màn REQ-064, mỗi mục là provider gốc + model + thinking + mode. Chính sách: **Hỏi tôi** (mặc định) hoặc **Tắt** (như hôm nay). (g) **Lan can.** Mỗi Worker bị thay nhiều nhất một lần. Chuỗi chỉ đi tiến, không quay lại mục đã hỏng trong cùng request. Hết chuỗi thì thẻ nói rõ. Lỗi thuộc gói hay phiên đăng nhập (L1 cửa sổ chung, L2, L4) thì bỏ qua mục cùng provider gốc với Worker vừa hỏng. (h) Ngân sách review theo `requestId` không reset khi đổi Worker. (i) `providers.listUsage` chỉ được gọi **sau khi** đã nhận ra L1, chỉ cho Claude và Codex, tối đa một lần mỗi sự cố (Q2 a). (j) Mỗi sự cố được ghi lại: Worker cũ, lỗi, lựa chọn của người dùng, Worker mới. (k) Chỉ plugin tạo Worker dự phòng; Manager không tự tạo |
| REQ-066 | Dự phòng cho Reviewer và Manager — chế độ "Hỏi tôi" | P2 | (a) Reviewer và Manager có chuỗi dự phòng riêng (tối đa 3 mục mỗi vai trò, khai trên màn REQ-064), cùng loại lỗi, cùng thẻ, cùng ba nút và cùng lan can như REQ-065 (a)–(c), (e), (g), (i), (j). (b) **Reviewer.** Thẻ hiện trong chat Manager của Worker đã tạo Reviewer đó. Bấm **Chuyển** thì **Worker** tạo Reviewer thay thế trên ứng viên, theo chỉ dẫn chính xác plugin gửi, và gửi nó nguyên văn tin review đã gửi Reviewer cũ. Tin đó **không** bị tính là một lượt review mới. Trong lúc chờ người dùng, Worker không tự tạo Reviewer khác. (c) **Manager.** Thẻ hiện trong chính chat của Manager hỏng. Bấm **Chuyển** thì plugin tạo một Manager thay thế trong cùng workspace, với lời bàn giao **dựng bằng mã**: các Worker đang sống và báo cáo cuối của chúng, câu hỏi đang chờ, và ba tin gần nhất người dùng gõ cho Manager cũ (đã che bí mật). Mở Beads Manager từ sidebar hay Command Center thì mở Manager thay thế. Mọi Worker đang sống được báo id Manager mới, để báo cáo tới đúng chỗ. Manager cũ vẫn còn cho tới khi người dùng lưu trữ nó. (d) **Chờ** gửi lời nhắn làm tiếp cho chính Reviewer hay Manager cũ. (e) Alias dự phòng của Reviewer không bao giờ có công cụ Paseo (REQ-031 b). (f) Mỗi agent bị thay nhiều nhất một lần; chuỗi của Manager chỉ đi tiến trong một workspace, của Reviewer trong một request |
| REQ-067 | Dự phòng — chế độ "Tự động" | P2 | (a) Chính sách của **mỗi vai trò** thêm lựa chọn **Tự động**: plugin chuyển ngay sang ứng viên theo đúng luật của REQ-065 và REQ-066, không chờ bấm. Thẻ vẫn hiện, sau khi đã chuyển. Với Manager, màn hình cảnh báo rằng chat đang dùng có thể bị thay. (b) Nếu biết giờ reset và giờ đó còn không quá 30 phút, plugin chờ thay vì chuyển. (c) **Chỉ phát hành** khi đã ghi được ít nhất **một sự cố thật** (REQ-065 j), và bộ mẫu nhận dạng khớp đúng sự cố đó (Q1). (d) Không kiểm hạn mức **trước** khi tạo agent (đề xuất N4 — Q2 a không chọn) |

## 4. Các dòng sẽ đổi trong PRD gốc nếu được duyệt

Mỗi dòng được áp ở WP đóng phase ghi trong cột cuối (plan delta §3).

| # | Vị trí | Hiện tại | Đề xuất | Phase |
|---|---|---|---|---|
| 1 | REQ-027 ý (d) | `Cấu hình lưu trong thư mục cài đặt của paseo-bm; chạy lại không hỏi lại trừ khi người dùng yêu cầu cấu hình lại.` | `Cấu hình vai trò có hiệu lực nằm trong cấu hình Paseo (provider dẫn xuất và profile bm-*); hồ sơ cài đặt ghi lại lần ghi cuối của trình cài. Chạy lại không hỏi lại và không xoá thay đổi người dùng đã làm trên mục bm-*, trừ khi người dùng yêu cầu cấu hình lại (REQ-062).` | 2a-13 |
| 2 | Bảng requirement | — | Thêm REQ-062 | 2a-13 |
| 3 | REQ-026 ý (c), sau câu về Reviewer | `… Reviewer được tạo ở chế độ tự động không mở toàn quyền hay quyền mạng (Codex auto, Claude auto) …` | Giữ nguyên, thêm: `Trên provider có feature tự duyệt (OpenCode) Reviewer không bao giờ được bật tự duyệt và chạy với quyền của agent OpenCode người dùng chọn; trên provider không có mode (Pi) không có lớp duyệt quyền nào, nên luật chỉ đọc của Reviewer chỉ còn trong chỉ dẫn — owner chấp nhận ngày 2026-09-21 (Q7 a của req-20260921T111242Z). Người dùng chọn provider cho mọi vai trò (REQ-063).` | 2a-14 |
| 4 | NFR **Quyền**, câu "Rủi ro đã biết" | `… ranh giới an toàn của Manager và Worker chỉ còn nằm trong chỉ dẫn vai trò.` | `… ranh giới an toàn của Manager và Worker chỉ còn nằm trong chỉ dẫn vai trò; với Reviewer trên Pi, và trên OpenCode khi agent OpenCode người dùng chọn không giới hạn quyền, luật chỉ đọc cũng chỉ còn nằm trong chỉ dẫn.` | 2a-14 |
| 5 | Bảng requirement | — | Thêm REQ-063 | 2a-14 |
| 6 | §8 Depends on | — | Thêm: `Extension pi-mcp-adapter của Pi (bên thứ ba, không bắt buộc): thiếu nó thì agent Pi không có công cụ Paseo.` | 2a-14 |
| 7 | REQ-028 | `Người dùng đổi được tên, công cụ, model cho từng vai trò mà không phải gỡ rồi cài lại; thay đổi có hiệu lực với Worker tạo sau đó.` | Giữ nguyên, thêm: `Đáp ứng cho người dùng app bằng REQ-064. Lệnh CLI paseo-bm configure vẫn là P2 chưa làm.` | 2a-15 |
| 8 | §8 Does NOT own, câu về `config.json` | `Trong config.json, paseo-bm chỉ chạm tới việc đăng ký plugin paseo-bm và công tắc pluginsEnabled (có đồng ý).` | `Trong config.json, paseo-bm chỉ chạm tới việc đăng ký plugin paseo-bm, công tắc pluginsEnabled và daemon.mcp.injectIntoAgents (có đồng ý), và các mục bm-* của agents.providers và daemon.agentProfiles. Các mục bm-* do trình cài ghi (ADR-006) và do plugin ghi khi người dùng lưu trên màn REQ-064 (ADR-008).` Câu hiện tại đã lỗi thời từ ADR-006; đây là errata cộng phần mới | 2a-15 |
| 9 | Bảng requirement | — | Thêm REQ-064 | 2a-15 |
| 10 | REQ-031 ý (a) | `… đăng ký các vai trò (Manager, Worker, Reviewer) vào Paseo …` | Thêm: `Mỗi mục trong chuỗi dự phòng của một vai trò (REQ-065, REQ-066) có thêm một provider dẫn xuất bm-<vai trò>-fallback-<n> do plugin ghi; của Reviewer thì không có công cụ Paseo.` | 2a-16 |
| 11 | NFR **Riêng tư** | `… paseo-bm không gửi dữ liệu đi đâu khác và không có telemetry.` | Thêm: `Ngoại lệ duy nhất: sau khi đã nhận ra một agent của paseo-bm hết hạn mức (REQ-065 i), plugin nhờ daemon đọc hạn mức của gói Claude hoặc Codex; daemon gọi API hạn mức của chính nhà cung cấp đó bằng phiên đăng nhập của nó. paseo-bm không thấy credential và không gửi nội dung nào.` | 2a-16 |
| 12 | Bảng requirement | — | Thêm REQ-065 | 2a-16 |
| 13 | Bảng requirement | — | Thêm REQ-066 | 2a-17 |
| 14 | REQ-020 ý (b) | `Mỗi workspace dùng lại một Manager thay vì tạo trùng; Manager cũ còn sống thì mở lại nó.` | Thêm: `Ngoại lệ: Manager đã bị thay theo REQ-066 (c) thì không được mở lại; lối vào mở Manager thay thế. Manager cũ vẫn còn cho tới khi người dùng lưu trữ nó.` | 2a-17 |
| 15 | Bảng requirement | — | Thêm REQ-067 | 2a-18 |
| 16 | §9 Roadmap, dưới bảng | — | Thêm: `Delta 20260921 (worker-fallback-and-role-settings): Phase 2a-13 → 2a-18 giao REQ-062 → REQ-067, điều kiện ra ở plan delta tương ứng.` | 2a-13 |
| 17 | Revision History | — | Một dòng cho mỗi phase khi áp | mỗi phase |

## 5. Bằng chứng thành công

Owner tự xác nhận trên daemon thật, sau mỗi phase:

| Phase | Bằng chứng |
|---|---|
| 2a-13 | Đặt thinking `max` cho profile `bm-worker` trong Settings → Agent profiles → **100%** Worker tạo sau đó chạy `max` (`runtimeInfo.thinkingOptionId` trên Dashboard). Chạy lại `npx paseo-bm install` → giá trị đó **còn nguyên** |
| 2a-14 | Một Worker trên OpenCode làm xong một yêu cầu Nhỏ trên fixture nghiệm thu: Manager nhận được cả `received` và `finished`. Một Reviewer trên OpenCode và một Reviewer trên Pi được tạo **không lỗi**. Một Worker Pi trên máy chưa có `pi-mcp-adapter` sinh cảnh báo trước khi lượt đầu của nó kết thúc |
| 2a-15 | Đổi model Worker trên màn Roles & models → Worker kế tiếp chạy model đó, và Settings → Agent profiles hiện đúng giá trị. **0** profile không phải `bm-*` bị đổi |
| 2a-16 | Test tự động với provider giả phủ đủ L1–L6 và ba nút. Trên daemon thật, ở sự cố thật đầu tiên: thẻ hiện ngay khi lượt hỏng kết thúc; "Chuyển" tạo Worker thay thế trong **≤ 60 giây**; Worker đó làm tiếp mà **không mở lại** bead đã đóng |
| 2a-17 | "Chuyển" một Reviewer → Worker tạo Reviewer thay thế, và số lượt review của request **không tăng**. "Chuyển" một Manager → mở Beads Manager thì ra Manager thay thế, và báo cáo kế tiếp của một Worker đang chạy tới Manager đó |
| 2a-18 | Có ít nhất một sự cố thật được ghi lại, và bộ mẫu nhận dạng nó đúng loại |

## 6. NFR của delta

- **Hiệu năng:**
  - Hook tạo agent đọc thêm profile trong cùng ngân sách 5 giây đang có. Hết giờ thì tạo agent như hôm nay, không chặn.
  - Nhận dạng lỗi ở cuối lượt chỉ so chữ, không gọi thêm RPC nào khi lượt không có dấu hiệu lỗi.
  - Lưu trên màn Roles & models trả lời trong ≤ 5 giây.
- **Bảo mật:**
  - Không đọc, in hay lưu credential; `listUsage` do daemon gọi bằng phiên của nó.
  - Mọi lệnh ngoài vẫn chạy bằng `execFile`, không qua shell, với đối số đã kiểm.
  - Plugin chỉ ghi vào `config.json` các mục `bm-*`, và chỉ khi người dùng bấm Lưu.
  - Tin của người dùng đưa vào lời bàn giao Manager đi qua bộ che bí mật trước.
  - Rủi ro owner chấp nhận: Q3 (ghi đè `agentProfiles`) và Q7 (Reviewer trên Pi và OpenCode), §1.1.
- **Riêng tư:** lời bàn giao Manager chứa tới ba tin người dùng đã gõ. Các tin này đi tới provider của mục dự phòng, do chính người dùng khai cho vai trò Manager (NFR Riêng tư của PRD gốc).
- **Tính sẵn sàng:**
  - Mọi lỗi của phần mới thành một dòng log hay một thông báo; không làm hỏng việc đang chạy được hôm nay.
  - Chính sách "Tắt" đưa hành vi về đúng như trước delta.
- **Chi phí:** không agent nào được tạo trên provider dự phòng khi người dùng chưa bấm, trừ chế độ Tự động (REQ-067) mà người dùng tự bật.

## 7. Phạm vi

### 7.1 Personas và journeys

Personas: N/A. Delta dùng đúng người dùng và các actor của PRD gốc §4.

Journey mới, vì nghiệm thu REQ-065 và REQ-066 dựa trên cả một luồng:

| ID | Journey |
|---|---|
| J-F1 | Worker đang làm một request Lớn thì hết phiên 5 giờ của Claude → chat Manager hiện thẻ "Worker dừng vì hết hạn mức Claude (reset 15:40)" → người dùng bấm "Chuyển sang Codex · gpt-5.6-sol" → một Worker mới xuất hiện dưới Manager, đọc lời bàn giao, làm tiếp từ bead đang dở → Manager nhận `finished` từ Worker mới |
| J-F2 | Như J-F1, nhưng giờ reset còn 20 phút → người dùng bấm "Chờ tới 15:40" → đúng giờ, Worker cũ nhận lời nhắn làm tiếp và chạy lại |
| J-F3 | Reviewer Codex hết hạn mức giữa lượt review → thẻ trong chat Manager → người dùng bấm "Chuyển sang Claude · Sonnet 5" → Worker tạo Reviewer mới, gửi đúng tin review cũ → Worker nhận kết luận như thường |
| J-F4 | Manager và Worker cùng trên Claude, cùng hết hạn mức → chat Manager hiện hai thẻ → người dùng chuyển Manager sang Codex rồi mở lại Beads Manager → Manager mới báo đã tiếp quản, liệt kê Worker đang dở → người dùng chuyển Worker từ thẻ trong chat của Manager mới |

### 7.2 Ngoài phạm vi

- Kiểm hạn mức **trước** khi tạo agent (đề xuất N4): Q2 a không chọn.
- Đổi model hay thinking của agent **đang chạy** từ plugin: SDK chưa cho (đề xuất S9, đề nghị U1).
- Chuyển nguyên hội thoại của agent cũ sang agent thay thế: chỉ có lời bàn giao dựng bằng mã. Hội thoại cũ vẫn đọc được trong Paseo.
- Tách phiên đăng nhập theo vai trò: PRD gốc §3 đã loại.
- Cài `pi-mcp-adapter` hay bất kỳ công cụ nào thay người dùng.
- Copilot và Oh My Pi: đang unavailable hay bị tắt trên máy owner. Chúng vẫn chọn được khi `available` (REQ-063 a), nhưng không được nghiệm thu.
- Màn Dashboard cho các sự cố dự phòng. Dữ liệu được ghi (REQ-065 j), còn cách hiện là việc sau.
- Lệnh CLI `paseo-bm configure` (REQ-028 bản CLI).
- Gửi các đề nghị U1–U4 cho Paseo (đề xuất §5.2): đó là việc gửi ra ngoài, owner tự làm.
- Hỗ trợ CLI `skills` cài skill cho Pi hay OpenCode: tên agent của CLI đó cho hai công cụ này chưa kiểm. `--skills-agents` giữ mặc định `claude,codex`.

## 8. Câu hỏi mở

Không còn. Owner trả lời Q6–Q8 ngày 2026-09-21 (§1.1).

## 9. Duyệt

- [x] Owner đồng ý REQ-062 → REQ-067 và các dòng ở §4 (2026-09-22, Q10 a)
- [x] Owner trả lời Q6–Q8 (2026-09-21)
- [x] Owner chấp nhận rủi ro của Q3 và Q7 (2026-09-21) và các rủi ro còn lại ở §6 (2026-09-22, Q10 a)
- Approved-by: hieu.nt10, 2026-09-22 ("duyệt tất cả; PRD delta chuyển Accepted và tôi bắt đầu từ phase 2a-13" — Q10 a). Cùng lượt: Q11 a (commit cục bộ mỗi phase trên nhánh `feat/worker-fallback`, không push), Q12 a (review mỗi phase một lô), Q13 a (đọc `role-fallback-state.json` lúc đóng 2a-17)

Sau khi duyệt: Status → Accepted. Mỗi WP đóng phase áp các dòng ghi phase của nó ở §4. Sau phase 2a-17: Status → "Applied — 2a-18 deferred" nếu 2a-18 chưa đủ điều kiện vào, và REQ-067 chưa áp. Sau phase 2a-18: Status → Applied (plan delta §1.3).

## 10. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | Bản Draft theo `req-20260921T111242Z`, quyết định Q1–Q5 và đề xuất 20260921 |
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | `reviewing-plan`: REQ-063 (b) — agent OpenCode không chọn thì dùng agent đầu tiên Paseo liệt kê |
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | Owner trả lời Q6 a, Q7 a, Q8 c. Thêm REQ-066 (dự phòng cho Reviewer và Manager); chế độ Tự động thành REQ-067, cho cả ba vai trò; §4 thêm dòng REQ-020 (b); §5, §6, §7 theo đó; không còn câu hỏi mở |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Review `b1` và re-review: không mục chặn nào ở tài liệu này; §9 chỉnh câu trạng thái cho khớp hai đường đóng của plan delta. Cổng `prd-ready` PASS. Status Draft → Review, chờ owner duyệt §9 |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Owner duyệt §9 (Q10 a). Status Review → Accepted |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Phase 2a-13 xong (beads `bm-phase-2a-13-respect-profile-8u20.1` → `.4`): dòng 1, 2, 16 của PRD delta §4 đã áp vào PRD gốc; errata §3.2 vào thiết kế gốc; checklist nghiệm thu `docs/operations/paseo-bm-worker-fallback-checklist.md` (phần 2a-13) và ghi chú phát hành `docs/releases/paseo-bm-release-notes-0.2.0-alpha.2.md` |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Phase 2a-14 xong (beads `bm-phase-2a-14-any-provider-u2g9.1` → `.11`): dòng 3–6 của PRD delta §4 đã áp vào PRD gốc; errata §2.6 và §7 vào thiết kế gốc; checklist nghiệm thu phần 2a-14 và ghi chú phát hành `docs/releases/paseo-bm-release-notes-0.3.0-alpha.0.md`. Khi implement: hook tra mode của Worker cả khi bên tạo đã chọn mode (để bật `auto_accept` trên OpenCode); `costOf` nhận thêm `paseo` làm tham số đầu |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Owner chốt Q14 a và Q15 a: REQ-064 (f) sửa cho đúng — plugin chỉ thu hẹp được cửa sổ ghi đè `agentProfiles`, không báo được; sau khi ghi thì kiểm chính mục `bm-*` |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Phase 2a-15 xong (beads `bm-phase-2a-15-roles-and-models-kj1p.1` → `.6`): dòng 7, 8, 9 của §4 đã áp vào PRD gốc (REQ-028, §8 Does NOT own, thêm REQ-064); ADR-008 Accepted; checklist nghiệm thu phần 2a-15 và ghi chú phát hành `docs/releases/paseo-bm-release-notes-0.3.0-alpha.1.md` |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Phase 2a-16 xong (beads `bm-phase-2a-16-fallback-worker-332y.1` → `.12`): dòng 10, 11, 12 của §4 đã áp vào PRD gốc (REQ-031 a, NFR Riêng tư, thêm REQ-065); checklist nghiệm thu phần 2a-16 và ghi chú phát hành `docs/releases/paseo-bm-release-notes-0.3.0-alpha.2.md` |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Phase 2a-17 xong (beads `bm-phase-2a-17-fallback-reviewer-manager-fnnc.1` → `.6`): dòng 13, 14 của §4 đã áp vào PRD gốc (thêm REQ-066, REQ-020 b); checklist nghiệm thu phần 2a-17 và ghi chú phát hành `docs/releases/paseo-bm-release-notes-0.3.0-alpha.3.md`. Điều kiện vào phase 2a-18 kiểm lúc đóng phase 2a-17 (Q13 a, chỉ đọc `~/.paseo-bm/role-fallback-state.json` trên máy owner): file không tồn tại — **0 sự cố thật**, chưa đạt → Status Accepted → **Applied — 2a-18 deferred**; dòng 15 (REQ-067) không áp |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Owner chốt Q17 b; phase 2a-18 xong (beads `bm-phase-2a-18-fallback-auto-ny4k.1`, `.2`): dòng 15 của §4 (REQ-067) đã áp vào PRD gốc. Status **Applied — 2a-18 deferred → Applied**; phát hành npm bản mang "Auto switch" chờ một sự cố thật được mẫu nhận đúng loại (REQ-067 c, owner chốt Q17 b) |
| 2026-09-23 | hieu.nt10 (soạn bởi Beads Worker) | **Đã phát hành lên npm.** `paseo-bm@0.3.0-alpha.4` (dist-tag `next`, provenance SLSA v1) mang REQ-062 → REQ-067 của delta này, gộp cả sáu phase 2a-13 → 2a-18 vào một bản; sáu số theo phase chưa từng lên npm. Commit `e309e45`, run `35821253485`. Điều kiện phát hành REQ-067 (c) đạt (checklist 18.1). Xem [bản ghi lần chạy](../operations/paseo-bm-release-run-20260923.md) và [delta plan 20260923](../plans/paseo-bm-implementation-plan-delta-20260923-release-030-alpha4.md) |
