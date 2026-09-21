# Đề xuất — Worker dự phòng khi hết hạn mức, cấu hình model/thinking trong Beads Manager, hỗ trợ OpenCode và Pi

| Trường | Giá trị |
|---|---|
| Mã | `proposal-20260921-worker-fallback-and-role-settings` |
| Request | `req-20260921T082908Z` |
| Status | **Decided** — owner chốt ngày 2026-09-21 ở `req-20260921T111242Z` (Q1–Q5: D1 a, D2 a, D3 a, D4 a; D5–D7 thay bằng "mọi provider cho mọi vai trò"; vòng hai Q6 a, Q7 a, Q8 c — dự phòng cho **cả ba** vai trò, nên mục "Dự phòng cho Manager và Reviewer" ở §8 không còn là ngoài phạm vi). Triển khai theo [PRD delta](../product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md), [design delta](./paseo-bm-delta-20260921-worker-fallback-and-role-settings.md), [ADR-008](../adr/ADR-008-role-settings-written-by-plugin.md), [plan delta](../plans/paseo-bm-implementation-plan-delta-20260921-worker-fallback-and-role-settings.md). Tài liệu này giữ làm nguồn sự thật đã kiểm (§1), không sửa thêm |
| Owner | hieu.nt10 |
| Người viết | Beads Worker (`claude-opus-5`), 2026-09-21 |
| Beads | `bm-worker-fallback-facts-zue3` (T1), `bm-worker-fallback-mechanism-kede` (T2), `bm-worker-fallback-providers-faj5` (T3), `bm-worker-fallback-role-settings-agwa` (T4), `bm-worker-fallback-roadmap-clcz` (T5), `bm-worker-fallback-provider-split-t74x` (T6) |
| Tính chất | **Chỉ phân tích và đề xuất.** Không đổi mã, cấu hình Paseo, chỉ dẫn vai trò hay tài liệu Accepted/Active. Triển khai là một request sau, khi owner đã chốt các quyết định ở cuối tài liệu |

## Owner nói gì

> Tôi đang muốn cải tiến tiếp cho plugin của mình:
> 1. Nếu tôi muốn có cơ chế fallback nếu Worker đang làm việc gặp vấn đề với Usage limit / Subscription ... , cấu hình trong màn hình Beads Manager để chỉ định Model / Think level cho Worker khi làm việc , ngoài Claude Code, Codex . Tôi cần support thêm OpenCode và Pi
> 2. Nếu tôi muốn sau khi thiết lập cài đặt npx paseo-bm thì trong Beads Manager cho phép cấu hình điều chỉnh lại nếu cần thiết
>
> Bạn hãy phân tích đánh giá yêu cầu này và đưa ra đề xuất để chúng ta nâng cấp phiên bản của mình.

## Routing Decision

- Variant preset: brownfield
- Triggered risks: none cho **tài liệu này** (chỉ phân tích). Phần triển khai mà nó đề xuất sẽ chạm hợp đồng công khai (`install.json` `roles[]`, RPC của plugin), cấu hình lưu bền (`~/.paseo/config.json`, file mới của paseo-bm), quyền (mode của provider mới, Reviewer chỉ-đọc) và nhiều thành phần độc lập (CLI, plugin server, plugin client, chỉ dẫn vai trò) → **Large** khi triển khai
- Required artifacts/gates: tài liệu đề xuất này; review lô b1 (brief và beads) và b2 (tài liệu). Không có cổng PRD/design/plan cho tài liệu này
- Execution path: manual tracking (5 bead viết tay, nguồn là brief dưới đây)
- Exceptions: none
- Decided: 2026-09-21 — Beads Worker, cỡ **Medium** (Manager đoán sơ bộ Large; sản phẩm của request chỉ là tài liệu)
- Supersedes: none

## Brief

**Phạm vi:** đánh giá hai nhóm yêu cầu của owner trên Paseo 0.8 và mã paseo-bm 0.2.0-alpha.1, rồi đề xuất cách nâng cấp: Worker dự phòng khi gặp giới hạn dùng hay lỗi gói đăng ký; chọn model và mức thinking cho Worker trong màn Beads Manager; chạy vai trò trên OpenCode và Pi ngoài Claude Code và Codex; cấu hình lại vai trò trong Beads Manager sau khi đã cài bằng `npx paseo-bm`.

**Ngoài phạm vi:** viết mã; sửa PRD/design/plan/ADR đang Accepted hay Active; tạo bead triển khai; đổi cấu hình của daemon; cài hay chạy thử OpenCode/Pi; dùng mạng.

**Cách làm:**
- Kiểm trên daemon thật **chỉ đọc** (liệt kê provider, mode, model), đọc bundle Paseo 0.8 và SDK plugin trong `node_modules/@getpaseo`, đọc mã và tài liệu của repo.
- Mọi khẳng định có nguồn; điều là suy luận hay chưa kiểm thì ghi rõ.
- Mỗi đề xuất có ít nhất ba phương án, chi phí, rủi ro, và đúng một khuyến nghị; quyết định thuộc về owner.

**Nhiệm vụ:**
- T1: Kiểm chứng khả năng Paseo 0.8 cho dự phòng Worker, OpenCode/Pi và cấu hình lại từ plugin → mục "Sự thật đã kiểm" (`bm-worker-fallback-facts-zue3`)
- T2: Đề xuất cơ chế Worker dự phòng khi hết hạn mức hoặc lỗi gói đăng ký → mục "Dự phòng Worker" (`bm-worker-fallback-mechanism-kede`)
- T3: Đề xuất hỗ trợ OpenCode và Pi cho các vai trò → mục "OpenCode và Pi" (`bm-worker-fallback-providers-faj5`)
- T4: Đề xuất cấu hình lại vai trò trong Beads Manager sau khi cài: provider, model, thinking, chuỗi dự phòng → mục "Cấu hình lại vai trò" (`bm-worker-fallback-role-settings-agwa`)
- T5: Tổng hợp: kết luận ngắn, lộ trình phiên bản, rủi ro, các quyết định owner cần chốt (`bm-worker-fallback-roadmap-clcz`)

Thứ tự: T1 trước; T2 và T3 sau T1; T4 sau T1, T2, T3; T5 cuối cùng.

Sau review, theo góp ý của owner (2026-09-21, lô b3):
- T6: Sửa mọi chỗ coi Manager và Worker là **luôn dùng chung một gói**. Đó chỉ là cấu hình hiện tại, và mỗi vai trò chọn được provider riêng. Phân tích dự phòng phải xét cả hai trường hợp cùng và khác provider gốc (`bm-worker-fallback-provider-split-t74x`)

**Kiểm:** mỗi mục truy được về bảng Sự thật đã kiểm; mọi tham chiếu tới REQ, ADR, tệp và API đều có thật (kiểm bằng grep); review lô b2 trên toàn tài liệu.

## 0. Kết luận ngắn

1. **Phần lớn yêu cầu làm được trên Paseo 0.8 mà không cần Paseo đổi gì.** Plugin thấy được lượt lỗi của Worker (S1), tự tạo được agent (S7), đổi được provider/model/thinking/mode lúc tạo agent (S8), đọc được hạn mức của Claude và Codex (S6), và ghi được cấu hình qua RPC của Paseo (S10).
2. **Dự phòng Worker nên do mã của plugin điều khiển, không trông hoàn toàn vào Manager.** Manager chỉ hết hạn mức cùng Worker khi hai vai trò chạy **cùng provider gốc**, vì alias dùng chung phiên đăng nhập và hạn mức của provider gốc (M14, M17). Đó là cấu hình hiện tại trên máy owner (cả hai extends `claude`, §1.1), nhưng không bắt buộc: mỗi vai trò chọn được provider riêng. Plugin không biết trước người dùng chọn thế nào, nên cơ chế phải chạy được trong cả hai trường hợp (§2.1). Khuyến nghị: plugin phát hiện rồi hiện **thẻ "Hỏi tôi"** với ba nút — chuyển sang provider dự phòng, chờ tới giờ reset rồi làm tiếp, hoặc để người dùng tự xử lý. Chế độ **tự động** để sau, khi đã thấy một sự cố thật: trên máy owner chưa từng có lượt nào hết hạn mức (§1.5), nên chưa biết chắc thông báo trông ra sao.
3. **Chọn model/thinking cho Worker phần lớn đã làm được trong màn Settings → Agent profiles của Paseo** (S11). Nhưng paseo-bm đang làm rơi thinking khi tạo Worker và Reviewer (M8), và mỗi lần cài lại thì xoá mất (M3). Sửa hai chỗ đó là bước 1, nhỏ và có giá trị ngay. Màn "Vai trò & model" ngay trong Beads Manager là bước 3 (§4).
4. **OpenCode: làm được cho Worker, có điều kiện cho Reviewer** (§3). OpenCode có công cụ Paseo, nhưng hôm nay bị chặn bởi cách paseo-bm chọn mode (M6, M7): Reviewer trên OpenCode còn bị từ chối tạo (suy luận từ mã, M7).
5. **Pi: Worker chỉ chạy được khi máy có `pi-mcp-adapter`**, mà máy owner chưa có (P4, P5). Thiếu nó, Worker Pi vẫn được tạo nhưng không có công cụ Paseo — không báo được Manager, không tạo được Reviewer. Reviewer trên Pi làm được về kỹ thuật, nhưng Pi không hỏi quyền khi chạy công cụ (P6), còn sandbox thì chưa kiểm (§1.6). Vì vậy không khuyến nghị Reviewer Pi cho bản này (§3.4, phương án V2).
6. **Chưa làm được hôm nay:** plugin đổi model của Worker **đang chạy** (S9); nhận dạng "hết hạn mức" bằng mã lỗi thay vì bằng chữ (S5); hạn mức của OpenCode và Pi (S6). Ba điều này là đề nghị gửi Paseo (§5.2).
7. **Triển khai là việc Large**, chia 5 bước phát hành (§5). Nó chạm ADR-004, ADR-006, design §3.2/§3.4 và PRD REQ-027(d)/REQ-028 (§4.7). Owner cần chốt **7 quyết định ở §7** trước khi bắt đầu.

## 1. Sự thật đã kiểm (T1)

Ký hiệu nguồn:
- **[D]** đọc trên daemon thật của owner ngày 2026-09-21 bằng công cụ MCP chỉ đọc của Paseo (`list_providers`, `inspect_provider`, `list_models`, `list_profiles`).
- **[SDK]** kiểu của `@getpaseo/plugin`, `@getpaseo/client`, `@getpaseo/protocol` 0.8.0 trong `node_modules/`.
- **[B]** bundle Paseo 0.8 (`/Applications/Paseo.app/Contents/Resources/app.asar`). Đường dẫn ghi tương đối với `@getpaseo/server/dist/server/` trong bundle, kèm số dòng; riêng giao diện app ghi từ `Contents/Resources/`. File được trích ra một thư mục `mktemp -d` để đọc rồi xoá.
- **[CLI]** `paseo … --help`.
- **[M]** mã paseo-bm 0.2.0-alpha.1, `file:dòng`.
- **[A]** tài liệu trong `docs/`.
- **[T]** kho vết `~/.paseo-bm/traces` và bản ghi agent `~/.paseo/agents`. Chỉ đếm trường, không đọc nội dung hội thoại.
- **[F]** danh sách **tên file** trong `~/.pi/agent`. Không mở `auth.json`.

Điều gì là **suy luận** thì ghi rõ.

### 1.1 Provider Paseo 0.8 có trên máy owner

| Provider | Trạng thái | Mode | Feature | Model và thinking |
|---|---|---|---|---|
| `claude` | available | `plan`, `default`, `acceptEdits`, `auto`, `bypassPermissions` — có `colorTier` | — | 15 model; `claude-opus-5` thinking `off`…`max`, `ultracode`, mặc định `high` [D] |
| `codex` | available | `auto`, `auto-review`, `full-access` — có `colorTier` | — | `gpt-5.6-sol/terra/luna`, `gpt-5.5`; thinking `low`…`max` (`ultra` ở sol/terra), mặc định `xhigh` [D] |
| `opencode` | available | **là các agent trong cấu hình OpenCode của người dùng** — máy owner chỉ có `bytes`, **không có `colorTier`** | toggle `auto_accept` (mặc định tắt): "Automatically approves OpenCode tool permission prompts" | 129 model qua 7 nhà cung cấp con: google 38, github-copilot 30, kiro 24, anthropic 16, openai 13, opencode 7, dx-ai-dev 1. Mức thinking **khác nhau theo model**: 40 model không có, còn lại là các tổ hợp `default/none/minimal/low/medium/high/xhigh/max`. Có `metadata.cost` theo triệu token [D] |
| `pi` | available | **không có mode nào** | không có | Máy owner có 1 model (`dx-ai-dev/Qwen/Qwen3.6-35B-A3B-FP8`), `thinkingOptions: null` [D]. Pi chỉ cho 7 mức `off`…`max` (mặc định `medium`) với model được Pi đánh dấu `reasoning` [B `server/agent/providers/pi/agent.js` 87–94, 875, 22] |
| `copilot`, `omp` (Oh My Pi) | unavailable / omp bị tắt | — | — | [D] |
| `bm-manager`, `bm-worker` | extends `claude` | như `claude` | — | profile: `claude-opus-5`, **không** `thinkingOptionId`, **không** `modeId` [D] |
| `bm-reviewer` | extends `codex` | như `codex` | — | profile: `gpt-5.6-sol`, không thinking, không mode [D] |

### 1.2 Pi và OpenCode trong daemon

| # | Sự thật | Nguồn |
|---|---|---|
| P1 | Provider dẫn xuất (`agents.providers.<id>.extends`) nhận **mọi** provider có sẵn trong Paseo, kể cả `opencode` và `pi`. Không có danh sách cho phép; chỉ báo lỗi khi `extends` trỏ tới provider không tồn tại | [B `server/agent/provider-registry.js` 517–520] |
| P2 | Công cụ Paseo đến agent qua một **MCP server HTTP tên `paseo`**, daemon gắn vào `config.mcpServers` lúc khởi chạy (`?callerAgentId=<id>`) | [B `server/agent/runtime-mcp-config.js`; `server/agent/agent-manager.js` 3593–3599] |
| P3 | **OpenCode nhận MCP** (`supportsMcpServers: true`), nên có công cụ Paseo | [B `server/agent/providers/opencode-agent.js` 42] |
| P4 | **Pi chỉ nhận MCP khi máy có extension `pi-mcp-adapter`.** Mỗi lần tạo agent, daemon chạy thử Pi và tìm lệnh `mcp` của extension đó. Không thấy thì bỏ qua toàn bộ `mcpServers`, **không báo lỗi** — agent vẫn được tạo nhưng không có công cụ Paseo | [B `server/agent/providers/pi/agent.js` 80, 2201–2227, 514–522; `server/agent/agent-manager.js` 2432–2439] |
| P5 | Máy owner **chưa có** `pi-mcp-adapter`: `~/.pi/agent/npm/node_modules` chỉ có `pi-context`, `extensions/` chỉ có `herdr-agent-state.ts`. Đây là **suy luận từ tên file**, chưa kiểm bằng một lần chạy | [F] |
| P6 | Pi **không có mode và không hỏi quyền khi chạy công cụ**. `getAvailableModes()` trả `[]`, `setMode` ném lỗi; "permission" của Pi chỉ là câu hỏi của extension UI. Suy luận: agent Pi luôn chạy như chế độ không hỏi quyền | [B `server/agent/providers/pi/agent.js` 1103–1111, 663–715] |
| P7 | Pi **tự thử lại** khi provider lỗi (`auto_retry_start`, "Provider retry (attempt N)") trước khi báo lượt thất bại | [B `server/agent/providers/pi/agent.js` 742, 1820–1842] |
| P8 | Paseo đưa chỉ dẫn vai trò vào Pi bằng một **extension tạm** nối `systemPrompt` vào system prompt của Pi | [B `server/agent/providers/pi/agent.js` 370–450, 2031] |
| P9 | Máy owner đã có đủ 5 skill workflow trong `~/.pi/agent/skills` (`converting-plan-to-beads`, `feature-workflow`, `implementing-beads`, `polishing-beads`, `reviewing-plan`) | [F] |
| P10 | OpenCode: khi agent cha đang chạy không hỏi quyền và không truyền mode, daemon **bật `auto_accept`** và để mode trống (OpenCode dùng agent mặc định của nó). Truyền một mode không có trong danh sách thì bị từ chối (`Invalid mode`) | [B `server/agent/providers/opencode-agent.js` 140–165; `server/agent/create-agent-mode.js`] |
| P11 | Luật chọn mode khi tạo agent con: mode tường minh phải nằm trong danh sách, không thì báo `Invalid mode`. Cùng provider với cha thì thừa kế mode của cha. Cha chạy không hỏi quyền thì lấy mode `isUnattended` của đích. Provider **không có mode nào thì bỏ trống, không lỗi**. Còn lại báo `cannot inherit mode … Pass an explicit mode` | [B `server/agent/create-agent-mode.js`] |

### 1.3 Plugin quan sát và làm được gì

| # | Sự thật | Nguồn |
|---|---|---|
| S1 | `on("agent.turn_ended")` nhận `outcome` là `completed`, `failed` (kèm `error: { message, code? }`) hoặc `canceled`, cùng `timeline` của lượt đó | [SDK `@getpaseo/plugin/dist/server/lifecycle.d.ts` 32–54] |
| S2 | Khi một lượt thất bại, daemon ghi `agent.lastError = event.error` và thêm một dòng lỗi hệ thống vào timeline. Agent ở trạng thái `error` chỉ khi lượt đó chạy nền | [B `server/agent/agent-manager.js` 3095–3119] |
| S3 | **Claude:** lượt chỉ `failed` khi kết quả của SDK **không** phải `success`. Khi đó `error` là nội dung lỗi, `code` chỉ lấy từ "exit code", stderr nằm ở `diagnostic`. Kết quả `success` luôn thành `completed`; nếu lượt có 0 token ra và chưa có chữ nào thì chữ của kết quả được đưa lên thành một tin nhắn assistant. **Suy luận, chưa kiểm trên sự cố thật:** thông báo hết hạn mức của Claude Code có thể tới dưới dạng một lượt `completed` mà tin nhắn cuối là câu thông báo, chứ không phải lượt `failed` | [B `server/agent/providers/claude/agent.js` 2763–2775, 3600–3627] |
| S4 | **Codex:** lượt `failed` mang `error = turn.error.message` của Codex, **không có mã lỗi**. `codexErrorInfo` không được chuyển tiếp | [B `server/agent/providers/codex-app-server-agent.js` 1863, 4644–4649] |
| S5 | Không provider nào của Paseo tự phân loại "hết hạn mức". Muốn biết thì phải so **chữ** của lỗi | [B, tìm `usage limit`, `rate_limit`, `quota`, `429` trong bốn adapter: không có] |
| S6 | `paseo.providers.listUsage()` trả hạn mức theo gói: `windows[]` gồm `{ usedPct, remainingPct, resetsAt, runsOutAt }` và `balances[]`. Dữ liệu chỉ có cho **claude, codex**, copilot, cursor, zai, grok, kimi, minimax; **không có opencode và pi**. Daemon **gọi mạng** tới nhà cung cấp bằng phiên đăng nhập của nó (`https://api.anthropic.com/api/oauth/usage` với các cửa sổ `five_hour`, `seven_day`, `seven_day_opus`…; `https://chatgpt.com/backend-api/wham/usage`) và cache 5 phút | [SDK `@getpaseo/client/dist/index.d.ts` `PaseoProviderActions`; `@getpaseo/protocol/dist/messages.d.ts` 14637–14780; B `services/quota-fetcher/manifest.js`, `services/quota-fetcher/service.js` 3, `services/quota-fetcher/providers/claude.js` 22–63, 354, `services/quota-fetcher/providers/codex.js` 15–71, 151] |
| S7 | `paseo.agents.create({ config: { provider, modeId, thinkingOptionId, featureValues, systemPrompt, mcpServers }, cwd, parent, labels, prompt })` — plugin tự tạo được agent. Agent do plugin tạo **vẫn đi qua** `before("agent.create")` | [SDK `@getpaseo/client/dist/index.d.ts` 140–166; B `server/agent/agent-manager.js` 655–664] |
| S8 | `before("agent.create")` **được đổi cả `provider`**, model, thinking, mode, feature. Chỉ `cwd` là không đổi được. Daemon lấy provider từ config hook trả về | [B `server/plugins/lifecycle/index.js` 106–111; `server/agent/agent-manager.js` 659–668] |
| S9 | Đổi model hay thinking của agent **đang có**: công cụ MCP `update_agent` nhận `settings.model`, `thinkingOptionId`, `modeId`, `features`. CLI `paseo agent update` chỉ có `--thinking`, không có `--model`. SDK plugin không có hàm đổi | [MCP schema `update_agent`; CLI; SDK `PaseoAgentHandle`] |
| S10 | `paseo.config.patch()`: mục `providers` được **gộp sâu**, giữ `extends` và `label`, và provider registry cập nhật **ngay**, không cần reload. `agentProfiles` là mảng nên **bị thay cả mảng**. Ghi xuống file trước, lỗi thì trả lại file cũ. Lời gọi **không mang phiên bản hay điều kiện nào** (`patch(config, requestId?)`): daemon gộp vào cấu hình nó đang giữ rồi ghi, nên không có cơ chế so-rồi-ghi | [SDK `@getpaseo/protocol/dist/messages.d.ts` 154–213; B `server/daemon-config-store.js` 10–23, 153–178, 231–261; `server/agent/mutable-provider-config-owner.js`] |
| S11 | App Paseo **đã có** màn **Settings → Agent profiles** sửa được Name, Icon, Provider, Model, Mode, Thinking, Features, "When to use" của từng profile, kể cả `bm-*` | [B `Contents/Resources/app-dist/_expo/static/js/web/index-*.js`, chuỗi `agentProfiles.*`] |
| S12 | Plugin settings (`defineSettings`) chỉ phía client đọc được; server không có API đọc | [A `docs/design/paseo-bm-delta-20260916-setup-screen.md` §2] |
| S13 | Handle agent của SDK có `send(text)` (gửi như một tin nhắn), `timeline.refetch()` (đọc lại timeline) và `timeline.append()` (thêm một mục của plugin), cùng `lastError`, `status`, `capabilities` (ví dụ `supportsMcpServers`); **không** có `cancel` hay hàm đổi model/mode | [SDK `@getpaseo/client/dist/index.d.ts` `PaseoAgentHandle`, `PaseoAgentTimelineHandle`] |

### 1.4 paseo-bm hôm nay

| # | Sự thật | Nguồn |
|---|---|---|
| M1 | Trình cài ghi `agents.providers.bm-<vai trò>` = `{ extends, label }`, cộng `paseoTools.enabled` cho Manager và Worker, cùng profile `{ id, name, provider, model, notes }`. **Không bao giờ** ghi `modeId`, `thinkingOptionId` | [M `src/roles/register.ts` 91–147] |
| M2 | Trình cài nhận **mọi** provider Paseo liệt kê (chỉ kiểm dạng tên), nên `--role worker=opencode/<model>` hay `pi/<model>` qua được bước cài | [M `src/roles/config.ts` 64, 379–420] |
| M3 | Cài lại **thay nguyên** mục `bm-*` khi khác trước. Thinking, mode hay `disabledTools` người dùng tự đặt trên `bm-*` (kể cả qua màn Agent profiles của Paseo) **bị mất** ở lần cài có ghi kế tiếp | [M `src/paseo/config.ts` 680–684, 722–734] |
| M4 | `install.json` `roles[]` = `{ role, providerId, profileId, baseProvider, model, modeId: null, thinkingOptionId: null, paseoTools }` | [M `src/roles/config.ts` 704–715; A design §3.2] |
| M5 | Vai trò được nhận ra bằng **đúng ba** tên provider `bm-manager`, `bm-worker`, `bm-reviewer` (nhãn `bm.role` ưu tiên khi có). Hook `agent.create` không thấy nhãn nên **chỉ** dựa vào provider | [M `plugin/server/agent-role.ts` 38–58; `provider-id.ts`] |
| M6 | Mode được chọn theo `colorTier`: Worker lấy mode `dangerous` đầu tiên, rồi `moderate`, rồi `safe`. Reviewer lấy `auto`, rồi `moderate` không "full/network", rồi `safe`. Provider không có `colorTier` (OpenCode của owner) hay không có mode (Pi) cho ra **không mode nào** | [M `plugin/server/role-mode.ts` 60–110] |
| M7 | Khi không đọc được danh sách mode, Worker được dặn mode Reviewer là `auto`. **Suy luận từ P10–P11:** với Reviewer trên OpenCode hay Pi, `auto` không có trong danh sách nên daemon sẽ từ chối tạo (`Invalid mode`) | [M `plugin/server/role-extras.ts` 69–70] |
| M8 | Mục `## Runtime facts` chỉ nói **mode** của agent con, không nói model hay thinking. Manager và Worker truyền `bm-worker/<model>` (`bm-reviewer/<model>`) lấy từ `list_profiles`, **không truyền thinking**. Chỉ `manager.ensure` dùng `thinkingOptionId` của profile | [M `role-extras.ts` 76–82; `plugin/roles/manager.md` 91–99; `worker.md` 313–317; `manager.ts` 102–124, 272–277] |
| M9 | Plugin **bỏ qua mọi lượt `failed`**: phần lan truyền dừng chỉ xử lý `canceled`. Không có watchdog, không thử lại, không dự phòng provider. `manager.md` chỉ dặn báo người dùng khi Worker lỗi | [M `plugin/server/stop-propagation.ts` 121–127; `plugin/roles/manager.md` 62–65, 161–163] |
| M10 | Công cụ Paseo tới vai trò nhờ công tắc chung `daemon.mcp.injectIntoAgents` cộng `paseoTools` trên alias. Hook không thêm MCP server | [M `src/commands/install/enable.ts` 75; `plugin/server/role-hook.ts` 74, 102] |
| M11 | Màn Setup hôm nay có: chỉ dẫn bổ sung theo vai trò (`role-extras.json`), trạng thái skill (**chỉ cột Claude và Codex**), cài `br`/`bv`. Provider và model của vai trò **chỉ hiện để đọc**. Plugin không ghi cấu hình Paseo; lệnh `paseo` duy nhất nó chạy là `agent mode` và `agent update --label` | [M `plugin/server/setup-skills.ts` 29–30; `plugin/client/agent-tree.ts` 210–212; `plugin/server/paseo-cli.ts` 82–114] |
| M12 | Chỗ gắn cứng claude/codex: lệnh đăng nhập (có cho claude, codex, opencode; **không có pi**) và chỉ đọc được `loggedIn` của Claude; bảng giá chỉ có model Claude (model khác chỉ hiện token); nhận diện "đã nạp skill" theo công cụ `Skill` của Claude hoặc việc đọc `SKILL.md`; cột skill, cờ `--claude-home`/`--codex-home`, mặc định `--skills-agents claude,codex` | [M `src/roles/login.ts` 60–84, 113–122; `plugin/shared/prices.ts` 54–62; `plugin/server/collector.ts` 165–192; `src/flags.ts` 194–209] |
| M13 | Quy tắc "một Worker cho mỗi request": thẻ chat và pill chỉ nhận một Worker sống mang `bm.requestId`. Có hai Worker sống cùng request thì **không** nhận ai. Ngân sách review được đếm theo `requestId` từ kho vết, nên đi theo request chứ không theo Worker | [M `plugin/shared/sole-worker.ts`; `plugin/server/review-budget.ts` 67–85] |
| M14 | ADR-004 quyết định 1, 4, 8: tích hợp Paseo qua CLI; sửa `config.json` chỉ khi có đồng ý, theo kiểu đọc-sửa-ghi tối thiểu có backup và reload; ADR-004 §Context loại `config.patch` vì nó **thay cả mảng** `agentProfiles`. ADR-006 quyết định 5: không bao giờ thay cả mảng. §Hệ quả: provider dẫn xuất **kế thừa hạn mức và phiên đăng nhập** của provider gốc — gốc hỏng thì mọi vai trò trên gốc đó hỏng | [A ADR-004, ADR-006] |
| M16 | `doctor` chỉ kiểm mỗi vai trò **có mặt** (alias và profile) và `paseoTools` khớp hồ sơ; **không** so `extends`, model hay thinking. Mọi mục có id bắt đầu bằng `bm-` được coi là của paseo-bm (lệnh gỡ dùng cùng luật) | [M `src/commands/doctor.ts` 748–790; `src/paseo/config.ts` 55, 789] |
| M17 | **Mỗi vai trò có provider gốc riêng.** Trình cài hỏi provider và model cho từng vai trò (REQ-027a) và nhận `--role <vai trò>=<provider>/<model>` lặp lại được, nên `bm-manager` và `bm-worker` extends cùng hay khác provider là do người dùng chọn. Màn Agent profiles của Paseo cũng đổi được (S11). Alias không có `command` hay `env` riêng, tức không có phiên đăng nhập riêng (ADR-006 QĐ 2). Vì vậy hai vai trò **cùng provider gốc** dùng chung phiên đăng nhập và hạn mức (M14); **khác provider gốc** thì khác gói. `manager.ensure` chạy được Manager trên Claude và Codex (lấy mode `dangerous` đầu tiên: `bypassPermissions`, `full-access`). Trên máy owner hôm nay, Manager và Worker cùng extends `claude` (§1.1) | [M `src/flags.ts` 125–131; `src/roles/config.ts` 108–166; A PRD REQ-027; ADR-006 QĐ 2; design §2.6 errata 2026-09-18] |
| M15 | PRD đã có **REQ-028 (P2, chưa làm)**: đổi tên, công cụ, model từng vai trò mà không cài lại, áp cho Worker tạo sau. Design §4.1 có lệnh `paseo-bm configure` (P2, chưa làm) | [A `docs/product/paseo-bm-prd.md` REQ-028; `docs/design/paseo-bm.md` §4.1] |

### 1.5 Đã từng hết hạn mức thật chưa

- Kho vết: **989** bản ghi lượt — `completed` 889, `canceled` 100, **`failed` 0** [T].
- Bản ghi agent: **328** agent. `attentionReason` chỉ có `finished` hoặc trống; **không agent nào có `lastError`**. Không tìm thấy chuỗi "usage limit", "hit your limit", "limit reached", "rate_limit_error" [T].
- **Kết luận:** trên máy owner, đường lỗi hết hạn mức **chưa từng xảy ra**, nên chưa quan sát được hình dạng thật của nó. Mọi cơ chế phát hiện đề xuất dưới đây phải được kiểm trên một sự cố thật, hoặc bằng provider giả trong test, trước khi coi là xong.

### 1.6 Chưa kiểm được

| Điều | Vì sao chưa | Cách kiểm |
|---|---|---|
| Nguyên văn thông báo hết hạn mức của Claude Code và Codex 0.8, và lượt đó là `completed` hay `failed` | Chưa có sự cố thật (§1.5). Nhị phân Claude trong bundle không đọc được | Ghi lại lượt đầu tiên gặp hạn mức; hoặc đọc log daemon (`handleStreamEvent: turn_failed` có `error`, `code`, `diagnostic`) |
| Agent Pi có thật sự thiếu công cụ Paseo trên máy owner | P5 chỉ suy từ tên file | Tạo một agent Pi rồi hỏi nó liệt kê công cụ (việc của request triển khai, có đồng ý của owner) |
| Màn Agent profiles của Paseo sửa được alias `bm-*` và `extends` hay chỉ sửa profile | Chỉ đọc chuỗi giao diện | Mở Settings của app |
| Pi có sandbox, hay giới hạn ghi file và mạng nào, ngoài việc không hỏi quyền (P6) | Chỉ đọc adapter Pi của Paseo; không đọc tài liệu Pi vì không dùng mạng | Đọc tài liệu Pi, hoặc chạy thử một agent Pi trong thư mục tạm (có đồng ý của owner) |

## 2. Dự phòng Worker (T2)

### 2.1 Bài toán thật

- **Manager có hết hạn mức cùng Worker hay không là do cấu hình.** Alias `bm-*` không có phiên đăng nhập riêng; nó kế thừa phiên đăng nhập và hạn mức của provider gốc (M14, M17). Có hai trường hợp:
  - **Cùng provider gốc** — cấu hình hiện tại trên máy owner, cả hai extends `claude` (§1.1). Hai vai trò dùng chung gói: phiên 5 giờ hay hạn mức tuần hết thì lượt kế tiếp của **Manager cũng hỏng**. Cơ chế nào trông vào Manager sẽ hỏng đúng lúc cần nó.
  - **Khác provider gốc** — ví dụ Manager trên Codex, Worker trên Claude. Manager vẫn chạy, còn báo được và trả lời được người dùng. Cấu hình này đã làm được hôm nay (M17).

  Mỗi vai trò chọn được provider riêng, và plugin không biết trước người dùng chọn gì. Vì vậy cơ chế dự phòng phải chạy được trong **cả hai** trường hợp.
- **Hội thoại của Worker không mang sang provider khác được.** Worker thay thế phải dựng lại trạng thái từ những gì đã ghi ra ngoài: bead (trạng thái, close reason), tài liệu và mã trên đĩa, các `BM-REPORT` trong kho vết, ngân sách review theo `requestId` (M13). Đây đúng là điều beads được thiết kế cho: `worker.md` gọi bead là thứ "lets you stop, hand over, or be reviewed".
- **Hôm nay không có gì xử lý chuyện này.** Plugin bỏ qua lượt `failed` (M9), và chưa từng có sự cố thật để biết thông báo trông ra sao (§1.5).

### 2.2 Loại lỗi nào thì dự phòng

| Mã | Loại | Dấu hiệu | Chờ là hết? | Dự phòng? |
|---|---|---|---|---|
| L1 | Hết cửa sổ dùng của gói (phiên 5 giờ, hạn mức tuần, hạn mức theo model) | chữ kiểu "limit … resets …"; `listUsage` cho `usedPct` 100 kèm `resetsAt` (S6) | có, tới `resetsAt` | **có** — hoặc chờ nếu sắp reset |
| L2 | Hết credit, gói hết hạn, lỗi thanh toán | chữ kiểu "credit balance", "billing", "subscription" | không | **có**, và báo người dùng |
| L3 | Rate limit tạm thời, quá tải (429, 529) | chữ "rate limit", "overloaded"; Pi tự thử lại (P7) | có, vài phút | **không** — để công cụ tự thử lại; nhiều nhất là nhắc Worker làm tiếp một lần sau vài phút |
| L4 | Đăng nhập hết hạn, sai khoá | chữ "not logged in", "401", "invalid api key" | không | **có**, và báo người dùng đăng nhập lại |
| L5 | Provider không chạy được | `providerUnavailable`, "process exited with code" | không | **có** |
| L6 | Lỗi khác: tràn ngữ cảnh, lỗi công cụ, lỗi của chính việc | mọi thứ còn lại | — | **không** — đổi provider không sửa được việc sai; báo người dùng như hôm nay |

Nguyên tắc: **chỉ L1, L2, L4, L5 kích hoạt dự phòng**; phân loại không chắc thì coi là L6. Mẫu chữ để nhận dạng là **cấu hình, không phải hằng số trong mã**, vì nguyên văn thông báo chưa quan sát được (§1.6) và nhà cung cấp đổi chữ theo phiên bản.

### 2.3 Phát hiện

| Mã | Tín hiệu | Dùng khi | Giới hạn |
|---|---|---|---|
| N1 | `on("agent.turn_ended")` của Worker có `outcome.kind = failed`: so `error.message` với mẫu (S1, S2, S4) | luôn luôn | chỉ có chữ; Codex không có mã lỗi |
| N2 | Lượt Worker `completed` mà **không có `BM-REPORT`**, 0 token ra, và tin nhắn cuối khớp mẫu hạn mức | luôn luôn | cần vì Claude có thể báo hạn mức bằng một lượt `completed` (S3, suy luận) |
| N3 | `providers.listUsage()` để xác nhận L1 và lấy `resetsAt` | **chỉ sau khi** N1/N2 bắn | chỉ có cho claude/codex; daemon **gọi mạng** tới nhà cung cấp (S6) — một hành vi mới của paseo-bm, owner phải đồng ý |
| N4 | Trước khi tạo Worker, hook xem hạn mức của provider chính rồi chuyển thẳng sang mục dự phòng đầu tiên còn dùng được | tuỳ chọn, tắt mặc định | như N3; thêm độ trễ lúc tạo Worker |

### 2.4 Các phương án: ai thực hiện dự phòng

| | Phương án | Chạy thế nào | Chi phí làm | Rủi ro | Cùng provider gốc (Manager cũng hết hạn mức) | Khác provider gốc (Manager còn chạy) |
|---|---|---|---|---|---|---|
| **A** | Manager làm theo chỉ dẫn | Plugin gửi Manager một thông báo `BM-FALLBACK` (loại lỗi, ứng viên kế tiếp); Manager tạo Worker mới trên ứng viên đó kèm lời bàn giao | Thấp: một thông báo, vài câu trong `manager.md` | Manager là LLM, có thể tự chế; lời bàn giao phụ thuộc trí nhớ của Manager; plugin không bảo đảm được Manager khác provider gốc, vì đó là lựa chọn của người dùng | **Không** | **Có** — rẻ nhất trong trường hợp này |
| **B** | Plugin tự làm, **tự động** | Plugin phát hiện (N1/N2), phân loại, lấy mục kế tiếp trong chuỗi dự phòng, **tự tạo** Worker thay thế (S7) làm con của Manager với lời bàn giao dựng bằng mã (§2.5), đánh dấu Worker cũ, báo Manager và hiện thẻ cho người dùng | Cao: module server mới, bộ dựng lời bàn giao, nhãn, test với provider giả | Tốn tiền mà không ai hỏi, khi provider dự phòng tính theo token (OpenCode/Pi dùng API); phân loại sai thì đẻ Worker vô ích; hai Worker cùng sửa một cây nếu người dùng gọi lại Worker cũ | **Có** | **Có** |
| **C** | Plugin phát hiện, **người dùng bấm** | Như B tới bước chọn ứng viên, rồi hiện **thẻ** trong Beads Manager (và pill "đang chờ"): *"Worker dừng vì hết hạn mức Claude (phiên 5 giờ, reset 15:40). [Chuyển sang Codex · gpt-5.6-sol · high] [Chờ tới 15:40 rồi làm tiếp] [Để tôi tự xử lý]"*. Bấm nút nào thì plugin làm đúng việc đó | Cao như B, cộng một loại thẻ (dùng lại hạ tầng thẻ và nút trả lời đã có) | Việc chờ người bấm — nhưng không bấm thì việc cũng đứng như hôm nay; người dùng thấy chi phí trước khi chuyển | **Có** — thẻ do plugin đăng, nút gọi RPC của plugin | **Có** — Manager còn giải thích và trả lời được người dùng trong chat |
| **D** | Chờ reset rồi làm tiếp **chính Worker đó** | Plugin đọc `resetsAt` (N3), tới giờ thì gửi Worker cũ "continue" như app gửi (`agents.ref(id).send`, S13) | Thấp–vừa: hẹn giờ trong tiến trình daemon, ghi ra file để đặt lại sau khi daemon khởi động lại | Chờ có thể nhiều giờ; chỉ áp cho L1 của claude/codex | **Có** | **Có** |
| **E** | Đổi **model** cùng provider trên chính Worker (ví dụ hết hạn mức tuần riêng của Opus thì chuyển Sonnet) | `update_agent` đổi `settings.model` (S9) | Thấp nếu làm được | **SDK plugin không có hàm đổi model** (S9); chỉ Manager (LLM) gọi được qua MCP; chỉ giúp khi hạn mức tính riêng theo model | Không (cần Manager) | Có, nếu Manager gọi `update_agent`; vẫn chỉ giúp khi hạn mức tính riêng theo model |

**Khuyến nghị: C làm mặc định, D là một nút trong thẻ của C, B là tuỳ chọn "tự động" bật riêng sau khi đã thấy sự cố thật.**
- C chạy được trong **cả hai** trường hợp với cùng một đường mã, và giữ quyết định chuyển provider — tức là quyết định tiêu tiền — cho người dùng. Khi Manager khác provider gốc, plugin vẫn gửi `BM-FALLBACK` cho Manager (§2.5) để nó giải thích và trả lời người dùng. Nhưng **chỉ plugin** tạo Worker thay thế, để không có hai bên cùng tạo.
- D rẻ nhất khi sắp tới giờ reset: không mất ngữ cảnh, không đổi provider.
- B dùng chung toàn bộ mã với C, chỉ khác là không chờ bấm. Nó nên chờ tới khi mẫu nhận dạng đã được kiểm trên sự cố thật (§1.5), vì một lần nhận nhầm ở chế độ tự động là một Worker thừa đang sửa code.
- A không khuyến nghị làm đường chính. Nó chỉ chạy khi Manager khác provider gốc với Worker, mà đó là lựa chọn của người dùng, plugin không bảo đảm được. Lời bàn giao do một LLM viết cũng kém chắc hơn lời bàn giao dựng bằng mã. E cần một hàm Paseo chưa cho plugin (đề nghị U1 gửi Paseo, §5.2).

### 2.5 Bàn giao: Worker thay thế nhận gì

Lời bàn giao được **plugin dựng bằng mã** từ dữ liệu đã lưu, không nhờ LLM nào tóm tắt:

| Mục | Lấy từ đâu |
|---|---|
| `requestId`, yêu cầu gốc (nguyên văn tin giao việc của Manager) | nhãn `bm.requestId` của Worker cũ; tin nhắn đầu tiên trong timeline của nó (`timeline.refetch`, S13) |
| Cỡ, giai đoạn, bead đã tạo / đóng / sẵn sàng, file đã đổi, phát hiện review còn mở, skill đã dùng | `BM-REPORT` cuối cùng của Worker cũ trong kho vết |
| Bead đang dở | bead `in_progress` trong danh sách trên; Worker mới được dặn đọc `git status`/`git diff` trước, **không** hoàn tác gì mình không tạo |
| Số lượt review đã dùng, lô đang mở | bộ đếm ngân sách review theo `requestId` (M13) |
| Vì sao đổi | loại lỗi (L1…L5), nguyên văn thông báo, Worker cũ là ai |

Kèm theo:
- **Nhãn:** Worker mới có `bm.role=worker`, cùng `bm.requestId`, và `bm.replaces=<id cũ>`. Worker cũ nhận `bm.replacedBy=<id mới>` qua `paseo agent update --label`, đường gọi CLI plugin đã dùng (M11). Luật "một Worker cho mỗi request" (M13) bỏ qua Worker đã bị thay, nên thẻ và pill trỏ đúng Worker mới.
- **Reviewer của Worker cũ** nhận thông báo dừng sẵn có (design §2.6 D).
- **Chỉ dẫn vai trò:** `worker.md` thêm một đoạn "nếu tin khởi đầu là `BM-HANDOVER` thì tiếp tục từ đó, không làm lại bead đã đóng, không mở lô review mới cho lô đang dở".
- **Manager** nhận thông báo `BM-FALLBACK` (như `BM-BUDGET`). Khác provider gốc thì Manager còn chạy, nên báo được và trả lời được người dùng trong chat. Cùng provider gốc và cũng đang hết hạn mức thì lượt của nó hỏng, vô hại; người dùng vẫn thấy thẻ.
- **Worker mới chạy trên provider nào:** mục kế tiếp của chuỗi dự phòng (§4). Provider phải là một alias mà hook nhận ra là Worker (M5); §4 chốt cách tạo các alias đó.

### 2.6 Lan can

1. Chỉ **plugin** tạo Worker dự phòng. Mỗi Worker cũ bị thay **nhiều nhất một lần**; nhãn `bm.replacedBy` làm việc này idempotent.
2. Đi **tiến** trong chuỗi, không bao giờ quay lại mục đã hỏng trong cùng request. Hết chuỗi thì thẻ nói "hết phương án dự phòng" và dừng.
3. Không dự phòng cho L3, L6, hay lượt `canceled` (người dùng bấm Stop).
4. Ngân sách review đi theo `requestId`, không reset khi đổi Worker.
5. Thẻ nói trước **chi phí**: provider dự phòng tính theo token thì hiện giá từ `metadata.cost` của model (§1.1) khi có.
6. Mỗi lần dự phòng được ghi vào kho vết (Worker cũ → mới, lý do), để Dashboard hiện được.
7. Không đọc credential. `listUsage` là daemon gọi bằng phiên của nó, và chỉ chạy khi owner đã đồng ý (quyết định D3, §7).
8. **Bỏ qua mục dự phòng cùng provider gốc** với Worker vừa hỏng, khi lỗi thuộc về gói hay phiên đăng nhập (L1 với cửa sổ chung, L2, L4). Alias cùng provider gốc dùng chung gói (M17), nên chuyển sang đó không giúp gì. Chỉ giữ mục đó khi hạn mức tính riêng theo model (ví dụ cửa sổ `seven_day_opus`, S6) và mục đó dùng model khác.

### 2.7 Phải kiểm trên daemon thật trước khi coi là xong

- Nguyên văn thông báo hạn mức của Claude và Codex, và lượt đó là `completed` hay `failed` (§1.6).
- `listUsage` trả cửa sổ và `resetsAt` cho tài khoản của owner.
- Plugin tạo được Worker làm con của Manager, kèm nhãn, và hook nạp đúng chỉ dẫn.
- Test tự động: một provider giả phát lượt `failed` và `completed` mang chữ hạn mức — không bao giờ dùng hạn mức thật.

## 3. OpenCode và Pi (T3)

### 3.1 Mỗi vai trò cần gì từ provider

| Cần | Manager | Worker | Reviewer |
|---|---|---|---|
| Công cụ Paseo (tạo, nhắn, dừng agent; `send_agent_prompt` để báo cáo) | **bắt buộc** | **bắt buộc** — không có thì không tạo được Reviewer, không gửi được `BM-REPORT` | không cần, và không nên có |
| Chạy không hỏi quyền | có (REQ-026c, delta 20260918) | có | **không** — REQ-026c: Reviewer không bao giờ ở mode toàn quyền |
| Giữ được "chỉ đọc" bằng cấu hình | — | — | nên có; không có thì chỉ còn chỉ dẫn |
| Skill workflow đọc được | nên có | **nên có** (thiếu thì làm kém, REQ-007j) | nên có |

### 3.2 Provider × vai trò

| | Manager | Worker | Reviewer |
|---|---|---|---|
| **Claude** | có (hôm nay) | có (hôm nay) | có — mode `auto` |
| **Codex** | có | có | có (hôm nay) — mode `auto` |
| **OpenCode** | **có điều kiện**: có công cụ Paseo (P3); chạy không hỏi quyền bằng feature `auto_accept`, không bằng mode (P10); nhưng `manager.ensure` lấy mode `dangerous` đầu tiên của provider (design §2.6, errata 2026-09-18), mà OpenCode không có mode nào như vậy, nên phải sửa | **có**: có công cụ Paseo (P3); tạo từ Manager đang chạy không hỏi quyền thì daemon tự bật `auto_accept` (P10); Paseo nạp chỉ dẫn vào trường `system` (research 20260918 §2) | **có điều kiện**: mode của OpenCode là **agent do người dùng tự khai** (§1.1), nên "chỉ đọc" chỉ có cấu hình khi người dùng có một agent chỉ đọc (ví dụ `plan`) và chọn nó cho Reviewer. Không có thì Reviewer chạy với `auto_accept` = **chỉ còn chỉ dẫn**. Hôm nay còn **bị từ chối tạo**, vì Worker được dặn mode `auto` mà OpenCode không có (suy luận từ mã, M7) |
| **Pi** | **chỉ khi có `pi-mcp-adapter`** (P4); máy owner chưa có (P5) | **chỉ khi có `pi-mcp-adapter`**; không có thì agent vẫn được tạo nhưng **câm lặng mất công cụ Paseo** (P4) — Worker không tạo được Reviewer, không báo được Manager | **có về kỹ thuật** (không cần công cụ Paseo), nhưng Pi **không hỏi quyền khi chạy công cụ** (P6), nên không có lớp duyệt nào chặn việc sửa file hay chạy lệnh mạng. Pi có sandbox hay giới hạn nào khác không thì **chưa kiểm** (§1.6). Hôm nay còn **bị từ chối tạo** vì mode `auto` (suy luận từ mã, M7) |

Thêm hai điều về **chất lượng**, không thuộc Paseo:
- OpenCode và Pi chỉ là **khung chạy**. Model thật là model người dùng cấu hình bên trong chúng (OpenCode: 129 model qua 7 nhà cung cấp; Pi trên máy owner: một model cục bộ `Qwen3.6-35B-A3B`). `worker.md` dài khoảng 5.300 token (research 20260918 §3) và đòi khối `BM-REPORT` đúng từng trường. Một model nhỏ có thể không theo nổi. Đây là suy luận; đo được bằng một lượt chạy trên fixture sẵn có (§5.1 bước 2).
- Pi **tự thử lại** khi provider lỗi (P7), nên lỗi tạm thời ít khi tới plugin. Tốt cho L3 (§2.2), nhưng một Worker Pi đang chờ thử lại trông như đang chạy.

### 3.3 Những gì paseo-bm phải sửa

| # | Chỗ | Sửa gì | Vì sao |
|---|---|---|---|
| O1 | `plugin/server/role-mode.ts`, `role-hook.ts` | Chọn cách chạy theo **khả năng** của provider, không theo `colorTier`: có mode `colorTier` → như hôm nay; có feature `auto_accept` → Manager/Worker bật nó, Reviewer tắt nó và dùng agent chỉ đọc nếu người dùng đã chọn; không có mode nào → không truyền mode | M6, P10, P11 |
| O2 | `plugin/server/role-extras.ts` (Runtime facts) | Dòng mode của agent con phải nói được **"không có mode — đừng truyền `settings.modeId`"**; bỏ mặc định `auto` cho provider không có `auto` | M7, M8 |
| O3 | `plugin/roles/manager.md`, `worker.md` | Câu "Paseo refuses to create a Worker without one" chỉ đúng với Claude/Codex; viết lại theo Runtime facts mới | M8, P11 |
| O4 | Kiểm công cụ Paseo sau khi tạo | Sau khi tạo Manager/Worker, đọc `capabilities.supportsMcpServers` của agent (SDK handle có `capabilities`). `false` với Pi nghĩa là thiếu `pi-mcp-adapter` → báo rõ trên màn hình, không để Worker câm lặng | P4 (Pi đặt `supportsMcpServers` theo việc có cấu hình MCP hay không) |
| O5 | Màn Setup, `setup-skills.ts`, CLI `--skills-agents` | Thêm cột skill cho Pi (`~/.pi/agent/skills`, P9) và OpenCode (thư mục **chưa kiểm**); tên agent của CLI `skills` cho hai công cụ này **chưa kiểm** | M11, M12 |
| O6 | `src/roles/login.ts` | Pi: không có lệnh đăng nhập đã biết → chỉ in hướng dẫn; mọi provider ngoài Claude: trạng thái đăng nhập `unknown` như hôm nay | M12 |
| O7 | `plugin/shared/prices.ts`, `cost.ts` | Lấy giá từ `metadata.cost` của model khi Paseo có (OpenCode có); không có thì chỉ hiện token như hôm nay | §1.1, M12 |
| O8 | `plugin/server/collector.ts` | Kiểm lại việc nhận "đã nạp skill" trên timeline OpenCode/Pi (hôm nay theo công cụ `Skill` của Claude hoặc việc đọc `SKILL.md`) | M12 |
| O9 | Test | Provider giả **không có mode**, và provider giả có mode **không `colorTier`** kèm feature `auto_accept` | — |

### 3.4 Các phương án phạm vi và khuyến nghị

| | Phương án | Gồm | Chi phí làm | Rủi ro |
|---|---|---|---|---|
| **V1** | Chỉ OpenCode, Pi để sau | OpenCode cho Worker và Reviewer (O1–O3, O5–O9); không đụng Pi | Vừa | Thấp nhất; nhưng **không đáp ứng phần "Pi"** của yêu cầu |
| **V2** | OpenCode đầy đủ; Pi chỉ cho Worker, và chỉ khi có `pi-mcp-adapter` | V1, cộng O4 (kiểm công cụ Paseo sau khi tạo agent), cột skill Pi, cảnh báo khi chọn Pi | Vừa, thêm O4 | Worker Pi phụ thuộc một extension bên thứ ba (P4); model trong Pi có thể không theo nổi `worker.md` (§3.2) |
| **V3** | Như V2, cộng Reviewer trên Pi | V2, cộng cho phép chọn Pi cho Reviewer | Như V2 | Reviewer Pi không có lớp duyệt quyền (P6), sandbox chưa kiểm (§1.6): "chỉ đọc" có thể chỉ còn là chỉ dẫn |
| **V4** | Cả ba vai trò trên OpenCode và Pi, kể cả Manager | V3, cộng sửa `manager.ensure` chọn cách chạy theo khả năng provider; Manager Pi cũng cần adapter | Cao | Manager là lối vào của sản phẩm, hỏng nó là hỏng tất cả; owner không yêu cầu Manager |

**Khuyến nghị: V2** (tương ứng D5 **a** và D6 **a** ở §7). V2 đáp ứng cả OpenCode lẫn Pi cho Worker — chỗ owner hỏi — mà không hạ lan can của Reviewer và không đụng Manager. V3 chỉ nên cân nhắc lại sau khi kiểm được Pi có cơ chế giữ chỉ đọc (§1.6).

Chi tiết theo vai trò của V2:

| Vai trò | Đề xuất cho bản này |
|---|---|
| **Worker** | **OpenCode: hỗ trợ đầy đủ** (O1–O3, O5–O9), dùng được làm provider chính hay mục dự phòng. **Pi: chỉ khi máy có `pi-mcp-adapter`**; màn hình cảnh báo khi chọn Pi, và plugin báo ngay khi một Worker Pi được tạo mà thiếu công cụ Paseo (O4). Không bao giờ để một Worker Pi chạy mà không có công cụ Paseo |
| **Reviewer** | **OpenCode: hỗ trợ**, và khuyên chọn một agent OpenCode chỉ đọc. Không có thì phải được owner chấp nhận rằng "chỉ đọc" chỉ còn là chỉ dẫn. **Pi: không đưa vào bản này**, trừ khi (1) kiểm được Pi có cơ chế giữ chỉ đọc (§1.6), hoặc (2) owner chấp nhận rõ việc Reviewer chạy không có lớp duyệt quyền nào |
| **Manager** | **Không thêm OpenCode/Pi cho Manager trong bản này** — owner không yêu cầu, và `manager.ensure` có logic mode riêng. Lưu ý: Manager **đã** chạy được trên provider gốc khác Worker ngay hôm nay, trên Claude hay Codex (M17). Đặt Manager khác provider gốc với Worker là cách rẻ nhất để Manager còn chạy khi Worker hết hạn mức (§2.1) |

Rủi ro còn lại: với OpenCode không có agent chỉ đọc, và với mọi Reviewer trên Pi, ranh giới "Reviewer không sửa gì" chỉ còn nằm trong `reviewer.md`. Đây là cùng loại rủi ro đã chấp nhận cho Worker ở `bypassPermissions` (design §2.6, errata bm-msy), nay mở rộng sang Reviewer, nên phải là quyết định của owner.

## 4. Cấu hình lại vai trò trong Beads Manager (T4)

### 4.1 Hôm nay người dùng đổi được gì, và vướng ở đâu

- **Đổi được ngay, ngoài paseo-bm:** màn **Settings → Agent profiles** của Paseo sửa được provider, model, mode, thinking, feature của profile `bm-*` (S11).
- **Nhưng bốn chỗ làm hỏng việc đó:**
  1. **Thinking đặt trên profile không tới được Worker và Reviewer.** Manager và Worker không truyền thinking khi tạo agent con; chỉ Manager đọc thinking của profile (M8).
  2. **Cài lại thì mất.** `npx paseo-bm install` thay nguyên mục `bm-*`, nên mode, thinking hay feature người dùng tự đặt biến mất (M3).
  3. **Đổi provider gốc** (ví dụ Worker từ Claude sang OpenCode) nghĩa là đổi `extends` của alias `bm-worker`. Không rõ màn của Paseo có sửa alias được không (§1.6), và CLI chỉ làm việc này qua `install --reconfigure` / `--role`.
  4. **Chuỗi dự phòng** (§2) là khái niệm riêng của paseo-bm; Paseo không có chỗ nào để khai.
- **Không có** đường nào trong plugin mở thẳng màn Agent profiles của Paseo. `openSettings(id)` của SDK nhận id settings của plugin (suy luận từ chữ ký hàm, `@getpaseo/plugin/dist/client/contracts.d.ts` 127–132).

### 4.2 Các phương án nơi lưu và người ghi

| | Phương án | Nơi lưu | Ai ghi | Chi phí | Rủi ro | ADR bị ảnh hưởng |
|---|---|---|---|---|---|---|
| **R1** | Giữ cấu hình trong Paseo; plugin ghi qua RPC của Paseo | alias `agents.providers.bm-*` và profile `bm-*` như hôm nay | Plugin, qua `config.patch` (S10): **alias** thì gộp theo khoá, chỉ chạm mục `bm-*`; **profile** thì đọc lại ngay trước khi ghi (khác lần đọc lúc mở màn hình thì dừng, không ghi) → sửa đúng mục `bm-*` → ghi → đọc lại; thấy một profile khác bị đổi trong khoảng đó thì **báo** tên profile đó, không tự ghi lại (ghi lại cũng là thay cả mảng) | Vừa | `agentProfiles` bị thay cả mảng, và `config.patch` **không có cơ chế so-rồi-ghi** (không phiên bản, không etag; S10). Đọc lại ngay trước khi ghi chỉ **thu hẹp** cửa sổ xung đột, không loại bỏ: một thay đổi trong app rơi đúng vào khoảng giữa lần đọc cuối và lần ghi vẫn bị đè. Kiểm sau khi ghi chỉ phát hiện, không cứu lại được. Chỉ U3 (§5.2) mới bảo đảm | **ADR-004** (thêm người ghi ngoài trình cài, ghi qua RPC thay vì CLI), **ADR-006** QĐ 5 (ngoại lệ có kiểm cho `agentProfiles`) |
| **R2** | File riêng của paseo-bm, áp ở hook | `<install home>/roles.json` (dữ liệu người dùng, như `role-extras.json`) | Plugin ghi file của nó; `before("agent.create")` đặt model, thinking, mode lúc tạo agent (S8) | Vừa | **Hai nguồn sự thật:** màn của Paseo nói Opus, Worker chạy Sonnet. Đổi provider gốc vẫn cần alias đúng `extends`, nên hoặc vẫn phải ghi config, hoặc lúc cài phải đăng ký sẵn alias cho mọi provider | Không, cho model và thinking; vẫn chạm ADR-004 nếu đổi provider gốc |
| **R3** | Chỉ sinh lệnh CLI | như hôm nay | CLI; màn hình dựng lệnh `npx paseo-bm install --reconfigure --role …` để người dùng copy | Thấp | Không phải "trong Beads Manager"; `npx` cần mạng; CLI chưa có cờ cho thinking và chuỗi dự phòng | Không |
| **R4** | Plugin chạy lõi ghi config của CLI | như hôm nay, cộng `install.json` | Plugin gọi mã đọc-sửa-ghi file của CLI (backup, kiểm ghi song song, `paseo daemon reload`) từ trong daemon | Cao | Plugin ghi file mà chính daemon cũng ghi; `paseo daemon reload` gọi từ **trong** daemon chưa kiểm — có thể nạp lại chính plugin giữa lúc RPC đang chạy | ADR-004 |

**Khuyến nghị: R1 cho provider, model, thinking, mode của ba vai trò; một file riêng cho chuỗi dự phòng.**
- R1 giữ **một nguồn sự thật** mà ADR-006 đã chọn ("người dùng chọn công cụ cho từng vai trò ngay trong Paseo"). Màn của Paseo và màn của paseo-bm luôn nói cùng một điều.
- Chỗ yếu của R1 (thay cả mảng profile, chỉ thu hẹp và báo được chứ không chặn được việc đè) nhỏ hơn cái giá "hai nguồn sự thật" của R2. Nó phải được owner chấp nhận bằng một sửa đổi ADR-006, kèm bước kiểm sau khi ghi.
- Chuỗi dự phòng và chính sách "hỏi / tự động / tắt" không có chỗ trong Paseo, nên nằm trong `<install home>/worker-fallback.json`. File này là dữ liệu người dùng: không hash, không bị cài lại hay `--prune` đụng tới — cùng cách với `role-extras.json` (delta setup-screen §3.2).
- Mỗi mục dự phòng cần một **alias** để hook nhận ra đó là Worker (M5): `bm-worker-fallback-1`, `bm-worker-fallback-2`… Mỗi alias gồm `{ extends, label: "Worker (dự phòng N)", paseoTools.enabled }`, ghi bằng đường gộp theo khoá của R1. Alias vẫn theo tiền tố `bm-`, nên lệnh gỡ và `doctor` coi nó là của paseo-bm mà không phải đổi luật (M16).

### 4.3 Áp vào agent lúc nào

| Agent | Khi nào nhận cấu hình mới | Cách |
|---|---|---|
| Worker, Reviewer tạo **sau** khi lưu | ngay lần tạo kế tiếp | hook đọc profile qua `config.get()` mỗi lần tạo, và đặt `thinkingOptionId`, `featureValues` từ profile khi agent cha không truyền (sửa chỗ vướng 1). `modeId` của profile thì hook đã áp từ hôm nay (M6). Luật an toàn của Reviewer vẫn thắng: không bao giờ mode `dangerous` hay `planning` (M6) |
| Worker dự phòng | lúc plugin tạo nó (§2.5) | model và thinking của mục dự phòng, trên alias của mục đó |
| Manager **mới** | lần `manager.ensure` tạo Manager kế tiếp | như hôm nay: `manager.ensure` đã đọc profile (M8) |
| Agent **đang chạy** (kể cả Manager đang có) | **không đổi** | SDK plugin không đổi được model hay thinking của agent đã có (S9, S13). Màn hình nói rõ điều này. Nút "tạo Manager mới với cấu hình mới" là gợi ý, không thuộc đề xuất này |

### 4.4 Sống chung với CLI

- **Cài lại:** mục `bm-*` được **gộp** thay vì thay nguyên. Giữ provider, model, thinking, mode, feature đang có; chỉ `--role` hay `--reconfigure` mới ghi đè, và chỉ ở vai trò được nêu (sửa chỗ vướng 2, M3). Alias `bm-worker-fallback-*` không bị cài lại xoá.
- **`install.json` `roles[]`** thành bản ghi "trình cài đã ghi gì lần cuối", không còn là nguồn sự thật của model. Lý do: nguồn sự thật đã là config của Paseo, và `doctor` vốn không so model (M16), nên không phát sinh báo lỗi giả.
- **`doctor`** thêm một dòng thông tin (không phải lỗi) khi model hay provider hiện tại khác bản ghi: "đã đổi trong app".
- **`paseo-bm configure`** (REQ-028 bản CLI, design §4.1) vẫn để P2. Màn hình mới đáp ứng REQ-028 cho người dùng app.

### 4.5 Phác giao diện

Trong màn Beads Manager → **Setup**, thêm một mục **"Vai trò & model"**:

```
Vai trò & model
┌ Manager   Claude · Opus 5 · thinking High · mode Bypass (tự đặt)            [Sửa]
├ Worker    Claude · Opus 5 · thinking High                                    [Sửa]
│   ⚠ Manager và Worker cùng dùng gói Claude: Worker hết hạn mức thì Manager cũng dừng
│   Khi Worker hết hạn mức:  (•) Hỏi tôi   ( ) Tự động chuyển   ( ) Tắt
│   Dự phòng 1  Codex · GPT-5.6-Sol · thinking high                  [↑][↓][Xoá]
│   Dự phòng 2  OpenCode · anthropic/claude-sonnet-4-6 · medium · ~$3 / $15 mỗi 1M token
│   [+ Thêm mục dự phòng]
└ Reviewer  Codex · GPT-5.6-Sol · thinking (mặc định: xhigh) · mode auto       [Sửa]
Thay đổi áp cho agent tạo SAU khi lưu. Agent đang chạy giữ cấu hình cũ.
```

Form **Sửa** cho một vai trò hay một mục dự phòng:

| Trường | Nguồn danh sách | Luật |
|---|---|---|
| Provider | `providers.snapshot()` / `listAvailable()`: chỉ provider `available` | Pi cho Manager/Worker: hiện cảnh báo "cần `pi-mcp-adapter`" (§3.4). Pi cho Reviewer: tắt, trừ khi owner đã chấp nhận (§3.4) |
| Model | `providers.listModels(provider)` | phải có trong danh sách |
| Thinking | `thinkingOptions` của model đã chọn | ẩn khi model không có; để trống = mặc định của provider |
| Mode | `providers.listModes(provider)` | Reviewer: không bao giờ `dangerous`/`planning`. OpenCode: chọn một agent (Reviewer: khuyên agent chỉ đọc). Pi: không có |
| Feature | do plugin quản | `auto_accept` của OpenCode: bật cho Manager/Worker, tắt cho Reviewer; chỉ hiện để đọc |

**Kiểm khi lưu** (trả lỗi rõ, không lưu nửa chừng):
- Model và thinking có thật.
- Chuỗi dự phòng không trùng provider + model với mục chính hay với nhau.
- Mỗi mục dự phòng dùng provider đang `available`.
- **Manager và Worker cùng provider gốc:** cảnh báo, không chặn — "Manager và Worker dùng chung gói <provider>: Worker hết hạn mức thì Manager cũng dừng" (§2.1). Mục dự phòng cùng provider gốc với Worker chính được đánh dấu "chỉ giúp khi hạn mức tính theo model" (§2.6 mục 8).
- Cảnh báo chi phí khi model có `metadata.cost`.
- **Xung đột với một thay đổi khác trong app:** ngay trước khi ghi, đọc lại cấu hình; khác lúc mở màn hình thì dừng, không ghi, và báo "cấu hình vừa bị thay đổi ở nơi khác, mở lại màn hình". Sau khi ghi, đọc lại; một profile không phải `bm-*` đã đổi trong khoảng đó thì báo rõ profile đó có thể đã mất thay đổi. **R1 không bảo đảm được việc không ghi đè**: nó thu hẹp cửa sổ và báo khi xảy ra; bảo đảm thật cần U3 (§5.2).

**RPC** (tên chữ thường theo luật SDK, delta setup-screen §6):
- `roles.settings`: đọc cả ba vai trò cùng chuỗi dự phòng.
- `roles.save-settings({ role, provider, model, thinkingOptionId?, modeId? })`.
- `roles.save-fallback({ policy, entries[] })`.

Mã lỗi mới cho sổ mã của Dashboard: `E_ROLE_SETTINGS_INVALID`, `E_ROLE_SETTINGS_CONFLICT`.

### 4.6 Bản nhỏ làm trước được

Hai sửa nhỏ, không cần màn mới hay sửa ADR, cho owner chọn thinking của Worker ngay bằng màn Agent profiles của Paseo:
- (a) Hook áp thinking và feature của profile cho Worker và Reviewer, như đã áp mode (§4.3 dòng đầu).
- (b) Cài lại gộp thay vì thay nguyên mục `bm-*` (§4.4 gạch đầu).

Đây là bước 1 của lộ trình ở §5.

### 4.7 Quyết định đã Accepted mà khuyến nghị này chạm tới

Không sửa tài liệu nào ở đây. Nếu owner chọn R1, request triển khai phải có các delta sau:

| Tài liệu | Chỗ | Vì sao phải đổi |
|---|---|---|
| ADR-004 | Quyết định 1 ("Mặc định tích hợp qua CLI `paseo`, không phụ thuộc SDK") và phạm vi "chỉ trình cài ghi `config.json`" | Plugin trở thành bên ghi thứ hai, và ghi qua RPC `config.patch` của SDK thay vì sửa file rồi `paseo daemon reload` |
| ADR-006 | Quyết định 1 ("Đăng ký **ba** vai trò") | Thêm alias `bm-worker-fallback-N` ngoài ba vai trò |
| ADR-006 | Quyết định 5 ("**Không bao giờ thay cả mảng**" `agentProfiles`) | `config.patch` thay cả mảng (S10); cần một ngoại lệ có bước kiểm sau khi ghi, và owner chấp nhận rủi ro còn lại |
| Design `paseo-bm.md` | §3.2 `install.json` `roles[]`; §3.4 bảng khoá paseo-bm ghi vào `config.json` | `roles[]` thôi là nguồn sự thật của model; §3.4 thêm alias dự phòng và người ghi là plugin |
| PRD `paseo-bm-prd.md` | REQ-027(d) ("Cấu hình lưu trong thư mục cài đặt của paseo-bm") | Cấu hình vai trò có hiệu lực nằm trong config của Paseo; thư mục cài đặt chỉ giữ chuỗi dự phòng |
| PRD `paseo-bm-prd.md` | REQ-028 (P2) | Được đáp ứng bằng màn hình thay vì lệnh `configure`; nên nâng ưu tiên nếu owner chọn làm trong bản này |

Phương án R2 chỉ chạm ADR-004 khi đổi provider gốc. R3 không chạm gì.

## 5. Lộ trình nâng cấp (T5)

### 5.1 Năm bước phát hành

Mỗi bước là một bản prerelease riêng theo quy trình phát hành đang có (GitHub prerelease → npm dist-tag `next`, `docs/operations/paseo-bm-release-runbook.md`). Mỗi bước tự có giá trị và rút lại được bằng cách cài bản trước đó; payload các phiên bản cũ vẫn được giữ trong thư mục cài đặt (design §3.1).

| Bước | Bản đề xuất | Nội dung | Giá trị cho owner | Phụ thuộc | Rút lại |
|---|---|---|---|---|---|
| 1 | `0.2.0-alpha.2` | **Tôn trọng profile** (§4.6): hook áp thinking và feature của profile cho Worker và Reviewer; cài lại gộp thay vì thay nguyên mục `bm-*` | Chọn thinking cho Worker ngay trong màn Agent profiles của Paseo, và không bị cài lại xoá | — | cài bản cũ; profile của người dùng không bị đụng |
| 2 | `0.3.0-alpha.0` | **OpenCode và Pi** (§3.3 O1–O9): chọn cách chạy theo khả năng provider, Runtime facts nói được "không có mode", kiểm công cụ Paseo sau khi tạo agent, cột skill, giá từ `metadata.cost`. Kèm **một lượt đo** Worker trên một model OpenCode với fixture nghiệm thu sẵn có (research 20260918 §7 gợi ý cách này) | Chạy Worker trên OpenCode; biết model nào theo nổi `worker.md` | bước 1 | cài bản cũ; alias đã đổi `extends` thì đổi lại bằng `--role` |
| 3 | `0.3.0-alpha.1` | **Màn "Vai trò & model"** (§4.2 R1, §4.5), kèm cảnh báo khi Manager và Worker cùng provider gốc, và sửa ADR-004/006 (§4.7) | Cấu hình lại provider, model, thinking, mode cho ba vai trò ngay trong Beads Manager (REQ-028) | bước 1, 2 | cài bản cũ; cấu hình đã lưu nằm trong config của Paseo và vẫn dùng được |
| 4 | `0.3.0-alpha.2` | **Dự phòng Worker, chế độ "Hỏi tôi"** (§2.4 C + D): phát hiện N1–N3, lời bàn giao, thẻ, alias dự phòng, file chuỗi dự phòng | Worker hết hạn mức không làm đứng việc; người dùng chọn chuyển hay chờ | bước 3 (chuỗi cấu hình trong màn đó) | đặt chính sách "Tắt"; hoặc cài bản cũ |
| 5 | sau | **Chế độ "Tự động"** (§2.4 B), kiểm trước khi tạo Worker (N4) | Không cần người bấm | bước 4, cộng **ít nhất một sự cố thật đã ghi lại** | đặt chính sách "Hỏi tôi" |

Việc triển khai là **Large** (Routing Decision ở đầu tài liệu). Đề xuất đi theo lối repo đang dùng: một PRD delta và một design delta cho cả năm bước, sửa ADR-004/006, rồi một plan delta chia phase theo bước. Mỗi phase có beads, review theo lô và nghiệm thu trên daemon thật riêng.

### 5.2 Đề nghị gửi Paseo (bản nháp, chưa gửi)

Làm theo mẫu `docs/operations/paseo-upstream-request-*.md` đã có:

| # | Đề nghị | Mở khoá gì |
|---|---|---|
| U1 | SDK plugin có hàm đổi `model` và `thinkingOptionId` của agent đang có (MCP `update_agent` đã làm được, S9) | Phương án E (§2.4): đổi model mà giữ nguyên Worker và ngữ cảnh; áp cấu hình mới cho Manager đang chạy |
| U2 | `turn_failed` mang mã có cấu trúc cho hết hạn mức (ví dụ `usage_limit`, `billing`, `auth`) kèm `resetsAt` | Phát hiện bằng mã thay vì so chữ (S3–S5); an toàn để bật chế độ tự động |
| U3 | RPC sửa **một** agent profile theo `id` | Bỏ rủi ro thay cả mảng `agentProfiles` (S10, ADR-006 QĐ 5) |
| U4 | Pi báo rõ khi agent được yêu cầu MCP mà thiếu `pi-mcp-adapter` | Không còn Worker Pi câm lặng (P4) |

## 6. Rủi ro

| # | Rủi ro | Khả năng | Tác động | Giảm thiểu |
|---|---|---|---|---|
| K1 | Mẫu nhận dạng hết hạn mức sai: nhận nhầm, hoặc bỏ sót khi Claude báo bằng lượt `completed` | vừa (chưa có sự cố thật, §1.5) | Worker thừa, hoặc việc đứng mà không ai biết | mặc định "Hỏi tôi"; mẫu là cấu hình; kiểm trên sự cố thật trước khi bật tự động (bước 5) |
| K2 | Tốn tiền bất ngờ khi chuyển sang provider tính theo token | vừa | chi phí | thẻ hiện giá (§2.6 mục 5); người dùng bấm mới chuyển |
| K3 | Hai Worker cùng sửa một cây (người dùng gọi lại Worker cũ) | thấp | xung đột file | nhãn `bm.replacedBy`, luật "một Worker cho mỗi request" (§2.5) |
| K4 | Reviewer trên OpenCode (không có agent chỉ đọc) hay trên Pi mất lan can cấu hình | chắc chắn nếu chọn | Reviewer có thể sửa file hay dùng mạng | quyết định D6, D7 của owner; cảnh báo lúc lưu |
| K5 | Ghi `agentProfiles` thay cả mảng đè mất một thay đổi song song trong app | thấp | mất cấu hình profile khác | đọc lại ngay trước khi ghi để thu hẹp cửa sổ, đọc lại sau khi ghi để báo (§4.2); không chặn được hẳn — cần đề nghị U3 |
| K6 | Model nhỏ trong OpenCode/Pi không theo nổi `worker.md` và khối `BM-REPORT` | vừa | Worker làm sai quy trình | lượt đo ở bước 2; cảnh báo trên màn hình |
| K7 | `listUsage` làm daemon gọi mạng tới nhà cung cấp bằng phiên đăng nhập — một hành vi mới do paseo-bm kích hoạt | chắc chắn nếu bật | quyền riêng tư, số lần gọi | quyết định D3; chỉ gọi sau khi đã phát hiện lỗi; cache 5 phút của daemon (S6) |
| K8 | API plugin của Paseo 0.8 đổi ở bản sau | vừa | tính năng hỏng sau khi nâng Paseo | test với daemon giả như hôm nay; `doctor` kiểm phiên bản |
| K9 | Manager cũng hết hạn mức nên không điều phối được | cao khi Manager và Worker cùng provider gốc (cấu hình hiện tại trên máy owner); thấp khi khác (§2.1) | người dùng phải tự xem màn Beads Manager | thẻ do plugin đăng chạy được trong cả hai trường hợp (§2.4 C); cảnh báo cấu hình ở màn "Vai trò & model" (§4.5); người dùng đặt được Manager khác provider gốc ngay hôm nay (M17) |

## 7. Quyết định owner cần chốt

Trả lời theo mẫu `D1: a`. Mỗi quyết định chỉ có hiệu lực cho request triển khai sau.

| # | Câu hỏi | Phương án | Khuyến nghị |
|---|---|---|---|
| D1 | Phạm vi và thứ tự | **a:** năm bước như §5.1. **b:** chỉ bước 1 và 3 (cấu hình), dự phòng để sau. **c:** dự phòng trước (bước 1 và 4, chuỗi dự phòng tạm khai bằng file), màn cấu hình sau | **a** — mỗi bước có giá trị riêng, và dự phòng cần sẵn màn cấu hình để khai chuỗi |
| D2 | Cơ chế dự phòng | **a:** plugin phát hiện + thẻ "Hỏi tôi" (C) có nút "chờ reset" (D); tự động (B) để sau. **b:** tự động ngay. **c:** Manager làm theo chỉ dẫn (A) — chỉ chạy khi Manager khác provider gốc với Worker. **d:** chỉ chờ reset rồi làm tiếp (D) | **a** — chạy được dù Manager cùng hay khác provider gốc với Worker, và người dùng quyết chuyện tiêu tiền |
| D3 | Cho plugin gọi `listUsage` (daemon gọi mạng tới Anthropic/OpenAI bằng phiên của nó) | **a:** chỉ sau khi đã phát hiện lỗi, để lấy giờ reset. **b:** không bao giờ; chỉ dựa vào chữ của lỗi, không có nút "chờ reset" chính xác. **c:** cả kiểm trước khi tạo Worker (N4) | **a** — ít lần gọi nhất mà vẫn có giờ reset |
| D4 | Nơi lưu cấu hình vai trò | **a:** R1 — trong config Paseo, plugin ghi qua `config.patch`, chuỗi dự phòng trong file riêng; sửa ADR-004/006. **b:** R2 — file riêng áp ở hook. **c:** R3 — màn hình chỉ sinh lệnh CLI | **a** — một nguồn sự thật, khớp màn Agent profiles của Paseo |
| D5 | OpenCode cho vai trò nào | **a:** Worker và Reviewer. **b:** chỉ Worker. **c:** cả Manager | **a** |
| D6 | Pi cho vai trò nào | **a:** chỉ Worker, và chỉ khi có `pi-mcp-adapter`. **b:** như a, cộng Reviewer, chấp nhận Reviewer chạy không có lớp duyệt quyền nào (sandbox của Pi chưa kiểm, §1.6). **c:** chưa hỗ trợ Pi trong bản này | **a** |
| D7 | Reviewer trên OpenCode khi người dùng **không có** agent OpenCode chỉ đọc | **a:** cho lưu, kèm cảnh báo rằng "chỉ đọc" chỉ còn là chỉ dẫn. **b:** không cho lưu cho tới khi chọn một agent chỉ đọc | **b** — Reviewer là lớp kiểm độc lập; không nên hạ lan can mà không có một agent chỉ đọc làm chỗ dựa |

## 8. Ngoài phạm vi

- Dự phòng cho Manager và Reviewer; Manager trên OpenCode hay Pi (§3.4).
- Copilot và Oh My Pi (`omp`): trên máy owner là unavailable và bị tắt (§1.1).
- Cách ly phiên đăng nhập theo vai trò: PRD đã loại ("Cách ly credential theo từng vai trò kiểu paseo-room").
- Đổi model của agent đang chạy từ plugin: chờ U1.
- Cài `pi-mcp-adapter` hay bất kỳ công cụ nào hộ người dùng.

## 9. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | Bản Draft theo `req-20260921T082908Z`: sự thật đã kiểm, ba đề xuất, lộ trình, rủi ro, bảy quyết định |
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | Sửa theo review b2: thêm phương án V1–V4 cho phạm vi OpenCode/Pi (§3.4); sandbox của Pi ghi là chưa kiểm (§1.6); R1 nói rõ chỉ thu hẹp và báo được việc ghi đè, không chặn được (§4.2, §4.5) |
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | Theo góp ý owner (lô b3): Manager và Worker **không** bắt buộc dùng chung gói. Thêm M17; §2.1 và §2.4 xét riêng hai trường hợp cùng/khác provider gốc; lan can mục 8 về mục dự phòng cùng provider gốc; cảnh báo cấu hình ở §4.5; sửa §0, §3.4, §5.1, K9, D2, §8. Khuyến nghị C giữ nguyên, lý do đổi thành "chạy được trong cả hai trường hợp" |
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | `req-20260921T111242Z`: owner chốt §7 (D1 a, D2 a, D3 a, D4 a; Q4 "người dùng quyết định, model ngang hàng cho mọi agent" thay D5–D7). Status Draft → Decided; trỏ tới bốn tài liệu triển khai |
