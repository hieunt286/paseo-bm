# Delta-change — Dự phòng khi hết hạn mức cho mọi vai trò, màn "Roles & models", mọi provider cho mọi vai trò

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260921-worker-fallback-and-role-settings` |
| Tài liệu gốc | [Technical Design](./paseo-bm.md) §2.6, §3.2, §3.4, §5, §7, §8; [Technical Design Dashboard](./paseo-bm-dashboard.md) giá theo model. **Không sửa tại chỗ khi chưa duyệt** |
| PRD | [prd-delta-20260921-worker-fallback-and-role-settings](../product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md): REQ-062 → REQ-067, quyết định Q1–Q8 |
| Routing decision | [PRD delta §0](../product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md#0-routing-decision) (canonical owner) |
| ADR | [ADR-008](../adr/ADR-008-role-settings-written-by-plugin.md) (mới, Accepted 2026-09-22); sửa đổi [ADR-004](../adr/ADR-004-paseo-config-mutation.md) QĐ1 và [ADR-006](../adr/ADR-006-role-registration.md) QĐ1, QĐ5. [ADR-007](../adr/ADR-007-dashboard-trace-store.md): chỉ thêm một trường tuỳ chọn |
| Plan | [plan-delta-20260921-worker-fallback-and-role-settings](../plans/paseo-bm-implementation-plan-delta-20260921-worker-fallback-and-role-settings.md) |
| Nguồn sự thật đã kiểm | [Đề xuất 20260921](./paseo-bm-proposal-20260921-worker-fallback-and-role-settings.md) §1 (S1–S13, P1–P11, M1–M17), cộng §2 dưới đây |
| Status | **Active** — `design-ready` PASS 2026-09-22 sau review `b1` và re-review |
| Owner | hieu.nt10 |
| Request | `req-20260921T111242Z` |

**Thiết kế này sở hữu:**
- cách hook `agent.create` áp thinking và feature của profile;
- cách chọn cách chạy theo khả năng của provider;
- nội dung mục `## Runtime facts`, và thông báo `BM-SETTINGS`, `BM-TOOLS`, `BM-FALLBACK`, `BM-HANDOVER`, `BM-RESUME`;
- luật gộp của trình cài;
- màn Roles & models và các RPC của nó;
- đường plugin ghi `config.json` qua `config.patch`;
- phát hiện, phân loại, thẻ, bàn giao và hẹn giờ của agent dự phòng, cho cả ba vai trò;
- hai file mới trong thư mục cài đặt.

**Không sở hữu:**
- cách provider báo lỗi hạn mức, và API hạn mức của nhà cung cấp;
- cơ chế mode và feature bên trong Paseo;
- extension `pi-mcp-adapter`;
- chất lượng của model trong OpenCode hay Pi;
- bố cục Dashboard cho sự cố dự phòng (PRD delta §7.2).

## 1. Sáu kết quả, sáu phase

| Phase | Kết quả | REQ |
|---|---|---|
| 2a-13 | Worker và Reviewer nhận thinking và feature đặt trên profile; cài lại không xoá chúng | REQ-062 |
| 2a-14 | Mọi provider chạy được cho mọi vai trò, cách chạy chọn theo khả năng; thiếu công cụ Paseo thì người dùng được báo | REQ-063 |
| 2a-15 | Màn Roles & models ghi thẳng cấu hình Paseo; agent đang sống được báo mode mới của agent con | REQ-064 |
| 2a-16 | Hạ tầng dự phòng chung; Worker hết hạn mức → thẻ "Hỏi tôi" → chuyển, chờ reset, hoặc để người dùng | REQ-065 |
| 2a-17 | Cùng cơ chế cho Reviewer (Worker tạo Reviewer thay thế) và Manager (plugin tạo Manager thay thế) | REQ-066 |
| 2a-18 | Chế độ Tự động cho cả ba vai trò, chỉ sau một sự cố thật | REQ-067 |

## 2. Nền tảng — sự thật kiểm thêm trong request này

Đọc trên daemon owner ngày 2026-09-21 bằng công cụ Paseo chỉ đọc (`inspect_provider`, `list_models`), `paseo … --help`, SDK trong `node_modules/@getpaseo`, và mã của repo.

| # | Sự thật | Nguồn | Hệ quả |
|---|---|---|---|
| F1 | `inspect_provider opencode`: `modes` = `[{ id: "bytes", … }]`, **không có `colorTier`**; `features` = `[{ type: "toggle", id: "auto_accept", value: false }]`. `inspect_provider pi`: `modes: []`, `features: []` | MCP `inspect_provider` | Ba lớp khả năng ở §4.2 nhận ra được chỉ bằng `listModes` và `listFeatures` |
| F2 | Model OpenCode có id **chứa dấu `/`** (`anthropic/claude-sonnet-4-6`) và `metadata.cost = { input, output, cache: { read, write }, tiers?, experimentalOver200K? }`, đơn vị USD mỗi 1M token. Cả 129 model đều có `cost` | MCP `list_models opencode` | Chọn provider là `bm-worker/anthropic/claude-sonnet-4-6`: `providerId` lấy phần trước dấu `/` **đầu tiên**, model là **toàn bộ** phần sau. Giá lấy theo §4.2.7 |
| F3 | `modesFor` (`plugin/server/role-mode.ts`) trả `null` khi danh sách mode **rỗng**, nên không phân biệt được "provider không có mode" (Pi) với "đọc không được" | mã | Phải tách hai ca (§4.2.1) |
| F4 | `REVIEWER_FALLBACK_MODE = "auto"` (`role-extras.ts`, delta 20260918g Q9 a) được dặn Worker khi không đọc được mode Reviewer, bất kể provider | mã | Chỉ còn dùng khi provider gốc của `bm-reviewer` là `claude` hay `codex` (§4.2.2) |
| F5 | Daemon kiểm mode tường minh **trước** hook: mode không có trong danh sách → `Invalid mode` (đề xuất P10–P11, AGENTS.md) | bundle, AGENTS.md | Một `## Runtime facts` đã cũ, sau khi người dùng đổi provider của agent con, làm lần tạo kế tiếp **thất bại**. Cần thông báo `BM-SETTINGS` (§4.3.5) |
| F6 | SDK plugin (`PaseoApi`) có `terminals`, `workspaces`, `projects`, `agents`, `providers`, `config`; **không có API lịch hẹn**. `paseo schedule create` và `create_schedule` chỉ **tạo agent mới** theo lịch, không nhắn một agent đang có | `@getpaseo/client/dist/index.d.ts` 362–369; `paseo schedule create --help`; schema `create_schedule` | "Chờ tới giờ reset rồi làm tiếp chính Worker đó" cần một bộ hẹn giờ trong plugin (§4.4.9). Thiết kế gốc §8 ghi "không tác vụ nền" → owner cho một ngoại lệ hẹp (Q6 a) |
| F7 | Bản ghi lượt trong kho vết **không có** provider; chỉ có `usage.model` và `runtime.{model, thinkingOptionId, modeId}` | `plugin/server/trace-store.ts` | Giá theo `metadata.cost` cần thêm `runtime.provider`, trường tuỳ chọn (§4.2.7) |
| F8 | Thư mục skill của OpenCode trên máy owner là `~/.config/opencode/skill/` (số ít), có đủ năm skill workflow; `~/.pi/agent/skills/` cũng đủ năm skill (đề xuất P9). Chỉ liệt kê tên | `ls` | Cột skill ở §4.2.6 dùng đúng hai đường này |
| F9 | `role-extras.json` được giữ lại khi gỡ cài đặt, và được liệt kê trong mục những gì được giữ | delta 20260916-owner-feedback, dòng về gỡ cài đặt | Hai file mới ở §4.4.2 theo đúng cách đó |
| F10 | Luật "một Worker cho mỗi request" (`plugin/shared/sole-worker.ts`) đếm mọi Worker sống mang `bm.requestId`; có hai thì **không nhận ai** | mã | Worker đã bị thay phải bị loại khỏi phép đếm (§4.4.8) |
| F12 | `MutableDaemonConfigPatch` (`@getpaseo/protocol/dist/messages.d.ts` 154–213) dùng khoá **phẳng**: `providers` (cách daemon nhìn `agents.providers`, bản ghi `loose` nên giữ `extends`, `label`) được gộp sâu; `agentProfiles` (cách daemon nhìn `daemon.agentProfiles`) là mảng; và có **`removeProviders: string[]`** để xoá provider. `config.get()` trả cùng hai khoá phẳng (`plugin/server/roles.ts` 12–19, 75–77) | SDK, mã | Patch của `config-writer` dùng `providers` / `agentProfiles`, không dùng đường dẫn file. Xoá alias dự phòng bằng `removeProviders` (§4.3.4, §4.4.1) |
| F13 | `PaseoAgentHandle.send()` vào một agent **đang chạy** thì **thay** lượt của nó; plugin chỉ gửi khi `refresh()` báo không `running` | delta 20260918g K10; `review-budget.ts` | Mọi thông báo của plugin tới một agent có thể đang chạy đi qua `notice-queue` (§4.2.4, §4.3.5, §4.4.6) |
| F11 | Daemon **không** coi `bypassPermissions` của Claude là "không người trông" khi cho agent con thừa kế mode: một Reviewer Codex do Worker `bypassPermissions` tạo mà không truyền mode bị từ chối (`cannot inherit mode … Pass an explicit mode`). Luật đó chỉ miễn cho provider **không có mode nào** (đề xuất P11) | AGENTS.md (hai Worker, 2026-09-18); bundle `create-agent-mode.js` | Agent con trên provider `untiered` (OpenCode) phải được truyền **một mode tường minh**, không bỏ trống. Chỉ lớp `none` (Pi) mới bỏ trống được (§4.2.2) |

## 3. Kiến trúc

```
                ┌─────────────────────── plugin server (trong daemon) ─────────────────────────┐
 Paseo daemon   │ before("agent.create")  role-hook  ── profileOf / runPostureOf / factsOf     │
  ───────────▶  │ on("agent.created")     agent-labels + tools-check ── BM-TOOLS                │
  events        │ on("agent.turn_ended")  collector, format-check, review-budget,               │
                │                         settings-notices (BM-SETTINGS),                       │
                │                         fallback-detect ── fallback-state ── BM-FALLBACK      │
                │ timers (Q6 a)           fallback-wait ── BM-RESUME                             │
                │ notice-queue            BM-SETTINGS / BM-FALLBACK tới agent đang chạy           │
                │ RPC                     roles.settings / roles.options / roles.save-settings   │
                │                         roles.save-fallback / fallback.incidents / fallback.act│
                │                         ── config-writer ── paseo.config.patch                 │
                └────────────────────────────────────────────────────────────────────────────────┘
 plugin client: Setup → "Roles & models"; chat Manager → thẻ fallback; pill đang chờ
 CLI paseo-bm:  install (gộp, không thay nguyên), doctor (dòng thông tin), login (Pi: hướng dẫn)
 install home:  role-extras.json (có sẵn), role-fallback.json (mới), role-fallback-state.json (mới)
```

Mỗi phase chỉ thêm các khối của nó. Phase 2a-13 không cần màn hình mới hay ADR mới.

## 4. Thiết kế

### 4.1 Phase 2a-13 — Tôn trọng profile (REQ-062)

#### 4.1.1 Hook áp thinking và feature

`plugin/server/role-mode.ts` có thêm `profileOf(paseo, profileId)`. Hàm này trả `{ model, modeId, thinkingOptionId, featureValues } | null`. Nó đọc **một** lần `config.get()` trong ngân sách `withTimeout` 5 giây đang có, và thay chỗ của `profileModeOf`. `profileModeOf` giữ lại làm lớp bọc cho mã đang gọi nó.

`prepare()` trong `role-hook.ts` gọi `profileOf` cho vai trò của request. Hàm mới `applyRoleProfile(request, profile)` chạy sau `applyRoleInstructions` và trước `applyRoleMode`:

| Trường | Luật |
|---|---|
| `thinkingOptionId` | Đặt giá trị của profile khi cả ba điều sau đúng: (1) request **không** có `thinkingOptionId` khác rỗng; (2) profile có giá trị; (3) model của request (phần sau dấu `/` đầu tiên của `config.provider`, F2) **trùng** `profile.model`, **hoặc** request không nêu model. Model khác thì không đặt, vì thinking của model này có thể không có ở model kia |
| `featureValues` | Gộp nông: `{ ...profile.featureValues, ...request.featureValues }`, khoá do bên tạo truyền thắng. Rồi áp luật cách chạy ở §4.2.2; luật đó thắng mọi giá trị khác cho Reviewer |
| `modeId` | Không đổi: `applyRoleMode` và `chooseModeId` đã dùng mode của profile từ delta 20260917c |

`ROLE_GETS_MODE.manager` vẫn `false`. `manager.ensure` đã truyền thinking và feature của profile từ hôm nay (M8).

#### 4.1.2 Trình cài gộp thay vì thay nguyên

`src/roles/register.ts` và `applyProviders` / `applyProfiles` trong `src/paseo/config.ts` đổi theo luật sau. Một mục là **mục vai trò** khi id là `bm-manager`, `bm-worker`, `bm-reviewer`. Từ phase 2a-16 có thêm alias dự phòng `bm-<vai trò>-fallback-<n>` (§4.4.1).

| Mục đã có trong `config.json` | Cài / cập nhật **không** nêu vai trò đó bằng `--role` hay `--reconfigure` | Cài nêu vai trò đó |
|---|---|---|
| alias `agents.providers.bm-<vai trò>` | **Giữ mọi khoá.** Chỉ bảo đảm `paseoTools.enabled === true` cho Manager và Worker, gộp vào `paseoTools` đang có nên `disabledTools` còn nguyên. Không bao giờ thêm `paseoTools` cho Reviewer. Thiếu `extends` thì lấy từ `install.json` `roles[]` | Đặt `extends` và `label` từ lựa chọn mới; mọi khoá khác giữ |
| profile `daemon.agentProfiles[bm-<vai trò>]` | **Giữ mọi khoá.** Chỉ bảo đảm `provider === "bm-<vai trò>"`. Thiếu `model` hay `name` thì lấy từ `roles[]` | Đặt `name` và `model`; **xoá** `thinkingOptionId` khi model đổi, vì mức thinking thuộc về model; mọi khoá khác giữ |
| alias `bm-<vai trò>-fallback-<n>` | Không đụng | Không đụng: không có cờ CLI cho chuỗi dự phòng |
| mục vai trò **chưa có** | Tạo như hôm nay, từ `roles[]` (REQ-027d) | Tạo từ lựa chọn mới |

`install.json` `roles[]` giữ **đúng hình dạng hiện có**. Ý nghĩa đổi thành "trình cài đã ghi gì lần cuối". Hệ quả: trình cài vẫn ghi `modeId: null` và `thinkingOptionId: null` ở đó như hôm nay, dù profile có giá trị. Lệnh gỡ vẫn xoá mọi mục có id bắt đầu bằng `bm-` (M16).

**Idempotent (thiết kế gốc §8):** chạy lại cùng phiên bản trên một mục đã đủ khoá thì không có `changedPaths`, vì gộp không đổi gì. REQ-009 vẫn đúng.

#### 4.1.3 `doctor`

`roleChecks` thêm một kiểm **info**, id `roles.changed-in-app` (errata khi implement: hợp đồng JSON §4.4 của thiết kế gốc chỉ có `ok | warn | error`, nên kiểm này mang severity `ok`, như `payload-versions` và `backups`; nó xuất hiện một lần cho mỗi vai trò bị đổi). Nó so `extends` của alias và `model` của profile với `roles[]`; khác thì báo: `bm-worker: base provider or model differs from what the installer wrote (changed in the app).` Kiểm này không bao giờ nâng mã thoát.

### 4.2 Phase 2a-14 — Mọi provider cho mọi vai trò (REQ-063)

#### 4.2.1 Ba lớp khả năng

`plugin/server/role-mode.ts` có thêm `capabilityOf(modes, features)`:

| Lớp | Nhận ra bằng | Ví dụ |
|---|---|---|
| `tiered` | `listModes` trả ít nhất một mode có `colorTier` | Claude, Codex |
| `untiered` | `listModes` trả mode, không mode nào có `colorTier` | OpenCode (F1) |
| `none` | `listModes` trả **danh sách rỗng, không có `error`** | Pi (F1) |
| `unknown` | `listModes` lỗi, hết giờ, hoặc trả `error` | — |

`modesFor` đổi: danh sách rỗng mà không có `error` → trả `[]` và **không** log. Chỉ lỗi, hết giờ hay có `error` mới trả `null` như hôm nay (F3).

Feature tự duyệt: feature `toggle` có id `auto_accept` trong `providers.listFeatures({ provider: "<alias>/<model>" })`. Hàm chỉ tra feature khi lớp là `untiered`, để provider `tiered` không tốn thêm một lời gọi.

#### 4.2.2 Cách chạy theo vai trò

Hàm mới `runPostureOf(role, capability, modes, features, profile)` trả `{ modeId?: string, featureValues?: Record<string, unknown> }`. Hook dùng nó cho Worker và Reviewer; `manager.ensure` dùng nó cho Manager.

| Vai trò | `tiered` | `untiered` | `none` | `unknown` |
|---|---|---|---|---|
| **Manager** | `managerModeFor` như hôm nay | `modeId` = mode của profile nếu provider liệt kê nó, không thì mode **đầu tiên** provider liệt kê (F11: không bao giờ bỏ trống); `auto_accept: true` khi provider có feature đó, **trừ khi** profile tự đặt `auto_accept` | không truyền mode, không feature | như hôm nay: mode mặc định, có log |
| **Worker** | `chooseModeId` như hôm nay | như Manager | không truyền mode | như hôm nay |
| **Reviewer** | `chooseModeId` như hôm nay (không `dangerous` / `planning`) | `modeId` như Manager (mode của profile, không thì mode đầu tiên); `auto_accept` **luôn `false`**, đè cả giá trị của profile lẫn giá trị daemon tự bật (đề xuất P10); owner chấp nhận rủi ro còn lại (Q7 a) | không truyền mode; Pi không có lớp duyệt quyền (đề xuất P6) | như hôm nay |

Với OpenCode, mode là một agent do người dùng khai trong cấu hình OpenCode (F1). "Mode đầu tiên" nghĩa là agent đầu tiên Paseo liệt kê. Người dùng muốn agent khác, ví dụ một agent chỉ đọc cho Reviewer, thì chọn nó trên profile hoặc trên màn Roles & models.

Manager đang có trên provider `untiered` không được đổi feature, vì plugin không đổi được feature của agent đã tồn tại (đề xuất S9). `manager.ensure` trả một notice nói điều này, cùng kênh `modeNotice` đang có.

`REVIEWER_FALLBACK_MODE` (`auto`) chỉ được dặn khi provider gốc của `bm-reviewer` là `claude` hay `codex` (F4). Provider gốc đọc từ `extends` trong `config.get()`. Còn lại thì không dặn gì, và Worker gửi `blocked` với lỗi của Paseo như luật hiện có.

#### 4.2.3 `## Runtime facts`

`runtimeFactsText` có ba dạng cho dòng mode của agent con:

| Tình huống | Dòng (tiếng Anh, dành cho agent) |
|---|---|
| `tiered` hay `untiered` | ``Worker mode: `bypassPermissions` — pass it as `settings.modeId` when you create a Worker.`` (như hôm nay; với `untiered` là agent OpenCode của §4.2.2) |
| `none` | ``Worker mode: none — do not pass `settings.modeId` when you create a Worker; Paseo sets it.`` |
| `unknown` | không có dòng (như hôm nay) |

Với Reviewer thì thay `Worker` bằng `Reviewer`. `plugin/roles/manager.md` và `worker.md` sửa câu "Paseo refuses to create a Worker without one": câu mới nói truyền đúng giá trị Runtime facts nêu, kể cả "none". Không thêm quy tắc mới nào khác.

#### 4.2.4 Kiểm công cụ Paseo sau khi tạo

| Agent | Khi nào | Tín hiệu | Báo ở đâu |
|---|---|---|---|
| Manager | trong `manager.ensure`, ngay sau khi tạo | `handle.current()?.capabilities?.supportsMcpServers === false` | trường mới `toolsNotice: string \| null` của output `manager.ensure`; màn Manager hiện nó như `modeNotice` |
| Worker (kể cả Worker dự phòng) | `on("agent.created")` trong `agent-labels.ts`, sau khi gắn nhãn | cùng tín hiệu, đọc qua `paseo.agents.ref(id)` | thông báo `BM-TOOLS` gửi Manager cha (nhãn `paseo.parent-agent-id`), theo mẫu dưới |

```
BM-TOOLS Worker <id> runs on <provider> without Paseo tools (on Pi this means pi-mcp-adapter is missing). It cannot send you a BM-REPORT or create a Reviewer. Tell the user in one line; do not create another Worker for this request unless the user asks.
```

- Lúc Worker vừa được tạo, Manager cha thường **đang chạy** (nó vừa gọi `create_agent`), và `send()` vào agent đang chạy thì thay lượt của nó (F13). Vì vậy `BM-TOOLS` đi qua **`plugin/server/notice-queue.ts`**, module này được tạo ở đây (phase 2a-14): đích đang nghỉ thì gửi ngay (kiểm bằng `refresh()`), đang chạy thì chờ `agent.turn_ended` kế tiếp của đích. `BM-SETTINGS` (§4.3.5) và `BM-FALLBACK` (§4.4.6) dùng lại đúng module này.
- Mọi lần kiểm ghi kết quả vào một bảng trong bộ nhớ: `role → { agentId, provider, supportsMcpServers, at }`. `setup.status` trả thêm `paseoTools: { manager, worker }`, mỗi cái `{ state: "ok" | "missing" | "unknown", agentId, provider, at } | null`.
- `BM-TOOLS` vào danh sách `PREFIXES` của `notices.ts`. `manager.md` có một dòng: thông báo bắt đầu bằng `BM-TOOLS` là của plugin.
- **Phải kiểm trên daemon thật** rằng Pi thiếu adapter thật sự cho `supportsMcpServers === false`: đề xuất O4 chỉ suy từ mã. Tín hiệu sai thì WP bị chặn và hỏi owner, không đổi sang tín hiệu khác.

#### 4.2.5 Trình cài: đăng nhập

`src/roles/login.ts`: provider `pi` không có lệnh đăng nhập. Trình cài in `Pi has no login command paseo-bm knows; sign in the way Pi's own documentation describes, then run doctor.` Trạng thái đăng nhập là `unknown`, như mọi provider ngoài Claude.

#### 4.2.6 Cột skill cho Pi và OpenCode

`plugin/server/setup-skills.ts` và `setupStatusSchema`: `skills.dirs` thêm `pi: "~/.pi/agent/skills"` và `opencode: "~/.config/opencode/skill"` (F8). Mỗi dòng skill thêm `pi` và `opencode` với cùng `skillStateSchema`; `missingRequired` thêm hai khoá. Các trường mới là **tuỳ chọn** trong lược đồ, nên client cũ vẫn đọc được. Không có biến môi trường ghi đè hai đường này trong bản này. CLI `--skills-agents` và `doctor` không đổi (PRD delta §7.2).

#### 4.2.7 Giá theo `metadata.cost`

- `traceRecordSchema.runtime` thêm `provider?: string | null`, tuỳ chọn. Bộ thu thập điền từ `snapshot.provider` của payload `timeline.refetch`, ví dụ `bm-worker`. Giữ `v: 1`, không di trú (ADR-007, cùng luật delta 20260918 N8).
- `plugin/server/model-costs.ts` (mới) có `costOf(provider, model)`. Hàm gọi `providers.listModels(provider)` một lần mỗi provider mỗi lần plugin chạy, nhớ kết quả, giới hạn 5 giây. Kết quả là `ModelPrice` với `input` → `inputUsdPerMTok`, `output` → `outputUsdPerMTok`, `cache.read` → `cacheReadUsdPerMTok`. Thiếu `cache.read` thì dùng `input`. Bỏ qua `tiers` và `experimentalOver200K`.
- Thứ tự giá: bảng `MODEL_PRICES` có sẵn → `costOf(runtime.provider, model)` → không có (chỉ hiện token như hôm nay). Bản ghi cũ không có `runtime.provider` thì chỉ dùng bảng.
- Dashboard, thẻ dự phòng (§4.4.6) và màn Roles & models (§4.3.2) dùng cùng hàm này.

#### 4.2.8 Nhận "đã nạp skill"

`collector.ts` giữ hai tín hiệu hiện có: công cụ `Skill` của Claude, và việc đọc `<skill>/SKILL.md`. Tín hiệu đọc `SKILL.md` không phụ thuộc provider. Nghiệm thu trên OpenCode và Pi ghi lại tín hiệu nào xuất hiện thật. Nếu không tín hiệu nào xuất hiện, `skillsUsed` của Dashboard hiện "không ghi nhận" cho agent đó: đây là giới hạn đã biết, không phải lỗi chặn.

### 4.3 Phase 2a-15 — Màn "Roles & models" (REQ-064, ADR-008)

#### 4.3.1 Giao diện

Beads Manager → **Setup** có thêm mục **Roles & models**, ở ngay trên mục "Additional instructions" đang có. Chữ giao diện tiếng Anh, như phần còn lại:

```
Roles & models
┌ Manager   Claude · Opus 5 · thinking high · mode Bypass                  [Edit]
│   On a usage limit: (•) Ask me ( ) Off   Fallback 1 Codex · GPT-5.6-Sol  (2a-17)
├ Worker    Claude · Opus 5 · thinking high                                 [Edit]
│   ⚠ Manager and Worker share the Claude plan: if the Worker hits its limit, the Manager stops too.
│   On a usage limit: (•) Ask me   ( ) Off                                  (2a-16)
│   Fallback 1  Codex · GPT-5.6-Sol · high                        [↑][↓][Remove]   (2a-16)
│   [+ Add fallback]                                                         (2a-16)
└ Reviewer  Codex · GPT-5.6-Sol · thinking provider default · mode auto     [Edit]
    On a usage limit: (•) Ask me ( ) Off   [+ Add fallback]                 (2a-17)
Changes apply to agents created after you save. Running agents keep their model and thinking.
```

Mỗi vai trò có một khối chuỗi dự phòng cùng dạng. Khối của Worker có từ 2a-16; khối của Manager và Reviewer có từ 2a-17 (§4.5).

Form **Edit**:

| Trường | Nguồn | Luật |
|---|---|---|
| Provider | `providers.listAvailable()` / `snapshot()`: provider gốc có `status: "available"`, **không** gồm alias `bm-*` | mọi provider chọn được cho mọi vai trò (Q4). Cảnh báo theo REQ-063 h |
| Model | `providers.listModels(<provider>)` | bắt buộc, phải có trong danh sách |
| Thinking | `thinkingOptions` của model đã chọn | ẩn khi model không có; để trống = mặc định của provider |
| Mode | `providers.listModes(<provider>)` | `tiered`: Reviewer không chọn được mode `dangerous` / `planning`. `untiered`: danh sách là các agent OpenCode của người dùng, cho mọi vai trò, không bắt buộc. `none`: ẩn |
| Giá | `costOf` (§4.2.7) | hiện `~$in / $out per 1M tokens` khi có |

#### 4.3.2 RPC

Tên chữ thường theo luật SDK, định nghĩa Zod trong `plugin/shared/contracts.ts`:

| RPC | Input | Output |
|---|---|---|
| `roles.settings` | `{}` | `{ revision: string, roles: RoleSetting[], fallback: Record<Role, FallbackSettings> \| null, warnings: string[] }` |
| `roles.options` | `{ provider: string }` (provider gốc) | `{ provider, capability, models: [{ id, label, thinkingOptions: [{ id, label }], defaultThinkingOptionId, cost: ModelPrice \| null }], modes: [{ id, label, colorTier \| null }], autoAccept: boolean }` |
| `roles.save-settings` | `{ revision, role, baseProvider, model, thinkingOptionId: string \| null, modeId: string \| null }` | `{ revision, role: RoleSetting, warnings: string[], notified: number }` |

`RoleSetting = { role, providerId: "bm-<vai trò>", baseProvider: string | null, label: string | null, model: string | null, thinkingOptionId: string | null, modeId: string | null, featureValues: Record<string, unknown>, capability: "tiered" | "untiered" | "none" | "unknown" }`.

- `roles.describe` giữ nguyên cho client cũ.
- *(Errata khi implement, 2026-09-22, bead `bm-phase-2a-15-roles-and-models-kj1p.4`):* output của `roles.settings` có thêm `providers: string[]` — các provider gốc Paseo báo `available`, không gồm alias `bm-*`, xếp theo tên. Đó chính là nguồn của trường Provider ở §4.3.1, để form không phải gọi thêm RPC. Chỉ cộng thêm.
- `FallbackSettings` và `roles.save-fallback` thuộc §4.4.3. Ở phase 2a-15 trường `fallback` luôn là `null`; từ 2a-16 nó là `Record<Role, FallbackSettings>` của các vai trò đã bật.

`revision` là sha256 của chuỗi JSON chuẩn hoá (khoá sắp xếp) gồm `{ providers: <mọi mục bm-* của config.providers>, profiles: <toàn bộ mảng config.agentProfiles> }`, đọc bằng `config.get()` (F12). Toàn bộ mảng profile nằm trong `revision`, vì ghi là thay cả mảng.

#### 4.3.3 Kiểm khi lưu

Chạy trước mọi lần ghi. Lỗi → `E_ROLE_SETTINGS_INVALID`, không ghi gì:

1. `baseProvider` có trong danh sách available, và không phải alias `bm-*`.
2. `model` có trong `listModels(baseProvider)`.
3. `thinkingOptionId` là `null` hoặc nằm trong `thinkingOptions` của model đó.
4. `modeId` là `null` hoặc nằm trong `listModes(baseProvider)`. Reviewer trên `tiered`: không `dangerous`, không `planning`.
5. Tên vai trò hợp lệ; chuỗi không quá 200 ký tự.

Cảnh báo, không chặn, trả trong `warnings`:
- Manager và Worker cùng provider gốc (đề xuất §2.1);
- các trường hợp của REQ-063 h;
- model có `cost` (§4.2.7).

#### 4.3.4 Ghi — `plugin/server/config-writer.ts` (mới)

Mọi lần ghi của plugin đi qua **một** mutex trong tiến trình, nên hai lần Lưu không chen nhau.

1. `config.get()` → tính `revision` hiện tại. Khác `input.revision` → `E_ROLE_SETTINGS_CONFLICT` ("the configuration changed elsewhere; reopen Roles & models"), không ghi.
2. Dựng patch:
   - `providers["bm-<vai trò>"] = { extends: baseProvider }` (F12: khoá phẳng, là `agents.providers` của file). Daemon gộp sâu, nên `label` và `paseoTools` còn nguyên (đề xuất S10).
   - `agentProfiles` (F12: là `daemon.agentProfiles` của file) = **đúng mảng vừa đọc ở bước 1**, chỉ thay mục `bm-<vai trò>` tại chỗ: `model`, `thinkingOptionId` và `modeId` đặt theo input; `null` nghĩa là **xoá** khoá, không ghi `null`. Mọi khoá khác của mục đó giữ nguyên.
   - Profile `bm-<vai trò>` không có trong mảng → `E_ROLE_SETTINGS_INVALID` ("run npx paseo-bm install first"). Plugin **không** tạo mục vai trò; tạo vẫn là việc của trình cài.
3. `config.patch(patch)`. Lỗi → `E_ROLE_SETTINGS_WRITE_FAILED`, kèm lời của daemon. Daemon tự trả lại file cũ khi lỗi (S10).
4. `config.get()` lần nữa, và kiểm **chính mục `bm-*` vừa ghi** đã có đúng giá trị (alias và profile). Không khớp → `E_ROLE_SETTINGS_WRITE_FAILED` ("Paseo did not keep the saved values"). Không ghi lại. *(Errata 2026-09-22, owner Q15 a: bản trước so các profile không phải `bm-*` để "báo profile bị ghi đè". Việc đó không làm được: một thay đổi rơi vào khoảng giữa bước 1 và bước 3 bị lần ghi — thay cả mảng — trả về đúng bản đã đọc, nên lần đọc lại thấy giống hệt. Plugin chỉ **thu hẹp** được cửa sổ: kiểm `revision`, và đọc ngay trước khi ghi, trong cùng một lượt xử lý.)*
5. Trả `revision` mới.

Ghi alias trước hay profile trước không quan trọng: cả hai nằm trong **một** lần `patch`. Alias dự phòng ở §4.4.3 dùng cùng đường này.

#### 4.3.5 Agent đang sống: `BM-SETTINGS`

Theo F5, một Manager sống qua lần đổi provider của Worker sẽ truyền mode cũ và bị daemon từ chối. Sau một lần lưu làm **đổi dòng Runtime facts** của agent con, plugin xử lý như sau:

- Mode của Worker đổi → đích là mọi Manager sống. Mode của Reviewer đổi → đích là mọi Worker sống, kể cả Worker dự phòng. "Sống" nghĩa là chưa lưu trữ, xét trên mọi workspace, tìm bằng `listAllAgents` và `roleOfAgent`.
- Đích đang nghỉ → gửi ngay. Đích đang chạy → đặt vào hàng chờ trong bộ nhớ (`plugin/server/notice-queue.ts`, tạo ở §4.2.4, dùng chung với §4.4.6), **thay** tin `BM-SETTINGS` cũ nếu có (tin mới chỉ thay tin cùng loại), gửi ở `agent.turn_ended` kế tiếp của đích đó.
- Nội dung là dòng Runtime facts mới, nguyên văn:

```
BM-SETTINGS The user changed the paseo-bm role settings. This replaces the matching line under "## Runtime facts":
Worker mode: `<modeId>` — pass it as `settings.modeId` when you create a Worker.
Do not reply to this message; carry on with what you were doing.
```

- `roles.save-settings` trả `notified` = số đích đã gửi hoặc đã xếp hàng.
- Hàng chờ mất khi plugin nạp lại. Lúc đó agent rơi về hành vi hiện có: Paseo từ chối, agent gửi `blocked` với lỗi của Paseo. Không đích nào nhận tin khi dòng Runtime facts không đổi.
- `BM-SETTINGS` vào `PREFIXES` của `notices.ts`, và không bao giờ được đếm là lượt review.
- `manager.md` và `worker.md` mỗi file có một câu: tin bắt đầu bằng `BM-SETTINGS` là của plugin, thay dòng Runtime facts tương ứng rồi làm tiếp.

#### 4.3.6 Sống chung với CLI

- `npx paseo-bm install` giữ mọi thay đổi trên màn này (§4.1.2).
- `doctor` báo dòng thông tin §4.1.3.
- Settings → Agent profiles của Paseo đọc và sửa cùng dữ liệu. Sửa ở đó trong lúc màn này đang mở thì lần Lưu kế tiếp bị chặn bằng `E_ROLE_SETTINGS_CONFLICT`.

### 4.4 Phase 2a-16 — Dự phòng theo vai trò: hạ tầng chung và Worker (REQ-065)

Owner chốt Q8 c: **cả ba vai trò** có chuỗi dự phòng. Hạ tầng của phase này (alias, file, phát hiện, sự cố, thẻ, hẹn giờ) được viết **cho cả ba vai trò** ngay từ đầu, để phase 2a-17 không phải di trú gì. Nhưng phase này chỉ **bật** vai trò Worker. Tập vai trò được bật là hằng số `FALLBACK_ROLES` trong `plugin/shared/fallback.ts`: `["worker"]` ở 2a-16, `["worker", "reviewer", "manager"]` từ 2a-17.

#### 4.4.1 Alias dự phòng và nhận vai

- Mỗi mục `n` (1…3) của chuỗi một vai trò có alias `agents.providers["bm-<vai trò>-fallback-<n>"]`, ghi bằng đường §4.3.4:

  | Vai trò | Alias |
  |---|---|
  | Manager | `{ extends, label: "Manager (fallback <n>)", paseoTools: { enabled: true } }` |
  | Worker | `{ extends, label: "Worker (fallback <n>)", paseoTools: { enabled: true } }` |
  | Reviewer | `{ extends, label: "Reviewer (fallback <n>)" }` — **không** `paseoTools` (ADR-006 QĐ3) |

- Alias dự phòng **không có profile**: model, thinking, mode nằm trong `role-fallback.json`, vì chuỗi là khái niệm riêng của paseo-bm (ADR-008).
- Xoá một mục thì plugin xoá alias của nó bằng `removeProviders` của patch (F12), và đánh số lại các mục sau để số `n` luôn liền nhau.
- `agent-role.ts`: `roleOfProvider` nhận thêm mẫu `^bm-(manager|worker|reviewer)-fallback-[1-3]$`, trả đúng vai trò trong tên.
  - Mọi chỗ nhận vai bằng tên alias cố định đổi sang `roleOfProvider`. Đó là: `WORKER_PROVIDER_ID` trong `stop-propagation.ts` (`isCanceledWorkerTurn`); bảng `COLLECTED_PROVIDERS` của `collector.ts`, vì không có nó thì lượt của agent dự phòng không được ghi vết; `COUNTED_ROLES` của `review-budget.ts`; và `isBmRequest` / `modeLookupFor` / `prepare` của `role-hook.ts`, vốn tra `ROLE_BY_PROVIDER`.
  - `ROLE_BY_PROVIDER` vẫn là bảng của ba alias chính.
  - `listModes` và `listFeatures` tra theo alias thật của agent, ví dụ `bm-worker-fallback-1`.

#### 4.4.2 Hai file mới trong thư mục cài đặt

Cả hai là **dữ liệu người dùng**, cùng cách với `role-extras.json` (F9):
- quyền `0600`, ghi bằng file tạm rồi rename (`writeStoreFileAtomically`), có chặn symlink;
- không hash trong `install.json`; cập nhật và `--prune` không bao giờ chạm;
- gỡ cài đặt giữ lại và liệt kê trong mục "được giữ".

**`role-fallback.json`** — cài đặt người dùng:

```ts
type Role = "manager" | "worker" | "reviewer";
{
  version: 1,
  roles: Partial<Record<Role, {
    policy: "ask" | "off" | "auto",       // "auto" chỉ được nhận từ phase 2a-18
    entries: Array<{                      // 0..3 mục, theo thứ tự
      baseProvider: string,               // provider gốc, không phải alias
      model: string,
      thinkingOptionId: string | null,
      modeId: string | null,
    }>,
  }>>,
  patterns?: Partial<Record<"L1" | "L2" | "L3" | "L4" | "L5", string[]>>, // regex, cờ "i"; chỉ sửa tay; chung cho mọi vai trò
}
```

- Thiếu file, hay thiếu một vai trò, thì vai trò đó mặc định `{ policy: "ask", entries: [] }`. Người dùng chưa khai mục nào vẫn nhận thẻ, với nút "Chờ" và "Để tôi".
- `patterns` thiếu một loại thì dùng bộ mặc định §4.4.4 của loại đó.
- File hỏng → dùng mặc định, log một dòng, và màn Roles & models hiện lỗi.

**`role-fallback-state.json`** — sự cố:

```ts
{
  version: 1,
  incidents: Array<{
    id: string,                          // "fb-" + 12 ký tự hex ngẫu nhiên
    role: Role,
    workspaceId: string, requestId: string | null,   // requestId: null với Manager
    agentId: string, agentProvider: string, agentModel: string | null,
    parentId: string | null,             // Worker của Reviewer; Manager của Worker; null với Manager
    managerId: string | null,            // chat nơi thẻ hiện (§4.4.6)
    class: "L1" | "L2" | "L4" | "L5",
    signal: "failed" | "completed",      // N1 hay N2
    message: string,                     // nguyên văn, cắt 500 ký tự
    perModelWindow: boolean,
    resetsAt: string | null,             // ISO; null khi không biết
    candidate: { position: number, alias: string, baseProvider: string, model: string, thinkingOptionId: string | null, modeId: string | null } | null,
    status: "pending" | "switched" | "waiting" | "resumed" | "dismissed" | "exhausted" | "expired" | "failed",
    detectedAt: string, decidedAt: string | null,
    waitUntil: string | null,
    replacementId: string | null,
    error: string | null,
  }>,
}
```

- Giữ tối đa 200 sự cố; bỏ sự cố cũ nhất trong số đã xong trước.
- Mọi lần đọc-sửa-ghi đi qua một mutex trong tiến trình.

#### 4.4.3 Cài đặt chuỗi — `roles.save-fallback`

| RPC | Input | Output |
|---|---|---|
| `roles.save-fallback` | `{ revision, role, policy: "ask" \| "off", entries: [{ baseProvider, model, thinkingOptionId, modeId }] }` (tối đa 3) | `{ revision, fallback: FallbackSettings, warnings }` |

`FallbackSettings = { role, policy, entries: [{ position, alias, baseProvider, model, thinkingOptionId, modeId, capability, cost }], patternsFromFile: boolean }`. Trường `fallback` của `roles.settings` (§4.3.2) thành `Record<Role, FallbackSettings> | null`, chỉ gồm các vai trò đã bật.

- `role` phải nằm trong `FALLBACK_ROLES`, không thì `E_ROLE_SETTINGS_INVALID`.
- Mỗi mục qua đúng các kiểm của §4.3.3, với luật mode của vai trò đó: Reviewer không `dangerous` / `planning`.
- Chặn thêm hai trường hợp: hai mục trùng cả `baseProvider` lẫn `model`; một mục trùng provider gốc và model của vai trò chính.
- Mục cùng provider gốc với vai trò chính được **cảnh báo**: `only helps when the limit is per model`.
- Ghi alias qua `config-writer` trước, rồi mới ghi `role-fallback.json`. Ghi file lỗi sau khi alias đã ghi → trả lỗi. Alias thừa vô hại, vì không mục nào dùng nó; lần lưu sau dọn nó.

#### 4.4.4 Phát hiện và phân loại — `plugin/server/fallback-detect.ts`

Plugin đăng ký thêm vào `on("agent.turn_ended")` đang có. Chỉ xét agent có vai trong `FALLBACK_ROLES` (`roleOfAgent`), và không có nhãn `bm.replacedBy`. Policy của vai trò là `"off"` thì chỉ ghi sự cố (§4.4.5), để phase 2a-18 có dữ liệu. Hai tín hiệu:

- **N1:** `outcome.kind === "failed"`; chữ dùng để so là `outcome.error.message`.
- **N2:** `outcome.kind === "completed"`, thoả cả bốn điều. Chữ dùng để so là tin assistant cuối (đề xuất S3).
  1. Timeline của lượt **không có lời gọi công cụ nào**.
  2. Lượt **không có** khối `BM-REPORT` hay `BM-REVIEW`.
  3. Tin assistant cuối **≤ 500 ký tự**.
  4. Hoặc token ra của lượt bằng **0** (đọc như bộ thu thập đang đọc `usage` của lượt), hoặc — khi provider không báo token — tin mở đầu lượt **không** phải thông báo của plugin (`isPluginNotice`). Điều 4 chặn ca Manager giải thích một `BM-FALLBACK` bằng một câu ngắn có chữ "limit".

Phân loại chữ, theo thứ tự, loại đầu tiên khớp thắng:

| Thứ tự | Loại | Mẫu mặc định (regex, không phân biệt hoa thường) | Kết quả |
|---|---|---|---|
| 1 | L1 | `usage limit`, `limit reached`, `hit your (usage )?limit`, `limit (will )?reset`, `resets? (at\|in) ` | dự phòng |
| 2 | L2 | `credit balance`, `billing`, `subscription (has )?(expired\|ended\|inactive)`, `payment (required\|failed)`, `quota exceeded` | dự phòng |
| 3 | L4 | `not logged in`, `please (run )?/?login`, `invalid api key`, `authentication (failed\|error)`, `\b401\b`, `oauth token (has )?expired` | dự phòng |
| 4 | L5 | `provider (is )?unavailable`, `process exited with code`, `command not found`, `ENOENT` | dự phòng |
| 5 | L3 | `rate[ _]limit`, `overloaded`, `\b429\b`, `\b529\b`, `too many requests` | không dự phòng |
| — | L6 | không khớp gì | không dự phòng |

- Mẫu mặc định nằm trong `plugin/shared/fallback-patterns.ts`. Đây là **điểm khởi đầu chưa kiểm trên sự cố thật** (đề xuất §1.5): nghiệm thu phase 2a-16 và điều kiện vào phase 2a-18 kiểm lại chúng.
- L1 đứng trước L3 vì thông báo hết hạn mức của gói có thể chứa chữ "rate limit".
- Phân loại xong mà thuộc L3 hoặc L6 → không làm gì, như hôm nay.

#### 4.4.5 Dựng sự cố

1. **Chống trùng.** Agent đã có sự cố `pending`, `waiting` hay `switched` → dừng.
2. **Hạn mức** (Q2 a). Chỉ khi loại là L1, provider gốc là `claude` hay `codex`, và policy khác `"off"`: gọi `providers.listUsage()` **một lần**, giới hạn 5 giây, rồi tìm mục của provider gốc đó.
   - Cửa sổ đã hết là cửa sổ có `usedPct >= 100` hoặc `remainingPct <= 0`.
   - `resetsAt` = `resetsAt` **muộn nhất** trong các cửa sổ đã hết.
   - `perModelWindow = true` khi mọi cửa sổ đã hết có id chứa tên một họ model (`opus`, `sonnet`, `haiku`, `gpt`), ví dụ `seven_day_opus` (đề xuất S6).
   - Lỗi, hết giờ, hay không cửa sổ nào đã hết → `resetsAt: null`, `perModelWindow: false`.
3. **Ứng viên.** Chuỗi của vai trò là `[bm-<vai trò>, bm-<vai trò>-fallback-1, …]`. Vị trí của agent vừa hỏng lấy từ alias của nó (`bm-<vai trò>` = 0). Xét lần lượt các mục **sau** vị trí đó, bỏ mục nếu gặp một trong các trường hợp sau:
   - alias của mục đã hỏng trong cùng phạm vi, theo các sự cố đã ghi. Phạm vi là `requestId` với Worker và Reviewer, `workspaceId` với Manager;
   - provider gốc không `available`;
   - **cùng provider gốc** với agent vừa hỏng, khi loại là L2 hay L4, hoặc L1 mà `perModelWindow` là `false`;
   - L1 có `perModelWindow`, cùng provider gốc, và model cùng họ.

   Mục đầu tiên còn lại là ứng viên. Không còn mục nào → `candidate: null`.
4. **`managerId`**, tức chat nơi thẻ hiện:

   | Vai trò | `managerId` |
   |---|---|
   | Worker | Manager cha (nhãn `paseo.parent-agent-id`) |
   | Reviewer | Manager cha của Worker cha |
   | Manager | chính nó |

5. Ghi sự cố `pending`. Policy `"off"` thì ghi `dismissed` và dừng ở đây.
6. Gửi `BM-FALLBACK` cho `managerId` (§4.4.6). Không có `managerId` thì chỉ có pill.

#### 4.4.6 Thông báo `BM-FALLBACK`, thẻ và pill

Plugin gửi bằng `agents.ref(id).send(text)`, như `BM-BUDGET`. Đích đang chạy thì tin vào **hàng chờ gửi** chung `plugin/server/notice-queue.ts` (§4.2.4, F13), gửi ở `agent.turn_ended` kế tiếp của đích; `BM-TOOLS` và `BM-SETTINGS` dùng cùng hàng chờ này.

```
BM-FALLBACK
incident: fb-3f9a2c1d7e4b
role: worker
agent: <id của agent hỏng>
requestId: req-20260921T111242Z | none
status: pending
class: L1 usage limit
provider: bm-worker (claude) · claude-opus-5
message: <nguyên văn, một dòng, cắt 300 ký tự>
resetsAt: 2026-09-21T15:40:00Z | unknown
candidate: bm-worker-fallback-1 · codex · gpt-5.6-sol · thinking high | none
replacement: none

The <role> stopped because of its provider plan. The user decides on the card in this chat. Tell the user in one line; do not create an agent yourself.
```

- Sau khi người dùng chọn, plugin gửi thêm một `BM-FALLBACK` cùng `incident`, với `status` mới (`switched`, `waiting`, `resumed`, `dismissed`, `failed`) và `replacement` khi có.
- `managerId` khác provider gốc với agent hỏng thì đọc được tin này và trả lời người dùng. Cùng provider gốc thì lượt của nó hỏng, vô hại, nhưng tin vẫn nằm trong timeline — **phải kiểm trên daemon thật** (§8).

Thẻ và pill:
- **Thẻ.** `plugin/shared/bm-fallback.ts` đọc khối (bộ đọc khoan dung, cùng kiểu `bm-report.ts`); `chat-cards.ts` thêm loại thẻ `fallback`. Thẻ lấy trạng thái thật từ RPC `fallback.incidents`, không từ chữ, nên tin cũ không bao giờ hiện nút đã hết hiệu lực.
- **Nút:**
  - **Switch to <candidate · cost>**: khi có ứng viên;
  - **Wait until <giờ địa phương>**: khi có `resetsAt` và giờ đó chưa quá 7 ngày nữa;
  - **I'll handle it**: luôn có.
- **Pill.** `chat.waiting` đếm thêm sự cố `pending` có `managerId` là Manager đó. Bấm pill mở thẻ. Pill đọc RPC, không đọc timeline, nên vẫn đúng khi lượt của Manager hỏng.
- `BM-FALLBACK` và `BM-RESUME` vào `PREFIXES` của `notices.ts`. `manager.md` có một câu cho `BM-FALLBACK`: báo người dùng một dòng, không tự tạo agent; khi `status: switched` thì theo dõi agent ở dòng `replacement`.

| RPC | Input | Output |
|---|---|---|
| `fallback.incidents` | `{ workspaceId?: string, ids?: string[] }` | `{ incidents: Incident[] }` (hình dạng §4.4.2) |
| `fallback.act` | `{ incidentId, action: "switch" \| "wait" \| "dismiss" }` | `{ incident: Incident }` |

Lỗi mới: `E_FALLBACK_NOT_FOUND`, `E_FALLBACK_NOT_PENDING` (sự cố không còn `pending`), `E_FALLBACK_NO_CANDIDATE`, `E_FALLBACK_NO_RESET`, `E_FALLBACK_CREATE_FAILED`.

#### 4.4.7 Chuyển Worker — `action: "switch"`, vai trò `worker`

1. Lấy mutex; sự cố phải `pending` và có `candidate`; Worker cũ chưa có `bm.replacedBy`.
2. Ứng viên vẫn `available`, không thì `E_FALLBACK_NO_CANDIDATE`.
3. Dựng `BM-HANDOVER` (§4.4.8), tổng ngân sách 5 giây. Phần nào quá giờ thì ghi `unknown`, không chặn.
4. Tạo Worker:

   ```ts
   paseo.agents.create({
     config: {
       provider: `bm-worker-fallback-${n}/${model}`,
       thinkingOptionId?,                           // từ mục
       modeId?,        // của mục; không có thì mode của runPostureOf("worker", …) cho alias đó (§4.2.2)
       featureValues?, // runPostureOf, vd. auto_accept trên OpenCode
     },
     cwd: <cwd của Worker cũ>,
     parent: managerId ?? undefined,
     title: "Beads Worker (fallback)",
     labels: { "bm.role": "worker", "bm.requestId": requestId, "bm.version": PLUGIN_VERSION, "bm.replaces": oldId },
     prompt: handover,
   })
   ```

   Hook §4.2 vẫn chạy cho lần tạo này: nạp chỉ dẫn và chọn cách chạy theo khả năng provider.
5. `setAgentLabels(oldId, { "bm.replacedBy": newId })` qua `paseo-cli.ts`. Lỗi chỉ ghi log: sự cố đã ghi `replacementId`, và §4.4.8 loại Worker cũ bằng cả nhãn lẫn sự cố.
6. Gửi thông báo dừng sẵn có (`REVIEWER_STOP_NOTICE_PREFIX`) cho Reviewer **đang chạy** của Worker cũ, cùng hàm `stop-propagation.ts` đang dùng.
7. Ghi `switched`, `replacementId`, `decidedAt`; gửi `BM-FALLBACK` với `status: switched`.
8. Tạo lỗi → ghi `failed`, lưu `error`, trả `E_FALLBACK_CREATE_FAILED`. Sự cố **không** quay về `pending`, để một lần bấm lặp lại không đẻ hai Worker.

#### 4.4.8 Lời bàn giao cho Worker và luật "một Worker"

`plugin/server/fallback-handover.ts` dựng lời bàn giao bằng mã, **không** nhờ LLM tóm tắt:

```
BM-HANDOVER
role: worker
requestId: <requestId>
managerAgentId: <managerId | none>
replaces: <oldId>
reason: <class> — "<message, cắt 300 ký tự>"
lastReport: <phase> at <ISO> | none
tier: <tier | unknown>
filesChanged: <…>
beadsCreated: <…>
beadsUpdated: <…>
beadsClosed: <…>
beadsReady: <…>
reviewFindingsOpen: <…>
reviewCalls: <n used of the request's budget>
skillsUsed: <…>

Original request (verbatim, the first message the replaced Worker received):
<text | unavailable>
```

| Trường | Nguồn |
|---|---|
| `requestId` | nhãn `bm.requestId` của Worker cũ |
| các trường của `BM-REPORT` | `BM-REPORT` **mới nhất** Worker cũ đã gửi, đọc từ kho vết của workspace (`traces.ts`), phân tích bằng `plugin/shared/bm-report.ts` |
| `reviewCalls` | `review-budget.ts`, đếm theo `requestId` |
| Yêu cầu gốc | tin `user_message` đầu tiên trong timeline của Worker cũ (`timeline.refetch`) |

- `worker.md` thêm **một** đoạn ngắn: tin khởi đầu bắt đầu bằng `BM-HANDOVER` thì:
  - tiếp tục request đó: đọc `git status` và `git diff` trước; coi mọi thay đổi đang có là của request, không hoàn tác;
  - không mở lại bead đã đóng, trừ khi review chặn;
  - ngân sách review tiếp tục từ `reviewCalls`, không mở lô mới cho lô đang dở;
  - gửi `received` cho `managerAgentId`.
- `BM-RESUME` (§4.4.9) có một câu tương tự: làm tiếp từ chỗ dừng.
- Luật "một Worker" (F10): `chatPeerSchema` thêm `replaced: boolean`, mặc định `false`, để client cũ vẫn đọc được. `replaced` là `true` khi agent có nhãn `bm.replacedBy`, **hoặc** là `agentId` của một sự cố `switched`. `soleWorkerOf` bỏ qua peer `replaced`. Cây agent ghi `· replaced by <id>` cho mọi vai trò.

#### 4.4.9 Chờ reset — `action: "wait"`, mọi vai trò

Owner chốt Q6 a: một **ngoại lệ hẹp** với thiết kế gốc §8 ("không tác vụ nền, không cron, không watcher"). Mỗi lời hẹn:
- có đúng một hẹn giờ, do người dùng bấm (hoặc chế độ Tự động mà người dùng bật, §4.6);
- được ghi ra file, và được đặt lại khi plugin nạp;
- bị huỷ khi sự cố đổi trạng thái;
- không quét đĩa, không lặp.

Luồng:
- Điều kiện: `resetsAt` khác `null` và không quá 7 ngày nữa, không thì `E_FALLBACK_NO_RESET`.
- Ghi `waiting` với `waitUntil = resetsAt + 60 giây`, rồi đặt `setTimeout(…).unref()`.
- **Khi plugin nạp** (`index.server.ts`), mọi sự cố `waiting` được đặt lại hẹn giờ; sự cố đã quá giờ thì chạy ngay.
- **Tới giờ:**
  - agent hỏng đã lưu trữ, đang chạy, hay đã có `bm.replacedBy` → ghi `expired`;
  - không thì gửi chính agent đó tin dưới đây, ghi `resumed`, và gửi `BM-FALLBACK` với `status: resumed` cho `managerId`. Khi agent hỏng là chính Manager, đó là cùng một agent.

  ```
  BM-RESUME The usage limit that stopped you has reset. Continue from where you stopped; do not redo finished work.
  ```

- Reviewer tiếp tục lượt review của nó rồi kết thúc lượt. Worker đã tạo nó được Paseo đánh thức như thường, vì Worker là bên tạo.

#### 4.4.10 `action: "dismiss"`

Ghi `dismissed`, gửi `BM-FALLBACK` với `status: dismissed`. Không động tới agent nào.

### 4.5 Phase 2a-17 — Dự phòng cho Reviewer và Manager (REQ-066)

`FALLBACK_ROLES` thành `["worker", "reviewer", "manager"]`. Màn Roles & models hiện chuỗi cho cả ba vai trò (§4.3.1). Phát hiện, sự cố, thẻ, pill, "Chờ" và "Để tôi" dùng lại nguyên §4.4. Hai vai trò mới chỉ khác nhau ở **ai tạo agent thay thế** và **bàn giao gì**:

| Vai trò hỏng | Thẻ hiện ở | Ai tạo agent thay thế | Bàn giao |
|---|---|---|---|
| Worker | chat Manager cha | plugin (§4.4.7) | `BM-HANDOVER` role worker (§4.4.8) |
| Reviewer | chat Manager của Worker cha | **Worker cha**, theo chỉ dẫn plugin gửi (§4.5.1) | tin review Worker đã gửi Reviewer cũ, nguyên văn |
| Manager | chat của chính Manager đó | plugin (§4.5.2) | `BM-HANDOVER` role manager (§4.5.2) |

#### 4.5.1 Reviewer

Reviewer do Worker tạo, và Worker được Paseo đánh thức khi Reviewer kết thúc lượt. Nếu plugin tự tạo Reviewer thay thế, Worker sẽ không bao giờ nhận được kết luận của nó. Vì vậy **Worker cha tạo** Reviewer thay thế, theo chỉ dẫn chính xác của plugin.

- **Khi Reviewer hỏng:** `worker.md` có một đoạn ngắn. Khi một Reviewer của bạn kết thúc vì lỗi của provider (usage limit, credit hay billing, đăng nhập, provider không chạy) thì:
  - đừng tạo Reviewer khác, và đừng tính đó là một lượt review;
  - kết thúc lượt, không gửi báo cáo;
  - plugin hỏi người dùng bằng thẻ, rồi gửi bạn `BM-FALLBACK`.
- **`switch`:** plugin không tạo agent. Nó gửi Worker cha (qua `notice-queue`) một `BM-FALLBACK` có `status: switched`, với phần chỉ dẫn:

  ```
  The user chose to replace Reviewer <oldId>. Create the new Reviewer now with create_agent:
  provider `bm-reviewer-fallback-<n>/<model>`, settings.modeId `<mode>` (or: do not pass settings.modeId),
  settings.thinkingOptionId `<id>` (omit when none), and the labels you give any Reviewer plus `bm.replaces` = `<oldId>`.
  Send it, unchanged, the message you sent <oldId>. This is the same review call, not a new one.
  ```

  Mode là kết quả của `runPostureOf("reviewer", …)` cho alias đó; lớp `none` thì dùng dòng "do not pass".
- **Nhận ra Reviewer thay thế:** `on("agent.created")` thấy một Reviewer có nhãn `bm.replaces` = `agentId` của một sự cố Reviewer `switched`. Khi đó plugin ghi `replacementId`, và đặt `bm.replacedBy` cho Reviewer cũ qua `setAgentLabels`.
- **Ngân sách review:** `reviewCallsOf` (`traces.ts`) nhận thêm tập id Reviewer thay thế, lấy từ `replacementId` của các sự cố Reviewer. Tin **đầu tiên** mà mỗi Reviewer thay thế nhận **không được đếm**. Worker quên nhãn `bm.replaces` thì tin đó bị đếm, và có thể sinh `BM-BUDGET`. Đó là lỗi an toàn: Manager hỏi người dùng.
- **Chờ:** §4.4.9 gửi `BM-RESUME` cho chính Reviewer cũ.

#### 4.5.2 Manager

Người dùng đang chat với chính Manager bị hỏng. Plugin tạo Manager thay thế trong cùng workspace, rồi người dùng mở nó bằng lối vào sẵn có.

- **`switch`:**
  1. Lấy mutex; sự cố `pending`, có `candidate`; Manager cũ chưa có `bm.replacedBy`.
  2. Dựng `BM-HANDOVER` role manager (dưới đây), ngân sách 5 giây.
  3. Tạo Manager bằng hàm `createManager` tách ra từ nhánh tạo của `ensureManager` (`manager.ts`), để hai đường cùng chỉ dẫn, cùng Runtime facts, cùng nhãn:
     - provider `bm-manager-fallback-<n>/<model>`;
     - mode theo `runPostureOf("manager", …)`, kèm `bm.modeSet` khi có mode;
     - thinking của mục;
     - nhãn `bm.role=manager`, `bm.version`, `bm.replaces=<oldId>`;
     - `prompt` = lời bàn giao.
  4. `setAgentLabels(oldId, { "bm.replacedBy": newId })`.
  5. Mọi Worker sống, chưa bị thay, trong workspace nhận qua `notice-queue` một `BM-SETTINGS` với dòng: ``Manager agent id: `<newId>` — send every BM-REPORT to this agent from now on.`` `worker.md` đã có luật "thay dòng tương ứng" của `BM-SETTINGS` (§4.3.5); câu đó được mở rộng thành "thay dữ kiện tương ứng, gồm id của Manager".
  6. Ghi `switched`, `replacementId`; gửi `BM-FALLBACK` (`status: switched`) vào chat Manager cũ.
  7. Lỗi → `failed` như §4.4.7 bước 8.
- **Một Manager cho mỗi workspace** (REQ-020b, thiết kế gốc §8): `findLiveManagers` bỏ agent có nhãn `bm.replacedBy`, hoặc là `agentId` của một sự cố Manager `switched`. Nhờ vậy `manager.ensure` mở Manager thay thế, và `otherManagerIds` không nhắc Manager cũ. Manager cũ vẫn sống cho tới khi người dùng lưu trữ nó (ADR-005).
- **Thẻ** trong chat Manager cũ, khi `switched`: `A new Beads Manager is running on <candidate>. Open Beads Manager from the sidebar or Command Center to continue with it.` Thẻ không mở agent được, vì timeline item không có `openAgent` (REQ-059 i).
- **Lời bàn giao** `plugin/server/fallback-handover.ts`, dựng bằng mã:

  ```
  BM-HANDOVER
  role: manager
  workspaceId: <id>
  replaces: <oldId>
  reason: <class> — "<message, cắt 300 ký tự>"
  workers:
  - <id> · requestId <req> · <provider>/<model> · <status> · last report: <phase> at <ISO> · blockers: <…, cắt 300>
  openQuestions: <workerId: Q1, Q2; …> | none
  openIncidents: <incident ids> | none

  The user's last messages to the Manager you replace (oldest first, verbatim):
  1. <text>
  2. <text>
  3. <text>

  You are the Beads Manager of this workspace from now on. Every Worker listed was told your id. Tell the user in one line that you took over, then carry on.
  ```

  | Trường | Nguồn |
  |---|---|
  | `workers` | Worker sống, chưa bị thay, trong workspace (`bmAgentsOf`); báo cáo cuối từ kho vết như §4.4.8 |
  | `openQuestions` | cùng luật `waitingOf` của `chat-waiting.ts`, trên timeline Manager cũ |
  | tin của người dùng | ba `user_message` **có `clientMessageId`** mới nhất trong timeline Manager cũ (AGENTS.md: đó là tin người dùng gõ), mỗi tin cắt 1.000 ký tự, **qua bộ che bí mật** của bộ thu thập (REQ-048b) |

  `manager.md` thêm một đoạn ngắn: tin khởi đầu bắt đầu bằng `BM-HANDOVER` và `role: manager` thì nhận các Worker trong danh sách là Worker của mình, báo người dùng một dòng, và không tạo lại Worker nào đang có.
- **Chờ:** §4.4.9 gửi `BM-RESUME` cho chính Manager cũ. Người dùng cũng có thể tự gõ lại vào chat đó.

### 4.6 Phase 2a-18 — Chế độ Tự động (REQ-067)

- `role-fallback.json` nhận `policy: "auto"` cho cả ba vai trò. Màn Roles & models hiện lựa chọn **Auto switch** cho từng vai trò, kèm cảnh báo chi phí. Với Manager, cảnh báo nói thêm: "the chat you use may be replaced".
- Sau §4.4.5 bước 5, khi policy là `"auto"`:
  - có `resetsAt` và giờ đó cách không quá 30 phút → chạy `wait`;
  - không thì có ứng viên → chạy `switch` (§4.4.7, §4.5.1 hay §4.5.2 theo vai trò);
  - không thì để `pending` như "Hỏi tôi".
- Thẻ vẫn hiện, với trạng thái đã chọn.
- Không có kiểm hạn mức trước khi tạo agent (PRD delta REQ-067 d).
- **Điều kiện vào phase** (plan delta): `role-fallback-state.json` có ít nhất một sự cố với `signal` và `message` từ một provider thật, và bộ mẫu phân loại đúng nó. Thiếu điều kiện thì phase không mở.

## 5. Hợp đồng

| Loại | Tên | Phase |
|---|---|---|
| RPC mới | `roles.settings`, `roles.options`, `roles.save-settings` | 2a-15 |
| RPC mới | `roles.save-fallback`, `fallback.incidents`, `fallback.act` | 2a-16 (vai trò `worker`); 2a-17 (thêm `reviewer`, `manager`) |
| RPC đổi (cộng thêm) | `manager.ensure` + `toolsNotice`; `setup.status` + `paseoTools`, cột `pi` / `opencode` | 2a-14 |
| RPC đổi (cộng thêm) | `chat.peers` + `replaced`; `chat.waiting` đếm sự cố | 2a-16 |
| RPC đổi (hành vi) | `manager.ensure` bỏ qua Manager đã bị thay | 2a-17 |
| Mã lỗi mới | `E_ROLE_SETTINGS_INVALID`, `E_ROLE_SETTINGS_CONFLICT`, `E_ROLE_SETTINGS_WRITE_FAILED` | 2a-15 |
| Mã lỗi mới | `E_FALLBACK_NOT_FOUND`, `E_FALLBACK_NOT_PENDING`, `E_FALLBACK_NO_CANDIDATE`, `E_FALLBACK_NO_RESET`, `E_FALLBACK_CREATE_FAILED` | 2a-16 |
| Thông báo của plugin (`notices.ts`) | `BM-TOOLS` | 2a-14 |
| Thông báo của plugin | `BM-SETTINGS` (dòng mode của agent con) | 2a-15 |
| Thông báo của plugin | `BM-FALLBACK`, `BM-RESUME`; `BM-HANDOVER` role worker là prompt khởi đầu | 2a-16 |
| Thông báo của plugin | `BM-SETTINGS` dòng "Manager agent id"; `BM-HANDOVER` role manager; `BM-FALLBACK` gửi Worker với chỉ dẫn tạo Reviewer | 2a-17 |
| Nhãn | `bm.replaces`, `bm.replacedBy` | 2a-16 |
| `config.json` | plugin ghi `bm-*` qua `config.patch` | 2a-15 |
| `config.json` | alias `bm-worker-fallback-<1..3>` | 2a-16 |
| `config.json` | alias `bm-manager-fallback-<1..3>`, `bm-reviewer-fallback-<1..3>` | 2a-17 |
| File | `role-fallback.json`, `role-fallback-state.json` | 2a-16 |
| Kho vết | `runtime.provider` tuỳ chọn | 2a-14 |
| `install.json` | hình dạng không đổi; `roles[]` = lần ghi cuối của trình cài | 2a-13 |

Mã lỗi mới vào sổ mã chung của sản phẩm (`DASHBOARD_ERROR_CODES` trong `contracts.ts`, thiết kế gốc §4.4). Mọi chữ dành cho agent viết bằng tiếng Anh (REQ-032a).

## 6. Security

- **Ghi `config.json` từ plugin (ADR-008):**
  - chỉ khi người dùng bấm Lưu;
  - chỉ chạm mục `bm-*`;
  - chặn khi `revision` lệch;
  - đọc ngay trước khi ghi, và kiểm sau khi ghi rằng chính mục `bm-*` đã vào đúng.

  Rủi ro còn lại, owner chấp nhận ở Q3 và Q15 a: một thay đổi trong app rơi đúng vào khoảng giữa lần đọc và lần ghi (vài mili giây) vẫn bị đè, và **không báo được** (errata §4.3.4).
- **Quyền của Reviewer** (owner chấp nhận ở Q7 a, 2026-09-21):
  - Reviewer không bao giờ chạy mode `dangerous` / `planning`, và `auto_accept` của Reviewer luôn `false` (§4.2.2).
  - Reviewer trên Pi không có lớp duyệt nào. Reviewer trên OpenCode chạy với quyền của agent OpenCode được chọn, và có thể dừng chờ người dùng duyệt quyền trong Paseo.
  - Có kiểm âm: một test tạo Reviewer trên provider giả có `auto_accept` mà profile đặt `true` → request ra khỏi hook có `false`. Alias `bm-reviewer-fallback-*` không bao giờ có `paseoTools`.
- **Mạng:** plugin gọi `listUsage` chỉ sau một sự cố L1 của Claude hay Codex, khi policy của vai trò khác `"off"`, một lần mỗi sự cố. Test đếm số lần gọi.
- **Credential và bí mật:**
  - Plugin không đọc credential. `listUsage` là daemon gọi bằng phiên của nó.
  - Lời bàn giao chỉ chứa dữ liệu kho vết và timeline mà plugin đã đọc hôm nay.
  - Tin của người dùng trong bàn giao Manager đi qua bộ che bí mật trước khi vào prompt.
- **Tạo agent:**
  - chỉ ở `fallback.act` (người dùng bấm) và ở chế độ Tự động (người dùng bật);
  - plugin tạo Worker và Manager; Reviewer do Worker tạo theo chỉ dẫn;
  - mỗi agent bị thay tối đa một lần;
  - chuỗi tối đa 3 mục, nên mỗi vai trò trong một phạm vi (request, hay workspace với Manager) có nhiều nhất 3 agent thay thế.
- **Chèn lệnh:** `setAgentLabels` giữ các kiểm hiện có của `paseo-cli.ts`, gồm mẫu id agent và `execFile` không shell. Mẫu regex của người dùng được biên dịch trong `try`; mẫu hỏng bị bỏ và log. Chuỗi so bị cắt ở 2.000 ký tự trước khi chạy regex, để một mẫu tồi không treo được hook lâu.
- **Yêu cầu rà soát:** owner review mã của `config-writer.ts`, `fallback.act` (Worker) và `createManager` dùng cho dự phòng trước bản phát hành của phase tương ứng. Đây là cùng loại với ba chỗ thiết kế gốc §7 đã nêu.

## 7. Reliability

- Mọi phần mới là "lỗi thì log, không phá": hook hết giờ thì tạo agent như hôm nay; phát hiện lỗi hỏng thì nuốt và log; `fallback.act` lỗi thì trả mã lỗi.
- Mọi file mới ghi atomic, có mutex trong tiến trình.
- Chống trùng:
  - sự cố theo agent;
  - `switch` chỉ từ `pending`;
  - nhãn `bm.replacedBy` và `replacementId`.
- Hẹn giờ ở §4.4.9 là ngoại lệ owner chấp nhận với thiết kế gốc §8 (Q6 a). Nó sống qua lần nạp lại vì được ghi ra file và đặt lại khi plugin nạp.
- `notice-queue` (`BM-SETTINGS`, `BM-FALLBACK` gửi Worker) chỉ ở trong bộ nhớ. Mất hàng chờ khi plugin nạp lại thì:
  - với `BM-SETTINGS`, agent rơi về hành vi hiện có (§4.3.5);
  - với chỉ dẫn tạo Reviewer thay thế, thẻ vẫn ở `switched` mà `replacementId` trống. Thẻ hiện nút **Resend to Worker**, gửi lại đúng tin đó.

## 8. Testing Strategy

Theo quy ước repo: Vitest; daemon, `paseo` và `$HOME` đều giả; không test nào chạm daemon thật. Các ca tối thiểu, mỗi luật một ca:

| Phase | Ca |
|---|---|
| 2a-13 | Hook: profile có thinking, request không có → đặt. Request có → giữ. Model khác → không đặt. `featureValues` gộp đúng thứ tự. `config.get` hết giờ → như hôm nay. Trình cài: mục đủ khoá → 0 `changedPaths`. Mục có `thinkingOptionId` / `modeId` / `disabledTools` → còn nguyên sau cài lại. `--role worker=…` đổi model → `thinkingOptionId` bị xoá, `modeId` giữ. Mục thiếu → tạo từ `roles[]`. `doctor` info khi lệch, mã thoát không đổi. **Đối chứng âm:** trả lại luật thay nguyên thì test "còn nguyên" phải đỏ |
| 2a-14 | `capabilityOf` bốn lớp; `modesFor` với `[]` không lỗi → `[]`, có `error` → `null`. `runPostureOf` đủ 12 ô của bảng §4.2.2; `untiered` không có mode trên profile → mode đầu tiên, **không bao giờ** bỏ trống (F11). Reviewer trên provider giả `untiered` có `auto_accept`, profile đặt `true` → `false` (**kiểm âm**). Runtime facts hai dạng. `REVIEWER_FALLBACK_MODE` chỉ cho claude/codex. `manager.ensure` với provider `untiered` / `none`; `toolsNotice`. `agent.created` với `supportsMcpServers: false` → `BM-TOOLS` tới đúng Manager; `true` → không gửi. Cột skill pi/opencode. Giá từ `metadata.cost` (có `cache.read` / không có); bản ghi cũ không có `runtime.provider`. Model id có `/` (F2) |
| 2a-15 | `revision` ổn định với thứ tự khoá. Lệch revision → `E_ROLE_SETTINGS_CONFLICT`, **không** gọi `patch`. Patch chỉ đổi mục `bm-<vai trò>`, mọi profile khác giống từng byte (so JSON). `null` → xoá khoá. Đọc lại thấy chính mục `bm-*` không có giá trị vừa ghi → `E_ROLE_SETTINGS_WRITE_FAILED`; một thay đổi rơi giữa lần đọc và lần ghi bị đè mà không báo (test "KNOWN LIMIT", errata §4.3.4). Kiểm §4.3.3 từng dòng. Reviewer + mode `dangerous` → từ chối. `BM-SETTINGS`: đích nghỉ → gửi ngay; đích chạy → gửi ở `turn_ended` kế; tin mới thay tin cũ; dòng không đổi → không gửi. `BM-SETTINGS` không bị đếm là review |
| 2a-16 | Phân loại: mỗi mẫu mặc định một ca khớp; L1 thắng L3; L6 không làm gì; mẫu của file thay mẫu mặc định; mẫu hỏng bị bỏ. N2: lượt có công cụ → không; có `BM-REPORT` → không; token ra > 0 → không; không có token và tin mở đầu là thông báo plugin → không. Vai trò ngoài `FALLBACK_ROLES` → không. Chống trùng. Ứng viên: đủ bốn luật bỏ qua của §4.4.5, chuỗi hết → `null`. `listUsage`: chỉ L1 và claude/codex, đúng một lần; `resetsAt` muộn nhất; `perModelWindow`. `switch` Worker: tạo đúng config, nhãn, parent, prompt; nhãn `replacedBy`; Reviewer đang chạy nhận thông báo dừng; bấm hai lần → một Worker; tạo lỗi → `failed`, không quay về `pending`. Bàn giao Worker: đủ trường từ `BM-REPORT` giả; thiếu dữ liệu → `unknown`. `soleWorkerOf` bỏ Worker `replaced`. `wait`: hẹn giờ giả (fake timers) → `BM-RESUME`; nạp lại plugin → đặt lại; quá giờ → chạy ngay; agent đang chạy → `expired`. `roles.save-fallback`: trùng mục → lỗi; đánh số lại alias khi xoá; vai trò chưa bật → lỗi. Policy `off` → chỉ ghi sự cố. `notice-queue`: đích chạy → gửi ở `turn_ended` kế |
| 2a-17 | `roleOfProvider` cho `bm-manager-fallback-1`, `bm-reviewer-fallback-3`; `-4` → `null`. Alias Reviewer dự phòng không có `paseoTools`. Reviewer: sự cố có `managerId` là Manager của Worker cha; `switch` gửi Worker đúng provider, mode (hay dòng "do not pass"), thinking, nhãn; **không** gọi `agents.create`; Reviewer mới có `bm.replaces` → `replacementId` và `replacedBy`; `reviewCallsOf` không đếm tin đầu của Reviewer thay thế, vẫn đếm tin thứ hai; hàng chờ mất → nút "Resend to Worker". Manager: `switch` gọi `createManager` với đúng provider, mode, nhãn, prompt; `findLiveManagers` bỏ Manager đã bị thay (theo nhãn và theo sự cố); mọi Worker sống nhận `BM-SETTINGS` có id mới; bàn giao có ba tin người dùng mới nhất, đã che bí mật (**kiểm âm**: một token giả trong tin bị che); `wait` gửi `BM-RESUME` cho Manager cũ |
| 2a-18 | `auto` cho mỗi vai trò: có reset ≤ 30 phút → wait; không → switch đúng đường của vai trò; không ứng viên → pending |

Nghiệm thu trên daemon thật, do owner làm hoặc owner cho phép làm, ở WP đóng mỗi phase:
- 2a-13: thinking của profile tới Worker; cài lại giữ nó.
- 2a-14:
  - Worker OpenCode làm xong một yêu cầu Nhỏ;
  - Reviewer OpenCode và Reviewer Pi được tạo;
  - Worker Pi thiếu adapter sinh `BM-TOOLS`;
  - tín hiệu `supportsMcpServers` đúng với Pi thiếu adapter (§4.2.4);
  - tín hiệu nạp skill trên OpenCode và Pi.
- 2a-15: lưu trên màn → Settings → Agent profiles hiện cùng giá trị; 0 profile khác đổi.
- 2a-16:
  - thẻ hiện khi lượt của Manager cùng provider gốc hỏng;
  - "Chuyển" Worker trên một sự cố thật, hoặc trên một sự cố giả lập bằng provider giả;
  - `listUsage` trả cửa sổ cho tài khoản owner.
- 2a-17: "Chuyển" Reviewer (Worker tạo Reviewer mới, lượt review không bị đếm thêm); "Chuyển" Manager (Beads Manager mở Manager mới, Worker đang chạy gửi báo cáo tới nó).
- 2a-18: điều kiện vào phase (§4.6).

## 9. Backward Compatibility và hoàn tác

- **RPC:** mọi trường mới là cộng thêm, có mặc định hoặc tuỳ chọn trong Zod. Bên tiêu thụ duy nhất là client của chính plugin, đóng cùng bundle.
- **`install.json`:** hình dạng không đổi, `schemaVersion` không đổi. Bản cũ đọc hồ sơ mới được.
- **`config.json`:** bản cũ gặp alias `bm-*-fallback-*` thì không nhận ra vai của nó. Agent đã tạo trên alias đó vẫn chạy, nhưng agent tạo mới trên alias đó khi bản cũ đang chạy thì không có chỉ dẫn vai trò. Lệnh gỡ của bản cũ vẫn xoá alias đó, vì luật tiền tố `bm-` không đổi (M16).
- **Kho vết:** `runtime.provider` tuỳ chọn; bản cũ bỏ qua nó.
- **Hoàn tác theo phase** (đề xuất §5.1): cài bản trước. Riêng các phase sau có thêm:

| Phase | Hoàn tác |
|---|---|
| 2a-13 | Không có gì để dọn; giá trị của người dùng trên profile vẫn đúng |
| 2a-14 | Alias đã đổi `extends` sang OpenCode hay Pi thì đổi lại bằng `--role` hoặc Settings của Paseo |
| 2a-15 | Cấu hình đã lưu nằm trong config Paseo và vẫn dùng được |
| 2a-16 | Đặt policy "Off"; hoặc cài bản trước. Hai file mới ở lại vô hại |
| 2a-17 | Đặt policy "Off" cho Manager và Reviewer. Manager đã bị thay: người dùng lưu trữ Manager nào không dùng nữa; bản trước mở Manager mới nhất có nhãn, tức Manager thay thế |
| 2a-18 | Đặt policy "Ask me" |

## 10. Rủi ro

| Rủi ro | Chặn bằng |
|---|---|
| Mẫu nhận dạng sai: nhận nhầm, hoặc sót lượt `completed` | Mặc định "Hỏi tôi"; mẫu là dữ liệu sửa được; N2 hẹp (không công cụ, không báo cáo, ≤ 500 ký tự, token ra 0); phase 2a-18 chỉ mở sau một sự cố thật |
| Tốn tiền khi chuyển sang provider tính theo token | Thẻ hiện giá (§4.2.7); người dùng bấm mới chuyển |
| Hai Worker cùng sửa một cây (người dùng nhắn lại Worker cũ) | `replaced` loại Worker cũ khỏi thẻ và pill; cây agent ghi rõ; agent cũ không nhận `BM-RESUME` sau khi đã bị thay |
| Hai Manager trong một workspace sau khi thay | `findLiveManagers` bỏ Manager cũ; thẻ chỉ đường mở Manager mới; Worker được báo id mới |
| Manager mới thiếu ngữ cảnh hội thoại | Bàn giao dựng bằng mã: Worker, báo cáo cuối, câu hỏi đang chờ, ba tin người dùng mới nhất; hội thoại cũ vẫn đọc được trong chat Manager cũ |
| Worker không làm đúng chỉ dẫn tạo Reviewer thay thế | Chỉ dẫn nêu đủ giá trị; thiếu nhãn thì lượt bị đếm và `BM-BUDGET` báo; nút "Resend to Worker" |
| Ghi đè thay đổi song song trong `agentProfiles` | `revision`, đọc ngay trước khi ghi (§4.3.4); ghi đè trong cửa sổ đó không báo được — rủi ro owner chấp nhận (Q3, Q15 a) |
| Runtime facts cũ sau khi đổi provider | `BM-SETTINGS` (§4.3.5); còn lại thì agent gửi `blocked` như hôm nay |
| Reviewer mất lan can cấu hình trên Pi / OpenCode | `auto_accept` luôn tắt; cảnh báo khi lưu; owner chấp nhận (Q7 a) |
| Worker Pi câm lặng vì thiếu adapter | `BM-TOOLS` (§4.2.4); tín hiệu kiểm trên daemon thật |
| Model nhỏ trong OpenCode / Pi không theo nổi file vai trò | Nghiệm thu 2a-14 trên fixture; người dùng thấy model trên Dashboard |
| Request khác sửa cùng tệp (`worker.md`, `manager.md`, `contracts.ts`, `chat-cards.ts`, `manager.ts`) | Mỗi WP kiểm `git status` và Worker khác đang chạy trước khi sửa, như delta 20260918g |

## 11. Câu hỏi mở — đã trả lời (vòng hỏi thứ hai, 2026-09-21)

| ID | Câu hỏi | Owner chốt | Owner | Trạng thái |
|---|---|---|---|---|
| Q6 | Ngoại lệ hẹn giờ của §4.4.9 với thiết kế gốc §8 | **a**: ngoại lệ hẹp — mỗi lần "Chờ" đúng một hẹn giờ, ghi ra file, đặt lại khi plugin nạp, huỷ khi sự cố đổi trạng thái | hieu.nt10 | answered |
| Q7 | Rủi ro Reviewer trên Pi và OpenCode | **a**: chấp nhận, lưu kèm cảnh báo; Reviewer OpenCode luôn tắt tự duyệt | hieu.nt10 | answered |
| Q8 | Chuỗi dự phòng cho vai trò nào | **c**: cả ba vai trò; Manager và Reviewer ở một phase riêng (2a-17, §4.5) | hieu.nt10 | answered |

## 12. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | Bản Draft theo `req-20260921T111242Z`, quyết định Q1–Q5 và mười sự thật F1–F10 |
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | `reviewing-plan`: F11 — agent con trên OpenCode phải được truyền mode tường minh (mode của profile, không thì mode đầu tiên); §4.2.2, §4.2.3, §4.4.7, §8 theo đó |
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | Owner trả lời Q6 a, Q7 a, Q8 c. §4.4 viết lại cho cả ba vai trò (file `role-fallback*.json`, alias `bm-<vai trò>-fallback-<n>`, `FALLBACK_ROLES`, `notice-queue`, N2 thêm điều kiện token); thêm §4.5 (Reviewer, Manager — phase 2a-17); Tự động thành §4.6, phase 2a-18; §5–§11 theo đó |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Review `b1`: hai mục chặn và mục chặn của re-review đều nằm ở plan delta, không ở tài liệu này. Cổng `design-ready` PASS. Status Draft → Active |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Errata khi chuyển thành beads (không đổi quyết định nào): F12 — patch của SDK dùng khoá phẳng `providers` / `agentProfiles` và có `removeProviders`, nên §4.3.4 và §4.4.1 gọi đúng tên và xoá alias bằng `removeProviders`; F13 — `send()` vào agent đang chạy thay lượt của nó, nên `BM-TOOLS` cũng đi qua `notice-queue`, và module này được tạo ở phase 2a-14 thay vì 2a-15 |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Errata khi implement bead `bm-phase-2a-13-respect-profile-8u20.3`: kiểm "info" của §4.1.3 dùng severity `ok`, vì hợp đồng JSON của `doctor` (thiết kế gốc §4.4) không có `info`. Không đổi hợp đồng nào |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Phase 2a-13 xong (beads `bm-phase-2a-13-respect-profile-8u20.1` → `.4`): dòng 1, 2, 16 của PRD delta §4 đã áp vào PRD gốc; errata §3.2 vào thiết kế gốc; checklist nghiệm thu `docs/operations/paseo-bm-worker-fallback-checklist.md` (phần 2a-13) và ghi chú phát hành `docs/operations/paseo-bm-release-notes-0.2.0-alpha.2.md` |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Phase 2a-14 xong (beads `bm-phase-2a-14-any-provider-u2g9.1` → `.11`): dòng 3–6 của PRD delta §4 đã áp vào PRD gốc; errata §2.6 và §7 vào thiết kế gốc; checklist nghiệm thu phần 2a-14 và ghi chú phát hành `docs/operations/paseo-bm-release-notes-0.3.0-alpha.0.md`. Khi implement: hook tra mode của Worker cả khi bên tạo đã chọn mode (để bật `auto_accept` trên OpenCode); `costOf` nhận thêm `paseo` làm tham số đầu |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Owner chốt Q14 a (nâng trần dòng file vai trò vừa đủ theo đo thật khi bead thêm câu) và Q15 a: errata §4.3.4, §6, §8, §10 — bước đọc lại kiểm chính mục `bm-*` vừa ghi; ghi đè song song trong cửa sổ đọc–ghi chỉ thu hẹp được, không báo được |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Phase 2a-15 xong (beads `bm-phase-2a-15-roles-and-models-kj1p.1` → `.6`): errata §3.4 và §5 vào thiết kế gốc; ADR-008 Accepted; checklist nghiệm thu phần 2a-15 và ghi chú phát hành `docs/operations/paseo-bm-release-notes-0.3.0-alpha.1.md`. Khi implement: `roles.settings` trả thêm `providers` (errata §4.3.2); `BM-SETTINGS` đếm `notified` là số đích đã gửi hay xếp hàng |
