# Delta-change — Plugin bắt buộc quy ước phối hợp giữa các agent

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260918g-agent-conventions` |
| Tài liệu gốc | [Technical Design](../../design/paseo-bm.md) (Active); [delta 20260916-chat-cards](./paseo-bm-delta-20260916-chat-cards.md) §4 (thẻ, `chat.peers`); [delta 20260917c-context-engineering](./paseo-bm-delta-20260917c-context-engineering.md) §4.6 (Runtime facts); [delta 20260918-manager-mode-model-metrics](./paseo-bm-delta-20260918-manager-mode-model-metrics.md) §4.1 (`bm.modeSet`, Paseo CLI) — **không sửa tại chỗ** |
| PRD | [prd-delta-20260918g-agent-conventions](../product/paseo-bm-prd-delta-20260918g-agent-conventions.md) — REQ-061 (a)–(j); quyết định Q1–Q10; Routing Decision ở §0 của tài liệu đó |
| Plan | [plan-delta-20260918g-agent-conventions](../plans/paseo-bm-implementation-plan-delta-20260918g-agent-conventions.md) |
| Status | Merged — gộp vào [paseo-bm.md](../../design/paseo-bm.md) ngày 2026-09-25; chỉ còn là hồ sơ lịch sử |
| Owner | hieu.nt10 |
| ADR | N/A — không thêm công nghệ; dùng lại Paseo CLI (delta 20260918 §4.1) và hook vòng đời đã có |
| Request | `req-20260918T071130Z` |

**Thiết kế này sở hữu:**

- cách plugin quyết vai của một agent (`plugin/server/agent-role.ts`, mới);
- gắn nhãn vai khi agent `bm-*` được tạo;
- bộ kiểm template các khối `BM-*` (`plugin/shared/bm-format.ts`, mới) và thông báo `BM-FORMAT` (`plugin/server/format-check.ts`, mới);
- chip cảnh báo và chip "template error" trên thẻ, và bản dự phòng khi không vẽ thẻ;
- giá trị dự phòng của mode Reviewer trong `## Runtime facts`;
- luật `BM-FORMAT` trong ba file vai.

**Không sở hữu:**

- các mẫu `BM-*` và bộ đọc khoan dung của chúng (`plugin/shared/bm-report.ts`, `bm-questions.ts`) — dùng lại, không đổi;
- cách Manager nói về thẻ (REQ-059 f), bố cục thẻ câu hỏi;
- kho vết, cách đếm review (chỉ thêm một tiền tố thông báo vào `notices.ts`);
- phát hành plugin. Cài và nạp lại một lần theo §4.11 (Q10).

## 1. Bốn kết quả

1. **Agent `bm-*` luôn được nhận đúng vai**, dù có nhãn hay không (Q1 a), và agent mới thiếu nhãn được gắn nhãn (Q1 b).
2. **Khối sai template bị phát hiện, người gửi được báo và phải gửi lại, người dùng thấy chip** (Q2).
3. **Tin không vẽ được thẻ vẫn đọc được** (Q3).
4. **Worker luôn biết mode Reviewer**, và mọi lần tra cứu hỏng đều để lại log (Q4).

## 2. Nền tảng — đã kiểm chứng những gì

| # | Sự thật | Nguồn |
|---|---|---|
| K1 | Manager `f13a4e4e` (workspace `wks_project_b`) có provider `bm-manager`, đủ chỉ dẫn Manager, `labels: {}`, tên = câu đầu người dùng gõ; Manager do `manager.ensure` tạo luôn tên "Beads Manager" và có `bm.role`, `bm.version`, `bm.modeSet` | `get_agent_status`, `list_agents` 2026-09-18; `manager.ts:295-307`; bead `bm-llmg` |
| K2 | `bmAgentsOf` chỉ liệt kê theo nhãn `bm.role`, mỗi vai **một trang 200**, không đọc trang sau | `dashboard-rpc.ts:293-326` |
| K3 | `manager.ensure`, cây agent, `/bm-worker-stop-all`, dừng Reviewer đều lọc theo nhãn `bm.role` | `manager.ts:213-226, 418, 455`; `stop-propagation.ts:140, 163, 302-307` |
| K4 | Kho vết và ngân sách review đã nhận vai theo provider, không theo nhãn | `collector.ts:371-373`; `review-budget.ts:141` |
| K5 | `providerId()` bỏ phần `/<model>` của provider | `provider-id.ts`; dùng ở `role-hook.ts` |
| K6 | Hook `before("agent.create")` chỉ đổi được `{ config, env }`, không đổi nhãn; plugin có sự kiện `on("agent.created", { agent: { id, workspaceId, parentAgentId, provider, cwd, title } })` | `@getpaseo/plugin` `lifecycle.d.ts` |
| K7 | `paseo agent update <id> --label k=v` **thêm hoặc đặt** nhãn (lặp được `--label`), không xoá nhãn khác; plugin đã chạy lệnh này qua `execFile` | `paseo agent update --help` (0.8.0); `paseo-cli.ts:setAgentLabel` |
| K8 | Chạy Paseo CLI từ trong tiến trình daemon **chưa được chứng minh** trên daemon thật | AGENTS.md; bead `bm-wp-249-5qqp.1` (deferred) |
| K9 | Tin một agent gửi agent khác tới người nhận thành `user_message` **không có** `clientMessageId`; tin người dùng gõ và thông báo của plugin (`PaseoAgentHandle.send`) có | AGENTS.md; `collector.ts:412-420`; `notices.ts` |
| K10 | `PaseoAgentHandle.send()` vào agent đang chạy thay lượt của nó; plugin chỉ gửi khi `refresh()` báo không `running` | `review-budget.ts:26-29, 177-187` |
| K11 | Timeline của lượt vừa kết thúc có trong sự kiện `agent.turn_ended` (và `timeline.refetch` theo `turnId`); collector đã đọc `user_message` và `assistant_message` của lượt | `collector.ts:367-432` |
| K12 | Hình dạng thô của tool call `send_agent_prompt` trong timeline **chưa được kiểm chứng** (CLI chỉ in `[Send agent prompt] {json}`) | `paseo agent logs` 2026-09-18 |
| K13 | Bản plugin đang chạy (`~/.paseo-bm/plugin/0.2.0-alpha.0`, nạp 06:28Z) có `runtimeFactsOf` chỉ cho Manager; working tree đã có nhánh Worker → Reviewer mode. Mọi Worker tạo trong ngày thiếu `## Runtime facts` | `diff` hai bản `role-extras.ts`; `persistence.metadata.systemPrompt` của Worker `25039a8d` |
| K14 | `runtimeFactsOf` nuốt mọi lỗi (`catch { return {} }`) không log; `modesFor` log khi hết giờ hay không có mode | `role-extras.ts:105-130`; `role-mode.ts:168-200` |
| K15 | Luật chọn mode Reviewer lấy `auto` đầu tiên khi provider liệt kê nó; Claude và Codex đều liệt kê `auto` | `role-mode.ts:103-111`; AGENTS.md (`providers.listModes`, 2026-09-17) |
| K16 | Thẻ dự phòng vẽ `card.text` thô, không qua `markdownOf` | `chat-card.tsx:132-137` |
| K17 | `reviewCallsOf` bỏ qua tin có `isPluginNotice` | `traces.ts:434-452` |

## 3. Không đổi

- Mẫu và bộ đọc khoan dung của `BM-REPORT`, `BM-REVIEW`, `BM-QUESTIONS`, `BM-ANSWERS`; kho vết (schema, bản ghi).
- Nhãn mà `manager.ensure`, Manager và Worker đang gắn; tên nhãn.
- Cách Manager tạo Worker, Worker tạo Reviewer.
- Mọi hành vi với agent **có** nhãn đúng: kết quả của `chat.peers`, `chat.waiting`, Dashboard, cây agent, dừng agent giữ nguyên, chỉ thêm trường `labelled: true`.

## 4. Thiết kế

### 4.1 Vai của một agent — `plugin/server/agent-role.ts` (mới)

```ts
export type BmRole = "manager" | "worker" | "reviewer";
export interface RoleFact { role: BmRole; labelled: boolean }

/** `bm-manager` → manager, … (chuyển từ role-hook.ts, role-hook import lại). */
export const ROLE_BY_PROVIDER: Readonly<Record<string, BmRole>>;

/** Vai của một snapshot agent, hoặc null khi không phải agent paseo-bm. Không ném. */
export function roleOfAgent(agent: { labels?: unknown; provider?: unknown }): RoleFact | null;

/** Mọi agent, đi hết các trang (`pageInfo.hasMore` / `nextCursor`), không lọc nhãn. */
export async function listAllAgents(list, options: { includeArchived: boolean }): Promise<AgentSnapshot[]>;
```

Luật của `roleOfAgent`, theo thứ tự:

1. Nhãn `bm.role` là một trong ba vai → `{ role, labelled: true }`.
2. Nếu không, `providerId(agent.provider)` có trong `ROLE_BY_PROVIDER` → `{ role, labelled: false }`. Nhãn `bm.role` có giá trị lạ cũng rơi vào luật này.
3. Còn lại → `null`.

`listAllAgents` là hàm đang có trong `manager.ts` (đi hết trang), được chuyển sang đây và export. Trang thiếu `pageInfo` được coi là trang cuối, để fake cũ vẫn chạy.

### 4.2 Nơi dùng — mọi chỗ đang đọc nhãn

| Nơi | Hôm nay | Sau delta |
|---|---|---|
| `bmAgentsOf` (`dashboard-rpc.ts`) → `chat.peers`, `chat.waiting`, `agentFactsOf`, Dashboard | 3 lần `list` lọc `bm.role`, mỗi lần 1 trang ≤ 200 | 1 lần `listAllAgents({ includeArchived: true })` (đủ trang), giữ agent có `roleOfAgent ≠ null`; `AgentFacts` thêm `labelled` |
| `chat.peers` (`chat-rpc.ts`) | owner/peers theo nhãn | theo `bmAgentsOf` mới; `ChatPeer` thêm `labelled: boolean` (`contracts.ts`, `.default(true)` để tương thích) |
| `findLiveManagers` (`manager.ts`) | lọc nhãn `bm.role=manager` | `listAllAgents({ includeArchived: false })`, giữ `roleOfAgent().role === "manager"` và còn sống; sắp **có nhãn trước**, rồi mới nhất trước (§4.3) |
| `listWorkspaceAgents` (cây agent, `manager.ts`) | thành viên = có nhãn `bm.role` + con cháu; `roleOf` theo nhãn | thành viên = `roleOfAgent ≠ null` + con cháu; `roleOf` dùng `roleOfAgent`; `AgentNode` thêm `labelled` |
| `listByRole` (`/bm-worker-stop-all`, `stop-propagation.ts`) | lọc nhãn vai | `listAllAgents({ includeArchived: false })` + `roleOfAgent().role === role` + đúng workspace; vẫn kiểm lại để **không bao giờ** chạm Manager |
| `listRunningReviewers` / `isRunningReviewerOf` (`stop-propagation.ts`) | lọc nhãn cha + nhãn vai | lọc nhãn cha `paseo.parent-agent-id` (giữ), vai kiểm bằng `roleOfAgent().role === "reviewer"` |
| Kho vết, ngân sách review | theo provider | không đổi (K4) |

### 4.3 Manager thiếu nhãn — `manager.ensure`

- Chọn: trong các Manager đang sống của workspace, Manager **có nhãn** đứng trước. Trong cùng nhóm thì mới nhất trước, như hôm nay. `otherManagerIds` liệt kê phần còn lại như trước.
- Không đổi mode: `switchOnce` chỉ chạy cho Manager `labelled: true`. Manager chỉ nhận theo provider được người dùng tạo với mode họ chọn.
- Ví dụ workspace paseo-bm: `557cc8e4` (có nhãn) vẫn là Manager được mở. `c8bca1ea` (không nhãn) chỉ nằm trong `otherManagerIds`.
- Ví dụ workspace "Refactor Dependency": `f13a4e4e` được mở; không tạo Manager thứ hai.

### 4.4 Cảnh báo trong chat và cây agent

- `ChatCardView`: khi `peers.data.owner.labelled === false`, hàng chip của thẻ có thêm chip `Not started by paseo-bm` (tone `warning`). Mở tin thì có thêm một dòng trước nội dung: `This agent has no bm.role label: it was started outside Beads Manager, and paseo-bm recognised it by its provider.`
- Cây agent (`plugin/client/tree.tsx`): sau tên vai của nút `labelled === false` có chữ `· no label`, cùng màu chữ phụ.
- Chữ trên màn hình bằng tiếng Anh như mọi chữ khác của plugin.

### 4.5 Gắn nhãn khi tạo — `plugin/server/agent-labels.ts` (mới)

Đăng ký `on("agent.created", handler)` trong `index.server.ts`. Handler:

1. `role = ROLE_BY_PROVIDER[providerId(event.agent.provider)]`; không có thì dừng.
2. `snapshot = await paseo.agents.ref(id).refresh()`. Nhãn `bm.role` đã là một vai hợp lệ thì dừng. Đây là trường hợp thường: Manager tạo Worker, Worker tạo Reviewer, `manager.ensure` tạo Manager, tất cả đều truyền nhãn khi tạo.
3. Nhãn cần gắn:
   - `bm.role=<role>`;
   - với `manager`: thêm `bm.modeSet=<mode hiện tại>`, mode lấy từ `runtimeInfo.modeId`, rồi `currentModeId`. Thiếu mode thì không gắn `bm.modeSet`.
4. Gọi `setAgentLabels(id, labels)`: một lệnh `paseo agent update <id> --label k=v --label k=v --json`, mở rộng `paseo-cli.ts`. Mọi giá trị vẫn qua kiểm `TOKEN` như hôm nay.
5. Log:
   - thành công: `[paseo-bm] labelled <id> as <role> (it was created without bm.role)`;
   - thất bại: `[paseo-bm] could not label <id> as <role>: <reason>`.

   Handler không bao giờ ném. Mỗi `id` được xử lý tối đa một lần trong một lần chạy plugin.

Vì K7, lệnh không xoá `bm.requestId` hay nhãn nào khác. Vì K8, đây là cố gắng tốt nhất; §4.1–4.3 vẫn bảo đảm nhận diện khi lệnh hỏng.

**Lượt quét khi nạp (Q6 a).**

- `PluginServerContext` **không có** handle Paseo lúc nạp: handle chỉ có trong context của hook và RPC (`@getpaseo/plugin` `server/contracts.d.ts`, `lifecycle.d.ts`). Vì vậy lượt quét chạy **một lần mỗi lần nạp**, bắt đầu ở sự kiện `agent.turn_started` hay `agent.created` đầu tiên plugin nhận sau khi nạp, bằng `paseo` của sự kiện đó.
- Lượt quét gọi một lần `listAllAgents({ includeArchived: false })`, chạy nền và không chặn handler của sự kiện.
- Với mỗi agent có `roleOfAgent(...)` = `{ labelled: false }`, lượt quét chạy đúng các bước 3–5 ở trên.
- Ví dụ: `f13a4e4e` thành `bm.role=manager`, `bm.modeSet=bypassPermissions`; `c8bca1ea` cũng thành Manager có nhãn.
- Lỗi của lượt quét (liệt kê, CLI) chỉ tốn log, và không chạy lại tới lần nạp sau.

### 4.6 Bộ kiểm template — `plugin/shared/bm-format.ts` (mới, thuần)

```ts
export type BlockKind = "BM-REPORT" | "BM-QUESTIONS" | "BM-ANSWERS" | "BM-REVIEW";
export interface FormatIssue { kind: BlockKind; field: string | null; message: string }
export interface CheckedBlock { kind: BlockKind; requestId: string | null; text: string; issues: FormatIssue[] }
/** Mọi khối BM-* trong một tin, theo thứ tự, mỗi khối kèm lỗi của nó. Không ném. */
export function checkBlocks(message: string): CheckedBlock[];
```

**Tìm khối.**

- Một khối bắt đầu ở dòng chỉ có `BM-REPORT`, `BM-QUESTIONS`, `BM-ANSWERS` hay `BM-REVIEW`. Được phép có `>` hoặc hàng rào code ngay trước dòng đó.
- Khối kết thúc ở dòng trống, ở hàng rào code, hay ở đầu khối khác.
- `BM-REVIEW` được phép có dòng trống bên trong danh sách `findings:`.
- `BM-REVIEW STOPPED` là một khối hợp lệ đứng một mình.

**Bỏ qua:**

- khối "mẫu", tức có một dòng giá trị liệt kê lựa chọn bằng `|` (`phase: received | beads-done | …`), giống `TEMPLATE_PHASE` của `chat-cards.ts`;
- khối ở trong đoạn trích dẫn `>` bên trong một tin người dùng. Không kiểm tin người dùng nào, xem §4.7.

**Luật** (mỗi luật hỏng là một `FormatIssue`, câu tiếng Anh vì nó gửi cho agent):

| Khối | Luật |
|---|---|
| `BM-REPORT` | Đúng 12 trường của mẫu `worker.md` — `requestId, phase, tier, filesChanged, beadsCreated, beadsUpdated, beadsClosed, beadsReady, reviewFindingsOpen, buildAndTests, skillsUsed, blockers` — mỗi trường đúng một lần, không trường lạ, **đúng thứ tự mẫu** (Q7 a) |
| | `requestId` khớp `^req-\d{8}T\d{6}Z$` |
| | `phase` ∈ `received`, `beads-done`, `blocked`, `finished` |
| | `tier` khớp `^(Small\|Medium\|Large) \(changed: (no\|from (Small\|Medium\|Large), .+)\)$` |
| | `beadsCreated/Updated/Closed/Ready`: `none`, hoặc danh sách cách bởi `,` mà mỗi phần là một bead id đầy đủ (`BEAD_ID` của `bm-report.ts`: có tiền tố, không `.3` cụt, không chữ chú thích) |
| | `skillsUsed`: `none` hoặc danh sách tên skill `[a-z0-9-]+` |
| | `reviewFindingsOpen`: `none` hoặc các mục `b<n>: <nội dung>` cách bởi `;` |
| | `filesChanged`, `buildAndTests`, `blockers` không rỗng |
| | `phase: blocked` → cùng tin có một khối `BM-QUESTIONS` (Q7 a); `blockers` khi đó bắt đầu `<n> question(s): Q…, Q… — see BM-QUESTIONS` và liệt kê đúng các mã của khối |
| `BM-QUESTIONS` | Dòng `requestId:` có, và bằng `requestId` của `BM-REPORT` cùng tin |
| | 1–5 câu; mỗi câu một dòng `Q<n>: <chữ>`; mã không trùng, tăng dần |
| | Mỗi câu ≥ 2 lựa chọn, mỗi lựa chọn một dòng `- <chữ cái>: <chữ>`; chữ cái liên tiếp từ `a` |
| | Đúng một lựa chọn kết thúc bằng `(recommended)` trong mỗi câu |
| `BM-ANSWERS` | Dòng `requestId:` hợp lệ; mỗi dòng còn lại `Q<n>: <chữ cái> — <chữ>` hoặc `Q<n>: other — <chữ>`; mã không trùng; ít nhất một dòng |
| `BM-REVIEW` | Trường `requestId, batchId, reviewKind, verdict, checked, findings, notChecked` đủ, không trùng |
| | `batchId` khớp `^b\d+$`; `reviewKind` ∈ `first`, `re-review`; `verdict` ∈ `pass`, `changes-required` |
| | `findings: none`, hoặc mỗi mục có đủ `severity` (∈ `blocking`, `non-blocking`), `location`, `reason`, `suggestedFix` |
| | `verdict` = `changes-required` khi và chỉ khi có ít nhất một mục `blocking` (luật của `reviewer.md`) |

Giá trị `none` so không phân biệt hoa thường, như bộ đọc khoan dung. Một tin tối đa 20 000 ký tự được kiểm (như `MAX_BLOCK_CHARS`). Dài hơn thì chỉ kiểm phần đầu và thêm một lỗi `message too long to check`.

### 4.7 Phát hiện và thông báo `BM-FORMAT` — `plugin/server/format-check.ts` (mới)

**Ở đâu kiểm.** Chỉ dùng hình dạng đã kiểm chứng: `user_message` không có `clientMessageId` (K9) và `assistant_message` (K11). Tool call `send_agent_prompt` không được dùng (K12).

| Khối | Kiểm ở lượt kết thúc của | Nguồn trong lượt | Người gửi (nhận thông báo) |
|---|---|---|---|
| `BM-REPORT` (+ `BM-QUESTIONS`) | Manager (người nhận) | `user_message` không `clientMessageId`, không phải thông báo plugin | Worker **duy nhất** của workspace có `requestId` đó (nhãn `bm.requestId` hoặc kho vết, như `chat.peers`) |
| `BM-ANSWERS` | Worker (người nhận) | như trên | Cha của Worker (`paseo.parent-agent-id`) nếu `roleOfAgent` là `manager` |
| `BM-REVIEW` | Reviewer (người gửi) | `assistant_message` của chính Reviewer | chính Reviewer |

Không xác định được đúng một người gửi thì không gửi thông báo. Chip trên thẻ vẫn hiện, và có một dòng log.

**Chỉ khối mới nhất.** Với mỗi `(người gửi, requestId, loại khối)`, chỉ khối cuối cùng thấy trong lượt được xét. Kết quả được lưu (bộ nhớ trong tiến trình) thành trạng thái "mới nhất đã thấy":

- khối mới nhất đúng → xoá thông báo đang chờ của khoá đó;
- khối mới nhất sai → thay thông báo đang chờ bằng lỗi của khối này, kèm **mốc**. Mốc là `lastUserMessageAt` của phía đã kiểm khối lúc kiểm: Manager với báo cáo, Worker với câu trả lời, chính Reviewer với review.

**Gửi.** Thông báo đang chờ được xét lại ở ba loại lượt kết thúc:

1. lượt kết thúc nơi khối được kiểm;
2. lượt kết thúc kế tiếp của phía nhận: Manager với báo cáo, Worker với câu trả lời, và **Worker cha của Reviewer** (`paseo.parent-agent-id`) với review;
3. lượt kết thúc kế tiếp của chính người gửi.

Ở mỗi lần xét, thông báo chỉ được gửi khi đủ cả hai điều kiện:

- **Người gửi không chạy.** `refresh()` báo không `running` hay `initializing`. Ở loại (3), nếu `refresh()` vẫn báo `running` vì trạng thái chưa kịp đổi, thì đọc lại tối đa 5 lần, cách nhau 1 giây. Vẫn chạy thì giữ lại.
- **Khối vẫn là khối mới nhất.** Ở loại (1) và (2), bước kiểm vừa chạy đã thay hay xoá thông báo theo khối mới nhất mà phía kiểm nhận được, nên không cần xét thêm. Ở loại (3), phía kiểm có thể chưa đọc khối mới hơn của người gửi, nên thông báo chỉ được gửi khi `lastUserMessageAt` của phía kiểm vẫn bằng mốc. Khác mốc thì **giữ lại, không bỏ**, và lượt kết thúc kế tiếp của phía kiểm sẽ quyết (errata khi implement: bỏ thông báo ở đây làm mất nó mỗi khi Paseo báo "Worker finished" cho Manager, vì thông báo đó cũng đổi mốc).

Vì sao luôn có một lần xét sau khi người gửi rảnh:

- Báo cáo: Manager được đánh thức sau mỗi lượt của Worker (`notifyOnFinish` mặc định khi tạo Worker), nên luôn có một lượt Manager, loại (2), sau khi Worker rảnh.
- Review: Worker được đánh thức khi Reviewer xong (`notifyOnFinish` mặc định khi tạo Reviewer), nên luôn có một lượt Worker cha, loại (2), sau khi Reviewer rảnh.
- Câu trả lời: không có bảo đảm tương tự. Lần xét muộn nhất là loại (3), ở lượt kết thúc kế tiếp của chính Manager. Manager chạy quá 5 giây sau lượt đó thì thông báo bị giữ tới lượt Worker hay Manager kế tiếp, và có thể không bao giờ đi. Chip trên thẻ vẫn hiện, và có một dòng log.

- Mỗi khối (theo nội dung) được báo tối đa **một** lần. Mỗi `(người gửi, requestId, loại khối)` được báo tối đa **2** lần (Q8 a). Quá giới hạn thì chỉ còn chip và một dòng log `[paseo-bm] <kind> from <id> still breaks the template after 2 notices; not asking again`.
- Nhớ trong bộ nhớ: nạp lại plugin thì đếm lại từ 0. Không bao giờ báo lại khối cũ sau khi nạp lại, vì chỉ khối thấy trong lượt vừa kết thúc mới được xét.
- Giới hạn đã biết: `BM-ANSWERS` sai chỉ được kiểm khi lượt của Worker nhận nó kết thúc, và lượt đó có thể dài. Thông báo cho Manager vì thế có thể đến muộn. Chip trên thẻ trong chat Worker thì hiện ngay.

**Chữ thông báo** (tiếng Anh, cho agent):

```
BM-FORMAT requestId: <requestId>
Your last <BM-REPORT | BM-QUESTIONS | BM-ANSWERS | BM-REVIEW> broke the template:
- <field>: <issue>
- <issue>
Send the whole corrected block again, to the same agent as before, in one message. Change nothing else and do not redo any work; then carry on exactly where you were.
```

Với Reviewer, dòng cuối là: `Answer with the whole corrected BM-REVIEW block as your final message; do not review again.`

`BM-FORMAT` được thêm vào `PREFIXES` của `notices.ts`. Nhờ vậy kho vết ghi nó là tin của plugin, không phải lời người dùng, và `reviewCallsOf` không đếm nó là một lượt review (K17).

**Không bao giờ ném.** Mọi lỗi (đọc timeline, liệt kê agent, gửi) chỉ tốn một dòng log. Handler đăng ký trong `index.server.ts` cạnh collector và ngân sách review, đọc cùng timeline của sự kiện.

### 4.8 Chip "template error" và bản dự phòng — `plugin/client/chat-cards.ts`, `chat-card.tsx`

- `chatCardSchema` thêm `formatIssues: z.array(z.string()).default([])`. `CHAT_CARD_VERSION` giữ 1, vì trường có mặc định và thẻ được dựng lúc vẽ, không lưu.
- `toChatCard` điền `formatIssues` từ `checkBlocks(text)`: mọi lỗi của các khối trong tin, dạng `<kind> <field>: <message>`.
  - Tin người dùng gõ không bao giờ thành thẻ (đã vậy), nên không bao giờ có chip.
  - Chỉ thẻ `received` và thẻ `sent` của Reviewer (`BM-REVIEW`) mang lỗi. Thẻ `sent` của Worker trích báo cáo trong chat của chính nó thì không, vì đó không phải khối gửi đi.
- `ChatCardView`: `formatIssues.length > 0` → chip `template error` (tone `danger`) trong hàng chip. Mở tin thì danh sách lỗi đứng trước nội dung.
- Bản dự phòng (`drawAsCard` false) vẽ `markdownOf(card.text)` thay cho `card.text` (K16), nên mỗi trường một dòng và câu hỏi, lựa chọn tách dòng như trong thẻ.

### 4.9 Mode Reviewer — `plugin/server/role-extras.ts`

**Nguyên nhân (K13, K14).**

1. Nhánh Worker của `runtimeFactsOf` có trong working tree nhưng chưa được cài lên daemon.
2. Khi tra cứu hỏng, không có giá trị dự phòng.
3. Lỗi bất ngờ bị nuốt mà không có log.

**Sửa.**

- `modesFor` nhớ danh sách mode đọc được **lần thành công gần nhất** cho mỗi provider, trong bộ nhớ của tiến trình plugin.
- Worker, khi `modesFor` trả `null`:
  1. dùng danh sách nhớ gần nhất nếu có, qua cùng `chooseModeId("reviewer", …)`;
  2. nếu không có danh sách nhớ, dùng **`auto`** (Q9 a). Đây là lựa chọn đầu tiên của luật Reviewer (K15), có ở cả Claude và Codex, và không phải mode `dangerous` hay `planning` ở provider nào đã đo. Provider lạ không có `auto` thì Paseo từ chối lúc tạo, kèm danh sách mode của nó, nghĩa là hỏng to chứ không im lặng.
  3. Log: `[paseo-bm] could not read the modes of bm-reviewer; the Worker is told to pass the fallback Reviewer mode "<mode>" (<source>).` Ở đây `<source>` là `last list read at <time>` hoặc `static fallback`.
- `catch` của `runtimeFactsOf` ghi `[paseo-bm] reading the Runtime facts of <role> failed: <message>` trước khi trả `{}`.
- Nhánh Manager không đổi: đã có dự phòng là mode của profile.
- Hook `before("agent.create")` của Reviewer vẫn chạy và vẫn hạ mode `dangerous` / `planning` (không đổi).

### 4.10 Chỉ dẫn vai — `plugin/roles/*.md`

Mỗi file thêm đúng một luật, đặt ở chỗ đã nói về thông báo `BM-` của plugin:

- **`worker.md`** (mục Reporting): `A message that starts with BM-FORMAT comes from the plugin, not the user: your last block broke the template. Send the whole corrected block again, to the same agent, in one message, changing nothing else; do not redo work, then carry on where you were.`
- **`manager.md`** (mục Talking to the user): `A message that starts with BM-FORMAT is the plugin's: your last BM-ANSWERS broke the template. Send the corrected block again to that Worker once it is not running; say nothing to the user about it.`
- **`reviewer.md`** (sau mẫu `BM-REVIEW`): `A message that starts with BM-FORMAT is the plugin's: answer with the whole corrected BM-REVIEW block only; do not review again.`

Sinh lại `*-instructions.ts` bằng `npm run generate:role-instructions`. `test/roles-content.test.ts` ghim ba luật. Luật không vừa ngưỡng dòng, nên owner cho nâng vừa đủ (Q14 a): `worker.md` < 397 và `manager.md` < 176. Mỗi luật được nối vào một đoạn có sẵn của mục đó và xếp lại đoạn (+3 và +2 dòng). `reviewer.md` vừa ngưỡng cũ.

### 4.11 Sửa chồng và cài đặt (Q10 a)

**Trước khi sửa code.**

- Worker gọi `list_agents` của workspace này và tìm agent khác có `roleOfAgent` là `worker` đang `running` hay `initializing`.
- Có thì Worker gửi `blocked`, nêu các agent đó, và chờ owner. Không có thì Worker sửa code.
- Mỗi lần owner cho tiếp tục, Worker kiểm lại trước khi sửa tiếp.

**Sau khi batch implementation pass.**

1. Kiểm mọi agent `bm-*` khác (mọi workspace) đang không `running` / `initializing`. Nếu còn thì chờ và báo, không cài.
2. Gửi `finished` cho Manager **trước**, vì lệnh dưới có thể ngắt lượt của chính Worker (checklist dashboard, cảnh báo 2).
3. Chạy lần lượt:
   - sao lưu payload đang chạy: `cp -Rp ~/.paseo-bm/plugin/0.2.0-alpha.0 ~/.paseo-bm/backups/<UTC stamp>-pre-20260918g`, rồi kiểm bằng `diff -r`. Bước này là bản sao duy nhất của payload cũ, vì trình cài ghi đè file của chính nó cùng phiên bản mà không sao lưu (`src/commands/install/applier.ts:53` chỉ sao lưu file `user-modified` / `conflict`). Owner xác nhận bước này ở Q11 a;
   - `npm run build`;
   - `node dist/index.js install --home ~/.paseo-bm` không có `--apply`, để xem trước;
   - `node dist/index.js install --home ~/.paseo-bm --apply --yes --skip-skills-check`;
   - `paseo plugin reload paseo-bm --json`, rồi đọc `status: running` (bằng `paseo plugin ls --json`).
4. Không đồng ý thay mới ranh giới tin cậy nào (`--enable-plugins`, `--install-skills` không được dùng). Không chạy `paseo daemon restart` / `stop`.
5. Chỉ làm **một lần**. Hỏng thì Worker ghi đúng lỗi vào một báo cáo `blocked`, không thử lại.

Bản cài mang theo mọi thay đổi chưa commit của working tree, kể cả của request khác. Owner đã chấp nhận điều này ở Q10.

**Hoàn tác.**

- Chép bản sao lưu đè lại payload, rồi `paseo plugin reload paseo-bm --json`. Các tệp mới của delta vẫn nằm đó nhưng không còn gì import chúng.
- Chặn tạm không cần hoàn tác: `paseo plugin disable paseo-bm`. Agent vẫn chạy, chỉ không có thẻ và thông báo.
- Owner quyết cách nào; Worker không tự hoàn tác.
- Ngoài đường này, việc cài là điểm không đảo ngược của request, được Q10 a cho phép.

### 4.12 Tương thích

- Người dùng chỉ dùng Beads Manager: không thấy gì khác, trừ khi có khối sai template (chip và `BM-FORMAT`).
- Người dùng có Manager mở từ màn tạo agent của Paseo: thẻ, thẻ câu hỏi, pill hiện lại; Beads Manager mở đúng Manager đó thay vì tạo cái thứ hai. Đây là thay đổi hành vi họ đang gặp, và là mục đích của Q1.
- `/bm-worker-stop-all` giờ cũng dừng Worker, Reviewer thiếu nhãn. Manager vẫn không bao giờ bị chạm.
- Trường mới của `ChatPeer`, `AgentNode`, thẻ đều có mặc định: client cũ đọc server mới và ngược lại đều không vỡ.
- Worker, Manager, Reviewer cũ (chỉ dẫn cũ) nhận `BM-FORMAT` mà không có luật: họ đọc nó như một tin thường. Chữ thông báo tự đủ ý để làm đúng.

## 5. Luồng

- **F1 — Manager không nhãn** (`f13a4e4e`): mở chat → `chat.peers` → `bmAgentsOf` thấy `f13a4e4e` theo provider (`labelled: false`) → thẻ vẽ, câu hỏi có nút, chip "Not started by paseo-bm".
- **F2 — Tạo từ màn Paseo**: người dùng tạo agent với profile "Manager" → `agent.created` → snapshot không có `bm.role` → `paseo agent update <id> --label bm.role=manager --label bm.modeSet=<mode>` → log. Lệnh hỏng thì F1 vẫn đúng.
- **F3 — Báo cáo sai**: Worker gửi `blocked` thiếu `(recommended)` ở Q2 → lượt Manager kết thúc → `checkBlocks` → Worker duy nhất của `requestId` là người gửi, đang không chạy → `BM-FORMAT` tới Worker → Worker gửi lại cả khối → lượt Manager kế tiếp: khối mới nhất đúng → xoá chờ. Thẻ của báo cáo đầu có chip `template error`, thẻ thứ hai không.
- **F4 — Không hết lỗi**: sau 2 thông báo khối vẫn sai → chỉ chip và log.
- **F5 — Tra mode hỏng**: tạo Worker khi `listModes("bm-reviewer")` hết giờ → dùng danh sách nhớ hoặc `auto` → chỉ dẫn Worker có `## Runtime facts` → log.

## 6. Chiến lược kiểm thử

Vitest, Paseo giả, CLI giả, `$HOME` giả. Không test nào chạm daemon thật. File trong `test/` không import `react-native` như một giá trị.

| Phần | Ca chính |
|---|---|
| `roleOfAgent` | nhãn đúng; nhãn lạ + provider `bm-worker/claude-opus-5`; không nhãn + `bm-manager`; provider lạ → null; input hỏng không ném |
| `listAllAgents` / `bmAgentsOf` | 3 trang; trang thiếu `pageInfo`; agent không nhãn của từng vai có mặt với `labelled: false`; > 200 agent mỗi vai (đối chứng âm cho K2) |
| `chat.peers` | dữ liệu giống workspace "Refactor Dependency" (K1) → owner là manager `labelled: false`, peers có Worker |
| `manager.ensure` | Manager có nhãn trước Manager không nhãn mới hơn; chỉ có Manager không nhãn → dùng nó, `created: false`, không gọi `setAgentMode` |
| Cây agent, `/bm-worker-stop-all`, dừng Reviewer | agent không nhãn có mặt đúng vai; Manager không nhãn không bao giờ nhận thông báo dừng |
| `agent-labels` | không nhãn → một lệnh đúng tham số; có nhãn → không lệnh; CLI hỏng → một dòng log, không ném; provider lạ → không gì; lượt quét khi nạp: chỉ agent `bm-*` chưa lưu trữ thiếu nhãn, mỗi agent một lệnh, liệt kê hỏng → log, không ném, không chặn nạp |
| `bm-format` | mỗi luật của §4.6: một ca sai (đúng lỗi) và mẫu đúng (không lỗi); khối "mẫu" có `\|` bị bỏ qua; `BM-REVIEW STOPPED`; ba báo cáo thật của ngày 2026-09-18 (Worker `9467dc77`, bead `bm-llmg`) không lỗi |
| `format-check` | F3; F4; người gửi đang chạy → không gửi, lượt sau gửi; Reviewer còn `running` ở lượt của chính nó → gửi ở lượt kế tiếp của Worker cha; Manager còn `running` ở lượt Worker → gửi ở lượt kế tiếp của chính Manager; `refresh()` báo `running` rồi `idle` ở lần đọc lại → gửi; phía kiểm đã nhận tin mới hơn mốc → bỏ, không gửi; `received` sai rồi `blocked` đúng → không báo; tin có `clientMessageId` → không kiểm; không xác định người gửi → không gửi; thông báo không bị đếm là review, không thành lời người dùng |
| Thẻ | chip `template error` và danh sách lỗi; chip `Not started by paseo-bm`; bản dự phòng dùng `markdownOf` |
| Mode Reviewer | `modesFor` hỏng + có danh sách nhớ → mode từ danh sách; hỏng + không nhớ → `auto`; ném bất ngờ → log |
| Chỉ dẫn | `roles-content.test.ts` ghim ba luật `BM-FORMAT`; ngưỡng dòng không đổi |

Cổng cuối: `npm run verify` mã 0; `br lint -s all`, `br dep cycles` sạch.

## 7. Hoàn tác

- Mỗi WP revert tệp của chính nó; chỉ dẫn thì chạy lại `npm run build`.
- Không có dữ liệu lưu bền nào đổi: mọi đếm và "mới nhất" ở trong bộ nhớ.
- Nhãn đã gắn cho agent (§4.5) ở lại sau khi hoàn tác. Nhãn đó đúng vai và vô hại. Gỡ bằng tay được trong Paseo, nhưng plugin không gỡ.

## 8. Rủi ro và giới hạn

| Rủi ro | Giảm thiểu |
|---|---|
| Luật quá chặt → báo nhầm, tốn lượt của agent | Luật chỉ lấy từ mẫu trong ba file vai; test với báo cáo thật; giới hạn 2 lần; thứ tự trường và `blocked` bắt buộc `BM-QUESTIONS` do owner chọn (Q7 a), và mẫu trong `worker.md` đã yêu cầu đúng hai điều đó |
| Thông báo cắt ngang việc | Không bao giờ gửi vào lượt đang chạy (K10); chữ thông báo nói "không làm lại việc" |
| Vòng lặp thông báo | Mỗi khối một lần, mỗi khoá tối đa 2 lần; thông báo của plugin không bị kiểm |
| CLI từ daemon không chạy (K8) | Nhận diện theo provider là bảo đảm; lỗi chỉ tốn log |
| Liệt kê mọi agent thay vì theo nhãn → chậm hơn | Mỗi trang 200; `chat.peers` được client nhớ 30 s như hôm nay |
| Người gửi xác định sai | Chỉ gửi khi đúng một ứng viên; còn lại chỉ có chip |
| Bản sửa chưa tới daemon | Cài và nạp lại một lần sau khi batch implementation pass (§4.11) |
| Request khác sửa cùng tệp | Kiểm Worker đang chạy trước khi sửa code; có thì `blocked` (§4.11) |

## 9. Câu hỏi mở

Không còn. Owner chốt Q6–Q10 ngày 2026-09-18, xem [PRD delta §1.2](../product/paseo-bm-prd-delta-20260918g-agent-conventions.md):

- Q6 a: quét khi nạp (§4.5);
- Q7 a: thứ tự trường, `blocked` bắt buộc `BM-QUESTIONS` (§4.6);
- Q8 a: tối đa 2 lần (§4.7);
- Q9 a: `auto` (§4.9);
- Q10 a: §4.11.

## 10. Revision History

| Ngày | Ai | Thay đổi |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Tạo delta theo Q1–Q5 của `req-20260918T071130Z`; Status Draft |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | WP-282: thiết kế gốc có dòng revision trỏ tới delta này; §4.10 ghi Q14 a (nâng trần dòng) |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Errata khi implement §4.7: mốc `lastUserMessageAt` chỉ xét ở lượt kết thúc của chính người gửi, và khác mốc thì giữ lại chứ không bỏ, vì thông báo "Worker finished" của Paseo cũng đổi mốc |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Review `b3` (blocking): §4.11 thêm bước sao lưu payload trước khi cài (chờ owner xác nhận) và đường hoàn tác / chặn tạm cụ thể |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Errata khi chuyển thành beads: server của plugin không có handle Paseo lúc nạp, nên lượt quét (§4.5, Q6) bắt đầu ở sự kiện `agent.turn_started` / `agent.created` đầu tiên sau khi nạp, một lần mỗi lần nạp |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Cổng `design-ready` PASS sau review `b2` (pass ở lần re-review); Status Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Review `b2` (blocking): §4.7 thêm ba loại lượt xét lại (kể cả Worker cha của Reviewer và chính người gửi), mốc `lastUserMessageAt` chống báo khối cũ, đọc lại trạng thái tối đa 5 lần; §6 thêm ca tương ứng |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Áp Q6–Q10: lượt quét khi nạp (§4.5), luật Q7 (§4.6; sửa "13 trường" thành 12), giới hạn 2 (§4.7), `auto` (§4.9), §4.11 sửa chồng và cài đặt mới; §9 không còn câu mở |
