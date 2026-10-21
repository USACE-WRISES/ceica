// The order CPython 3.12 (64-bit) iterates a set of tuples of ints in. openpyxl keeps a sheet's merged
// cells in a set of CellRanges, each hashed as its bounds' tuple, and writes them in the set's order, so
// a workbook's <mergeCells> list follows it.
//
// Ported from CPython's Objects/tupleobject.c (tuplehash: xxHash's lanes) and Objects/setobject.c
// (set_add_entry: linear probes then perturbation; set_table_resize when fill * 5 >= mask * 3). Hashes
// are 64-bit, unsigned as the table indexes them, in BigInt.

const M64 = (1n << 64n) - 1n
const P1 = 11400714785074694791n
const P2 = 14029467366897019727n
const P5 = 2870177450012600261n
/** sys.hash_info.modulus: 2**61 - 1 */
const MODULUS = (1n << 61n) - 1n
const LINEAR_PROBES = 9
const PERTURB_SHIFT = 5n
const MINSIZE = 8

const rotl31 = (x: bigint): bigint => ((x << 31n) | (x >> 33n)) & M64

/** hash(n) of an int, as the unsigned 64-bit value a table indexes by. */
export function intHash(n: number | bigint): bigint {
  const v = BigInt(n)
  let h = (v < 0n ? -v : v) % MODULUS
  if (v < 0n) h = -h
  if (h === -1n) h = -2n
  return BigInt.asUintN(64, h)
}

/** hash(t) of a tuple of ints. */
export function tupleHash(items: readonly (number | bigint)[]): bigint {
  let acc = P5
  for (const item of items) {
    const lane = intHash(item)
    acc = (acc + lane * P2) & M64
    acc = rotl31(acc)
    acc = (acc * P1) & M64
  }
  acc = (acc + (BigInt(items.length) ^ (P5 ^ 3527539n))) & M64
  return acc === M64 ? 1546275796n : acc
}

interface Slot<T> { key: T, hash: bigint }

/** A CPython set of keys with their hashes (no removals: openpyxl only adds merged ranges). */
export class PySet<T> {
  private table: (Slot<T> | null)[] = new Array(MINSIZE).fill(null)
  private fill = 0

  constructor(private readonly hashOf: (key: T) => bigint, private readonly same: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.fill
  }

  /** set.add(key) */
  add(key: T): void {
    const hash = this.hashOf(key)
    const mask = this.table.length - 1
    const bmask = BigInt(mask)
    let i = Number(hash & bmask)
    let perturb = hash
    for (;;) {
      let probes = i + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0
      let j = i
      do {
        const slot = this.table[j]
        if (slot === null) {
          this.table[j] = { key, hash }
          this.fill++
          if (this.fill * 5 >= mask * 3) this.resize(this.fill > 50000 ? this.fill * 2 : this.fill * 4)
          return
        }
        if (slot.hash === hash && this.same(slot.key, key)) return
        j++
      } while (probes-- > 0)
      perturb >>= PERTURB_SHIFT
      i = Number((BigInt(i) * 5n + 1n + perturb) & bmask)
    }
  }

  private resize(minused: number): void {
    let size = MINSIZE
    while (size <= minused) size <<= 1
    const old = this.table
    this.table = new Array(size).fill(null)
    const mask = size - 1
    const bmask = BigInt(mask)
    for (const slot of old) {
      if (slot === null) continue
      // set_insert_clean
      let i = Number(slot.hash & bmask)
      let perturb = slot.hash
      for (;;) {
        if (this.table[i] === null) break
        let found = -1
        if (i + LINEAR_PROBES <= mask) {
          for (let k = 1; k <= LINEAR_PROBES; k++) {
            if (this.table[i + k] === null) {
              found = i + k
              break
            }
          }
        }
        if (found >= 0) {
          i = found
          break
        }
        perturb >>= PERTURB_SHIFT
        i = Number((BigInt(i) * 5n + 1n + perturb) & bmask)
      }
      this.table[i] = slot
    }
  }

  /** iter(set): the keys in table order */
  *[Symbol.iterator](): IterableIterator<T> {
    for (const slot of this.table) if (slot !== null) yield slot.key
  }
}

/** A set of tuples of ints, in CPython's order: the tuples iterated as the set holds them. */
export function tupleSetOrder(tuples: readonly (readonly number[])[]): number[][] {
  const set = new PySet<readonly number[]>(tupleHash, (a, b) => a.length === b.length && a.every((x, k) => x === b[k]))
  for (const t of tuples) set.add(t)
  return [...set].map((t) => [...t])
}
