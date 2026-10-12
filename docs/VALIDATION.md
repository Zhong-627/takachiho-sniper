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
