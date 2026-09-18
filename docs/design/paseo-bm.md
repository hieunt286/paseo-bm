# paseo-bm — Technical Design

| Trường | Giá trị |
|---|---|
| Status | Active (bản 2, duyệt 2026-09-15) |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Requirements source | [PRD paseo-bm](../product/paseo-bm-prd.md) |
| Related ADRs | [ADR-001](../adr/ADR-001-plugin-distribution.md) · [ADR-002](../adr/ADR-002-install-ownership-model.md) · [ADR-003](../adr/ADR-003-skills-delegation.md) · [ADR-004](../adr/ADR-004-paseo-config-mutation.md) · [ADR-005](../adr/ADR-005-manager-as-agent.md) · [ADR-006](../adr/ADR-006-role-registration.md) |
| Routing decision | [PRD §0](../product/paseo-bm-prd.md#0-routing-decision) (canonical owner) |
| Môi trường tham chiếu | Paseo CLI/daemon 0.8.0, Node 26.8.2, macOS 25.5 (khảo sát 2026-09-14 và 2026-09-15) |
| Bản trước | Bản 1 (2026-09-14) chỉ mô tả trình cài đặt. Bản này giữ nguyên phần cài đặt và thêm phần điều phối; các mục đã đổi được đánh dấu trong §14. |

## 1. Boundaries

- **Design này sở hữu:** CLI `paseo-bm` (cấu trúc module, hợp đồng dòng lệnh, JSON, mã thoát); thư mục cài đặt và hồ sơ; cách gọi Paseo CLI; cách sửa `config.json` gồm công tắc plugin, provider dẫn xuất, agent profile và công tắc công cụ; cách dò skills và gọi CLI `skills`; payload plugin gồm cả client và server entry; bộ chỉ dẫn vai trò; cách plugin tạo và quan sát agent; chiến lược kiểm thử và đóng gói.
- **Design này KHÔNG sở hữu:** chất lượng suy luận của model; nội dung skills của bên thứ ba; nội bộ Paseo; thao tác git; và thứ tự công việc, ước lượng, DoD từng task (thuộc Implementation Plan). *(Sửa 2026-09-15: "việc implement từng bead" trước đây nằm ở đây, nay đã thuộc phạm vi — Worker đi tới khi implement xong, xem §2.5 và §9.2.)*

## 2. Architecture

### 2.1 Ba lớp

```
┌─ Lớp 1: TRÌNH CÀI ĐẶT (npx paseo-bm) ──────────────────────────────────────┐
│  cli · wizard · preflight · planner · applier · record · paseo · skills     │
│  · roles (đăng ký provider dẫn xuất + agent profile + công tắc công cụ)     │
└───────────────┬────────────────────────────────────────────────────────────┘
                │ ghi
                ▼
   ~/.paseo-bm/            plugin/<ver>/ · install.json · backups/ · .lock
   ~/.paseo/config.json    pluginsEnabled · plugins · agents.providers.bm-*
                           · daemon.agentProfiles[bm-*] · daemon.mcp (nếu cần)

┌─ Lớp 2: PLUGIN PASEO (paseo-bm) ───────────────────────────────────────────┐
│  index.client.tsx   sidebar "Beads Manager" + Command Center               │
│    client/launcher  mở Manager cho workspace hiện tại (có rồi thì mở lại)  │
│    client/tree      cây agent: Manager → Worker → Reviewer, kèm trạng thái │
│  index.server.ts    RPC: ensureManager(workspaceId) · listBmAgents(...)    │
│    server/manager   dùng Paseo SDK tạo/tìm Manager, đọc trạng thái agent   │
└───────────────┬────────────────────────────────────────────────────────────┘
                │ tạo / đọc trạng thái
                ▼
┌─ Lớp 3: CÁC AGENT (chạy trong workspace của người dùng) ───────────────────┐
│                                                                            │
│   người dùng ⇄ MANAGER (agent, profile bm-manager, có công cụ Paseo)       │
│                   │ tạo + theo dõi + nhắc việc                             │
│                   ▼                                                        │
│   người dùng ⇄ WORKER (agent, profile bm-worker, có công cụ Paseo)         │
│                   │ tạo khi cần review                                     │
│                   ▼                                                        │
│                REVIEWER (agent, profile bm-reviewer, KHÔNG có công cụ)     │
│                                                                            │
│   Worker đọc/ghi: docs/**, kho beads (qua br hoặc bd), VÀ mã nguồn thuộc   │
│   bead — tất cả trong workspace. Không đụng git, không ghi ra ngoài.       │
└────────────────────────────────────────────────────────────────────────────┘
```

Hai mũi tên hai chiều là điều cốt lõi: người dùng chat được với **cả** Manager lẫn Worker. Agent con vẫn là agent hạng nhất trong workspace — đã kiểm chứng ngày 2026-09-15: nó nằm trong danh sách agent, chỉ mang thêm nhãn `paseo.parent-agent-id`, và có sẵn `paseo agent open|send|stop|archive|delete`.

### 2.2 Vì sao vẫn cần plugin khi Manager là agent

Plugin làm ba việc mà một agent không làm được:

1. **Lối vào ổn định.** Người dùng bấm một chỗ cố định trong sidebar để mở Manager của workspace hiện tại, thay vì phải nhớ tạo agent với đúng profile.
2. **Một Manager cho mỗi workspace.** Plugin biết Manager nào còn sống để mở lại thay vì tạo trùng (Q-025).
3. **Bảng quan sát.** Cây Manager → Worker → Reviewer kèm trạng thái, dựng từ nhãn quan hệ cha con, để người dùng thấy toàn cảnh mà không phải lần trong danh sách agent chung.

### 2.3 Lựa chọn nền tảng

| Mục | Quyết định | Lý do |
|---|---|---|
| Ngôn ngữ / runtime | TypeScript, ESM, Node ≥ 22 | Khớp hệ sinh thái `npx`; 22 là LTS |
| Đóng gói | `tsup` → `dist/index.js`, `bin`, `files: ["dist/", "plugin/"]` | Một file chạy, tải nhanh qua `npx` |
| Phụ thuộc runtime | Tối thiểu: parser dòng lệnh, thư viện prompt, `semver` | Mỗi phụ thuộc là một mắt xích chuỗi cung ứng |
| Script vòng đời npm | **Không có** `preinstall`/`postinstall`. `prepack` được phép vì chạy trên máy người phát hành, không phải máy người cài | NFR bảo mật chỉ cấm script chạy lúc cài trên máy người dùng |
| Phát hành | GitHub Release → npm trusted publishing (OIDC), có provenance | Không cần lưu token |

### 2.4 Payload plugin

```
plugin/
  paseo-plugin.json      { "id": "paseo-bm", "requirements": { "paseo": ">=0.8.0" } }
  index.client.tsx       sidebar item + Command Center item + workspace panel
  client/launcher.tsx    nút mở Manager; gọi RPC ensureManager
  client/tree.tsx        cây agent kèm trạng thái, poll qua RPC
  index.server.ts        đăng ký RPC
  server/manager.ts      tìm/tạo Manager qua Paseo SDK; đọc danh sách agent
  shared/contracts.ts    hợp đồng Zod cho các RPC
  shared/version.ts      hằng số phiên bản, sinh lúc build
  roles/manager.md       chỉ dẫn vai trò Manager
  roles/worker.md        chỉ dẫn vai trò Worker
  roles/reviewer.md      chỉ dẫn vai trò Reviewer
  tsconfig.json
```

Surface chỉ hiển thị dữ liệu lấy từ RPC và hằng số lúc build. Client entry **không đọc được hệ thống file**, nên mọi thứ cần đọc đĩa đều phải đi qua server entry.

### 2.5 Bộ chỉ dẫn vai trò

Ba file Markdown đóng cùng gói, được copy vào thư mục cài đặt và có hash trong hồ sơ như mọi file payload khác. Nội dung của chúng được nhúng vào bundle server lúc build và nạp làm system prompt của agent `bm-*` qua hook `before("agent.create")` (xem cuối §2.6).

**Toàn bộ nội dung dành cho agent viết bằng tiếng Anh** — ba file `roles/*.md` và mọi prompt hệ thống. Tài liệu dự án (PRD, design, plan này) vẫn giữ tiếng Việt cho người đọc.

| Vai trò | Nội dung chính | Công cụ Paseo |
|---|---|---|
| Manager | Nhận yêu cầu từ người dùng; **giao ngay** cho Worker, không tự làm; theo dõi và trả lời về tiến độ; không bao giờ xoá agent | Có |
| Worker | Bám feature-workflow; quyết định cần tài liệu gì theo mức rủi ro; **gán nhãn khi tạo bead và truy vấn theo nhãn để tìm việc liên quan**; gọi Reviewer sau mỗi lần chạm tài liệu hoặc beads; **đi tiếp tới khi implement xong**; vướng chỗ nào thì hỏi lại rồi đi tiếp; không commit, không push | Có |
| Reviewer | Chỉ đọc và nhận xét đúng phần vừa thay đổi; phân loại phát hiện theo mức chặn; **không tự sửa** | Không |

**Quy ước nhãn (REQ-033).** Worker suy ra bộ nhãn từ nội dung yêu cầu và gắn vào mọi bead nó tạo; khi cần biết yêu cầu mới có trùng việc cũ không, nó **truy vấn kho beads theo chính bộ nhãn đó** rồi xét các bead chưa đóng trong tập kết quả. Quy ước phải viết đủ cụ thể trong `roles/worker.md` để hai lần chạy khác nhau cho ra nhãn giống nhau; nhãn do người dùng tự thêm không bị xoá.

**Không có giới hạn cứng cho Worker (REQ-022f).** Nó chạy hết chuỗi: tài liệu → beads → implement → đóng bead kèm bằng chứng. Cơ chế an toàn không phải là đồng hồ đếm giờ mà là **bắt buộc hỏi khi vướng**, cộng với ranh giới không-chạm-git và quyền vòng đời thuộc về người dùng.

### 2.6 Hợp đồng hành vi giữa các agent

Bốn hợp đồng dưới đây phải cụ thể tới mức hai lần chạy khác nhau cho ra kết quả giống nhau. Chúng nằm trong `roles/*.md` và là thứ quyết định sản phẩm chạy được hay không.

*(Errata 2026-09-17, [delta simplify-roles](./paseo-bm-delta-20260917b-simplify-roles.md): **cách trình bày** của ba file `roles/*.md` đã đổi — khối `## RULES` nay là 5 / 4 / 5 giới hạn theo LOẠI hành vi thay vì 19 / 8 / 11 gạch đầu dòng cấm theo từng ca, và mọi chi tiết "cách làm" chuyển xuống đúng bước dùng nó, viết ở thể khẳng định. **Nội dung mọi hợp đồng dưới đây không đổi**: nhãn, báo cáo, lô review, quy tắc dừng, ngân sách, mức. Bảng §4.3 của delta đó truy từng luật cũ tới chỗ mới.)*

*(Errata 2026-09-17, [delta context-engineering](./paseo-bm-delta-20260917c-context-engineering.md): ba file vai trò viết lại theo **ba tầng** — thường trú (danh tính, một vòng "việc tiếp theo", giới hạn, hợp đồng phát ra mọi lần), theo lần gọi (tiêu chí giai đoạn nằm trong brief Worker gửi Reviewer), ép bằng mã (plugin lo mode và đếm ngân sách). Hai thay đổi **nội dung**: (1) §F — ngân sách review do plugin đếm, `BM-REPORT` bỏ dòng `guardrail:`, Manager nhận thông báo `BM-BUDGET` và **hỏi người dùng** thay vì tự huỷ; (2) Worker thôi chọn mode cho Reviewer (hook hạ `full-access` thừa kế về `auto`), còn Manager truyền mode Worker lấy từ mục `## Runtime facts` plugin ghi vào chỉ dẫn, vì daemon từ chối tạo Worker thiếu mode **trước** khi hook chạy.)*

**A. Hợp đồng nhãn (REQ-033).** Không đủ nếu chỉ nói "gán nhãn phù hợp".

| Mục | Quy định |
|---|---|
| Không gian tên | `feature:<slug>` bắt buộc; `area:<slug>` và `component:<slug>` thêm khi xác định được |
| Chuẩn hoá | chữ thường, nối bằng dấu gạch ngang, bỏ dấu tiếng Việt, tối đa 32 ký tự mỗi slug, loại trùng |
| Nguồn của slug | suy từ danh từ chính trong yêu cầu; nếu repo đã có nhãn `feature:*` gần nghĩa thì **dùng lại nhãn cũ** thay vì đặt tên mới |
| Truy vấn tìm việc liên quan | lọc bead **chưa đóng** khớp `feature:<slug>`; nếu rỗng thì nới ra `area:<slug>` |
| Không kết quả | tạo bead mới |
| Một kết quả | cập nhật bead đó nếu phạm vi trùng; tách bead con nếu yêu cầu vượt quá một kết quả quan sát được |
| Nhiều kết quả | **dừng lại hỏi người dùng** chọn bead nào, không tự đoán |
| Nhãn của người dùng | giữ nguyên, chỉ thêm chứ không xoá |

**B. Báo cáo Worker → Manager (REQ-034).** Manager không đọc hội thoại của Worker, nên Worker phải **chủ động nhắn** cho Manager bằng công cụ gửi tin của Paseo tại các mốc: nhận việc, xong tài liệu, xong beads, xong mỗi bead khi implement, khi vướng, khi kết thúc. Nội dung là một khối có cấu trúc cố định: giai đoạn; file đã đổi; bead đã tạo/cập nhật/đóng; bead đang sẵn sàng; phát hiện review còn lại; trạng thái build và test; điều đang vướng. Manager đối chiếu thêm bằng công cụ đọc trạng thái và dòng hoạt động của agent.

**C. Lô review (REQ-024g).** Một lượt review tính theo **lô thay đổi mạch lạc** — một tài liệu, hoặc một đợt tạo/cập nhật bead, hoặc một bead vừa implement xong — chứ không phải mỗi file một lượt. Sửa xong theo phát hiện mức chặn thì **review lại** cho tới khi hết mục chặn. Thao tác chỉ đọc không kích hoạt review. Reviewer **không được tạo agent**: đây là thứ chặn review đệ quy, và theo ADR-006 quyết định 9 nó phải nằm trong chỉ dẫn chứ không trông cậy hoàn toàn vào cấu hình.

**D. Dừng và lan truyền.** Người dùng hoặc Manager dừng một Worker thì Worker phải dừng luôn Reviewer đang chạy, không tự sinh lại agent mới, và để lại báo cáo cuối nêu rõ file nào, bead nào còn dang dở. Không agent nào được lưu trữ hay xoá agent.

*Errata 2026-09-15 (bm-wq6) — dừng Worker bằng nút Stop của Paseo:* nghiệm thu điều phối lượt 4, F-8a, cho thấy Stop của Paseo (nút Stop trong app hay `paseo stop`) **chỉ ngắt lượt hiện tại của Worker**. Worker không còn lượt nào để làm theo quy tắc trên, nên Reviewer đang chạy vẫn chạy tới hết, rồi thông báo "finished" của nó đánh thức Worker thêm một lần. Paseo 0.8 **không cho plugin huỷ agent**: `PaseoAgentHandle` (`@getpaseo/client` 0.8.0, `dist/index.d.ts`) chỉ có `send`, `run`, `waitForFinish`, `archive`, `detach`… mà không có `cancel`; `cancelAgent` chỉ nằm trên `DaemonClient` nội bộ (`./internal/daemon-client`), plugin không được cấp. Plugin chỉ **phát hiện** được lượt `bm-worker` bị huỷ qua `on("agent.turn_ended")` với `outcome.kind` = `"canceled"`; lý do huỷ không phân biệt người dùng bấm Stop với việc tin nhắn mới thay lượt, nên phải đọc lại trạng thái Worker. Owner chốt A + B + E:
- **(A) Plugin:** khi một lượt `bm-worker` kết thúc với `canceled`, plugin đọc lại trạng thái Worker; nếu Worker **không** còn `running` thì gửi một thông báo dừng cố định (bắt đầu bằng `STOP: The Beads Worker that created you was stopped by the user.`) tới các agent con `bm-reviewer` của nó đang chạy.
- **(B) Chỉ dẫn vai trò:** `worker.md` coi lượt mới ngay sau một lượt bị ngắt (bắt đầu từ thông báo agent con kết thúc, hoặc không có chỉ thị mới của người dùng) là bị dừng, trừ khi người dùng bảo làm tiếp; khi đó Worker gọi `cancel_agent` cho mọi Reviewer đang chạy (huỷ thật, không lưu trữ, kill hay xoá), không làm gì khác, gửi báo cáo `finished` rồi nghỉ; thông báo kết thúc đến sau không phải chỉ thị. `reviewer.md` nhận ra thông báo dừng: không đọc file, không chạy lệnh, không gọi công cụ, chỉ trả đúng một dòng `BM-REVIEW STOPPED`.
- **(E) Ghi nhận giới hạn** ở đây và soạn đề nghị gửi Paseo (`docs/operations/paseo-upstream-request-agent-cancel.md`, bản nháp, chưa gửi).

**Rủi ro đã biết:** Reviewer bị `send` ngắt vẫn chạy thêm **một lượt ngắn** để trả lời thông báo dừng; Worker đã dừng vẫn **bị đánh thức một lần** bởi thông báo "finished" khi Reviewer kết thúc (kể cả Reviewer do plugin hay chính Worker dừng); cả hai đường A và B **phụ thuộc agent làm theo chỉ dẫn vai trò**. Vì vậy REQ-026f hiện chỉ được đáp ứng **về hành vi**, không phải bằng huỷ cứng, cho tới khi Paseo cho plugin một thao tác huỷ agent.

**E. Phân loại quy mô yêu cầu (REQ-036).** Yêu cầu của người dùng trải từ "sửa một dòng chữ" tới "dựng cả hệ thống". Bắt mọi yêu cầu đi qua cùng một quy trình là cách nhanh nhất để sản phẩm trở nên phiền phức. Worker phân loại ngay khi nhận việc, nói rõ mức và lý do, rồi đi theo đúng cột của nó.

**Quy tắc có thứ tự, dừng ở điều kiện khớp đầu tiên** — viết vậy để cùng một yêu cầu không bị hai lần chạy phân vào hai mức khác nhau:

1. Chạm **hợp đồng công khai, lược đồ dữ liệu, xác thực, quyền, khả năng hoàn tác yếu, hay nhiều thành phần độc lập** → **Lớn**, bất kể yêu cầu nghe nhỏ tới đâu.
2. Thoả **tất cả**: nằm gọn trong một thành phần, không đổi hợp đồng, không cần tài liệu mới, cách làm đã rõ ngay từ đầu → **Nhỏ**.
3. Còn lại → **Vừa**.

**Rủi ro luôn thắng cảm giác về kích thước.** Số bead là kết quả của phân rã nên **không** được dùng làm căn cứ phân loại — nếu không sẽ thành lập luận vòng.

| | **Nhỏ** | **Vừa** | **Lớn** |
|---|---|---|---|
| Ví dụ | sửa lỗi lặt vặt, đổi chữ hiển thị, chỉnh cục bộ đã rõ | tính năng trong module sẵn có | hệ thống mới, chạm hợp đồng công khai, lược đồ dữ liệu, xác thực, nhiều thành phần |
| Tài liệu | **không tạo file mới** (sửa tài liệu sẵn có thì được nếu bead yêu cầu) | chỉ bổ sung phần bị ảnh hưởng | đủ chuỗi theo feature-workflow |
| Review | **đúng 1 lượt, sau khi implement**, soi cùng lúc bead, diff mã và kết quả kiểm thử | tối đa 2 lượt mỗi lô | tối đa 2 lượt mỗi lô |
| Polish beads | **không** | tối đa 1 lượt | tối đa 1 lượt |
| Trước khi implement | đi thẳng | đi thẳng | **phải hỏi người dùng xác nhận** |

Vài ca biên để tránh cãi nhau: "sửa một dòng chữ trong response API mà client đang dựa vào" → **Lớn** (hợp đồng công khai). "Thêm một cột vào bảng" → **Lớn** (lược đồ). "Sửa lỗi hiển thị sai định dạng ngày ở một component" → **Nhỏ**. "Thêm bộ lọc mới cho một màn hình đã có" → **Vừa**.

Phát hiện rủi ro thuộc mức cao hơn khi đang làm thì **nâng mức và báo người dùng** rồi mới đi tiếp; không tự âm thầm nới việc. Người dùng ghi đè được mức phân loại.

> Errata 2026-09-17: skill theo mức (Lớn đủ 5 skill, Vừa theo điều kiện, Nhỏ giữ đường nhanh), hợp đồng bead leaf và các vòng hỏi quyết định/rủi ro đã được bổ sung bằng [delta workflow-skills](./paseo-bm-delta-20260917-workflow-skills.md) §4.1–§4.5 (`design-delta-20260917-workflow-skills`).

**F. Lan can hành vi cho review và polish (REQ-037).** Vòng review là thứ dễ chạy vô hạn nhất: mỗi lần sửa lại đẻ ra thứ để review tiếp.

> **Nói thẳng về giới hạn của cơ chế này.** Đây **không phải** cơ chế chặn bằng mã. Cả hai lớp — chỉ dẫn cho Worker và giám sát của Manager — đều là agent làm theo lời dặn. Worker tự đếm rồi tự báo; Manager tin vào con số đó cộng với những gì công cụ Paseo nhìn thấy. Một Worker cố tình phớt lờ thì Phase 1 không có gì chặn được nó. Owner chấp nhận có ý thức hạn chế này (2026-09-15); cơ chế chặn bằng mã — tắt công cụ tạo agent của Paseo cho vai trò Worker rồi bắt nó đi qua một công cụ có kiểm ngân sách — được hoãn sang Phase 3 và chỉ làm nếu số liệu thực tế cho thấy cần.

**Đơn vị đếm, phải chặt để đếm được:**

| Khái niệm | Định nghĩa |
|---|---|
| `requestId` | Một yêu cầu của người dùng, sinh khi Manager giao việc; theo suốt vòng đời Worker |
| `batchId` | Một lô thay đổi mạch lạc: một tài liệu, hoặc một đợt tạo/cập nhật bead, hoặc **toàn bộ chặng implement của một bead**. Sinh khi lô mở ra và **không được đổi** khi sửa theo phát hiện review — sửa xong vẫn là lô cũ, nên lượt kiểm lại là lượt thứ hai của chính nó |
| Một "lượt" | **Một lần gọi** review hoặc polish, bất kể có tái dùng cùng một agent hay không |

**Ngân sách:**

> Errata 2026-09-16: bảng dưới đây đã được thay bằng [delta review-budget](./paseo-bm-delta-20260916-review-budget.md) §4 (review gom theo giai đoạn, tổng 1 / 4 / 6, bỏ polish).
>
> Errata 2026-09-17: polish quay lại cho Vừa và Lớn dưới dạng lượt `polishing-beads` của chính Worker, cùng `reviewing-plan`; các lượt skill này **không** tính vào ngân sách review 1 / 4 / 6. Xem [delta workflow-skills](./paseo-bm-delta-20260917-workflow-skills.md) §4.2 (`design-delta-20260917-workflow-skills`).

| | Nhỏ | Vừa | Lớn |
|---|---|---|---|
| Review mỗi lô | 1 (sau implement) | tối đa 2 | tối đa 2 |
| Polish mỗi đợt beads | 0 | tối đa 1 | tối đa 1 |
| Tổng số lần gọi review + polish cho một `requestId` | **1** | **6** | **10** |

- Hết lượt mà lô vẫn còn mục chặn: **dừng, báo người dùng** kèm danh sách còn lại. Không review lượt thứ ba.
- Chạm ngân sách tổng: phải hỏi người dùng mới được gọi thêm. Người dùng đồng ý thì phần vượt là **hợp lệ** và không tính là vi phạm khi nghiệm thu.
- Bộ đếm cùng `requestId` nằm trong báo cáo có cấu trúc, nên cả người dùng lẫn Manager đều thấy. Manager theo dõi và dừng Worker khi thấy vượt mà chưa được phép.

**Ngôn ngữ (REQ-032a, Q-027).** Chỉ dẫn vai trò và prompt hệ thống: **tiếng Anh**. Tài liệu Worker tạo cho repo đích: **theo ngôn ngữ đang có của repo đó**, mặc định tiếng Anh nếu repo chưa có tài liệu nào.

Chỉ dẫn được nạp vào agent làm **system prompt qua hook server `before("agent.create")` của plugin**, nhận diện vai trò theo `config.provider` (`bm-manager`, `bm-worker`, `bm-reviewer`, kể cả dạng `<id>/<model>`); nếu config đã có system prompt khác thì chỉ dẫn vai trò đứng trước, phần cũ giữ phía sau, và không nhân đôi khi đã có. Lý do: công cụ `create_agent` của Paseo không có tham số system prompt, nên Worker do Manager tạo và Reviewer do Worker tạo sẽ không có chỉ dẫn nếu chỉ dựa vào prompt khởi tạo (bm-hld). Nội dung ba file `roles/*.md` được nhúng vào bundle lúc build (`plugin/server/{manager,worker,reviewer}-instructions.ts`). Cơ chế này không phụ thuộc việc người dùng đã cài skills hay chưa. Skills của bên thứ ba (feature-workflow…) là thứ **nâng chất lượng** chứ không phải điều kiện để chạy — nhưng thiếu thì Worker làm kém đi, nên phải cảnh báo (REQ-007j).

*Errata 2026-09-15 (bm-msy) — chế độ quyền của agent con:* theo quyết định của owner sau nghiệm thu điều phối (2026-09-15, duyệt qua `prd-delta-20260915-subagent-modes`), cả Manager (khi tạo Worker) và Worker (khi tạo Reviewer) đặt `settings.modeId` là mode của profile nếu có. Nếu profile không có mode, chúng gọi `inspect_provider` một lần rồi chọn theo vai trò:
- **Worker:** mode chạy không hỏi quyền của provider (Claude `bypassPermissions`, Codex `full-access`, OpenCode chế độ tương đương; thường có `colorTier` `dangerous`). Provider không có mode như vậy thì lấy mode `moderate` đầu tiên, rồi mới tới `safe`.
- **Reviewer:** mode tự động **không** mở toàn quyền hay quyền mạng (Codex `auto`, Claude `auto`; provider khác thì mode `moderate` đầu tiên không mở toàn quyền hay mạng). **Không bao giờ** giao Reviewer mode `dangerous`/full-access. Không có mode như vậy thì lấy `safe`.

Cả hai vai trò: không bao giờ chọn mode `planning`. Lý do: các lượt F-3/F-4/F-5 phát sinh 20–42 lời hỏi quyền, agent phải dừng chờ người dùng xác nhận. **Rủi ro đã biết:** cổng tác dụng phụ của Worker (hỏi trước khi cài phụ thuộc, dùng mạng, migration, deploy; cấm lệnh phá huỷ, git, đọc bí mật) và quy tắc chỉ đọc của Reviewer giờ **chỉ còn là ràng buộc hành vi** trong chỉ dẫn vai trò, không còn lời hỏi quyền của Paseo làm lớp chặn thứ hai; câu "Vượt ranh giới thì để người dùng phê duyệt trong Paseo" ở §7 vì vậy không còn áp cho Worker và Reviewer. Manager **không đổi**: nó vẫn chạy ở mode của profile `bm-manager` và không bao giờ phê duyệt yêu cầu quyền thay người dùng. Cũng trong bm-msy, mọi bead Worker tạo phải có mục `## Provenance` ghi `requestId` và yêu cầu gốc của người dùng.

*Errata 2026-09-18 ([delta 20260918](./paseo-bm-delta-20260918-manager-mode-model-metrics.md) §4.1, owner chốt Q31, Q36–Q39):* câu "Manager **không đổi**" ở trên không còn đúng. `manager.ensure` tạo Manager ở mode không hỏi quyền của provider (mode `dangerous` đầu tiên: Claude `bypassPermissions`, Codex `full-access`) khi profile `bm-manager` không tự đặt mode mà provider có liệt kê — mode tự đặt thì thắng, kể cả `planning`; không có mode nào như vậy thì để mặc định và ghi một dòng log. Manager mới mang nhãn `bm.modeSet=<mode>`. Manager đã có mà chưa mang nhãn đó được chuyển **một lần** khi màn hình Manager mở lại nó, bằng `paseo agent mode` rồi `paseo agent update --label` (SDK plugin không đổi được mode của agent đã tồn tại); Manager đang chạy thì bỏ qua lần đó; mọi lỗi thành `modeNotice`, không chặn việc mở Manager. Có nhãn rồi thì plugin không bao giờ đổi mode của Manager đó nữa. Manager vẫn không bao giờ phê duyệt yêu cầu quyền thay người dùng. Đường gọi CLI từ trong daemon **chưa nghiệm thu trên daemon thật** (ngoại lệ theo quyết định owner, bead `bm-wp-249-5qqp.1`).

## 3. Data Model

### 3.1 Bố cục thư mục cài đặt

```
~/.paseo-bm/                        (0700, đổi bằng --home hoặc PASEO_BM_HOME)
  install.json                      (0600) hồ sơ cài đặt — nguồn sự thật về quyền sở hữu
  plugin/
    0.1.0/                          payload phiên bản đang dùng (gồm cả roles/)
    0.0.9/                          các phiên bản trước — GIỮ LẠI, chỉ --prune mới xoá
  backups/
    20260915T101500Z/
      paseo-config.json             bản sao config.json trước khi sửa
      plugin/0.1.0/...              bản sao file bị ghi đè có chủ đích
  traces/                           (0700) lưu vết Dashboard — dữ liệu do paseo-bm tạo
    meta.json                       (0600) { schemaVersion, createdAt, updatedAt }
    <workspaceId>/                  (0700) một thư mục cho mỗi workspace
      meta.json                     (0600) tên và đường dẫn cuối biết được của workspace
      events-<YYYYMM>.jsonl         (0600) nối thêm, một bản ghi lượt một dòng
  .lock
```

`traces/` là **dữ liệu do paseo-bm tạo nhưng thuộc người dùng**: không có hash trong `install.json`, không được backup, cài và cập nhật không bao giờ chạm. Xem §3.3 loại `user-data`, [ADR-007](../adr/ADR-007-dashboard-trace-store.md), và [Technical Design Dashboard](paseo-bm-dashboard.md) §3.

### 3.2 `install.json`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `schemaVersion` | number | Bắt đầu từ `1`; lớn hơn mức CLI hiểu → dừng |
| `version` | string | Phiên bản gói npm đã cài |
| `installedAt` / `updatedAt` | ISO 8601 UTC | |
| `installHome` | string | Đường dẫn tuyệt đối đã dùng |
| `paseo.home` | string | Lấy từ `paseo daemon status --json` |
| `paseo.pluginId` / `paseo.pluginDir` | string | Plugin đã đăng ký |
| `paseo.pluginsEnabledSetByUs` | boolean | Cơ sở để lệnh gỡ có đề nghị tắt lại hay không |
| `paseo.pluginsEnabledPrevious` | `{ present, value }`, tuỳ chọn | Trạng thái `pluginsEnabled` **trước khi** paseo-bm bật lần đầu, cùng mẫu với `mcpInject.previous`; ghi trước khi chạm `config.json`. Gỡ và người dùng chọn tắt lại: vắng → xoá khoá, `false` → `false`, chỉ khi giá trị hiện tại vẫn là `true` do paseo-bm đặt. Hồ sơ cũ không có trường này thì gỡ như trước (đặt `false`), không đoán |
| `paseo.mcpInject` | `{ setByUs, previous: { present, value } }` | Ghi trạng thái **trước khi** paseo-bm chạm vào: khoá có tồn tại không và giá trị là gì. Boolean đơn thuần không phân biệt được "trước đó vắng mặt" với "trước đó là `false`", nên không hoàn tác đúng được (ADR-006 quyết định 8) |
| `paseo.createdConfigContainers` | string[], tuỳ chọn | Container trong `config.json` do chính paseo-bm tạo, chỉ thuộc tập đóng `agents`, `agents.providers`, `daemon`, `daemon.agentProfiles`, `daemon.mcp`. Chỉ ghi khi container chưa tồn tại lúc paseo-bm sắp tạo nó, ghi trước khi chạm `config.json`, gộp và không bao giờ bị bớt qua các lần cài/cập nhật. Gỡ: sau khi xoá mục `bm-*`, container trong danh sách mà nay rỗng thì bị xoá, từ trong ra ngoài; container có sẵn từ trước hoặc còn nội dung khác thì giữ. Vắng = không có container nào |
| `roles[]` | `{ role, providerId, profileId, baseProvider, model, modeId, thinkingOptionId, paseoTools }` | Ba vai trò `bm-manager`, `bm-worker`, `bm-reviewer` do paseo-bm tạo |
| `files[]` | `{ path, sha256, mode }` | Mọi file payload gồm cả `roles/*.md` |
| `versions[]` | `{ version, dir, installedAt, active }` | Giữ tất cả; chỉ `--prune` xoá |
| `backups[]` | `{ at, dir, reason }` | Để liệt kê và khôi phục |
| `skills.agents[]` | string[] | Danh sách agent người dùng chọn cho CLI `skills` |
| `skills.lastStatus` | `{ agent, skill, present }[]` | Ảnh chụp lần dò gần nhất |
| `skills.assistDeclinedAt` | ISO \| null | Người dùng chọn "đừng hỏi lại" |
| `skills.lastCommand` | string \| null | Lệnh đã chạy hộ |
| `skills.assistOutcome` | `"ok" \| "failed" \| "interrupted" \| null` | Kết quả lần hỗ trợ gần nhất |

Ghi atomic, quyền `0600`, không chứa bí mật.

### 3.3 Phân loại quyền sở hữu

| Tình trạng đích | Điều kiện | Hành động mặc định |
|---|---|---|
| `unchanged` | có trong `files[]`, hash khớp | bỏ qua |
| `outdated` | có trong `files[]`, hash khớp bản ghi cũ nhưng khác bản mới | cập nhật |
| `user-modified` | có trong `files[]`, hash không khớp bản ghi | giữ; hỏi khi tương tác; `--force` mới ghi đè, luôn backup |
| `conflict` | tồn tại trên đĩa, không có trong `files[]` | bỏ qua, báo |
| `missing` | có trong `files[]` nhưng không còn trên đĩa | tạo lại |
| `user-data` | nằm trong `<install home>/traces/` | không hash, không backup, không so sánh; cài và cập nhật (gồm cả `--prune`) **không bao giờ** chạm; chỉ lệnh gỡ được xoá và phải hỏi trước |

Loại `user-data` là **dữ liệu tích luỹ**, không phải tài sản phiên bản, nên nó đứng ngoài mọi quy tắc hash, backup và `--prune` *(delta `design-delta-20260916-trace-store`)*.

**Phạm vi thực tế:** nâng cấp luôn copy sang `plugin/<version mới>/` nên mọi đích đều là `missing`. Ba trạng thái xung đột chỉ xảy ra khi cài lại cùng phiên bản, sửa chữa trong thư mục đang hoạt động, hoặc với chính `install.json`. Quy tắc này áp dụng cho cả `roles/*.md`.

### 3.4 Phần paseo-bm ghi vào `config.json`

| Khoá | Ghi gì | Điều kiện |
|---|---|---|
| `pluginsEnabled` | `true` | Có đồng ý riêng (REQ-006) |
| `plugins` | Do **Paseo** ghi khi chạy `paseo plugin install` | paseo-bm không tự ghi khoá này |
| `agents.providers.bm-manager` / `bm-worker` / `bm-reviewer` | `{ extends, label, paseoTools }` — không `command`, không `env` | Có đồng ý cấu hình vai trò |
| `daemon.agentProfiles[]` | Thêm/sửa **chỉ** các mục `id` bắt đầu bằng `bm-`; giữ nguyên mục khác và thứ tự | Như trên |
| `daemon.mcp.injectIntoAgents` | `true` | **Bước tiêu chuẩn của luồng cài**, hỏi **gộp chung** với việc bật plugin. Cảnh báo nêu đủ hai hệ quả: plugin là mã không sandbox, và mọi agent trên máy được quyền tạo, nhắc, dừng agent khác. Không tương tác thì cần `--enable-plugins`. Ghi trạng thái trước theo §3.2 để hoàn tác đúng (ADR-006 quyết định 3 và 8) |

## 4. Hợp đồng dòng lệnh

### 4.1 Lệnh

| Lệnh | Ý nghĩa |
|---|---|
| `paseo-bm` | Có TTY: wizard. Không TTY: xem trước rồi thoát mã 6 |
| `paseo-bm install` | Cài hoặc cập nhật (cùng một đường mã) |
| `paseo-bm configure` | Cấu hình lại vai trò agent mà không cài lại (REQ-028, P2 — Phase 1 chỉ cần `install --reconfigure`) |
| `paseo-bm doctor` | Kiểm tra sức khoẻ. **Không ghi gì.** Chỉ gọi lệnh Paseo **chỉ-đọc** (`daemon status`, `plugin ls`); không bao giờ gọi CLI `skills`; không chạm mạng |
| `paseo-bm uninstall` | Gỡ những thứ paseo-bm sở hữu |
| `paseo-bm --version` / `--help` | |

`install` và `uninstall` mặc định **chỉ xem trước**; phải có `--apply` mới ghi.

### 4.2 Cờ

| Cờ | Áp dụng | Ghi chú |
|---|---|---|
| `--apply` | install, uninstall | Không có thì chỉ xem trước |
| `--yes` | install, uninstall | Bỏ qua xác nhận áp dụng; **không** ngầm đồng ý bất kỳ ranh giới tin cậy nào |
| `--enable-plugins` | install | Đồng ý **cả hai việc trong cùng một ranh giới tin cậy**: bật `pluginsEnabled` và mở quyền công cụ Paseo cho agent (REQ-006, REQ-031c). Gộp vì bật plugin mà không mở quyền thì Manager không tạo được Worker. Cảnh báo phải nêu đủ cả hai hệ quả |
| `--install-skills` | install | Đồng ý cho chạy CLI `skills` |
| `--skills-agents <list>` | install, doctor | Danh sách agent đích cho CLI `skills`, mặc định `claude,codex`. Khi dựng lệnh cho CLI `skills`, `claude` được đổi thành `claude-code` (tên CLI `skills` 1.5.26 dùng); tên khác giữ nguyên *(errata 2026-09-15)* |
| `--role <role>=<provider>/<model>` | install | Chọn công cụ cho vai trò, lặp lại được. Ví dụ `--role worker=codex/gpt-5.6-sol` |
| `--reconfigure` | install | Hỏi lại toàn bộ cấu hình vai trò dù đã có |
| `--skip-skills-check` | install, doctor | Bỏ hẳn phần skills |
| `--force` | install, uninstall | Cài: ghi đè `user-modified`. Gỡ: xoá cả file `user-modified` |
| `--ask-skills-again` | install | Xoá ghi nhớ "đừng hỏi lại" của bước skills |
| `--restore-backups` | uninstall | Khôi phục backup trước khi xoá |
| `--prune` | install | Dọn payload cũ và backup; **chỉ** khi người dùng yêu cầu. Không gắn cho `doctor` vì `doctor` không ghi |
| `--home`, `--paseo-home`, `--claude-home`, `--codex-home` | tất cả | Hoặc biến môi trường tương ứng |
| `--json`, `--verbose` | tất cả | |

Thứ tự ưu tiên: cờ > biến môi trường > mặc định.

### 4.3 Mã thoát

| Mã | Ý nghĩa |
|---|---|
| 0 | Thành công, hoặc xem trước hoàn tất theo chủ đích, hoặc `doctor` báo khoẻ |
| 1 | `doctor` phát hiện sai lệch thuộc phạm vi sở hữu |
| 2 | Dùng sai lệnh/cờ (gồm `--skills-agents` và `--role` sai định dạng) |
| 3 | Tiền đề môi trường không đạt — chưa ghi gì |
| 4 | Đã cài nhưng một ranh giới tin cậy chưa được đồng ý (plugin chưa bật, hoặc quyền công cụ chưa mở) |
| 5 | Dừng vì xung đột cần người quyết định |
| 6 | Không có TTY và không có `--apply`: đã in bản xem trước, chưa ghi gì |
| 7 | Đã chép file và ghi hồ sơ, nhưng Paseo không cài được hoặc không nạp được plugin — xem `paseo plugin logs paseo-bm` *(errata 2026-09-15)* |

Cảnh báo về skills và beads CLI không bao giờ đổi mã thoát. Kiểm định `--skills-agents` và `--role` chạy **lúc phân tích tham số**, trước preflight và trước mọi thao tác ghi.

### 4.4 Hình dạng JSON

```jsonc
{
  "schemaVersion": 1,
  "command": "install",              // install | doctor | uninstall
  "mode": "preview",                 // preview | applied
  "paseoBmVersion": "0.1.0",
  "paseo": { "cliVersion": "0.8.0", "daemonVersion": "0.8.0", "home": "…", "pluginsEnabled": false },
  "actions": [
    { "kind": "create", "target": "installHome/plugin/0.1.0/roles/worker.md", "reason": "missing" },
    { "kind": "config", "target": "paseoHome/config.json#daemon.agentProfiles[bm-worker]", "from": null, "to": "…", "consent": "interactive" }
  ],
  "roles": [
    { "role": "worker", "provider": "codex", "model": "gpt-5.6-sol", "paseoTools": true, "loggedIn": true }
  ],
  "skills": { "source": "cuongntr/agent-skills", "required": ["…"], "byAgent": { "claude": { "present": [], "missing": [] } },
              "suggestedCommand": "npx -y skills add …", "assisted": false, "outcome": null },
  "warnings": [{ "code": "W_BEADS_CLI_MISSING", "message": "…" }],
  "result": { "exitCode": 0, "pluginState": "running" }
  // Khi lệnh thất bại với một mã trong sổ đăng ký (errata 2026-09-15):
  // "result": { "exitCode": 3, "pluginState": null, "error": { "code": "E_TARGET_NOT_WRITABLE", "message": "…" } }
}
```

`result.error` **chỉ có mặt khi lệnh thất bại** với một mã lỗi trong sổ đăng ký; lệnh thành công thì không có khoá này, nên script kiểm `"error" in result` là biết lệnh lỗi hay không *(errata 2026-09-15)*.

`doctor` thay `actions[]` bằng `checks[]` gồm `{ id, severity: "ok" | "warn" | "error", message, remediation }`. Check `plugin-path` (đứng sau `plugin-status`) so thư mục Paseo đang nạp plugin với thư mục của phiên bản active trong `install.json`: lệch là `error`, Paseo không báo đường dẫn là `warn`; `install-version` báo `error` cả khi `version` của hồ sơ khác phiên bản active *(errata bm-p48, 2026-09-15 — sau lần cập nhật hỏng, doctor từng báo `ok` dù plugin vẫn chạy bản cũ)*. `uninstall` dùng `actions[]` với `kind: "delete" | "keep" | "config"`.

Khi bật `--json`, stdout chỉ chứa đúng một tài liệu JSON; output của tiến trình con đi ra **stderr**.

**Sổ đăng ký mã lỗi** là một hằng số duy nhất, đủ cho Phase 1, mỗi mục có thông điệp và cách khắc phục: `E_DAEMON_UNREACHABLE`, `E_VERSION_MISMATCH`, `E_UNSUPPORTED_OS`, `E_NODE_TOO_OLD`, `E_PASEO_CLI_MISSING`, `E_PASEO_OUTPUT_UNEXPECTED`, `E_CONFLICT`, `E_BAD_SKILLS_AGENTS`, `E_BAD_ROLE_SPEC`, `E_CONFIG_CONCURRENT_WRITE`, `E_RECORD_SCHEMA_TOO_NEW`, `E_LOCKED`, `E_PROVIDER_UNAVAILABLE`, `E_UNSAFE_INSTALL_HOME`, `E_PATH_ESCAPE`, `E_SYMLINK_IN_PATH`, `E_TARGET_NOT_WRITABLE`, `E_PLUGIN_LOAD_FAILED`, `E_TIMELINE_UNAVAILABLE`, `E_BEADS_STORE_UNREADABLE`, `E_TRACE_NOT_FOUND`, `E_TRACE_STORE_UNWRITABLE`, `E_TRACE_STORE_SCHEMA_TOO_NEW`, `E_TRACE_REASSIGN_INVALID`, `W_SKILLS_MISSING`, `W_BEADS_CLI_MISSING`, `W_SKILLS_ASSIST_FAILED`, `W_PROVIDER_NOT_LOGGED_IN`. Không được đặt mã tại chỗ. Sáu mã `E_TIMELINE_UNAVAILABLE` → `E_TRACE_REASSIGN_INVALID` thuộc các RPC của Dashboard (delta `design-delta-20260916-trace-store`); chúng đi qua kênh RPC của plugin nên **không** có mã thoát CLI. Năm mã `E_UNSAFE_INSTALL_HOME`, `E_PATH_ESCAPE`, `E_SYMLINK_IN_PATH`, `E_TARGET_NOT_WRITABLE` (mã thoát 3, chưa ghi gì) và `E_PLUGIN_LOAD_FAILED` (mã thoát 7) được bổ sung theo errata 2026-09-15.

## 5. Hợp đồng RPC của plugin

Ba RPC, định nghĩa bằng Zod trong `shared/contracts.ts`, xử lý trong `index.server.ts`:

| RPC | Input | Output | Ngữ nghĩa |
|---|---|---|---|
| `manager.ensure` | `{ workspaceId }` | `{ agentId, created }` | Tìm Manager còn sống của workspace (theo nhãn `bm.role=manager`); có thì trả về, chưa có thì tạo bằng profile `bm-manager` với chỉ dẫn từ `roles/manager.md` |
| `agents.list` | `{ workspaceId }` | `{ agents: [{ id, role, title, status, parentId, updatedAt }] }` | Dựng cây từ nhãn `bm.role` và `paseo.parent-agent-id` |
| `roles.describe` | `{}` | `{ roles: [{ role, provider, model, paseoTools, instructionsPath }] }` | Để panel hiển thị cấu hình đang có hiệu lực (REQ-032d). Nguồn dữ liệu là **cấu hình Paseo đang có hiệu lực**, đọc qua `paseo.config.get()` của SDK — không đọc `install.json`: `provider` = `extends` của `agents.providers.bm-<vai trò>`, `model` lấy từ `daemon.agentProfiles[bm-<vai trò>]`, `paseoTools` = `paseoTools.enabled === true` của provider dẫn xuất, `instructionsPath` = tên chỉ dẫn nhúng trong bundle (ví dụ `roles/manager.md`), không phải đường dẫn trên đĩa. Vai trò không có cả provider lẫn profile thì bị bỏ qua (errata 2026-09-15) |

Các RPC của Dashboard (`traces.list`, `traces.get`, `traces.delete`, `traces.reassign`, `beads.stats`) được định nghĩa ở [Technical Design Dashboard](paseo-bm-dashboard.md) §5; ba RPC trên không đổi *(delta `design-delta-20260916-trace-store`)*.

Plugin **không** có RPC xoá agent: theo ADR-005, vòng đời do người dùng quyết định qua chính giao diện Paseo.

Nhãn dùng để nhận diện: paseo-bm gắn `bm.role` = `manager` | `worker` | `reviewer` và `bm.version` khi tạo agent. Worker và Reviewer do agent tạo ra nên chỉ dẫn yêu cầu chúng tự gắn nhãn tương ứng; panel phải chịu được trường hợp nhãn thiếu (hiển thị là "không rõ vai trò") thay vì vỡ.

## 6. Integration & Events

| Bên ngoài | Cách gọi | Ngữ nghĩa lỗi |
|---|---|---|
| Paseo CLI (trình cài đặt) | `paseo daemon status\|reload --json`, `paseo plugin install\|ls\|logs\|remove --json`; tiến trình con, không qua shell, timeout 15 giây | Không tới được → dừng ở preflight, mã 3. JSON lạ → `E_PASEO_OUTPUT_UNEXPECTED` |
| `~/.paseo/config.json` | Đọc–sửa–ghi tối thiểu theo §3.4; backup trước; reload sau; thử lại một lần khi phát hiện ghi song song | Reload lỗi → khôi phục backup, reload lại, báo lỗi |
| Paseo SDK (trong plugin server) | `paseo.workspaces`, `paseo.agents` để tìm và tạo Manager, đọc trạng thái | Lỗi SDK → RPC trả lỗi có mã; panel hiển thị và mời thử lại; không tạo agent trùng |
| Công cụ Paseo cấp cho agent | Manager và Worker dùng để tạo, liệt kê, theo dõi, nhắc việc và dừng agent | Quyền chưa mở → agent không có công cụ; `doctor` phải phát hiện và báo |
| beads CLI (`br`/`bd`) | **Worker** gọi trực tiếp trong workspace | Thiếu → cảnh báo lúc cài; Worker báo không làm được phần beads |
| CLI `skills` | Chỉ trình cài đặt gọi, sau khi có đồng ý; chế độ symlink mặc định; timeout 300 giây | Mọi lỗi đều không chặn và không đổi mã thoát |
| Lệnh đăng nhập của provider | Gọi đúng lệnh login của công cụ đó khi người dùng đồng ý (REQ-027b) | Thất bại → in hướng dẫn thủ công; vai trò vẫn đăng ký, `doctor` báo `W_PROVIDER_NOT_LOGGED_IN` |

Không telemetry. CLI `skills` có kênh thu thập riêng của nó; README phải nói rõ.

## 7. Security

- **Ranh giới tin cậy 1 — bật plugin.** Plugin chạy không sandbox. Đồng ý rõ ràng hoặc `--enable-plugins`; `--yes` không tính.
- **Ranh giới tin cậy 2 — chạy tiến trình ngoài.** CLI `skills` và lệnh login của provider. Nguồn skills là hằng số trong gói; argv dạng mảng, không qua shell; in nguyên văn lệnh trước khi chạy.
- **Ranh giới tin cậy 3 (mới) — mở quyền tạo agent.** Cho Manager và Worker quyền dùng công cụ Paseo nghĩa là cho chúng tạo và dừng agent khác, tức là tiêu tiền và chạy mã. Phải có đồng ý rõ ràng — **gộp chung một lần hỏi với việc bật plugin**, cờ `--enable-plugins` ở chế độ không tương tác (ADR-006 quyết định 3), và `doctor` phải hiển thị vai trò nào đang có quyền.
- **Tham số do người dùng nhập.** `--skills-agents` và `--role` kiểm định lúc phân tích tham số: `--skills-agents` mỗi phần tử khớp `^[a-z0-9][a-z0-9_-]{0,31}$`, tối đa 8, loại trùng, từ chối phần tử bắt đầu bằng `-`; `--role` phải khớp đúng ba tên vai trò và một cặp provider/model có thật trong danh sách Paseo trả về. Sai → mã 2, không ghi gì.
- **Phạm vi ghi của trình cài đặt.** Chỉ `<install home>/**` và các khoá ở §3.4. Có test chứng minh không ghi ra ngoài, kể cả vào thư mục skills.
- **Phạm vi hành động của agent.** Worker sửa tài liệu, kho beads **và mã nguồn thuộc bead**, tất cả trong workspace. Cấm tuyệt đối: git, lệnh phá huỷ, ghi ra ngoài workspace, đọc credential. Phải hỏi trước khi cài phụ thuộc, chạy lệnh cần mạng, chạy migration trên dữ liệu thật, deploy hay publish. Vượt ranh giới thì để người dùng phê duyệt trong Paseo. *(Errata 2026-09-15, bm-msy: câu này nay chỉ còn áp cho Manager; Worker chạy ở mode không hỏi quyền và Reviewer ở mode tự động không mở mạng — xem §2.6.)* *(Errata 2026-09-18, delta 20260918: Manager cũng chạy ở mode không hỏi quyền, nên câu phê duyệt trong Paseo không còn áp cho vai trò nào của paseo-bm — xem §2.6.)* Không agent nào được lưu trữ hay xoá agent; Manager được dừng.
- **Chống thoát thư mục.** Mọi đường dẫn `resolve` rồi kiểm tra nằm trong gốc cho phép; từ chối install home trùng/chứa `$HOME`, `~/.paseo`, thư mục cấu hình agent; `lstat` trước khi ghi để không đi xuyên symlink.
- **Bí mật.** Không đọc, ghi hay in credential. Che giá trị của `PASEO_PASSWORD`, `PASEO_DAEMON_PASSWORD` và token argv dạng mật khẩu ở cả ba kênh. Trong `~/.paseo` chỉ đọc `config.json`.
- **Không quản lý credential của provider.** Vai trò dùng lại phiên đăng nhập sẵn có; paseo-bm chỉ gọi lệnh login của công cụ gốc rồi đứng ngoài (ADR-006).
- **Chuỗi cung ứng.** Không script vòng đời npm chạy trên máy người cài; phát hành có provenance; phụ thuộc runtime tối thiểu.
- **Yêu cầu rà soát:** ba chỗ phải được owner review mã trước bản phát hành đầu: sửa `config.json`, chạy tiến trình ngoài, và phần plugin tạo agent.

## 8. Reliability

- **Atomic:** mọi file ghi qua tạm → `fsync` → `rename`.
- **Idempotent:** so hash trước khi ghi; chạy lại cùng phiên bản cho 0 Action; đăng ký vai trò cũng phải idempotent (mục `bm-*` đã đúng thì không ghi lại).
- **Cài bên cạnh:** payload mới vào thư mục phiên bản mới; bản cũ giữ lại; chỉ `--prune` xoá.
- **Khoá tiến trình:** `.lock` cho install và uninstall; `doctor` không lấy khoá.
- **Timeout:** mỗi lời gọi Paseo CLI 15 giây; chờ plugin `running` tổng 30 giây, poll 500 ms; CLI `skills` 300 giây, cảnh báo sau 60 giây không output; ghi `config.json` thử lại đúng một lần rồi dừng với `E_CONFIG_CONCURRENT_WRITE`.
- **Một Manager cho mỗi workspace:** `manager.ensure` tìm theo nhãn trước khi tạo. Manager bị người dùng xoá → lần mở sau tạo mới, không báo lỗi.
- **Agent mồ côi:** Worker vẫn chạy khi Manager đã bị xoá thì không bị ảnh hưởng; panel hiển thị nó ở nhánh "không có Manager" thay vì giấu đi.
- **Worker chết giữa chừng:** tài liệu và beads đã ghi vẫn hợp lệ; người dùng thấy trạng thái lỗi và đọc được agent đó để biết dừng ở đâu. paseo-bm không tự dọn.
- **Dọn rác:** chỉ thư mục payload dở dang (không có trong `versions[]`) mới bị dọn.
- **Không tác vụ nền, không cron, không watcher.** Bộ thu thập lưu vết của Dashboard bám hook `agent.turn_ended` của Paseo nên vẫn nằm trong quy tắc này: nó chạy theo sự kiện, không có đồng hồ, không quét đĩa, và lỗi ghi bị nuốt để không ảnh hưởng agent *(delta `design-delta-20260916-trace-store`)*.

## 9. Interaction Flow

### 9.1 Cài đặt

```
cli → preflight ─(đạt)→ record.load → planner ─→ report(xem trước, gồm cả vai trò sẽ đăng ký)
                                                     │ xác nhận (mặc định "Không")
                                                     ▼
  applier: tạo plugin/<ver> (atomic, gồm roles/*.md) → ghi hồ sơ tạm
        → paseo plugin install <dir> --id paseo-bm --json
        → pluginsEnabled? ──tắt──→ cảnh báo tin cậy → đồng ý? ──không──→ bỏ qua (mã 4)
                                                        │ có
                                                        ▼ backup → sửa 1 trường → reload → xác minh
        → cấu hình vai trò: hỏi tên + provider/model cho Worker và Reviewer (và Manager)
        → provider chưa đăng nhập? → mời chạy lệnh login của chính công cụ đó
        → (mở quyền công cụ đã gộp vào câu hỏi bật plugin ở trên — ADR-006 quyết định 4)
        → backup → ghi agents.providers.bm-* và daemon.agentProfiles[bm-*] → reload → xác minh
        → chốt install.json (files[] + versions[] + roles[] + ai bật cái gì)
        → skills: dò → thiếu? → hiện lệnh → đồng ý? → chạy CLI skills → dò lại
        → report(tóm tắt: plugin running, vai trò đã đăng ký, trạng thái đăng nhập, skills)
```

*Errata 2026-09-15:* quyền công cụ (`daemon.mcp.injectIntoAgents`) được bật cùng `pluginsEnabled` sau **một** cảnh báo và **một** lần đồng ý (ADR-006 quyết định 3, 4). Câu hỏi cấu hình vai trò và kiểm tồn tại provider/model chạy **trước** bản xem trước, để bản xem trước liệt kê được vai trò sẽ đăng ký và `E_PROVIDER_UNAVAILABLE` ra trước mọi thao tác ghi; thứ tự **ghi** giữ như sơ đồ.

*Errata 2026-09-15 (bm-vey) — cập nhật sang phiên bản mới:* Paseo 0.8 từ chối `paseo plugin install` khi id đã được cấu hình (`Plugin ID "paseo-bm" is already configured; choose another ID with --id`) và không có lệnh đổi đường dẫn của plugin dạng thư mục (`update` chỉ cho Git). Vì vậy bước `paseo plugin install <dir> --id paseo-bm --json` trong sơ đồ trên được thay bằng:

```
đọc `paseo plugin ls --json` (đã có trong luồng) → thư mục Paseo đang dùng (thiếu thì lấy paseo.pluginDir của hồ sơ)
  ├─ chưa cấu hình ─────────────→ install <dir mới>
  ├─ đã trỏ đúng <dir mới> ─────→ không gọi Paseo (idempotent)
  └─ trỏ thư mục khác ──────────→ remove paseo-bm → install <dir mới>
                                        │ lỗi
                                        ▼
                  remove paseo-bm (Paseo 0.8 giữ mục của plugin không khởi động được; lỗi ở bước này được bỏ qua)
                  → install <dir cũ> → báo E_PLUGIN_LOAD_FAILED (mã 7) kèm kết quả đường lùi
```

- Hai đường dẫn được so sau `path.resolve`, không `realpath`, giống cách planner so (`resolve(state.dir) !== versionDirAbsolute`).
- Thành công: `versions[].active` và `paseo.pluginDir` chuyển sang bản mới.
- Đăng ký bản mới lỗi (kể cả khi `remove` lỗi): hồ sơ giữ `paseo.pluginDir` và `versions[].active` cũ, còn `version` (applier đã ghi bản mới trước bước đăng ký) được ghi trả về bản cũ; payload mới vẫn giữ trên đĩa. Thông điệp lỗi chứa **nguyên văn** lý do Paseo (trường `error.message` trong JSON lỗi của `--json`, không có thì lấy stderr) và nói rõ đường lùi đã khôi phục bản cũ hay cũng lỗi — nếu cũng lỗi thì có cả hai lý do và lệnh để đăng ký lại thư mục cũ.
- Plugin vắng mặt vài giây giữa `remove` và `install`; chấp nhận vì có đường lùi. Không bao giờ restart/stop daemon và không sửa tay khoá `plugins` trong `config.json`.

*Errata 2026-09-15 (bm-i52) — ghi đè payload trong thư mục đang chạy:* ở nhánh "đã trỏ đúng <dir mới>", nếu lượt này đã ghi (tạo hoặc cập nhật nội dung) ít nhất một file trong `plugin/<ver>` — sửa chữa, hoặc cài lại cùng phiên bản với nội dung khác — và plugin không ở trạng thái `disabled`, thì gọi `paseo plugin reload paseo-bm --json` rồi poll `plugin ls` tới khi `status` là `running` (30 giây, 500 ms như §8). Reload lỗi hoặc không tới `running` → `E_PLUGIN_LOAD_FAILED` (mã 7) kèm nguyên văn lý do Paseo; payload mới vẫn giữ. Không file nào đổi thì không gọi Paseo (idempotent). Plugin `disabled` không reload vì sẽ nạp file mới khi công tắc được bật. `actions[]` không đổi; tóm tắt cho người đọc có một dòng báo đã reload.

**Thứ tự "đăng ký plugin trước, bật công tắc sau" đã kiểm chứng** (2026-09-14): `paseo plugin install` thành công với mã 0 ngay cả khi `pluginsEnabled` chưa đặt, trả `status: "disabled"`. Nghiệm thu phải đọc `status`, không đọc `enabled`.

### 9.2 Giao việc

```
người dùng ──chat──▶ MANAGER
                       │ 1. đọc yêu cầu; nếu mơ hồ thì hỏi lại ngay tại chat
                       │ 2. tạo WORKER (profile bm-worker, cùng workspace, gắn nhãn bm.role=worker)
                       │ 3. trả lời: đã giao cho Worker nào, mở ở đâu
                       ▼
                    WORKER
                       │ a. đọc repo, tài liệu, kho beads
                       │ b. phân loại rủi ro → quyết định cần tài liệu gì
                       │ c. chạm tài liệu → tạo REVIEWER(tài liệu) → xử lý phát hiện mức chặn
                       │ d. suy ra bộ nhãn → truy vấn beads theo nhãn → cập nhật bead chưa đóng, hoặc tạo mới
                       │ e. chạm beads → tạo REVIEWER(beads) → xử lý phát hiện mức chặn
                       │ f. IMPLEMENT: làm từng bead sẵn sàng, chạy kiểm thử, đóng bead kèm bằng chứng
                       │ g. vướng bất kỳ đâu (kể cả giữa lúc implement) → DỪNG, hỏi người dùng, rồi đi tiếp
                       │ h. báo cáo rồi nghỉ (KHÔNG tự xoá mình, KHÔNG commit)
                       ▼
người dùng ──chat──▶ WORKER (làm rõ, chỉnh hướng, hoặc bảo tiếp tục)
người dùng ──hỏi──▶ MANAGER ("tình hình thế nào") → Manager dùng công cụ Paseo đọc trạng thái và trả lời
người dùng ──quyết định──▶ lưu trữ hoặc xoá Worker
```

### 9.3 Luồng lỗi bắt buộc đúng

| Tình huống | Xử lý |
|---|---|
| Daemon không chạy / lệch phiên bản / thiếu CLI | Dừng ở preflight, mã 3, chưa ghi gì |
| `paseo plugin install` lỗi | Giữ payload, không sửa `config.json`, in lệnh xem log, mã khác 0 |
| Reload xong nhưng plugin không `running` trong 30 giây | Báo lỗi kèm lệnh log; hồ sơ ghi trạng thái thực; không tự tắt công tắc |
| Daemon từ chối `config.json` sau reload | Khôi phục backup, reload lại, báo lỗi |
| Ghi `config.json` song song | Đọc lại và thử lại một lần; lệch tiếp → `E_CONFIG_CONCURRENT_WRITE`, giữ nguyên bản của bên kia |
| Người dùng từ chối mở quyền công cụ | Vẫn cài xong; vai trò vẫn đăng ký nhưng Manager sẽ không tạo được Worker; tóm tắt nói rõ và `doctor` báo tiếp |
| Provider chưa đăng nhập | Vai trò vẫn đăng ký; cảnh báo `W_PROVIDER_NOT_LOGGED_IN`; không chặn cài |
| Ctrl+C giữa chừng | File dở ở dạng tạm nên bị bỏ; payload chưa vào hồ sơ thì lần sau dọn; chạy lại là xong |
| Ctrl+C khi CLI `skills` đang chạy | Chuyển tín hiệu cho tiến trình con, ghi `assistOutcome: "interrupted"`, nhả khoá, in lệnh chạy lại |
| `manager.ensure` gặp hai Manager còn sống | Chọn cái mới nhất, báo trong panel, không tự xoá cái kia |
| Worker mất khi Manager còn sống | Manager báo trạng thái thật; không tự tạo lại Worker nếu người dùng chưa yêu cầu |

### 9.4 Gỡ

`preflight nhẹ → đọc install.json → planner(gỡ) → xem trước → xác nhận → paseo plugin remove → xoá mục bm-* trong agents.providers và daemon.agentProfiles → trả daemon.mcp.injectIntoAgents về cũ nếu chính ta bật → xoá payload theo versions[] → giữ file user-modified → hỏi tắt lại pluginsEnabled nếu chính ta bật và không còn plugin nào khác → xoá/giữ backup theo lựa chọn → báo cáo`.

Hai hành vi đã kiểm chứng của `paseo plugin remove`: **không** xoá thư mục nguồn cục bộ, và **để lại khoá `plugins: {}`**. Khoá rỗng đó là của Paseo, paseo-bm không xoá; M-5 vì vậy hiểu là "không còn thứ nào **do paseo-bm tạo**".

Lệnh gỡ **không** đụng tới các agent đang tồn tại: chúng là tài sản của người dùng. Tóm tắt nhắc rằng Manager và Worker cũ vẫn còn và tự lưu trữ hay xoá được.

### 9.x Hai slash command (delta 20260917e)

*Errata 2026-09-17.* Sau khi cài plugin, người dùng gõ được hai lệnh trong Paseo:

- **`/bm-worker-new <yêu cầu>`** — gọi `manager.ensure` cho workspace hiện tại, gửi cho Manager một tin nhắn có **dòng đầu là `BM-NEW-REQUEST`** rồi tới lời người dùng **nguyên văn**, và mở chat của nó. Dòng cờ là bắt buộc: thiếu nó, Manager áp luật của chính mình — tin nhắn đến khi đang có request sống là việc nối tiếp — và ném lời người dùng cho Worker đang bận, tức ngược hẳn mục đích của lệnh ([delta 20260917f](./paseo-bm-delta-20260917f-new-request-command.md)). Không có đường tạo Worker thứ hai: Manager vẫn cấp `requestId`, đoán cỡ và theo dõi (owner chốt Q24). Tham số rỗng thì **không gửi gì**, chỉ mở chat — một tin nhắn rỗng sẽ ép Manager tự đặt yêu cầu, điều mà chính chỉ dẫn của nó cấm.
- **`/bm-worker-stop-all`** — gọi RPC mới `agents.stop-all { workspaceId }`, chỉ **workspace hiện tại** (Q28). Máy chủ gửi `BM-STOP` cho từng Worker đang chạy và `REVIEWER_STOP_NOTICE` cho từng Reviewer đang chạy, bỏ qua agent đã lưu trữ (`send()` sẽ bỏ lưu trữ — ADR-005), và **không bao giờ đụng Manager**.

**Đây là "yêu cầu dừng", không phải "huỷ".** Paseo không cho plugin huỷ agent; cách ngắt duy nhất được hỗ trợ là gửi tin nhắn vào agent đang chạy để thay lượt hiện tại. Mọi lớp chữ — thông báo, `worker.md`, câu báo cho người dùng — phải nói "đã yêu cầu dừng", và có test cấm chữ "stopped".

**Kênh báo kết quả.** Một slash command của Paseo 0.8 **không có** đường báo thành công: composer chỉ hiện chữ khi `onSubmit` **ném lỗi**, và hiện dưới dạng toast lỗi. Báo một việc thành công bằng cách ném lỗi sẽ tô màu thất bại lên một việc đã chạy đúng, nên lệnh đẩy câu tổng kết vào hàng đợi `launcherNotices` rồi mở màn hình Beads Manager, nơi nó hiện như một dòng thông báo bình thường.

## 10. Testing Strategy

Khung: **Vitest**, Node 22 và 24, macOS và Linux.

| Tầng | Nội dung | Cách dựng |
|---|---|---|
| Unit | Phân loại quyền sở hữu, hash, đường dẫn, thứ tự cờ/env, dựng argv `skills`, parse `--role`, parse JSON Paseo, che bí mật, hợp nhất mảng `agentProfiles` | Hàm thuần |
| Integration (đa số) | Toàn bộ luồng install/doctor/uninstall trên **HOME giả**, với `paseo` và `skills` **giả lập bằng script trên PATH** ghi lại argv | Script giả lập trả JSON đặt trước |
| Bất biến an toàn | Guard chặn ghi ngoài `<install home>` và `config.json`; không ghi vào thư mục skills; không đọc file credential | Bộ khung ở lớp lõi, **mỗi lệnh tự bật cho bộ test của mình** |
| Hợp nhất cấu hình | Ghi `bm-*` vào một `config.json` đã có sẵn 6 provider và 6 profile của paseo-room, rồi khẳng định mọi mục `room-*` không đổi một byte | Fixture lấy từ cấu hình thật, đã ẩn danh |
| Gián đoạn & idempotent | Giết tiến trình sau từng bước rồi chạy lại; chạy lại cho 0 Action | Bảng tham số hoá theo điểm ngắt |
| Ma trận skills | 6 bố cục theo M-8 | HOME giả |
| Plugin | Typecheck payload; test RPC với Paseo SDK giả lập: `manager.ensure` khi chưa có, khi đã có, khi có hai Manager; `agents.list` dựng cây đúng kể cả khi thiếu nhãn | SDK giả lập |
| Chỉ dẫn vai trò | Test nội dung: mỗi file `roles/*.md` phải nêu đủ ranh giới an toàn bắt buộc (không git, không tự xoá agent, dừng lại hỏi khi có việc quyết định) | Khẳng định theo từ khoá và cấu trúc |
| Gói đã đóng | `npm pack` → cài tarball → chạy `--help`, `--version`, `install` xem trước | Bù khoảng trống của paseo-room |
| **Nghiệm thu điều phối** (thủ công, bắt buộc trước phát hành) | **Bộ 5 yêu cầu mẫu** trên repo dùng một lần với daemon thật: 1 Nhỏ, 2 Vừa, 1 Lớn chạm hợp đồng công khai, 1 trùng bead đang mở. Đo **M-10 → M-18**, tất cả phải đạt. Bằng chứng cho M-13 là **ảnh chụp hệ thống file trước/sau cộng toàn bộ timeline lệnh và tool call cộng kiểm remote và pull request** — `git reflog` một mình không đủ vì không thấy push, tạo PR hay ghi ngoài repo | Checklist trong `docs/operations/`, ghi lại kết quả |

CI **không** chạy agent thật: không xác định, tốn tiền, và cần đăng nhập. Chất lượng phần điều phối được bảo đảm bằng test hợp đồng RPC cộng bộ nghiệm thu thủ công ở trên.

## 11. Phase Scope Summary

- **Phase 1 MVP:** REQ-001 → REQ-015, REQ-020 → REQ-027, REQ-031 → REQ-035. Plugin có cả client và server entry. Worker đi hết chuỗi tài liệu → beads → **implement**. Chỉ daemon cục bộ.
- **Hoãn Phase 2:** REQ-016, REQ-017, REQ-028 (`configure` riêng), REQ-029 (giới hạn đồng thời), REQ-030 (lịch sử phiên), bảng báo cáo tiến độ bead.
- **Hoãn Phase 3:** REQ-019 (`--host`; lưu ý skills và agent nằm ở máy chạy daemon), WSL/Windows. *(Sửa 2026-09-15: "cho Worker đi tiếp sang bước implement" trước nằm ở đây, nay thuộc Phase 1b.)*

## 12. Backward Compatibility

- **Hồ sơ cài đặt:** `schemaVersion` 1. Bản 2 của design thêm `roles[]`, `paseo.mcpInjectSetByUs`, `skills.assistOutcome` — vẫn là schema 1 vì chưa có bản phát hành nào.
- **Hợp đồng JSON và mã thoát:** công khai từ bản đầu; trong cùng major chỉ thêm, không đổi nghĩa.
- **Hợp đồng RPC của plugin:** nội bộ giữa client và server của cùng phiên bản plugin, nên không phải hợp đồng công khai; vẫn phải kiểm tra phiên bản để tránh client cũ gọi server mới.
- **Chỉ dẫn vai trò:** là nội dung, không phải hợp đồng; nhưng thay đổi làm đổi hành vi agent nên phải ghi trong ghi chú phát hành.
- **Khi Paseo lên 0.9:** ba chỗ phải xem lại: `requirements.paseo` của payload, mức kiểm tra ở preflight, và các khoá cấu hình ở §3.4.

## 13. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-024 | Mở quyền công cụ → **báo trước rồi bật `daemon.mcp.injectIntoAgents`**, giữ `paseoTools` theo vai trò làm lớp thu hẹp bổ sung | hieu.nt10 | answered (2026-09-15) |
| Q-021 | Tiêu chí "bead liên quan" → **theo nhãn**: gán nhãn khi tạo, truy vấn theo nhãn khi kiểm tra (REQ-033) | hieu.nt10 | answered (2026-09-15) |
| Q-023 | Giới hạn của Worker → **không có giới hạn cứng**; chạy tới khi implement xong, vướng thì hỏi | hieu.nt10 | answered (2026-09-15) |
| Q-020 | Công cụ cho Reviewer → **hỏi người dùng lúc cài**, không ghép mặc định với Worker | hieu.nt10 | answered (2026-09-15) |
| Q-027 | Ngôn ngữ tài liệu cho repo đích → **theo repo đích**, mặc định tiếng Anh nếu repo chưa có tài liệu | hieu.nt10 | answered (2026-09-15) |
| Q-028 | Khi công tắc MCP toàn cục đã bật, `paseoTools` ở mức provider có vô hiệu hoá được quyền cho `bm-reviewer` không? Nếu không thì ràng buộc "Reviewer không tạo agent" chỉ còn nằm ở chỉ dẫn. Cần kiểm chứng trong phần nghiệm thu (ADR-006 quyết định 9) | hieu.nt10 | open — không chặn, nhưng phải kiểm chứng trước phát hành |
| Q-025 | Một workspace giới hạn đúng một Manager; nhưng nếu người dùng cố tình tạo cái thứ hai thì xử lý ra sao ngoài việc "chọn cái mới nhất và báo"? | hieu.nt10 | open |
| Q-026 | Manager có được tự nhắc Worker khi Worker treo quá lâu không, hay chỉ báo cho người dùng? Ảnh hưởng chỉ dẫn vai trò Manager | hieu.nt10 | open |
| Q-011 | Cho đổi nguồn skills bằng cờ hay cố định? Đang chốt **cố định** ở Phase 1 | hieu.nt10 | answered |
| Q-013 | Ghim phiên bản skills? CLI `skills` 1.5.26 không có cờ ghim ref → Phase 1 **không ghim** | hieu.nt10 | answered |
| Q-014 | Định danh agent cho `skills add -a` → **cho người dùng nhập**, có kiểm định | hieu.nt10 | answered |
| Q-015 | Symlink hay `--copy` → **symlink mặc định** | hieu.nt10 | answered |
| Q-016 | Giữ phiên bản và backup → **giữ tất cả**, chỉ `--prune` mới xoá | hieu.nt10 | answered |
| Q-017 | `paseo plugin install` khi công tắc tắt → **cài được**, trả `status: "disabled"` | hieu.nt10 | answered |

## 14. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | **Errata theo [delta 20260918](./paseo-bm-delta-20260918-manager-mode-model-metrics.md)** (owner chốt Q31, Q36–Q39): §2.6 Manager chạy ở mode không hỏi quyền; Manager đã có được chuyển một lần bằng Paseo CLI và đánh dấu `bm.modeSet`; §7 câu phê duyệt trong Paseo không còn áp cho Manager. `manager.ensure` trả thêm `modeNotice`. Nghiệm thu trên daemon thật chưa làm — ngoại lệ, không phải đạt |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | **[delta 20260917f](./paseo-bm-delta-20260917f-new-request-command.md)** — owner báo `/bm-worker-new` chỉ ném việc vào Worker đang chạy. Lệnh giờ gắn dòng cờ `BM-NEW-REQUEST`; Manager coi cờ đó luôn là việc mới và tạo Worker mới dù đang có Worker khác chạy, và **không bao giờ** gửi vào Worker đang `running` vì làm thế thay thế lượt của nó |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | **Errata theo [delta 20260917e](paseo-bm-delta-20260917e-manager-screen-and-commands.md)** — thêm §9.x: hai slash command `/bm-worker-new` và `/bm-worker-stop-all`, RPC `agents.stop-all`, thông báo `BM-STOP` và lối trả lời của Worker. Ghi rõ dừng là **yêu cầu**, không phải huỷ (Paseo không cho plugin huỷ agent), và vì sao kết quả lệnh không được báo bằng cách ném lỗi |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | **Áp dụng delta `design-delta-20260916-trace-store`** do owner duyệt: §3.1 thêm `traces/` vào bố cục thư mục cài đặt; §3.3 thêm loại quyền sở hữu thứ sáu `user-data` (không hash, không backup, cập nhật không chạm, chỉ lệnh gỡ được xoá sau khi hỏi); §4.4 thêm sáu mã lỗi của RPC Dashboard; §5 thêm con trỏ sang Technical Design Dashboard; §8 làm rõ rằng bộ thu thập bám hook sự kiện nên quy tắc "không tác vụ nền" vẫn giữ. Nội dung Phase 1 không đổi |
| 2026-09-14 | hieu.nt10 (soạn bởi Claude) | Bản 1: kiến trúc CLI, bố cục thư mục cài đặt, hợp đồng dòng lệnh/JSON/mã thoát, chiến lược kiểm thử; liên kết ADR-001 → ADR-004 |
| 2026-09-14 | hieu.nt10 (soạn bởi Claude) | Chốt Q-014 → Q-017; thêm `versions[]`, `skills.agents[]`; phân biệt `enabled` với `status`; ghi nhận hành vi của `paseo plugin remove` |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Sau lượt review plan: thêm mã thoát 6; định nghĩa lại bất biến của `doctor`; thêm ba cờ còn thiếu; hình dạng JSON cho `doctor`/`uninstall`; sổ mã lỗi; số timeout cụ thể; tên biến môi trường cần che |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Lượt hợp nhất sau review thứ hai: §2.6 F đổi thành **lan can hành vi** kèm phần nói thẳng về giới hạn, định nghĩa `requestId`/`batchId`/đơn vị đếm, và ngân sách theo mức (Nhỏ 1, Vừa 6, Lớn 10); §2.6 E thành **quy tắc có thứ tự** với ca biên cụ thể; mức Nhỏ có một lượt review sau implement; §2.1, §7, §10 sửa cho khớp việc Worker được sửa mã trong workspace; §10 đồng bộ M-10 → M-18 và bằng chứng M-13 mới |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Sau lượt review độc lập bằng Codex: thêm **§2.6 Hợp đồng hành vi giữa các agent** (hợp đồng nhãn đủ để implement, báo cáo Worker → Manager, định nghĩa lô review, quy tắc dừng và lan truyền, quy tắc ngôn ngữ); sửa §1 và §11 vốn còn nói Worker dừng ở beads và implement thuộc Phase 3; đổi `mcpInjectSetByUs` thành bản ghi trạng thái trước theo từng khoá; gộp `--enable-agent-tools` vào `--enable-plugins` thành một ranh giới tin cậy; chốt Q-020 và Q-027; thêm Q-028 về việc Reviewer có thật sự bị từ chối công cụ hay không |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Chốt Q-021, Q-023, Q-024 và quy tắc ngôn ngữ: nội dung dành cho agent viết tiếng Anh; Worker gán nhãn khi tạo bead và truy vấn theo nhãn; Worker **đi tiếp tới khi implement xong**, không giới hạn cứng, vướng thì hỏi; `daemon.mcp.injectIntoAgents` trở thành bước tiêu chuẩn có cảnh báo trong luồng cài. Cập nhật §2.5, §3.4, §9.2 |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | **Bản 2 — viết lại theo PRD có phần điều phối.** Kiến trúc chuyển thành ba lớp (§2.1); thêm §2.2 lý do vẫn cần plugin, §2.5 bộ chỉ dẫn vai trò, §5 hợp đồng RPC, §9.2 luồng giao việc. Bổ sung `roles[]` và hai trường mới vào hồ sơ; §3.4 liệt kê đủ phần ghi vào `config.json`; thêm cờ `--enable-agent-tools`, `--role`, `--reconfigure`; mã 4 mở rộng cho ranh giới quyền công cụ; thêm ranh giới tin cậy thứ ba ở §7; thêm tầng test hợp nhất cấu hình, test chỉ dẫn vai trò và bộ nghiệm thu 5 yêu cầu mẫu; gỡ `--prune` khỏi `doctor` theo phát hiện của lượt polish. Liên kết ADR-005 và ADR-006 |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | **Errata theo quyết định của owner khi implement.** §4.3 thêm mã thoát 7 (đã chép file nhưng Paseo không cài/nạp được plugin — trước đây không có dòng nào đúng nghĩa, mã 3 sai vì đã ghi). §4.4 thêm năm mã lỗi: ba mã cho chốt đường dẫn (`E_UNSAFE_INSTALL_HOME`, `E_PATH_ESCAPE`, `E_SYMLINK_IN_PATH`), `E_TARGET_NOT_WRITABLE` (preflight trước đây mượn `E_CONFLICT`, sai hướng khắc phục) và `E_PLUGIN_LOAD_FAILED`; thêm `result.error { code, message }` chỉ có mặt khi thất bại. `--prune` luôn giữ backup cấu hình Paseo mới nhất làm bản sao an toàn gần nhất để khôi phục thủ công (lệnh gỡ không khôi phục nguyên file cấu hình — ADR-006 quyết định 8; `--restore-backups` chỉ khôi phục file payload) |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | **Errata khi implement (tiếp).** §4.2: CLI `skills` 1.5.26 gọi agent Claude là `claude-code` và từ chối `claude`; owner chốt giữ mặc định `claude,codex` phía paseo-bm và đổi `claude` → `claude-code` khi dựng lệnh `skills`. §9.1: bỏ bước hỏi quyền công cụ riêng (đã gộp theo ADR-006 quyết định 4) và ghi rõ câu hỏi vai trò chạy trước bản xem trước |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | **Errata bm-dnc theo quyết định owner.** §5: `roles.describe` đọc cấu hình Paseo đang có hiệu lực (`agents.providers.bm-*`, `daemon.agentProfiles[bm-*]`) qua SDK thay vì `install.json`; `instructionsPath` là tên chỉ dẫn nhúng. Lý do: Paseo 0.8 biên dịch `index.server.ts` thành bundle CJS bằng esbuild và fork tiến trình con không đặt cwd, nên mã server không biết thư mục payload (`import.meta.url` rỗng → plugin không nạp được với lỗi `Invalid URL`). Nội dung `roles/manager.md` được nhúng vào bundle lúc build (`plugin/server/manager-instructions.ts` sinh bởi `scripts/generate-role-instructions.mjs`); file md vẫn nằm trong payload |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | **Errata bm-tm2 theo quyết định owner (ghi trạng thái trước và khôi phục đúng).** §3.2 thêm hai trường tuỳ chọn `paseo.pluginsEnabledPrevious` và `paseo.createdConfigContainers` (`schemaVersion` vẫn 1, hồ sơ cũ vẫn đọc được và gỡ như trước). Lý do: nghiệm thu Phase 1a thấy sau khi gỡ `config.json` có `pluginsEnabled: false` và `agents.providers: {}` dù trước khi cài không có hai khoá đó, trái M-5 |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | **Errata bm-vey (cập nhật phiên bản).** §9.1: Paseo 0.8 từ chối `plugin install` khi id `paseo-bm` đã cấu hình và không có lệnh đổi đường dẫn plugin dạng thư mục, nên khi plugin đang trỏ thư mục khác thì cập nhật = `plugin remove` rồi `plugin install <dir mới>`; trỏ đúng rồi thì không gọi Paseo. Đăng ký bản mới lỗi → cài lại thư mục cũ (remove trước vì Paseo giữ mục lỗi), hồ sơ giữ `paseo.pluginDir`/`versions[].active` và ghi trả `version` cũ, lỗi `E_PLUGIN_LOAD_FAILED` (mã 7) kèm nguyên văn lý do Paseo và kết quả đường lùi. Lý do: nghiệm thu Phase 1a lượt 5 cập nhật 0.1.0-alpha.0 → 0.1.0-alpha.1 thoát mã 7 |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | **Errata bm-p48.** §4.4: thêm check `plugin-path` của `doctor` và mở rộng `install-version` để phát hiện plugin chạy từ thư mục khác phiên bản active hoặc hồ sơ ghi phiên bản khác bản active |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | **Errata bm-hld.** §2.5/§2.6: chỉ dẫn vai trò được nạp làm system prompt qua hook `before("agent.create")` của plugin theo provider `bm-*` (Worker ← `roles/worker.md`, Reviewer ← `roles/reviewer.md`, Manager ← `roles/manager.md` nếu chưa có), thay cho câu cũ "nạp qua nội dung prompt khởi tạo do plugin dựng". Lý do: nghiệm thu F-1 thấy Worker do Manager tạo bằng `create_agent` không có system prompt, vì công cụ này không có tham số đó; `worker.md` và `reviewer.md` giờ được nhúng vào bundle như `manager.md` |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | **Errata bm-i52.** §9.1: khi install ghi đè file payload của thư mục plugin đang được Paseo dùng (thư mục đăng ký không đổi), gọi `paseo plugin reload paseo-bm` và chờ `running`; lỗi → `E_PLUGIN_LOAD_FAILED` (mã 7). Lý do: nghiệm thu điều phối cài lại 0.1.0-alpha.0 cập nhật 7 file nhưng plugin vẫn chạy bundle cũ tới khi reload bằng tay |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | **Errata bm-msy theo quyết định owner.** §2.6: Worker và Reviewer được tạo ở mode không hỏi quyền của provider (mode của profile nếu có; không thì Claude `bypassPermissions`, Codex `full-access`, OpenCode tương đương, qua `inspect_provider`), thay quy tắc bm-cvr chọn mode `safe`/`moderate` và cấm `dangerous`. Rủi ro ghi nhận: cổng tác dụng phụ của Worker và quy tắc chỉ đọc của Reviewer chỉ còn là ràng buộc hành vi, không có lời hỏi quyền làm lớp thứ hai; câu phê duyệt trong Paseo ở §7 không còn áp cho hai vai trò này. Manager không đổi. Mọi bead Worker tạo có mục `## Provenance` (`requestId` và yêu cầu gốc). Lý do: nghiệm thu điều phối F-3/F-4/F-5 có 20–42 lời hỏi quyền; F-2 để lại bead thiếu Provenance (M-11) |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | **Errata bm-msy sau khi owner duyệt `prd-delta-20260915-subagent-modes`.** §2.6: Reviewer **không** dùng mode không hỏi quyền mà dùng mode tự động không mở toàn quyền hay mạng (Codex `auto`, Claude `auto`), không bao giờ `dangerous`; Worker giữ mode không hỏi quyền. §7: câu "Vượt ranh giới thì để người dùng phê duyệt trong Paseo" chỉ còn áp cho Manager |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | **Errata bm-wq6 theo quyết định owner (A + B + E).** §2.6 D: Stop của Paseo chỉ ngắt lượt của Worker và Paseo 0.8 không cho plugin huỷ agent (`PaseoAgentHandle` không có `cancel`, `cancelAgent` chỉ ở `DaemonClient` nội bộ). (A) plugin bắt `agent.turn_ended` với `canceled` của `bm-worker`, đọc lại trạng thái, Worker không `running` thì gửi thông báo dừng cố định tới Reviewer con đang chạy; (B) `worker.md` coi lượt ngay sau lượt bị ngắt là dừng, `cancel_agent` Reviewer đang chạy rồi báo `finished`, `reviewer.md` trả `BM-REVIEW STOPPED`; (E) ghi nhận giới hạn và soạn đề nghị gửi Paseo. Rủi ro: Reviewer chạy thêm một lượt ngắn, Worker bị đánh thức một lần, phụ thuộc agent làm theo chỉ dẫn; REQ-026f đạt về hành vi, chưa phải huỷ cứng. Lý do: nghiệm thu điều phối lượt 4, F-8a |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | **Errata `design-delta-20260917b-simplify-roles`.** §2.6: ba file vai trò viết lại theo bố cục giới hạn-theo-loại (Worker 5, Reviewer 4, Manager 5), luồng làm việc thành mục cấp một của `worker.md`, chi tiết công cụ và văn phong chuyển sang thể khẳng định ở đúng bước. Không quyết định nào đổi; `BM-REPORT`, `BM-REVIEW`, tên nhãn, ngân sách 1/4/6 giữ nguyên từng ký tự. Lý do: owner thấy hai file Worker/Reviewer "cấm đoán rất nhiều" và cấm vụn theo từng ca |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | **Errata `design-delta-20260917c-context-engineering`.** §2.6: ba file vai trò theo ba tầng (thường trú / theo lần gọi / ép bằng mã); §F ngân sách review do plugin đếm và Manager hỏi người dùng khi vượt; hook `before("agent.create")` chọn và hạ mode của Worker/Reviewer, Manager nhận mode Worker cụ thể qua `## Runtime facts`. Lý do: owner yêu cầu chỉ dẫn giúp agent làm giỏi thay vì một khung kiểm soát dày; review b1 phát hiện daemon chọn mode trước hook (K10) |
