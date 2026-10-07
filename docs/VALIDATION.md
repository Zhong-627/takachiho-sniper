# 實際驗證紀錄

2026-10-07 在 Linux x64 Cloud 使用系統 Chromium 151 執行實際 EIPrO 網站的安全 inspect 及三輪 rehearsal，兩者退出碼均為 0。未使用個資，未送出 hold 或客戶頁請求。

- 日表示、2026-10-26、10:00／10:30 均正確識別。
- 兩時段每輪均為 `unavailable`：尚未開放的官方旗標禁止預約，即使剩餘數為 15 也不執行動作。
- 每個流程有獨立 Chrome/Chromium process、context、cookie jar、計時與 retry。
- 完整 runtime artifacts 有 JSONL、cookie metadata、DOM、navigation timing、兩時段 screenshots；未追蹤於 Git。
- [真站 rehearsal 摘要](evidence/real-rehearsal-result.json)、[目標時段實際旗標](evidence/target-availability.json)、[實際日曆截圖](evidence/calendar-2026-10-26.png) 可供檢查。網路延遲只代表這次 Cloud 環境，不代表開賣時延遲。

驗證過程發現並修正 toolbar 容器高度、日期選單初始化、官方 `bindCalendar` 動態改寫 `data-target_selector`、以及 iframe navigation 日誌的問題。穩定 selector 使用實際 `#mainForm` 父層。CLI 透過 `tsc` 編譯後的 Node.js 執行，避免 transpiler helper 出現在瀏覽器函式序列化中。

自動化檢查：`npm run check` 執行 typecheck、lint、159 項 Vitest 測試，全部通過；`npm run build` 驗證可產出執行檔。瀏覽器測試使用 localhost 或攔截的官方形狀 fixture，涵蓋一次性 hold 成功證明、客戶 Autofill、信用卡／OTP 保持空白、安全模式意外呼叫仍被阻擋、redirect、429、未知 availability、時間、獨立並行及 receipt。

真實 hold、Customer Information DOM、付款及 3D Secure **沒有在 Cloud 執行**。自動審查曾拒絕真實時段點擊，因為選擇可能扣減名額；後续確認採用公開 JavaScript 與零 hold 的頁面讀取。Mac 需依 [檢查清單](MAC_CHECKLIST.md) 用帶明確確認旗標的 full-rehearsal 確認实际表單、額外 assets 及 Autofill。若客戶頁有尚未驗證的資源，guard 會阻擋並留下診斷；先人工檢查其精確路徑與來源，不能擴大為任意 GET allowlist。

GitHub Actions workflow 已建立，測試階段只有 loopback 網路。尚未提供 GitHub repository 目的地，因此尚未推送 remote 或實際執行 GitHub Actions。專案附鎖定相依套件、CI、文件及本機 Git history，供推送後從 GitHub clone。
