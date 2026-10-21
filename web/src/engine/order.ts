// Plan order: indices sorted by (output, cost, index), the order numpy's stable lexsort gives
// ceica/cea.py, ceica/plans.py and ceica/analysis.py.
//
// Outputs and costs are whole numbers (numeric.ts), so the two keys usually pack into one exact key,
// and a stable radix sort orders a hundred thousand plans in a few milliseconds; equal keys keep
// their index order, as the stable lexsort does. When the packed key would pass 2**52 the sort
// compares instead, with the same result.

const RADIX = 65536

/** Indices of ``keys`` (whole numbers, 0 <= key < 2**52) in ascending key order, ties by index. */
function radixOrder(keys: Float64Array, idx: Int32Array): Int32Array {
  let src: Int32Array = idx
  let dst: Int32Array = new Int32Array(src.length)
  let max = 0
  for (let k = 0; k < src.length; k++) if (keys[src[k]] > max) max = keys[src[k]]
  const count = new Int32Array(RADIX)
  for (let div = 1; div <= max; div *= RADIX) {
    count.fill(0)
    for (let k = 0; k < src.length; k++) count[Math.floor(keys[src[k]] / div) % RADIX]++
    let pos = 0
    for (let d = 0; d < RADIX; d++) {
      const n = count[d]
      count[d] = pos
      pos += n
    }
    for (let k = 0; k < src.length; k++) {
      const i = src[k]
      dst[count[Math.floor(keys[i] / div) % RADIX]++] = i
    }
    const t = src
    src = dst
    dst = t
  }
  return src
}

/** The indices ``which`` (default: all) sorted by output (descending when ``outputDesc``), then
 * cost ascending, then index. */
export function orderByOutputCost(output: Float64Array, cost: Float64Array, outputDesc: boolean,
  which: ArrayLike<number> | null = null): Int32Array {
  const idx = which === null ? Int32Array.from({ length: output.length }, (_, i) => i) : Int32Array.from(which)
  if (idx.length < 2) return idx
  let qmin = Infinity
  let qmax = -Infinity
  let cmin = Infinity
  let cmax = -Infinity
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k]
    if (output[i] < qmin) qmin = output[i]
    if (output[i] > qmax) qmax = output[i]
    if (cost[i] < cmin) cmin = cost[i]
    if (cost[i] > cmax) cmax = cost[i]
  }
  const spanC = cmax - cmin + 1
  // a radix pass touches every bucket, so short lists sort faster by comparing
  if ((qmax - qmin + 1) * spanC > 2 ** 52 || idx.length < 8192) {
    const sign = outputDesc ? -1 : 1
    return idx.sort((a, b) => (sign * (output[a] - output[b])) || (cost[a] - cost[b]) || (a - b))
  }
  const keys = new Float64Array(output.length)
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k]
    keys[i] = (outputDesc ? qmax - output[i] : output[i] - qmin) * spanC + (cost[i] - cmin)
  }
  // the indices in ascending order first, so equal keys keep their index order
  idx.sort()
  return radixOrder(keys, idx)
}
