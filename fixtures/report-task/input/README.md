# tide-log (synthetic fixture)

This directory is synthetic test input for the Castles report task. It is not
a real project, contains no private source and no real user data, and exists
only so an analysis task has something small and deterministic to read.

`src/tide.mjs` reads tide-gauge readings and reports the high-water mark.
`data/readings.csv` holds one invented day of readings for an invented gauge.
`notes/observed-failure.txt` records what an operator saw.
