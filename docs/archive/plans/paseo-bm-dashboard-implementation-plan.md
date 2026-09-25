# paseo-bm — Dashboard điều phối: Implementation Plan

| Trường | Giá trị |
|---|---|
| Status | **Completed** (2026-09-25) — mọi bead của plan đã đóng; từ nay tài liệu sống thay cho chuỗi delta (xem `AGENTS.md`, mục Process). Trạng thái trước: **Active** |
| Plan-ready | **PASS — 2026-09-16 — hieu.nt10**, với đúng một ngoại lệ đã ghi: **WP-213 nằm ngoài phạm vi chuyển thành beads** cho tới khi Q-039b và Q-043 được trả lời (xem §7). 13 WP còn lại chuyển được |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Created | 2026-09-16 |
| Routing decision | [PRD Dashboard §0](../../product/paseo-bm-dashboard-prd.md#0-routing-decision) (canonical owner cho tính năng này) |
| Source PRD | [PRD Dashboard điều phối](../../product/paseo-bm-dashboard-prd.md) — REQ-040 → REQ-057 |
| Source Technical Design | [Technical Design Dashboard](../../design/paseo-bm-dashboard.md) (Draft) |
| Related ADRs | [ADR-007](../../adr/ADR-007-dashboard-trace-store.md) (Proposed — plan này thi hành đúng chín quyết định của nó) · [ADR-002](../../adr/ADR-002-install-ownership-model.md) · [ADR-005](../../adr/ADR-005-manager-as-agent.md) |
| Delta-change bắt buộc | [`design-delta-20260916-trace-store`](../design/paseo-bm-delta-20260916-trace-store.md) (Draft) |
| Phase | **Phase 2a MVP**, chia hai chặng: **Phase 2a-1 MVP** (thu thập và đọc được) → **Phase 2a-2 MVP** (diễn giải, giao diện, vòng đời dữ liệu) |
| Quan hệ với plan Phase 1 | [Plan bản 2](paseo-bm-implementation-plan-v2.md) (Active, Plan-ready PASS) vẫn nguyên; plan này là tài liệu **riêng** cho Phase 2, không sửa plan đó |

## 0. Điều kiện tiên quyết ngoài phạm vi work package

Bốn cổng tài liệu dưới đây **đã xong ngày 2026-09-16**:

1. ✅ PRD Dashboard — `prd-ready` PASS, Status `Accepted`.
2. ✅ Technical Design Dashboard — `design-ready` PASS, Status `Active`.
3. ✅ [ADR-007](../../adr/ADR-007-dashboard-trace-store.md) — `Accepted`.
4. ✅ Delta-change [`design-delta-20260916-trace-store`](../design/paseo-bm-delta-20260916-trace-store.md) — `Accepted` **và** `Applied`: design gốc §3.1, §3.3, §4.4, §5, §8; PRD gốc REQ-010(f), REQ-012(i); ADR-002 mục bổ sung.

**Còn một điều kiện chưa xong, và nó chặn đúng một WP:** Q-039b (hành vi lệnh gỡ với kho lưu vết, và **tên cờ** cho chế độ không tương tác) cùng Q-043 (`doctor` có báo tình trạng kho không) vẫn mở. Tên cờ là hợp đồng công khai của CLI nên **không được phát minh trong lúc implement**. Vì vậy **WP-213 nằm ngoài phạm vi chuyển thành beads**; 13 WP còn lại chuyển được ngay.

Riêng hai giả định **A-1** và **A-2** (PRD §11) không chặn việc bắt đầu: chúng được trả lời **bên trong** WP-205 bằng quan sát trên daemon thật, và điều kiện ra của WP-205 yêu cầu ghi lại câu trả lời.

## 1. MVP-Lock

### Phase 2a-1 MVP — thu thập và đọc được

- **Trong chặng này:** REQ-041 (dữ liệu, chưa có giao diện), REQ-042 (a)(b)(d)(e), REQ-043 (a)(b)(c)(d) phần dữ liệu, REQ-044, REQ-046, REQ-047, REQ-048 (a)(b)(c), REQ-049, REQ-050, REQ-053. Bằng chứng **tiền kiểm** cho **D-8** và phần dữ liệu của **D-2 → D-4**, **D-6**, **D-7**. *(D-8 chính thức PASS ở WP-214, vì nó đòi 5/5 yêu cầu mẫu.)*
- **Vì sao chặng này đứng riêng:** khi bộ thu thập đã chạy, mọi yêu cầu người dùng giao từ lúc đó trở đi **bắt đầu được lưu vết** — nên **hoàn tất và nạp thử** chặng này sớm (cài lại payload rồi `paseo plugin reload`) làm lịch sử dày lên trong khi giao diện còn đang làm. Chặng này **không** phát hành npm; không WP nào publish. Nó cũng là chặng trả lời A-1 và A-2, hai ẩn số duy nhất còn lại của thiết kế.
- **Exit criteria:**
  1. Mọi AC của các REQ trên đạt, có test tương ứng.
  2. Ba RPC của chặng này (`traces.list`, `traces.get`, `beads.stats`) trả đúng dữ liệu trên `PaseoApi` giả lập và `$HOME` giả; hợp đồng của `traces.delete` và `traces.reassign` đã khoá ở WP-201 nhưng phần thực thi thuộc chặng 2a-2.
  3. **A-1 và A-2 được trả lời bằng quan sát trên daemon thật**, ghi vào một biên bản trong `docs/operations/`.
  4. **Smoke proof cho đường lưu vết:** trace của **một** yêu cầu thật đọc lại được nguyên vẹn sau reload plugin, khởi động lại daemon, và sau khi agent bị lưu trữ rồi xoá. **Không được ghi là D-8 PASS** — D-8 đòi 5/5 yêu cầu mẫu và thuộc WP-214.
  5. Bộ bất biến phủ định của REQ-047 xanh: không ghi ngoài `<install home>/traces`, không mạng, không tạo/dừng/xoá agent.
  6. `npm run typecheck && npm run lint && npm test && npm run build` sạch.

### Phase 2a-2 MVP — diễn giải, giao diện và vòng đời dữ liệu

- **Trong chặng này:** REQ-040, REQ-042 (c), REQ-043 (e), REQ-045, REQ-048 (d), REQ-051, REQ-052, REQ-054, REQ-055, REQ-056, REQ-057. Chỉ số **D-1**, **D-5**, **D-9**, **D-10**, **D-11**, và phần còn lại của D-2 → D-4, D-6, D-7.
- **Exit criteria:**
  1. Mọi AC P2 còn lại đạt.
  2. **D-1 → D-11 đều đạt** trong một đợt nghiệm thu trên daemon thật theo checklist mới của WP-214, có run record trong `docs/operations/`.
  3. Xoá và gán lại có ảnh chụp hệ thống file trước–sau chứng minh không file nào ngoài `traces/` bị thay đổi.
  4. Một lần cập nhật phiên bản thật chứng minh kho lưu vết còn nguyên (REQ-056c).
  5. Delta-change đã `Applied`; **lệnh gỡ** phản ánh đúng quyền sở hữu kho lưu vết. `doctor` chỉ đổi nếu Q-043 được owner trả lời "Có" **trước khi** WP-213 được phân rã; trả lời "Không" thì `doctor` nằm ngoài phạm vi WP-213 và ngoài điều kiện ra này.
  6. README nêu Dashboard, cách xoá trace, và câu cảnh báo về việc nội dung hội thoại được lưu trên đĩa.

### Ngoài phạm vi Phase 2a (dễ bị tưởng là có)

- Gộp số liệu nhiều workspace, biểu đồ theo thời gian, xuất báo cáo — Phase 2b.
- Tách nhóm theo nhãn `phase:*` / `wp:*` — Phase 2b.
- REQ-016 (nhắc skills trong Paseo), REQ-017, REQ-028 (lệnh `configure`), REQ-029 (giới hạn Worker song song) — vẫn là Phase 2 nhưng **không** thuộc tính năng này.
- Tự động xoá, tự nén, xoay vòng theo tuổi hay dung lượng — ADR-007 quyết định 6 **cấm**.
- Tự khớp workspace cũ với workspace mới — ADR-007 quyết định 11 **cấm**; chỉ người dùng gán lại.
- Đồng bộ kho lưu vết giữa nhiều máy.
- Sửa `BM-REPORT` để thêm field mới. Plan này chỉ **đọc** khối đó; đổi định dạng là một delta khác.

### Default checkpoint posture

Mọi WP là thay đổi mã cục bộ trong một repo, hoàn tác bằng git. Trên máy người dùng, phần mới duy nhất ghi ra đĩa là `<install home>/traces/`; nó **giới hạn được** (nằm trong một thư mục, có chức năng xoá) chứ không phải đảo ngược được — dữ liệu đã ghi thì chỉ có đường xoá, không có đường hoàn tác. **Ba điểm không đảo ngược được:**

1. **Người dùng xoá trace** (REQ-054): xoá là xoá thật, không có thùng rác. Containment: luôn có bước xem trước nêu số trace và dung lượng, xác nhận mặc định "Không", và phạm vi xoá được kiểm đường dẫn trước khi chạm đĩa.
2. **Gán lại trace** (REQ-057): sau khi gộp vào workspace đích thì không tách lại được. Containment: xem trước + xác nhận; `workspaceId` gốc vẫn nằm trong từng bản ghi và hiện ra ở `reassignedFrom`, nên vẫn biết nó từng thuộc đâu.
3. **Bump phiên bản chỉ dẫn vai trò** (WP-212): agent đã tạo bằng bản cũ giữ system prompt cũ suốt đời nó. Containment: bộ nhóm trace phải chạy đúng cho cả agent có và không có nhãn, nên bump không làm hỏng lịch sử.
Phase 2a **không** phát hành npm: không WP nào publish, và điều kiện ra của phase không đòi một bản trên registry. Khi nào phát hành thì theo [release runbook](../../operations/paseo-bm-release-runbook.md) sẵn có, dist-tag `next` như Phase 1.

Ngoài ra có một điểm **nhạy cảm nhưng đảo ngược được**: từ nay nội dung hội thoại agent nằm trên đĩa. Containment gồm ba lớp — che bí mật trước khi ghi, quyền `0600`/`0700`, và người dùng xoá được bất cứ lúc nào.

> Sau khi mục này được duyệt, phạm vi không được thêm nếu không có delta-change.

## 2. Work Packages

### Phase 2a-1

#### WP-201: Hợp đồng RPC, lược đồ lưu vết và bảng giá

- **Outcome:** `shared/contracts.ts` có hợp đồng Zod cho năm RPC mới (`traces.list`, `traces.get`, `traces.delete`, `traces.reassign`, `beads.stats`) cùng các kiểu dùng chung (`confidence`, `evidence`, `usage`, `TraceSummary`, `TraceDetail`, `BeadStats`); `shared/settings.ts` khai báo cài đặt `warnAboveBytes`; `shared/prices.ts` có bảng giá kèm `pricesUpdatedAt`. Sáu mã lỗi mới được đặt trong một hằng số duy nhất, không rải rác.
- **Requirement / AC coverage:** REQ-041 (b)(d), REQ-046 (a), REQ-052 (c)(d), REQ-053 (b) phần lược đồ, REQ-055 (d)(f).
- **Design refs:** Dashboard Design §4, §5, §9; `shared/` hiện có làm khuôn.
- **Prerequisites:** không (sau khi §0 xong).
- **Risk boundaries:** đây là **hợp đồng công khai** của plugin và là lược đồ của dữ liệu bền. Sai tên trường ở đây thì sửa sau phải di trú. `shared/` không được import Node hay React Native — đã có test bundle canh việc này.
- **Exit condition:** typecheck payload sạch; test khẳng định mọi schema parse được mẫu hợp lệ và **từ chối** mẫu thiếu trường bắt buộc; test khẳng định `shared/` không import Node/React Native; `pricesUpdatedAt` là ngày thật, không phải chỗ trống.

#### WP-202: Định vị thư mục cài đặt từ cấu hình Paseo

- **Outcome:** `server/install-home.ts` trả về `<install home>` theo ba bước của Design §3.1: đọc `config.plugins["paseo-bm"].path` rồi lùi hai cấp, xác nhận bằng `install.json`, dự phòng `~/.paseo-bm`; không tìm được thì trả `null` và tính năng lưu vết **tắt có thông báo** thay vì ném lỗi.
- **Requirement / AC coverage:** REQ-053 (b) phần vị trí, REQ-049 (d).
- **Design refs:** Dashboard Design §3.1; errata bm-dnc của design gốc (bundle server không có cwd).
- **Prerequisites:** WP-201 (mã lỗi).
- **Risk boundaries:** đây là chỗ duy nhất trong plugin biết vị trí trên đĩa. Nó **chỉ đọc** `install.json`, không bao giờ ghi. Phải chịu được `--home` khác mặc định và cấu hình không có mục plugin.
- **Exit condition:** test cho năm tình huống: (1) path chuẩn và (2) `--home` khác mặc định đều trả **đúng** `<install home>`; (3) `install.json` thiếu, (4) mục `plugins` không có `paseo-bm`, và (5) `config.get()` lỗi đều trả `null` kèm lý do đọc được, **không ném**.

#### WP-203: Kho lưu vết — ghi, đọc, lược đồ, dung lượng

- **Outcome:** `server/trace-store.ts` tạo bố cục `traces/<workspaceId>/events-<YYYYMM>.jsonl` với `meta.json` hai cấp; nối bản ghi bằng `O_APPEND` + `fsync`; đọc theo file tháng từ mới tới cũ có loại trùng `(agentId, turnId)`; bỏ qua dòng hỏng và đếm `skippedLines`; quyền `0700`/`0600`; đo dung lượng bằng `stat`; từ chối ghi khi `schemaVersion` cao hơn mức hiểu.
- **Requirement / AC coverage:** REQ-053 (a)(b)(c), REQ-049 (a) phần trần đọc, REQ-048 (c), REQ-055 (a).
- **Design refs:** Dashboard Design §3.2, §3.3, §3.4, §3.6.
- **Prerequisites:** WP-201, WP-202.
- **Risk boundaries:** **WP này tạo ranh giới ghi mới đầu tiên của plugin.** Ba bất biến phải có test: (1) mọi đường dẫn đi qua **bộ kiểm no-follow của Design §3.8** — kiểm mẫu `workspaceId`, kiểm tiền tố sau `resolve`, **và `lstat` từng thành phần để từ chối symlink ở mọi cấp**, vì kiểm tiền tố chuỗi một mình không bắt được symlink giữa đường; (2) mọi thao tác sửa kho lấy mutex theo `workspaceId` của §3.8; (3) lỗi ghi không bao giờ ném ra ngoài. Đây cũng là chủ sở hữu duy nhất của lược đồ dữ liệu bền và của mọi đường dẫn vào kho — không module nào khác được tự dựng đường dẫn.
- **Exit condition:** test: ghi rồi đọc lại; dòng trùng; dòng hỏng; **dòng cuối bị ghi dở** (bỏ qua, tính vào `skippedLines`, các dòng trước vẫn đọc được); nhiều file tháng; `schemaVersion` mới hơn (đọc hạn chế, không ghi); hết đĩa và thiếu quyền (lỗi bị nuốt, có log); cắt trường dài; quyền **`0700` cho `traces/` và thư mục workspace, `0600` cho `meta.json`, file tháng và file tạm**; đo dung lượng khớp `stat`. **Test symlink tại bốn cấp** (`traces/`, thư mục workspace, file tháng, file tạm): mọi trường hợp bị từ chối bằng `E_TRACE_STORE_UNWRITABLE` và **đích của symlink không đổi một byte**. **Test barrier:** nối bản ghi đồng thời với một thao tác sửa khác không mất và không nhân đôi bản ghi.

#### WP-204: Bộ đọc `BM-REPORT` và `BM-REVIEW`

- **Outcome:** `server/bm-report.ts` đọc mọi khối `BM-REPORT`/`BM-REVIEW` trong một đoạn văn bản, khoan dung với thiếu field, field lạ, thứ tự khác, chữ hoa khác, nhiều khối một tin nhắn, và khối bị trích dẫn lại; trả về cấu trúc đã chuẩn hoá kèm `unparsedFields`.
- **Requirement / AC coverage:** REQ-050 (a)(b)(c), REQ-044 (b) phần nguồn dữ liệu, REQ-042 (c) phần đọc `guardrail`.
- **Design refs:** Dashboard Design §6 (đoạn "Bộ đọc `BM-REPORT`"); `plugin/roles/worker.md` mục Reporting là định dạng nguồn.
- **Prerequisites:** WP-201.
- **Risk boundaries:** đây là **hợp đồng đang được tiêu thụ**: định dạng do `roles/*.md` sinh ra, và nó sẽ đổi. Bộ đọc không được vỡ vì một field lạ, và phải đọc được cả định dạng của bản chỉ dẫn trước.
- **Exit condition:** test cho đủ các tình huống ở Design §15 hàng `bm-report.ts` (khối `BM-REVIEW`; khối đủ field; thiếu field; field lạ; nhiều khối một tin nhắn; khối bị trích dẫn lại; chữ hoa khác; `none`; id nhiều dấu phân cách; khối của bản chỉ dẫn trước), gồm **khối của bản chỉ dẫn hiện tại và một biến thể thiếu field** (REQ-050c); id bead tách đúng với dấu phẩy và khoảng trắng; `none` và chuỗi rỗng cho ra "không có" chứ không phải chuỗi `"none"`. **Khi fixture định dạng mới được thêm, test của định dạng trước vẫn phải xanh** (REQ-050b).

#### WP-205: Bộ thu thập theo hook

- **Outcome:** `server/collector.ts` đăng ký `on("agent.turn_started")` và `on("agent.turn_ended")`, lọc theo provider `bm-*`, che bí mật, rồi ghi một bản ghi lượt qua WP-203; cập nhật `meta.json` của workspace khi tên hay đường dẫn đổi; nuốt mọi lỗi; host không có hook thì log một dòng và trả no-op.
- **Requirement / AC coverage:** REQ-053 (a)(c)(d), REQ-048 (b), REQ-047 phần "không chặn agent".
- **Design refs:** Dashboard Design §2.2 quyết định 1, §3.3, §12; `plugin/server/stop-propagation.ts` và `role-hook.ts` là khuôn đăng ký hook sẵn có.
- **Prerequisites:** WP-203, WP-204.
- **Risk boundaries:** WP này chạy **trong đường sống của agent**. Một ngoại lệ thoát ra khỏi hook có thể làm hỏng lượt của agent thật, nên "nuốt lỗi" là yêu cầu chức năng, không phải lười. **Đây cũng là WP trả lời hai ẩn số A-1 và A-2**; nếu A-2 cho kết quả "timeline của hook không có `timestamp`", WP này thêm một lời gọi `timeline.refetch` cho cửa sổ lượt vừa xong — đường đó đã được thiết kế sẵn, không phải phạm vi mới.
- **Exit condition:** test: chỉ ghi cho agent `bm-*`; ba `outcome`; host thiếu hook; lượt không có `turn_started`; lỗi ghi không ném; chờ mutex quá hạn thì bỏ lượt và log (Design §3.8); che bí mật chạy **trước** khi ghi (khẳng định bằng nội dung file). **Benchmark có ghi môi trường:** p95 thời gian hook cho bản ghi lớn nhất **< 50 ms** (NFR hiệu năng); không đạt thì ghi số đo thật và **không** tuyên bố NFR đạt. **Kèm quan sát trên daemon thật**: chạy một yêu cầu, ghi vào biên bản câu trả lời cho A-1 (khối `BM-REPORT` xuất hiện dưới kiểu entry nào) và A-2 (timeline của hook có `timestamp` hay không), cùng đường đã chọn nếu phải đọc bù.

#### WP-206: Dựng trace, đo thời gian, và hai RPC đọc

- **Outcome:** `server/traces.ts` nhóm bản ghi thành trace theo năm bước của Design §6 (nhãn → `BM-REPORT` → prompt khởi tạo → thời gian → "không rõ"), gắn `linking`, đếm riêng số agent Reviewer và số lượt review, suy `state`, đo thời gian theo bốn mốc của §7, đọc bù timeline cho lượt đang chạy; `index.server.ts` đăng ký `traces.list` và `traces.get`.
- **Requirement / AC coverage:** REQ-041 (a)(b)(c)(d), REQ-042 (a)(b)(d)(e), REQ-043 (a)(b)(c)(d), REQ-044 (a)(c)(d), REQ-049 (a)(b)(c)(d).
- **Design refs:** Dashboard Design §6, §7, §3.4, §5.
- **Prerequisites:** WP-203, WP-204, **WP-205** (cần hợp đồng bản ghi thực tế và đường đọc đã chọn sau khi A-1/A-2 được trả lời), **WP-208** (cần hàm đọc bead theo id để làm giàu chi tiết bead — REQ-044a).
- **Risk boundaries:** đây là chỗ dễ **nói sai** nhất của cả tính năng. Hai quy tắc là bất biến, không phải tuỳ chọn: không gán bừa một agent vào trace gần nhất khi không có căn cứ (phải vào nhóm "không rõ"), và không bao giờ suy ra `0` cho một số đo thiếu mốc (phải là `null`).
- **Exit condition:** test cho tám tình huống nhóm trace ở Design §15 (khớp nhãn; khớp `BM-REPORT`; khớp prompt; theo thời gian; không xếp được; Worker mồ côi; Reviewer dùng lại; hai yêu cầu chồng thời gian) và bốn tình huống thời gian (lượt đang chạy; thiếu `finished`; agent bị xoá giữa trace; thiếu mốc). `traces.get` trả **đúng** trace cho một `traceId` tồn tại, và trả **đúng** `E_TRACE_NOT_FOUND` cho `traceId` không tồn tại; bead có trong báo cáo nhưng không còn trong kho được hiện kèm ghi chú "không còn trong kho" (REQ-044d).

#### WP-208: Thống kê beads

- **Outcome:** `server/beads-store.ts` đọc `<workspace>/.beads/issues.jsonl` (chỉ đọc), loại trùng theo `updated_at`, tính `total`/`open`/`inProgress`/`blocked`/`closed`/`ready`, cache theo `mtime`+`size`, chặn symlink ra ngoài workspace và trần 32 MB; `beads.stats` đăng ký trong `index.server.ts`. **Kèm một hàm đọc theo tập id** trả `{ id, title, status }` để WP-206 làm giàu chi tiết bead của trace (REQ-044a); hàm này là nội bộ, không thành RPC công khai.
- **Requirement / AC coverage:** REQ-046 (a)(b)(c)(d)(e), REQ-047 phần "chỉ đọc kho beads".
- **Design refs:** Dashboard Design §10.
- **Prerequisites:** WP-201.
- **Risk boundaries:** đọc **vào repo của người dùng**. Không bao giờ ghi, không gọi `br`, không sinh tiến trình con, không chạm `beads.db` (đang bị `br` khoá). `ready` phải tính theo phụ thuộc loại `blocks`, không phải `parent-child` — tính sai thì con số trông hợp lý mà vẫn sai.
- **Exit condition:** test: không có file; file rỗng; dòng hỏng; id trùng khác `updated_at`; `ready` với `blocks` chưa đóng, với `parent-child`, và với dep trỏ id không tồn tại; vượt trần kích thước; symlink ra ngoài. **Đối chiếu số với `br stats` và `br ready`** trên **ba** repo thật theo D-6, trong đó một repo không có `.beads/`. Hàm đọc theo id: trả đúng với id tồn tại, và **bỏ qua có báo** với id không còn trong kho.

### Phase 2a-2

#### WP-207: Suy ra bước feature-workflow

- **Outcome:** `server/workflow-steps.ts` trả về đủ mười một bước cố định, mỗi bước có `status` (`done`/`skipped`/`unknown`), `confidence`, và danh sách `evidence` dẫn được về nguồn; quy tắc `skipped` chỉ áp khi `tier` đọc được và REQ-036 cho phép mức đó bỏ bước đó.
- **Requirement / AC coverage:** REQ-045 (a)(b)(c)(d)(e).
- **Design refs:** Dashboard Design §8 (bảng tín hiệu và quy tắc `skipped`); PRD gốc REQ-036 là nguồn của quy tắc bỏ bước.
- **Prerequisites:** WP-204, WP-206.
- **Risk boundaries:** đây là chỗ duy nhất trong sản phẩm **kết luận về chất lượng quy trình của một agent**. Một ô "đã làm" sai sẽ làm người dùng tin vào một lượt chạy tồi; một ô "không làm" sai sẽ buộc tội oan. Vì thế: `done` phải có bằng chứng, `skipped` phải có phát biểu mức, còn lại là `unknown` — D-5 đo đúng hai điều này.
- **Exit condition:** test cho từng dòng tín hiệu của §8 (cả cột `exact` và cột `inferred`); `Small` bỏ bước là hợp lệ; `Medium` chỉ được `skipped` cho `polish_beads`; **không có `tier` thì không bao giờ ra `skipped`**; không bằng chứng thì `unknown`; mọi ô `done` đều kèm ít nhất một `evidence` khác rỗng.

#### WP-209: Token và chi phí

- **Outcome:** `server/cost.ts` tổng hợp `lastUsage` theo agent và theo trace; dùng `totalCostUsd` của provider khi có (`costBasis: "provider"`); không có thì tạm tính theo `shared/prices.ts` với **đơn giá cache riêng cho token cache** (`"estimated"`); model không có trong bảng thì `null` (`"unavailable"`).
- **Requirement / AC coverage:** REQ-052 (a)(b)(c)(d)(e)(f), REQ-041 (b) phần token và chi phí.
- **Design refs:** Dashboard Design §9.
- **Prerequisites:** WP-201, WP-206.
- **Risk boundaries:** một con số tiền sai làm mất niềm tin nhanh hơn mọi lỗi khác trong tính năng này. Ba ràng buộc: **không bao giờ gọi mạng** để lấy giá; token cache không được tính theo đơn giá token vào; và `pricesUpdatedAt` luôn đi kèm con số ra giao diện.
- **Exit condition:** test: có `totalCostUsd`; không có (tạm tính đúng tới từng xu với số đã biết); token cache tính theo đơn giá cache; model lạ cho `null` và `"unavailable"`; thiếu `lastUsage` hoàn toàn; khẳng định không có lời gọi mạng nào trong module.

#### WP-210: Xoá, gán lại, và phân loại workspace

- **Outcome:** `traces.delete` cho ba phạm vi (một trace, cũ hơn một mốc, toàn bộ workspace) với `dryRun` đếm trước; `traces.reassign` gán lại trace của một workspace không còn sang một workspace đang có, `rename` khi đích trống và gộp có loại trùng khi đích đã có; phân loại `live`/`archived`/`orphaned`/`unknown` đối chiếu `workspaces.list()`.
- **Requirement / AC coverage:** REQ-054 (a)(b)(c)(d)(e)(f), REQ-055 (a)(b)(c), REQ-057 (a)(b)(c)(d)(e)(f)(g). *(REQ-054(e) phần cảnh báo trên giao diện và (f) phần "không có đường tự xoá" được nghiệm thu cùng WP-211.)*
- **Design refs:** Dashboard Design §3.5, §3.6, §3.7.
- **Prerequisites:** WP-203.
- **Risk boundaries:** **WP duy nhất xoá dữ liệu người dùng** — hai trong ba điểm không đảo ngược ở §1 nằm ở đây. Bốn bất biến phải có test: (1) mọi đường dẫn đi qua **bộ kiểm no-follow của Design §3.8**, gồm `lstat` từng thành phần, trước khi chạm đĩa; (2) mọi thao tác lấy mutex theo `workspaceId`, nên không có bản ghi nào bị nối vào nguồn trong lúc xoá hay gộp; (3) không file nào ngoài `traces/` bị thay đổi; (4) `workspaces.list()` lỗi thì **không** gắn nhãn `orphaned` cho ai (phải là `unknown`), vì một lần gọi lỗi không được biến thành kết luận "workspace đã mất".
- **Exit condition:** test cho ba phạm vi xoá và năm tình huống gán lại ở Design §15; `dryRun` đếm khớp với kết quả xoá thật; `workspaceId` sai định dạng và đường dẫn thoát ra ngoài đều bị từ chối bằng `E_TRACE_STORE_UNWRITABLE` mà không chạm đĩa; gán lại vào workspace không tồn tại hoặc `from == to` cho `E_TRACE_REASSIGN_INVALID`; bị ngắt giữa lúc gộp thì đọc lại **không** nhân đôi bản ghi. **Test snapshot trước–sau của toàn bộ `$HOME` giả và workspace fixture** — so nội dung, loại file, đích symlink và metadata; allowlist duy nhất là các path dự kiến dưới `<install home>/traces/`. **Test symlink** ở bốn cấp cho cả xoá và gán lại: bị từ chối, đích symlink không đổi. **Test barrier**: nối bản ghi đồng thời với xoá và với gán lại — không mất, không nhân đôi, và không ghi vào thư mục nguồn sau khi gán lại xong.

#### WP-211: Giao diện Dashboard và màn hình cài đặt

- **Outcome:** Màn hình "Beads Manager" có nút **Dashboard** mở Dashboard cùng surface; một mục Command Center theo ngữ cảnh workspace; Dashboard hiện danh sách trace, chi tiết một trace (gửi đi / nhận lại / thời gian / token và chi phí / beads / bảng bước quy trình), khối thống kê beads, khối dung lượng kèm cảnh báo, và các luồng xoá và gán lại có xem trước; một màn hình cài đặt plugin cho `warnAboveBytes`. Toàn bộ logic, text và style nằm trong `client/dashboard-model.ts`.
- **Requirement / AC coverage:** REQ-040 (a)(b)(c)(d), REQ-041 (c)(d) phần hiển thị, REQ-042 (c), REQ-043 (c)(e), REQ-045 phần hiển thị, REQ-048 (d), REQ-052 phần nhãn hiển thị, REQ-054 (b)(e)(f), REQ-055 (a)(b)(d)(e)(f), REQ-057 (a)(b)(d).
- **Design refs:** Dashboard Design §2.1, §3.6, §3.7; `client/launcher.tsx` và `client/launch-manager.ts` là khuôn tách render khỏi logic.
- **Prerequisites:** WP-206, WP-207, WP-208, WP-209, WP-210.
- **Risk boundaries:** đây là chỗ **độ chắc chắn phải nhìn thấy được**: `linking`, `confidence` từng ô, `costBasis` kèm ngày bảng giá, và mốc đo thời gian đều phải hiện ra chữ, không được ẩn. Hai câu bắt buộc có trên màn hình: thời gian là thời gian treo (gồm chờ người dùng), và nội dung đang xem là hội thoại agent được lưu trên đĩa. Chỉ primitive React Native, màu lấy từ `theme.colors`, không import `server/`.
- **Exit condition:** test cho `dashboard-model.ts`: text cho từng `state`, từng `confidence`, từng `costBasis`; cảnh báo dung lượng bật đúng ngưỡng; hộp xác nhận xoá mặc định "Không"; **xoá một trace đang chạy hiện cảnh báo trước bước xác nhận** (REQ-054e); **màn hình cài đặt nói rõ ngưỡng áp cho toàn máy** (REQ-055e) và **giá trị không hợp lệ giữ nguyên ngưỡng cũ kèm thông báo** (REQ-055f); nhóm "workspace không còn" hiện `lastKnownName`. Một test khẳng định **không có đường nào trong giao diện hay hook tự gọi xoá** (REQ-054f). Test render với dữ liệu: danh sách rỗng, trace thiếu dữ liệu, trace đang chạy, agent đã bị xoá, host không có `navigation.openAgent`; bố cục rộng và `compact`; đổi theme vẫn đọc được; không dùng phần tử HTML. **Kèm một test đi hết đường:** bấm Dashboard → `traces.list` → chọn một dòng → `traces.get` → hiện đủ bốn khối; và bấm xoá → `dryRun` → xác nhận → `traces.delete`.

#### WP-212: Nhãn `bm.requestId` và `bm.batchId` trong chỉ dẫn vai trò

- **Outcome:** `plugin/roles/manager.md` yêu cầu Manager gắn `bm.requestId` khi tạo Worker; `plugin/roles/worker.md` yêu cầu Worker gắn `bm.requestId` và `bm.batchId` khi tạo Reviewer; chỉ dẫn nhúng được sinh lại; phiên bản payload và `bm.version` bump theo.
- **Requirement / AC coverage:** REQ-051 (a)(b)(c)(d).
- **Design refs:** Dashboard Design §6 bước 3a, §14 hàng `roles/*.md`; design gốc §2.5, §2.6.
- **Prerequisites:** WP-206 (bộ nhóm trace phải tồn tại để chứng minh nhãn thiếu vẫn chạy được).
- **Risk boundaries:** đây là **"mã" viết bằng tiếng Anh cho một hệ thống không xác định**, và là một trong bốn điểm không đảo ngược: agent tạo bằng bản cũ giữ prompt cũ suốt đời. Vì vậy nhãn là **đường nhanh, không phải điều kiện**: thiếu nhãn thì trace vẫn dựng được ở mức `inferred`. Bằng chứng cục bộ chỉ là test nội dung; bằng chứng hành vi thật nằm ở WP-214 và **không** được dùng làm điều kiện ra của WP này.
- **Exit condition:** test nội dung khẳng định hai file viết bằng tiếng Anh và nêu đúng hai nhãn kèm định dạng `requestId`; test byte-match của chỉ dẫn nhúng xanh; test bộ nhóm trace chạy đúng với **cả hai** tập dữ liệu: agent có nhãn (`linking: exact`) và agent không có nhãn (`inferred`).

#### WP-213: Trình cài đặt, `doctor` và lệnh gỡ — quyền sở hữu kho lưu vết

- **Outcome:** Lệnh gỡ liệt kê kho lưu vết **riêng** kèm số trace và dung lượng, hỏi riêng trước khi xoá, và chỉ xoá ở chế độ không tương tác khi có cờ dành đúng cho việc đó; cài và cập nhật (gồm `--prune`) không bao giờ chạm kho; `install.json` **không** ghi kho vào `files[]`. `doctor` báo tình trạng kho **chỉ khi** Q-043 được trả lời "Có"; mặc định là không, và khi đó `doctor` không nằm trong outcome này.
- **Requirement / AC coverage:** REQ-056 (a)(b)(c)(d); PRD gốc REQ-010(f) và REQ-012(i) **sau khi** delta được áp dụng.
- **Design refs:** Delta [`design-delta-20260916-trace-store`](../design/paseo-bm-delta-20260916-trace-store.md) vị trí 1, 2, 6, 7; design gốc §3.1, §3.3; ADR-007 quyết định 9, 10.
- **Prerequisites:** WP-203, **và delta phải `Accepted` + `Applied`** (§0 mục 4).
- **Risk boundaries:** WP này **bị chặn** cho tới khi owner trả lời hai câu hỏi còn mở của delta: hành vi mặc định của lệnh gỡ, và **tên cờ** cho chế độ không tương tác. Tên cờ là hợp đồng công khai của CLI — không được tự đặt trong lúc implement. Đây cũng là ranh giới giữa "dữ liệu người dùng" và "tài sản phiên bản": một lỗi ở đây sẽ xoá lịch sử của người dùng trong lúc họ chỉ muốn cập nhật.
- **Exit condition:** test tích hợp trên `$HOME` giả: cài lại cùng phiên bản, cập nhật lên phiên bản mới, và `--prune` — cả ba để kho **nguyên vẹn từng byte**; gỡ mà không đồng ý thì kho còn và bản tóm tắt nói nó ở đâu; gỡ có đồng ý thì kho mất và không có gì khác ngoài phạm vi bị xoá; chế độ không tương tác không có cờ thì **không** xoá; `install.json` sau mọi luồng đều không chứa đường dẫn nào trong `traces/`.

#### WP-214: Nghiệm thu Phase 2a trên daemon thật

- **Outcome:** Một checklist nghiệm thu mới trong `docs/operations/` cho Dashboard (fixture, cách đo từng chỉ số, phiếu ghi), chạy trên daemon thật, một run record ghi kết quả D-1 → D-11 kèm bằng chứng, **và README được cập nhật ba nội dung: lối vào Dashboard, cách xoá trace, và cảnh báo rằng hội thoại agent được lưu trên đĩa**.
- **Requirement / AC coverage:** toàn bộ D-1 → D-11; xác nhận lại REQ-047 và REQ-048 bằng quan sát thật; **điều kiện ra số 6 của Phase 2a-2 (tài liệu người dùng)**.
- **Design refs:** Dashboard Design §15 hàng cuối; `docs/operations/paseo-bm-orchestration-checklist.md` là khuôn.
- **Prerequisites:** WP-207, WP-209, WP-210, WP-211, WP-212, WP-213.
- **Risk boundaries:** đây là **nơi duy nhất** thu bằng chứng cho những thứ test không chứng minh được: độ chính xác của nhóm trace và của bảng bước quy trình trên hành vi agent thật (D-2 → D-5), tính bền của kho (D-8), và tính vô hại của xoá và gán lại (D-9, D-11). Không WP nào khác được lấy WP này làm điều kiện ra, để tránh phụ thuộc vòng.
- **Exit condition:** run record ghi PASS cho D-1 → D-11, trong đó: D-2 → D-5 đo trên **5 yêu cầu mẫu** dùng lại bộ fixture điều phối hiện có; D-8 đo sau reload plugin, khởi động lại daemon, và sau khi xoá agent; D-9 và D-11 có ảnh chụp hệ thống file trước–sau; D-10 đối chiếu với số provider báo; kèm một lần cập nhật phiên bản thật chứng minh kho còn nguyên; **đối chiếu README** chứng minh đủ ba nội dung bắt buộc. Chỉ số nào không đạt thì ghi "Không" kèm số đo, **không** ghi PASS.

## 3. Dependencies

| Edge | Producer outcome mà WP phụ thuộc cần |
|---|---|
| WP-202 → WP-201 | Cần hằng số mã lỗi trước khi báo lỗi định vị |
| WP-203 → WP-201, WP-202 | Cần lược đồ bản ghi và đường dẫn `<install home>` |
| WP-204 → WP-201 | Cần kiểu đã chuẩn hoá của báo cáo |
| WP-205 → WP-203, WP-204 | Thu thập cần đường ghi và bộ đọc báo cáo |
| WP-206 → WP-203, WP-204, WP-205, WP-208 | Dựng trace cần kho, bộ đọc báo cáo, **bản ghi collector đã chốt nguồn báo cáo/timestamp sau A-1/A-2**, và **hàm đọc bead theo id** cho REQ-044(a). Không tạo chu trình: WP-205 và WP-208 không phụ thuộc WP-206 |
| WP-208 → WP-201 | Cần hợp đồng `BeadStats` và mã lỗi |
| WP-207 → WP-204, WP-206 | Tín hiệu bước lấy từ báo cáo và từ trace đã dựng |
| WP-209 → WP-201, WP-206 | Cần bảng giá và cần `usage` gom theo trace |
| WP-210 → WP-203 | Xoá và gán lại là thao tác trên kho |
| WP-211 → WP-206, WP-207, WP-208, WP-209, WP-210 | Giao diện dựng trên năm RPC đã có dữ liệu thật |
| WP-212 → WP-206 | Phải có bộ nhóm trace để chứng minh nhãn thiếu vẫn chạy được |
| WP-213 → WP-203 **và** delta `Applied` | Cần bố cục kho, và cần nội dung quyền sở hữu đã được duyệt |
| WP-214 → WP-207, WP-209, WP-210, WP-211, WP-212, WP-213 | Nghiệm thu cần cả chuỗi chạy thật, gồm cả vòng đời dữ liệu |

Không có chu trình. WP-204 và WP-208 chạy song song được với WP-202 ngay từ đầu. WP-212 **không** phụ thuộc WP-214: bằng chứng cục bộ của nó là test nội dung, còn WP-214 là nơi duy nhất thu bằng chứng hành vi — cùng cách gỡ chu trình mà plan Phase 1 đã dùng cho các WP chỉ dẫn.

## 4. Test Strategy

Theo Dashboard Design §15. Khung **Vitest**, Node 22 và 24, macOS và Linux — cùng bộ CI hiện có.

- **Unit (hàm thuần):** bộ đọc `BM-REPORT`; nhóm trace; đo thời gian; suy bước quy trình; tính chi phí; đọc `issues.jsonl`; text và style của `dashboard-model.ts`.
- **Unit có hệ thống file:** `trace-store.ts`, xoá, gán lại, `install-home.ts` — chạy trên thư mục tạm, khẳng định cả **quyền file** (`0600`/`0700`).
- **Integration:** `PaseoApi` giả lập cộng `$HOME` giả: một workspace, một Manager, hai Worker, ba Reviewer, có agent đã lưu trữ; đi hết vòng **ghi → đọc → xoá → gán lại** qua năm RPC.
- **Bất biến an toàn (bắt buộc, REQ-047):** bộ kiểm no-follow của Design §3.8 (symlink ở bốn cấp bị từ chối, đích không đổi) và mutex tuần tự hoá (test barrier cho append song song với xoá và gán lại); không gọi hàm ghi nào của SDK (`create`, `send`, `run`, `archive`, `respondToPermission`, `timeline.append`); không mạng; **không ghi ngoài `<install home>/traces`**; không đọc file nào ngoài `<workspace>/.beads/issues.jsonl` và `<install home>/install.json` (REQ-047 sau khi sửa ở bản 4 của PRD); che bí mật chạy trước khi ghi, khẳng định bằng nội dung file trên đĩa.
- **Hợp đồng đang tiêu thụ:** `BM-REPORT` test với **hai** phiên bản định dạng (bản hiện tại và một biến thể thiếu/ thêm field).
- **Dữ liệu bền:** `schemaVersion` bằng, thấp hơn, cao hơn; dòng hỏng; ghi dở; loại trùng.
- **Plugin bundle:** mở rộng `test/plugin-bundle-cjs.test.ts` — client entry mới không import `server/`, `shared/` không import Node.
- **Chỉ dẫn vai trò:** test nội dung cho hai file đã sửa, kèm byte-match của bản nhúng.
- **Nghiệm thu thủ công:** WP-214; đây là bằng chứng duy nhất cho D-2 → D-5, D-8 → D-11.

**Mức tối thiểu cam kết:** ≥ 80% dòng cho các module mới trong `plugin/server/` và `plugin/client/`; ba nhóm phải phủ **mọi nhánh**: bất biến an toàn, xoá và gán lại, và quy tắc `skipped` của bảng bước quy trình. CI **không** chạy agent thật.

## 5. Risk Modules

- **Quyền riêng tư và ranh giới ghi (kích hoạt — đây là rủi ro lớn nhất của phase):**
  - Ranh giới mới: plugin ghi nội dung hội thoại agent vào `<install home>/traces/`.
  - Chính sách: che bí mật **trước khi ghi**; quyền `0700`/`0600`; cắt độ dài; không ghi `env`; đọc đĩa ngoài kho đúng hai chỗ; người dùng xoá được bất cứ lúc nào; không mạng.
  - **Bằng chứng phủ định bắt buộc:** bộ bất biến ở §4, cộng ảnh chụp hệ thống file trước–sau trong WP-214 cho D-7, D-9, D-11.
  - **Yêu cầu rà soát:** owner review mã hai chỗ trước khi phát hành — đường ghi của `trace-store.ts` + `collector.ts` (WP-203, WP-205) và đường xoá/gán lại (WP-210).
  - **Hai lỗ hổng do lượt review Codex tìm ra, đã chốt ở tầng design (Design §3.8), không còn là phạm vi phải phát minh khi implement:** đường ghi và xoá trước đây chỉ kiểm tiền tố chuỗi nên vẫn bị một thành phần symlink dẫn ra ngoài kho; và chưa có hợp đồng tuần tự hoá giữa bộ thu thập với hai thao tác xoá/gán lại.
- **Hợp đồng công khai:** năm RPC mới và sáu mã lỗi là hợp đồng từ bản đầu; trong cùng major chỉ thêm, không đổi nghĩa. `BM-REPORT` là hợp đồng **đang được tiêu thụ**: đổi định dạng phải đi kèm cập nhật bộ đọc trong cùng lần.
- **Dữ liệu bền vững:** kho lưu vết lược đồ v1, đánh số **độc lập** với `install.json`. Quy tắc từ chối lược đồ cao hơn nằm ở WP-203. **Không có backfill** — trước bản này chưa có kho nào, nên lịch sử cũ đơn giản là không có trace; Dashboard hiện "không có dữ liệu trước ngày cài" chứ không dựng lại từ timeline.
- **Rollout / containment:** vẫn dist-tag `next`; đường lùi là bản vá cộng đổi dist-tag. Hạ cấp xuống bản không biết lược đồ mới: bản cũ đọc hạn chế và **không ghi**, nên dữ liệu không bị phá.
- **Chi phí:** tính năng này **không** tạo agent và không gọi model, nên không thêm chi phí model. Chi phí duy nhất là đĩa, và nó có cảnh báo cộng đường xoá.
- **R3 decision:**
  - Risk owner: hieu.nt10.
  - Phân loại: **có thao tác phá huỷ dữ liệu** (xoá trace, gán lại) nhưng chỉ do người dùng khởi động, có xem trước và xác nhận. Bốn điểm forward-only đã nêu ở §1.
  - **Diễn tập: chọn có** — WP-214 chạy xoá và gán lại trên kho thật của repo nháp, có ảnh chụp trước–sau, trước khi phát hành.
  - Containment: mọi thao tác xoá đi qua một bộ kiểm đường dẫn duy nhất; `dryRun` là bước bắt buộc của giao diện; cập nhật phiên bản không bao giờ xoá.

## 6. Cross-Stack

Không áp dụng. Một repo, một stack. Payload plugin dùng React Native primitives nhưng cùng repo và cùng quy trình phát hành; WP-211 tách riêng vì ràng buộc kiểm thử khác (render, theme, compact).

## 7. Risks & Open Questions

| ID | Risk / Question | Mitigation / Owner | Status |
|---|---|---|---|
| Q-039b | Hành vi mặc định của **lệnh gỡ** với kho lưu vết, và **tên cờ** cho chế độ không tương tác | Owner: hieu.nt10. **Chặn WP-213** — tên cờ là hợp đồng công khai, không được tự đặt khi implement | **open, chặn** |
| Q-042 | Ngưỡng cảnh báo chỉ có phạm vi toàn máy (Paseo chỉ cấp `scope: "host"`). Có cần ngưỡng theo workspace không? | Nếu cần thì lưu trong `meta.json` của kho; không chặn WP nào | open, không chặn |
| Q-043 | `doctor` có báo thêm một dòng về kho lưu vết không (câu hỏi 3 của delta) | **Phải trả lời trước khi WP-213 được phân rã**, vì nó đổi cả outcome của WP-213 và điều kiện ra số 5 của chặng 2a-2. Mặc định là **không**. Owner: hieu.nt10 | **open, chặn WP-213** |
| A-1 | Khối `BM-REPORT` gửi bằng `send_agent_prompt` xuất hiện dưới kiểu entry nào trong timeline Manager | Trả lời **trong** WP-205 bằng quan sát thật; đường đỡ đã có sẵn (đọc từ timeline Worker) | open, có đường đỡ |
| A-2 | `timeline` của hook `agent.turn_ended` có `timestamp` cho từng item không | Trả lời **trong** WP-205; thiếu thì thêm một `timeline.refetch` cho cửa sổ lượt — đã thiết kế sẵn, không phải phạm vi mới | open, có đường đỡ |
| R-101 | **Agent không gắn nhãn hoặc không gửi `BM-REPORT` đầy đủ** → nhiều ô "không rõ", tính năng trông kém giá trị | Nhãn là đường nhanh chứ không phải điều kiện (WP-212); bảng bước quy trình có cột `inferred`; D-5 chỉ đòi **không kết luận sai**, không đòi phủ kín | mở, đã giảm thiểu |
| R-102 | **Kho phình nhanh hơn dự kiến** trên máy dùng nhiều | Trần độ dài trường; cảnh báo dung lượng cấu hình được; ba phạm vi xoá. Không tự xoá theo ADR-007 | mở, chấp nhận có ý thức |
| R-103 | **Hook không chạy** (host cũ, plugin bị tắt giữa lúc agent chạy) → thiếu trace mà người dùng không biết | Ghi notice "có thể thiếu trace" thay vì im lặng; WP-205 test nhánh host thiếu hook | mở, đã giảm thiểu |
| R-104 | **Nội dung nhạy cảm lọt vào kho** dù đã che bí mật (agent trích một đoạn mã hoặc một token dạng lạ) | Ghi nhận là hạn chế đã biết trong ADR-007 Consequences; giảm nhẹ bằng quyền `0600`, cắt độ dài, câu cảnh báo trên giao diện, và quyền xoá. Owner: hieu.nt10 | chấp nhận có ý thức |
| R-105 | **Đổi định dạng `BM-REPORT` ở một bản sau** làm Dashboard đọc trượt | REQ-050 buộc bộ đọc khoan dung và test hai phiên bản; ghi vào Design §14 rằng đổi định dạng là thay đổi hợp đồng | mở, đã giảm thiểu |
| R-106 | Nhóm trace sai khi hai yêu cầu chồng thời gian và không có `requestId` | Nhóm "không rõ" thay vì gán bừa; nhãn `bm.requestId` (WP-212) loại gần hết trường hợp này cho agent mới | mở, đã giảm thiểu |

## 8. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | **Owner duyệt; cổng `plan-ready-for-beads` PASS với một ngoại lệ.** Status Draft → Active, `Plan-ready: PASS — 2026-09-16 — hieu.nt10`. Ngoại lệ được ghi, không phải PASS ngầm: **WP-213 không được chuyển thành beads** cho tới khi Q-039b (hành vi lệnh gỡ + tên cờ) và Q-043 (`doctor`) được trả lời. Phạm vi 13 WP còn lại **đóng băng** từ thời điểm này; thêm phạm vi phải qua delta-change |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | **Sửa theo lượt review độc lập bằng Codex (`codex/gpt-5.6-sol`, agent `632ed207`): 9 blocker, 8 mục quan trọng, 4 mục tuỳ chọn — nhận cả 21 về nội dung; riêng B-2 (tuần tự hoá) xử lý khác cách nó đề xuất: nó đề nghị treo plan chờ chốt khoá, nhưng bộ thu thập và các handler RPC chạy **cùng một tiến trình** plugin server nên chỉ cần mutex trong tiến trình, và điều đó được chốt ngay ở Design §3.8 thay vì để mở.** Hai lỗ hổng thật ở tầng design được chốt trước ở Design §3.8 (bộ kiểm no-follow cho đường ghi và xoá; mutex tuần tự hoá theo `workspaceId`) rồi WP-203 và WP-210 mới trỏ vào. Sửa: WP-202 điều kiện ra tự mâu thuẫn (`--home` hợp lệ bị xếp vào nhóm trả `null`); chặng 2a-1 không được tuyên bố D-8 PASS khi chỉ có một yêu cầu; WP-206 thiếu phụ thuộc WP-205 (hợp đồng bản ghi sau A-1/A-2) và WP-208 (đọc bead theo id cho REQ-044a); REQ-044(a) trước đây không có chủ; Q-043 chuyển sang **chặn WP-213**; README vào outcome WP-214; bổ sung chủ sở hữu cho REQ-050(b), REQ-054(e)(f), REQ-055(e)(f); benchmark 50 ms cho hook; quyền `0700`; ba repo cho D-6; `traces.get` kiểm cả hai chiều; đếm đúng số ca test của bộ đọc; bỏ `npm publish` khỏi phase này; gọi kho là "giới hạn được" thay vì "đảo ngược được" |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | Tạo bản Draft cho Phase 2a từ PRD Dashboard (REQ-040 → REQ-057), Technical Design Dashboard và ADR-007. Chia hai chặng 2a-1 (thu thập và đọc, 7 WP) và 2a-2 (diễn giải, giao diện, vòng đời dữ liệu, 7 WP). `Plan-ready: Pending` — bốn điều kiện tiên quyết ở §0 chưa đủ, và Q-039b đang chặn WP-213 |
