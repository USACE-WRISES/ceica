// Autosave in this browser (views/host.ts says where). The Shiny page kept it in localStorage
// (www/ceica.js: "ceica.autosave.<id>" and the index "ceica.autosave.index"); the web app keeps it
// in IndexedDB, database "ceica": each project's file by its id, and the Recent list (newest first,
// at most 10), written in one transaction. A project that falls off the list is deleted with it.
//
// Storage may be blocked or full (a private window, a managed browser): each call then answers as
// an empty store and the page goes on, as ceica.js's try/catch did; Save is the durable copy.

export interface Recent {
  id: string
  name: string
  at: string
}

const DB = 'ceica'
const PROJECTS = 'projects'
const META = 'meta'
const RECENT = 'recent'
const LIMIT = 10

let opened: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (!opened) {
    opened = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS)
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('the autosave store is blocked'))
    })
    opened.catch(() => {
      opened = null
    })
  }
  return opened
}

const done = (tx: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onerror = () => reject(tx.error)
  tx.onabort = () => reject(tx.error)
})

const result = <T>(req: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result)
  req.onerror = () => reject(req.error)
})

const isRecent = (x: unknown): x is Recent => typeof x === 'object' && x !== null && typeof (x as Recent).id === 'string'

/** The Recent list, newest first ([] when storage is unavailable). */
export async function recents(): Promise<Recent[]> {
  try {
    const db = await open()
    const list = await result(db.transaction(META, 'readonly').objectStore(META).get(RECENT))
    return Array.isArray(list) ? list.filter(isRecent) : []
  } catch {
    return []
  }
}

/** ce_autosave: the project's file kept, and the project put first in the Recent list; whether it
 * was kept. */
export async function save(id: string, name: string, at: string, json: string): Promise<boolean> {
  try {
    const db = await open()
    const tx = db.transaction([PROJECTS, META], 'readwrite')
    const meta = tx.objectStore(META)
    const projects = tx.objectStore(PROJECTS)
    projects.put(json, id)
    const list = await result(meta.get(RECENT))
    const old = Array.isArray(list) ? list.filter(isRecent) : []
    const next = [{ id, name, at }, ...old.filter((x) => x.id !== id)]
    meta.put(next.slice(0, LIMIT), RECENT)
    for (const gone of next.slice(LIMIT)) projects.delete(gone.id)
    await done(tx)
    return true
  } catch {
    // storage full or blocked: the download is the durable copy
    return false
  }
}

/** ce_restore: a kept project's file, or null when it is gone. */
export async function load(id: string): Promise<string | null> {
  try {
    const db = await open()
    const json = await result(db.transaction(PROJECTS, 'readonly').objectStore(PROJECTS).get(id))
    return typeof json === 'string' ? json : null
  } catch {
    return null
  }
}

/** ce_forget: the project's file deleted and the project taken off the Recent list. */
export async function forget(id: string): Promise<void> {
  try {
    const db = await open()
    const tx = db.transaction([PROJECTS, META], 'readwrite')
    tx.objectStore(PROJECTS).delete(id)
    const meta = tx.objectStore(META)
    const list = await result(meta.get(RECENT))
    const old = Array.isArray(list) ? list.filter(isRecent) : []
    meta.put(old.filter((x) => x.id !== id), RECENT)
    await done(tx)
  } catch {
    // nothing kept, or storage blocked
  }
}
