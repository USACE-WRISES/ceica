// Literal port of ecorest's CEfinder and BBfinder (test oracle only; ecorest 2.0.x, R doubles), from
// tests/oracles/ecorest_ceica.py.
//
// The Utoy R analysis used these. They agree with IWR Planning Suite II except on exact duplicate
// plans: CEfinder counts every plan with benefit >= and cost <= a plan's own, so two identical plans
// knock each other out, and BBfinder flags only the first of identical best-buy points.

export function cefinder(benefit: readonly number[], cost: readonly number[]): number[] {
  const n = benefit.length
  const ce = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    let k = 0
    for (let j = 0; j < n; j++) if (benefit[j] >= benefit[i] && cost[j] <= cost[i]) k++
    ce[i] = k === 1 ? 1 : 0
  }
  return ce
}

/** (BB flags per plan, best-buy table rows [benefit, cost, inccost]) */
export function bbfinder(benefit: readonly number[], cost: readonly number[],
  ce: readonly number[]): [number[], number[][]] {
  const b = benefit
  const c = cost
  const n = b.length
  const ceIdx = ce.flatMap((v, i) => (v === 1 ? [i] : []))
  let benCe = ceIdx.map((i) => b[i])
  let costCe = ceIdx.map((i) => c[i])
  let nCe = benCe.length
  const single = (idx: number): [number[], number[][]] => {
    const loc = new Array<number>(n).fill(0)
    loc[idx] = 1
    return [loc, [[b[idx], c[idx], 0]]]
  }
  if (nCe === 1) return single(ceIdx[0])
  const order = costCe.map((_, i) => i).sort((x, y) => costCe[x] - costCe[y])  // stable
  let ben2 = order.map((i) => benCe[i])
  let cost2 = order.map((i) => costCe[i])
  // duplicate benefit handling
  const seen = new Set<number>()
  const dup = ben2.map((x) => {
    const d = seen.has(x)
    seen.add(x)
    return d
  })
  const groupMin = ben2.map((x) => Math.min(...cost2.filter((_, k) => ben2[k] === x)))
  if (dup.some((d, k) => d && cost2[k] > groupMin[k])) {
    const keep = dup.map((d) => !d)
    ben2 = ben2.filter((_, k) => keep[k])
    cost2 = cost2.filter((_, k) => keep[k])
    nCe = ben2.length
  }
  if (nCe === 1) {
    const idx = b.findIndex((bi, i) => bi === ben2[0] && c[i] === cost2[0] && ce[i] === 1)
    return single(idx)
  }
  const bb = [1]  // 1-based positions into the cost-sorted cost-effective vectors
  for (let step = 0; step < nCe; step++) {
    const cur = bb[bb.length - 1]
    const inc: number[] = []
    for (let k = cur; k < nCe; k++) inc.push((cost2[k] - cost2[cur - 1]) / (ben2[k] - ben2[cur - 1]))
    const valid = inc.filter((v) => !Number.isNaN(v))
    const m = Math.min(...valid)
    const nxt = inc.findIndex((v) => v === m) + 1 + cur
    bb.push(nxt)
    if (nxt >= nCe) break
  }
  const benBb = bb.map((p) => ben2[p - 1])
  const costBb = bb.map((p) => cost2[p - 1])
  const loc = new Array<number>(n).fill(0)
  benBb.forEach((bi, k) => {
    loc[b.findIndex((x, i) => x === bi && c[i] === costBb[k])] = 1
  })
  const table = benBb.map((bi, k) => [bi, costBb[k],
    k === 0 ? 0 : (costBb[k] - costBb[k - 1]) / (benBb[k] - benBb[k - 1])])
  return [loc, table]
}
