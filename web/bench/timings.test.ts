// Engine timings on the Python app's benchmark cases (its tools/bench.py), which web/README.md's
// Speed section sets beside the Python engine's own:
//
//     npm --prefix web run bench
//
// The Utoy example (128 watershed plans); Utoy with every alternative carried at every site (49,152
// plans, the report's "full factorial"); synthetic spaces of 65,536 and 117,649 plans (near IWR's
// 175,000-plan limit); and a 30-site space far beyond full enumeration (cost-effective candidates by
// Pareto merge). The projects are the goldens' copies, written by the same generator as the Python
// bench. Each time is the best of a few runs after one warm-up, as tools/bench.py takes it.
import { expect, it } from 'vitest'
import { analyze, wsBb, wsCe, wsPlans } from '../src/engine/analysis'
import { loads } from '../src/engine/projectfile'
import utoy from '../tests/fixtures/projects/utoy-creek.ceica?raw'
import full from '../tests/fixtures/projects/utoy-full-factorial.ceica?raw'
import s8x3 from '../tests/fixtures/projects/synthetic-8x3.ceica?raw'
import s6x6 from '../tests/fixtures/projects/synthetic-6x6.ceica?raw'
import s30x3 from '../tests/fixtures/projects/synthetic-30x3.ceica?raw'

const cases: [string, string, number][] = [
  ['Utoy example', utoy, 20],
  ['Utoy full factorial', full, 3],
  ['Synthetic 8 x 3', s8x3, 3],
  ['Synthetic 6 x 6', s6x6, 3],
  ['Synthetic 30 x 3 (CE)', s30x3, 1],
]

it('times the engine', () => {
  const lines: string[] = []
  for (const [name, text, repeat] of cases) {
    const project = loads(text).project
    let res = analyze(project)
    let best = Infinity
    for (let k = 0; k < repeat; k++) {
      const t0 = performance.now()
      res = analyze(project)
      best = Math.min(best, performance.now() - t0)
    }
    const ws = res.watershed
    lines.push(`${(name + ':').padEnd(24)} ${String(wsPlans(ws)).padStart(9)} plans  ${best.toFixed(1).padStart(8)} ms`
      + `  CE ${wsCe(ws)}, BB ${wsBb(ws)}`)
    expect(ws.ready).toBe(true)
  }
  console.info(lines.join('\n'))
})
