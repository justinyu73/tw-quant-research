---
name: uiux-review
description: TQR dashboard UI/UX review checklist — design tokens, type ladder, badge/form/card specs, color principles (TW red-up/green-down, no AI-style visuals), and the offline RWD verification flow with screenshot self-review.
whenToUse: Use before and after changing ui/dashboard/styles.css or the class structure in ui/dashboard/app.js — whenever touching layout, typography, badges, form controls, colors, or anything that can shift the dashboard's visual baseline across the six audited breakpoints.
---

# TQR dashboard UI/UX review

The dashboard is a research-only, offline market terminal. It must read like a
professional financial terminal, not a generic AI dashboard.

## Rule 0: read the design tokens first

Before editing `ui/dashboard/styles.css`, read the two `:root` blocks (top of
file and the "Canonical TQR-UIUX-001" section) and work from the existing
tokens — never introduce a parallel scale:

- Type: `--type-page` (26) / `--type-card` (17) / `--type-section` (14) /
  `--type-body` (14) / `--type-helper` (12), `--leading-body`, `--leading-tight`.
- Controls: `--control-h` (38px), `--touch-min` (40px).
- Color: `--primary` blue accent, `--success` / `--warning` / `--danger`,
  `--green` / `--yellow` / `--red`, neutrals (`--text`, `--text-secondary`,
  `--text-muted`, `--border`, `--surface*`).
- Radius/shadow: `--radius*` (3–5px, squared terminal look), `--shadow`,
  `--shadow-modal`.

## Type ladder (apply consistently)

- 大標題 H1: `.page-title` → `var(--type-page)` (26px, 760 weight).
- 中標題 card/section: `.card-title`, `.terminal-panel-heading h2`,
  `.data-update-heading h2`, dialog/builder header h2 → `var(--type-card)` (17px).
- 小標題 subsection: `.subsection-heading h2`, note/story item titles →
  `var(--type-section)` (14px); eyebrow/pretitle labels → `var(--type-helper)`.
- Numeric displays (quote price, stat values) are not headings — size them for
  the data, but keep them inside their containers (see RWD rules).

## Badges / pills

One size scale: `padding: 4px 8px; border-radius: 3px; font-size: 10px;
font-weight: 700; letter-spacing: 0.02em` (see the "UIUX convergence" block).
Semantic colors only: neutral (muted on `--surface-secondary`), positive
(`--success` tint), warning (amber tint), info (blue tint). Do not add new
badge colors that are not already in the token set.

## Form controls

- Every text input / select / textarea: `min-height: var(--control-h)` (38px),
  `padding: 0 10px`, `font-size: var(--type-helper)` — enlarge dense 27–32px
  stragglers instead of inventing new heights.
- Labels: 10–12px, muted, 4–8px gap above the control; keep them consistent
  across toolbars and panels.
- In grid/flex tracks, controls must shrink: `min-width: 0; width: 100%`, and
  the parent label grid uses `grid-template-columns: minmax(0, 1fr)` so
  intrinsic input/select widths never escape their track.

## Form rejection feedback (TQR-FORM-FEEDBACK)

- 任何因「不符合計算或規則」而 disabled 的按鈕（或被拒絕的提交）都必須跳出
  可見提示：指出**哪個欄位錯**與**正確格式/規則**（例：「門檻值需為數字，
  例如 950 或 12.5」、「折現率 r 必須大於股利成長率 g」）。靜默 disabled
  不允許；按鈕 enabled 時提示必須隱藏。
- Issue 清單由 `dashboard-core.js` 的純函式產生（`alertFormIssues`、
  `valuationFormIssues`、`watchlistGroupNameIssues`、`watchlistAddIssues`），
  回傳 `[{field, message}]`，message 用中文。規則必須抄自引擎 fail-closed
  validators（`alerts.py` / `valuation.py`）或 reducer 守衛——不要在 UI 另造
  規則。
- 呈現用共享 `.form-issues`（跨欄 `<ul>`，放按鈕旁/表單下方）：
  `var(--type-helper)`（12px）、`var(--warning)` 文字色、無背景無邊框、
  `•` 標記，克制不喧賓奪主；`hidden` 時完全不占位。
- 輸入時用 `refreshFormIssues(testId, issues)` 直接更新 DOM——打字不能觸發
  整頁 re-render（會丟焦點）。
- 引擎/sidecar 在 evaluation 時才發現的拒絕（如 r<=g），錯誤訊息經
  `engineErrorMessage` **原樣**顯示在既有 status 行，不改寫引擎文案；引擎
  訊息本身必須含欄位與規則，fail-closed 行為不變。

## Color principles (de-AI)

- Neutral deep blue-gray chrome (sidebar `#131722`), light warm-gray body,
  white surfaces, **one** accent blue (`--primary` `#2962ff`).
- 台股慣例： `.positive` = red (`--red`), `.negative` = green (`--green`) — never
  invert these.
- Forbidden "AI 感": bright purple (`#7c3aed`-family), neon/cyan glow, rainbow
  or multi-stop decorative gradients, heavy shadows, large border radii.
  Surfaces are flat (`background: var(--surface)`), radius stays 3–5px, shadows
  stay at `--shadow` / `--shadow-modal` levels.
- Status colors follow the existing semantic set (`status-admitted` green,
  `status-unadmitted`/`partial` amber, `status-invalid`/`error` red, loading
  states blue).

## RWD rules (hard requirements)

- Six audited breakpoints: 1440 / 1280 / 1024 / 820 / 720 / 390.
- Grid/flex tracks that hold content must be shrinkable: `minmax(0, 1fr)` and
  `min-width: 0` on children — bare `1fr` tracks caused the market@390
  page overflow (root cause A).
- Mono numeric values (technical readings, metric labels) need
  `overflow-wrap: anywhere` and/or `auto-fit` grids so they never spill.
- Tables may only scroll inside `.table-responsive` (TQR-WIREFRAME-002).
- The topbar breadcrumb truncation at 720px (`.system-topbar-left .breadcrumb`
  `max-width: 96px; overflow: hidden`) is **intentional** — the one accepted
  audit failure; do not "fix" it.

## Verification flow (offline, loopback only)

1. `node scripts/dashboard-rwd-audit.cjs` — walks all nine views × six
   breakpoints; failures must be 0 except the intentional 720px breadcrumb
   clip (9 entries, `kind: clipped`, class `breadcrumb`). Writes
   `outputs/dashboard-rwd-audit.json`. Reuses 127.0.0.1:5173 when reachable,
   otherwise spawns its own server (5199/8770) with a fresh preview build.
2. Screenshot self-review: capture all nine views at 1440 and 390 (Playwright,
   same harness as the audit) and **look at every image** — hierarchy, badge
   sizes, control heights, spacing, and color tone must read consistently; no
   clipped or wrapped-awkward content.
3. `node scripts/dashboard-browser-smoke.cjs` — functional checks + pixel
   baselines. On `functional_pass_baseline_required`, manually review every
   PNG in `outputs/dashboard-browser/`, confirm each diff is an intended
   visual change, then update `EXPECTED_SCREENSHOTS` hashes and rerun to
   `pass`. Never update baselines without looking at the images.
4. `node scripts/dashboard-alerts-smoke.cjs` and
   `node tests/dashboard-core.test.cjs` must also stay green, plus
   `python3 -B -m unittest discover -s tests`.
