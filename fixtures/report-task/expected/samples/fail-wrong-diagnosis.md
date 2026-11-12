<!-- Synthetic sample, hand-written. Not model output. Names the right file and
function and repeats the right numbers, but the diagnosis is wrong. -->
## Summary

The observed result is right and the operator note is mistaken.

## Findings

There is no defect in `src/tide.mjs`. The function `highWaterIndex` is correct:
its loop bound `readings.length - 1` is the right bound for this data. The
14:00 reading of 4.31 m is a data-entry error in the gauge sheet, so the value
that should have been reported is 08:00, 3.92 m.

## Evidence

- `src/tide.mjs`: the `for` loop in `highWaterIndex`.
- `data/readings.csv`: the row `14:00,4.31`.
- `notes/observed-failure.txt`: observed 08:00 3.92 m, expected 14:00 4.31 m.

## Limitations

Only the one supplied day was examined. The code was read, not executed.
