// @vitest-environment happy-dom
// The page's side of an update (src/app/offline.ts): what it does with the controller's answer (reload
// at once with nothing open, else the notice; Reload to update saves first, then reloads, unless the
// project could not be kept), the notice's button, the project reopened after the reload (once), and
// persistent storage asked for after the first kept autosave.
import { afterEach, describe as group, expect, it, vi } from 'vitest'
import type { Client } from '../src/app/client'
import { decide, NOTICE_ID, otherDialogOpen, REOPEN_KEY, Updates } from '../src/app/offline'
import * as host from '../src/views/host'

afterEach(() => {
  document.body.innerHTML = ''
})

function fakeClient() {
  return { askReload: vi.fn(), restore: vi.fn(), warmFiles: vi.fn() }
}

function fakeSession(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(), key: () => null, get length() { return m.size },
  }
}

function updates(session: Storage | null = fakeSession()) {
  const client = fakeClient()
  const reload = vi.fn()
  const u = new Updates(client as unknown as Client, { reload, session: () => session })
  return { u, client, reload, session }
}

group('an update in the page', () => {
  it('decides from the controller\'s answer', () => {
    expect(decide({ id: null, save: false, kept: true }, false)).toBe('reload')
    expect(decide({ id: null, save: false, kept: true }, true)).toBe('notice')
    expect(decide({ id: 'p', save: false, kept: true }, false)).toBe('notice')
    expect(decide({ id: 'p', save: true, kept: true }, false)).toBe('reload')
    expect(decide({ id: 'p', save: true, kept: false }, false)).toBe('warn')
    expect(decide({ id: null, save: true, kept: false }, false)).toBe('reload')
  })

  it('tells the start page from another dialog', () => {
    expect(otherDialogOpen()).toBe(false)
    document.body.innerHTML = '<div id="shiny-modal"><div class="ce-start-rail"></div></div>'
    expect(otherDialogOpen()).toBe(false)
    document.body.innerHTML = '<div id="shiny-modal"><form></form></div>'
    expect(otherDialogOpen()).toBe(true)
  })

  it('reloads at once with nothing open, and asks the controller after a switch', () => {
    const { u, client, reload } = updates()
    u.switched()
    expect(client.askReload).toHaveBeenCalledWith(false)
    u.answer({ id: null, save: false, kept: true })
    expect(reload).toHaveBeenCalledTimes(1)
    u.switched()
    u.answer({ id: 'p', save: false, kept: true })
    expect(client.askReload).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('shows the notice with a project open, and its button saves and reloads', () => {
    const { u, client, reload, session } = updates()
    u.answer({ id: 'p1', save: false, kept: true })
    const notice = document.getElementById(`shiny-notification-${NOTICE_ID}`)!
    expect(notice.querySelector('.shiny-notification-content-text')!.textContent).toBe(host.UPDATE_READY)
    expect(client.warmFiles).toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    const button = notice.querySelector<HTMLButtonElement>('button[data-ceica-update]')!
    expect(button.textContent).toBe(host.UPDATE_ACTION)
    button.click()
    expect(client.askReload).toHaveBeenCalledWith(true)
    u.answer({ id: 'p1', save: true, kept: true })
    expect(session!.getItem(REOPEN_KEY)).toBe('p1')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('stays, with a warning, when the project could not be kept', () => {
    const { u, reload, session } = updates()
    u.answer({ id: 'p1', save: true, kept: false })
    expect(reload).not.toHaveBeenCalled()
    expect(session!.getItem(REOPEN_KEY)).toBeNull()
    expect(document.querySelector('.shiny-notification-warning .shiny-notification-content-text')!.textContent).toBe(host.UPDATE_NOT_KEPT)
  })

  it('reopens the project the reload left, once', () => {
    const { u, client, session } = updates()
    session!.setItem(REOPEN_KEY, 'p1')
    u.reopen()
    expect(client.restore).toHaveBeenCalledWith('p1')
    expect(session!.getItem(REOPEN_KEY)).toBeNull()
    u.reopen()
    expect(client.restore).toHaveBeenCalledTimes(1)
    // storage refused: nothing to reopen, nothing breaks
    expect(() => updates(null).u.reopen()).not.toThrow()
  })

  it('asks for persistent storage after the first kept autosave, once', async () => {
    const persisted = vi.fn(async () => false)
    const persist = vi.fn(async () => true)
    vi.stubGlobal('navigator', { ...navigator, storage: { persisted, persist } })
    try {
      const { u } = updates()
      u.kept(false)
      expect(persisted).not.toHaveBeenCalled()
      u.kept(true)
      u.kept(true)
      await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
      expect(persisted).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
