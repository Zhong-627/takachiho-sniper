# 真站研究與驗證範圍

觀察日期：**2026-10-07 UTC**。來源為 `https://eipro.jp/takachiho1/`、可公開存取的日曆與網站自行載入的官方 JavaScript。研究只使用公開讀取，沒有派送 `hold_slot`、沒有進入 `orders/add`、沒有付款。

## 已確認的公開 flow

1. 首頁 `GET /takachiho1/` 回傳 HTTP 302，導向 `GET /takachiho1/terms/view/toppage`。
2. 官方使用說明連到 `/takachiho1/eventCalendars/index` 的預約日曆。
3. 日曆由 FullCalendar 3.9.0／官方 `App` module 管理，使用官方日期選取控制項與日視圖。
4. 官方 JavaScript 使用 `POST /takachiho1/eventCalendars/search` 讀取指定日期範圍，以及 `POST /takachiho1/apiCalendars/api/holidays` 讀取假日資訊。POST method 本身不代表建立 reservation，這兩條的用途及 body 已從官方程式確認；工具只准其已驗證結構。
5. 公開官方 `App.Module.Front.Order.link` 組成 `POST /takachiho1/apiServices/api/hold_slot`。只有 server JSON `data.result === "1"` 成功時，才導向 `GET /takachiho1/orders/add` 的 Customer Information 流程。研究確認的是官方公開程式路徑，**並未真實派送此 hold**。

## 已確認的 DOM 與資料來源

| 項目 | 真實觀察 |
| --- | --- |
| Calendar root | `#service-full-calendar` |
| 日視圖控制項 | `#mainForm [data-target_view_name="agendaDay"]` |
| 日期 select | `#mainForm .fullcalendar_control_date_list`，option value 為 `YYYY/MM/DD` |
| 日曆事件 | `.fc-event` |
| 事件開始時間 | 事件中的 `input.service_unit_service_start_datetime` |
| Event model | 官方 jQuery FullCalendar 的 `clientEvents`，另含可預約／開始時間旗標 |

2026-10-07 在公開日曆 event model 中，**2026/10/26 10:00 及 10:30 各顯示 remaining 15**，但同時 **`ordable=false`、`reserve_possible=false`、`is_reserve_started=false`**。這是未開放，不可因 remaining 大於零就宣稱 available。程式必須核對日期、時間與明確的官方預約旗標；資料缺少、型別變更或互相矛盾應是 `unknown`，不得派送 hold。

這些內容是當時觀察，不代表 10 月 12 日仍有同樣餘位。Calendar 讀取、資料判斷與官方函式的作用已確認；真實使用者 UI click 的 hold 結果尚未在 Mac 執行。

## 官方公開規則

官方使用說明表示 reservation hold 約 **15 分鐘**。同一代表人不能同時預約多艘船；兩個獨立 flow 應使用不同實際代表人。付款、信用卡、3D Secure、安全驗證與最終確認全部交由使用者。取消／釋放規則以官方當前頁面為準，工具關閉瀏覽器不保證立即釋放 hold。

## 客戶表單尚未確認

Cloud 研究沒有前往 `orders/add`，因為正常流程需要先建立真實 hold。**沒有已確認的姓名、フリガナ、Email、電話、人數或其他客戶欄位 selector**。不得把通用欄位猜測寫成 official selector。

工具在 Mac full rehearsal 已取得 hold 後，才檢查實際可見 `input`／`select`／`textarea`、label、id、name、required、選項及唯一 selector，輸出去除個資的表單 schema。使用者依該 DOM metadata 建立 local mappings，於同一流程輸入 `f` 再驗證，不重複占位。live 需要這組 mappings 已通過 full rehearsal 的本機 receipt。

客戶頁可能需要日曆未出現的新 script、stylesheet 或 read-only endpoint。這些仍受 allowlist 防護，尚須在 Mac 看 `blocked` 診斷後逐一研究確認，不能宣稱已完成驗證。不要以開放未知 POST、未知 redirect、第三方網域或付款 request 解決自動化載入問題。

## Cloud 與 Mac 的分界

Cloud 已確認公開 HTTP flow、官方 source、日曆 DOM／event model、未開放狀態；離線 fixture 可驗證程式行為。Cloud 未驗證 Apple Silicon native browser、真實 hold 成功、客戶頁新資源、實際 Autofill、付款或開放瞬間 server contention。

安全模式預設只允許當時確認的公開讀取路徑與已列出的資源。官方若改版，先 inspect 診斷，重新確認公開用途再修改 `src/site-rules.ts`，並執行 safety tests。`docs/evidence/observed-assets.json` 是公開資源 evidence；不包含 Cookie 值、action token 或私人資料。

網路 latency、redirect、Cookie metadata、maintenance／queue／CAPTCHA 都由當次 inspect 診斷收集。一次 Cloud 觀察不能證明 Mac 當下沒有 queue 或 CAPTCHA，也不能證明開放時延遲。
