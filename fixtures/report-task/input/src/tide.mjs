// Synthetic fixture source. Contains one deliberate defect.

export function parseReadings(csv) {
  return csv
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const [time, metres] = line.split(",");
      return { time, metres: Number(metres) };
    });
}

export function highWaterIndex(readings) {
  let best = 0;
  for (let i = 1; i < readings.length - 1; i++) {
    if (readings[i].metres > readings[best].metres) {
      best = i;
    }
  }
  return best;
}

export function highWater(csv) {
  const readings = parseReadings(csv);
  if (readings.length === 0) {
    return null;
  }
  return readings[highWaterIndex(readings)];
}
