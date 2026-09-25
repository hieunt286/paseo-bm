# Delta-change — Sổ hỏi–đáp: "đã trả lời" thành một trạng thái thật

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260924-qa-ledger` |
| Tài liệu gốc | [Technical Design](../../design/paseo-bm.md); các delta đang sống mà delta này sửa: [20260918c-question-cards](./paseo-bm-delta-20260918c-question-cards.md), [20260918d-card-replies](./paseo-bm-delta-20260918d-card-replies.md) §4.8–§4.9, [20260917c-context-engineering](./paseo-bm-delta-20260917c-context-engineering.md) §4.7 (`BM-BUDGET`), [20260921-worker-fallback](./paseo-bm-delta-20260921-worker-fallback-and-role-settings.md) §4.4.8 (`BM-HANDOVER`). **Không sửa tại chỗ** |
| Chẩn đoán | [chan-doan-hoi-lap-20260924](../operations/paseo-bm-chan-doan-hoi-lap-20260924.md) — mọi con số và ca ở đây lấy từ đó |
| Plan | [plan-delta-20260924-qa-ledger](../plans/paseo-bm-implementation-plan-delta-20260924-qa-ledger.md) |
| Status | Merged — gộp vào [paseo-bm.md](../../design/paseo-bm.md) ngày 2026-09-25; chỉ còn là hồ sơ lịch sử |
| Owner | hieu.nt10 |
| Created | 2026-09-24 |
| Quyết định của chủ repo | 2026-09-24: đồng ý sáu hướng sửa của chẩn đoán §5, yêu cầu "xử lý triệt để" |

## Routing Decision

- Variant preset: brownfield
- Triggered risks: hợp đồng giữa các vai trò bị đổi (thông báo mới `BM-ANSWERED`, nghĩa của `BM-BUDGET`, hình dạng `BM-HANDOVER`, đầu ra RPC `chat.waiting`); một file trạng thái mới trên đĩa (`qa-ledger.json`)
- Required artifacts/gates: delta thiết kế này + `design-ready`; delta plan + `plan-ready-for-beads`; `feature-done`
- Execution path: plan → bead viết tay theo tiền lệ của chẩn đoán 2026-09-23 (nhãn `feature:paseo-bm`, `area:giao-tiep-hoi-lap`, không `wp:*`/`phase:*`)
- Exceptions: không có delta PRD. Không thêm REQ: hành vi người dùng thấy chỉ là **bớt** hỏi lại; các tiêu chí nằm ở §9
- Decided: 2026-09-24 — hieu.nt10
- Supersedes: none

## 1. Kết quả cần đạt

1. Một câu hỏi đã được trả lời, qua thẻ hay qua Manager, **không bao giờ** hiện lại như đang chờ: không pill, không thẻ trắng nút, không Manager nói "còn chờ".
2. Manager biết khi người dùng trả lời thẳng cho Worker, và không chuyển lại câu trả lời đó.
3. Chỉ một bên hỏi người dùng về ngân sách review.
4. Worker không phải hỏi lại một câu vì câu trả lời tới trước việc người dùng phải làm.
5. Worker thay thế của fallback biết mọi câu đã hỏi và đã trả lời.

## 2. Nền tảng — sự thật đã kiểm

| # | Sự thật | Nguồn |
|---|---|---|
| F1 | Hook `agent.turn_ended` trao `timeline` là cả cuộc hội thoại; một `user_message` là `{ type, text, messageId?, clientMessageId? }`, **không có dấu thời gian** | `@getpaseo/protocol` `agent-types.d.ts`; `format-check.ts` đọc đúng dạng này |
| F2 | `user_message` do người dùng gửi từ app (thẻ hoặc gõ tay) có `clientMessageId`; do agent gửi bằng `send_agent_prompt` thì không | AGENTS.md, đo 15/15 và 43/43 |
| F3 | Thẻ gửi câu trả lời **thẳng tới Worker** (`chat-cards.ts` `sendReply`, người nhận là người gửi thẻ) | mã |
| F4 | Worker chỉ báo cáo ở `received`, `beads-done`, `blocked`, `finished`, và kết thúc lượt khi chờ Reviewer (`notifyOnFinish` mặc định) | `worker.md` "Reporting", "Reviewing" |
| F5 | Worker đánh số câu hỏi một lần cho cả request (`Q1`, `Q2`, … đếm tiếp qua các vòng); một câu **chưa** trả lời được hỏi lại **dưới chính số của nó** | `worker.md` "How to ask", "Answers" |
| F6 | `PaseoAgentHandle.send()` vào một agent đang chạy **thay** lượt của nó; mọi thông báo tới agent có thể đang chạy phải qua `notice-queue.ts` | `notice-queue.ts` |
| F7 | Trạng thái bền của UI nằm trong `<install home>/ui/`, ghi nguyên tử, chặn symlink, và file mới hơn phiên bản thì từ chối ghi đè (`answer-marks.json`, `budget-told.json`) | `answer-marks.ts`, `budget-told.ts` |

### 2.1 ADR và ranh giới

- [ADR-005](../../adr/ADR-005-manager-as-agent.md): vòng đời agent thuộc về người dùng. Sổ không huỷ, không lưu trữ agent nào. `BM-ANSWERED` đi qua `notice-queue`, nơi đã bỏ qua agent đã lưu trữ hoặc đã đóng.
- [ADR-007](../../adr/ADR-007-dashboard-trace-store.md): trace store là lịch sử cho Dashboard, không phải nguồn trạng thái cho giao tiếp. Sổ **không** dựng từ trace store: bản ghi trace cắt tin nhắn xuống 512 ký tự khi bản ghi lớn (chẩn đoán 2026-09-23 L4), nên các dòng `Q<n>:` cuối của một khối `BM-ANSWERS` dài có thể mất.
- Delta này **sở hữu**: sổ, luật "đã trả lời", `BM-ANSWERED`, câu chữ mới của `BM-BUDGET`, khối `questions` của `BM-HANDOVER`, và các câu tương ứng trong `worker.md`, `manager.md`. **Không sở hữu**: mẫu `BM-QUESTIONS` và `BM-ANSWERS` (giữ nguyên), cách Paseo giao tin nhắn, vòng đời agent.

### 2.2 Luồng

```
Manager turn_ended ──(user_message từ agent có BM-QUESTIONS)──► sổ.questions
Worker  turn_ended ──(user_message có BM-ANSWERS)─────────────► sổ.answers
                    └─(lượt cuối, via user, mới ghi)──► notice-queue ──► Manager: BM-ANSWERED
chat.waiting ──đọc sổ──► waitingOf(…, answered) ──► pill (đếm câu mở), thẻ ("Answered.")
fallback switch ──đọc sổ──► BM-HANDOVER.questions
```

Khi có lỗi: hook ghi sổ thất bại thì ghi một dòng log, lượt của agent không bị ảnh hưởng, và lần kết thúc lượt sau ghi bù (§3.2). `chat.waiting` không đọc được sổ thì lùi về hành vi cũ. Handover không đọc được sổ thì ghi `questions: unknown`.

## 3. Sổ hỏi–đáp (`plugin/server/qa-ledger.ts`, mới)

### 3.1 File

`<install home>/ui/qa-ledger.json`, cùng thư mục và cùng cơ chế ghi với `answer-marks.json` (F7).

```jsonc
{
  "schemaVersion": 1,
  "requests": [
    {
      "requestId": "req-20260922T135101Z",
      "workspaceId": "wks_project_b",
      "updatedAt": "2026-09-22T15:58:07.300Z",
      "questions": [ { "id": "Q16", "text": "Thứ tự pha (PRD Q-003).", "at": "…" } ],
      "answers":   [ { "id": "Q16", "text": "a — giữ như đề xuất …", "via": "user", "workerId": "4412007…", "at": "…" } ]
    }
  ]
}
```

- `via`: `"user"` khi `user_message` có `clientMessageId` (F2), ngược lại `"agent"`.
- `at` là **lúc plugin ghi**, không phải lúc tin nhắn được viết (F1). Nó chỉ để đọc, không dùng để so thứ tự.
- Mỗi `text` được che bí mật bằng `redactText` như mọi bản ghi trace (REQ-048b), rồi cắt còn 1 000 ký tự.
- Giới hạn: 300 request (bỏ request có `updatedAt` cũ nhất), 100 câu hỏi và 200 câu trả lời mỗi request.
- Đọc: file hỏng hoặc sai hình dạng thì coi như rỗng và ghi một dòng log `[paseo-bm]`. File có `schemaVersion` mới hơn thì coi như rỗng và **không ghi đè**. Không bao giờ sửa file khi đọc.

### 3.2 Ai ghi, lúc nào

Một handler `on("agent.turn_ended")` mới. Nó không bao giờ ném lỗi vào lượt của agent.

| Agent kết thúc lượt | Đọc | Ghi |
|---|---|---|
| Manager (`roleOfProvider` = `manager`) | mọi `user_message` **không** có `clientMessageId` và không phải thông báo của plugin, chứa khối `BM-QUESTIONS` | từng câu hỏi (`parseQuestions`); `requestId` của khối, không có thì của `BM-REPORT` ngay trên |
| Worker (`worker`) | mọi `user_message` không phải thông báo của plugin, chứa khối `BM-ANSWERS` | từng câu trả lời (`parseAnswers`, mới, §3.3) |

Handler đọc **cả** `timeline`, không chỉ lượt cuối. Việc ghi là idempotent: một câu hỏi đã có thì chỉ cập nhật `text`; một câu trả lời trùng cả `id` lẫn `text` thì bỏ qua. Vì vậy một lượt bị huỷ giữa chừng hay một lần nạp lại plugin không làm mất câu trả lời nào: lượt kết thúc sau sẽ ghi bù.

### 3.3 `parseAnswers` (`plugin/shared/bm-questions.ts`)

Bộ đọc khoan dung, cùng tinh thần với `parseQuestions`: tìm khối `BM-ANSWERS` **cuối cùng** của tin nhắn; đọc dòng `requestId:`; mỗi dòng `Q<n>: <câu trả lời>` (chấp nhận đậm `**Q1**`, trích dẫn `>`, gạch đầu dòng) là một câu trả lời; dừng ở dòng trống đầu tiên sau câu trả lời cuối, hoặc ở một khối `BM-*` khác. Trả `{ requestId, answers: [{ id, text }] }` hoặc `null`.

### 3.4 Luật "đã trả lời"

**Một câu hỏi `(requestId, Qn)` đã được trả lời khi sổ có ít nhất một câu trả lời cho nó, bất kể thứ tự thời gian.** Luật này dựa vào F5: một câu đã trả lời không bao giờ được hỏi lại dưới cùng số. Một Worker dùng lại số đã trả lời là đi ngoài hợp đồng. Khi đó thẻ hiện câu ấy là đã trả lời, và người dùng vẫn trả lời được bằng nút Reply của thẻ.

Vì không so thời gian, cách tính này không phụ thuộc thứ tự hai hook ghi, và lần đầu chạy sau khi nâng cấp cũng đúng.

**Luật đi kèm trong `worker.md`**: một câu trả lời không giải quyết được câu hỏi vẫn **đóng** số đó lại. Phần còn lại được hỏi dưới một **số mới**, kèm lý do. Khi phát lại toàn bộ trace thật qua sổ, tìm được đúng một Worker đi ngược luật này: `wks_project_c`, 2026-09-21T06:59:56Z, hỏi lại Q3 dưới chính Q3 (*"asked again: the last answer named the folder, not this"*). Nếu không có luật đi kèm, pill sẽ giấu câu đó. Đã cân nhắc so thứ tự giữa lần hỏi và lần trả lời thay cho luật này, nhưng bác: hook không có dấu thời gian (F1), còn thứ tự ghi thì sai ngay lần quét đầu tiên sau khi nâng cấp.

`answeredIds(ledger, requestId)` → `Set<string>`. `openQuestionIds(ledger, requestId)` → các câu hỏi của request mà chưa có câu trả lời, theo thứ tự số.

## 4. `chat.waiting`, pill và thẻ

### 4.1 Server

`waitingOf(manager, entries, workers, answered?)` nhận thêm một hàm `answered(requestId) → ReadonlySet<string>`. Với báo cáo `blocked` mới nhất của một request:

- mọi câu hỏi của khối đều nằm trong `answered` → Worker **không** chờ, dù đang `idle`;
- còn câu mở → vẫn chờ như cũ, và mục trả về mang thêm `answered: string[]`, là các câu của khối đã được trả lời.

`handleChatWaiting` đọc sổ **một lần** mỗi lượt gọi. Không đọc được sổ thì `answered` rỗng: hành vi lùi về đúng như trước delta này, không tệ hơn.

Hợp đồng `waitingWorkerSchema` thêm `answered: z.array(z.string()).default([])`. Máy khách cũ bỏ qua trường này; máy chủ cũ không gửi thì mặc định `[]`.

### 4.2 Pill

`questionCountOf(entry)` đếm câu **còn mở** (câu của thẻ trừ `entry.answered`). Nhãn đổi theo, và khoá của pill thêm `answered`, để pill vẽ lại khi một phần được trả lời.

### 4.3 Thẻ

- Thẻ tìm mục của chính nó trong `chat.waiting` như hiện nay (`stillWaiting`). Mục đó có `answered` thì các câu ấy hiện dòng **"Answered."** thay cho các lựa chọn, không chọn được, và "dùng khuyến nghị" không điền vào chúng.
- Thẻ không còn mục nào trong `chat.waiting` thì đổi câu hiện nay thành: `Answered, or {Worker} is working or has reported since.` Trước đây câu này chỉ đúng khi Worker đang chạy; nay nó còn đúng cả khi sổ đã ghi câu trả lời.
- Dấu "đã gửi" trong bộ nhớ phiên (`answer-state.ts`) và "Mark as answered" giữ nguyên: chúng vẫn là cách nhanh nhất và cách cuối cùng.

## 5. `BM-ANSWERED` — Manager được báo

### 5.1 Khi nào gửi

Ở lượt kết thúc của một Worker, với các câu trả lời trong **lượt cuối** (`sliceLastTurn`) mà:

1. `via = "user"` — Manager tự chuyển (`"agent"`) thì nó đã biết;
2. **mới ghi vào sổ ở chính lần này** — một lượt kết thúc sau không gửi lại cùng câu.

Chỉ đọc lượt cuối nên một câu trả lời cũ, lần đầu được ghi khi nâng cấp, không đánh thức Manager.

### 5.2 Gửi cho ai

Manager của Worker: `parentAgentId` nếu agent đó là Manager còn sống (không lưu trữ, không đóng, không bị thay). Nếu không phải, thì Manager còn sống **duy nhất** của workspace. Không tìm được đúng một Manager thì không gửi và ghi một dòng log.

Gửi qua `notice-queue.ts` (F6) với kind `BM-ANSWERED:<requestId>`. Kind theo request để hai Worker trả lời cùng lúc không thay chỗ nhau trong hàng đợi. Thông báo mới hơn cho cùng request thay thông báo cũ chưa gửi. Không sao, vì phần "còn mở" luôn tính lại từ sổ.

### 5.3 Câu chữ

```
BM-ANSWERED requestId: <requestId>
The user answered Q16, Q17, Q19 directly to the Worker (in its card or chat); the Worker has them. Those questions are closed: do not ask them again and do not relay answers to them.
Still open: Q18.
```

Dòng cuối là `Still open: none.` khi không còn câu nào mở, và `Still open: unknown.` khi sổ chưa ghi câu hỏi nào của request (lượt của Manager chưa kết thúc, hoặc hook ghi lỗi): không bao giờ nói "none" khi không biết. `BM-ANSWERED` vào danh sách tiền tố thông báo của plugin (`notices.ts` `isPluginNotice`), nên không ai đọc nó như lời của người dùng.

### 5.4 Manager làm gì (`manager.md`)

Xoá các câu đó khỏi danh sách đang chờ của mình. Không chuyển gì cho Worker. Trả lời người dùng đúng một dòng: Worker nào đã có câu trả lời, và câu nào còn mở nếu có. Luật "A Worker that reported again has had its answers" giữ nguyên, thêm vế "or a `BM-ANSWERED` closed them".

## 6. Ngân sách review — chỉ Worker hỏi

Thay quyết định của [20260917c §4.7](./paseo-bm-delta-20260917c-context-engineering.md) ("the Manager asks the user whether to continue or cancel").

- **Worker là bên hỏi.** `worker.md` đã bắt Worker gửi `blocked` trước mọi lượt review ngoài ngân sách (Small: không bao giờ có Reviewer thứ hai; Medium, Large: còn lỗi chặn sau re-review thì hỏi). Thêm: *một lần người dùng cho phép vượt ngân sách bao phủ đúng phạm vi họ nói ("một lượt nữa", "tới khi sạch") — Worker không hỏi lại cho những lượt nằm trong phạm vi đó.*
- **`BM-BUDGET` chỉ để báo.** Vẫn một lần mỗi request, vẫn bền qua nạp lại (`budget-told.json`). Câu chữ mới:

```
BM-BUDGET requestId: <requestId>
The Worker has used <n> review calls; the <tier> budget is <b>. For your information only: the Worker asks the user itself before any review beyond its budget, so do not ask the user about it. Tell the user in one line. If the user asks you to stop the Worker, cancel its run.
```

- `manager.md`: gạch đầu dòng `BM-BUDGET` viết lại theo đúng câu trên. Luật "never cancel on the notice alone" giữ nguyên.

## 7. Phương án giao việc cho người dùng (`worker.md`, "Asking")

Thêm: *Một phương án cần người dùng làm gì đó ngoài chat (chạy lệnh, đăng nhập, nhập OTP, dời một tag) được viết sao cho **chọn nó nghĩa là việc đã xong** — ví dụ "a: I ran `npm login`; carry on". Không bao giờ viết "I will do X, then tell you". Nếu sau một câu trả lời như vậy phép kiểm vẫn thất bại, thì câu trả lời đó chưa giải quyết được câu hỏi: nói trong một dòng mình thấy gì và hỏi dưới một số mới.*

(Sửa sau review: bản đầu viết "nói một dòng rồi chờ". Câu đó mâu thuẫn với luật §3.4 "câu trả lời đóng số", và không có kênh nào để chờ, vì `bm-format.ts` bắt một báo cáo `blocked` phải kèm `BM-QUESTIONS`.)

## 8. `BM-HANDOVER` mang theo hỏi–đáp

`workerHandover` (`fallback-handover.ts`) thêm một khối, đọc từ sổ trong cùng ngân sách 5 giây:

```
questions:
- Q16: Thứ tự pha (PRD Q-003). → a — giữ như đề xuất …
- Q18: Tải file và ảnh đại diện (DQ-05). → open
```

- Mỗi dòng gọn trên một dòng, câu hỏi và câu trả lời mỗi phần cắt còn 300 ký tự. Nhiều câu trả lời cho cùng một câu thì lấy câu **mới ghi nhất**.
- `questions: none` khi sổ không có gì cho request này; `questions: unknown` khi không đọc được sổ hoặc hết ngân sách.
- `worker.md`, đoạn `BM-HANDOVER`: *các dòng `questions` là ràng buộc — câu đã trả lời là đã chốt, không bao giờ hỏi lại; câu `open` hỏi lại ở lần `blocked` kế tiếp, dưới chính số của nó; câu mới đánh số tiếp sau số lớn nhất trong danh sách, và bắt đầu từ Q100 khi danh sách là `unknown`, để không trùng số đã trả lời.*
- `managerHandover` → `openQuestions` gọi `waitingOf` với cùng hàm `answered`, nên Manager thay thế không nhận câu đã trả lời như câu đang chờ.

## 9. Kiểm thử và tiêu chí nghiệm thu

| # | Tiêu chí | Chứng minh |
|---|---|---|
| A1 | Dáng của ca `4412007` 2026-09-22: `blocked` Q16–Q19, trả lời Q16, Q17, Q19 qua thẻ, rồi Worker `idle` chờ Reviewer → `chat.waiting` liệt kê Worker với `answered = [Q16, Q17, Q19]` và pill đếm **1**. Trả lời thêm Q18 → Worker không còn trong `chat.waiting` | test `waitingOf` + `handleChatWaiting` đọc sổ thật trong thư mục tạm; đối chứng: bỏ tham số `answered` thì test đỏ. Văn bản của ca `4412007` thuộc repo nội bộ project-b nên **không** chép vào repo công khai này: câu hỏi được viết lại cùng dáng. Fixture thật lấy từ chính workspace paseo-bm (`dced724` Q14, 2026-09-23T09:10:36Z / 09:43:59Z) |
| A2 | Câu trả lời qua thẻ ghi `via: user`, qua Manager ghi `via: agent`; ghi lại từ cùng timeline không nhân đôi | test sổ |
| A3 | `BM-ANSWERED` đi đúng một lần tới đúng Manager cho câu trả lời `via: user` ở lượt cuối; không đi cho `via: agent`; không đi cho câu trả lời cũ nằm ngoài lượt cuối; đi qua `notice-queue` (Manager đang chạy thì chờ) | test hook; đối chứng: bỏ điều kiện "mới ghi ở lần này" thì test gửi-một-lần đỏ |
| A4 | `BM-BUDGET` không còn câu "Ask the user"; `manager.md` không còn bảo Manager hỏi người dùng về ngân sách; `worker.md` có luật phạm vi cho phép | test câu chữ + `roles-content.test.ts` |
| A5 | `worker.md` có luật phương án giao việc (§7) | `roles-content.test.ts` |
| A6 | `BM-HANDOVER` có khối `questions` đúng thứ tự, đúng câu trả lời mới nhất, `open` cho câu chưa trả lời, `unknown` khi sổ hỏng | test `fallback-handover` |
| A7 | Sổ hỏng, sổ mới hơn, symlink: đọc ra rỗng, không ghi đè, không ném vào lượt | test sổ |
| A8 | Thẻ: câu nằm trong `answered` hiện "Answered." và không vào `BM-ANSWERS` của lần gửi; "dùng khuyến nghị" không điền vào nó | test `chat-cards` (hàm thuần) |
| A9 | `npm run typecheck && npm run typecheck:plugin && npm run lint && npm test && npm run build` xanh | chạy |

## 10. Hoàn tác

Mọi phần là mã và chỉ dẫn vai trò, lùi bằng `git revert`. `qa-ledger.json` là file mới; bản cũ của plugin không đọc nó. Xoá file thì chỉ mất lịch sử, và hành vi lùi về như trước delta. `chat.waiting` thêm trường có mặc định nên hai chiều tương thích.

## 11. Ngoài phạm vi

- L6 của chẩn đoán 2026-09-23 (tin nhắn cắt ngang lượt đang chạy) — thuộc Paseo.
- L7 (Manager nói ở mọi lần bị đánh thức) — không đổi, ngoài việc giờ nó nói đúng.
- Đọc câu trả lời người dùng gõ tay **không** theo mẫu `BM-ANSWERS` vào chat của Worker. Sổ không đoán; "Mark as answered" vẫn là lối ra.

## 12. Câu hỏi mở

Không còn. Sáu hướng đã được chủ repo duyệt ngày 2026-09-24. Tên file, hình dạng JSON, câu chữ thông báo và luật "đã trả lời" được chốt ở đây, và chủ repo xem lại khi đọc delta này.

## Revision History

| Ngày | Thay đổi | Người |
|---|---|---|
| 2026-09-24 | Tạo, Active | hieu.nt10 (Claude Code thực hiện) |
| 2026-09-24 | §3.4 thêm luật đi kèm "câu trả lời đóng số" (phát hiện khi phát lại trace); §5.3 `Still open: unknown`; §7 và §8 sửa theo review độc lập | hieu.nt10 (Claude Code thực hiện) |
