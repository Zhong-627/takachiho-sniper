# 真站研究與驗證範圍

公開日曆／程式觀察日期：**2026-10-07 UTC**，當日僅公開讀取、沒有 hold。另於 **2026-10-08 Asia/Taipei**，使用者明確授權一次官方 UI 暫留勘查，已進入一份客戶表單；沒有填個資、勾同意、提交或付款。來源為 `https://eipro.jp/takachiho1/`、公開日曆、官方載入的 JavaScript 及該次可見表單。完整 [10/8 紀錄](FORM_20261008.md) 與 [欄位 metadata](evidence/customer-form-20261008.json) 可核對。UI 勘查與本 repo adapter／Mac 驗證分開記錄。

## 已確認的公開 flow

1. 首頁 `GET /takachiho1/` 回傳 HTTP 302，導向 `GET /takachiho1/terms/view/toppage`。
2. 官方使用說明連到 `/takachiho1/eventCalendars/index` 的預約日曆。
3. 日曆由 FullCalendar 3.9.0／官方 `App` module 管理，使用官方日期選取控制項與日視圖。
4. 官方 JavaScript 使用 `POST /takachiho1/eventCalendars/search` 讀取指定日期範圍，以及 `POST /takachiho1/apiCalendars/api/holidays` 讀取假日資訊。POST method 本身不代表建立 reservation，這兩條的用途及 body 已從官方程式確認；工具只准其已驗證結構。
5. 公開官方 `App.Module.Front.Order.link` 組成 `POST /takachiho1/apiServices/api/hold_slot`。只有 server JSON `data.result === "1"` 成功時，才導向 `GET /takachiho1/orders/add`。10/7 確認的是公開 source，沒有 hold；10/8 UI 勘查確認進入該頁及倒數，但沒有擷取獨立 hold HTTP 回應的時間／JSON，不以 UI 操作返回時間代替。
6. 10/8 正常 UI 先點日曆時段，開啟只讀詳情；「予約手続き」才是預約操作，「予約終了」不能預約。當次官方 constants 是 POPUP=1、ORDER=2、DETAIL=3。repo 使用經 guard 保護的官方 `Order.link` adapter，不因 UI popup 的 action type 就改成 2，也不新增未驗證的替代 hold 流程。

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

這些內容是當時觀察，不代表 10 月 12 日仍有同樣餘位。10/8 勘查曾遇到日曆顯示剩 1 艘，但詳情已「予約終了」；仍不得只因 remaining>0 就 action。本 repo 仍核對完整官方 flags，缺少或矛盾則 unknown。Mac 的 adapter 與正式瞬間狀態尚未驗證。

## 官方公開規則

官方使用說明表示 reservation hold 約 **15 分鐘**。同一代表人不能同時預約多艘船；兩個獨立 flow 應使用不同實際代表人。付款、信用卡、3D Secure、安全驗證與最終確認全部交由使用者。取消／釋放規則以官方當前頁面為準，工具關閉瀏覽器不保證立即釋放 hold。

## 已觀察的客戶表單，尚未實測填寫

10/8 官方 UI 暫留了 2026/10/15 日本時間 08:30–09:00、1 艘、當次 ¥4,100，08:18:05.268 台北時間確認 `予約入力` 與倒數。價格／表單只代表這一份，不套用到 10/26。實際確認 9 個 control：姓／名、片假名姓／名、Email、電話、住家地址、生日、乘客組成；selector 與 16 個人數 options 見 [FORM_20261008.md](FORM_20261008.md)。沒有猜測 selector。

客戶 input 沒有連結的原生 label，DOM required 全是 false，但頁面要求全部資訊。工具會讀短欄位標籤，並在符合當次 customer profile、name／tag／type 的實際 DOM 中使用已觀察語義；schema 區分 `htmlRequired` 與 `requiredSources`。缺欄位、類型改變、重複或不可編輯時停止，不會產生 verified。片假名無星號，目前依「全部資訊」採本機保守非空檢查，不表示已確認伺服器必填。

三個 checkbox 名稱都是 `data[dummy]`，當次 UUID id 跨次穩定性未驗證；全部保持人工，即使第三個文字是「確認」而非「同意」。付款 UI／安全欄位同時出現在表單，仍禁止自動操作。

config example 已帶實際 mappings，個資只在 Mac 的 `config/config.local.json`。Mac full rehearsal 是選用演練，須有一次明確授權的 hold；可在同一頁核對當次 DOM、生日格式與海外電話／地址、額外資源並輸入 `f` 實測填寫。live 不要求先取得 receipt；近期相符紀錄僅供參考，每次自動填寫仍核對當次表單。live／full rehearsal 實際客戶欄位填寫與 HTML 檢查通過才記錄 receipt v2；失敗、人工模式與 Cloud 公開勘查不產生真實本機驗證紀錄。離線 fixture 僅使用測試暫存路徑，不冒充真站紀錄。

客戶頁可能需要日曆未出現的新 script、stylesheet 或 read-only endpoint。這些仍受 allowlist 防護，尚須在 Mac 看 `blocked` 診斷後逐一研究確認，不能宣稱已完成驗證。不要以開放未知 POST、未知 redirect、第三方網域或付款 request 解決自動化載入問題。

## Cloud 與 Mac 的分界

Cloud 已確認公開 HTTP flow、官方 source、日曆 DOM／event model、未開放狀態，另透過官方 UI 確認一次暫留與真實客戶頁；離線 fixture 可驗證程式邏輯。Cloud 未在這次 UI 勘查執行本 repo adapter，未驗證 Apple Silicon browser、客戶頁新資源 allowlist、實際 Autofill、伺服器欄位驗證、付款或開放瞬間競爭。

本次 07:50–08:20 查找窗在 08:17 成功後提早停止，保存 641 筆日曆讀取紀錄，間隔中位數 1,297 ms、最大 180,013 ms；包含工具檢查中斷，沒有精準每秒一次。這是勘查實測，不改寫正式程式預設 polling／backoff，也不保證伺服器或網路節奏。

安全模式預設只允許當時確認的公開讀取路徑與已列出的資源。官方若改版，先 inspect 診斷，重新確認公開用途再修改 `src/site-rules.ts`，並執行 safety tests。`docs/evidence/observed-assets.json` 是公開資源 evidence；不包含 Cookie 值、action token 或私人資料。

網路 latency、redirect、Cookie metadata、maintenance／queue／CAPTCHA 都由當次 inspect 診斷收集。一次 Cloud 觀察不能證明 Mac 當下沒有 queue 或 CAPTCHA，也不能證明開放時延遲。
