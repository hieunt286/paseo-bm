# Báo cáo — Chỉ dẫn vai trò tới từng model thế nào, và có cần tối ưu theo model không

| Trường | Giá trị |
|---|---|
| Mã | `research-20260918-instructions-by-model` |
| Request | `req-20260918T011706Z` (phần 3 của yêu cầu) |
| Bead | `bm-wp-248-uxpe` |
| Thiết kế | [design-delta-20260918](../archive/design/paseo-bm-delta-20260918-manager-mode-model-metrics.md) §4.5 (câu hỏi R1–R6, luật nguồn) |
| Phạm vi | Claude Code / `claude-opus-5` (Manager, Worker); Codex / `gpt-5.6-sol` (Reviewer); một đoạn về OpenCode (Q35) |
| Tính chất | **Chỉ điều tra.** Không sửa `plugin/roles/*.md` (Q33). Mọi đề xuất ở §7 là việc owner quyết, thành request mới |
| Ngày | 2026-09-18 — người viết: Beads Worker (`claude-opus-5`) |

Ký hiệu nguồn: **[B]** bundle Paseo 0.8 đã cài (`/Applications/Paseo.app/Contents/Resources/app.asar`, gói `@getpaseo/server/dist/server/server/agent/…`), kèm số dòng; **[T]** kho vết `~/.paseo-bm/traces`; **[S]** snapshot agent đọc bằng `get_agent_status`; **[D]** tài liệu công khai của nhà cung cấp, đọc ngày 2026-09-18 (danh sách ở §8); **[Q]** quan sát trực tiếp ngữ cảnh của chính Worker viết báo cáo này. Điều gì là **suy luận** thì ghi rõ.

## 0. Kết luận ngắn

1. **Ba provider nạp chỉ dẫn vai trò theo ba đường khác nhau** (§2): Claude nối nó vào **cuối** system prompt dựng sẵn của Claude Code; Codex đưa nó thành **developer instructions**; OpenCode đưa vào trường `system`. Ở cả Claude lẫn Codex, chỉ dẫn vai trò đứng ở vị trí **có thẩm quyền cao hơn** file chỉ dẫn của repo (`CLAUDE.md`/`AGENTS.md` đi vào hội thoại như lời người dùng).
2. **Không cần tách văn bản chỉ dẫn theo model lúc này.** Trên 504 lượt đã ghi, cả hai model làm đúng hợp đồng định dạng gần như tuyệt đối: 61/61 lượt Reviewer (`gpt-5.6-sol`) kết thúc bằng khối `BM-REVIEW` đủ 7 trường; 131 `BM-REPORT` của Worker (`claude-opus-5`) không thiếu trường nào (§5). Mọi bất thường tìm được đều do **tầng chỉ dẫn xung đột nhau** hoặc do phiên bản prompt cũ, không do model.
3. **Cái cần tối ưu là chỗ các tầng chỉ dẫn đè lên nhau, và chỗ đó khác nhau theo provider** (§6). Hai xung đột có bằng chứng thật: (a) preset của Claude Code dạy agent **ghi bộ nhớ ra `~/.claude/projects/…/memory`**, trái giới hạn "không ghi ra ngoài workspace" — 3 lần ghi thật; (b) tin nhắn giao việc của Worker cho phép Reviewer chạy `npm run build`, còn `reviewer.md` chỉ cho chạy test và lint/typecheck không ghi file — Reviewer làm theo tin nhắn, 8 lệnh build trong 7 lượt.
4. **Sáu đề xuất có thứ tự ở §7**: hai sửa chữ dùng chung cho mọi model, một chỉnh cấu hình riêng cho Reviewer (mức thinking), và ba việc chỉ nên làm sau khi đo.

**Giới hạn của dữ liệu:** mỗi vai trò chỉ chạy **một** model (Manager và Worker luôn `claude-opus-5`, Reviewer luôn `gpt-5.6-sol`), nên số liệu **không tách được** hiệu ứng của model khỏi hiệu ứng của vai trò. Muốn tách phải chạy đổi model trên cùng fixture — ngoài phạm vi request này (Q33 không chọn (c)).

## 1. Câu hỏi và cách làm

| # | Câu hỏi (thiết kế §4.5) | Nguồn chính |
|---|---|---|
| R1 | Chỉ dẫn vai trò nằm ở đâu trong ngữ cảnh | [B], [S], [D], [Q] |
| R2 | Nó chiếm bao nhiêu, cái gì đứng sau nó | đếm ký tự trên file; [S] |
| R3 | Hướng dẫn chính thức của từng họ model nói gì | [D] |
| R4 | Trên trace đã có, từng model thật sự làm theo tới đâu | [T], biên bản trong `docs/operations/` |
| R5 | Nét nào của ba file vai trò tác động khác nhau theo model | đối chiếu R1–R4 |
| R6 | Có cần tối ưu theo model không; đề xuất | tổng hợp |

Phép đo trên trace: đọc mọi `events-*.jsonl`, khử trùng lặp theo `(agentId, turnId, nội dung lượt)`, phân loại lệnh shell bằng đúng luật của plugin (`shell.ts`: tách theo `&& || ; |`, xoá phần trong dấu nháy trước khi so tên lệnh). Script nằm trong thư mục `mktemp -d` và đã xoá khi xong.

## 2. R1 — Chỉ dẫn vai trò tới từng provider bằng đường nào

| | Claude Code (`claude-opus-5`) | Codex (`gpt-5.6-sol`) | OpenCode |
|---|---|---|---|
| Paseo gửi chỉ dẫn vai trò vào | `systemPrompt: { type: "preset", preset: "claude_code", append: <vai trò + phần daemon nối> }` — [B] `providers/claude/agent.js` 2588–2590, 2633–2638 | `developerInstructions` khi mở thread, khi nối lại thread và mỗi lượt — [B] `codex-app-server-agent.js` 2879–2881, 3013–3015, 3947–3958; khi có collaboration mode thì `developer_instructions = <chỉ dẫn của mode> + <vai trò> + <phần daemon>` — 2716–2718 | trường `system` — [B] `opencode-agent.js` 2511–2522, 2788–2803 |
| Vai trò tin nhắn | **system**, nằm **sau** toàn bộ preset của Claude Code | **developer**, sau chỉ dẫn gốc của model (Codex tự giữ, plugin không thấy) và sau chỉ dẫn của collaboration mode (Reviewer của lô b1 chạy mode `Default` — [S]) | system |
| Cái gì đứng sau | `appendSystemPrompt` của daemon — rỗng trừ khi người dùng đặt trong cấu hình daemon ([B] `bootstrap.js`, `agent-manager.js` 377, 3606–3615) | như cột trái, cùng một chuỗi | như cột trái |
| File chỉ dẫn của repo | `CLAUDE.md` (ở repo này là symlink tới `AGENTS.md`) được **tiêm vào hội thoại như ngữ cảnh dự án, không vào system prompt**; Paseo bật đủ ba nguồn `user`, `project`, `local` ([B] 38–42; [D] Anthropic "Modifying system prompts") | mỗi `AGENTS.md` tìm thấy thành **một tin nhắn vai trò user** mở đầu bằng `# AGENTS.md instructions for <thư mục>` ([D] OpenAI "Codex Prompting Guide") | không kiểm |
| Preset mang thêm gì | công cụ, an toàn, môi trường, **và các chỉ dẫn riêng của Claude Code**: mục "# Memory" bảo agent tự ghi bộ nhớ ra `~/.claude/projects/<repo>/memory/`, công cụ hỏi `AskUserQuestion`, luật commit và PR — [Q]: tất cả nằm trong system prompt của chính Worker này, **trước** chỉ dẫn vai trò | chỉ dẫn gốc của Codex và của collaboration mode (không đọc được từ plugin) | không kiểm |
| Đổi chỉ dẫn giữa phiên | Claude Code **ghi lại system prompt ở request đầu tiên** và dùng lại cho tới khi phiên bị nén ([D] Anthropic) — sửa file vai trò chỉ tới agent **mới** | Paseo gửi lại `developerInstructions` mỗi lượt, nhưng giá trị là `config.systemPrompt` đã chốt lúc tạo agent — thực tế cũng chỉ tới agent mới | — |

**Hệ quả về thẩm quyền.** Anthropic viết rõ: "Instructions in the user message carry marginally less weight than the same text in the system prompt" [D]. Codex đặt `AGENTS.md` ở vai trò user, dưới developer. Vì vậy, khi file vai trò và file của repo mâu thuẫn, **ở cả hai provider file vai trò thắng về vị trí**. Nhưng thắng về vị trí không có nghĩa là model không phải tốn công hoà giải: với GPT-5, "poorly-constructed prompts containing contradictory or vague instructions can be more damaging to GPT-5 than to other models, as it expends reasoning tokens searching for a way to reconcile the contradictions" [D].

**Khác biệt thật duy nhất về đường nạp:** ở Claude, chỉ dẫn vai trò phải **sống chung với một preset lớn viết cho một kịch bản khác** — một người ngồi xem và duyệt từng bước. Chính Anthropic nói preset giả định "a human is in the loop with access to a full toolset", và với "an agent [that] runs autonomously without a human approving each step" thì nên cân nhắc prompt riêng [D]. paseo-bm **không chọn được** điều đó: Paseo cố định preset + `append` [B 2633–2638]. Codex không có tầng tương đương mà plugin nhìn thấy được.

## 3. R2 — Kích thước và chỗ đứng

| | Ký tự | Token ước tính (ký tự ÷ 4) | Cụm CHỮ HOA | `NEVER` | Bảng (dòng) | Khối ví dụ |
|---|---|---|---|---|---|---|
| `manager.md` | 9.104 | ~2.300 | 7 | 3 | 0 | 0 |
| `worker.md` | 21.220 | ~5.300 | 8 | 4 | 15 | 3 |
| `reviewer.md` | 7.494 | ~1.900 | 11 | 1 | 0 | 3 |
| `AGENTS.md` của repo này (ví dụ file repo) | 15.427 | ~3.900 | 0 | 0 | 9 | 3 |

Ước tính ÷ 4 là thô và thấp hơn thực tế với chữ tiếng Việt; chỉ dùng để so tương đối.

- **Cửa sổ ngữ cảnh khác nhau gấp bốn:** Worker trên Claude có 1.000.000 token ([S] `contextWindowMaxTokens`); Reviewer trên Codex có 258.400. Reviewer lô b1 của request này dùng **110.940 token ngay lượt đầu (43%)** [S] — suy luận: phần lớn là file dự án và skill nó đọc, vì `reviewer.md` chỉ ~1.900 token.
- **Kích thước preset của Claude Code không đo được từ plugin** (suy luận: lớn hơn cả ba file vai trò cộng lại, vì nó mang toàn bộ hướng dẫn công cụ và môi trường). Chỉ dẫn vai trò vì vậy là **phần đuôi** của một system prompt dài — vị trí mà Anthropic nói với Opus 5 vẫn giữ tốt: "its instruction following, tool calling, and reasoning stay consistent throughout the window" [D].

## 4. R3 — Hướng dẫn chính thức nói gì

| Chủ đề | Anthropic — Claude Opus 5 | OpenAI — GPT-5.x / Codex |
|---|---|---|
| Nhấn mạnh, lời lẽ tuyệt đối | Model mới "more responsive to the system prompt… may now overtrigger. The fix is to dial back any aggressive language. Where you might have said 'CRITICAL: You MUST use this tool when…', you can use more normal prompting" | GPT-5: "Be THOROUGH" từng cần cho model cũ nhưng "counterproductive with GPT-5, which is already naturally introspective and proactive" (ví dụ Cursor) |
| Giải thích lý do | "Providing context or motivation behind your instructions… 'NEVER use ellipses' [kém hơn câu có lý do]… Claude is smart enough to generalize from the explanation" | (không có câu tương đương trong các trang đã đọc cho GPT-5.x) |
| Mâu thuẫn giữa các chỉ dẫn | không có mục riêng | "contradictory or vague instructions can be more damaging to GPT-5… expends reasoning tokens searching for a way to reconcile" |
| Nói cái cần làm thay vì cái cấm | "Tell Claude what to do instead of what not to do"; "Positive examples… more effective than instructions about what not to do" | GPT-5.2 dùng cả hai dạng; ưu tiên ràng buộc cụ thể ("Implement EXACTLY and ONLY what the user requests") |
| Ví dụ mẫu | "one of the most reliable ways to steer… Include 3–5 examples", bọc trong `<example>` | định dạng cố định: "Always follow this schema exactly (no extra fields)" |
| Phạm vi | Opus 5 "can also expand the scope of a task… constrain scope explicitly" | GPT-5.2: "No extra features… If any instruction is ambiguous, choose the simplest valid interpretation" |
| Tự kiểm | Opus 5 tự kiểm; "If your prompt contains explicit verification instructions… remove them: instructions like these cause over-verification" | (bài cho GPT-6 Astra — model **không** dùng ở đây — nói model mới tự chạy test; không áp cho 5.6) |
| Agent con | Opus 5 "delegates to subagents more readily"; preset `claude_code` tự thêm một chỉ dẫn uỷ quyền trên Opus 5 | GPT-5.6 "multi-agent behavior is very steerable" (tóm tắt kết quả tìm kiếm; trang gốc trả 403, độ tin thấp hơn) |
| Mức thinking/effort | mặc định `high`; hạ `low`/`medium` khi chất lượng giữ được | Codex: "'medium'… good all-around… `high` or `xhigh` for your hardest tasks"; GPT-5.6 Sol ở `low` "outperforming GPT-5.5 at high" (tóm tắt tìm kiếm, như trên) |
| Cấu trúc | XML tag giúp tách chỉ dẫn / ngữ cảnh / ví dụ | Markdown trong chỉ dẫn không có cảnh báo gì |

Không trang nào của OpenAI đã đọc là "hướng dẫn prompt cho GPT-5.6" riêng; trang "Model guidance" hiện viết cho GPT-6 Astra và chỉ nhắc 5.6 Sol để so sánh. Kết luận về GPT ở báo cáo này vì vậy dựa trên hướng dẫn GPT-5 / 5.2 / Codex — **suy luận** rằng chúng vẫn đúng với 5.6.

## 5. R4 — Trên trace, từng model thật sự làm theo tới đâu

Dữ liệu [T]: **504** lượt sau khử trùng lặp, 7 workspace, 2026-09-16 → 2026-09-18. Manager `claude-opus-5` 244 lượt / 9 agent; Worker `claude-opus-5` 199 lượt / 24 agent; Reviewer `gpt-5.6-sol` 61 lượt / 37 agent. Bộ file vai trò đổi một lần trong khoảng này (viết lại ngày 2026-09-17, delta 20260917c).

| Thước đo | Reviewer — `gpt-5.6-sol` | Worker / Manager — `claude-opus-5` |
|---|---|---|
| Khối kết quả cố định | **61/61** lượt hoàn tất kết thúc bằng `BM-REVIEW` của chính nó, **0** khối thiếu một trong 7 trường; verdict đúng `pass`/`changes-required` ở 59/61 — 2 khối ghép hai lô vào một câu trả lời, cả hai ngày 09-16 | **131** `BM-REPORT`, **0** thiếu trường; 3 báo cáo tự thêm trường lạ (`beadsDeferred`, `beadsBlocked`) |
| Giới hạn "chỉ đọc" (Reviewer) / "không ghi ra ngoài workspace" | **0** file được ghi; nhưng **8** lệnh `npm run build`/`verify` trong 7 lượt (3 workspace, 09-17 → 09-18) — build ghi file ra thư mục build. Ở 6/7 lượt, **tin nhắn giao việc của Worker cho phép thẳng** ("You may run `npm run build`…"); hai repo demo không có `AGENTS.md` nào | **3** file ghi vào `~/.claude/projects/<repo>/memory/` (Manager 2, Worker 1, cùng một workspace, 09-16); 35 lần ghi còn lại ngoài workspace đều nằm trong thư mục `mktemp` được phép |
| Lệnh cần hỏi trước (git ghi, cài phụ thuộc, mạng) | 0 | Worker: 14 lệnh git ghi, 23 lệnh cài phụ thuộc, 34 lệnh mạng. **Trace không cho biết lệnh nào đã được người dùng cho phép** (ví dụ các bead phát hành README do owner yêu cầu commit), nên đây là con số cần kiểm tay, **không** phải số vi phạm. Lượt nghiệm thu có kiểm tay gần nhất (biên bản 20260917c §4) chỉ tìm thấy một lệch: ghi `/tmp` ngoài thư mục `mktemp` |
| Token ra mỗi lượt | 655 | Worker 14.174; Manager 996 |

**Hai con số trông như lỗi model nhưng thật ra không phải:**

- **8 verdict lạ** kiểu `approved | changes-required` mà bộ đọc ghi nhận cho Reviewer ngày 09-16 **không do Reviewer viết**: bộ đọc nhặt chúng từ **tin nhắn yêu cầu review của Worker**, khi đó Worker còn tự dán một mẫu `BM-REVIEW` của riêng nó (có `verdict: approved | changes-required`). Khối của chính Reviewer trong cùng lượt ghi `verdict: pass`. Bản viết lại 09-17 thêm câu "Do not paste the `BM-REVIEW` format" vào `worker.md`; từ đó không còn trường hợp nào. → Lỗi của **Worker với prompt cũ**, cộng một điểm yếu của bộ đọc (đọc cả tin nhắn gửi đi).
- **27/67 review không có `blockingCount`**: bản ghi viết trước khi bộ đọc biết đếm các dòng `severity: blocking` (chú thích trong `plugin/server/bm-report.ts` 390–399). Là giới hạn của bộ thu thập, không phải của model.

## 6. R5 — Nét nào của ba file vai trò tác động khác nhau theo model

| # | Nét | Claude (preset + append) | Codex (developer) | Bằng chứng |
|---|---|---|---|---|
| 1 | **Giới hạn "không ghi ra ngoài workspace" gặp chỉ dẫn bộ nhớ của preset** | Preset bảo agent ghi bộ nhớ ra `~/.claude/projects/…`; `worker.md` rule 1 và `manager.md` không nhắc tới thư mục đó. Hai chỉ dẫn cùng nằm trong system prompt, preset đứng trước | Không có tính năng tương ứng | 3 lần ghi thật ở §5; [Q] mục "# Memory" có trong system prompt của chính Worker này |
| 2 | **"Được chạy gì" của Reviewer gặp tin nhắn giao việc của Worker** | Người viết tin nhắn là Worker trên Claude: nó tự cấp thêm quyền mà `worker.md` không nói nó được cấp | `reviewer.md` (developer) chỉ cho chạy test và lint/typecheck không ghi file; tin nhắn của Worker (user) cho chạy `npm run build`. Hai tầng nói khác nhau — đúng loại mâu thuẫn OpenAI cảnh báo — và Reviewer theo tầng cụ thể hơn | 6/7 lượt build ở §5 có câu cho phép trong tin nhắn. `reviewer.md` đã xử lý xung đột với **skill** ("when a skill says to edit something, report it as a finding"), nhưng chưa nói tin nhắn giao việc có được **nới** danh sách lệnh hay không |
| 3 | **Cụm CHỮ HOA ở mục RULES** (7 / 8 / 11 cụm) | Anthropic khuyên hạ giọng vì model mới "overtrigger" | GPT-5 làm theo "surgical precision"; chữ hoa không có tác dụng được ghi nhận riêng | Không đo được overtrigger: 48/131 báo cáo là `blocked`, nhưng mức Large **bắt buộc** hai vòng hỏi — không kết luận được là hỏi thừa |
| 4 | **Hướng dẫn tự kiểm chứng dày** (bằng chứng cho từng bead, đối chứng âm) | Opus 5: chỉ dẫn "hãy kiểm lại" gây kiểm thừa. Nhưng yêu cầu ở đây là **bằng chứng** cho người khác đọc, không phải "hãy tự kiểm lại" | — | Biên bản 20260917c: Worker tự dựng bản sao và chạy end-to-end, được đánh giá là "kiểm chứng thật", không phải lãng phí |
| 5 | **Agent con** | `worker.md` chỉ cấm agent con song song khi implement; preset tự thêm chỉ dẫn uỷ quyền trên Opus 5 | Reviewer không được tạo agent | Worker gọi agent con của provider 24 lần [T]; không có số chi phí riêng để kết luận |
| 6 | **Mẫu khối cố định có lựa chọn `a \| b`** | Worker giữ đúng mẫu `BM-REPORT` | Reviewer giữ đúng mẫu, không chép nguyên văn `pass \| changes-required` | §5 |
| 7 | **Ví dụ mẫu** (một bead mẫu, một mẫu câu hỏi, một cặp hiệu chuẩn chặn/không chặn) | Đúng hướng Anthropic | Đúng hướng OpenAI | — |

## 7. R6 — Kết luận và đề xuất có thứ tự

**Trả lời câu hỏi của owner:** thuật toán nạp chỉ dẫn **có** khác nhau theo provider (§2), nhưng khác biệt đó **chưa** làm model nào làm sai hợp đồng (§5). Thứ cần tối ưu **không phải văn phong riêng cho từng model**, mà là **những chỗ một tầng chỉ dẫn khác — preset của công cụ, hay tin nhắn giao việc của một agent khác — cãi nhau với file vai trò**. Những chỗ đó khác nhau theo provider, nhưng sửa được bằng **một văn bản chung** cho mọi model.

| # | Đề xuất | Loại | Tác động | Chi phí | Rủi ro | Đo bằng |
|---|---|---|---|---|---|---|
| 1 | Trong giới hạn "không ghi ra ngoài workspace" của `worker.md` và mục giới hạn của `manager.md`, gọi tên **thư mục bộ nhớ của công cụ**: công cụ mời ghi bộ nhớ thì đó vẫn là ghi ra ngoài workspace. Một câu, gộp vào giới hạn đã có — không thêm giới hạn mới (đúng phong cách owner chọn ở delta 20260917c) | Một văn bản cho mọi model | Vừa: chặn lệch có thật ở Claude; vô hại với Codex | Rất thấp | Thấp | Số lần ghi file ngoài workspace, không phải `mktemp`, theo vai trò → 0 ở lượt chạy sau |
| 2 | Cho `worker.md` và `reviewer.md` **nói cùng một câu** về lệnh build/verify của repo: hoặc `reviewer.md` cho phép rõ ("the repository's own build or verify command"), hoặc cả hai nói tin nhắn giao việc không nới được danh sách lệnh của Reviewer. **Owner quyết** cho phép hay không: build chỉ ghi ra thư mục build bị git bỏ qua, nhưng vẫn là ghi | Một văn bản cho mọi model | Vừa: bỏ một mâu thuẫn giữa hai tầng làm GPT tốn token lý luận, và một chỗ lệch với luật chỉ đọc | Rất thấp | Thấp | Số lần Reviewer chạy build; token mỗi lượt review |
| 3 | Đặt **mức thinking** cho profile `bm-reviewer` thay vì để Codex tự chọn — hiện là `xhigh` dù paseo-bm không đặt [S]. Thử `high` rồi `medium` trên cùng một fixture | Cấu hình riêng cho provider | Có thể lớn về thời gian và tiền của Reviewer | Thấp (màn Setup đã có ô thinking) | Vừa: có thể bắt ít lỗi hơn | Số mục chặn tìm được, token, thời gian trên cùng fixture |
| 4 | **Hạ giọng** các cụm CHỮ HOA ở mục RULES thành câu thường kèm lý do. **Chỉ làm dưới dạng thử có đo**, không làm mù: lượt đo 20260917c với bản hiện tại là lượt duy nhất không có lỗi chặn | Một văn bản cho mọi model | Chưa biết | Thấp | Vừa: có thể nới một lan can đang chạy tốt | So một lượt chạy trên fixture 20260917c |
| 5 | Thêm một câu vào `worker.md` về **khi nào dùng agent con** (việc lớn, độc lập, song song), như Anthropic gợi ý cho Opus 5 | Một văn bản; tác dụng chủ yếu ở Claude | Chưa biết | Rất thấp | Thấp | Số agent con của provider và chi phí Worker mỗi request |
| 6 | Ghi vào tài liệu vận hành: **sửa file vai trò chỉ có tác dụng với agent tạo sau đó** (Claude ghi lại system prompt ở request đầu; Codex dùng giá trị chốt lúc tạo) | Không đổi chữ | Tránh đo nhầm sau khi sửa | Không | Không | — |

**Không đề xuất:** tách `plugin/roles/*.md` thành biến thể theo provider. Lý do: (1) không có bằng chứng model nào hỏng vì văn phong; (2) mỗi vai trò chỉ chạy một model nên chưa có dữ liệu để tối ưu riêng; (3) hai bản nghĩa là gấp đôi file phải giữ đồng bộ, gấp đôi test nội dung, và hook `before("agent.create")` phải chọn bản theo provider nền. Nếu owner vẫn muốn đi hướng này, bước đúng đầu tiên là **một lượt chạy đổi model** — Reviewer bằng Claude và Worker bằng GPT trên cùng fixture — để có số liệu tách được model khỏi vai trò.

**OpenCode.** Paseo đưa chỉ dẫn vai trò vào trường `system` của OpenCode [B 2511–2522]. Dự án chưa chạy vai trò nào trên OpenCode, nên không có trace và không có kết luận. Đề xuất 1 và 2 viết cho mọi model, nên vẫn áp dụng được nếu sau này dùng OpenCode.

## 8. Nguồn

Tài liệu công khai, đọc ngày 2026-09-18:

- Anthropic — [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- Anthropic — [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) (mục *Add context to improve performance*, *Control the format of responses*, *Tool usage*, *Subagent orchestration*, *Migration considerations*)
- Anthropic — [Modifying system prompts (Agent SDK)](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)
- OpenAI — [GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)
- OpenAI — [GPT-5.2 Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-2_prompting_guide)
- OpenAI — [Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)
- OpenAI — [Model guidance](https://developers.openai.com/api/docs/guides/latest-model) (viết cho GPT-6 Astra; nhắc GPT-5.6 Sol)
- OpenAI — [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra) (model không dùng ở đây; chỉ để đối chiếu)
- OpenAI — [The builder's guide to GPT-5.6](https://openai.com/index/builders-guide-to-gpt-5-6/): trang trả **403**; hai ý trích ở §4 lấy từ đoạn tóm tắt của kết quả tìm kiếm, độ tin thấp hơn

Nguồn cục bộ:

- Bundle Paseo 0.8 — `server/agent/providers/claude/agent.js` 38–42, 2588–2590, 2633–2638; `server/agent/providers/codex-app-server-agent.js` 2716–2718, 2879–2881, 3013–3015, 3947–3958; `server/agent/providers/opencode-agent.js` 2511–2522, 2788–2803; `server/agent/agent-manager.js` 377, 3606–3615; `server/bootstrap.js` (`appendSystemPrompt`)
- Snapshot: Worker `29e658b5` (`claude-opus-5`, cửa sổ 1.000.000); Reviewer `2998dc82` (`gpt-5.6-sol`, thinking hiệu lực `xhigh`, mode `auto`, collaboration mode `Default`, cửa sổ 258.400, 110.940 token ở lượt đầu)
- Kho vết `~/.paseo-bm/traces/*/events-202609.jsonl` (504 lượt, 7 workspace)
- `plugin/roles/{manager,worker,reviewer}.md` bản hiện tại; `git show 1f7f034:plugin/roles/worker.md` (bản 09-15, cho phép thêm phase `documents-done` và `bead-implemented`); `plugin/server/bm-report.ts` 390–399
- `docs/archive/operations/paseo-bm-context-engineering-run-20260917c.md` §2, §4, §5
