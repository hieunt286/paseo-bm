# Checklist nghiệm thu — cài đặt vai trò và dự phòng provider

| Trường | Giá trị |
|---|---|
| Status | Active — kiểm trên daemon thật các tính năng cài đặt vai trò và dự phòng có trong `0.3.0` |
| Nguồn | [PRD delta §5](../archive/product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md#5-bằng-chứng-thành-công), [design delta §8](../archive/design/paseo-bm-delta-20260921-worker-fallback-and-role-settings.md#8-testing-strategy), [plan delta §1.3](../archive/plans/paseo-bm-implementation-plan-delta-20260921-worker-fallback-and-role-settings.md#13-điều-kiện-ra) |
| Người chạy | owner (hieu.nt10), trên daemon thật |
| Nguyên tắc ghi điểm | Mục nào chưa đo thì ghi **Chưa đo**, không bao giờ ghi Đạt. Mục không đạt thì ghi **Không** kèm số đo |

Mỗi phần là một tính năng, ghi phiên bản đầu tiên có nó. Tính năng mới về vai trò hay dự phòng thêm phần mới vào đây.

## Chuẩn bị chung, và đường lùi

> **Cảnh báo:** **không** cài bản mới hay `paseo plugin reload` khi còn một agent `bm-*` đang chạy — việc đó ngắt lượt của agent (bài học lượt 2026-09-16).

| # | Bước | Ghi lại |
|---|---|---|
| 1 | Đọc `~/.paseo-bm/install.json` (`version`, `roles[]`) | phiên bản cũ, để khôi phục |
| 2 | Chụp `~/.paseo/config.json` (mục `agents.providers.bm-*` và `daemon.agentProfiles`) | ảnh trước |
| 3 | `npm run build` trong repo, trên commit cần kiểm | bản dựng dùng để kiểm |
| 4 | `node dist/index.js install --home ~/.paseo-bm` | output, mã thoát |

**Đường lùi:** `npx paseo-bm@<phiên bản cũ>` cài lại bản trước. Các giá trị bạn đặt trên mục `bm-*` không bị bản mới xoá; bản cũ sẽ thay nguyên mục đó ở lần ghi kế tiếp của nó.

## Thinking và model theo profile (REQ-062, từ `0.2.0-alpha.2`)

| # | Kiểm | Cách làm | Kết quả mong đợi | Kết quả |
|---|---|---|---|---|
| 13.1 | Thinking của profile tới Worker | Settings → Agent profiles → profile **Worker** (`bm-worker`) → Thinking = `max` → lưu. Giao Manager một yêu cầu Nhỏ | Worker mới chạy thinking `max`: màn **Metric** → request → nút Worker ghi `thinking: max` (`runtimeInfo.thinkingOptionId`) cho **100%** Worker tạo sau đó | Chưa đo |
| 13.2 | Thinking của profile tới Reviewer | Như 13.1 với profile **Reviewer** (`bm-reviewer`), ví dụ `high`, và một yêu cầu Vừa (yêu cầu Nhỏ không tạo Reviewer) | Reviewer mới chạy `high` | Chưa đo |
| 13.3 | Cài lại không xoá | Sau 13.1, chạy lại `node dist/index.js install --home ~/.paseo-bm` | Bản xem trước báo 0 thay đổi cấu hình; `thinkingOptionId: "max"` vẫn nằm trên profile `bm-worker` trong `~/.paseo/config.json` | Chưa đo |
| 13.4 | `--role` chỉ đổi đúng vai trò | `node dist/index.js install --home ~/.paseo-bm --role worker=<provider>/<model khác>` | Profile `bm-worker` đổi `model`, **mất** `thinkingOptionId`, giữ `modeId` nếu có; profile `bm-manager` và `bm-reviewer` không đổi byte nào | Chưa đo |
| 13.5 | `doctor` báo đổi trong app | Trong Settings, đổi model của Worker; chạy `node dist/index.js doctor` | Có dòng `bm-worker: base provider or model differs from what the installer wrote (changed in the app).`; mã thoát không đổi so với trước khi đổi | Chưa đo |

## Worker và Reviewer trên OpenCode, Pi (REQ-063, từ `0.3.0-alpha.0`)

Cần một provider OpenCode và một provider Pi `available` trên daemon. Đổi provider gốc của vai trò bằng `node dist/index.js install --home ~/.paseo-bm --role <vai trò>=<provider>/<model>`, và trả lại như cũ sau mỗi kiểm.

| # | Kiểm | Cách làm | Kết quả mong đợi | Kết quả |
|---|---|---|---|---|
| 14.1 | Worker trên OpenCode làm xong một yêu cầu Nhỏ | `--role worker=opencode/<model>`; mở Beads Manager, giao một yêu cầu Nhỏ trên fixture nghiệm thu | Worker được tạo với một agent OpenCode (mode) và `auto_accept` bật; Manager nhận cả `received` và `finished` | Chưa đo |
| 14.2 | Reviewer trên OpenCode được tạo | `--role reviewer=opencode/<model>`; một yêu cầu Vừa (yêu cầu Nhỏ không có Reviewer, trừ khi người dùng xin review) | Reviewer được tạo **không lỗi**, `auto_accept` **tắt**; nếu agent OpenCode hỏi quyền, yêu cầu duyệt hiện trong Paseo | Chưa đo |
| 14.3 | Reviewer trên Pi được tạo | `--role reviewer=pi/<model>`; một yêu cầu Vừa | Reviewer được tạo không lỗi, không có mode; `## Runtime facts` của Worker ghi `Reviewer mode: none` | Chưa đo |
| 14.4 | Worker Pi thiếu `pi-mcp-adapter` sinh `BM-TOOLS` | Trên máy chưa có adapter: `--role worker=pi/<model>`; giao một yêu cầu | Chat Manager nhận `BM-TOOLS …` trước khi lượt đầu của Worker kết thúc; màn Setup có dòng cảnh báo Worker | Chưa đo |
| 14.5 | Tín hiệu `supportsMcpServers` | Như 14.4, rồi `get_agent_status` của Worker Pi | `capabilities.supportsMcpServers` là `false`. **Nếu là `true` hay không có**, ghi lại nguyên văn và báo: tín hiệu của thiết kế §4.2.4 sai | Chưa đo |
| 14.6 | Tín hiệu nạp skill trên OpenCode và Pi | Sau 14.1 và 14.3, mở màn **Metric** → request | Cột skill của Worker OpenCode / Reviewer Pi: ghi lại có hay "không ghi nhận" (giới hạn đã biết, thiết kế §4.2.8) | Chưa đo |
| 14.7 | Cột skill Pi và OpenCode | Mở Beads Manager → Setup | Có cột Pi (`~/.pi/agent/skills`) và OpenCode (`~/.config/opencode/skill`) | Chưa đo |
| 14.8 | Giá theo `metadata.cost` | Sau 14.1, màn **Metric** → request | Lượt của Worker OpenCode có tiền (không chỉ token) | Chưa đo |


## Sửa vai trò trên màn Setup (REQ-064, ADR-008, từ `0.3.0-alpha.1`)

Trước khi kiểm, chụp mảng `daemon.agentProfiles` và các mục `agents.providers.bm-*` của `~/.paseo/config.json` (bước 2 của phần chuẩn bị); 15.2 so với ảnh đó. Đây là chỗ plugin tự ghi `config.json` (ADR-008, `plugin/server/config-writer.ts`).

| # | Kiểm | Cách làm | Kết quả mong đợi | Kết quả |
|---|---|---|---|---|
| 15.1 | Lưu trên màn → Settings hiện cùng giá trị | Beads Manager → Setup → Roles & models → **Edit** ở Worker → đổi model (và thinking nếu model có) → **Save** | Dòng Worker hiện model mới và chữ "Saved."; Settings → Agent profiles → profile **Worker** (`bm-worker`) hiện đúng model và thinking đó | Chưa đo |
| 15.2 | 0 profile khác đổi | Sau 15.1, so `~/.paseo/config.json` với ảnh trước | Chỉ `model` / `thinkingOptionId` / `modeId` của `bm-worker` và `extends` của `agents.providers.bm-worker` khác; **mọi** profile không phải `bm-*` giống từng byte, thứ tự mảng giữ nguyên | Chưa đo |
| 15.3 | Worker kế tiếp chạy model mới | Sau 15.1, giao Manager một yêu cầu Nhỏ | màn **Metric** → request → nút Worker ghi đúng model đã lưu (`runtimeInfo.model`) | Chưa đo |
| 15.4 | Đổi provider → Manager đang sống được báo | Có một Manager đang mở. Edit Worker → đổi sang provider khác (ví dụ Codex) → Save; rồi giao Manager một yêu cầu | Chat Manager nhận `BM-SETTINGS …` với dòng `Worker mode` mới (ngay nếu Manager nghỉ, ở cuối lượt nếu đang chạy); Worker kế tiếp được tạo **không lỗi** mode | Chưa đo |
| 15.5 | Lệch revision → không ghi | Mở Edit ở Worker; trong Settings của Paseo sửa một profile bất kỳ và lưu; quay lại và bấm Save | Form báo đúng câu `The configuration changed elsewhere; reopen Roles & models.`; `config.json` không đổi thêm | Chưa đo |
| 15.6 | Reviewer không có mode nguy hiểm | Edit Reviewer trên Claude hay Codex | Danh sách Mode **không** có `bypassPermissions` / `full-access` / `plan` | Chưa đo |
| 15.7 | Cảnh báo không chặn | Edit Worker → Pi (nếu có) → Save | Lưu được, dưới dòng Worker hiện `Pi needs pi-mcp-adapter to give this role Paseo tools.` | Chưa đo |

Rủi ro đã biết (owner chấp nhận, Q3 a, Q15 a): một thay đổi trong Settings của Paseo rơi đúng vào lúc plugin đang ghi (giữa lần đọc và lần ghi của một lần Save) có thể bị đè mà không báo. Không có bước kiểm cho rủi ro này.

## Dự phòng cho Worker (REQ-065, từ `0.3.0-alpha.2`)

Cần một chuỗi dự phòng cho Worker: Beads Manager → Setup → Roles & models → dưới dòng Worker → **+ Add fallback** (ví dụ Codex) → **Save fallbacks**. Một sự cố thật là tốt nhất; không có thì dựng lượt hỏng bằng một provider giả (ví dụ một Worker trên provider Pi chưa đăng nhập, cho L4).

| # | Kiểm | Cách làm | Kết quả mong đợi | Kết quả |
|---|---|---|---|---|
| 16.1 | Lưu chuỗi ghi alias và file | Sau khi lưu, đọc `~/.paseo/config.json` và `~/.paseo-bm/role-fallback.json` | Có `agents.providers.bm-worker-fallback-1` với `extends` của mục đó; file có `roles.worker.entries` đúng thứ tự; 0 profile khác đổi | Chưa đo |
| 16.2 | Thẻ hiện ngay khi lượt Worker hỏng | Một Worker dừng vì hạn mức / billing / đăng nhập | Chat Manager có thẻ "Worker stopped by its provider plan" với nguyên văn lỗi; pill "Fallback · 1 decision" ở Manager đó; `~/.paseo-bm/role-fallback-state.json` có sự cố `pending` | Chưa đo |
| 16.3 | Thẻ vẫn hiện khi Manager cùng provider gốc | Manager và Worker cùng provider gốc; Worker hết hạn mức gói | Lượt của Manager hỏng theo (vô hại), nhưng thẻ và pill vẫn hiện (đọc từ file, không từ lượt Manager) | Chưa đo |
| 16.4 | Switch tạo Worker thay thế | Bấm **Switch to …** trên thẻ | Trong **≤ 60 giây** có Worker "Beads Worker (fallback)" trên `bm-worker-fallback-1/<model>`, nhãn `bm.replaces` = Worker cũ; Worker cũ mang `bm.replacedBy`; Worker mới gửi `received` và **không mở lại** bead đã đóng | Chưa đo |
| 16.5 | Một Worker cho request | Sau 16.4, trả lời một câu hỏi của request đó trên thẻ | Câu trả lời tới Worker mới, không tới Worker cũ; cây agent ghi `· replaced by <id>` cạnh Worker cũ | Chưa đo |
| 16.6 | `listUsage` trả cửa sổ | Ở một sự cố L1 của Claude hay Codex | Sự cố có `resetsAt` (giờ reset muộn nhất trong các cửa sổ đã hết); thẻ có nút **Wait until <giờ>** | Chưa đo |
| 16.7 | Wait | Bấm **Wait until …** | Sự cố `waiting`; tới giờ reset + 60 giây, Worker cũ nhận `BM-RESUME …` và làm tiếp; thẻ ghi đã resume | Chưa đo |
| 16.8 | I'll handle it | Bấm **I'll handle it** trên một sự cố khác | Sự cố `dismissed`; không agent nào bị tạo hay dừng | Chưa đo |

Rủi ro đã biết: mẫu nhận dạng mặc định chưa kiểm trên sự cố thật (đề xuất §1.5). Nếu 16.2 không có thẻ, ghi nguyên văn lỗi của lượt hỏng vào cột Kết quả: đó là dữ liệu để sửa mẫu.

## Dự phòng cho Reviewer và Manager (REQ-066, từ `0.3.0-alpha.3`)

Cần một chuỗi dự phòng cho Reviewer và cho Manager (Beads Manager → Setup → Roles & models, khối dưới dòng Reviewer và dòng Manager). Như phần dự phòng cho Worker: sự cố thật là tốt nhất, không thì dựng lượt hỏng bằng một provider giả; không bao giờ cố đẩy một provider tới hạn mức.

| # | Kiểm | Cách làm | Kết quả mong đợi | Kết quả |
|---|---|---|---|---|
| 17.1 | Switch một Reviewer | Một Reviewer dừng vì hạn mức / billing / đăng nhập; bấm **Switch to …** trên thẻ trong chat Manager | Worker cha nhận `BM-FALLBACK` với chỉ dẫn `create_agent`; Worker tạo Reviewer trên `bm-reviewer-fallback-1/<model>` có nhãn `bm.replaces` = Reviewer cũ, và gửi nó nguyên văn tin review cũ; Reviewer cũ mang `bm.replacedBy` | Chưa đo |
| 17.2 | Số lượt review không tăng | Sau 17.1, màn **Metric** → request | Số lượt review của request **không tăng** vì tin gửi lại; không có `BM-BUDGET` vì tin đó | Chưa đo |
| 17.3 | Resend to Worker | **Không dựng lại trên daemon thật**: tin chỉ nằm trong hàng chờ khi Worker đang chạy, nên phải nạp lại plugin giữa lượt của Worker — trái cảnh báo ở phần chuẩn bị. Chỉ kiểm bằng test tự động (`test/fallback-reviewer.test.ts`) | Thẻ hiện nút **Resend to Worker** khi sự cố Reviewer `switched` mà chưa có Reviewer thay thế; bấm thì Worker nhận lại đúng chỉ dẫn | Chưa đo (chỉ test tự động) |
| 17.4 | Switch một Manager | Manager dừng vì gói của provider; bấm **Switch to …** trên thẻ trong chính chat Manager đó | Có Manager mới trên `bm-manager-fallback-1/<model>` với lời bàn giao `BM-HANDOVER` role manager (Worker, câu hỏi đang chờ, ba tin gần nhất của bạn đã che bí mật); thẻ ghi "A new Beads Manager is running on …" | Chưa đo |
| 17.5 | Beads Manager mở Manager thay thế | Sau 17.4, mở Beads Manager từ sidebar hay Command Center | Mở Manager mới, không phải Manager cũ; Manager cũ vẫn còn cho tới khi bạn lưu trữ nó | Chưa đo |
| 17.6 | Worker báo cáo tới Manager mới | Sau 17.4, một Worker đang chạy gửi báo cáo kế tiếp | Worker đã nhận `BM-SETTINGS` với dòng `Manager agent id: …`; báo cáo kế tiếp tới Manager mới | Chưa đo |


## Tự chuyển và tự chờ (REQ-067, từ `0.3.0-alpha.4`)

Mục 18.1 là tiền đề trước khi bật **Auto switch**: bộ mẫu phải nhận đúng loại ít nhất một sự cố thật (từng là điều kiện phát hành của `0.3.0-alpha.4`, owner chốt Q17 b; đã Đạt trên máy owner). Các mục khác cần một chuỗi dự phòng, và policy **Auto switch** đặt riêng cho vai trò cần kiểm (Beads Manager → Setup → Roles & models). Như phần dự phòng cho Worker: sự cố thật là tốt nhất, không thì dựng lượt hỏng bằng một provider giả; không bao giờ cố đẩy một provider tới hạn mức.

| # | Kiểm | Cách làm | Kết quả mong đợi | Kết quả |
|---|---|---|---|---|
| 18.1 | Bộ mẫu nhận đúng sự cố thật (REQ-067 c) | Đọc `~/.paseo-bm/role-fallback-state.json` (chỉ đọc) | Ít nhất một sự cố có `signal` và `message` do một provider thật sinh ra, và `class` đúng với lỗi đó theo bộ mẫu (mặc định hoặc của file) | **Đạt** — đọc 2026-09-23 (`req-20260923T040415Z`). File có 1 sự cố: `fb-d3c9430912b2`, `role` `worker`, `signal` `completed`, `message` `"Failed to authenticate. API Error: 401 API key is invalid."` — do Anthropic thật từ chối lượt Claude Code sinh ra, `class` `L4`, `status` `switched`. Không có `~/.paseo-bm/role-fallback.json` nên bộ mẫu áp dụng là `DEFAULT_PATTERNS`. Chạy chính `classifyText` của `plugin/shared/fallback-patterns.ts` trên `message` đó: trả `L4`, mẫu khớp `/\b401\b/i`, `isFallbackClass` true — **trùng** với `class` đã ghi trong file. |
| 18.2 | Lựa chọn và cảnh báo | Chọn **Auto switch** cho Worker, rồi cho Manager; **Save fallbacks** | Dưới dòng policy có cảnh báo chi phí; của Manager có thêm "The chat you use may be replaced."; `role-fallback.json` có `policy: "auto"` cho đúng vai trò đó, vai trò khác không đổi | Chưa đo |
| 18.3 | Tự chuyển | Worker có Auto switch dừng vì gói của provider, không biết giờ reset (hay giờ reset còn hơn 30 phút) | Không cần bấm: có Worker thay thế như 16.4; chat Manager nhận **một** thẻ, trạng thái đã chuyển — không có thẻ "pending" trước đó | Chưa đo |
| 18.4 | Tự chờ | Sự cố L1 của Claude hay Codex có giờ reset còn ≤ 30 phút | Sự cố `waiting` ngay, không agent nào được tạo; tới giờ reset agent cũ nhận `BM-RESUME` như 16.7 | Chưa đo |
| 18.5 | Không ứng viên | Vai trò có Auto switch nhưng chuỗi rỗng (hay mọi ứng viên đã dùng) | Sự cố ở lại `pending`, thẻ như Ask me | Chưa đo |
| 18.6 | Ask me không đổi | Vai trò để "Ask me" | Như 16.2: thẻ `pending`, không gì tự chạy | Chưa đo |

Rủi ro đã biết: bật Auto switch khi 18.1 chưa đạt thì một lần nhận nhầm tạo ra một agent thừa. Nếu 18.3 tạo agent cho một lượt không phải lỗi gói, ghi nguyên văn lượt đó vào cột Kết quả và đặt lại "Ask me".

---

*Revision 2026-09-25: giữ làm checklist hiện hành cho cài đặt vai trò và dự phòng; tiêu đề phần đổi từ số phase sang tính năng, "Dashboard" đổi thành màn Metric, bỏ các câu về điều kiện vào/ra phase đã đóng; kiểm cần Reviewer dùng yêu cầu Vừa vì yêu cầu Nhỏ không còn tạo Reviewer. Kết quả đã đo (18.1) giữ nguyên.*
