# Delta-change — Manager mặc định Bypass, số đo model của từng agent, và kiểm tra cách nạp chỉ dẫn theo model

| Trường | Giá trị |
|---|---|
| Mã | `prd-delta-20260918-manager-mode-model-metrics` |
| Tài liệu gốc | [paseo-bm PRD](paseo-bm-prd.md) REQ-026 ý (c), NFR **Quyền**; [PRD Dashboard](paseo-bm-dashboard-prd.md) REQ-052 — **không sửa tại chỗ khi chưa duyệt** |
| Status | **Applied với ngoại lệ** — 2026-09-18. Accepted bởi owner hieu.nt10 (§6); các vị trí 1–3 và 5–6 đã áp vào PRD và PRD Dashboard. **Ngoại lệ:** nghiệm thu trên daemon thật chưa làm, theo quyết định owner (trả lời "c"), ghi là ngoại lệ chứ không phải đạt — bead `bm-wp-249-5qqp.1` để hoãn |
| Owner | hieu.nt10 |
| Created | 2026-09-18 |
| Request | `req-20260918T011706Z` |
| Thiết kế | [design-delta-20260918-manager-mode-model-metrics](../design/paseo-bm-delta-20260918-manager-mode-model-metrics.md) |
| Plan | [plan-delta-20260918-manager-mode-model-metrics](../plans/paseo-bm-implementation-plan-delta-20260918-manager-mode-model-metrics.md) |

## 0. Routing Decision

- Variant preset: brownfield
- Triggered risks: **quyền** (Manager chạy không hỏi quyền — đảo một câu của REQ-026c đang Accepted); **hợp đồng/dữ liệu lưu bền** (bản ghi trace thêm trường, hợp đồng RPC Dashboard thêm trường); **nhiều thành phần độc lập** (tạo Manager, bộ thu thập, Dashboard, một báo cáo nghiên cứu)
- Required artifacts/gates: PRD delta này (duyệt ở §6) → design delta + `design-ready` → plan delta + `plan-ready-for-beads` → beads → `feature-done` (hồ sơ standard)
- Execution path: plan → converter
- Exceptions: none
- Decided: 2026-09-18 — Beads Worker, theo cỡ **Large** Manager đoán và Worker xác nhận
- Supersedes: none

## 1. Owner nói gì

> Tôi muốn khi vào, tạo mới Agent Managers thì chế độ mặc định là ByPass.
> Ngoài ra tôi không thâý metric đo được rõ ràng về việc agent nào lúc xử lý thì xài model gì
> Cuối cùng, quan trọng nhất, tôi muốn kiểm tra xem với mỗi model thì cơ chế cách nói instruction có cần tối ưu không vì thuâtj toán để nhồi instruction có thể khác nhau

### 1.1 Quyết định của owner (2026-09-18, vòng hỏi đầu)

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q31 | Manager chạy mode nào, áp cho ai | **(b)** Manager **mới** tạo ở mode không hỏi quyền của provider khi profile `bm-manager` không tự đặt `modeId` (mode tự đặt trên profile vẫn thắng); Manager **đang có** cũng được chuyển sang mode đó khi màn hình Manager mở lại nó |
| Q32 | Số đo model hiện tới mức nào | **(c)** Model trên từng agent trong sơ đồ request, dòng "token theo model" cho mỗi request, thẻ tổng quan token và chi phí theo **model × vai trò**, **cộng** mức thinking/effort và mode của từng agent — chấp nhận bản ghi trace thêm trường |
| Q33 | Phạm vi phần kiểm tra chỉ dẫn theo model | **(a)** Chỉ điều tra: một báo cáo tiếng Việt trong `docs/` kèm danh sách đề xuất có thứ tự; **không** sửa file vai trò trong request này |
| Q34 | Nguồn cho hướng dẫn của từng họ model | **(a)** Được đọc (chỉ đọc) hướng dẫn viết prompt công khai của Anthropic và OpenAI cho các model đang dùng |
| Q35 | Phủ những model nào | **(a)** Claude Code / `claude-opus-5` (Manager, Worker) và Codex / `gpt-5.6-sol` (Reviewer), cộng một đoạn về OpenCode |
| Q36–Q39 | Vòng hai (sau `reviewing-plan`): chuyển Manager cũ mấy lần, Manager đang chạy, khoá model của chi phí, rủi ro gọi CLI trong daemon | **Một lần**; **bỏ qua lần này**; **model thật đã chạy**; **làm như thiết kế** — chi tiết ở [thiết kế §8](../design/paseo-bm-delta-20260918-manager-mode-model-metrics.md#8-câu-hỏi-mở--đã-trả-lời-vòng-hỏi-thứ-hai-2026-09-18) |

## 2. Thay đổi 1 — Manager mặc định chạy không hỏi quyền

### 2.1 Vì sao

Profile `bm-manager` do installer đăng ký **không** có `modeId` (ADR-006: installer cố ý không ghi mode), nên `manager.ensure` tạo Manager ở mode mặc định của provider — với Claude là `default` ("Always Ask", đọc trên daemon owner 2026-09-18). Manager vì vậy dừng chờ người dùng bấm duyệt ở mọi lệnh đầu tiên, trong khi Worker và Reviewer đã chạy không chờ từ 2026-09-15.

### 2.2 Rủi ro phải chấp nhận có ý thức

- **Mọi giới hạn của Manager chỉ còn là lan can hành vi.** Manager có công cụ Paseo (tạo, nhắn, dừng agent) và shell. Không còn lời hỏi quyền của Paseo làm lớp chặn thứ hai: một Manager phớt lờ `manager.md` có thể tự làm việc thay Worker, chạy lệnh cần mạng hay lệnh phá huỷ mà không ai phải bấm duyệt. Đây đúng là rủi ro đã chấp nhận cho Worker ở `prd-delta-20260915-subagent-modes` §3, nay mở rộng sang Manager.
- **Chuyển Manager đang có là đổi một thứ người dùng đang dựa vào.** Người dùng có thể đã tự chọn mode cho Manager của họ. Cách chuyển được giới hạn ở thiết kế §4.1: chuyển **một lần** cho mỗi Manager, sau đó tôn trọng lựa chọn tay (owner chốt Q36).
- M-13 (0 lần tự commit/push) với Manager trở thành bằng chứng quan sát về chỉ dẫn, không còn được lời hỏi quyền hỗ trợ.

### 2.3 Các dòng sẽ đổi nếu được duyệt

| # | Tài liệu và vị trí | Hiện tại | Đề xuất |
|---|---|---|---|
| 1 | `paseo-bm-prd.md`, REQ-026 ý (c), câu đầu | `(c) Manager không tự phê duyệt yêu cầu quyền thay người dùng.` | `(c) Manager không tự phê duyệt yêu cầu quyền thay người dùng. Manager được tạo ở chế độ không hỏi quyền của provider (Claude bypassPermissions, Codex full-access) khi profile bm-manager không tự đặt mode, và Manager đã có được chuyển sang chế độ đó một lần khi màn hình Manager mở lại nó — theo quyết định owner 2026-09-18 (Q31).` Phần còn lại của ý (c) giữ nguyên, và câu "với Worker không còn lời hỏi quyền…" đổi thành "với Manager và Worker không còn lời hỏi quyền…" |
| 2 | `paseo-bm-prd.md`, NFR **Quyền** | `… Manager không tự phê duyệt yêu cầu quyền. Rủi ro đã biết: ranh giới an toàn của Worker chỉ còn nằm trong chỉ dẫn vai trò.` | `… Manager chạy ở chế độ không hỏi quyền (REQ-026c) và không tự phê duyệt yêu cầu quyền của agent khác. Rủi ro đã biết: ranh giới an toàn của Manager và Worker chỉ còn nằm trong chỉ dẫn vai trò.` |
| 3 | `paseo-bm-prd.md`, Revision History | — | `2026-09-18 \| hieu.nt10 \| REQ-026c và NFR Quyền: Manager chạy không hỏi quyền theo prd-delta-20260918-manager-mode-model-metrics` |
| 4 | `paseo-bm-prd-delta-20260915-subagent-modes.md` §5 "Chế độ quyền của Manager … không đổi" | giữ nguyên chữ | Không sửa delta đã Applied; thiết kế gốc §2.6 nhận errata trỏ về delta này |

### 2.4 Không đổi

- Manager **không bao giờ** phê duyệt yêu cầu quyền của agent khác, không lưu trữ hay xoá agent (REQ-020d, REQ-026f).
- Worker giữ mode không hỏi quyền; Reviewer giữ `auto`, không bao giờ `dangerous` (REQ-026c).
- Profile `bm-manager` có `modeId` do người dùng tự đặt thì mode đó thắng — với cả Manager mới lẫn Manager đang có.
- Installer vẫn không ghi `modeId` vào profile (ADR-006).

## 3. Thay đổi 2 — REQ-058 trong PRD Dashboard: agent nào đã chạy bằng model gì

### 3.1 Vì sao

Kho vết **đã** ghi model của mỗi lượt (`usage.model`, ví dụ Manager và Worker `claude-opus-5`, Reviewer `gpt-5.6-sol` trên bốn workspace của owner), nhưng Dashboard không hiện nó ở đâu: mỗi agent chỉ có dòng token và tiền. Bảng cấu hình vai trò ở panel cây agent chỉ hiện model **đã cấu hình** trên profile, không phải model agent **đã thật sự chạy** — hai thứ khác nhau khi profile để trống model hoặc người dùng đổi model giữa chừng.

### 3.2 Requirement mới (đề xuất thêm vào PRD Dashboard)

| ID | Tên | Ưu tiên | Tiêu chí |
|---|---|---|---|
| REQ-058 | Agent nào chạy bằng model, mức thinking và mode nào | P2 | (a) Mỗi agent trong sơ đồ một request (Worker, Reviewer; Manager nằm trong phần chi tiết request) hiện **model**, **mức thinking/effort** và **mode** mà nó thật sự chạy, lấy từ các lượt đã ghi — không lấy từ cấu hình profile. (b) Giá trị đổi giữa các lượt thì hiện đủ mọi giá trị kèm số lượt của từng cái, không chọn một. (c) Lượt ghi bởi bản cũ không có trường này thì hiện **"không ghi nhận"**, không suy đoán; mức thinking không đặt thì hiện "mặc định của provider". (d) Phần chi tiết request có dòng **token và chi phí theo model**, cùng quy tắc giá của REQ-052 (model không có giá thì chỉ hiện token). (e) Phần tổng quan có thẻ **token và chi phí theo model × vai trò**, cộng trên đúng tập request mà các thẻ tổng quan khác đang dùng. (f) Không gọi mạng, không đọc thêm quyền nào ngoài những gì bộ thu thập đang đọc. |

### 3.3 Các dòng sẽ đổi nếu được duyệt

| # | Tài liệu và vị trí | Đề xuất |
|---|---|---|
| 5 | `paseo-bm-dashboard-prd.md`, bảng requirement | Thêm dòng REQ-058 như §3.2 |
| 6 | `paseo-bm-dashboard-prd.md`, Revision History | `2026-09-18 \| hieu.nt10 \| Thêm REQ-058 (model, mức thinking và mode từng agent; token theo model; thẻ model × vai trò) theo prd-delta-20260918-manager-mode-model-metrics. Status giữ Accepted` |

## 4. Phần 3 — kiểm tra cách nạp chỉ dẫn theo model

Đây **không** phải requirement sản phẩm: kết quả là một báo cáo nghiên cứu, không đổi hành vi của plugin. Theo Q33, request này **không** sửa `plugin/roles/*.md`; mọi đề xuất trong báo cáo là việc owner quyết sau, thành request mới. Phương pháp, câu hỏi phải trả lời và nơi đặt báo cáo nằm ở [thiết kế](../design/paseo-bm-delta-20260918-manager-mode-model-metrics.md) §4.5.

## 4b. Bằng chứng thành công, NFR, phụ thuộc, phase

- **Bằng chứng thành công** (quan sát được, owner tự xác nhận trên daemon thật): (1) Manager mới mở ra ở mode `Bypass`, 0 lời hỏi quyền cho lệnh đầu tiên của nó; (2) một Manager cũ ở `Always Ask` chuyển sang `Bypass` sau **một** lần mở, và đổi tay sau đó thì lần mở kế **không** đè; (3) một request mới trên Dashboard hiện model, mức thinking và mode của **100%** agent của nó; (4) báo cáo phần 3 trả lời đủ sáu câu hỏi R1–R6 của thiết kế §4.5, mỗi khẳng định có nguồn.
- **NFR — hiệu năng:** mở màn hình Manager chậm thêm tối đa 5 giây cho mỗi lần tra mode, và chỉ khi Manager chưa được xử lý; lỗi hay hết giờ không bao giờ chặn việc mở chat.
- **NFR — bảo mật:** như §2.2; không gọi mạng; không đọc bí mật; lệnh ngoài chỉ chạy không qua shell với đối số đã kiểm.
- **NFR — tính sẵn sàng:** không yêu cầu riêng; mọi lỗi ở phần mới thành một thông báo, không làm hỏng việc đang chạy được hôm nay.
- **Phụ thuộc:** lệnh `paseo agent mode` và `paseo agent update --label` của Paseo CLI 0.8 (cho Manager đang có); snapshot agent của Paseo 0.8 (cho REQ-058). paseo-bm **không** sở hữu cơ chế đổi mode của Paseo.
- **Phase:** Phase 2a-6, điều kiện ra ở [plan delta §1](../plans/paseo-bm-implementation-plan-delta-20260918-manager-mode-model-metrics.md#1-mvp-lock).
- **Personas và journeys:** N/A — cùng người dùng và cùng hành trình của PRD gốc; delta không thêm tác nhân nào.
- **Câu hỏi mở:** không còn — O1–O3 và rủi ro CLI đã được owner trả lời (Q36–Q39).

## 5. Ngoài phạm vi

- Sửa ba file vai trò, hay thêm biến thể chỉ dẫn theo provider (Q33).
- Một lượt đo thật trên daemon để so chất lượng theo model (Q33 không chọn (c)).
- Provider khác ngoài Claude Code, Codex và một đoạn về OpenCode (Q35).
- Đổi mode của Worker hay Reviewer.
- Ghi `modeId` vào `~/.paseo/config.json` (Q31 không chọn (c)).

## 6. Duyệt

- [x] Owner đồng ý §2 và chấp nhận rủi ro ở §2.2
- [x] Owner đồng ý REQ-058 ở §3.2
- [x] Nghiệm thu trên daemon thật: owner tự cài bản build và tự kiểm theo checklist (không để Worker cài)
- Approved-by: hieu.nt10 ("làm theo để xuất Worker Large" — trả lời ba câu xác nhận trước khi implement), 2026-09-18

Sau khi duyệt: đổi Status thành Accepted; WP đóng delta (plan §3) áp các vị trí 1–3 và 5–6 rồi đổi Status thành Applied.

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Bản Draft theo yêu cầu `req-20260918T011706Z` và năm quyết định Q31–Q35 |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Ghi quyết định vòng hai Q36–Q39; không còn câu hỏi mở |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Owner duyệt §2 và REQ-058 ở bước xác nhận trước khi implement; chọn tự cài bản build để nghiệm thu. Status Draft → Accepted |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Áp vị trí 1–3 vào `paseo-bm-prd.md` và 5–6 vào `paseo-bm-dashboard-prd.md` (WP-249). Owner chọn bỏ qua nghiệm thu trên daemon thật lúc này ("c"): ghi **ngoại lệ**, không ghi đạt. Status Accepted → Applied với ngoại lệ |
