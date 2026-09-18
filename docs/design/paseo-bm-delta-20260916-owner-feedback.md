# Delta-change — Góp ý của owner sau nghiệm thu: bớt vẽ việc, Dashboard gọn hơn

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260916-owner-feedback` |
| Tài liệu gốc | [Technical Design Dashboard](paseo-bm-dashboard.md) §2, §4.2 · `plugin/roles/{manager,worker,reviewer}.md` |
| Status | **Accepted, Applied** — owner yêu cầu trực tiếp ngày 2026-09-16 |
| Owner | hieu.nt10 |

## 1. Owner nói gì

1. Yêu cầu "thêm docstring cho `format_date`, không sửa gì khác" bị biến thành một chuỗi review và việc lan man.
2. Dashboard quá dài dòng; muốn dạng **graph**, bấm vào node mới mở chi tiết.
3. Cần **tổng quan nhanh**: thẻ số liệu và biểu đồ về việc, token, chi phí, tin nhắn.
4. Việc ngoài mục tiêu chỉ nên **tư vấn và hỏi**. Không over-engineering.

## 2. Đã đổi

**Hướng dẫn agent**

| File | Đổi |
|---|---|
| `worker.md` | Mục mới *"Do exactly what was asked"*: việc ngoài yêu cầu ghi thành `Suggestion (not done): …` trong báo cáo `finished`, không tự làm. Không sửa finding non-blocking. Có **đường nhanh cho Small**: 1 bead ngắn → sửa → kiểm tra rẻ nhất → 1 review → đóng; chỉ gửi `received` và `finished`. Repo không có lệnh test **không còn** là điểm dừng. Provenance chỉ một dòng |
| `reviewer.md` | Review theo **yêu cầu**, không theo sự hoàn hảo. Việc yêu cầu không đòi hỏi luôn là non-blocking. Re-review chỉ kiểm finding blocking cũ. Tối đa 3 finding non-blocking |
| `manager.md` | Không tự thêm yêu cầu vào prompt của Worker; người dùng đã nêu size thì dùng, không tranh luận; báo lại ngắn; gợi ý của Worker được đưa lên thành câu hỏi cho người dùng |

**Rút gọn ba file hướng dẫn (lượt góp ý thứ hai)**

Owner thấy hướng dẫn quá dài, luật quan trọng không nổi bật, dễ làm model lẫn. Đánh giá:

- **Lặp lại:** luật dừng có ở 3 chỗ; ngân sách, label, heading, Provenance mỗi thứ 2–3 chỗ. Mỗi bản lặp là một chỗ có thể lệch nhau.
- **Không có thứ bậc:** luật cấm tuyệt đối viết cùng giọng với chi tiết vặt.
- **Đoạn giải thích "tại sao"** có ích cho người đọc, nhưng là nhiễu với model.

Đã làm:

- Mỗi file mở đầu bằng khối `## RULES`, các luật cứng viết hoa (`NEVER`, `ASK THE USER FIRST`, `DO ONLY WHAT WAS ASKED`).
- Mỗi luật chỉ viết một lần; các bước viết ngắn.
- Độ dài: `worker.md` 521 → 220 dòng, `reviewer.md` 190 → 105, `manager.md` 224 → 124.
- Giữ nguyên văn những gì code phụ thuộc: khối `BM-REPORT`, khối `BM-REVIEW`, dòng `BM-REVIEW STOPPED`, các nhãn `bm.*`, cách chọn mode.
- Năm file test kiểm từng câu chữ được gộp thành `test/roles-content.test.ts`, kiểm **quy tắc** chứ không kiểm văn phong.

**Dashboard**

- Trên cùng: 6 thẻ — Requests, Beads, Agents, Messages, Tokens, Cost (tạm tính).
- Hai biểu đồ cột: số request 7 ngày gần nhất; các request tốn token nhất.
- Mỗi request là một dòng gọn; bấm để mở **graph** Request → Worker → Reviewer. Bấm từng node để xem: đã hỏi gì, trả lời gì, mất bao lâu, token, bead, các bước quy trình trên **một dòng** (`✓` làm, `–` không cần, `?` không rõ).
- Lưu trữ và thao tác xoá được gấp lại ở cuối.
- Hợp đồng: `TraceSummary` thêm `messageCount`.

Các quy tắc trung thực giữ nguyên (liên kết theo thời gian, số đếm lệch, workspace không còn) — giờ hiện trong chi tiết node Request thay vì chiếm chỗ trên danh sách.

## 3. Góp ý lượt ba: tin người dùng nhắn trực tiếp và skill đã load

Owner muốn trace cho thấy (1) khi người dùng tự nhắn cho Worker (hoặc agent khác), và (2) mỗi agent đã load skill nào.

Dữ kiện kiểm trên daemon thật, không đoán:

| Việc | Tín hiệu | Kiểm |
|---|---|---|
| Tin do người dùng gõ | `user_message` có `clientMessageId`; tin agent gửi bằng `send_agent_prompt` không có | Manager của owner: 15/15 tin có trường này đều do owner gõ, 43/43 tin không có đều là `BM-REPORT`. Worker `d91ccf32` của owner: nhận ra 4 tin owner nhắn thẳng |
| Load skill | Claude Code: `tool_call` tên `Skill`, `detail.label` = tên skill. Provider khác: đọc `<skill>/SKILL.md` (chỉ là suy luận); `ls`/`test -f` không tính | Worker F-4: nhận ra `feature-workflow`; Manager (chỉ kiểm skill): không nhận nhầm |

Đã làm (bead `bm-fyi`, `bm-roy`):

- Collector ghi `origin: user | agent` cho mỗi tin đến. Bản ghi cũ không có trường này nên **không bao giờ** được coi là tin của người dùng.
- Collector ghi bằng chứng `skill` cho mỗi lần load.
- `TraceSummary.userMessageCount`; `TraceDetail.userMessages`, `TraceDetail.skills`.
- Dòng request hiện `💬 N from you`. Node Worker/Reviewer hiện `Skills loaded: …` và từng tin `💬 You → <agent> (giờ): …`. Node Request hiện tập skill đã dùng và các tin người dùng gửi Manager.
- Bằng chứng skill không ảnh hưởng bảng bước quy trình.

## 4. Quyết định của owner: bỏ một luật cấm của Manager

Ngày 2026-09-16, owner yêu cầu bỏ khỏi `manager.md` dòng *"NEVER commit, push, open pull requests, publish, run destructive commands, or read credential files."* vì không muốn hạn chế các quyền này với Manager.

- Đã bỏ. Manager vẫn giữ các luật khác: không tự làm việc (tài liệu, bead, code), không lưu trữ/xoá agent, không đọc hội thoại của agent khác, không duyệt quyền thay người dùng.
- Worker và Reviewer **giữ nguyên** luật cấm của chúng.
- Rủi ro đã nêu với owner: dòng này gồm cả việc **cấm đọc file credential**, vốn là cốt lõi an toàn của sản phẩm theo `AGENTS.md`. Sau thay đổi, Manager không còn luật nào chặn việc đó. Owner là người chấp nhận rủi ro.
- Test `roles-content.test.ts` khẳng định dòng này không còn trong `manager.md`, để không ai vô tình thêm lại.

## 5. Nghiệm thu

Đợt chạy F-3 (Large) **đã dừng** theo góp ý này: nó đang chạy đúng kiểu quy trình nặng mà owner phê bình, và kết quả không còn đại diện cho hướng dẫn mới. Các phép đo đã có (F-1, F-2, D-1, D-6, D-7) vẫn giữ trong [biên bản](../operations/paseo-bm-dashboard-run-20260916.md).

## 6. Review và đơn giản hoá code

Ngày 2026-09-16, owner yêu cầu review lại toàn bộ code và đơn giản hoá. Hành vi giữ nguyên, trừ các lỗi dưới đây. Hai thay đổi contract (nội bộ plugin, client và server luôn đi cùng một bản):

| Chỗ | Trước | Sau | Lý do |
|---|---|---|---|
| `store` trong `traces.list` / `traces.delete` / `traces.reassign` | `{ traces, bytes, workspaceBytes }` | `{ bytes, workspaceBytes }` | §3.6 nói kích thước tính bằng `stat`, không đọc nội dung; code cũ đọc toàn bộ bản ghi chỉ để đếm `traces`, và client đã không hiển thị số này |
| `traces.delete` → `deleted` | `{ traces, bytes }` | `{ traces, bytes, running }` | REQ-054e (báo trước khi xoá request còn đang chạy) chưa từng hoạt động: client luôn truyền danh sách rỗng. Giờ server đếm số request trong phạm vi xoá còn agent `running` |

Lỗi tìm thấy và đã sửa:

- **`sent.userRequest` có thể là một `BM-REPORT`**: trước đây lấy tin đầu tiên của lượt Manager đầu tiên; giờ lấy đúng tin mà bước dựng lại đã chọn làm yêu cầu.
- **Thông báo STOP bị đếm là một lần gọi review**: tin plugin gửi Reviewer khi người dùng dừng Worker không còn được tính.
- **Gộp workspace (`traces.reassign`) làm mất dòng không đọc được**: nay các dòng đó được giữ nguyên, đúng luật "không xoá dữ liệu mình không hiểu".
- **Tin người dùng gửi một Worker đã bị xoá bị ghi là gửi Manager**: nay lọc theo vai trò của agent.
- **Hai module đọc lệnh `br` theo hai luật khác nhau** (đếm bead và bảng bước quy trình): nay dùng chung `server/shell.ts`, nên `br close` trong chuỗi trích dẫn không còn bị tính là đã đóng bead.
- **Đếm finding chặn của Reviewer luôn trả `null`** với định dạng `reviewer.md` quy định (`- severity: blocking`): nay đếm đúng.

Đơn giản hoá: helper dùng chung `shared/order.ts` (`byAt`, `uniqueBy`) và `client/ui.tsx` (`StatCards`, `BarChart`, `Chip`); một lần gọi `workspaces.list` cho mỗi `traces.get`; bỏ code chết (`totalUsage`, `beadsStoreDirectory`, `describeStoredWorkspaces`, `DASHBOARD_VIEW`, `DashboardSettings`, `beadIdsInCommand`); gom các kiểu `DeleteScope` bị trùng về `TraceDeleteScope`; sửa các doc comment đặt sai chỗ.

Chưa làm (gợi ý): Beads của một workspace đã đóng vẫn báo "không được Paseo liệt kê". Có thể dùng `lastKnownDirectory` trong metadata của kho vết để đọc bead khi thư mục còn tồn tại.

## 7. Icon theo vai trò trên graph của Metric

Ngày 2026-09-16, owner yêu cầu dùng icon nhỏ, màu dịu, dễ nhận ra để biết agent nào làm gì trên graph của Metric.

- Mỗi node có một icon Lucide đặt trên nền tròn nhạt (độ đậm 16%) của một màu lấy từ theme: **Manager** `BotMessageSquare` màu accent, **Worker** `Hammer` màu success, **Reviewer** `ScanEye` màu warning. Node request được coi là node của Manager, vì Manager là agent xử lý request.
- Màu danger không dùng cho vai trò; nó để dành cho lỗi. Hình icon khác nhau nên vẫn phân biệt được dù hai màu trông gần nhau.
- Trên danh sách request có một dòng chú giải: icon, tên vai trò và việc vai trò đó làm.
- Icon lấy từ `Icon` mà Paseo 0.8 cung cấp cho plugin (`@getpaseo/plugin/client/react-native`). Đã kiểm trong bundle của app: tên icon được phân giải theo Lucide, tên không tồn tại thì không vẽ gì chứ không lỗi. Bảng vai trò nằm ở `ROLE_MARK` trong `dashboard-model.ts` và có test.

## 8. "Danh sách beads giữa các project bị lẫn"

Ngày 2026-09-16, owner báo danh sách beads giữa các project hiện lẫn lộn. Đã kiểm trên daemon thật bằng cách gọi `beads.list` cho từng workspace:

- Mỗi workspace đọc đúng file `.beads/issues.jsonl` trong thư mục của chính nó. Cache phía server tách theo đường dẫn, query phía client có `workspaceId` trong key, và màn hình được dựng lại mỗi lần đổi workspace.
- **Nguyên nhân thật:** repo `bead_view_advance` (workspace "Build bva terminal UI for beads reporting") chứa một **bản sao cũ** (ngày 10/09) của beads thuộc `xspace-customer`: cả 183 bead trùng id và tiêu đề. Màn Beads của workspace đó hiện đúng dữ liệu của file đó, nhưng giao diện không cho biết file nằm ở đâu, nên trông như bị lẫn.

Đã sửa để không thể nhầm, và chặn một lỗi có thể xảy ra:

- Màn Beads ghi `Read from <đường dẫn file>`.
- Tiêu đề màn Metric và Beads ghi thêm tên project khi tên workspace khác tên project (`Build bva terminal UI… · bead_view_advance`).
- **Lỗi tiềm ẩn đã chặn:** khi tìm thư mục của workspace, server có thể lấy `projectRootPath` làm dự phòng. Với một worktree, đó là thư mục của bản checkout chính, nên các worktree của cùng repo sẽ thấy chung beads của bản chính. Nay worktree không bao giờ dùng `projectRootPath`, và trường `workspaceDirectory` cũng được đọc. Có test.

Không sửa dữ liệu trong `bead_view_advance`: đó là repo của owner, và theo luật của dự án không xoá bead.

## 9. Bead đang làm: ai làm, làm từ bao giờ

Ngày 2026-09-16, owner yêu cầu màn Beads cho biết một bead đang làm thì Worker nào làm và làm từ bao giờ.

- **File bead không có thông tin này:** `br` không ghi thời điểm bắt đầu, và Worker không đặt `assignee`. Thông tin được suy ra từ **kho lưu vết**, chỉ tính các lượt của Worker:
  - **bắt đầu**: lệnh gần nhất đưa bead sang `in_progress` (`br update <id> --status in_progress`, `--status=in_progress`, `-s in_progress` hoặc `--claim`);
  - **hoạt động gần nhất**: lệnh hoặc `BM-REPORT` gần nhất có nhắc tới id của bead (khớp nguyên id: `x.1` không khớp `x.12`).
- Contract: `BeadRow.work = { started, last } | null`. Mỗi mốc gồm `{ agentId, at, title, status }`; `status` là trạng thái hiện tại của Worker, `null` khi Paseo không còn liệt kê Worker đó. `work` chỉ có giá trị với bead `in_progress`.
- **Không đoán:** nếu không có lệnh đặt trạng thái, màn hình ghi "start not recorded" và chỉ hiện hoạt động gần nhất. Nếu một Worker khác nhận bead sau đó, màn hình hiện Worker mới cùng giờ hoạt động của nó, không mượn giờ bắt đầu của Worker cũ.
- Không có kho lưu vết thì danh sách bead vẫn đầy đủ, chỉ thiếu tên Worker.
- Giao diện:
  - dòng bead có thêm một dòng nhỏ kèm icon Worker: `<Worker> · since <giờ> (<bao lâu>) · <trạng thái>`;
  - phần chi tiết có khung "Being worked on" và nút "Open the Worker";
  - thẻ "Longest in progress" tính từ lúc bắt đầu nếu biết.
- Kiểm trên daemon thật: bead `cus-contact-uiux-redesign-u9zv.12` của `xspace-customer` hiện Worker "Worker — thiết kế lại UI màn Contact" (`d91ccf32`, đang rảnh), bắt đầu lúc 10:06:12 UTC. Mốc này lấy từ lệnh `br update …u9zv.12 --status=in_progress` nằm cuối một chuỗi lệnh `br close …`, và hoạt động gần nhất là lúc 10:14:11. Các bead `in_progress` không có dấu vết Worker nào (ví dụ hai bead trong `bead_view_advance`) trả `work: null`.

## 10. Màn Beads Manager gọn trên điện thoại, có số liệu

Ngày 2026-09-16, owner gửi ảnh chụp trên điện thoại: mỗi workspace chiếm cả màn hình vì có ba nút full-width. Owner muốn gọn lại, và muốn thấy ngay số bead (tổng, đang làm, bị chặn) cùng số Worker đang chạy.

- RPC mới `workspaces.overview({})`, chỉ đọc, gọi một lần cho cả màn: với mỗi workspace đang có (bỏ qua workspace đã lưu trữ) trả `beads { total, inProgress, blocked, ready }` (null khi không có kho bead) và `runningWorkers`. Màn hình tự làm mới mỗi 10 giây.

  *Errata 2026-09-17:* RPC này thêm `runningAgents { manager, worker, reviewer }`; `runningWorkers` giữ nguyên nghĩa và bằng `runningAgents.worker`. Xem [delta 20260917e](paseo-bm-delta-20260917e-manager-screen-and-commands.md) §4.2.
- Mỗi dòng gồm:
  - tên (1 dòng) và project;
  - bốn con số kèm icon: `Layers` tổng, `CircleDot` đang làm, `Ban` bị chặn, `Hammer` Worker đang chạy; số bằng 0 hiện màu xám;
  - ba nút nhỏ có icon trên **một hàng**, kể cả trên điện thoại: **Go to** (màu nhấn), **Metric**, **Beads**.
- Đoạn giới thiệu đầu màn rút còn một câu.
- Kiểm trên daemon thật: paseo-bm 146 / 1 / 0 / 0; bead_view_advance 183 / 2 / 13 / 0; xspace-customer 283 / 1 / 1 / 0; bm-demo-dashboard 3 / 0 / 0 / 0; xspace-shell không có kho bead.

## 11. Review và đơn giản hoá phần làm từ tối (thẻ chat, Setup, `br`/`bv`)

Ngày 2026-09-16, owner yêu cầu review lại kỹ phần làm từ tối và cả README.

**Code:**

- **Tách module:** các RPC của chat (`chat.peers`, `chat.beads`, `beads.lookup`) chuyển sang `plugin/server/chat-rpc.ts`, có hàm đăng ký riêng (`registerChatRpcs`) để tránh vòng import. `dashboard-rpc.ts` gọn lại, chỉ còn phần của Dashboard.
- **Một vòng đọc timeline dùng chung:** `readTimelinePages` trong `live-timeline.ts`, dùng cho cả Metric lẫn panel "Beads in this chat". `mergeExtras` chuyển sang `byAt`/`uniqueBy`.
- **`chat.beads`:** bỏ trường thứ tự và bước sort thừa, vì Map đã giữ thứ tự lần nhắc mới nhất.
- **`role-hook`:** bỏ bảng hướng dẫn trùng; hướng dẫn gốc lấy từ `BASE_INSTRUCTIONS` của `role-extras`.
- **`bead-work`:** dựng regex một lần cho mỗi mã bead, và gom các mã được bắt đầu của mỗi lệnh thành một Set, thay vì dựng lại regex cho mỗi lệnh.
- **Setup:**
  - `--version` của ba công cụ chạy song song;
  - RPC `setup.install-tool` bắt buộc `confirmed: true` (thêm một lớp chặn lời gọi nhầm; đã kiểm trên daemon thật: thiếu cờ thì bị từ chối ngay ở schema);
  - nút Copy trở về chữ "Copy" sau 2 giây.
- **Test khoá lệnh cài:** lệnh cài `br`/`bv` của CLI và của màn Setup phải trùng nhau (`src/` và `plugin/` không dùng chung code được).

**README:**

- Phần giới thiệu và bảng thành phần có thêm màn Setup, thẻ chat, và việc trình cài tự cài `br`/`bv`.
- Mục Requirements gộp `br`/`bv` thành một dòng: bỏ câu "`bd` also works" (Worker dùng `br`), và ghi rằng trình cài tự cài công cụ còn thiếu.
- Bước cài số 9 tách lệnh thành danh sách. Màn Setup chỉ trỏ về bước này, không lặp lại lệnh.
- Mục gỡ cài đặt ghi rõ những gì được giữ lại: `role-extras.json`, `br` và `bv`.
- Troubleshooting có thêm `--install-beads-tools`, cảnh báo `W_BEADS_TOOLS_INSTALL_FAILED`, và lưu ý `PATH` của daemon có thể khác `PATH` của terminal.
- Known limits có thêm hai giới hạn (thẻ chat chỉ áp dụng cho tin của paseo-bm; hướng dẫn bổ sung áp dụng cho agent tạo sau và cho toàn máy). Bỏ mục "in-Paseo skills reminder", vì màn Setup đã hiện trạng thái skill.
- Mục thẻ chat gộp lại cho ngắn hơn.
