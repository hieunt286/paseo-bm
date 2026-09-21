# Delta-change — Manager mặc định Bypass, số đo model của từng agent, và kiểm tra cách nạp chỉ dẫn theo model

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260918-manager-mode-model-metrics` |
| Tài liệu gốc | [Technical Design](./paseo-bm.md) §2.6, §5 (`manager.ensure`), §7; [Technical Design Dashboard](./paseo-bm-dashboard.md) §3.3, §4.2, §4.3, §9 |
| PRD | [prd-delta-20260918-manager-mode-model-metrics](../product/paseo-bm-prd-delta-20260918-manager-mode-model-metrics.md) (Applied với ngoại lệ) — REQ-026c, NFR Quyền, REQ-058 mới; quyết định owner Q31–Q35 và Routing Decision ở §0 của tài liệu đó |
| Plan | [plan-delta-20260918-manager-mode-model-metrics](../plans/paseo-bm-implementation-plan-delta-20260918-manager-mode-model-metrics.md) |
| Status | **Applied** — 2026-09-18. `design-ready` PASS (review b1); implement WP-243 → WP-248 xong, review b3 pass sau một lần sửa; nghiệm thu trên daemon thật xong với **một điểm chưa quan sát** (Manager mới mở ở Bypass — owner chấp nhận, có unit test). Chỗ lệch so với bản Active ở §10 |
| Owner | hieu.nt10 |
| ADR | [ADR-006](../adr/ADR-006-role-registration.md) (installer không ghi `modeId` — giữ nguyên); [ADR-007](../adr/ADR-007-dashboard-trace-store.md) (kho vết — chỉ thêm trường tuỳ chọn) |
| Request | `req-20260918T011706Z` |

**Thiết kế này sở hữu:** cách `manager.ensure` chọn và đặt mode của Manager; trường `runtime` của bản ghi trace; ba trường RPC cộng thêm của Dashboard và cách hiện chúng; phương pháp của báo cáo §4.5. **Không sở hữu:** mode của Worker và Reviewer (delta 20260917c §4.6), nội dung ba file vai trò, bảng giá (`shared/prices.ts`), và cơ chế đổi mode bên trong Paseo.

## 1. Ba kết quả

1. **Manager chạy không hỏi quyền.** Manager mới tạo ở mode không hỏi quyền của provider; Manager đang có được chuyển sang mode đó một lần khi màn hình Manager mở lại nó (Q31).
2. **Biết agent nào đã chạy bằng gì.** Mỗi lượt ghi thêm model, mức thinking và mode thật; Dashboard hiện chúng trên từng agent, theo model trong mỗi request, và theo model × vai trò ở phần tổng quan (Q32, REQ-058).
3. **Một báo cáo** trả lời: với mỗi model đang dùng, cách paseo-bm nạp và viết chỉ dẫn có cần tối ưu không (Q33–Q35). Không sửa file vai trò.

## 2. Nền tảng — đã kiểm chứng những gì

Đọc trực tiếp trên Paseo 0.8 đã cài (`/Applications/Paseo.app`, gói `@getpaseo/*` trong `node_modules`) và trên daemon của owner bằng lệnh chỉ đọc, ngày 2026-09-18.

| # | Câu hỏi | Kết quả | Hệ quả |
|---|---|---|---|
| N1 | Manager mới đang chạy mode nào? | Profile `bm-manager` có `provider` và `model`, **không** có `modeId` (`list_profiles`). `manager.ensure` chỉ truyền `modeId` khi profile có. `providers.listModes("bm-manager")` trên Claude: `plan`[planning], `default`[safe] "Always Ask", `acceptEdits`[moderate], `auto`[moderate], `bypassPermissions`[dangerous] "Bypass" | Manager mới luôn rơi vào `default` và hỏi quyền. Chọn mode theo `colorTier` như đã làm cho Worker |
| N2 | Plugin đổi được mode của một agent **đã tồn tại** không? | **Không qua SDK.** `PaseoAgentHandle` (`@getpaseo/client`) chỉ có `send`, `run`, `refresh`, `archive`, `respondToPermission`, … — không có hàm đặt mode. `DaemonClient.setAgentMode` có, nhưng plugin chỉ nhận `PaseoApi`. Hook `before("agent.session_open")` chỉ sửa được `env` | Đường duy nhất là **CLI**: `paseo agent mode <id> <mode> [--json]` ("Change an agent's operational mode") |
| N3 | Plugin gắn được nhãn cho agent đã tồn tại không? | Không qua SDK. CLI có `paseo agent update <id> --label <k=v>`. Lúc **tạo**, `agents.create({ labels })` nhận nhãn | Nhãn đánh dấu "đã chuyển mode" đặt được lúc tạo bằng SDK, và cho Manager cũ bằng CLI |
| N4 | Plugin server đã từng chạy chương trình ngoài chưa? | Có: `plugin/server/setup-tools.ts` dùng `execFile` (không qua shell, có timeout) và `findTool` dò PATH của daemon cộng `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`. Trên máy owner `paseo` = `/opt/homebrew/bin/paseo` → `/Applications/Paseo.app/Contents/Resources/bin/paseo`. `paseo agent mode <id> --list --json` từ shell thường trả mảng `{ id, label, description }`, mã 0 | Dùng lại đúng khuôn đó; không cần cơ chế mới |
| N5 | Danh sách agent có mode hiện tại không? | Có: mỗi `entries[].agent` của `agents.list` mang `currentModeId` và `labels` | `manager.ensure` biết Manager đang có ở mode nào mà không phải gọi thêm |
| N6 | Snapshot agent có gì về model và mode? | `model` (model **đã cấu hình**, có thể null), `thinkingOptionId`, `effectiveThinkingOptionId`, `currentModeId`, và `runtimeInfo { model, thinkingOptionId, modeId, extra.runtimeModel }` là giá trị **đang chạy**. Ví dụ thật (Worker của request này): `model` `claude-opus-5`, `runtimeInfo.model` `claude-opus-5`, `currentModeId` `bypassPermissions`, hai trường thinking `null`. Payload của `timeline.refetch` (bộ thu thập đã gọi mỗi lượt) mang đúng snapshot này | Không cần gọi thêm RPC nào để ghi model, thinking và mode |
| N7 | Kho vết đã ghi model chưa? | Có, `usage.model` lấy từ `snapshot.model`. Bốn workspace gần nhất của owner: Manager và Worker `claude-opus-5`, Reviewer `gpt-5.6-sol`. Bản ghi **không** có mức thinking hay mode | REQ-058 (a)–(e) phần model làm được trên dữ liệu cũ; thinking và mode chỉ có từ bản ghi mới |
| N8 | Thêm trường vào bản ghi có phải di trú không? | `traceRecordSchema` là `z.object` mặc định **bỏ khoá lạ**; `contracts.ts` ghi luật "a new record must only ever *add* optional fields". Bản cũ đọc bản ghi mới thì bỏ qua trường mới và vẫn ghi được | Trường **tuỳ chọn**, giữ `v: 1` và `TRACE_STORE_SCHEMA_VERSION = 1`, không di trú |
| N9 | Chỉ dẫn vai trò tới từng provider bằng đường nào? | Claude: `systemPrompt: { type: "preset", preset: "claude_code", append: <chỉ dẫn + phần daemon nối thêm> }` — **nối sau** system prompt dựng sẵn của Claude Code, và Claude Code còn nạp `CLAUDE.md` qua `settingSources`. Codex: `developerInstructions` khi mở thread (và `developer_instructions` sau chỉ dẫn của collaboration mode khi có). OpenCode: trường `system`. Snapshot lưu nguyên văn prompt đã nạp ở `persistence.metadata.systemPrompt` | Ba đường khác nhau về **vị trí** và **vai trò tin nhắn** — đây là đầu vào của báo cáo §4.5, không phải kết luận |

## 3. Không đổi

- Mode của Worker và Reviewer, và hook `before("agent.create")` cho hai vai đó (`ROLE_GETS_MODE.manager` vẫn `false`: `manager.ensure` là **nơi duy nhất** quyết mode của Manager).
- `manager.md`, `worker.md`, `reviewer.md` và mục `## Runtime facts`. Manager vẫn truyền mode Worker khi tạo Worker (K10 của delta 20260917c vẫn đúng).
- `install.json`, `~/.paseo/config.json`, profile `bm-manager` (installer vẫn không ghi `modeId`, ADR-006).
- Kho vết: bố cục, `schemaVersion`, luật chống trùng, xoá, gán lại.
- Quy tắc giá của REQ-052, ngoại trừ khoá model nói ở §4.3.

## 4. Thiết kế

### 4.1 Mode của Manager

**Mode đích.** Hàm mới `managerModeFor(modes, profileModeId)` trong `plugin/server/role-mode.ts`:

1. `modeId` người dùng tự đặt trên profile `bm-manager`, nếu provider có liệt kê mode đó → dùng nó;
2. không thì mode `dangerous` đầu tiên (Claude `bypassPermissions`, Codex `full-access`);
3. không có mode `dangerous` nào, hoặc không đọc được danh sách mode → **không chọn**, để mode mặc định của provider và log một dòng. Không lùi về `moderate`: yêu cầu là "không hỏi quyền", và một mode tự động của provider khác không phải điều đó.

Plugin không bao giờ **tự** chọn một mode `planning` (bước 2 chỉ nhận `dangerous`). Mode người dùng tự đặt trên profile ở bước 1 thì luôn thắng, **kể cả** khi nó là `planning` — đúng quyết định Q31. Danh sách mode lấy bằng `providers.listModes("bm-manager", { cwd })` qua `withTimeout` sẵn có (5 giây).

**Nhãn đánh dấu.** `bm.modeSet = <modeId>` nghĩa là "paseo-bm đã đặt mode này cho Manager này". Có nhãn thì paseo-bm **không bao giờ** đụng mode của Manager đó nữa: người dùng đổi tay sau đó được tôn trọng.

**Manager mới** (`ensureManager`, nhánh tạo): tính mode đích; có mode thì truyền `config.modeId` **và** nhãn `bm.modeSet`. Không có mode đích thì tạo như hôm nay, không nhãn — lần mở sau sẽ xử lý nó như một Manager cũ.

**Manager đang có** (`ensureManager`, nhánh tìm thấy), theo thứ tự:

1. Có nhãn `bm.modeSet` → không làm gì.
2. Không có mode đích → không làm gì (đã log).
3. Manager đang `running` → **bỏ qua lần này**, trả notice; lần mở sau thử lại. Lý do: đổi mode trên Claude có thể dựng lại query bên dưới (chú thích trong `claude/agent.js`), không nên làm giữa một lượt.
4. `currentModeId` khác mode đích → chạy `paseo agent mode <id> <mode> --json`.
5. Chạy `paseo agent update <id> --label bm.modeSet=<mode> --json` (kể cả khi bước 4 không cần vì mode đã đúng).
6. Bất kỳ bước nào lỗi, hết giờ, hay không tìm thấy `paseo` → **vẫn trả Manager** như hôm nay, kèm notice nói rõ lý do và cách tự đổi trong Paseo. Bước 4 thành công mà bước 5 lỗi thì lần mở sau lặp lại bước 5 (bước 4 khi đó tự bỏ qua vì mode đã đúng).

**Chạy CLI.** Module mới `plugin/server/paseo-cli.ts`: tìm `paseo` bằng `findTool` của `setup-tools.ts`, gọi bằng `execFile` **không qua shell**, timeout 5 giây mỗi lệnh. Id agent lấy từ chính `agents.list` của daemon và phải khớp `^[A-Za-z0-9][A-Za-z0-9_-]*$` (`agentIdSchema` chỉ kiểm độ dài; ký tự đầu không được là `-`, để CLI không đọc id thành cờ); mode phải nằm trong danh sách provider trả về. Cả hai được kiểm **trước khi** vào đối số — không có đường nào để chữ tuỳ ý thành lệnh hay cờ. Không tìm thấy `paseo` → notice "không tìm thấy lệnh `paseo`; hãy đổi mode của Manager trong Paseo".

**Hợp đồng.** `manager.ensure` output thêm `modeNotice: string | null` (trường cộng thêm; client cũ bỏ qua). Màn hình Manager hiện notice đó như các notice hiện có, không chặn việc mở chat.

### 4.2 Ghi model, mức thinking và mode của mỗi lượt

`traceRecordSchema` thêm trường **tuỳ chọn**:

```
runtime?: { model: string | null, thinkingOptionId: string | null, modeId: string | null } | null
```

Bộ thu thập (`timestampsForTurn`, `collector.ts`) điền từ snapshot trong payload `timeline.refetch` nó đã gọi:

Cả ba trường cùng một luật: giá trị **đang chạy** (`runtimeInfo`, N6) trước, trường cấu hình của snapshot chỉ là dự phòng khi provider không báo:

- `model` = `runtimeInfo.model` → không có thì `snapshot.model`;
- `thinkingOptionId` = `runtimeInfo.thinkingOptionId` → không có thì `effectiveThinkingOptionId` → không có thì `thinkingOptionId`;
- `modeId` = `runtimeInfo.modeId` → không có thì `currentModeId`.

"Không có" nghĩa là trường vắng mặt hoặc không phải chuỗi khác rỗng; `null` do provider báo cũng tính là không có, để một giá trị dự phòng thật không bị che bởi `null`. Cả chuỗi đều trống thì trường đó là `null` — với thinking, `null` được hiện là "mặc định của provider".

`refetch` lỗi thì `runtime` là `null`, cùng cách `usage` đang làm. `usage.model` **giữ nguyên** nguồn cũ để bản ghi mới vẫn đọc đúng với bản plugin cũ.

**Model hiệu lực của một bản ghi** = `runtime.model` → không có thì `usage.model`. Mọi phép gộp theo model ở §4.3 dùng khoá này.

### 4.3 Hợp đồng RPC (đều là trường cộng thêm)

| Nơi | Trường mới | Ngữ nghĩa |
|---|---|---|
| `TraceDetail.usageByAgent[]` | `runtime: [{ model: string \| null, thinkingOptionId: string \| null, modeId: string \| null, recorded: boolean, turns }]` | Mỗi tổ hợp khác nhau một dòng, kèm số lượt, theo thứ tự lượt đầu tiên gặp (REQ-058 a, b). Mỗi lượt góp vào đúng một dòng, theo luật dưới bảng |
| `TraceDetail` | `usageByModel: [{ model: string \| null, usage }]` | Token và chi phí theo model hiệu lực (REQ-058 d). `model: null` = lượt không rõ model |
| `TraceSummary` | `usageByModelRole: [{ role, model: string \| null, usage }]` | Cho thẻ tổng quan (REQ-058 e) |

**Một lượt góp vào dòng nào** (REQ-058 c — bản ghi cũ vẫn giữ được model của nó):

| Bản ghi của lượt | `model` | `thinkingOptionId`, `modeId` | `recorded` |
|---|---|---|---|
| có `runtime` | model hiệu lực (`runtime.model` → `usage.model`) | lấy từ `runtime` | `true` |
| không có `runtime` (bản ghi cũ, hoặc `refetch` lỗi) nhưng có `usage.model` | `usage.model` | `null` | `false` |
| không có cả hai | `null` | `null` | `false` |

`recorded: false` nghĩa là thinking và mode **không được ghi** — khác hẳn `recorded: true` với thinking `null` ("mặc định của provider"). Không có trường đếm riêng cho lượt không ghi: số đó là tổng `turns` của các dòng `recorded: false`.

**Giá theo model hiệu lực.** `usageOfTrace` hôm nay gộp theo `usage.model`. Nó chuyển sang model hiệu lực, để tổng tiền, dòng theo model và thẻ tổng quan luôn cùng một phép chia. Hai khoá chỉ khác nhau khi profile để trống model (`snapshot.model` null mà `runtimeInfo.model` có giá trị): khi đó token hôm nay bị ghi "không có giá" nay được định giá đúng model đã chạy. Đây là thay đổi **duy nhất** trong con số chi phí, và nó theo đúng ý REQ-052 ("khớp theo model id của agent").

### 4.4 Giao diện

- **Nút Worker và Reviewer** (`requestGraph` trong `dashboard-model.ts`): mỗi dòng `runtime` một dòng chi tiết. `recorded: true` → `Model: claude-opus-5 · thinking: provider default · mode: bypassPermissions · 12 turns`. `recorded: false` → `Model: claude-opus-5 · thinking/mode: not recorded · 3 turns`, và `Model: not recorded · 1 turn` khi `model` cũng `null`. Phụ đề của nút thêm tên model khi agent chỉ có một model khác `null`.
- **Chi tiết request**: dòng tương tự cho Manager (Manager không có nút riêng), và dòng `Token theo model: claude-opus-5 … · gpt-5.6-sol …`, mỗi phần có tiền theo `formatCost`.
- **Tổng quan**: một khối "Model × vai trò" dùng lại thành phần biểu đồ thanh sẵn có (`ui.tsx`), mỗi thanh một cặp (model, vai trò) với token và tiền; cộng trên đúng danh sách `traces` mà `overviewCards` đang dùng.
- Mọi chữ mới là tiếng Anh như phần còn lại của giao diện; "không ghi nhận" hiện là `not recorded`, "mặc định của provider" là `provider default`.

### 4.5 Báo cáo: cách nạp chỉ dẫn theo model

**Nơi đặt:** `docs/design/paseo-bm-research-20260918-instructions-by-model.md`, tiếng Việt.

**Phải trả lời, cho Claude Code / `claude-opus-5` và Codex / `gpt-5.6-sol`, cộng một đoạn về OpenCode:**

| # | Câu hỏi | Nguồn |
|---|---|---|
| R1 | Chỉ dẫn vai trò nằm **ở đâu** trong ngữ cảnh: vai trò tin nhắn (system / developer), vị trí so với prompt dựng sẵn của công cụ, `CLAUDE.md`/`AGENTS.md` của repo, danh sách skill, mô tả công cụ MCP, phần daemon nối thêm | Bundle Paseo (N9), `persistence.metadata.systemPrompt` của agent thật, tài liệu công khai của Claude Code và Codex |
| R2 | Chỉ dẫn vai trò **chiếm bao nhiêu** so với phần còn lại, và cái gì đứng sau nó | Như R1, đếm ký tự / token ước lượng |
| R3 | Hướng dẫn chính thức của từng họ model nói gì về: nhấn mạnh (CHỮ HOA, **NEVER**), ví dụ mẫu, cấu trúc (bảng, XML, Markdown), độ dài, mâu thuẫn giữa các lớp chỉ dẫn, và đặt chỉ dẫn ở system hay developer | Trang hướng dẫn viết prompt công khai của Anthropic và OpenAI (được phép đọc, Q34); ghi rõ URL và ngày đọc |
| R4 | Trên các trace đã có, từng model **thật sự** làm theo tới đâu: định dạng `BM-REPORT` / `BM-REVIEW` đủ trường, số lần hỏi người dùng, vi phạm giới hạn thấy được trong bằng chứng (lệnh `git`, cài phụ thuộc, dùng mạng), hành vi khi bị dừng | Kho vết (chỉ đọc), các biên bản chạy trong `docs/operations/` |
| R5 | Nét nào của ba file vai trò hiện tại có khả năng tác động **khác nhau** theo model | Đối chiếu R1–R4 với `plugin/roles/*.md` |
| R6 | Kết luận: có cần tối ưu theo model không; nếu có thì **danh sách đề xuất có thứ tự** (tác động, chi phí, rủi ro, cách đo), mỗi đề xuất nêu rõ là một thay đổi một-văn-bản-cho-mọi-model hay biến thể theo provider | Tổng hợp |

**Luật của báo cáo:** mỗi khẳng định ghi nguồn (tệp và dòng, URL và ngày, hay phép đo trên trace); điều suy luận ghi là suy luận; không sửa `plugin/roles/*.md` (Q33). Mọi tệp tạm (bundle giải nén, script đếm) nằm trong một thư mục `mktemp -d` và bị xoá khi xong.

## 5. Rủi ro

| Rủi ro | Chặn bằng |
|---|---|
| Manager không hỏi quyền làm việc thay Worker hay chạy lệnh nguy hiểm | Rủi ro owner chấp nhận ở PRD delta §2.2; giới hạn trong `manager.md` không đổi |
| Ghi đè mode người dùng tự chọn cho Manager cũ | Chỉ chuyển **một lần** mỗi Manager (nhãn `bm.modeSet`, owner chốt Q36); profile có `modeId` thì dùng mode đó |
| Gọi CLI từ trong tiến trình daemon: `paseo` không có trên PATH của daemon, hoặc gọi ngược về daemon bị treo | `findTool` dò cả các thư mục cài đặt thường gặp; timeout 5 giây; lỗi chỉ tạo notice, không bao giờ chặn việc mở Manager. Đường này **chỉ kiểm chứng được trên daemon thật** — nghiệm thu ở WP đóng delta |
| Đổi mode giữa một lượt đang chạy | Manager `running` thì bỏ qua lần này |
| Chèn lệnh hay cờ qua id agent hoặc id mode | `execFile` không shell; id khớp mẫu không mở đầu bằng `-`, mode phải nằm trong danh sách của provider; có test cho id `--help` |
| Bản ghi mới làm bản plugin cũ đọc sai | Trường tuỳ chọn, `v` không đổi; test đọc bản ghi mới bằng lược đồ không có trường đó |
| Con số chi phí đổi | Chỉ đổi ở ca profile để trống model (§4.3); test riêng cho ca đó |
| Báo cáo dựa vào kiến thức cũ về model mới | Đọc tài liệu công khai hiện hành (Q34); điều không tìm được nguồn thì ghi là suy luận |

## 6. Kiểm thử

- **Mode Manager** (`test/rpc-manager-ensure.test.ts`, test `role-mode`): profile không mode → `bypassPermissions` + nhãn; profile có mode → mode đó; không có mode `dangerous` → không truyền mode, không nhãn; `listModes` hết giờ → tạo như cũ, có log. Manager cũ: có nhãn → không gọi CLI; không nhãn + nghỉ + mode khác → gọi `agent mode` rồi `agent update --label`, đúng đối số; mode đã đúng → chỉ gọi `update`; `running` → không gọi, có notice; CLI lỗi → Manager vẫn trả về, có notice. **Đối chứng âm:** bỏ kiểm nhãn thì test "tôn trọng lựa chọn tay" phải đỏ.
- **Bộ thu thập:** snapshot có `runtimeInfo` khác với trường cấu hình → `runtime` lấy giá trị của `runtimeInfo` cho cả ba trường (ca này đỏ nếu thứ tự ưu tiên bị đảo); thiếu `runtimeInfo` → lấy trường dự phòng; `runtimeInfo.modeId: null` mà `currentModeId` có giá trị → lấy `currentModeId`; `refetch` lỗi → `runtime: null`; bản ghi có `runtime` vẫn qua lược đồ cũ (không có trường) và bản ghi cũ qua lược đồ mới.
- **Dựng trace:** hai tổ hợp trong một agent → hai dòng đúng số lượt; lượt cũ có `usage.model` → dòng `recorded: false` **giữ model đó**; lượt không có cả hai → dòng `model: null, recorded: false`; `usageByModel` và `usageByModelRole` cộng đúng; tổng tiền bằng tổng các phần; ca profile trống model được định giá theo `runtime.model`.
- **Giao diện** (`dashboard-model` thuần, không renderer): dòng `Model: …` trên Worker, Reviewer và Manager; `thinking/mode: not recorded` cho dòng `recorded: false`; `provider default` cho thinking `null` của dòng `recorded: true`; khối model × vai trò.
- `npm run verify` mã 0.

## 7. Backward Compatibility

- Mọi trường RPC mới là trường **cộng thêm**; client cũ bỏ qua. Bên tiêu thụ duy nhất của `manager.ensure` và các RPC Dashboard là client của chính plugin, đóng cùng bundle và cùng phiên bản, nên không có bên tiêu thụ ngoài nào phải báo trước.
- Kho vết không di trú; bản cũ và bản mới đọc được bản ghi của nhau.
- Manager đang có chỉ đổi mode một lần, và chỉ khi màn hình Manager mở nó.
- Không đổi `install.json`, `config.json`, profile, ba file vai trò.

## 8. Câu hỏi mở — đã trả lời (vòng hỏi thứ hai, 2026-09-18)

| ID | Câu hỏi | Owner chốt | Owner | Trạng thái |
|---|---|---|---|---|
| O1 (Q36) | Chuyển Manager cũ **một lần** (nhãn `bm.modeSet`) hay **mỗi lần** mở (đè cả mode người dùng đổi tay sau đó) | **Một lần** | hieu.nt10 | answered |
| O2 (Q37) | Manager đang chạy thì bỏ qua lần này, hay vẫn đổi mode ngay | **Bỏ qua lần này**, hiện notice, thử lại ở lần mở sau | hieu.nt10 | answered |
| O3 (Q38) | Chi phí gộp theo model hiệu lực (§4.3), chấp nhận con số đổi ở ca profile trống model | **Chấp nhận** | hieu.nt10 | answered |
| Q39 | Gọi `paseo` từ trong daemon chỉ kiểm được trên daemon thật — làm như thiết kế, hay bỏ phần Manager cũ | **Làm như thiết kế**: lỗi chỉ thành notice, không chặn mở Manager; kiểm ở nghiệm thu | hieu.nt10 | answered |

## 10. Chỗ lệch so với bản Active (ghi khi áp dụng)

| # | Thiết kế nói | Thực tế | Lý do |
|---|---|---|---|
| 1 | §5, §6: đường CLI kiểm trên daemon thật ở nghiệm thu | **Đã kiểm, chạy được** — nghiệm thu trên daemon thật 2026-09-18: hai Manager tạo trước thay đổi được chuyển sang Bypass và gắn nhãn `bm.modeSet` qua lệnh `paseo` gọi từ trong daemon; đổi tay một Manager về "Always Ask" rồi gọi `manager.ensure` thì mode được giữ; mọi lượt sau khi cài ghi model/thinking/mode và `traces.get` trả đủ ba trường mới. Chưa quan sát: một Manager **mới** mở ở Bypass (owner chấp nhận ở câu trả lời Q1 = b; có unit test) | Owner ban đầu chọn bỏ qua ("c"), sau đó yêu cầu làm nốt và chọn để Worker tự kiểm điểm đổi tay (Q1 = b) |
| 2 | §4.1 bước 3 "không có mode `dangerous` → không chọn" | Bản đầu vẫn truyền `modeId` của profile khi provider **không** liệt kê nó — review b3 bắt; đã sửa: biết danh sách mode thì chỉ truyền mode có trong danh sách, và ghi một dòng log | Truyền một mode provider không có làm việc tạo Manager thất bại |
| 3 | §4.1 `listModes("bm-manager", { cwd })` | Gọi không kèm `cwd` | `manager.ensure` chỉ nhận `workspaceId`; lượt tra vẫn được giới hạn 5 giây |
| 4 | §4.3 ba trường RPC mới | `usageByAgent[].runtime`, `usageByModel`, `usageByModelRole` là **tuỳ chọn** trong lược đồ Zod, server luôn gửi; `modeNotice` là bắt buộc (nullable) | Payload của bản cũ và fixture test vẫn hợp lệ |
| 5 | — | `index.server.ts` còn ghi `modeNotice` ra log ở cả hai đường gọi `ensureManager` | Đường "Implement with Manager" của màn Beads không hiện thông báo launcher; log là chỗ duy nhất lỗi mode lộ ra ở đó |
| 6 | §4.5 dự đoán xung đột với file chỉ dẫn của repo | Báo cáo tìm ra xung đột build đến từ **tin nhắn giao việc của Worker**, không phải `AGENTS.md` | Kiểm lại từng tin nhắn giao việc (6/7 lượt build có câu cho phép) |

## 9. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Bản Draft theo `req-20260918T011706Z`, quyết định Q31–Q35 và chín kết quả kiểm chứng N1–N9 |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Owner trả lời vòng hai: Q36 chuyển Manager cũ một lần, Q37 bỏ qua Manager đang chạy, Q38 chi phí theo model hiệu lực, Q39 làm đường CLI như thiết kế. §8 không còn câu hỏi mở |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Sửa theo review b1 (hai mục chặn): §4.2 lấy `runtimeInfo` trước cho **cả ba** trường, trường cấu hình chỉ là dự phòng; §4.3 hợp đồng `runtime` thành danh sách dòng có `recorded`, và luật một lượt góp vào dòng nào, để lượt cũ giữ `usage.model` còn thinking/mode ghi rõ "không được ghi"; §4.4 và §6 theo đó |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Review b1 re-review pass; cổng `design-ready` PASS. Status Draft → Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Errata theo review b2: §4.1 nói rõ "không chọn `planning`" chỉ áp cho lựa chọn tự động; mode tự đặt trên profile luôn thắng, kể cả `planning` (Q31). Không đổi quyết định nào |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | WP-249: thêm §10 (sáu chỗ lệch khi áp dụng); errata vào `paseo-bm.md` §2.6/§7, `paseo-bm-dashboard.md` §3.3/§4.2/§4.3/§9, và ba sự thật vào `AGENTS.md`. Status Active → Applied với ngoại lệ (nghiệm thu trên daemon thật chưa làm, quyết định owner) |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Nghiệm thu trên daemon thật (owner yêu cầu làm nốt, Q1 = b): đường CLI chạy thật, lựa chọn tay được giữ, dữ liệu Dashboard đúng; còn một điểm chưa quan sát (Manager mới). Status → Applied; §10 dòng 1 cập nhật |
