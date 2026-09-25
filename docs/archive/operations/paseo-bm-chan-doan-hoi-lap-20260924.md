# Chẩn đoán: câu hỏi đã trả lời vẫn bị hỏi lại

| Trường | Giá trị |
|---|---|
| Mã | `chan-doan-hoi-lap-20260924` |
| Status | **Active** — chẩn đoán xong; đã sửa trong working tree (epic `bm-so-hoi-dap-tb4m`, chưa commit, chưa cài lên daemon), theo [design-delta-20260924-qa-ledger](../design/paseo-bm-delta-20260924-qa-ledger.md) |
| Owner | hieu.nt10 |
| Created | 2026-09-24 |
| Yêu cầu | "Khi Manager giao việc xuống cho Worker, thường xuyên bị tình trạng Worker hỏi lại, tôi đã trả lời vào Manager nhưng Worker nhận được, làm một lúc thì lại hỏi lại chính những gì đã hỏi Manager … tìm ra nguyên nhân gốc rễ … fix triệt để" |
| Nối tiếp | [chan-doan-hoi-lap-20260923](paseo-bm-chan-doan-hoi-lap-20260923.md). Bản đó tìm ra các thẻ bị đăng trùng trong vòng 19–48 giây (L1) và đã sửa. Bản này tìm ra nguyên nhân của các lần hỏi lại **sau khi đã có câu trả lời**, mà §4 của bản trước ghi là chưa thấy |
| Hiện trường | `wks_project_b` (project-b) và `wks_paseo_bm` (paseo-bm), trace store cắt tại `CUT = 2026-09-24T02:00:00Z` |
| Quyết định của chủ repo | 2026-09-24: đồng ý cả sáu hướng sửa ở §5 và yêu cầu làm tới nơi |

## 1. Kết luận

Trong hệ thống **không có chỗ nào ghi lại "câu hỏi này đã được trả lời"**. Chỉ Worker biết mình đã nhận câu trả lời, và Worker không báo lại điều đó cho ai. Mọi bên còn lại tự đoán trạng thái từ tín hiệu gián tiếp:

| Bên | Đoán "còn chờ" từ | Vì sao sai |
|---|---|---|
| Thẻ câu hỏi, pill trên khung chat | `chat.waiting`: báo cáo mới nhất của request là `blocked` có câu hỏi **và** Worker đang `idle` (`plugin/server/chat-waiting.ts` `waitingOf`) | Worker cũng `idle` khi chờ Reviewer hay CI. Dấu "đã gửi" của thẻ chỉ nằm trong bộ nhớ phiên của app (`plugin/client/answer-state.ts`), mất khi app nạp lại hoặc mở trên máy khác |
| Manager | Báo cáo `BM-REPORT` cuối cùng và những gì chính nó đã chuyển đi | Câu trả lời từ thẻ đi **thẳng tới Worker** (`chat-cards.ts` `sendReply` → `replyTarget` là người gửi thẻ). Manager không thấy. Worker chỉ báo cáo ở `received`, `beads-done`, `blocked`, `finished` (`worker.md`), không báo khi nhận câu trả lời |

Hai chữ `idle` trông giống nhau: "chờ bạn" và "chờ Reviewer". Plugin không phân biệt được.

## 2. Chuỗi nhân quả

```
Worker gửi blocked + BM-QUESTIONS ──► Manager dựng thẻ
Người dùng bấm trả lời trên thẻ ──► BM-ANSWERS tới THẲNG Worker (Manager không thấy)
Worker làm tiếp, gọi Reviewer, KẾT THÚC LƯỢT để chờ ──► Worker idle, chưa có báo cáo mới
        ├─► chat.waiting: blocked + idle ⇒ "đang chờ" ──► pill hiện lại, thẻ trắng nút lại
        │                                                  └─► người dùng trả lời LẦN HAI
        └─► Manager bị đánh thức (notifyOnFinish) ──► "Worker vẫn chờ Q…"
                                                       └─► người dùng gõ gì đó ──► Manager chuyển lại câu trả lời cũ
```

## 3. Bằng chứng

### 3.1 Khoảng thời gian câu hỏi đã trả lời vẫn hiện như đang chờ

Sau mỗi lần một `BM-ANSWERS` tới Worker, đếm các lượt Worker kết thúc `completed` **trước** báo cáo kế tiếp của request đó. Mỗi lượt như vậy là một lúc Worker `idle` mà báo cáo mới nhất vẫn là `blocked`.

| Workspace | Ngày | Câu trả lời | Có khoảng "chờ giả" sau đó | Tổng phút |
|---|---|---|---|---|
| project-b | 2026-09-22 | 11 | 6 | 181 |
| project-b | 2026-09-23 | 20 | 17 | 462 |
| paseo-bm | 2026-09-18 | 32 | 17 | 253 |
| paseo-bm | 2026-09-23 | 16 | 8 | 120 |

### 3.2 Cùng một câu hỏi được trả lời hai lần: 12 lần

11 lần trong hai workspace ở bảng dưới, 1 lần ở `wks_project_c` (Q3, 2026-09-21, cách 3,6 phút).

| Lần hai | Worker | Câu | Qua | Lần đầu |
|---|---|---|---|---|
| 2026-09-18T05:54:20Z, 05:56:32Z | `9d7d127` | Q11–Q14 | thẻ, hai lần | 05:26:04Z |
| 2026-09-18T11:41:17Z | `c5c21e8` | Q1 — lần đầu chọn **b**, lần hai chọn **a** | thẻ | 11:15:27Z |
| 2026-09-18T14:37:34Z | `c5c21e8` | Q2 — hai câu trả lời trái nhau | thẻ | 11:42:18Z |
| 2026-09-22T16:28:10Z | `4412007` | Q16, Q17, Q19 | thẻ | 15:56:22Z |
| 2026-09-22T17:10:59Z | `4412007` | Q18 — lời khác lần đầu | **Manager chuyển** | 16:28:10Z |
| 2026-09-22T17:58:10Z | `4412007` | Q20, Q21 | thẻ | 17:26:22Z |
| 2026-09-23T05:58:31Z | `4412007` | Q28, Q29 | **Manager chuyển** | 02:04:59Z |
| 2026-09-23T05:58:36Z | `4b260e4` | Q5 | **Manager chuyển** | 05:16:31Z |
| 2026-09-23T09:53:16Z | `dced724` | Q14 | thẻ | 09:43:59Z |
| 2026-09-23T11:13:44Z | `f472260` | Q10–Q12 | thẻ (L1 + L3 của bản 23/09) | 11:04:55Z |

Mọi lần hai qua thẻ đều rơi vào lúc Worker đang `idle` chờ Reviewer hoặc chờ CI mà chưa gửi báo cáo mới. Ví dụ `4412007`: trả lời lúc 15:56:22Z → 15:58:07Z Worker kết thúc lượt với *"Reviewer b1 đang chạy. Mình chờ kết quả…"* → 16:28:10Z người dùng trả lời lại cả Q16–Q19.

### 3.3 Manager nói sai rằng câu hỏi còn mở

- 2026-09-22T17:11:02Z: *"Q16, Q17 và Q19 vẫn chưa có câu trả lời"* — đã trả lời lúc 15:56:22Z và lại lần nữa lúc 16:28:10Z.
- 2026-09-22T17:12:59Z: *"có lẽ Q16, Q17, Q19 đã được trả lời, nhưng mình không thấy…"*
- 2026-09-23T05:34:54Z và 05:54:51Z: liệt kê Q5, Q28, Q29 là đang chờ — Q28, Q29 đã trả lời lúc 02:04:59Z, Q5 lúc 05:16:31Z. Lúc 05:58 nó chuyển lại cả ba cho hai Worker.

### 3.4 Worker thật sự hỏi lại cùng một quyết định

Hai nguồn này không phải lỗi trạng thái. Chúng do luật trong chỉ dẫn vai trò:

1. **Ngân sách review có hai bên cùng hỏi.** Worker tự gửi `blocked` khi hết lượt review, và plugin gửi `BM-BUDGET` bảo Manager hỏi người dùng "tiếp tục hay huỷ". Ca 2026-09-23T05:59:31Z: Manager tự viết *"chính bạn đã cho phép lượt này khi chọn Q29 a"* rồi vẫn phải hỏi. Mỗi lần người dùng cho "review thêm", Reviewer mới tìm thêm lỗi chặn, luật lại kích hoạt: project-b `req-20260923T122743Z` Q6 → Q8; paseo-bm `req-20260923T132222Z` Q1 → Q5.
2. **Phương án giao việc cho người dùng làm sau.** Ví dụ "anh chạy X rồi báo tôi": câu trả lời tới Worker **trước** khi việc được làm. Worker kiểm, thấy chưa xong, và hỏi lại dưới số mới: paseo-bm `req-20260923T063441Z` Q8 → Q9 (dời dist-tag), Q16 → Q17 → Q18 (`npm login`, 2FA).

## 4. Đã kiểm và **không** phải nguyên nhân

- **Mã fallback.** Toàn bộ trace chỉ có một sự cố fallback (`fb-d3c9430912b2`, bản thử lúc 2026-09-22T07:06Z). Daemon log không có lỗi nào từ `chat.waiting`. Cơ chế ở §2 đã có từ 2026-09-18, ngày thẻ câu hỏi ra đời (4 lần trả lời trùng ngày hôm đó). Cảm giác "xuất hiện sau fallback" là vì từ 2026-09-22 các request Large dài hơn, nhiều lượt review hơn, và tới 6 Worker chạy song song, nên khoảng "chờ giả" ở §3.1 tăng vọt.
- **Mất ngữ cảnh do nén hội thoại.** Mọi Worker của hai workspace chạy `claude-opus-5` với cửa sổ 1 000 000 token. Khi nhận câu trả lời trùng, Worker đều nhận ra ngay: *"Câu này anh đã trả lời rồi"* (`dced724`, 09:53:26Z).
- **Hỏi lại có lý do.** `1477872` Q1 → Q3 (2026-09-23T04:56Z) giống nhau về chữ, nhưng câu trả lời Q1 là *"other — kiểm tra so với repo Insight cũ rồi đánh giá thêm"*, tức người dùng bảo Worker điều tra trước. Q3 là câu hỏi sau điều tra. Không tính.

**Một lỗi tiềm ẩn của fallback, cùng loại:** `BM-HANDOVER` (`plugin/server/fallback-handover.ts` `workerHandover`) chỉ chuyển yêu cầu gốc và báo cáo cuối, **không** chuyển các câu hỏi và câu trả lời trước đó. Khi fallback chạy thật, Worker thay thế chắc chắn sẽ hỏi lại mọi thứ.

## 5. Hướng sửa (chủ repo đã đồng ý 2026-09-24)

1. Server của plugin ghi một sổ hỏi–đáp: mọi `BM-QUESTIONS` tới Manager và mọi `BM-ANSWERS` tới Worker, xuống đĩa.
2. `chat.waiting`, thẻ và pill đọc sổ đó, không suy từ `idle` và bộ nhớ phiên.
3. Khi người dùng trả lời thẳng cho Worker, Manager được báo bằng `BM-ANSWERED`.
4. Chỉ Worker hỏi về ngân sách review; `BM-BUDGET` chỉ để báo.
5. Luật cho phương án giao việc cho người dùng: chọn phương án đó nghĩa là việc đã làm xong.
6. `BM-HANDOVER` mang theo các câu hỏi và câu trả lời.

Chi tiết: [design-delta-20260924-qa-ledger](../design/paseo-bm-delta-20260924-qa-ledger.md).

## 6. Kiểm chứng lại

Chỉ đọc, không ghi. Lưu đoạn dưới thành `check.mjs` rồi chạy `node check.mjs ~/.paseo-bm/traces/<workspace>/events-202609.jsonl`:

```js
import { readFileSync } from "node:fs";
const [file, cut = "2026-09-24T02:00:00Z"] = process.argv.slice(2);
const recs = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.at <= cut);
const rid = (t) => (t.match(/requestId: (req-\S+)/) ?? [])[1];
const qids = (t) => t.split("\n").filter((l) => /^Q\d+:/.test(l)).map((l) => l.split(":")[0]);
// §3.2: BM-ANSWERS tới Worker; cùng một câu được trả lời hai lần.
const answers = recs.filter((r) => r.role === "worker").flatMap((r) =>
  (r.sent ?? []).filter((m) => /^BM-ANSWERS/m.test(m.text)).map((m) => ({ at: m.at, worker: r.agentId, rid: rid(m.text), ids: qids(m.text), via: m.origin })));
answers.sort((a, b) => (a.at < b.at ? -1 : 1));
const first = new Map();
for (const a of answers) {
  const again = a.ids.filter((id) => first.has(`${a.worker}|${a.rid}|${id}`));
  if (again.length) console.log(`answered twice: ${a.at} worker ${a.worker.slice(0, 7)} ${again.join(",")} via ${a.via} (first ${first.get(`${a.worker}|${a.rid}|${again[0]}`)})`);
  for (const id of a.ids) if (!first.has(`${a.worker}|${a.rid}|${id}`)) first.set(`${a.worker}|${a.rid}|${id}`, a.at);
}
// §3.1: sau mỗi câu trả lời, các lượt Worker kết thúc `completed` trước báo cáo kế tiếp của request.
const reports = recs.filter((r) => r.role === "manager").flatMap((r) =>
  (r.sent ?? []).filter((m) => m.origin === "agent" && /^BM-REPORT/m.test(m.text)).map((m) => ({ at: m.at, rid: rid(m.text) })));
const ends = recs.filter((r) => r.role === "worker" && r.outcome === "completed").map((r) => ({ worker: r.agentId, end: r.endedAt }));
const days = {};
for (const a of answers) {
  const next = reports.filter((p) => p.rid === a.rid && p.at > a.at).sort((x, y) => (x.at < y.at ? -1 : 1))[0];
  const idle = ends.filter((e) => e.worker === a.worker && e.end > a.at && (!next || e.end < next.at)).sort((x, y) => (x.end < y.end ? -1 : 1));
  const d = (days[a.at.slice(0, 10)] ??= { answers: 0, staleAfter: 0, staleMinutes: 0 });
  d.answers += 1;
  if (idle.length) {
    d.staleAfter += 1;
    d.staleMinutes += (Date.parse(next ? next.at : idle.at(-1).end) - Date.parse(idle[0].end)) / 60000;
  }
}
for (const [day, d] of Object.entries(days).sort()) console.log(day, `answers=${d.answers} staleAfter=${d.staleAfter} staleMinutes=${Math.round(d.staleMinutes)}`);
```

Trong trace, `sent` là các tin nhắn **gửi tới** agent của bản ghi, `received` là các tin nhắn agent đó viết ra; `origin: "user"` nghĩa là tin nhắn có `clientMessageId`, tức đi từ app (thẻ hoặc gõ tay).

> Bỏ `CUT` thì số sẽ lớn hơn: đó là việc xảy ra sau lúc chẩn đoán, không phải sai lệch.
