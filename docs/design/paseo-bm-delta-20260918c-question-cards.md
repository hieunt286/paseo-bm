# Delta-change — Câu hỏi có cấu trúc của Worker và thẻ trả lời có lựa chọn

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260918c-question-cards` |
| Tài liệu gốc | [delta 20260916-chat-cards](./paseo-bm-delta-20260916-chat-cards.md) §4 (thẻ, người gửi/nhận, trả lời); [Technical Design Dashboard](./paseo-bm-dashboard.md) §6 (bộ đọc `BM-REPORT`); [Technical Design](./paseo-bm.md) phần chỉ dẫn vai trò |
| PRD | [prd-delta-20260918c-question-cards](../product/paseo-bm-prd-delta-20260918c-question-cards.md) — REQ-059 (a)–(h); quyết định Q40–Q44; Routing Decision ở §0 của tài liệu đó |
| Plan | [plan-delta-20260918c-question-cards](../plans/paseo-bm-implementation-plan-delta-20260918c-question-cards.md) |
| Status | **Active** — cổng `design-ready` PASS 2026-09-18 (review b1 pass sau một lần sửa) |
| Owner | hieu.nt10 |
| ADR | N/A — không có ADR nào quản chuyện này: không thêm công nghệ, không đảo quyết định nào. [ADR-007](../adr/ADR-007-dashboard-trace-store.md) (kho vết) giữ nguyên vì kho không thêm trường |
| Request | `req-20260918T021211Z` |

**Thiết kế này sở hữu:**

- định dạng khối `BM-QUESTIONS` và `BM-ANSWERS`;
- bộ đọc và bộ soạn của chúng (`plugin/shared/bm-questions.ts`);
- phần câu hỏi của thẻ chat trong chat Manager;
- các câu trong `worker.md` và `manager.md` nói về cách hỏi, cách hiện câu hỏi và cách chuyển câu trả lời.

**Không sở hữu:**

- các trường có sẵn của `BM-REPORT` và `BM-REVIEW`, và bộ đọc của chúng;
- kho vết, Dashboard;
- `reviewer.md`;
- cơ chế chat, trạng thái agent và việc gửi tin của Paseo;
- nội dung câu hỏi (Worker) và quyết định trả lời (người dùng).

## 1. Ba kết quả

1. **Worker hỏi theo một mẫu cố định.** Mỗi câu có mã không lặp lại trong request, có các lựa chọn và đúng một đề xuất, đặt trong khối `BM-QUESTIONS` ngay sau `BM-REPORT` (Q41).
2. **Người dùng trả lời trong thẻ, bằng nút bấm.** Câu trả lời đi thẳng tới đúng Worker đang hỏi, dưới dạng khối `BM-ANSWERS` (Q40, Q42).
3. **Manager hiện câu hỏi theo từng Worker và chuyển câu trả lời không nhầm**, cũng bằng `BM-ANSWERS` (Q43).

## 2. Nền tảng — đã kiểm chứng những gì

Đọc mã của repo, SDK plugin Paseo 0.8 trong `node_modules/@getpaseo/plugin`, và kho vết của owner (chỉ đọc), ngày 2026-09-18.

| # | Câu hỏi | Kết quả | Hệ quả |
|---|---|---|---|
| F1 | Worker đang hỏi thế nào? | 42 báo cáo `blocked` thật: mọi câu hỏi nằm trên một dòng `blockers:`, trung vị 458 ký tự, dài nhất 2975; mỗi Worker viết một kiểu (`1. … (a) … Recommended: (a).`, `Q1 (…) A-recommended: … \| B: …`) | Không đọc được bằng máy một cách chắc chắn → cần mẫu mới (Q41), còn kiểu cũ thì để nguyên (Q44) |
| F2 | Thêm một khối sau `BM-REPORT` có làm bộ đọc báo cáo đọc sai không? | `extractBlocks` (`plugin/shared/bm-report.ts`) kết thúc một khối ở dòng đầu tiên không có dạng `key: value`. Dòng `BM-QUESTIONS` không có dấu `:` nên kết thúc khối báo cáo; các dòng `Q1: …` sau đó nằm ngoài mọi khối và bị bỏ qua | Bộ đọc báo cáo, bộ thu thập và kho vết không đổi. Một test chốt điều này (§6) |
| F3 | Thẻ nhận biết tin của ai, gửi cho ai? | `toChatCard` chạy trên từng mục chat; `partiesOf` tìm Worker theo `requestId` và chỉ trả id khi có **đúng một** Worker khớp; `chat.peers` trả `status` của từng agent paseo-bm cùng workspace | Dùng lại nguyên cách tìm người nhận; không cần RPC mới |
| F4 | Gửi từ thẻ đi đường nào? | `paseo.agents.ref(id).send(text)`: đúng đường composer của app dùng, tin mang `clientMessageId` như tin người dùng thật (AGENTS.md) | Worker nhận câu trả lời như lời người dùng (Q40) |
| F5 | Gửi vào agent đang chạy thì sao? | Tin mới thay lượt đang chạy và bỏ phần việc đó (AGENTS.md; `manager.md` bước 2) | Thẻ đọc lại trạng thái ngay trước khi gửi và từ chối khi Worker đang `running` hay `initializing` |
| F6 | Chỉ dẫn vai trò tới agent lúc nào? | Hook `before("agent.create")` (`plugin/server/role-hook.ts`) gắn chỉ dẫn **lúc tạo** agent | Agent tạo trước bản cập nhật giữ chỉ dẫn cũ → phải đọc được cả hai kiểu (§4.6) |
| F7 | Thẻ giữ trạng thái được bao lâu? | Renderer là component React; danh sách chat có thể dựng lại component khi cuộn. Renderer không có kho lưu riêng | Trạng thái "đã gửi" giữ trong một bảng ở mức module, sống hết phiên app (REQ-059d) |
| F8 | Bộ đọc hôm nay chặn độ dài thế nào? | `MAX_LIST_CHARS = 8000` cho trường danh sách (review bm-wp-220-nvk.1: đầu vào 40 KB đã làm chậm 1,6 giây) | Bộ đọc câu hỏi cũng chặn độ dài và không dùng regex lồng nhau |

## 3. Không đổi

- Các trường, thứ tự và nghĩa của `BM-REPORT`. `blockers:` vẫn là một dòng; chỉ **nội dung nên viết** vào đó đổi (§4.5).
- `BM-REVIEW`, `reviewer.md`, bộ thu thập, kho vết (`v: 1`, `TRACE_STORE_SCHEMA_VERSION = 1`), Dashboard, RPC `chat.peers`.
- Thẻ cho mọi tin khác: báo cáo không có câu hỏi, review, chỉ thị. Nút "Reply to …" chữ tự do vẫn có trên mọi thẻ.
- Chat của Worker và Reviewer (Q44).

## 4. Thiết kế

### 4.1 Khối `BM-QUESTIONS` (Worker → Manager)

Đặt ngay sau khối `BM-REPORT`, trong **cùng** tin `send_agent_prompt`:

```
BM-QUESTIONS
requestId: req-20260917T010956Z
Q1: Storage — the request says "save the user list" but not where.
- a: the existing Postgres `users` table: no migration, ready today. (recommended)
- b: a new table: needs a migration, which makes this request Large.
- c: a file on disk: simplest, but two writers can lose data.
Q2: Existing sessions — renaming the session cookie signs everyone out.
- a: keep the old name: nobody is signed out. (recommended)
- b: rename it: everyone signs in again, once.
```

**Luật viết (chỉ dẫn Worker):**

- tối đa 5 câu một lượt;
- mỗi câu một dòng `Q<n>: <chủ đề> — <câu hỏi>`;
- mỗi lựa chọn một dòng `- <chữ cái>: <lựa chọn: cái giá, việc Worker sẽ làm>`, chữ cái từ `a`, ít nhất 2 lựa chọn;
- **đúng một** `(recommended)` mỗi câu;
- **`n` đếm tiếp trong cả request**: lượt hỏi thứ hai bắt đầu sau số cuối của lượt đầu. Một câu trả lời muộn cho lượt cũ vì thế không bao giờ trùng mã với câu của lượt mới (REQ-059a, g);
- câu hỏi và lựa chọn viết bằng ngôn ngữ của người dùng; `BM-QUESTIONS`, `requestId`, `Q<n>`, chữ cái và `(recommended)` giữ nguyên.

Dòng `blockers:` của báo cáo đi kèm chỉ còn, ví dụ, `2 questions: Q1, Q2 — see BM-QUESTIONS`, rồi `Suggestion (not done): …` nếu có.

### 4.2 Khối `BM-ANSWERS` (người dùng → Worker)

```
BM-ANSWERS
requestId: req-20260917T010956Z
Q1: a — the existing Postgres `users` table: no migration, ready today.
Q2: other — giữ tên cũ tới bản phát hành sau
```

Mỗi câu một dòng:

- `Q<n>: <chữ cái> — <nguyên văn lựa chọn>`;
- hoặc `Q<n>: other — <nguyên văn lời người dùng>`, với xuống dòng đổi thành dấu cách để giữ mỗi câu một dòng.

Thẻ gửi **chỉ** khối này. Manager gửi `Continue <requestId>.`, một dòng trống, rồi khối này (§4.6).

### 4.3 Bộ đọc và bộ soạn — `plugin/shared/bm-questions.ts`

File mới, thuần (không React, không `server/`), client dùng được. Tách khỏi `bm-report.ts` để hợp đồng `BM-REPORT` và test của nó không đổi (F2).

```ts
export interface QuestionOption { key: string; text: string; recommended: boolean }
export interface Question { id: string; text: string; options: QuestionOption[] }
export interface QuestionSet { requestId: string | null; questions: Question[] }

export function parseQuestions(text: string): QuestionSet | null;
export type Pick = { key: string } | { other: string };
export function answersText(requestId: string, questions: readonly Question[], picks: Readonly<Record<string, Pick>>): string;
```

**`parseQuestions`** trả khối `BM-QUESTIONS` **cuối cùng** trong tin, hoặc `null` khi không có khối nào. Nó dễ dãi như bộ đọc báo cáo, vì đầu vào do mô hình ngôn ngữ viết:

- **Dòng mở khối:** `BM-QUESTIONS` đứng một mình, chấp nhận thêm `>`, `-`, `**` và rào ```` ``` ```` trước hoặc sau.
- **Dòng câu hỏi:** `Q<n>` rồi một trong `:`, `.` hay `)`; chấp nhận `**Q1:**` và `- Q1:`. Mã chuẩn hoá thành `Q<n>`.
- **Dòng lựa chọn:** có gạch đầu dòng hoặc ngoặc — `- a: …`, `- (a) …`, `- a) …`, `(a) …`, `a) …`. Khoá đổi về chữ thường. Một dòng văn xuôi bắt đầu bằng `a: …` mà không có gạch hay ngoặc **không** phải lựa chọn.
- **Đề xuất:** `(recommended)` hoặc `[recommended]`, không phân biệt hoa thường, được bỏ khỏi chữ hiển thị. Có **hơn một** lựa chọn đánh dấu trong một câu → coi như câu đó không có đề xuất, và thẻ không đoán.
- **Dòng tiếp nối:** dòng thụt lề ít nhất 2 dấu cách mà không phải lựa chọn được nối vào câu hỏi hoặc lựa chọn ngay trên nó. Dòng trống bị bỏ qua.
- **Kết thúc khối:** một dòng mở khối khác (`BM-REPORT`, `BM-REVIEW`, `BM-QUESTIONS`, `BM-ANSWERS`), rào đóng, hoặc một dòng văn xuôi không thụt lề.
- **Trùng lặp:** mã câu hỏi trùng thì giữ câu đầu; khoá lựa chọn trùng trong một câu thì giữ lựa chọn đầu.
- **Giới hạn:**
  - khối nằm **sau** báo cáo, nên không được cắt đầu tin. Bộ đọc làm hai bước:
    1. một lượt quét từng dòng trên **toàn bộ** tin để tìm dòng mở `BM-QUESTIONS` cuối cùng. Mỗi dòng chỉ thử một regex neo đầu dòng, không có lượng từ lồng nhau, nên chi phí tuyến tính theo độ dài tin;
    2. chỉ đọc tối đa 20 000 ký tự **tính từ dòng mở đó**;
  - đọc tối đa 10 câu và 8 lựa chọn mỗi câu;
  - mỗi đoạn chữ cắt ở 1000 ký tự kèm `…`;
  - mọi regex chạy trên từng dòng và không có lượng từ lồng nhau (F8).
- **Câu có ít hơn 2 lựa chọn** vẫn được trả về; thẻ chỉ cho trả lời câu đó bằng "Khác".

**`answersText`** soạn khối §4.2 theo thứ tự các câu hỏi và bỏ qua mã không có trong `questions`. Hàm được gọi khi mọi câu đã có đáp án (§4.4); câu còn thiếu thì hàm ném lỗi, để lỗi lập trình không lặng lẽ gửi đi một câu trả lời thiếu.

### 4.4 Thẻ câu hỏi trong chat Manager

**Dữ liệu** (`plugin/client/chat-cards.ts`):

- `chatCardSchema` thêm `questions: z.array(questionSchema).default([])`. `kind` và `version` giữ nguyên (`bm-message`, 1). Thẻ được dựng lại từ tin mỗi lần hiện và không được lưu ở đâu, nên không có dữ liệu cũ nào phải đọc lại.
- `toChatCard` điền `questions` khi thẻ là `report` và tin có khối `BM-QUESTIONS` mà `requestId` của khối để trống hoặc bằng `requestId` của báo cáo. Khối mang request khác bị bỏ qua (không gắn câu hỏi của request này vào Worker khác).

**Khi nào hiện phần câu hỏi:** hàm thuần `showsQuestions(card, owner)`. Nó đúng khi:

- thẻ là `report`,
- chiều là `received`,
- chủ khung chat là `manager`,
- và có ít nhất một câu hỏi.

Mọi trường hợp khác giữ nguyên thẻ hôm nay (Q44).

**Bố cục** (thêm vào `plugin/client/chat-card.tsx`, dưới dòng tóm tắt):

- **Dòng tóm tắt** của báo cáo có câu hỏi là `<tier> · <n> questions waiting`, thay cho `waiting on: <blockers>`.
- **Dòng tóm tắt không quá 2 dòng** (Q50, batch `b4`), kể cả khi mở toàn văn: `numberOfLines={2}` luôn áp dụng, và `summaryOf` cắt phần `waiting on: …` ở 160 ký tự kèm `…`, nên đoạn `blockers` dài không bị lặp lại trên dòng tóm tắt. Báo cáo kiểu cũ không đổi gì khác (Q49).
- **Mỗi câu hỏi:**
  - dòng mã và chữ câu hỏi, chủ đề in đậm (phần trước ` — ` đầu tiên);
  - bên dưới là các lựa chọn xếp dọc, mỗi lựa chọn một nút `accessibilityRole="button"` có `accessibilityState.selected`: `○ a — <chữ>` / `● a — <chữ>`;
  - lựa chọn đề xuất có chip `recommended` (tone `success`);
  - cuối cùng là nút `Other…`; chọn nó thì mở một ô nhập cho câu đó.
- **Hàng nút:**
  - `Use recommendations` điền lựa chọn đề xuất cho mọi câu còn trống, không đè lựa chọn đã có, và không gửi;
  - `Send answers to <tên Worker>` chỉ bật khi `formComplete` đúng và không có lý do chặn;
  - `Clear` xoá mọi lựa chọn.
- **Dòng người nhận:** `Answers go to <partyName(Worker)> · <requestId>`, để người dùng thấy câu trả lời sẽ tới ai trước khi bấm.
- Nút "Reply to Worker" chữ tự do vẫn còn. Với báo cáo có câu hỏi, hai câu gợi ý "Continue as you proposed." và "Stop here…" **không** hiện, vì chúng mơ hồ khi có câu hỏi.

**Logic thuần** (`chat-cards.ts`, test được không cần renderer):

- `recommendedPicks(questions, picks)` điền lựa chọn đề xuất vào các câu còn trống.
- `formComplete(questions, picks)`: mọi câu có một lựa chọn là khoá có thật, hoặc `other` với chữ khác rỗng sau khi `trim`.
- `answerTarget(card, owner, peers)` trả `{ worker: ChatPeer }` hoặc `{ reason: string }`:
  - Worker là `partiesOf(card, owner, peers).from`, tức Worker duy nhất mang request của báo cáo (F3); trạng thái của nó đọc từ mục tương ứng trong `peers`;
  - không có id (0 hoặc nhiều Worker) → "Cannot tell which Worker asked this: no single Worker has `<requestId>`.";
  - trạng thái `running` / `initializing` → "<Worker> is working; a message now would replace its turn. Send when it stops.";
  - `closed` → "<Worker> is closed.";
  - `idle` và `error` → gửi được.
- `sendAnswers({ card, picks, refreshPeers, send })` là toàn bộ đường gửi, dưới dạng hàm `async` với hai phụ thuộc được truyền vào:
  - `refreshPeers(): Promise<{ owner, peers }>` — trong thẻ là `peers.refetch()`;
  - `send(agentId, text): Promise<void>` — trong thẻ là `paseo.agents.ref(agentId).send(text)`.

  Hàm trả `{ ok: true, to, text }` hoặc `{ ok: false, reason }`, và gọi `send` **nhiều nhất một lần**. Vì repo không có test dựng component React, đường gửi phải nằm ở đây để test được bằng hàm giả; `chat-card.tsx` chỉ nối nó vào nút.
- `answeredKey(agentId, card)` là khoá của bảng "đã gửi": id khung chat, `requestId`, các mã câu hỏi, và một mã băm ngắn (djb2) của nguyên văn tin.

**Gửi** (thứ tự bên trong `sendAnswers`):

1. `formComplete` sai → `{ ok: false }`, không gọi gì.
2. `refreshPeers()` để có trạng thái mới nhất. `answerTarget` trả `reason` → `{ ok: false, reason }`.
3. `send(worker.id, answersText(card.requestId, card.questions, picks))`. Không bao giờ dùng một id lấy từ nội dung tin.
4. Thành công → thẻ ghi vào bảng module `Map<answeredKey, { at, summary, to }>`, thay phần chọn bằng dòng `Answered at HH:MM → <Worker>: Q1 a, Q2 other`, và không hiện nút gửi cho bộ câu hỏi này nữa trong phiên app.
5. `refreshPeers` hay `send` ném lỗi → `{ ok: false, reason: errorMessageOf(failure) }`; thẻ hiện lý do và giữ nguyên các lựa chọn.

**Chữ khi mở rộng tin** (`markdownOf`): coi `BM-QUESTIONS` và `BM-ANSWERS` là khối như `BM-REPORT`. Dòng `Q<n>: …` thành mục in đậm như hôm nay; dòng lựa chọn thụt vào dưới câu của nó.

### 4.5 Chỉ dẫn Worker — `plugin/roles/worker.md`

Đổi mục **Asking** và một dòng của **Reporting**. Tối đa 5 câu, có lựa chọn, có đề xuất và "viết cả trong chat" vẫn giữ; ba thời điểm hỏi giữ nguyên.

- **"How to ask":**
  - đánh mã `Q1`, `Q2`, … và đếm tiếp trong cả request;
  - viết danh sách trong chat, **và** gửi `blocked` gồm `BM-REPORT` rồi khối `BM-QUESTIONS` chứa MỌI câu, trong cùng tin;
  - `blockers:` chỉ nói số câu và mã của chúng, trỏ tới khối;
  - ví dụ trong file đổi từ danh sách `1. … (a) …` sang khối §4.1, để một ví dụ duy nhất dạy cả mẫu lẫn chất lượng ("every option is named, each one says what it costs, one is recommended").
- **Câu trả lời:**
  - `BM-ANSWERS` là lời người dùng: `Q<n>: <chữ cái>` chọn lựa chọn đó, `other — …` là nguyên lời người dùng;
  - câu trả lời cho mã không còn mở → nói ra, không làm theo;
  - câu chưa có đáp án vẫn mở và được hỏi lại ở lần `blocked` sau, không bao giờ lấy mặc định.
- **Mẫu `BM-REPORT`:** dòng `blockers: <questions waiting for the user>` đổi thành `blockers: <what waits for the user; questions go in BM-QUESTIONS>`. Trường và thứ tự giữ nguyên.

Ngưỡng dòng của `worker.md` trong `test/roles-content.test.ts` là dưới 394, và file hiện có 383 dòng. Ví dụ mới ngắn hơn ví dụ cũ 2 dòng, nên bản sửa phải nằm trong ngưỡng. Không nâng ngưỡng.

### 4.6 Chỉ dẫn Manager — `plugin/roles/manager.md`

- **Luật 2 (RELAY):** vẫn "chỉ lời người dùng", thêm đúng một ngoại lệ có hình dạng cố định. Câu trả lời cho các câu hỏi của Worker đi dưới dạng `Continue <requestId>.` cộng khối `BM-ANSWERS`, với lời nào không phải một lựa chọn thì chép nguyên văn vào `other`. Không thêm yêu cầu, không tự chọn thay.

  Khối `## RULES` của `manager.md` đang đúng bằng trần 29 dòng của test "the RULES budget". Vì vậy luật 2 chỉ thêm một cụm trỏ sang mục `blocked` (nơi đặt định dạng), viết lại cho vừa số dòng hiện có. Trần đó **không** được nâng. Các từ mà test M2 kiểm (`verbatim`, `` `Continue <requestId>.` ``, `relay, not a decider`, `add no requirement`, "first prompt is the exception") phải còn nguyên.
- **Mục `blocked` của "Talking to the user":**
  1. Hiện MỌI câu hỏi, lấy từ khối `BM-QUESTIONS`, hoặc từ `blockers` khi báo cáo không có khối. Mỗi câu kèm lựa chọn và đề xuất.
  2. Nhóm theo Worker: liệt kê **mọi** Worker còn chờ, mỗi Worker một chữ cái A, B, … trong danh sách đó, kèm tên và `requestId`. Nhãn câu là chữ cái + số của câu (A6 = Q6 của Worker A). Với báo cáo kiểu cũ, số là số Worker tự đánh.
  3. Nói người dùng trả lời được trong thẻ của Worker, hoặc ngay trong chat theo dạng `A6 a, B1 b`.
  4. Đọc câu trả lời theo danh sách **gần nhất** đã hiện. Gửi cho mỗi Worker chỉ phần của nó (khối §4.2), và chỉ khi Worker đó không `running` (luật có sẵn ở bước 2).
  5. Câu trả lời không khớp đúng một câu đang chờ của đúng một Worker → hỏi lại người dùng, không gửi phần đó.
  6. Worker đã báo cáo lại sau `blocked` → câu hỏi của nó đã được trả lời (có thể trong thẻ): không chuyển thêm gì cho các câu đó.

**Ngưỡng dòng.** `manager.md` có 157 dòng, và ngưỡng test là dưới 160. Phần trên cần khoảng 8–12 dòng, kể cả khối ví dụ 4 dòng.

Quyết định theo đúng quy ước repo đã ghi trong chú thích của `test/roles-content.test.ts`. Quy ước đó: nâng ngưỡng là cách cuối cùng, không cắt biện pháp an toàn để vừa một con số (W4 của delta 20260917b), và lần nâng 158 → 160 của delta 20260917f để lại 2 dòng dư.

1. Viết gọn mục `blocked` và luật 2 trước.
2. File vẫn vượt 159 dòng → ngưỡng mới là **số dòng đo được + 3** (so sánh "nhỏ hơn", tức còn 2 dòng dư như lần trước). Ghi một đoạn chú thích trong test nêu delta này, số dòng đo được, và vì sao không cắt được thêm.
3. File vừa ngưỡng cũ → không đổi ngưỡng.

Ngưỡng của `worker.md` (394) và `reviewer.md` (164) không đổi. Owner xác nhận việc này cùng các điểm khác ở bước xác nhận trước khi implement; nếu owner không đồng ý thì phải bỏ bớt nội dung Manager và quay lại thiết kế trước khi làm WP-252.

### 4.7 Tương thích

Chỉ dẫn gắn lúc tạo agent (F6), nên sẽ có lúc Worker, Manager và plugin khác phiên bản nhau:

| Worker | Manager | Kết quả |
|---|---|---|
| mới | mới | Đầy đủ: thẻ có nút; Manager nhóm theo Worker; câu trả lời là `BM-ANSWERS` |
| cũ (tạo trước bản cập nhật) | mới | Không có khối, nên thẻ như hôm nay. Manager lấy câu hỏi từ `blockers`, vẫn nhóm theo Worker và gửi `BM-ANSWERS`. Worker cũ đọc được khối đó như văn bản `Q1: a — <lựa chọn>` |
| mới | cũ (Manager đang mở trước bản cập nhật) | Thẻ vẫn có nút, vì thẻ là mã plugin. Manager cũ được dặn "show every question in `blockers`", nhưng `blockers` giờ chỉ trỏ tới khối nằm ngay dưới trong cùng tin. **Rủi ro:** Manager cũ có thể chỉ nhắc lại dòng trỏ. Người dùng vẫn thấy câu hỏi trên thẻ. Muốn Manager nhóm theo Worker thì mở một Manager mới |
| bất kỳ | bất kỳ, plugin bản cũ | Khối mới hiện nguyên văn trong phần mở rộng; mọi thứ khác như hôm nay |

Bộ đọc `BM-REPORT`, bộ thu thập và kho vết đọc tin có thêm khối ra **đúng** kết quả như không có khối (F2, có test). REQ-050b của PRD Dashboard được giữ, vì khối cũ vẫn đọc được và không trường nào đổi.

## 5. Luồng

```
Worker A ──blocked: BM-REPORT + BM-QUESTIONS (Q6,Q7)──▶ Manager chat ──▶ thẻ A (nút)
Worker B ──blocked: BM-REPORT + BM-QUESTIONS (Q1)─────▶ Manager chat ──▶ thẻ B (nút)
Manager ──"A · Worker X · req-A: A6 …, A7 … / B · Worker Y · req-B: B1 …"──▶ người dùng

Đường 1 (thẻ):  người dùng chọn trong thẻ A ──refetch chat.peers──▶ A idle?
                  ├─ có   ──paseo.agents.ref(A).send(BM-ANSWERS Q6,Q7)──▶ Worker A
                  └─ không ──thẻ hiện lý do, không gửi
Đường 2 (chat): người dùng gõ "A6 a, A7 b, B1 c" ──▶ Manager
                  ├─ khớp  ──"Continue req-A." + BM-ANSWERS Q6,Q7──▶ Worker A (khi A không running)
                  │        ──"Continue req-B." + BM-ANSWERS Q1────▶ Worker B
                  └─ không khớp ──Manager hỏi lại người dùng
Worker nhận BM-ANSWERS: áp cho câu đang mở; mã không còn mở → nói ra, không làm theo;
                        câu còn thiếu → hỏi lại ở lần blocked sau
```

**Đường lỗi:**

- Không có Worker nào hoặc có nhiều Worker mang request đó → thẻ không gửi.
- Worker đang chạy → thẻ không gửi.
- `send` ném lỗi → thẻ hiện lỗi, giữ lựa chọn.
- Khối viết lệch tới mức không đọc được → thẻ như hôm nay; người dùng trả lời bằng chữ tự do hoặc qua Manager.

## 6. Chiến lược kiểm thử

| Cần chứng minh | Bằng chứng |
|---|---|
| Bộ đọc đọc đúng mẫu | `test/plugin-bm-questions.test.ts`: khối §4.1 → 2 câu, 3 và 2 lựa chọn, đề xuất đúng, `requestId` đúng; chữ hiển thị không còn `(recommended)` |
| Bộ đọc chịu được viết lệch | Cùng file, mỗi biến thể một ca: rào ```` ``` ````, `>`, `**Q1:**`, `- (a)`, `a)`, dòng tiếp nối, 2 đề xuất (→ không đề xuất), mã trùng, lựa chọn trùng, văn xuôi `a: …` không phải lựa chọn, khối kết thúc ở văn xuôi, không có khối (→ `null`), nhiều khối (→ khối cuối) |
| Bộ đọc bị chặn độ dài | Đầu vào 200 KB toàn dòng `Q1:` / `- a:` chạy dưới 100 ms, đọc tối đa 10 câu × 8 lựa chọn. Một `BM-REPORT` hợp lệ dài hơn 20 000 ký tự (danh sách file dài) đứng **trước** khối `BM-QUESTIONS` → khối vẫn được đọc đủ. Đầu vào 200 KB văn xuôi rồi mới tới khối ở cuối → khối được đọc, dưới 100 ms |
| Bộ soạn đúng dạng | `answersText` cho ra đúng khối §4.2, xuống dòng trong `other` thành dấu cách, ném lỗi khi thiếu câu. **Đối chứng âm:** bỏ ném lỗi thì ca "thiếu câu" phải đỏ |
| Bộ đọc báo cáo không đổi | `test/plugin-bm-report.test.ts`: `parseReports` trên tin `BM-REPORT` + `BM-QUESTIONS` bằng đúng kết quả trên tin chỉ có `BM-REPORT` (mọi trường, `unparsedFields` rỗng) |
| Thẻ lấy đúng câu hỏi | `test/plugin-chat-cards.test.ts`: báo cáo có khối → `questions` đủ; khối mang request khác → rỗng; báo cáo kiểu cũ → rỗng và tóm tắt như cũ |
| Thẻ chỉ hiện nút ở chat Manager | `showsQuestions`: đúng với `received` + chủ là Manager; sai với chat Worker, Reviewer, chat không phải paseo-bm, và thẻ `sent` |
| Thẻ chỉ gửi đúng Worker | `answerTarget`: không có hoặc có hai Worker mang request → chặn; `running` / `initializing` / `closed` → chặn; `idle` / `error` → cho gửi |
| Chọn đúng | `recommendedPicks` không đè lựa chọn có sẵn; `formComplete` sai khi thiếu câu hay `other` rỗng; hai cú bấm (đề xuất + gửi) đủ cho mọi câu có đề xuất |
| Gửi đúng người, đúng chữ | `sendAnswers` với `refreshPeers` và `send` giả: `send` được gọi **đúng một lần**, với id Worker từ lần `refreshPeers` và chữ bằng `answersText`. Worker chuyển sang `running` giữa lần hiện thẻ và lần bấm → không gọi `send`. `send` ném lỗi → `{ ok: false }` kèm lý do. Form thiếu câu → không gọi cả `refreshPeers`. **Đối chứng âm:** bỏ bước đọc lại trạng thái thì ca "`running` lúc bấm" phải đỏ |
| Chỉ dẫn Worker nói đúng | `test/roles-content.test.ts`: có `BM-QUESTIONS`, có `BM-ANSWERS`, "keep counting" trong request, mọi câu vào khối, ví dụ có `(recommended)` và không có "unless you say otherwise"; các luật cũ về số câu, lựa chọn, đề xuất vẫn được kiểm; `worker.md` dưới 394 dòng |
| Chỉ dẫn Manager nói đúng | Cùng file: nhóm theo Worker, nhãn chữ cái, dạng `A6 a`, gửi mỗi Worker chỉ phần của nó, hỏi lại khi không khớp, không tự chọn, lấy từ `blockers` khi không có khối; luật cũ "show EVERY question" vẫn đúng |
| Cả gói vẫn sạch | `npm run verify` mã 0 (typecheck, lint, test, build) |
| Chạy thật | Owner tự kiểm trên daemon thật (điều kiện ra của PRD delta §9). Worker không cài plugin lên daemon của owner |

## 7. Hoàn tác

Mỗi phần hoàn tác bằng cách revert tệp của chính nó; không có dữ liệu lưu bền nào đổi.

- **Thẻ:** revert `chat-cards.ts` và `chat-card.tsx` → thẻ như hôm nay; khối mới hiện nguyên văn.
- **Chỉ dẫn:** revert `worker.md` / `manager.md` rồi `npm run build`. Agent tạo sau đó dùng chỉ dẫn cũ. Agent đã tạo giữ chỉ dẫn mới tới khi người dùng mở agent mới; các bên vẫn hiểu nhau theo bảng §4.7.
- **Bộ đọc:** `bm-questions.ts` là file mới; xoá nó cùng với phần thẻ dùng nó.

## 8. Rủi ro và giới hạn

| Rủi ro | Xử lý |
|---|---|
| Mô hình viết lệch mẫu | Bộ đọc dễ dãi (§4.3); không đọc được thì thẻ lùi về chữ tự do |
| Người dùng trả lời một thẻ cũ sau khi tải lại app | Mã câu hỏi không lặp trong request (§4.1), nên Worker nhận ra câu trả lời cho câu không còn mở và không làm theo (REQ-059g) |
| Manager không biết người dùng đã trả lời trong thẻ (Q40) | Manager biết khi Worker báo cáo lại; chỉ dẫn Manager dặn không chuyển thêm gì cho các câu đó (§4.6 bước 6) |
| Manager và Worker cũ (F6) | Bảng §4.7 |
| Chữ cái của Manager khác nhau giữa hai danh sách | Manager đọc câu trả lời theo danh sách gần nhất và hỏi lại khi không khớp |
| Một Worker khác đang sửa cùng workspace (`req-20260918T011706Z`, chạm `contracts.ts` và Dashboard) | Delta này không sửa `contracts.ts`, Dashboard hay kho vết. Các file dùng chung (`roles/*.md`, `test/roles-content.test.ts`) chỉ sửa đúng đoạn của mình, không đụng thay đổi đang có |

## 9. Câu hỏi mở

Không còn câu nào chặn. Ngưỡng dòng của `manager.md` đã quyết theo quy ước repo (§4.6), và owner xác nhận cùng các điểm khác trước khi implement.

## 10. Revision History

| Ngày | Người | Thay đổi |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b4` (Q49–Q51): dòng tóm tắt không quá 2 dòng và phần `blockers` bị cắt ở 160 ký tự (§4.4) |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Đã cài đặt (WP-250 → WP-254). `manager.md` đo được 171 dòng sau khi viết gọn, ngưỡng test thành 174 theo §4.6 và Q46. Status giữ Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Errata lúc chuyển thành bead: ghi rõ ràng buộc đã có của test "the RULES budget" — khối `## RULES` của `manager.md` đang ở trần 29 dòng, nên ngoại lệ của luật 2 phải nằm trong số dòng hiện có. Không đổi phạm vi hay hành vi |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Theo review b1: bộ đọc tìm dòng mở `BM-QUESTIONS` cuối cùng trên toàn bộ tin rồi mới chặn 20 000 ký tự từ đó (khối nằm sau báo cáo dài không bị mất); ngưỡng dòng của `manager.md` quyết theo quy ước repo (§4.6). Sau `reviewing-plan`: đường gửi thành hàm thuần `sendAnswers`, `answerTarget` đọc trạng thái từ `chat.peers` |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Tạo delta: hai khối `BM-QUESTIONS` / `BM-ANSWERS`, bộ đọc riêng, thẻ câu hỏi trong chat Manager, sửa chỉ dẫn Worker và Manager, bảng tương thích |
