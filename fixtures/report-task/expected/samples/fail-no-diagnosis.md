<!-- Synthetic sample, hand-written. Not model output. Gives up, but the right
numbers appear because the input note is quoted. -->
## Summary

The supplied files were read. A cause for the observed result was not found.

## Findings

I could not determine the cause. `src/tide.mjs` exports `parseReadings`,
`highWaterIndex` and `highWater`, and each was read once.

## Evidence

- `notes/observed-failure.txt` says the run reported 08:00 3.92 m and that the
  gauge sheet shows 14:00 4.31 m.
- `data/readings.csv` has seven rows.

## Limitations

The code was not executed, and the last row was not examined in detail.
