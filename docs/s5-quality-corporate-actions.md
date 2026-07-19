# S5 — Quality checks and explicit corporate actions

S5 uses offline fixtures only. The admitted corporate-action convention is
`price_multiplier_after_ex_date`: for an action visible at `as_of`, multiply
prices strictly before its `ex_date` by its `factor`; prices on or after the
ex-date are unchanged. A factor convention not explicitly declared by the
fixture is unadmitted and cannot be used for adjusted prices.

S5 keeps `close_raw`, `adjustment_factor`, and `adjusted_close` separate. It
does not silently rewrite OHLCV. Cash amounts and action metadata remain
explicit records even when the price factor is applied.

The quality report checks canonical validation, provenance, duplicate/revision
semantics, monotonic dates, fundamental unit/currency consistency, and source
conflicts. Any conflict or ambiguous factor semantics fails closed.
