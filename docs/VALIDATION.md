# 實際驗證紀錄

2026-10-07 在 Linux x64 Cloud 使用系統 Chromium 151 執行實際 EIPrO 網站的安全 inspect 及三輪 rehearsal，兩者退出碼均為 0。未使用個資，未送出 hold 或客戶頁請求。

- 日表示、2026-10-26、10:00／10:30 均正確識別。
- 兩時段每輪均為 `unavailable`：尚未開放的官方旗標禁止預約，即使剩餘數為 15 也不執行動作。
- 每個流程有獨立 Chrome/Chromium process、context、cookie jar、計時與 retry。
- 完整 runtime artifacts 有 JSONL、cookie metadata、DOM、navigation timing、兩時段 screenshots；未追蹤於 Git。
- [真站 rehearsal 摘要](evidence/real-rehearsal-result.json)、[目標時段實際旗標](evidence/target-availability.json)、[實際日曆截圖](evidence/calendar-2026-10-26.png) 可供檢查。網路延遲只代表這次 Cloud 環境，不代表開賣時延遲。

驗證過程發現並修正 toolbar 容器高度、日期選單初始化、官方 `bindCalendar` 動態改寫 `data-target_selector`、以及 iframe navigation 日誌的問題。穩定 selector 使用實際 `#mainForm` 父層。CLI 透過 `tsc` 編譯後的 Node.js 執行，避免 transpiler helper 出現在瀏覽器函式序列化中。

自動化檢查：`npm run check` 執行 typecheck、lint、159 項 Vitest 測試，全部通過；`npm run build` 驗證可產出執行檔。瀏覽器測試使用 localhost 或攔截的官方形狀 fixture，涵蓋一次性 hold 成功證明、客戶 Autofill、信用卡／OTP 保持空白、安全模式意外呼叫仍被阻擋、redirect、429、未知 availability、時間、獨立並行及 receipt。

上述 10/7 run 沒有真實 hold 或客戶頁。當日自動審查曾拒絕真實時段點擊，後續使用公開 source 與零 hold 讀取；這是歷史紀錄，不是 10/8 UI 勘查的結果。Mac 仍需依 [檢查清單](MAC_CHECKLIST.md) 驗證 repo adapter、當次表單、額外資源及 Autofill，未知資源不能擴大成任意 GET allowlist。

GitHub 推送目標已指定為 [Zhong-627/takachiho-sniper](https://github.com/Zhong-627/takachiho-sniper)。GitHub Actions workflow 已建立，測試階段只有 loopback 網路。上述通過紀錄來自本機 Cloud 驗證，尚未確認 GitHub Actions 執行結果；推送後請在 repository 的 [Actions 頁面](https://github.com/Zhong-627/takachiho-sniper/actions) 檢查狀態。專案附鎖定相依套件、CI、文件及 Git history，可依 README 從 GitHub clone。

## 2026-10-08 更新範圍

另一次已授權 Cloud 官方 UI 勘查成功暫留 1 艘並讀取表單，詳見 [紀錄](FORM_20261008.md)。未執行本 repo adapter、填入個資、勾同意、提交或付款。沒有 Mac Autofill／receipt，不能把 UI 成功計作軟體已實測成功。

新增 `observed-form` 契約、9 欄 mappings、必要欄位來源、姓／名與代表人一致性、三個 dummy checkbox 人工防護及 receipt v2。離線 fixture 從去除個資的 metadata 重建，不保存完整真站 HTML，也未模擬未知生日格式化或伺服器驗證。程式不放寬未知欄位、付款或額外資源 allowlist；正式 adapter 與 polling 行為維持原設計。

2026-10-08 Linux x64／Node.js 24.19.0，最後一次 `npm run check` 的 typecheck、lint 與 **185 項測試（13 個 suites）全部通過，無跳過**；另執行 `npm run build`。本機 full Chromium 初次啟動被環境的 Unix socket 權限拒絕，改用同版 Playwright Chromium Headless Shell 141 執行完整離線測試，沒有修改 Mac browser 設定或降低 guard。重現 Cloud 檢查的環境變數如下，Mac 正常安裝不需這個路徑：

```bash
PLAYWRIGHT_EXECUTABLE_PATH=/root/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell npm run check
npm run build
```

新增 25 項表單測試及 1 項 receipt 版本測試；涵蓋 raw required=false、9 個值非空、地址／人數 mapping 缺漏、消失／改型／唯讀／重複 control、付款語義優先、三個確認保持人工、精確人數 value、HTML 限制 metadata、姓／名與代表人一致性、舊 receipt 失效。所有新增填寫使用假資料與本機 HTML；沒有再向 EIPrO 建立 hold 或生成真實本機 receipt。本紀錄不等於 GitHub Actions 已通過，CI 以提交後實際狀態為準。

## 2026-10-08：預約目標改由 local config 指定

日期、開賣時間、1–2 個 HH:mm 時段及各船個資改由 local config 讀取，移除原本正式模式固定日期、開賣 instant 與 10:00／10:30 的限制。三個目標欄位必填，保留日期／時區／時段格式、唯一時段、不同代表人、已驗證 mappings、可見瀏覽器及每時段單次 hold 防護。執行中 f 仍可改個資與 mappings；若有效日期、開賣 instant 或時段集合已變更，會拒絕填寫原表單。

Linux x64／Node.js 24.19.0／Playwright Chromium Headless Shell 141：`npm run check` 的 typecheck、lint 與 **206 項測試（13 個 suites）全部通過，無跳過**；`npm run build` 成功。新增 21 項測試，涵蓋必填目標、HH:mm 邊界、漏改 customers key、任意時段的代表人及 readiness、開賣時間等待、執行中目標變更與 CLI 覆寫限制。離線瀏覽器整合案例使用 2026-11-03、09:15／11:45 的合成日曆，兩個流程各取得一次受保護 fixture hold 並使用各自假資料，信用卡／OTP 空白、客戶表單未提交，再次 hold 仍被拒絕。此日期／時段僅為測試資料，不表示官方實際提供。

編譯後的 doctor 另以暫存 config 驗證單／雙自訂時段，正確輸出乘船日期、時段及台北開賣時間，缺少真實 receipt 時維持未就緒。編譯後 full-rehearsal 接受 09:15，再由非互動終端防護停止，沒有啟動瀏覽器。所有測試使用離線 fixture／暫存資料，沒有操作真站或建立新的真實驗證紀錄。Mac Autofill 與正式 availability 仍須依檢查清單確認。

## 2026-10-08：搶位啟動與歷史填表紀錄分開

歷史 receipt 改為參考提示。缺少、舊版、過期或 mapping 不相符的紀錄不再阻止 live 啟動；自動模式的本機欄位／mapping 完整性、代表人一致性、不同代表人、可見瀏覽器與 side-effect 確認仍須通過。新增 `--manual-customer-form`（live／doctor），保留代表人與目標檢查，客戶頁只檢查、不自動填寫，`f` 停用。

每次自動填表在第一欄寫入前檢查全部 mappings、必填客戶欄位與選項；未知必填欄位或缺少 mapping 時整批停止。填寫中的欄位變更、值不符或 HTML validity 失敗也停止後續寫入。結果未通過時明確回報 manual 並提示 handoff，仍保留已取得頁面；同一時段不重新 hold，另一時段獨立繼續。成功填寫可更新 live／full rehearsal 的歷史紀錄，並行寫入保留兩組不同 mapping 的紀錄；紀錄寫入失敗不丟棄已取得的位置。

macOS arm64／Node.js 22.16.0／Playwright Chromium 141：`npm run check` 的型別、lint 與 **218 項測試（14 個 suites）全部通過，無跳過**。新增的離線瀏覽器整合案例確認無 receipt 也可準備兩組 live flow，第一組 mapping 指向付款欄位時沒有填入任何個資、只建立一次 fixture hold，第二組正常完成客戶欄位填寫；信用卡／OTP 保持空白。其他案例涵蓋人工模式零寫入、未對應的必填欄位、填寫中新增欄位、HTML 失敗後停止、瀏覽器錯誤去敏感與選用紀錄寫入失敗。

## 2026-10-09：持續監控與確認額滿後恢復

live 新增必填的 `monitorUntil` 絕對截止時間，取消 80 次／預設 20 分鐘及開賣後 20 分鐘的啟動限制。普通額滿讀取沿用固定 base delay 與 jitter，429／錯誤仍保留退避。收到匹配的 HTTP 2xx 字串 `0` 後，還須確認當次官方結果常數、原日曆頁及同一場次的新 `is_full=true`，才能清除該次失敗能力並回到監控。其他回應、成功及 full rehearsal 不能重送。

macOS arm64／Node.js 22.16.0：完整 `npm run check` 的型別、lint 與 **238 項測試（14 個 suites）全部通過，無跳過**。新增測試涵蓋持續 1301 次讀取且超過 20 分鐘、原頻率保持、截止後抵達的可預約回應不觸發 hold、截止前準備但截止後不派送、手動取消、Retry-After、明確拒絕後額滿再釋出、未知／仍有餘位／場次變更／結果常數變更不得恢復、成功後禁止再送及演練保持一次性。本次瀏覽器測試全部使用離線 fixture，沒有新增真站暫留。

編譯後 `npm run doctor` 使用本機設定（2026-10-23、10:00／10:30，2026-10-09 08:00 台北開賣）退出碼為 0，顯示搶位設定通過、兩組自動填表待當次表單確認。測試中的所有驗證紀錄只寫入測試暫存路徑，沒有冒充真站紀錄。這次程式修改未執行額外真實暫留或付款；正式表單與伺服器接受情況仍取決於當次網站。

## 2026-10-12：07:58 提前查詢與 750 ms 間隔

新增選填 `monitorFrom`，將開始查詢時間與 `releaseAt` 分開，舊設定未填時仍從開放時間開始。本機目標為 2026-10-26 的日本時間 11:00／11:30，台北 2026-10-12 07:58 開始查詢、08:00 開放、10:00 截止，正常回應後基礎等待改為 750 ms；個資及其他設定值保留。預熱改以開始查詢時間為基準。

有效且無錯誤的日曆回應在開放前尚未列出時段時，維持普通等待，不累積 20 秒退避；正常等待會對齊開放時間，跨過開放時間才完成的正常查詢會立即再查一次，沒有並行重疊請求。未知、錯誤、開放後尚未出現時段與 429 繼續退避；`Retry-After` 不因開放而縮短。尚未出現時段仍是 unknown，不能觸發 hold。

macOS arm64／Node.js 22.16.0：型別檢查、lint、編譯與 doctor 通過；完整 **251 項測試（14 個 suites）全部通過，無跳過**。13 項新增測試涵蓋 07:58 起至 08:00 的 161 輪模擬讀取、750 ms 等待、跨開放時間的定時與延遲回應、錯誤及 Retry-After 不被縮短、有效未列出時段與損壞回應的區分、開始時間驗證及執行中設定保護。第一次瀏覽器測試因 macOS 沙箱阻擋 Chromium／localhost 而無法啟動，允許本機離線測試執行後完整重跑通過。瀏覽器測試只使用 localhost 或攔截的 fixture，沒有新增真實船位暫留。
