# Delta-change — Tool có schema thay cho khối `BM-*` viết tay

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260924b-agent-tools` |
| Tài liệu gốc | [Technical Design](./paseo-bm.md); các delta đang sống mà delta này chạm tới: [20260918g-agent-conventions](./paseo-bm-delta-20260918g-agent-conventions.md) §4.7–§4.8 (`BM-FORMAT`, kiểm mẫu), [20260918c-question-cards](./paseo-bm-delta-20260918c-question-cards.md) (`BM-QUESTIONS`), [20260924-qa-ledger](./paseo-bm-delta-20260924-qa-ledger.md) (`BM-ANSWERS`). **Không sửa tại chỗ** |
| Status | **Active** |
| Owner | hieu.nt10 |
| Created | 2026-09-24 |
| Nguồn | Chủ repo, 2026-09-24: "Tôi đang muốn làm theo hướng 1 … kiểm tra xem Paseo có hỗ trợ không và thực hiện việc đó"; "Tôi muốn phát triển bền vững khi user cài plugin là có, thay vì ad hoc" |

## Routing Decision

- **Variant preset:** brownfield.
- **Triggered risks:**
  - đổi hợp đồng giữa các vai trò (cách Worker, Reviewer, Manager tạo khối `BM-*`);
  - một thành phần chạy mới trong payload (MCP endpoint do plugin phục vụ, §3);
  - một hợp đồng đang được tiêu thụ công khai: văn bản khối `BM-REPORT` được Dashboard, thẻ chat, trace và qa-ledger đọc ([Dashboard PRD](../product/paseo-bm-dashboard-prd.md) §"Hợp đồng đang tiêu thụ trở thành công khai").
- **Artifacts và cổng:** [PRD delta REQ-068](../product/paseo-bm-prd-delta-20260924b-agent-tools.md), [ADR-010](../adr/ADR-010-plugin-hosted-agent-tools.md), delta này + `design-ready`, bead viết tay theo §6 (bốn gói, một chuỗi thẳng — tiền lệ của delta worker-autonomy), `feature-done`.
- **Execution path:** bead viết tay theo §6. Kiểm chứng trên daemon thật nằm trong AT-3, trước khi đổi role file, vì tài liệu Paseo không nói plugin tự làm MCP endpoint được (§2).
- **Exceptions:** chưa có.
- **Decided:** 2026-09-24 — hieu.nt10: Q1 (a), Q2 (a), Q3 (a).

## 1. Vấn đề

Agent viết khối `BM-*` bằng tay; plugin đoán lại cấu trúc bằng regex. Hai bản mô tả mẫu — chỉ dẫn trong `roles/*.md` và bộ kiểm `shared/bm-format.ts` — được viết riêng, và lệch nhau. Trace 2026-09-22..24:

- 13/17 `BM-FORMAT` gửi Reviewer là báo nhầm: bộ kiểm đọc từng mảnh stream (đã sửa, bead `bm-u6di`).
- 9/87 `BM-REPORT` bị bắt lỗi, tất cả vì hai trường mà chỉ dẫn **cho phép** ghi chú, còn bộ kiểm thì không (đã sửa, bead `bm-29uj`).
- Mỗi `BM-FORMAT` tốn thêm một lượt agent; một khối `blocked` sai mẫu còn kéo theo hỏi lại người dùng.

Sửa từng lệch thì lệch khác sẽ tới. Gốc là **hai nguồn** cho một mẫu.

## 2. Paseo hỗ trợ tới đâu

| Điều | Trạng thái | Nguồn |
|---|---|---|
| `before("agent.create")` gắn được `config.mcpServers` (`stdio`, `http`, `sse`) | **Có**, tài liệu có ví dụ | [reference v0.8 § Before hooks](https://paseo.sh/docs/plugins/v0.8/reference.md); `AgentSessionConfig.mcpServers` trong `@getpaseo/protocol` |
| `config.toolPolicy.preapproved` duyệt sẵn một tool MCP, agent không bị hỏi quyền | **Có** trong type | `ToolPolicy { preapproved: McpToolRef[] }` |
| Claude nhận MCP `http` do Paseo cấu hình | **Có**: chính tool Paseo tới Claude qua `--mcp-config {"mcpServers":{"paseo":{"type":"http",…}}}` | tiến trình Claude đang chạy trên daemon của chủ repo, 2026-09-24 |
| Agent đã tồn tại nhận tool | **Không**: `agent.session_open` chỉ đổi được `env` | reference v0.8 |
| Tiến trình server của plugin tự phục vụ một MCP endpoint | **Có** — kiểm chứng AT-3 | endpoint nghe ở `127.0.0.1:57829`, port ghi vào `~/.paseo-bm/ui/agent-tools.json` sau `install --apply` (2026-09-24T11:16Z) |
| Agent Claude tạo sau khi cài gọi được tool, không bị hỏi quyền | **Có** — kiểm chứng AT-3 | Worker `263ba812` gọi `mcp__paseo-bm__bm_report`, Reviewer `d48da711` gọi `mcp__paseo-bm__bm_review` (cả hai chạy Claude); log plugin `agent tool … called`; khối trả về đúng mẫu. Claude giấu tool sau ToolSearch → bật `alwaysLoad` |
| Codex nói chuyện được với endpoint | **Có** — client MCP của Codex CLI 0.147 gọi `bm_review` qua `mcp_servers.paseo-bm.url`, khối đúng mẫu, log plugin `bm_review built a block` (2026-09-24T13:03Z) | `codex exec -c mcp_servers.paseo-bm.url=… -c …approval…` |
| Paseo chuyển `mcpServers` và duyệt sẵn tool cho Codex | **Có trong mã Paseo**: `applyCodexToolPolicy` đặt `enabled_tools` và `tools.<tool>.approval_mode = "approve"`; tài liệu v0.8 có ví dụ gắn MCP `http` cho `codex`. Kiểm trên daemon thật 2026-09-24T14:0xZ qua alias fallback: Reviewer Codex gọi `paseo-bm.bm_review`, không bị hỏi duyệt ([hồ sơ](../operations/paseo-bm-agent-tools-scale-run-20260924.md) §5) | bundle Paseo 0.8 |
| Provider nào nhận `toolPolicy` | **Chỉ claude, codex, opencode.** Provider khác: Paseo **từ chối tạo agent**. Hook chỉ gắn tool khi provider gốc của alias thuộc ba cái đó (đọc `config.providers[alias].extends`), kiểm trên daemon thật 2026-09-24T13:07Z | `applyProviderConfiguration`, `PROVIDER_CONTRACTS` |

Hai dòng chưa kiểm chứng là gói đầu của plan (§6, AT-1): làm ngay trong paseo-bm, cài như mọi bản khác — không có plugin thử nghiệm riêng.

## 3. Thiết kế đề xuất

### 3.1 Tool

Ba tool trong `shared/bm-tools.ts`. Mỗi tool có **một JSON Schema** — thứ model thấy, và cũng là bộ kiểm hình dạng đầu vào — còn ngữ nghĩa của mẫu do `checkBlocks` kiểm trên chính văn bản dựng ra. Không dùng Zod: lúc chạy, Zod là bản của host, không phải của ta (lệch so với bản nháp, ghi ở AT-1):

| Tool | Ai dùng | Đầu vào (tóm tắt) | Thay cho |
|---|---|---|---|
| `bm_report` | Worker | `requestId`, `phase`, `tier` {`level`, `changed`, `note?`}, các danh sách bead, `filesChanged`, `reviewFindingsOpen`, `buildAndTests`, `skillsUsed`, `decided[]`, `blockers`, `questions[]` (bắt buộc khi `phase = blocked`) | `BM-REPORT` + `BM-QUESTIONS` |
| `bm_review` | Reviewer | `requestId`, `batchId`, `reviewKind`, `verdict`, `checked`, `findings[]` {`severity`, `location`, `reason`, `suggestedFix`}, `notChecked` | `BM-REVIEW` |
| `bm_answers` | Manager | `requestId`, `answers[]` {`id`, `pick` hoặc `other`} | `BM-ANSWERS` |

Tool trả lỗi của schema **ngay trong lượt** (MCP `isError`), mỗi trường một dòng, để agent sửa và gọi lại — không cần `BM-FORMAT`, không tốn thêm lượt.

### 3.2 Tool làm gì khi đầu vào đúng — quyết định Q1

- **(a) Chỉ dựng văn bản (đề xuất).** Tool trả về khối `BM-*` dựng từ schema; agent gửi nguyên văn bằng `send_agent_prompt` như hôm nay.
  - Mọi bên đang đọc văn bản — thẻ chat, Dashboard, trace, qa-ledger, bộ kiểm — không đổi. Hợp đồng công khai của Dashboard giữ nguyên.
  - Tool không có tác dụng phụ, nên không cần biết agent nào gọi và endpoint không cần xác thực.
  - Agent cũ (tạo trước bản này) vẫn viết tay; bộ kiểm còn đó làm lưới an toàn.
- **(b) Tool tự gửi.** Tool kiểm rồi tự chuyển khối tới Manager hoặc Worker. Bớt một bước của agent, nhưng phải: biết agent nào gọi (token theo agent), giữ luật "không gửi vào lượt đang chạy", và đổi cách thẻ chat nhận biết người gửi. Rủi ro cao hơn nhiều; có thể làm sau (a).

### 3.3 Tool chạy ở đâu — quyết định Q2

- **(a) HTTP trong tiến trình server của plugin (đề xuất).** `index.server.ts` mở `127.0.0.1:<port>`; `before("agent.create")` gắn `{ type: "http", url }` cho agent `bm-*` và duyệt sẵn ba tool. Cùng cơ chế Paseo dùng cho tool của chính nó; dùng chung code và Zod với plugin; không cần đường dẫn tới `node`.
  - Port được chọn một lần và lưu ở `~/.paseo-bm/ui/agent-tools.json` (install home mặc định; endpoint khởi động trước khi có `paseo` để tra install home thật, và không bao giờ tạo install home). Agent đang sống không mất tool khi plugin nạp lại. Không giữ được port cũ thì chọn port mới; agent cũ quay về viết tay.
  - Endpoint từ chối `Origin` (trình duyệt), `Host` lạ, body quá 1 MB; mỗi vai trò một đường `/mcp/<role>` nên agent chỉ thấy tool của mình.
- **(b) Script `stdio` trong payload.** Mỗi agent tự chạy một tiến trình. Không phụ thuộc port, nhưng cần một file JS đóng gói sẵn và một đường dẫn `node` chạy được trên máy người dùng — Paseo Desktop không bảo đảm có `node` trên `PATH`.

### 3.4 Chỉ dẫn vai trò

`worker.md`, `reviewer.md`, `manager.md`: "gọi `bm_report` / `bm_review` / `bm_answers`, rồi gửi nguyên văn kết quả". Chia việc giữa hai nơi:

- **Schema của tool** giữ cú pháp và nghĩa của từng trường: bead id đầy đủ, một dòng mỗi trường, `none` khi rỗng, ghi chú sau `tier`, `b<n>:` của `reviewFindingsOpen`, chữ cái và `(recommended)` của lựa chọn, thụt dòng của `checked`, verdict suy từ finding. Role file **không** nhắc lại những điều này nữa, nên chúng không còn lệch được (lỗi L2 của 2026-09-23 chính là hai bản mô tả lệch nhau).
- **Role file** giữ quy trình: khi nào báo cáo, gửi cho ai, hỏi thế nào, câu hỏi tốt ra sao, cái gì là `decided`, cái gì là gợi ý.
- `bm_report` có trường `suggestions` riêng: Worker liệt kê gợi ý chưa làm, tool viết chúng vào `blockers` dưới dạng `Suggestion (not done): …` như trước, nên Manager, thẻ và trace không đổi.
- Mẫu viết tay còn lại làm dự phòng, cùng vài dòng cú pháp tối thiểu để viết đúng ngay lần đầu; phần còn lại do `BM-FORMAT` chỉ ra. `BM-FORMAT` thêm một dòng "If you have the `bm_…` tool, build the block with it."

Kết quả: `worker.md` 377 → 374 dòng, `reviewer.md` 171 → 167.

### 3.5 Đường chữ cũ — quyết định Q3

- **(a) Giữ vĩnh viễn làm đường dự phòng (đề xuất).** Bộ kiểm và `BM-FORMAT` giữ nguyên cho khối viết tay. Tool hỏng hay provider không nạp MCP thì hệ thống vẫn chạy.
- **(b) Bỏ sau khi mọi agent đang sống đã được tạo bằng bản mới.** Gọn hơn, nhưng một provider không hỗ trợ MCP sẽ không báo cáo được.

### 3.6 Sau review độc lập (2026-09-24)

Review tìm ra 1 lỗi chặn và 7 nhóm nên sửa, đều có bằng chứng chạy thật; tất cả đã sửa:

| # | Lỗi | Sửa |
|---|---|---|
| 1 (chặn) | `worker.md` nói trường `suggestions`, tool chưa có | thêm `suggestions`; tool viết `none. Suggestion (not done): …` |
| 2 | báo cáo xong kèm gợi ý hiện "waiting on" trên thẻ | `blockers` luôn mở bằng `none` khi không có gì chờ |
| 3 | giá trị trông như placeholder (`<…>`, `a \| b`) làm `checkBlocks` bỏ qua cả khối, tool vẫn trả "ok" | tool đòi đúng các khối nó đã dựng, nếu không thì báo lỗi |
| 4 | câu hỏi: hơn 8 lựa chọn, chữ "(recommended)" trong lựa chọn, id `Q007`/`Q0` | `maxItems: 8`, từ chối dấu đó, id `^Q[1-9]\d{0,2}$` |
| 5 | `;` hay ngoặc lẻ trong một mục của danh sách `;` | thay `;` bằng `,`, bỏ ngoặc lẻ |
| 6 | code fence hay `>` trong `checked` phá khối | `prose()` bỏ fence và dấu trích; `maxLength` 4000 |
| 7 | `null` cho trường bỏ trống bị từ chối | bỏ trường `null` trước khi kiểm |
| 8 | giao thức: phiên bản lạ nhận bản cũ; 413 thành reset; `close()` trước khi nghe; batch rỗng; `Host` viết hoa; `__proto__` | sửa từng cái, có test |

Rút gọn: một hàm chạy chung cho ba tool (bỏ `checked()`, bỏ việc truyền schema hai lần), bỏ `ROLES`, `applyAgentTools(request, tools)` hai tham số, log gộp vào một vòng và chỉ ghi khi dựng được khối. Lỗi có sẵn từ trước mà review thấy — `parseReviews` đếm `severity: blocking` ở bất kỳ đâu trong tin nhắn — cũng đã sửa: chỉ đếm dòng finding sau chính khối đó. Bộ đọc khối có hai bản giống hệt (`server/` và `shared/`); nay `server/bm-report.ts` chỉ re-export bản `shared/`.

### 3.7 Mốc đo cho AT-5

`npm run measure` nay đếm thông báo `BM-FORMAT` (tổng, và mỗi request theo mức). Mốc **trước** — trace 2026-09-22T00:00Z tới lúc cài tool 2026-09-24T11:16Z:

| Workspace | `BM-FORMAT` | Request | Small / Medium / Large, mỗi request |
|---|---|---|---|
| project-b | 25 | 17 | 0,4 / 1 / 1,2 |
| paseo-bm | 6 | 8 | 1 / 0 / 0,5 |

Lệnh đo lại, cho request tạo sau khi cài: `npm run measure -- ~/.paseo-bm/traces/<workspace> --since 2026-09-24T13:07:00Z`.

Số **sau**: 0 `BM-FORMAT` trên 8 request của lần chạy thử diện rộng ([hồ sơ](../operations/paseo-bm-agent-tools-scale-run-20260924.md)). Đó là repo nhỏ và yêu cầu nhỏ, nên chưa so thẳng được với mốc trên hai project thật; chạy lại lệnh trên các project thật sau vài ngày dùng.

## 4. Quyết định của chủ repo (2026-09-24)

| # | Câu hỏi | Chọn |
|---|---|---|
| Q1 | Tool chỉ dựng văn bản, hay tự gửi? | **(a) chỉ dựng văn bản** |
| Q2 | HTTP trong plugin, hay script `stdio`? | **(a) HTTP trong plugin** |
| Q3 | Giữ đường viết tay làm dự phòng? | **(a) giữ vĩnh viễn** |

## 5. Tương thích và hoàn tác

- Văn bản khối không đổi, nên dữ liệu cũ, thẻ và Dashboard không cần chuyển đổi.
- Hoàn tác: bỏ phần gắn MCP trong `before("agent.create")`; agent mới quay về viết tay. Không có dữ liệu lưu mới ngoài số port.

## 6. Kế hoạch

| Gói | Việc | Chứng minh |
|---|---|---|
| AT-1 | Schema Zod + dựng văn bản cho ba tool (`shared/bm-tools.ts`) | test: văn bản dựng ra qua `checkBlocks` không có lỗi; đầu vào sai trả lỗi từng trường |
| AT-2 | Endpoint MCP HTTP (`server/agent-tools.ts`, port lưu trong install home) + gắn vào agent `bm-*` trong `before("agent.create")` | test: `initialize`, `tools/list` theo vai trò, `tools/call`; hook gắn đúng server và `preapproved` |
| AT-3 | Cài lên daemon; một agent Claude và một agent Codex gọi tool | log plugin có `tools/call` từ cả hai; không bị hỏi quyền. Không đạt thì dừng, ghi lại, hỏi chủ repo |
| AT-4 | Ba role file dùng tool, mẫu viết tay còn một câu dự phòng; test ghim câu chữ; `GUIDE.md` | test + một request thật |
| AT-5 | Đo lại bằng `npm run measure` sau vài request | số đo |

## Revision History

| Ngày | Thay đổi | Người |
|---|---|---|
| 2026-09-24 | Tạo, Draft | hieu.nt10 (Claude Code thực hiện) |
| 2026-09-24 | Chủ repo chọn Q1 a, Q2 a, Q3 a → Active; ADR-010, REQ-068; §6 tách thành năm gói | hieu.nt10 (Claude Code thực hiện) |
| 2026-09-24 | AT-1, AT-2 xong; AT-3: Claude đạt, Codex chưa kiểm được (§2); JSON Schema thay Zod; `alwaysLoad` | hieu.nt10 (Claude Code thực hiện) |
| 2026-09-24 | AT-3 đóng: Codex là ngoại lệ (chủ repo chọn bỏ qua lúc này), không phải đạt. AT-4 xong: role file dùng tool; request thật `req-20260924T114000Z`, Worker `4d9f8e8a` tự gọi `bm_report`, khối đúng mẫu; port giữ nguyên qua reload. AT-5 chờ request thật | hieu.nt10 (Claude Code thực hiện) |
| 2026-09-24 | Review độc lập + rút gọn (§3.6); chia việc schema/role file (§3.4), `suggestions`, dòng tool trong `BM-FORMAT` | hieu.nt10 (Claude Code thực hiện) |
| 2026-09-24 | Xử lý trọn: chỉ gắn tool cho provider duyệt được (Paseo từ chối tạo agent nếu không); Codex kiểm với endpoint; `parseReviews` chỉ đếm finding của chính khối; bộ đọc khối server dùng lại bản `shared/`; `aliasBases` một bản; lỗi placeholder nêu tên trường | hieu.nt10 (Claude Code thực hiện) |
| 2026-09-24 | Chạy thử diện rộng ([hồ sơ](../operations/paseo-bm-agent-tools-scale-run-20260924.md)): tải endpoint, 4 Manager song song, 2 vòng; sửa lỗi `none` trong JSON và lỗi không chỉ đúng trường; AT-5 có số "sau" | hieu.nt10 (Claude Code thực hiện) |
| 2026-09-24 | Ma trận tình huống S1–S7 (Codex, Pi, OpenCode, reload, trả lời trên thẻ, Large, `other`) và test sinh theo seed; sửa năm trường hợp biên của `bm_report` | hieu.nt10 (Claude Code thực hiện) |
