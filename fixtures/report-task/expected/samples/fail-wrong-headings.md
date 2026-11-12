<!-- Synthetic sample, hand-written. Not model output. Must fail RP-04. -->
## Summary

`highWater()` reports 08:00 at 3.92 m, but the high-water mark is 14:00, 4.31 m.

## Findings

The defect is in `src/tide.mjs`, function `highWaterIndex`: the loop bound
`readings.length - 1` skips the last reading. The correct value is 14:00,
4.31 m.

## Recommendations

Change the loop bound so the final reading is compared.

## Evidence

- `data/readings.csv`: the final row `14:00,4.31` is the maximum.
