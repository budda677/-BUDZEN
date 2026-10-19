// Проверка согласованности: стрелка vs выигрышная дуга.
// Повторяет геометрию из App.tsx.

function arcRange(chance) {
  const span = chance * 3.6
  const center = 90
  // диапазон углов дуги в SVG-координатах (0=вправо, по часовой)
  return { start: center - span / 2, end: center + span / 2 }
}

// нормализуем угол в [0,360)
const norm = (a) => ((a % 360) + 360) % 360

function inArc(angleSvg, chance) {
  const { start, end } = arcRange(chance)
  // дуга не пересекает 0 (center=90, span<=288 для chance<=80) => простая проверка
  const a = norm(angleSvg)
  if (start >= 0 && end <= 360) return a >= start && a <= end
  // если переходит через 0
  return a >= norm(start) || a <= norm(end)
}

function computeUpgradeRotation(won, chance, turns) {
  const winHalf = (chance * 3.6) / 2
  const freeHalf = (360 - chance * 3.6) / 2
  let baseRotation
  if (won) {
    const safeHalf = Math.max(0, winHalf * 0.82)
    baseRotation = (Math.random() * 2 - 1) * safeHalf
  } else {
    const safeHalf = Math.max(0, freeHalf * 0.82)
    baseRotation = 180 + (Math.random() * 2 - 1) * safeHalf
  }
  return turns * 360 + baseRotation
}

// Стрелка смотрит вниз при 0 (SVG угол 90). Поворот rotate(r) по часовой => угол = 90 + r
const pointerSvgAngle = (rotation) => norm(90 + rotation)

let fail = 0, total = 0
for (const chance of [10, 25, 50, 75, 80]) {
  for (const won of [true, false]) {
    for (let i = 0; i < 2000; i++) {
      const turns = 3 + Math.floor(Math.random() * 3)
      const rot = computeUpgradeRotation(won, chance, turns)
      const angle = pointerSvgAngle(rot)
      const inside = inArc(angle, chance)
      total++
      if (inside !== won) {
        fail++
        if (fail <= 10) console.log(`MISMATCH chance=${chance} won=${won} angle=${angle.toFixed(1)} inside=${inside} start/end=${JSON.stringify(arcRange(chance))}`)
      }
    }
  }
}
console.log(`\n${total} tests, ${fail} mismatches`)
