# Delta-change — Manager không nhắc lại thẻ, câu trả lời đi qua ô Reply, thẻ câu hỏi dễ đọc

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260918d-card-replies` |
| Tài liệu gốc | [design-delta-20260918c-question-cards](./paseo-bm-delta-20260918c-question-cards.md) §4.2 (khối `BM-ANSWERS`), §4.4 (thẻ câu hỏi), §4.6 (chỉ dẫn Manager); [delta 20260916-chat-cards](./paseo-bm-delta-20260916-chat-cards.md) §4 (nút Reply) — **không sửa tại chỗ** |
| PRD | [prd-delta-20260918d-card-replies](../product/paseo-bm-prd-delta-20260918d-card-replies.md) — REQ-059 (b)–(f) sửa; quyết định Q1–Q5; Routing Decision ở §0 của tài liệu đó |
| Plan | [plan-delta-20260918d-card-replies](../plans/paseo-bm-implementation-plan-delta-20260918d-card-replies.md) |
| Status | Merged — gộp vào [paseo-bm-dashboard.md](../../design/paseo-bm-dashboard.md) ngày 2026-09-25; chỉ còn là hồ sơ lịch sử |
| Owner | hieu.nt10 |
| ADR | N/A — không thêm công nghệ, không đảo quyết định nào của ADR-001…007 |
| Request | `req-20260918T041426Z`; §4.10: `req-20260918T074311Z` |

**Thiết kế này sở hữu:**

- đường gửi của nút Reply trên mọi thẻ chat;
- cách thẻ câu hỏi ghi lựa chọn vào ô Reply, và bố cục của phần câu hỏi;
- mục "Talking to the user" của `manager.md`.

**Không sở hữu:**

- định dạng `BM-QUESTIONS` / `BM-ANSWERS`, bộ đọc và bộ soạn của chúng (`plugin/shared/bm-questions.ts`) — dùng lại, không đổi;
- `worker.md`, `reviewer.md`, `chat.peers`, kho vết, Dashboard;
- cơ chế chat và trạng thái agent của Paseo.

## 1. Ba kết quả

1. **Manager nói điều thẻ không có, không nhắc lại thẻ** (Q1).
2. **Lựa chọn nằm ngay trong ô Reply, và một nút Send gửi đúng người, không bao giờ vào một lượt đang chạy** (Q4).
3. **Câu hỏi và lựa chọn đọc dễ, chọn dễ** (Q5).

## 2. Nền tảng — đã kiểm chứng những gì

Đọc mã của repo và trạng thái agent trên daemon của owner (chỉ đọc), ngày 2026-09-18.

| # | Câu hỏi | Kết quả | Hệ quả |
|---|---|---|---|
| F1 | Vì sao lựa chọn không tới Worker? | `chat-card.tsx` có hai đường gửi độc lập: `QuestionForm` gửi `answersText(...)` qua nút "Send answers to <Worker>"; ô Reply gửi `replyText(card, answer)` (`chat-cards.ts:335`), chỉ gồm chữ người dùng gõ. Tin Worker `req-20260918T041426Z` nhận được là `Reply from the user about \`req-20260918T041426Z\`:\n\nOK` | Gộp về **một** đường: lựa chọn được viết vào chính ô Reply (§4.1), ô Reply là đường gửi duy nhất (§4.2) |
| F2 | Ô Reply có kiểm trạng thái người nhận không? | Không: nó gọi `paseo.agents.ref(counterpart.id).send(...)` với id từ `chat.peers` đã lưu, không đọc lại và không xem `status`. Chỉ `sendAnswers` có bước đó | Bước đọc lại và kiểm trạng thái chuyển vào đường gửi chung, áp cho mọi thẻ (§4.2) |
| F3 | Manager lặp lại thẻ thế nào? | `get_agent_activity` của Manager `557cc8e4` sau báo cáo `blocked` của `req-20260918T035101Z`: Manager in lại cả Q1–Q2 với mọi lựa chọn, **hai lần**, ngay dưới thẻ. Manager đó chạy chỉ dẫn trước delta 20260918c ("show EVERY question in `blockers`"); bản hiện tại vẫn dặn "show the user EVERY question … with its options" | Đổi mục "Talking to the user" của `manager.md` (§4.5) |
| F4 | Ngân sách dòng của `manager.md` | 171 dòng; test đòi dưới 174. Khối `## RULES` đúng trần 29 dòng | Chỉ sửa mục "Talking to the user"; RULES không đổi; ngưỡng không nâng (§4.5) |
| F5 | Test được phần nào? | Repo không dựng component React trong test (plan-delta 20260918c §5); file trong `test/` không import `react-native` như một giá trị (AGENTS.md) | Mọi logic nằm ở hàm thuần trong `chat-cards.ts`; `chat-card.tsx` chỉ nối và vẽ |
| F6 | Chỉ dẫn tới agent lúc nào? | Hook `before("agent.create")` gắn chỉ dẫn lúc tạo agent (thiết kế 20260918c F6) | Chỉ Manager tạo sau khi nạp lại plugin mới dùng chỉ dẫn mới (§4.6) |
| F7 | `answersText` có soạn được khối thiếu câu không? | Có, nếu chỉ truyền các câu đã trả lời: hàm duyệt đúng danh sách `questions` được truyền, và chỉ ném lỗi khi một câu **trong danh sách đó** thiếu đáp án (`bm-questions.ts:197`) | Không sửa `bm-questions.ts`; thẻ lọc câu đã trả lời rồi gọi `answersText` (§4.1) |

## 3. Không đổi

- Định dạng khối `BM-QUESTIONS` và `BM-ANSWERS`, `parseQuestions`, `answersText`, mọi giới hạn độ dài của bộ đọc.
- `toChatCard`, `chatCardSchema` (`kind` `bm-message`, `version` 1), `summaryOf`, `quickReplies`, `markdownOf`, `showsQuestions`, `partiesOf`.
- `replyText`: dòng đầu `Reply from the user about <requestId>[, batch <id>]:` như hôm nay.
- `worker.md`, `reviewer.md`, `chat.peers`, `contracts.ts`, kho vết, Dashboard.
- Đường trả lời trong chat Manager (`A6 a, B1 b` → `Continue <requestId>.` + `BM-ANSWERS`).
- Khối `## RULES` của `manager.md`.

## 4. Thiết kế

### 4.1 Lựa chọn viết vào ô Reply — hàm thuần trong `plugin/client/chat-cards.ts`

```ts
/** A pick that answers its question: an existing option of a question with ≥ 2 options, or non-blank own words. */
export function isAnswered(question: Question, pick: Pick | undefined): boolean;

/** `BM-ANSWERS` for the answered questions only, in question order; "" when none is answered or the card names no request. */
export function answersDraft(card: ChatCard, picks: Readonly<Picks>): string;

/** `text` with its `BM-ANSWERS` block replaced by `block` (removed when `block` is ""); everything else kept. */
export function withAnswersBlock(text: string, block: string): string;
```

**`answersDraft`** gọi `answersText(card.requestId, answered, picks)`, với `answered` là các câu mà `isAnswered` đúng (F7). Câu chưa trả lời, câu chọn "Other" để trống, hay câu có khoá không tồn tại đều **không** có dòng.

**`withAnswersBlock(text, block)`** — vùng khối trong ô là:

- dòng đầu tiên mà sau khi `trim` bằng đúng `BM-ANSWERS`;
- cộng mọi dòng liền sau khớp `^\s*(requestId|Q\d+)\s*:`.

Cách làm, theo đúng thứ tự:

1. **Tách chữ của người dùng.** `rest` = các dòng của ô trừ vùng khối (nếu có), bỏ luôn các dòng trống **ngay sau** vùng, rồi bỏ các dòng trống ở đầu và cuối `rest`. Chữ đứng trước vùng và chữ đứng sau vùng đều nằm trong `rest`, giữ nguyên thứ tự và nội dung.
2. **Ghép lại, khối luôn ở đầu ô** (Q4):

| `block` | `rest` rỗng | `rest` có chữ |
|---|---|---|
| khác rỗng | `block` | `block` + một dòng trống + `rest` |
| rỗng | `""` | `rest` |

Hệ quả, ghi thành hành vi (REQ-059c):

- sau mỗi lần chọn, khối luôn là phần **đầu** ô; chữ người dùng gõ phía trên khối được đưa xuống dưới khối;
- khối luôn phản ánh các lựa chọn hiện tại; sửa tay bên trong khối bị viết đè ở lần chọn sau;
- người dùng xoá dòng `BM-ANSWERS` → lần chọn sau viết một khối mới lên đầu ô; các dòng `Q…` sót lại là chữ của người dùng.

**`answerSummary(questions, picks)`** chỉ liệt kê câu đã trả lời (`Q6 a, Q7 other`); hôm nay nó còn đếm cả "Other" để trống.

**`sentSummary(card, picks, text)`** trả `answerSummary(...)` khi `answersDraft(card, picks)` khác rỗng **và** nằm nguyên trong `text`; ngược lại trả `null`. Thẻ dùng nó để biết một lần gửi có mang câu trả lời hay không (§4.3).

### 4.2 Một đường gửi cho mọi Reply

```ts
export type ReplyTarget = { peer: ChatPeer } | { reason: string };
export function replyTarget(card: ChatCard, owner: ChatPeer | null, peers: readonly ChatPeer[]): ReplyTarget;

export interface SendReplyInput {
  card: ChatCard;
  /** What is in the Reply box. */
  text: string;
  refreshPeers: () => Promise<{ owner: ChatPeer | null; peers: ChatPeer[] }>;
  send: (agentId: string, text: string) => Promise<void>;
}
export type SendReplyResult = { ok: true; to: ChatPeer; text: string } | { ok: false; reason: string };
export async function sendReply(input: SendReplyInput): Promise<SendReplyResult>;
```

**`replyTarget`** tìm người nhận giống hệt nút Reply hôm nay, rồi thêm bước kiểm trạng thái mà ô Reply đang thiếu (F2):

1. Người nhận là `partiesOf(card, owner, peers)`: `from` khi thẻ `received`, `to` khi thẻ `sent`. Người nhận phải có id và có mặt trong `peers`, vì trạng thái đọc từ đó.
2. Không tìm được người nhận:
   - thẻ báo cáo `received` → giữ đúng câu hôm nay: "Cannot tell which Worker asked this: no single Worker has `<requestId>`.";
   - thẻ khác → "Cannot tell which <Role> to send this to.".
3. Người nhận là chính khung chat → "This is your own message."
4. Trạng thái:
   - `idle` hoặc `error` → `{ peer }`;
   - `running` hoặc `initializing` → "<tên> is working; a message now would replace its turn. Send when it stops.";
   - còn lại → "<tên> is <status>.".

   `<tên>` là `partyName` của người nhận.

**`sendReply`** — thứ tự:

1. `text.trim()` rỗng → `{ ok: false, reason: "Write a reply first." }`; không gọi gì.
2. `refreshPeers()`; `replyTarget` trả `reason` → `{ ok: false, reason }`.
3. `send(peer.id, replyText(card, text))`, **đúng một lần**. Không bao giờ dùng một id lấy từ nội dung tin.
4. Thành công → `{ ok: true, to: peer, text: <chữ đã gửi> }`.
5. `refreshPeers` hay `send` ném lỗi → `{ ok: false, reason: errorMessageOf(failure) }`.

**Bỏ đi:** `formComplete`, `answerTarget`, `sendAnswers`. Mỗi ca test của chúng được chuyển sang hàm mới với kỳ vọng ít nhất chặt bằng (§6). Riêng ca "chỉ gửi khi đủ đáp án" đổi theo quyết định Q4 của owner: nay gửi được khi ô có chữ, và câu chưa trả lời không có dòng trong khối.

### 4.3 Nối vào thẻ — `plugin/client/chat-card.tsx`

- **`picks` lên `ChatCardView`.** Đang nằm trong `QuestionForm`; chuyển lên cùng chỗ với `answer` (chữ trong ô) để một lần chọn sửa được cả hai. `QuestionForm` chỉ còn vẽ và báo lần chọn.
- **Mỗi lần `picks` đổi** (chọn lựa chọn, gõ "Other", "Use recommendations", "Clear"):
  - `setPicks(next)`;
  - `setAnswer(withAnswersBlock(answer, answersDraft(card, next)))`;
  - `setReplying(true)`.
- **Nút Send** của ô Reply:
  - bật khi không đang gửi và `answer.trim()` khác rỗng;
  - gọi `sendReply({ card, text: answer, refreshPeers, send })`, với `refreshPeers` = `peers.refetch({ throwOnError: true })` và `send` = `paseo.agents.ref(id).send(text)`.
- **Gửi xong:**
  - hiện `Sent to <tên>.`, xoá ô, đóng ô;
  - nếu `sentSummary(card, picks, answer)` khác `null` → ghi vào bảng module "đã trả lời" (khoá `answeredKey`, như hôm nay). Phần câu hỏi được thay bằng dòng `Answered at HH:MM → <Worker>: Q6 a, Q7 other`.
- **Gửi lỗi:** hiện lý do; giữ ô và các lựa chọn.
- **Không còn** nút "Send answers to <Worker>".
- **Dòng người nhận** `Answers go to <Worker> · <requestId>` giữ nguyên, đặt dưới danh sách câu hỏi (owner đã chốt ở Q47 của delta 20260918c).
- **Không xác định được người nhận** (`canReply` sai, ví dụ hai Worker cùng request): các câu hỏi vẫn hiện để đọc, nhưng các nút lựa chọn bị tắt, kèm một dòng lý do lấy từ `replyTarget` trên `chat.peers` đang lưu.
- **Hai câu gợi ý nhanh** vẫn chỉ hiện ở báo cáo `blocked` không có câu hỏi (không đổi).

### 4.4 Bố cục phần câu hỏi (Q5)

Hàm thuần mới:

```ts
/** `{ heading: "Q6 · Storage", body: "where does the list live?" }`; without a topic, `{ heading: "Q6", body: <text> }`. */
export function questionHeading(question: Question): { heading: string; body: string };
```

Hàm dựa trên `topicOf` (giữ nguyên).

Vẽ mỗi câu:

| Phần | Kiểu |
|---|---|
| Khối câu | `View`, `gap: 6`, `paddingVertical: 8`. Từ câu thứ hai trở đi có `borderTopWidth: 1`, màu `theme.colors.border`, làm vạch ngăn |
| Tiêu đề | `styles.body`, `fontWeight: "600"`: `heading` |
| Câu hỏi | `styles.body` (không monospace): `body` |
| Danh sách lựa chọn | `View`, `gap: 8` |
| Một lựa chọn | `Pressable`, rộng hết thẻ (`alignSelf: "stretch"`), `flexDirection: "row"`, `alignItems: "flex-start"`, `gap: 8`, `paddingVertical: 8`, `paddingHorizontal: 10`, `borderRadius: 8`, `borderWidth: 1`. Khi đã chọn: viền `toneColor(theme, "info")`, nền `theme.colors.surface2`. Có `accessibilityRole="button"` và `accessibilityState.selected` |
| Trong hàng | `Text` dấu `○`/`●` (rộng cố định 14), `Text` khoá in đậm (rộng cố định 16), `Text` nội dung `flex: 1` (xuống dòng thẳng hàng với dòng đầu), rồi chip `recommended` (tone `success`) ở cuối hàng khi lựa chọn được đề xuất |
| "Other…" | hàng cuối của cùng danh sách, cùng kiểu hàng, không có khoá. Khi chọn, ô nhập của câu đó mở ngay dưới hàng |
| Dưới mọi câu | hàng nút `Use recommendations`, `Clear`, rồi dòng người nhận |

Câu có ít hơn 2 lựa chọn: chỉ có hàng "Other…" (như hôm nay).

### 4.5 Chỉ dẫn Manager — `plugin/roles/manager.md`, mục "Talking to the user"

Trong đoạn mở đầu của mục, câu "Each carries the request id, the phase, the tier, …" được thay bằng:

> Each reaches the user as a card — phase, tier, beads, the full report one tap away, and a `BM-QUESTIONS` block as option buttons. Never repeat what the card shows; say in one or two lines only what it does not.

Sửa bốn mục:

- **`received`:** vẫn một dòng (luật test "received is acknowledged in one line" giữ nguyên), chỉ nói điều thẻ không có (ví dụ tier khác với lần Manager đoán).
- **`beads-done`:** bỏ "what documents and beads now exist". Giữ câu cho request Large ("say the Worker is waiting for the user's confirmation; never say it started implementing before the user answered").
- **`blocked`:**
  - mỗi Worker còn chờ một dòng dưới một chữ cái, gồm tên, `requestId` và mã câu **như Worker viết**: `A · <name> · <requestId>: Q6, Q7` — đúng dòng owner chốt ở Q1;
  - nói người dùng trả lời trong thẻ hoặc gõ `A6 a, B1 b` ở đây (A6 = Q6 của Worker A; nhãn chữ cái + số chỉ dùng cho câu trả lời trong chat);
  - câu hỏi và lựa chọn của khối `BM-QUESTIONS` đã có trên thẻ: **không bao giờ nhắc lại**;
  - báo cáo **không** có khối (kiểu cũ, thẻ không có nút): hiện đủ câu hỏi lấy từ `blockers`, kèm lựa chọn và đề xuất; báo cáo cũ giữ số của Worker;
  - phần đọc câu trả lời, gửi `BM-ANSWERS`, hỏi lại khi không khớp, không tự chọn, Worker đã báo lại thì không chuyển nữa: giữ nguyên từng chữ, kể cả khối ví dụ.
- **`finished`:** bỏ "in a few lines, what changed, the beads, and the check result" (thẻ đã có). Nói có bao nhiêu mục `Suggestion (not done)` và hỏi người dùng muốn mục nào thành việc mới. Câu về skill còn thiếu, "Do not cancel", "Leave the Worker idle": giữ nguyên.

Dòng "How you talk": ngoại lệ "which you show in full" đổi từ "the question list of a `blocked` report" thành "the questions of a report with no buttons" — tức báo cáo không có khối `BM-QUESTIONS`, như mục `blocked` định nghĩa ("A report without that block has no buttons"). Cách viết này giữ đoạn ở 4 dòng.

**Ngưỡng dòng.** Ngưỡng 174 và trần RULES 29 **không nâng**. Câu về thẻ được gộp vào đoạn mở đầu của mục, thay cho câu "Each carries the request id, the phase, …", nên không thêm đoạn mới. Phần bỏ ở `beads-done` và `finished` bù cho phần thêm ở `blocked`. Một bản nháp viết trong thư mục tạm lúc thiết kế đo được **173** theo cách test đo (`text.split("\n").length`, bản hiện tại là 172), vừa ngưỡng. Nếu bản thật vẫn vượt, Worker dừng và hỏi owner; không cắt biện pháp an toàn nào để vừa ngưỡng.

**Luật test đổi** (`test/roles-content.test.ts`), mỗi luật thay bằng luật ít nhất chặt bằng:

| Luật cũ | Luật mới |
|---|---|
| "every blocked question reaches the user" — `show the user EVERY question — from the report's BM-QUESTIONS block, else from blockers` | (1) câu hỏi của khối không được nhắc lại: `never repeat them`, nằm cùng câu với `BM-QUESTIONS`; (2) báo cáo không có khối được hiện đủ: `without … BM-QUESTIONS … show its questions from \`blockers\` in full` |
| "every waiting Worker gets a letter, with its name and request" | `every Worker still waiting under a letter (A, B, …)`, và dòng mẫu `A · <name> · <requestId>: Q6, Q7` xuất hiện nguyên văn; luật "A6 = Worker A's Q6" và `A6 a, B1 b` giữ nguyên |
| "suggestions become questions for the user" — `Suggestion (not done) items as questions` | `how many \`Suggestion (not done)\` items` + hỏi người dùng mục nào thành việc mới (`the user decides`) |
| "a blocked question list is shown in full" — `which you show in full` | giữ nguyên regex; đổi tên ca thành "an old-style blocked list is shown in full" |
| (mới) | `Never repeat what the card shows` |

Các luật khác của mục này giữ nguyên, không sửa kỳ vọng.

### 4.6 Tương thích

| Manager | Plugin | Kết quả |
|---|---|---|
| mới (tạo sau khi nạp lại) | mới | Đầy đủ: Manager trả lời ngắn; lựa chọn đi qua ô Reply; mọi Reply kiểm trạng thái |
| cũ (đang mở) | mới | Thẻ mới hoạt động; Manager vẫn in lại câu hỏi như trước, cho tới khi owner mở một Manager mới |
| bất kỳ | cũ | Như hôm nay |

**Worker nhận gì.** Tin từ thẻ có dạng `Reply from the user about \`<req>\`:`, một dòng trống, khối `BM-ANSWERS`, rồi lời người dùng nếu có. `worker.md` đã dạy:

- khối là câu trả lời;
- câu không còn mở thì nói ra, không làm theo;
- câu thiếu đáp án thì hỏi lại;
- mọi chữ khác của người dùng là lời chỉ dẫn (mục Stop: "an instruction from the user … an answer").

Vì vậy Worker cũ lẫn Worker mới đều đọc đúng, và `worker.md` không đổi.

### 4.7 Batch `b4` — trình bày thẻ và chip "Answered" (PRD delta §1.3, REQ-059 i)

Chỉ `plugin/client/chat-card.tsx` và các hàm thuần mới trong `plugin/client/chat-cards.ts`. Không sửa `bead-chips.tsx`, `ui.tsx` hay `index.client.tsx`: các file đó đang có thay đổi chưa commit của Worker `req-20260918T043115Z`.

**Hàng tiêu đề** (Q11, ý 5):

- khung thẻ bỏ `borderLeftWidth` / `borderLeftColor`;
- bên trái là một cột:
  - dòng 1: `RoleMark` (giữ màu vai trò), tên người gửi với `styles.sectionTitle` và màu `theme.colors.foreground`, rồi `→ <người nhận>`;
  - dòng 2: giờ gửi `HH:MM`, `styles.body`;
- bên phải là một cột căn phải: chip trạng thái, và ngay dưới nó chip "Answered" khi có.

**Bead liên quan** (ý 3), hàm thuần:

```ts
export const BEAD_CHIPS_SHOWN = 2;
/** The bead ids a card shows, and how many are folded behind the "…" chip. */
export function visibleBeads(ids: readonly string[], expanded: boolean): { shown: string[]; hidden: number };
```

- `expanded` sai và có hơn 2 id → `shown` là 2 id đầu, `hidden` = số còn lại;
- còn lại → `shown` là toàn bộ, `hidden` = 0.

Thẻ vẽ `BeadChips` với `shown`. Khi `hidden > 0`, dòng dưới là một `Chip` "…" (tone `muted`, có `accessibilityLabel` "Show all N beads"); bấm vào thì mở rộng. Khi đã mở rộng thì không có nút thu gọn.

**Chip "Answered"** (Q14), hàm thuần:

```ts
/** What the card offers for replying: the Reply button, or the "Answered" chip once a reply went out. */
export function replyControls(canReply: boolean, replied: boolean): { replyButton: boolean; answeredChip: boolean };
```

| `canReply` | `replied` | Nút "Reply to …" | Chip "Answered" |
|---|---|---|---|
| đúng | sai | có | không |
| đúng | đúng | không | có (bấm vào mở lại ô Reply) |
| sai | bất kỳ | không | không |

- "Đã phản hồi" = một `sendReply` thành công từ chính thẻ này, có hay không có khối `BM-ANSWERS`.
- Ghi vào bảng module `replied: Map<answeredKey, Date>`, sống hết phiên app như bảng "đã trả lời" (REQ-059d). Tải lại app thì nút hiện lại.
- Bấm chip → `setReplying(true)`. Ô Reply, nút Send và Cancel như cũ. Gửi thêm lần nữa thì chip vẫn còn.

### 4.8 Batch `b5` — chip câu đang chờ (PRD delta §1.4, REQ-059 j)

**Nền tảng đã kiểm** (`@getpaseo/plugin` 0.8.0):

- `PluginClientContext.addComposerPill({ id, workspaceId, agentId, button })` trả về một `PluginButtonRegistration` có `update(patch)` và `remove()`. `button.behavior` có thể là `{ kind: "popover", Content }`; `Content` nhận props của host (`theme`, `layout`), ngữ cảnh (`workspaceId`, `agentId`) và `close()`.
- `PluginClientContext` có `paseo` và `rpc(...)` lúc đăng ký, nên việc đọc lại định kỳ chạy được ở đó.
- Không có API cuộn khung chat hay làm nổi một mục của timeline.
- Server đã đọc được timeline của một agent bằng `readTimelinePages` (`plugin/server/live-timeline.ts`, dùng cho panel "Beads in this chat").

**Hợp đồng mới** — `plugin/shared/contracts.ts`:

```ts
export const chatWaitingRpc = defineRpc({
  name: "chat.waiting",
  input: z.object({}),
  output: z.object({
    waiting: z.array(z.object({
      managerId: agentIdSchema,
      workspaceId: workspaceIdSchema,
      workerId: agentIdSchema,
      workerTitle: z.string().nullable(),
      requestId: z.string(),
      /** The report message as the Manager received it: the client builds the same card from it. */
      text: z.string(),
      at: z.string().nullable(),
    })),
  }),
});
```

Chỉ đọc. Tên và hình dạng mới hoàn toàn, không đổi RPC nào đang có.

**Server** — `plugin/server/chat-waiting.ts` (file mới), đăng ký trong `registerChatRpcs`:

- `waitingOf(entries, workers)` là hàm thuần, test được không cần daemon *(errata 2026-09-18: chữ ký thật là `waitingOf(manager, entries, workers)`; từ delta 20260918f, Worker được chọn bằng `soleWorkerOf`, không tính agent đã lưu trữ)*:
  - `entries`: các mục timeline của **một** Manager, mới nhất trước;
  - lấy mọi `user_message` **không** có `clientMessageId` (tin một agent gửi, không phải người dùng gõ);
  - với mỗi tin, `parseReports(text)`; báo cáo cuối có `requestId` dạng `req-…` là báo cáo của tin đó;
  - giữ báo cáo **mới nhất** cho mỗi `requestId`;
  - chỉ giữ báo cáo có `phase: blocked` mà `parseQuestions(text)` đọc được ít nhất một câu, và `requestId` của khối để trống hoặc bằng `requestId` của báo cáo;
  - Worker là agent `worker` **duy nhất** mang `requestId` đó trong cùng workspace; không có hoặc có nhiều → bỏ qua;
  - chỉ giữ Worker ở trạng thái `idle` hoặc `error`.
- `handleChatWaiting(paseo)`:
  - `bmAgentsOf(paseo)` lấy Manager, Worker và `requestId` của Worker, như `chat.peers`;
  - với mỗi Manager chưa lưu trữ và chưa đóng: `readTimelinePages(paseo, managerId, { pages: 1, limit: 200 })`, rồi gọi `waitingOf`;
  - lỗi đọc của một Manager chỉ làm mất Manager đó, không làm hỏng cả câu trả lời.

**Client** — `plugin/client/waiting-pills.tsx` (file mới):

- `planPills(current, waiting)` là hàm thuần *(errata 2026-09-18: nằm ở `waiting-pills-model.ts`; từ delta 20260918f, khoá pill có thêm `requestId` và băm nội dung)*:
  - `current`: `Map<pillId, key>`;
  - pill id `bm-waiting-<workerId>`; `key` = `managerId|workspaceId|label|at` (đổi thì cập nhật);
  - trả `{ add, update, remove }`.
- Nhãn pill: `<tên Worker> · <n> question(s)`, dùng tên như thẻ (`partyName`). Tiêu đề (tooltip): `Questions from <Worker> about <requestId>`. Icon: `MessageCircleQuestion`.
- `registerWaitingPills(client)`:
  - đọc `client.rpc(chatWaitingRpc, {})` ngay rồi mỗi `WAITING_POLL_MS` = 15 000 ms, không chồng lượt (lượt trước chưa xong thì bỏ qua);
  - áp `planPills`: `addComposerPill` cho `add`, `update` cho `update`, `remove()` cho `remove`;
  - RPC lỗi → giữ nguyên các pill đang có; không báo lỗi lên màn hình;
  - trả về hàm dọn: dừng hẹn giờ, gỡ mọi pill.
- `Content` của popover: dựng `card = toChatCard({ type: "user_message", text }, "complete")` rồi vẽ `ChatCardView` với `agentId` = Manager, `item` = `{ type: "plugin", kind: CHAT_CARD_KIND, version: CHAT_CARD_VERSION, data: card }` và `timestamp` = `at` (hoặc lúc mở). Vì vậy popover có đúng câu hỏi, ô Reply, đường gửi, kiểm tra trạng thái và chip "Answered" của thẻ; hai nơi dùng chung các bảng "đã trả lời" trong phiên app.

**`plugin/index.client.tsx`**: thêm một dòng import và đưa `registerWaitingPills(client)` vào danh sách hàm dọn. File này đang có thay đổi chưa commit của Worker `req-20260918T043115Z`; owner chấp nhận sửa chồng (Q15 b), chỉ thêm hai dòng đó.

**Kiểm thử:**

- `waitingOf`:
  - báo cáo `blocked` có câu hỏi và Worker `idle` → có;
  - Worker `running` / `initializing` / `closed` → không;
  - báo cáo mới hơn của cùng request (`received`, `finished`) → không;
  - không có khối câu hỏi → không;
  - tin người dùng gõ (có `clientMessageId`) → bỏ qua;
  - hai Worker cùng request → không;
  - khối mang request khác → không.
- `handleChatWaiting` với `paseo` giả: nhiều Manager, một Manager đọc lỗi.
- `planPills`: thêm, cập nhật, gỡ, không đổi gì.
- Danh sách RPC trong `test/plugin-bundle-cjs.test.ts` và `test/rpc-list-describe.test.ts` thêm `chat.waiting`.
- Phần pill và popover chỉ kiểm được bằng `typecheck:plugin` và owner nhìn trên daemon thật.

**Rủi ro:**

| Rủi ro | Xử lý |
|---|---|
| Popover của composer pill chưa từng được dùng trong repo; chưa chắc host bọc popover bằng cùng provider (`usePaseo`, `useRpc`, React Query) như timeline | Owner kiểm trên daemon. Nếu popover không vẽ được thẻ, pill vẫn cho biết Worker nào đang chờ, và thẻ trong chat vẫn trả lời được |
| Đọc timeline của mọi Manager mỗi 15 giây | Một trang 200 mục cho mỗi Manager, chỉ khi app mở; không có Manager thì không đọc gì |
| Sửa chồng lên `index.client.tsx` đang dở của Worker khác | Owner chấp nhận (Q15 b); chỉ thêm hai dòng, không đụng phần của Worker kia |

### 4.9 Batch `b6` — trạng thái "đã trả lời" đồng bộ và "Mark as answered" (PRD delta §1.5, REQ-059 k)

**Nguyên nhân (ý 1):** `ChatCardView` đọc hai bảng module `answered` và `replied` một lần, lúc khởi tạo `useState`. Bản trong popover ghi vào bảng; bản trong chat không bao giờ đọc lại.

**Đồng bộ trong phiên app** — `plugin/client/answer-state.ts` (file mới, không React):

- giữ hai bảng `answered` (khoá `answeredKey` → `{ at, summary, to }`) và `replied` (khoá → `Date`), kèm `subscribe(listener)`;
- `setAnswered` / `setReplied` gọi mọi listener;
- `chat-card.tsx` đọc qua `useSyncExternalStore`, nên mọi bản của cùng một thẻ vẽ lại cùng lúc.

**Dấu "Mark as answered" lưu bền (Q16)** — `plugin/server/answer-marks.ts` (file mới, theo khuôn `launcher-order.ts`):

- file `<install home>/ui/answer-marks.json`: `{ schemaVersion: 1, marks: [{ key, at }] }`;
- đọc không bao giờ sửa file: file hỏng hay đời mới hơn thì đọc như rỗng và báo trong `notices`; đời mới hơn thì từ chối ghi;
- bảo vệ đường dẫn bằng `assertNoSymlinkOnPath`, ghi bằng `writeStoreFileAtomically`, như `launcher-order`;
- khoá phải là chuỗi 1–400 ký tự, không có ký tự điều khiển; giữ tối đa 500 dấu mới nhất;
- `answers.marks` (`{}` → `{ keys, notices }`) và `answers.mark` (`{ key, marked }` → `{ keys, notices }`) trong `plugin/shared/contracts.ts`, đăng ký cạnh `launcher.order.*`.

**Thẻ tự biết đã trả lời (Q17)**, hàm thuần trong `plugin/client/chat-cards.ts`:

```ts
/** The report of `card` is still one `chat.waiting` lists for this Manager's chat. */
export function stillWaiting(card: ChatCard, chatAgentId: string, waiting: readonly WaitingWorker[]): boolean;

export type AnsweredHow = "sent" | "marked" | "moved-on";
/** Why a question card counts as answered, or null. `waiting` is null while it is unknown. */
export function answeredHow(input: { sent: boolean; marked: boolean; waiting: readonly WaitingWorker[] | null; stillWaitingNow: boolean }): AnsweredHow | null;
```

- `stillWaiting`: có một mục cùng `managerId` = khung chat, cùng `requestId`, và cùng nguyên văn tin;
- `answeredHow`: `sent` → `"sent"`; không thì `marked` → `"marked"`; không thì `waiting` đã biết và thẻ không còn chờ → `"moved-on"`; còn lại `null`;
- `waiting` chưa đọc được → không suy ra gì.

**Nối vào `ChatCardView`** (chỉ với thẻ mà `showsQuestions` đúng):

- `useQuery(["paseo-bm", "chat-waiting"], chat.waiting, refetchInterval 15 000 ms)` và `useQuery(["paseo-bm", "answer-marks"], answers.marks)`. Các thẻ dùng chung bộ nhớ đệm, nên chỉ có một lần đọc cho mọi thẻ;
- đã trả lời → thay phần chọn bằng một dòng:
  - `"sent"`: `Answered at HH:MM → <Worker>: Q6 a` (như hôm nay);
  - `"marked"`: `Marked as answered.`;
  - `"moved-on"`: `No longer waiting: <Worker> is working or has reported since.`;
- chip "Answered" hiện (và nút Reply ẩn) khi đã Reply trong phiên **hoặc** thẻ đã trả lời;
- nút "Mark as answered" trong hàng nút của thẻ câu hỏi chưa trả lời: gọi `answers.mark` rồi ghi kết quả vào bộ nhớ đệm `answer-marks`; lỗi hiện trên thẻ.

**Không đổi:** pill và `chat.waiting` (Q18 b); thẻ không phải câu hỏi (chỉ có đồng bộ trong phiên).

**Giới hạn:** `chat.waiting` chỉ đọc 200 mục mới nhất của timeline Manager. Một báo cáo `blocked` cũ hơn thế mà vẫn chờ sẽ trông như "không còn chờ" và không có pill; khi đó người dùng vẫn trả lời được bằng ô Reply của thẻ.

**Kiểm thử:**

- `answer-marks`: ghi rồi đọc lại; bỏ dấu; trùng khoá; giới hạn 500; file hỏng hay sai dạng → rỗng kèm thông báo; đời mới hơn → đọc rỗng và từ chối ghi; đường dẫn là symlink → từ chối; khoá sai → từ chối;
- handler của hai RPC; danh sách RPC có `answers.marks`, `answers.mark`;
- `answer-state`: ghi thì listener được gọi, bỏ đăng ký thì không;
- `stillWaiting` và `answeredHow` cho mọi nhánh. **Đối chứng âm:** cho `answeredHow` bỏ qua `waiting` thì ca `"moved-on"` phải đỏ.

### 4.10 Thẻ `finished` mở sẵn và có viền success (PRD delta §1.6, REQ-059 l, request `req-20260918T074311Z`)

Chỉ `plugin/client/chat-cards.ts` (hai hàm thuần mới), `plugin/client/chat-card.tsx` (nối hai hàm vào `ChatCardView`) và `test/plugin-chat-cards.test.ts`. Không đổi `toChatCard`, `chatCardSchema`, `statusChip`, `summaryOf`, `markdownOf`, `drawAsCard` hay `dashboardStyles`.

**Hàm thuần**, trong `plugin/client/chat-cards.ts`:

```ts
/** A `finished` report's card opens with its whole message showing (Q1 a). */
export function startsOpen(card: ChatCard): boolean;
/** The tone of the outline around the whole card, or null for the usual border (Q2 a). */
export function outlineTone(card: ChatCard): "success" | null;
```

- Cả hai chỉ đúng với `card.type === "report" && card.phase === "finished"`: `startsOpen` trả `true`, `outlineTone` trả `"success"`.
- Mọi thẻ khác (báo cáo `received`, `beads-done`, `blocked`, báo cáo không đọc được `phase`, review, tin thường) được `false` và `null`.
- Hai hàm không xét `direction`: thẻ gửi trong chat Worker và thẻ nhận trong chat Manager giống nhau (Q1 a, "mọi chat vẽ thẻ này").

**Nối vào `ChatCardView`:**

- `const [open, setOpen] = useState(() => startsOpen(card));` thay cho `useState(false)`. Nút và phần tin nhắn giữ nguyên: đang mở thì nút ghi "▾ Hide message", bấm thì gập.
- khung thẻ thêm `{ borderColor: toneColor(theme, tone) }` khi `outlineTone(card)` khác `null`. Độ dày vẫn là `borderWidth: 1` của `styles.card`, nên thẻ không xê dịch. Không có `borderLeftWidth`.
- Nhánh vẽ chữ thường (`drawAsCard` sai) không đổi: không có thẻ thì không có viền.

**Giới hạn:** `open` là trạng thái của component. Paseo vẽ lại một thẻ đã bị gỡ khỏi màn (cuộn rất xa, đổi tab, tải lại app) thì thẻ `finished` lại mở sẵn, dù người dùng đã gập.

**Kiểm thử** (`test/plugin-chat-cards.test.ts`):

- `startsOpen` và `outlineTone`: báo cáo `finished` nhận và gửi → `true` / `"success"`; báo cáo `received`, `beads-done`, `blocked`, báo cáo `phase` rỗng, review, tin thường → `false` / `null`. Thẻ lấy từ `toChatCard` với tin thật, không dựng tay.
- Nối: đọc nguồn `chat-card.tsx` (như `test/plugin-launcher.test.ts`) — có `useState(() => startsOpen(card))`, có `outlineTone(card)`, và không còn `useState(false)` cho `open`.
- **Đối chứng âm:** cho `startsOpen` trả `true` với mọi báo cáo thì ca `blocked` phải đỏ; cho `outlineTone` bỏ điều kiện `phase` thì ca `received` phải đỏ.
- Phần vẽ: `npm run typecheck:plugin` và `npm run lint`. Màu và bố cục chỉ kiểm được bằng mắt: owner kiểm trên daemon thật.

**Hoàn tác:** revert hai hàm, hai chỗ nối và các ca test của chúng. Không có dữ liệu lưu bền.

## 5. Luồng

```
Worker ──blocked: BM-REPORT + BM-QUESTIONS──▶ Manager chat ──▶ thẻ câu hỏi
Manager ──"A · Worker X · req-A: Q6, Q7 — trả lời trong thẻ hoặc gõ A6 a"──▶ người dùng

Người dùng tick / Use recommendations / gõ Other
   └─▶ picks ──answersDraft──▶ withAnswersBlock(ô Reply) ──▶ ô Reply mở, khối ở đầu, lời người dùng giữ nguyên
Người dùng bấm Send
   └─▶ sendReply: ô rỗng? ─có─▶ không gửi
                  refreshPeers ─▶ replyTarget ─lý do─▶ thẻ hiện lý do, giữ ô và lựa chọn
                                              └─ idle/error ─▶ send(peer.id, replyText(card, ô)) ─▶ Worker
                  gửi xong + khối nằm trong chữ đã gửi ─▶ "Answered at HH:MM → Worker: Q6 a, Q7 other"
```

## 6. Chiến lược kiểm thử

| Cần chứng minh | Bằng chứng (`test/plugin-chat-cards.test.ts` trừ khi ghi khác) |
|---|---|
| Chỉ câu đã trả lời có dòng | `isAnswered`: khoá có thật → đúng; khoá `z` → sai; "Other" chỉ có dấu cách → sai; câu một lựa chọn chọn khoá → sai, chọn "Other" có chữ → đúng. `answersDraft`: không chọn gì → `""`; chọn Q6 → khối chỉ có dòng Q6; "Use recommendations" → khối đủ Q6, Q7 (hai cú bấm vẫn đủ); thẻ không có `requestId` → `""` |
| Ô Reply giữ lời người dùng, khối luôn ở đầu | `withAnswersBlock`: ô trống → khối; thay khối cũ và giữ chữ phía dưới; chữ **phía trên** khối cũ → kết quả bắt đầu bằng khối mới, chữ đó nằm dưới khối (`"note\n\nBM-ANSWERS…"` → `"BM-ANSWERS…\n\nnote"`); chữ ở cả hai phía → cả hai nằm dưới khối, đúng thứ tự, không có hai dòng trống liền nhau; khối rỗng → bỏ vùng, không để dòng trống ở đầu; ô chỉ có chữ → khối + dòng trống + chữ; khối rỗng và ô không có vùng → chữ giữ nguyên. Mọi ca có `block` khác rỗng đều kiểm `result.startsWith(block)`. **Đối chứng âm:** cho hàm thay vùng tại chỗ (không đưa khối lên đầu) thì ca "chữ phía trên" phải đỏ; cho hàm luôn trả `block` thì ca "giữ chữ phía dưới" phải đỏ |
| Không lựa chọn nào bị mất khi gửi | `sendReply` với ô = `withAnswersBlock("OK", answersDraft(...))`: `send` nhận đúng `replyText(card, ô)`, có dòng `Q6: a — …` và chữ `OK`. Đây là ca của lỗi owner gặp |
| Người nhận đúng, không vào lượt đang chạy, cho mọi thẻ | `replyTarget`: báo cáo → Worker duy nhất của request; 0 hay 2 Worker → câu lý do cũ nguyên văn; `running` / `initializing` / `closed` → chặn, câu lý do cũ nguyên văn; `idle` / `error` → cho gửi. Thẻ review trong chat Worker với Reviewer `running` → chặn. Tin thường trong chat Worker với Manager `running` → chặn |
| Đường gửi | `sendReply` với `refreshPeers` và `send` giả: `send` đúng một lần, id từ lần đọc lại; người nhận chuyển sang `running` giữa lúc vẽ và lúc bấm → không gửi; `send` ném lỗi, `refreshPeers` ném lỗi → `{ ok: false }` kèm lý do; ô trống → không gọi cả `refreshPeers`. **Đối chứng âm:** bỏ bước đọc lại thì ca "`running` lúc bấm" phải đỏ |
| Trạng thái "đã trả lời" | `sentSummary`: khối nằm trong chữ gửi → `Q6 a, Q7 other`; người dùng xoá khối → `null`; không chọn gì → `null`. `answerSummary` bỏ qua "Other" rỗng. `answeredKey` như cũ |
| Tiêu đề câu | `questionHeading`: có chủ đề → `Q6 · Storage` + phần còn lại; không chủ đề → `Q1` + toàn bộ câu |
| Thẻ cũ không đổi | Các ca đang có của `toChatCard`, `summaryOf`, `quickReplies`, `markdownOf`, `showsQuestions`, `partiesOf`, `replyText` giữ nguyên kỳ vọng |
| Chỉ dẫn Manager | `test/roles-content.test.ts`: bảng luật §4.5; `manager.md` dưới 174 dòng; RULES ≤ 29 dòng và đúng 5 giới hạn; file chỉ dẫn sinh ra khớp markdown (`test/plugin-bundle-cjs.test.ts`) |
| Phần `.tsx` | `npm run typecheck:plugin` và `npm run lint`. Bố cục chỉ kiểm được bằng mắt: owner kiểm trên daemon thật |
| Batch `b6` | `answer-marks`, hai handler, `answer-state`, `stillWaiting`, `answeredHow` như §4.9 |
| Batch `b5` | `waitingOf`, `handleChatWaiting`, `planPills` như §4.8; danh sách RPC có `chat.waiting` |
| Batch `b4` | `visibleBeads`: 0, 2, 3 và 7 id, mở rộng và chưa; `replyControls`: đủ bốn tổ hợp. Phần vẽ: `typecheck:plugin`, và đọc lại mã; owner kiểm bằng mắt |
| Thẻ `finished` (`req-20260918T074311Z`) | `startsOpen`, `outlineTone` và phần nối như §4.10 |
| Cả gói | `npm run verify` mã 0 |

## 7. Hoàn tác

Mỗi phần hoàn tác bằng cách revert tệp của nó. Dữ liệu lưu bền duy nhất là file `<install home>/ui/answer-marks.json` của batch `b6` (§4.9): revert mã thì file nằm yên, không ai đọc nữa; Worker không bao giờ xoá nó — đó là dữ liệu của người dùng.

- **Thẻ:** revert `chat-cards.ts`, `chat-card.tsx` và test của chúng → thẻ như bản 20260918c.
- **Chỉ dẫn:** revert `manager.md`, chạy `npm run build`. Manager tạo sau đó dùng chỉ dẫn cũ; Manager đã tạo giữ chỉ dẫn mới cho tới khi owner mở Manager mới. Hai bản vẫn hiểu nhau, vì định dạng khối không đổi.

## 8. Rủi ro và giới hạn

| Rủi ro | Xử lý |
|---|---|
| Người dùng sửa tay trong khối rồi chọn tiếp và mất chỗ sửa | Hành vi được ghi rõ (REQ-059c, §4.1); muốn trả lời bằng lời riêng thì dùng "Other…" hoặc viết bên dưới khối |
| Người dùng gửi khi mới trả lời một phần | Theo Q4: câu thiếu vẫn mở và Worker hỏi lại (REQ-059g) |
| Manager đang mở vẫn lặp lại thẻ | Chỉ dẫn gắn lúc tạo (F6); owner mở Manager mới sau khi nạp lại plugin (§4.6) |
| `manager.md` vượt ngưỡng dòng | Bù bằng phần bỏ (§4.5); vượt thì dừng và hỏi owner, không nâng ngưỡng, không cắt biện pháp an toàn |
| Worker `req-20260918T035101Z` cũng đang sửa repo (`worker.md`, `role-extras.ts`, test vai trò) | Delta này không sửa `worker.md` hay `role-extras.ts`. Với `test/roles-content.test.ts` thì chỉ sửa phần của Manager. `git status` trước mỗi bead; thấy cùng đoạn bị sửa thì dừng và hỏi |
| Bố cục chỉ kiểm được bằng mắt | Owner kiểm trên daemon thật (điều kiện ra 2 của PRD delta). Worker không cài hay nạp lại plugin nếu owner chưa cho phép |

## 9. Đánh giá — tách chỉ dẫn thành reference/template và thư mục theo provider (Q2)

**Owner hỏi:** file md quá dài thì có nên tách reference/template riêng cho agent tham chiếu, và có nên có thư mục chỉ dẫn riêng cho Claude Code, OpenCode, Codex không? **Owner chốt (a):** chưa tách, ghi lại đánh giá. Đánh giá dựa trên [báo cáo research-20260918-instructions-by-model](../../design/paseo-bm-research-20260918-instructions-by-model.md) (R1–R6) và mã hiện tại.

**Làm được không — được, về kỹ thuật:**

- Server biết thư mục plugin đã cài: `resolveInstallHome` đọc đường dẫn đã đăng ký, có dạng `<install home>/plugin/<version>`, và `roles/*.md` nằm trong đó. Hook `before("agent.create")` vì vậy ghi được đường dẫn tuyệt đối tới một file tham chiếu vào prompt.
- Hook biết alias provider (`bm-worker`, …). Muốn chọn thư mục theo provider **nền** (claude / codex / opencode), hook phải tra thêm cấu hình profile — thêm một lần tra trên đường tạo agent, vốn có hạn 30 giây.
- Agent phải **đọc** một file ngoài workspace. Worker và Manager chạy chế độ không hỏi quyền nên đọc được. Reviewer chạy `auto`; chưa kiểm trên daemon thật.

**Được gì — ít:**

- Kích thước hôm nay: `manager.md` 171 dòng (~2.300 token), `worker.md` 392 (~5.300), `reviewer.md` 158 (~1.900). Cửa sổ ngữ cảnh là 1.000.000 token (Claude) và 258.400 (Codex).
- Prompt hệ thống được cache giữa các lượt. Một file tham chiếu, khi đã đọc, vẫn nằm trong ngữ cảnh như mọi thứ khác.
- Tiết kiệm chỉ có ở những request **không** cần phần bị tách ra. Ví dụ: bead mẫu ~35 dòng của `worker.md` chỉ cần khi viết bead Medium/Large.
- **Chat dài dòng không đến từ độ dài file**, mà từ điều file dặn: `manager.md` bảo in lại mọi câu hỏi. Delta này sửa đúng chỗ đó (§4.5).

**Mất gì — thật:**

- Các khối `BM-REPORT`, `BM-QUESTIONS`, `BM-REVIEW` là hợp đồng mà plugin đọc bằng máy, nên phải ở lại trong prompt. Hướng dẫn chính thức của cả Anthropic lẫn OpenAI coi ví dụ ngay trong prompt là cách giữ định dạng chắc nhất (research §4).
- Một file tham chiếu chỉ được đọc khi agent **tự chọn** đọc; không đọc thì không có lỗi nào báo ra.
- Thư mục theo provider nghĩa là gấp đôi, gấp ba số file phải giữ đồng bộ, và gấp đôi, gấp ba test nội dung.

**Cần tối ưu theo provider không — chưa có bằng chứng:**

- 504 lượt đã đo: 0 lỗi định dạng do văn phong của model (research §5).
- Mỗi vai trò mới chạy **một** model, nên chưa tách được hiệu ứng của model khỏi hiệu ứng của vai trò.
- Chưa vai trò nào chạy trên OpenCode.
- Những chỗ khác nhau thật theo provider là **các tầng chỉ dẫn đè nhau**, ví dụ preset của Claude Code mời ghi bộ nhớ ra ngoài workspace. Những chỗ đó sửa được bằng một câu chung cho mọi model (research §7, đề xuất 1–2).

**Cơ chế "tham chiếu" đã có sẵn:** năm skill (`feature-workflow`, `reviewing-plan`, `converting-plan-to-beads`, `polishing-beads`, `implementing-beads`) mang phần dài — checklist, reference, template — trong thư mục của skill, và agent chỉ đọc phần bước đó cần. Các file vai trò đã trỏ tới chúng thay vì chép lại.

**Khi nào nên xem lại:**

1. một vai trò chạy trên provider thứ hai, và kho vết cho thấy một lỗi chỉ xảy ra ở provider đó;
2. một phần của file vai trò chỉ dùng ở một bước hiếm, và đo được chi phí của nó là đáng kể.

Khi đó, bước rẻ nhất là một **đoạn bổ sung ngắn theo provider**, do hook nối vào sau chỉ dẫn chung (như mục `## Runtime facts`), chứ không phải một bản chép cho mỗi provider.

## 10. Câu hỏi mở

Không còn câu nào chặn. Ngưỡng dòng của `manager.md` không nâng; nếu không vừa, Worker hỏi owner (§4.5).

## 11. Revision History

| Ngày | Người | Thay đổi |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Errata theo [delta 20260918f](./paseo-bm-delta-20260918f-ui-review.md) §4.12 (§4.8): chữ ký `waitingOf(manager, entries, workers)`; `planPills` nằm ở `waiting-pills-model.ts`. Không đổi phạm vi |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Request `req-20260918T074311Z` (PRD delta §1.6, Q1–Q4 của request đó): §4.10 — thẻ `finished` mở sẵn tin nhắn và có viền success; §6 thêm một dòng |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Theo review b6: §7 nói đúng dữ liệu lưu bền mới (`answer-marks.json`) và cách hoàn tác |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b6` (PRD delta §1.5, Q16–Q18): §4.9 — kho trạng thái chung trong phiên, dấu lưu bền `answers.mark(s)`, thẻ tự biết Worker không còn chờ |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b5` (PRD delta §1.4, Q15): §4.8 — RPC `chat.waiting`, composer pill cho mỗi Worker đang chờ, popover vẽ lại thẻ |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b4` (PRD delta §1.3, Q11–Q14): §4.7 — bỏ viền trái, tên màu chữ thường, giờ dưới tên, 2 bead + chip "…", chip "Answered" thay nút Reply sau khi gửi |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Đã cài đặt (WP-255 → WP-258). Ghi chú §4.4: tiêu đề, câu hỏi và chữ lựa chọn mang thêm màu `theme.colors.foreground`, vì `styles.body` mặc định là màu nhạt và chữ monospace cũ dùng màu `foreground`. Status giữ Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Errata lúc implement WP-255: câu ngoại lệ của "How you talk" viết là "the questions of a report with no buttons" (§4.5) để `manager.md` vừa ngưỡng, đo được 173 dòng. Không đổi hành vi |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | `design-ready` PASS sau review b1 pass; Status → Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Theo review b1: `withAnswersBlock` luôn đặt khối ở đầu ô, chữ phía trên khối cũ chuyển xuống dưới (§4.1, §6); dòng của Manager dùng mã câu `Q6, Q7` đúng lời owner chốt ở Q1, `A6 a` chỉ là cú pháp trả lời (§4.5, §5); `received` giữ "one line"; câu về thẻ thay câu "Each carries …" và bản nháp đo được 173 dòng (§4.5) |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Tạo delta: một đường gửi cho mọi Reply, lựa chọn viết vào ô Reply, bố cục câu hỏi, Manager không nhắc lại thẻ, đánh giá Q2 |
