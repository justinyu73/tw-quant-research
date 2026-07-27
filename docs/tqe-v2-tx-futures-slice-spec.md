# TQE v2 TAIFEX TX futures slice spec

Status: `spec_draft_pending_human_approval`

依 [`docs/tqe-v2-ia-uiux-plan.md`](tqe-v2-ia-uiux-plan.md) §6.2 展開的
TAIFEX TX 補足 slice 規格。本文件是規格草案：不實作、不擷取；任何
provider 接觸都需要獨立的 P5.1 風格 source contract 與人類批准的
work-unit。

## 1. 範圍

K6b 已有單一 `TX:202608` fixture（OHLCV）。本 slice 補足台指期貨（TX）
商品 detail 的第一版欄位，並定義第二層（法人／大額交易人）的邊界。

第一版欄位：

```text
contract_month
expiry（來源沒有就 null，不推導）
session（日盤／夜盤，依來源標示）
open / high / low / close
settlement
volume
open_interest
available_at / as_of / source / digest
```

## 2. Read model 對應（6B 統一 /instrument）

期貨走同一支 `GET /instrument?instrument=TAIFEX:TX:202608`，
`asset_class: "futures"`，期貨專屬欄位放 `sections.futures`：

```json
{
  "sections": {
    "quote": {"open": null, "high": null, "low": null, "close": null, "volume": null},
    "futures": {
      "contract_month": null,
      "expiry": null,
      "session": null,
      "settlement": null,
      "open_interest": null,
      "institutional": null
    }
  }
}
```

- `sections.futures` 對 equity 為 null；`sections.fundamentals/financials`
  對 futures 為 null——asset class 不共用錯誤欄位（v2 驗收矩陣）。
- `institutional`（法人／大額交易人）為**第二層**，本 slice 只保留欄位
  位置（null），不與第一版 TX OHLCV 驗收混在一起。

## 3. 來源評估框架（啟動前置）

候選：TAIFEX 官方 OAS（[TAIFEX OpenAPI](https://openapi.taifex.com.tw/)）
已列出每日期貨行情、法人期貨資料、大額交易人未平倉、最後結算價等資料
類型，作為後續切片依據。

每個候選 endpoint 啟動前需完成 P5.1 風格 source contract：method、
query、response schema、coverage（單一契約月份 vs 全月份）、更新頻率、
licence、digest 政策、request budget。

## 4. PIT 與品質規則

- `available_at <= as_of`（P5.2 慣例）；`retrieved_at` 不當 `available_at`。
- 缺欄位不補 0、不推導 expiry；未提供時為 null 並標記 quality。
- 夜盤 session 與日盤的歸屬日規則需在 source contract 中明確定義後才
  實作；未定義前不拼接。

## 5. 驗收對應

- TX 頁能顯示 contract month、session、settlement、OI 狀態；valid、
  partial、unavailable、unsupported、invalid 皆有明確中文狀態。
- 測試：offline fixture 擴充 K6b（新增含 settlement/OI 的 fixture），
  無網路、無 wall-clock 依賴。
- 閘門：`p4_research_closure.py`、browser smoke、open-source audit 全綠。

## 6. Out of scope（本 slice 不做）

- 選擇權、個股期貨、價差、所有商品一次性全接。
- 自動近月推導與連續合約拼接。
- 法人／大額交易人資料的實際 ingestion（第二層，另立 slice）。
