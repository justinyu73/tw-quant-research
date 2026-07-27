# TQE v2 fundamentals slice spec

Status: `spec_draft_pending_human_approval`

依 [`docs/tqe-v2-ia-uiux-plan.md`](tqe-v2-ia-uiux-plan.md) §6.1 展開的
fundamentals snapshot slice 規格。本文件是規格草案：不實作、不擷取、
不批准任何來源；任何 provider 接觸都需要獨立的 P5.1 風格 source contract
與人類批准的 work-unit。

## 1. 範圍

依已選方案 2B（基本面 + 現金流、股利、BVPS、毛利率／營益率）與 3A
（最新 EOD + 既有 fixtures），為股票／ETF 補一條 fundamentals snapshot
pipeline：

```text
TWSE／TPEx government open data
    ↓
manual HTTPS GET ingestion（人工啟動、bounded）
    ↓
append-only fundamentals snapshot
    ↓
point-in-time normalizer
    ↓
instrument read model（/instrument sections.fundamentals / financials）
```

首個 gate 只驗證**最新可取得資料**與 repo-local fixtures 的 replay；
歷史回補另立 slice，不在本範圍。

## 2. 最小欄位（2B）

| 區塊 | 欄位 |
| --- | --- |
| 估值摘要 | PE、EPS、月營收 |
| 損益表 | 營收、毛利、營業利益、稅後淨利、EPS、毛利率、營益率 |
| 資產負債表 | 資產、負債、權益、BVPS |
| 現金流量表 | 營業、投資、籌資現金流 |
| 股利 | 股利年度、每股股利、殖利率（來源有提供時） |

缺資料不補 0；未提供的欄位維持 null 並在 quality 標記。

## 3. Provenance 欄位（每筆必備）

```text
instrument_id、market、period_end、fiscal_year、quarter
available_at、published_at、retrieved_at
source_id、source_url、content_digest、license_ref、quality
```

鐵律（沿用 v2 驗收矩陣）：

- 不把 `retrieved_at` 當 `available_at`；`available_at` 採 P5.2 PIT 慣例
  （`available_at <= as_of`）。
- append-only snapshot：source、資料期別、可用時間、抓取時間、digest 全保留。
- provider ingestion 與 dashboard pipeline 分開驗收。

## 4. Read model 草案（6B 統一 /instrument）

```json
{
  "schema": "tw-quant-engine-instrument-read-model/v1",
  "read_only": true,
  "instrument": {"instrument_id": "TWSE:2330", "asset_class": "equity"},
  "as_of": "...",
  "available_at": "...",
  "sections": {
    "quote": {},
    "kline": {},
    "fundamentals": {
      "pe": null, "eps": null, "monthly_revenue": null,
      "dividend": {"fiscal_year": null, "per_share": null, "yield": null}
    },
    "financials": {
      "income_statement": {"revenue": null, "gross_profit": null, "operating_income": null, "net_income": null, "eps": null, "gross_margin": null, "operating_margin": null},
      "balance_sheet": {"assets": null, "liabilities": null, "equity": null, "bvps": null},
      "cash_flow": {"operating": null, "investing": null, "financing": null}
    },
    "futures": null,
    "evidence": {}
  },
  "quality": {},
  "provenance": {}
}
```

個人合理區間輸入**不進** `/instrument`，留在前端暫存（避免個人估值假設
混入官方資料 read model）；估值公式（P6-5 已啟用的 valuation & analysis）
只消費 admitted 資料，不消費未驗證的 fundamentals。

## 5. 來源評估框架（啟動前置）

候選來源一律先過 P5.1 風格 source contract 評估，順序：

1. 政府 open data（data.gov.tw 授權）優先：TWSE／TPEx 官方 openapi 與
   公告頁；逐 endpoint 記錄 method、schema、coverage、licence、digest 政策。
2. 每個候選需證明：bounded response、欄位涵蓋 §2 最小欄位的哪部分、
   更新頻率、`published_at` 可得性。
3. 不採用：FinMind 作為 canonical source（v2 §6.3 明列排除）、
   MOPS PDF 解析、公開分析師預估 EPS 或固定合理價。

## 6. 驗收對應

- Data 驗收矩陣：EPS、PE、月營收、財報、股利、BVPS、margin 具
  period/as-of/provenance；最新 snapshot 可 replay、digest 穩定。
- 測試：offline fixture、無網路、無 wall-clock 依賴；缺資料 fail-closed
  標記 quality，不補 0。
- 閘門：`p4_research_closure.py`、browser smoke、open-source audit 全綠。

## 7. Out of scope（本 slice 不做）

- 歷史回補（另立 slice）、即時或 delayed 行情（P6-2 另行）、選擇權／
  個股期貨、自動近月推導、MOPS PDF、FinMind canonical、分析師預估。
