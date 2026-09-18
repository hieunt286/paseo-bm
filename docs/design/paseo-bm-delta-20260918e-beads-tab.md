# Delta-change — Tab "Beads" trong menu "+", Setup là màn chính của Beads Manager, màu cả dòng cho bead

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260918e-beads-tab` |
| Tài liệu gốc | [Technical Design Dashboard](./paseo-bm-dashboard.md) (surface Beads Manager, màn Metric); [delta 20260916-beads-screen](./paseo-bm-delta-20260916-beads-screen.md) (màn Beads); [delta 20260916-setup-screen](./paseo-bm-delta-20260916-setup-screen.md) (màn Setup); [delta 20260917e](./paseo-bm-delta-20260917e-manager-screen-and-commands.md) §4.1, §4.2, §4.4 (danh sách workspace, thông báo của slash command) |
| PRD | [prd-delta-20260918e-beads-tab](../product/paseo-bm-prd-delta-20260918e-beads-tab.md) — REQ-060 (a)–(i); quyết định Q1–Q3; Routing Decision ở §0 của tài liệu đó |
| Plan | [plan-delta-20260918e-beads-tab](../plans/paseo-bm-implementation-plan-delta-20260918e-beads-tab.md) |
| Status | **Active** — cổng `design-ready` PASS 2026-09-18 (review b1 pass sau một lần sửa) |
| Owner | hieu.nt10 |
| ADR | N/A — không ADR nào quản chuyện này: không thêm công nghệ hay phụ thuộc, không đảo quyết định nào. ADR-005 (vòng đời agent thuộc người dùng) giữ nguyên: không màn nào thêm nút dừng, lưu trữ hay xoá agent |
| Request | `req-20260918T043115Z` |

**Thiết kế này sở hữu:**

- panel workspace "Beads" (`bm-beads`) và hai tab con của nó;
- phần đầu màn (nút ←, tiêu đề) của màn Beads và màn Metric;
- cách surface "Beads Manager" chọn màn: màn chính, màn phụ, đường quay lại;
- phần đầu màn Setup, cùng chỗ hiện thông báo trên màn chính;
- màu trạng thái của bead: bảng ánh xạ, khung dòng tô màu, kiểu chữ tên bead.

**Không sở hữu:**

- thanh tab, menu "+" và màn "New tab" (của Paseo);
- nội dung màn Beads, Metric, Setup, trừ các phần kể trên;
- mọi RPC và `plugin/shared/contracts.ts`;
- `plugin/client/chat-cards.ts` và `plugin/client/chat-card.tsx`: một Worker khác đang sửa chúng (delta 20260918d), và delta này không cần chạm vào.

## 1. Ba kết quả

1. **Tab "Beads" trong menu "+"** với hai tab con Beads / Metric, xem được trên desktop và mobile — REQ-060 (a)–(c).
2. **Setup là màn chính** của surface "Beads Manager", danh sách workspace thành màn phụ — REQ-060 (d)–(f).
3. **Màu cả dòng, chip cùng màu, tên không đậm** — REQ-060 (g)–(i).

Ba kết quả độc lập: không kết quả nào cần mã của kết quả khác.

## 2. Nền tảng — đã kiểm chứng những gì

Đọc trực tiếp từ `@getpaseo/plugin` 0.8.0 và từ bundle web của Paseo.app 0.8.0 (`app-dist/_expo/static/js/web/index-*.js`), ngày 2026-09-18. Không suy đoán.

- **F1. Panel workspace.** `client.addWorkspacePanel({ id, title, icon, context: "workspace", Component, locations? })`. Component nhận `PluginWorkspacePanelProps`:
  - `theme`, `host`;
  - `layout: { compact, platform: "ios" | "android" | "web" }`;
  - `navigation?`, `context: "workspace"`, `workspaceId`.

  Nguồn: `dist/client/contracts.d.ts`.
- **F2. Menu "+" liệt kê panel của plugin.**
  - Hàm `useWorkspaceTabLaunchCatalog` dựng danh mục tab mới. Nó thêm một nhóm `plugin-panels` gồm mọi panel `context === "workspace"` hỗ trợ vị trí `workspace`. Mỗi mục có nhãn = `title`, icon = `icon`, và mở panel đó trong workspace.
  - Hai nơi dùng danh mục này: menu thả xuống của nút "+" (`WorkspaceNewTabMenuContent`, `testID` `workspace-new-tab-button`) và màn "New tab" (`testID` `workspace-new-tab-panel`, panel `new_tab`). Mobile mở tab mới bằng màn thứ hai.
- **F3. Vị trí mặc định là `["workspace"]`.** Khi `locations` bị bỏ trống, `runPluginClientBundle` gán `["workspace"]`. Panel "Beads agents" (không khai `locations`) đang hiện trong "+" nhờ đó.
- **F4. Hai màn cần tái dùng đã là component độc lập.**
  - `BeadsScreen` (`beads-screen.tsx`) và `DashboardPanel` (`dashboard.tsx`) nhận `PluginSurfaceProps` + `workspaceId`, `workspaceLabel`, `onBack`.
  - Mỗi màn là một `ScrollView` với `dashboardStyles(theme, layout.compact)`.
  - `workspaceLabel` và `onBack` chỉ dùng ở dòng đầu màn: nút ← và tiêu đề `Beads · …` / `Metric · …`.
- **F5. Màu trong theme.** Theme của plugin chỉ có 11 màu, `accent`, `statusSuccess`, `statusWarning`, `statusDanger` trong đó. Định dạng chuỗi màu không được hứa, nên **không** ghép kênh alpha vào chuỗi. Repo đã có mẫu tô nhạt độc lập định dạng: `RoleMark` (`ui.tsx`) đặt một `View` phủ tuyệt đối cùng màu với `opacity: 0.16`.
- **F6. Ai dùng `statusBadge`.**
  - `beads-screen.tsx`: chip của dòng.
  - `bead-chips.tsx`:
    - `BeadChips` — chip bead trong thẻ chat, qua `chat-card.tsx`;
    - `BeadInline` — khung chi tiết khi bấm chip;
    - `ChatBeadsPanel` — panel "Beads in this chat".

  Đổi tone ở `statusBadge` là đổi ở cả bốn chỗ, và không cần sửa `chat-card.tsx`.
- **F7. Surface hôm nay.**
  - `ManagerLauncherSurface` (`launcher.tsx`) giữ `view: "launcher" | "dashboard" | "beads" | "settings"` (`DashboardViewName` ở `dashboard-view.ts`), mặc định `"launcher"`.
  - Thông báo của `/bm-worker-stop-all` (`launcherNotices`), cảnh báo host cũ và `describeLauncherState(state)` chỉ vẽ trong nhánh `"launcher"`.
  - Mục Command Center "Open Beads Manager" xếp hàng một lần mở Manager (`launchRequests`). Effect của surface chạy nó ở **mọi** view. Mục "Open Beads Metric" đặt view `"dashboard"`.

## 3. Không đổi

- RPC, `contracts.ts`, mã server, kho vết, file thứ tự ghim.
- Hai mục Command Center và đích của chúng. "Open Beads Metric" vẫn mở Metric trên surface (PRD delta §7).
- Hai slash command. Chỉ **chỗ** hiện thông báo của `/bm-worker-stop-all` đổi (§4.2).
- Panel "Beads agents" và "Beads in this chat", trừ màu dòng, màu chip và kiểu chữ tên (§4.3).
- Nội dung màn Beads, Metric, Setup dưới dòng đầu màn. Danh sách workspace (ghim, chấm đang chạy, số bead, ba nút, lịch sử đã đóng) giữ nguyên, trừ dòng đầu màn.

## 4. Thiết kế

### 4.1 Panel "Beads" với hai tab con (REQ-060 a–c)

**Đăng ký** — trong `plugin/index.client.tsx`, ngay **trước** panel "Beads agents", để "Beads" đứng đầu nhóm của plugin trong "+":

```ts
client.addWorkspacePanel({
  id: BEADS_TAB_PANEL_ID,      // "bm-beads"
  title: "Beads",
  icon: "ListChecks",          // cùng icon với nút "Beads" trên danh sách workspace
  context: "workspace",
  Component: BeadsTabPanel,
})
```

Không khai `locations`: mặc định `["workspace"]` là đúng chỗ cần (F3).

**Hằng số thuần** — trong `plugin/client/dashboard-view.ts`, để test đọc được mà không cần renderer:

- `BEADS_TAB_PANEL_ID = "bm-beads"`;
- `BEADS_TAB_VIEWS = [{ key: "beads", label: "Beads" }, { key: "metric", label: "Metric" }] as const`;
- `DEFAULT_BEADS_TAB_VIEW = "beads"`.

**Component** — file mới `plugin/client/beads-tab.tsx`, `BeadsTabPanel(props: PluginWorkspacePanelProps)`:

```
View (flex: 1, nền surface0)
├── hàng tab con: ngang, padding ngang = padding của content (12 compact / 24),
│   paddingTop như content, gap 8
│   ├── Pressable "Beads"   accessibilityRole="tab", accessibilityState={{ selected }}
│   └── Pressable "Metric"  (cùng kiểu)
│       tab đang chọn: kiểu `button` (nền accent); tab kia: `secondaryButton`
└── màn của tab con, chiếm phần còn lại (flex: 1):
    "beads"  → <BeadsScreen {...props} workspaceId={props.workspaceId} />
    "metric" → <DashboardPanel {...props} workspaceId={props.workspaceId} />
```

- Tab con đang chọn là `useState(DEFAULT_BEADS_TAB_VIEW)`, chỉ sống trong tab đang mở (PRD NFR dữ liệu).
- Chuyển tab con thì unmount màn kia. Dữ liệu của hai màn nằm trong bộ nhớ đệm React Query theo khoá có sẵn (`["paseo-bm", "beads-list", id]`, `["paseo-bm", "traces", id]`), nên quay lại không phải chờ tải lại.
- Nút đủ lớn để chạm: kiểu `button` / `secondaryButton` có `paddingVertical: 10`, nghĩa là cao khoảng 40 px.

**Phần đầu màn khi ở trong tab** (REQ-060 b):

- `BeadsScreenProps` và `DashboardProps` đổi `onBack` và `workspaceLabel` thành **tuỳ chọn**:
  - `onBack` không có → không vẽ nút ←;
  - `workspaceLabel` không có → không vẽ tiêu đề.
- Dòng đầu màn khi đó chỉ còn nút "Refresh", căn phải. Tab con đã nói đây là màn nào, và tab nằm trong chính workspace đó.
- Surface vẫn truyền đủ cả hai, nên màn Beads / Metric mở từ danh sách workspace không đổi.

**Mobile và desktop** (REQ-060 c):

- Cả hai màn đã dựng theo `layout.compact`: padding 12 thay vì 24, chữ nhỏ hơn một bậc, các khối thẻ `flexWrap`.
- Các khối rộng nhất có `minWidth` 260 (biểu đồ tạo/đóng 14 ngày) và 220 (biểu đồ cột). Màn điện thoại 360 px trừ padding còn 336 px, nên mỗi khối xuống một dòng riêng thay vì bị cắt.
- Delta này không đổi bố cục bên trong màn. Hàng tab con là phần mới duy nhất, và nó chỉ có hai nút.
- Paseo tự đưa mục "Beads" vào màn "New tab" của mobile (F2).

### 4.2 Setup là màn chính của surface (REQ-060 d–f)

**Tên màn.** `DashboardViewName` đổi thành `"setup" | "workspaces" | "dashboard" | "beads"`. Hai hàm thuần mới ở `dashboard-view.ts`:

- `SURFACE_HOME_VIEW = "setup"`;
- `backOf(view)`: `"dashboard"` và `"beads"` → `"workspaces"`; `"workspaces"` → `"setup"`; `"setup"` → `null` (không có nút ←).

Surface khởi tạo `useState(SURFACE_HOME_VIEW)`, và mọi nút ← gọi `setView(backOf(view)!)`.

**Dải trạng thái dùng chung.** Ba thứ hôm nay chỉ vẽ ở danh sách:

- thông báo của slash command (bấm để ẩn);
- cảnh báo "This Paseo version cannot open agents from plugins. Update Paseo to use this launcher." khi thiếu `navigation.openAgent`;
- các dòng `describeLauncherState(state)`.

Dải này phải hiện ở **cả** màn chính và danh sách workspace. Lý do:

- `/bm-worker-stop-all` mở surface, và surface giờ mở ra ở màn chính;
- mục Command Center "Open Beads Manager" chạy việc mở Manager ở bất kỳ view nào (F7), nên lỗi của nó phải thấy được ngay ở màn chính.

Cách làm, chia sao cho cả nội dung lẫn chỗ đặt đều chứng minh được bằng test:

- **Nội dung là một hàm thuần** trong `plugin/client/launch-manager.ts`:

  ```ts
  export const OLD_HOST_WARNING =
    "This Paseo version cannot open agents from plugins. Update Paseo to use this launcher.";
  export interface StatusLine { key: string; text: string; tone: NoticeTone; dismissable: boolean }
  export function launcherStatusLines(input: {
    commandNotice: string | null; canOpenAgents: boolean; state: LauncherState;
  }): StatusLine[]
  ```

  Thứ tự các dòng:
  1. thông báo slash command, nếu có: tone `muted`, `dismissable: true`;
  2. `OLD_HOST_WARNING` khi `!canOpenAgents`: tone `warning`;
  3. từng dòng của `describeLauncherState(state)`, giữ tone của nó.

  Chữ của mọi dòng không đổi so với hôm nay. Chỉ dòng 1 ẩn được.
- **Vẽ bằng một component** `LauncherStatus({ lines, onDismiss, theme, styles })` trong `launcher.tsx`. Dòng `dismissable` là `Pressable` với nhãn trợ năng `"<text>. Dismiss."` như hôm nay; các dòng khác là `Text` có `accessibilityLiveRegion="polite"`.
- **Dựng đúng một lần và đặt đúng hai chỗ.** `ManagerLauncherSurface` dựng một biến `const status = <LauncherStatus … />`, rồi dùng nó:
  - `<SetupScreen … status={status} />` ở màn chính;
  - `{status}` ngay dưới dòng đầu trong `ScrollView` của danh sách workspace.

  Màn Metric và Beads không có dải này, như hôm nay.

**Màn chính** (`SetupScreen`, `setup-screen.tsx`). Props mới:

- `onOpenWorkspaces: () => void`;
- `status?: ReactNode` (dải trạng thái).

Bỏ `onBack`, vì màn chính không có nút ←. `SetupScreen` chỉ còn được vẽ ở đây.

```
[Beads Manager ............................ (Workspaces)]
Setup for this machine: beads tools, agent skills and extra instructions for each role.
<LauncherStatus>
… nội dung Setup như hôm nay: Beads tools · Agent skills · Additional instructions …
paseo-bm <version>
```

- Nút "Workspaces" là nút chữ kiểu `secondaryButton`, nhãn trợ năng "Open the workspace list: Beads Manager, metrics and beads of each workspace".
- Dòng phiên bản dùng `PLUGIN_VERSION` như danh sách workspace đang dùng.

**Màn phụ "Workspaces"** (nhánh danh sách trong `launcher.tsx`):

- Dòng đầu đổi thành `[←] Workspaces`, với nhãn trợ năng "Back to Beads Manager setup".
- Bỏ nút ⚙: Setup giờ là màn chính, và nút ← đã về đó.
- Phần còn lại giữ nguyên từng dòng: câu giới thiệu, `LauncherStatus`, các dòng workspace, lịch sử đã đóng, dòng phiên bản.

**Đường đi:**

```
sidebar / Command Center "Open Beads Manager"
  → setup ──(Workspaces)──> workspaces ──(Metric | Beads)──> dashboard | beads
      ^────────(←)────────────┘ ^──────────────(←)──────────────────┘
Command Center "Open Beads Metric" → dashboard ──(←)──> workspaces ──(←)──> setup
/bm-worker-stop-all → surface mở ở view hiện tại; lần đầu là setup; thông báo hiện ở đó
```

### 4.3 Màu cả dòng, chip cùng màu, tên không đậm (REQ-060 g–i)

> **Batch `b4` (Q8) thay phần khung dòng của mục này.** `TintedCard`, `ROW_TINT_OPACITY` và `beadRowLook` bị bỏ; màu chuyển sang tên bead (§4.4). Bảng `STATUS_TONE`, `statusBadge` và việc bỏ đậm giữ nguyên. Phần dưới đây là thiết kế đã chạy ở batch `b3`, giữ lại làm lịch sử.

**Một bảng màu duy nhất** — trong `plugin/client/beads-model.ts`:

```ts
export const STATUS_TONE: Readonly<Record<StatusBucket, Tone>> = {
  ready: "info",          // accent — chưa làm
  in_progress: "warning", // vàng — đang làm
  blocked: "danger",      // đỏ — block
  closed: "success",      // xanh lá — đã đóng
};
export const ROW_TINT_OPACITY = 0.12;
export function beadRowLook(bead): { tone: Tone; muted: boolean }
  // tone = STATUS_TONE[statusBucket(bead)]; muted = bucket === "closed"
```

- `StatusBucket` là kiểu trả về của `statusBucket`, được đặt tên để dùng lại.
- `statusBadge` giữ nguyên chữ (Ready / In progress / Blocked / Closed) và lấy tone từ `STATUS_TONE[statusBucket(bead)]`. Chip và dòng vì vậy **không thể** lệch màu.
- So với hôm nay, chỉ hai tone đổi: In progress `info` → `warning`, Blocked `warning` → `danger`.
- Cách xếp trạng thái (`statusBucket`) giữ nguyên. Bead mở mà chưa sẵn sàng, hay mang trạng thái lạ như `deferred`, vẫn là "blocked" như trước.

**Khung dòng** — component mới `TintedCard` trong `plugin/client/ui.tsx`:

```tsx
<View style={[styles.card, { overflow: "hidden", borderLeftWidth: 4, borderLeftColor: colour }]}>
  <View pointerEvents="none"
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
                 backgroundColor: colour, opacity: ROW_TINT_OPACITY }} />
  {children}
</View>
```

- Lớp phủ là con **đầu tiên** và nằm ngoài luồng, nên nội dung vẽ đè lên nó và chạm vẫn tới `Pressable` của dòng.
- `pointerEvents="none"` là lớp an toàn thứ hai.
- Mở dòng ra xem chi tiết thì chi tiết nằm trong cùng khung, nên vẫn giữ màu (REQ-060 g).
- Vì sao độ mờ là 0.12, nhạt hơn 0.16 của `RoleMark`: `RoleMark` là một chấm tròn nhỏ không có chữ, còn đây là nền dưới cả khối chữ. Chữ `foreground` và `foregroundMuted` phải đọc rõ trên đó ở cả theme sáng và tối.

**Kiểu chữ tên bead** — hàm mới `beadTitleStyle(styles, theme, muted)` trong `ui.tsx`:

- trả về `[styles.sectionTitle, { fontWeight: "400", color: muted ? theme.colors.foregroundMuted : theme.colors.foreground }]`;
- cỡ chữ giữ theo `sectionTitle` (14 compact / 16), chỉ bỏ đậm.

**Áp vào đâu:**

| Chỗ | File | Đổi |
|---|---|---|
| Danh sách màn Beads | `beads-screen.tsx` | `styles.card` của dòng → `TintedCard` theo `beadRowLook`; tên dùng `beadTitleStyle` (bỏ `fontWeight: "600"`) |
| Panel "Beads in this chat" | `bead-chips.tsx` (`ChatBeadsPanel`) | như trên |
| Khung chi tiết mở từ chip | `bead-chips.tsx` (`BeadInline`) | tên dùng `beadTitleStyle`; không tô, vì đây là khung chi tiết, không phải dòng danh sách |
| Chip bead trong thẻ chat | `bead-chips.tsx` (`BeadChips`) | không sửa mã: lấy tone mới qua `statusBadge` (F6) |

**Tương thích.** Chỉ đổi cách vẽ. Chip trong thẻ chat đổi màu theo `statusBadge`, `chat-card.tsx` không bị sửa.

### 4.4 Batch `b4`: màu ở tên, bốn nhóm, ẩn/hiện bead đã đóng, thống kê nhanh (REQ-060 g, h, j–m)

Owner quyết Q8–Q11 (PRD delta §1.4). Mọi thay đổi nằm ở màn Beads, cộng phần màu tên ở panel "Beads in this chat". Không RPC, không dữ liệu lưu bền.

**Mô hình thuần** — `plugin/client/beads-model.ts`:

```ts
// giữ: StatusBucket, statusBucket, STATUS_TONE, statusBadge
export function beadTitleTone(bead): Tone            // = STATUS_TONE[statusBucket(bead)]
export const STATUS_GROUP_ORDER: readonly StatusBucket[] = ["in_progress", "blocked", "ready", "closed"];
export interface BeadGroup { bucket: StatusBucket; label: string; tone: Tone; total: number; beads: BeadRow[] }
export function groupBeads(beads: readonly BeadRow[], options: { showClosed: boolean; limit: number }): {
  groups: BeadGroup[];   // theo STATUS_GROUP_ORDER, bỏ nhóm rỗng, bỏ nhóm closed khi !showClosed
  visible: number;       // số bead thuộc các nhóm được hiện, trước khi cắt theo limit
  closed: number;        // số bead đã đóng trong đầu vào (đang ẩn hay đang hiện)
  truncated: number;     // số bead của các nhóm được hiện mà limit cắt mất
}
export function doneText(progress: { closed: number; total: number }): { text: string; label: string }
  // text  = "✓ 12 / 40 done"
  // label = "12 of 40 beads done, epics not counted"
export const closedBeadsVisibility: { get(): boolean; set(show: boolean): void; subscribe(listener: () => void): () => void }
  // một biến cấp module cho mỗi lần nạp client bundle; mặc định false (ẩn)
```

- **Bỏ:** `beadRowLook` và `ROW_TINT_OPACITY`.
- **`groupBeads`:**
  - đầu vào là danh sách **đã lọc và đã sắp** (`sortBeads(filterBeads(...))`); hàm giữ nguyên thứ tự đó trong từng nhóm;
  - `label` lấy đúng chữ của chip (In progress, Blocked, Ready, Closed), `tone` lấy từ `STATUS_TONE`;
  - `limit` (200) tính dồn theo thứ tự hiện của các nhóm: nhóm đầu lấy trước, nhóm sau lấy phần còn lại. Nhóm bị cắt còn 0 dòng thì không trả về, và số bead của nó tính vào `truncated`. `total` của nhóm luôn là số đầy đủ.
- **`doneText`** nhận `beadsOverview(...).progress`, nên đếm đúng như thẻ Progress: mọi bead trừ epic, không theo bộ lọc (Q11).
- **`closedBeadsVisibility`** là cách "nhớ trong phiên app" của Q9. Rời màn rồi quay lại vẫn giữ; màn Beads trên surface và trong tab "Beads" dùng chung. Tải lại app thì module được nạp lại và trở về `false`.

**Kiểu chữ tên** — `plugin/client/ui.tsx`:

- `beadTitleStyle(styles, theme, tone: Tone | null)` → `[styles.sectionTitle, { fontWeight: "400", color: tone === null ? theme.colors.foreground : toneColor(theme, tone) }]`;
- bỏ `TintedCard`.

**Màn Beads** — `plugin/client/beads-screen.tsx`:

- **Dòng đầu màn** (REQ-060 l): `[← nếu có] [tiêu đề nếu có | khoảng trống] [✓ 12 / 40 done] [Refresh]`.
  - Chữ số liệu dùng `styles.body` và `accessibilityLabel` = `label` của `doneText`.
  - Chỉ hiện khi đã có dữ liệu.
- **Bỏ** thẻ "Created / closed, last 14 days" và biến `activityMax` (REQ-060 m). Hàng thẻ còn "By type" và "By priority". Ở `b4`, `beadsOverview` còn tính `activity`; batch `b5` bỏ nốt phần đó (§4.5).
- **Dòng đầu danh sách:**
  - chữ `<visible> of <rows.length> beads`;
  - nút ẩn/hiện (REQ-060 j): một `Pressable` với `Icon` `EyeOff` khi đang ẩn / `Eye` khi đang hiện, cùng chữ `Closed <closed>`;
  - `accessibilityRole="button"`, `accessibilityState={{ selected: showClosed }}`;
  - `accessibilityLabel` = `Show closed beads (<closed>)` hoặc `Hide closed beads (<closed>)`;
  - bấm gọi `closedBeadsVisibility.set(!showClosed)`;
  - màn đọc trạng thái bằng `useSyncExternalStore(closedBeadsVisibility.subscribe, closedBeadsVisibility.get, closedBeadsVisibility.get)`.
- **Các nhóm** (REQ-060 k). Mỗi nhóm của `groupBeads(shown, { showClosed, limit: LIST_LIMIT })` vẽ:
  1. một vạch ngăn (`View` cao 1 px, màu `theme.colors.border`);
  2. dòng tiêu đề `<label> · <total>`, kiểu `sectionTitle`, màu `toneColor(theme, group.tone)`;
  3. các dòng bead như hôm nay trong `styles.card`, không tô. Tên dùng `beadTitleStyle(styles, theme, beadTitleTone(bead))`. Chip, id, dòng Worker và chi tiết mở ra giữ nguyên.
- **Trường hợp rỗng:**
  - workspace không có bead → giữ câu hiện có;
  - có bead khớp bộ lọc nhưng tất cả đều đã đóng và đang ẩn (`visible === 0 && closed > 0`) → `All <closed> matching beads are closed. Show them with the eye button.`
- **Giới hạn:** `truncated > 0` → giữ câu hiện có "Showing the first 200. Narrow the filters to see the rest."

**Panel "Beads in this chat"** — `plugin/client/bead-chips.tsx`:

- dòng trở lại `styles.card`, không tô;
- tên dùng `beadTitleStyle(styles, theme, beadTitleTone(bead))`;
- `BeadInline` dùng `beadTitleStyle(styles, theme, null)`: không đậm, không màu, như Q4;
- panel này không có nhóm và không có nút ẩn/hiện (PRD delta §7).

### 4.5 Batch `b5`: bỏ phần tính 14 ngày, màu các con số trên dòng workspace (REQ-060 m, n)

- **`plugin/client/beads-model.ts`:**
  - `BeadsOverview` mất trường `activity`;
  - `beadsOverview(beads, stats, now)` mất tham số `days` và vòng lặp tính số tạo/đóng theo ngày;
  - `DAY_MS` vẫn dùng cho `STALE_MS` và `formatDays`.
- **`plugin/client/dashboard-view.ts`, `workspaceStats`** (bảng nhỏ của dòng workspace):
  - `inProgress` > 0 → tone `warning` (trước là `info`);
  - `blocked` > 0 → tone `danger` (trước là `warning`);
  - số bằng 0 vẫn `muted`; `total` và `running` không đổi.

  Đây là hai tone của `STATUS_TONE` cho `in_progress` và `blocked`, nên `workspaceStats` đọc thẳng từ `STATUS_TONE` để hai nơi không lệch nhau được. `dashboard-view.ts` import `STATUS_TONE` từ `beads-model.ts`; cả hai đều thuần.
- **Test:**
  - ca "summarises status, progress, activity, type, priority and time" bỏ hai dòng kiểm `activity` và đối số `7` cho `days`, vì chính tính năng đó bị owner bỏ (không phải để cho xanh); tên ca đổi theo;
  - ca "workspace row figures" của `test/plugin-dashboard-view.test.ts` kỳ vọng `warning` / `danger` và thêm một dòng kiểm hai tone đó bằng `STATUS_TONE`.

## 5. Luồng lỗi và trường hợp biên

- **Workspace không có `.beads/`.** Tab "Beads" hiện như màn Beads hôm nay: "This workspace has no beads yet." và dòng "Read from …". Tab "Metric" hiện số đo của kho vết như hôm nay.
- **RPC lỗi.** Mỗi màn hiện dòng chữ đỏ và nút Refresh như hôm nay. Hàng tab con vẫn dùng được, nên người dùng chuyển sang tab con kia được.
- **Host Paseo không có `navigation`.** Các nút "Open the Worker" và "Open the Beads Manager" trong chi tiết bead tự ẩn như hôm nay (chúng đã kiểm `navigation?.openAgent`).
- **Hai tab "Beads" của cùng workspace.** Paseo quyết định việc mở lại tab có sẵn hay mở tab mới. Hai tab dùng chung bộ nhớ đệm, và mỗi tab giữ tab con riêng.
- **Surface mở khi đang có yêu cầu Metric từ Command Center.** Effect của `dashboardRequests` đặt view `"dashboard"` như hôm nay; ← về `"workspaces"`.

## 6. Chiến lược kiểm thử

Repo không dựng component React trong test (quy ước đã có ở các delta trước). Phần `.tsx` được kiểm bằng `npm run typecheck:plugin` và lần chạy thật của owner. Phần quyết định nằm trong hàm thuần và được test bằng Vitest.

| Test | File | Chứng minh |
|---|---|---|
| Bảng màu (sửa ở `b4`) | `test/plugin-beads-screen.test.ts` | `beadTitleTone`: bốn trạng thái → bốn tone khác nhau đúng như §4.3 |
| Bất biến chip = tên (sửa ở `b4`) | như trên | với một bead đại diện cho mỗi trạng thái (gồm cả bead mở mà chưa sẵn sàng), `statusBadge(b).tone === beadTitleTone(b)`, và chữ của chip không đổi |
| Nhóm (`b4`) | như trên | `groupBeads`: thứ tự In progress → Blocked → Ready → Closed; nhóm rỗng không có; `showClosed: false` bỏ nhóm Closed nhưng vẫn đếm `closed`; thứ tự sắp đầu vào giữ nguyên trong nhóm; `limit` cắt dồn theo thứ tự nhóm, `total` đầy đủ, `truncated` đúng |
| Thống kê nhanh (`b4`) | như trên | `doneText(beadsOverview(...).progress)` với một bộ có epic → epic không được đếm; chữ đúng mẫu `✓ n / m done` |
| Không còn `activity` (`b5`) | như trên | kiểu `BeadsOverview` không có `activity`; `typecheck` bắt mọi chỗ còn đọc nó |
| Màu số trên dòng workspace (`b5`) | `test/plugin-dashboard-view.test.ts` | `inProgress` > 0 → `warning`, `blocked` > 0 → `danger`, cùng giá trị với `STATUS_TONE`; số 0 → `muted` |
| Ẩn/hiện (`b4`) | như trên | `closedBeadsVisibility` mặc định `false`; `set` báo cho người nghe và giữ giá trị cho lần `get` sau |
| Tab con | `test/plugin-dashboard-view.test.ts` | `BEADS_TAB_VIEWS` đúng thứ tự Beads, Metric; `DEFAULT_BEADS_TAB_VIEW === "beads"` |
| Đường quay lại | như trên | `SURFACE_HOME_VIEW === "setup"`; `backOf` cho đủ bốn view như §4.2 |
| Đăng ký | `test/plugin-launcher.test.ts` | có đúng một panel mới `bm-beads`, `title: "Beads"`, `context: "workspace"`, không có `locations`, `Component === BeadsTabPanel`, đứng trước `beads-agents`; cleanup gỡ nó; hai mục Command Center và hai slash command vẫn đủ |
| Nội dung dải trạng thái | `test/plugin-launcher.test.ts` | `launcherStatusLines`: không có gì → `[]`; có thông báo → dòng đầu, `dismissable: true`; `canOpenAgents: false` → `OLD_HOST_WARNING` tone `warning`; trạng thái `pending` / `error` / `opened` → đúng các dòng của `describeLauncherState`, sau hai dòng kia; chỉ dòng thông báo `dismissable` |
| Chỗ đặt dải trạng thái | `test/plugin-launcher.test.ts` (đọc mã nguồn `plugin/client/launcher.tsx`, như `test/plugin-structure.test.ts` đọc file) | `<LauncherStatus` xuất hiện đúng **một** lần; phần tử `<SetupScreen` có `status={status}`; nhánh danh sách workspace có `{status}` |
| Thông báo slash command | `test/plugin-slash-commands.test.ts` (đang có) | vẫn xanh, không sửa kỳ vọng |

- **Đối chứng âm:**
  - (`b4`) đảo thứ tự `STATUS_GROUP_ORDER` → ca nhóm đỏ;
  - (`b4`) mặc định `closedBeadsVisibility` là `true` → ca ẩn/hiện đỏ;
  - (`b4`) tạm cho `progress` của `beadsOverview` đếm cả epic → ca thống kê đỏ;
  - (`b5`) trả tone của `inProgress` về `info` → ca màu số trên dòng workspace đỏ;
  - đổi `in_progress` trong `STATUS_TONE` về `info` → test bảng màu đỏ;
  - cho `statusBadge` trả tone riêng → test bất biến đỏ;
  - bỏ dòng đăng ký panel → test đăng ký đỏ;
  - bỏ `{status}` khỏi nhánh danh sách workspace → test chỗ đặt đỏ.
- **Toàn gói:** `npm run verify` (typecheck, typecheck:plugin, lint, test, build).
- **Chạy thật (owner):**
  - trên máy tính và điện thoại: bấm "+" → "Beads" → hai tab con;
  - mở Beads Manager thấy Setup; "Workspaces" rồi ←;
  - chạy `/bm-worker-stop-all` rồi thấy thông báo ở màn chính; mở danh sách workspace thì dải trạng thái vẫn ở đó;
  - màu dòng và chip ở theme owner đang dùng.

  Worker không cài hay reload plugin trên daemon của owner.

## 7. Hoàn tác

Mỗi kết quả hoàn tác bằng cách revert file của chính nó (bảng file ở plan delta). Không có dữ liệu lưu bền nào đổi, và không có điểm không đảo ngược. Bỏ đăng ký panel rồi nạp lại plugin thì mục "Beads" biến khỏi "+". Tab đang mở của panel đó hiện "Plugin unavailable" như Paseo làm với mọi panel đã gỡ.

## 8. Rủi ro và giới hạn

| Rủi ro | Giảm nhẹ |
|---|---|
| App gốc iOS/Android chưa được đọc trực tiếp; F2 dựa trên bundle web | Owner kiểm trên điện thoại (điều kiện ra của phase). Nếu mobile không hiện mục, đó là giới hạn của Paseo: ghi lại và báo owner, không vá vòng |
| Tô 0.12 quá nhạt hoặc quá đậm ở một theme | Một hằng số `ROW_TINT_OPACITY`; vạch trái 4 px vẫn cho màu đậm nếu nền quá nhạt |
| Đỏ cho block, vàng cho đang làm lệch với màu các con số trên dòng workspace (in progress xanh, blocked vàng) | Ngoài phạm vi (PRD delta §7); ghi là gợi ý cho owner |
| Một Worker khác (`req-20260918T041426Z`) đang sửa cùng repo | Delta này không sửa `chat-cards.ts`, `chat-card.tsx`, `roles/*.md` hay `contracts.ts`. Chạy `git status` trước mỗi bead; file của bead bị sửa ở đoạn khác thì làm tiếp, cùng đoạn thì dừng và hỏi |

## 9. Câu hỏi mở

Không còn. Q1–Q3 đã trả lời (PRD delta §1.1).

Owner đã xác nhận các điểm Worker chọn thêm ngoài lời owner (Q4–Q6, PRD delta §1.2):

- màu dòng ở cả panel "Beads in this chat";
- `BeadInline` bỏ đậm nhưng không tô;
- dòng đầu màn trong tab chỉ còn Refresh;
- tên và thứ tự mục;
- độ mờ 0.12 và vạch 4 px;
- dòng phiên bản và dải trạng thái ở màn chính.

## 10. Revision History

| Ngày | Người | Thay đổi |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b5`: thêm §4.5 (bỏ `activity` của `beadsOverview`; `workspaceStats` đọc tone từ `STATUS_TONE`); §6 thêm ca và đối chứng âm. Status giữ Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b4` (Q8–Q12): thêm §4.4 (màu ở tên, `groupBeads`, `closedBeadsVisibility`, `doneText`, bỏ biểu đồ 14 ngày); §4.3 ghi rõ phần khung dòng bị thay; §6 thêm và sửa ca test, thêm đối chứng âm. Status giữ Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Đã implement (WP-260 → WP-263). Ghi thêm cho §6: `test/agent-tree.test.ts` cũng ghim danh sách panel đăng ký và nay có `bm-beads`. Status giữ Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | `design-ready` PASS sau review b1; Status → Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Review b1: dải trạng thái thành hàm thuần `launcherStatusLines`, được dựng một lần và đặt hai chỗ; thêm test nội dung, test chỗ đặt, đối chứng âm, và mục kiểm của owner (§4.2, §6) |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Owner xác nhận các điểm Worker chọn thêm (Q4–Q6); không đổi thiết kế |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Tạo delta: F1–F7, §4.1–§4.3, kiểm thử, hoàn tác, rủi ro |
