// CEICA's server: app.py's server(input, output, session), ported line by line onto the reactive core
// (reactive.ts) and a py-shiny session (session.ts).
//
// The same state (the project and its undo history; where the person is: page, section, site, the
// plans view and the grid options; the start page's view and the Recent list; dirty and saved for
// autosave), the same one event channel (ce_event, www/ceica.js), the same effects and outputs made
// in the same order, so the messages come out in the same order. web/parity/make_traces.py records
// what app.py's real server sends for scripted client messages; tests/server.test.ts holds this
// port to every trace.
//
// What the Shiny server reads from disk or a session route comes in through ServerOptions: the
// bundled examples, an opened file's bytes, the day, and the address the Report page's links use.
import { analyze, type AnalysisResults } from '../engine/analysis'
import { History } from '../engine/history'
import {
  type BenefitSpec, defaultLabels, dumpProject, modelEquals, moduleOf, parseLabels, parseModule, parseProject, type Project,
  noAction, siteOf, type Module,
} from '../engine/model'
import * as staf from '../engine/benefits/staf'
import { canonicalJson, dumps, loads, ProjectFileError } from '../engine/projectfile'
import { fileStem, isoDay, resolve } from '../engine/report/files'
import { readWorkbook, WorkbookError } from '../engine/workbook/importer'
import { buildTemplate } from '../engine/workbook/template'
import { derive } from '../engine/runState'
import { importMapping, readStafFile, type StafImport, StafImportError } from '../engine/stafImport'
import { APP_NAME } from '../engine/version'
import { pyFixed, pyFixedComma, pyFloat } from '../py/pyfmt'
import { parseJson } from '../py/pyjson'
import { pyFloatText, PyValueError, pyStrip, pyStrRepr } from '../py/pystr'
import { h, type Tag } from '../shiny/htm'
import {
  inputActionButton, inputNumeric, inputRadioButtons, inputSelect, inputText, layoutColumns, modal, modalButton, outputUi,
} from '../shiny/shinyui'
import * as cells from '../views/cells'
import { ev } from '../views/components'
import * as edits from '../views/edits'
import * as examples from '../views/examples'
import { benefitsGrid, costsGrid, type GridOpts, pickModule, recurringGrid, sitesGrid, stafGrid, VIEWS } from '../views/grids'
import * as host from '../views/host'
import { methodChoice, inputsPage, moduleDialog } from '../views/inputsPage'
import { reportPage, settingsDialog } from '../views/reportPage'
import {
  aboutHtml, helpHtml, historyTools, panel, type Recent, START_VIEWS, stagebar as stagebarHtml, startPage, whatsNewHtml,
} from '../views/shell'
import { sitesPage } from '../views/sites'
import { watershedPage } from '../views/watershed'
import { Calc, Effect, event, invalidateLater, isolate, SilentException, Value } from './reactive'
import type { Session } from './session'

export const AUTOSAVE_QUIET_S = 2.5

/** Clipboard text from Excel as rows of cells (tab separated, one row per line). */
export function pasteBlock(text: string): string[][] {
  const lines = text.replace(/\r/g, '').replace(/\n+$/, '').split('\n')
  return lines.map((line) => line.split('\t'))
}

/** Cell paths of a grid in display order (for pasting a block). */
export function gridMatrix(res: AnalysisResults | null, grid: string, opts: GridOpts): (string | null)[][] {
  if (res === null) return []
  if (grid === 'benefits' || grid === 'staf') {
    const [mod, view] = pickModule(res.project, opts)
    if (mod === null) return []
    if (grid === 'staf') return stafGrid(res, mod.id, opts.staf_site ?? null, opts.staf_alt ?? null)[1]
    return benefitsGrid(res, mod.id, view)[1]
  }
  if (grid === 'costs') return costsGrid(res)[1]
  if (grid === 'omrrr') return recurringGrid(res)[1]
  if (grid === 'sites') return sitesGrid(res)[1]
  return []
}

/** The first module of a new project, by method: its name and quantity units. */
export const FIRST_MODULE: Readonly<Record<string, [string, string]>> = {
  HU: ['Habitat', ''], INDEX_X_QUANTITY: ['Habitat', 'acres'], STAF: ['Stream condition', 'mi'], AAHU: ['Habitat', ''],
}

/** Python's KeyError, as str() writes it: the key's repr. */
export class KeyError extends Error {
  constructor(key: string) {
    super(pyStrRepr(key))
    this.name = 'KeyError'
  }
}

/** The blank project a template is made from (app.py's _template). */
export function templateProject(mode: string): Project {
  const m = firstModule(mode)
  return parseProject({ name: 'New study', labels: labelsDoc(defaultLabels(mode)),
    benefits: { modules: [{ id: m.id, name: m.name, method: m.method, quantity_units: m.quantity_units }] } })
}

export function firstModule(method: string): Module {
  if (!(method in FIRST_MODULE)) throw new KeyError(method)
  const [name, units] = FIRST_MODULE[method]
  return parseModule({ id: 'M1', name, method, quantity_units: units })
}

// --- pydantic's ValidationError text (the New project dialog shows it whole) ---------------------

interface PydanticError { loc: string, msg: string, type: string, input: string, inputType: string }

/** repr() as pydantic writes an input value: shortened past 50 characters. */
function inputRepr(text: string): string {
  return text.length > 50 ? text.slice(0, 25) + '...' + text.slice(-24) : text
}

/** str(ValidationError): the count line, then each error with its type, input and link. */
export function validationText(model: string, errors: PydanticError[]): string {
  const lines = [`${errors.length} validation error${errors.length === 1 ? '' : 's'} for ${model}`]
  for (const e of errors) {
    lines.push(e.loc, `  ${e.msg} [type=${e.type}, input_value=${inputRepr(e.input)}, input_type=${e.inputType}]`,
      `    For further information visit https://errors.pydantic.dev/2.13/v/${e.type}`)
  }
  return lines.join('\n')
}

const tupleRepr = (xs: readonly number[]): string => (xs.length === 1 ? `(${pyFloat(xs[0])},)` : `(${xs.map(pyFloat).join(', ')})`)
const intRepr = (n: number): string => (Math.abs(n) < 1e21 ? String(n + 0) : BigInt(n).toString())

/** BenefitSpec(target_years=years, modules=(module,)): its validator's refusals. */
function benefitSpec(years: readonly number[], module: Module): BenefitSpec {
  let msg: string | null = null
  if (years.length < 2) msg = 'at least two target years are needed'
  else if (years.slice(1).some((b, i) => b <= years[i])) msg = 'target years must increase'
  if (msg !== null) {
    throw new Error(validationText('BenefitSpec', [{ loc: 'target_years', msg: `Value error, ${msg}`, type: 'value_error',
      input: tupleRepr(years), inputType: 'tuple' }]))
  }
  return { target_years: [...years], modules: [module], staf_mapping: 'A' }
}

/** Settings(discount_rate=rate, period_of_analysis=poa): pydantic's bounds, every refusal together
 * (le before ge, so NaN reads as above the top). */
function checkSettings(rate: number, poa: number): void {
  const errors: PydanticError[] = []
  if (!(rate <= 0.25)) errors.push({ loc: 'discount_rate', msg: 'Input should be less than or equal to 0.25', type: 'less_than_equal', input: pyFloat(rate), inputType: 'float' })
  else if (!(rate >= 0)) errors.push({ loc: 'discount_rate', msg: 'Input should be greater than or equal to 0', type: 'greater_than_equal', input: pyFloat(rate), inputType: 'float' })
  if (!(poa <= 200)) errors.push({ loc: 'period_of_analysis', msg: 'Input should be less than or equal to 200', type: 'less_than_equal', input: intRepr(poa), inputType: 'int' })
  else if (!(poa >= 1)) errors.push({ loc: 'period_of_analysis', msg: 'Input should be greater than or equal to 1', type: 'greater_than_equal', input: intRepr(poa), inputType: 'int' })
  if (errors.length) throw new Error(validationText('Settings', errors))
}

/** Python's truthiness for a value from the browser's JSON. */
const truthy = (v: unknown): boolean => !(v === null || v === undefined || v === false || v === 0 || v === '' || (Array.isArray(v) && !v.length)
  || (typeof v === 'object' && v !== null && !Array.isArray(v) && !Object.keys(v).length))

/** What a click or change posted (www/ceica.js): its type and data-* values. */
type CeEvent = Record<string, unknown>

/** e[key]: Python's KeyError when the event lacks it. */
function need(e: CeEvent, key: string): string {
  if (!(key in e)) throw new KeyError(key)
  return e[key] as string
}

/** int(text): Python's int() of a str or a number. */
function pyInt(v: unknown): number {
  if (typeof v === 'number') return Math.trunc(v) + 0
  const s = pyStrip(String(v))
  if (!/^[+-]?\d+(_\d+)*$/.test(s)) throw new PyValueError(`invalid literal for int() with base 10: ${pyStrRepr(String(v))}`)
  return Number(s.replace(/_/g, ''))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n: number): string => String(n).padStart(2, '0')
/** strftime('%H:%M') */
export const clockText = (d: Date): string => `${two(d.getHours())}:${two(d.getMinutes())}`
/** strftime('%b %d, %H:%M') */
export const stampText = (d: Date): string => `${MONTHS[d.getMonth()]} ${two(d.getDate())}, ${clockText(d)}`

export interface ServerOptions {
  /** date.today() */
  today(): Date
  /** The address of the Report page's files (Shiny: the session's dynamic route). */
  filesUrl: string
  /** An uploaded file's bytes, by the datapath the browser reported. */
  readUpload(datapath: string): Uint8Array
  /** A bundled example's file, or null. */
  exampleText(name: string): string | null
  /** savedAt for the autosave and Save files (the clock's UTC time when left out). */
  savedAt?(): string
}

/** app.py's server(input, output, session). */
export function ceicaServer(opts: ServerOptions): (session: Session) => void {
  return (session) => {
    const clock = session.clock
    const input = <T = unknown>(id: string): T => session.input<T>(id).get()
    const project = new Value<Project | null>(null)
    const page = new Value<string>('sites')
    const section = new Value<string>('study')
    const site = new Value<string | null>(null)
    const plansView = new Value<string>('bb')
    const inputsOpts = new Value<GridOpts>({}, 'fresh')
    const hist = new History()
    const histRev = new Value<number>(0)
    const recents = new Value<Recent[]>([], 'fresh')
    // the start page's view (views.shell.START_VIEWS) and the example picked in its gallery
    const startView = new Value<string>('home')
    const startPicked = new Value<string | null>(null)
    const lastChange = new Value<number>(0.0)
    const dirty = new Value<boolean>(false)
    const savedNote = new Value<string>('')

    const results = new Calc<AnalysisResults | null>(() => {
      const p = project.get()
      return p !== null ? analyze(p) : null
    })
    const statuses = new Calc(() => derive(results.get()))

    // --- project changes ---------------------------------------------------------------------
    const snap = (p: Project): string => canonicalJson(dumpProject(p))

    function commit(nw: Project, label: string, key: string | null = null): void {
      const old = isolate(() => project.get())
      if (old !== null && modelEquals(nw, old)) return
      hist.record(label, snap(nw), { key, now: clock.monotonic() })
      project.set(nw)
      histRev.set(histRev.get() + 1)
      lastChange.set(clock.monotonic(), 'float')
      dirty.set(true)
    }

    function openProject(p: Project, where: string, landing: string | null = null): void {
      hist.baseline(snap(p))
      histRev.set(histRev.get() + 1)
      project.set(p)
      site.set(p.sites.length ? p.sites[0].id : null)
      page.set(landing || (p.sites.length ? 'sites' : 'inputs'), 'literal')
      section.set('study', 'literal')
      inputsOpts.set({})
      dirty.set(true)
      lastChange.set(clock.monotonic(), 'float')
      session.updateNavset('page', page.get())
      session.modalRemove()
      session.notificationShow(`Opened ${p.name} (${where}).`, { type: 'message', duration: 4 })
    }

    // --- navigation state mirrors the hidden navset --------------------------------------------
    new Effect(event([() => page.get()], () => {
      session.updateNavset('page', page.get())
    }))

    /** Scroll to and focus the cell at ``path`` once it is on the page (a new row). */
    const focusCell = (path: string): void => session.sendCustomMessage('ce_focus', { path })

    // --- the one event channel -----------------------------------------------------------------
    new Effect(event([() => input('ce_event')], () => {
      const raw = input<CeEvent | null>('ce_event')
      const e: CeEvent = truthy(raw) ? raw! : {}
      const t = e.type
      const [p, res] = isolate(() => [project.get(), results.get()] as const)
      const str = (k: string, d = ''): string => (e[k] !== undefined ? e[k] as string : d)
      try {
        if (t === 'nav') {
          const target = (truthy(e.page) ? e.page : 'sites') as string
          let moved = page.get() !== target
          if (truthy(e.section)) {
            moved = moved || section.get() !== e.section
            section.set(e.section as string)
          }
          if (truthy(e.site)) site.set(e.site as string)
          if (truthy(e.toast)) session.notificationRemove(e.toast as string)
          if (page.get() !== target) page.set(target, truthy(e.page) ? 'fresh' : 'literal')
          if (truthy(e.anchor)) {
            // after the page renders again, or now when nothing will re-render
            session.sendCustomMessage('ce_scroll_to', { id: e.anchor, output: `page_${target}`, block: 'start', now: !moved })
          } else if (moved) {
            session.sendCustomMessage('ce_scroll_top', {})
          }
          return
        }
        if (t === 'site' || t === 'site_select') {
          const sid = truthy(e.site) ? e.site : e.value
          if (truthy(sid)) {
            site.set(sid as string)
            session.sendCustomMessage('ce_scroll_top', {})
          }
          return
        }
        if (t === 'plans_view') {
          plansView.set((truthy(e.value) ? e.value : 'bb') as string, truthy(e.value) ? 'fresh' : 'literal')
          return
        }
        if (t === 'grid_opt') {
          const o: Record<string, string | null | undefined> = { ...inputsOpts.get() }
          const name = str('name')
          o[name] = (e.value ?? null) as string | null
          if (e.name === 'staf_site') delete o.staf_alt
          inputsOpts.set(o)
          return
        }
        if (t === 'start') {
          showStart()
          return
        }
        if (t === 'start_view') {
          const valid = (START_VIEWS as readonly unknown[]).includes(e.view)
          startView.set(valid ? e.view as string : 'home', valid ? 'fresh' : 'literal')
          return
        }
        if (t === 'start_pick') {
          if (examples.example(e.name as string) !== null) startPicked.set(need(e, 'name'))
          return
        }
        if (t === 'about') {
          session.modalShow(modal([aboutHtml()], { title: `About ${APP_NAME}`, easyClose: true, footer: modalButton('Close') }))
          return
        }
        if (t === 'help') {
          session.modalShow(modal([helpHtml()], { title: 'Help', easyClose: true, footer: modalButton('Close'), size: 'l' }))
          return
        }
        if (t === 'whatsnew') {
          session.modalShow(modal([whatsNewHtml()], { title: "What's new", easyClose: true, footer: modalButton('Close') }))
          return
        }
        if (t === 'example') {
          const name = str('name')
          const text = examples.example(name) !== null ? opts.exampleText(name) : null
          if (text === null) {
            session.notificationShow('That example is not available yet.', { type: 'warning' })
            return
          }
          openProject(loads(text).project, 'example')
          return
        }
        if (t === 'restore') {
          session.sendCustomMessage('ce_restore', { id: str('id') })
          return
        }
        if (t === 'forget') {
          session.sendCustomMessage('ce_forget', { id: str('id') })
          return
        }
        if (t === 'new_project') {
          showNewProject()
          return
        }
        if (t === 'undo' || t === 'redo') {
          const step = t === 'undo' ? hist.undo() : hist.redo()
          if (step === null) return
          const [label, text] = step
          project.set(parseProject(parseJson(text)))
          histRev.set(histRev.get() + 1)
          dirty.set(true)
          lastChange.set(clock.monotonic(), 'float')
          session.notificationShow(`${t === 'undo' ? 'Undid' : 'Redid'}: ${label}.`, { duration: 2 })
          return
        }
        if (p === null) return
        const r = res!
        switch (t) {
          case 'recommend':
            commit(edits.recommend(p, r, need(e, 'site'), need(e, 'alt')), `recommend ${need(e, 'alt')} at ${need(e, 'site')}`)
            break
          case 'keep_rec':
            commit(edits.keepRecommendation(p, r, need(e, 'site')), 'keep a recommendation')
            break
          case 'alt_note':
            commit(edits.altNote(p, need(e, 'site'), need(e, 'alt'), str('value')), 'edit a decision note', `note:${need(e, 'site')}:${need(e, 'alt')}`)
            break
          case 'site_rationale':
            commit(edits.siteRationale(p, need(e, 'site'), str('value')), 'edit a site rationale', `rat:${need(e, 'site')}`)
            break
          case 'final':
            commit(edits.setFinal(p, r, need(e, 'key'), truthy(e.value)), 'change the final array')
            break
          case 'final_note':
            commit(edits.finalNote(p, r, need(e, 'key'), str('value')), 'edit a final array note', `fnote:${need(e, 'key')}`)
            break
          case 'worth':
            commit(edits.stepWorth(p, need(e, 'step'), str('value')), 'answer a step')
            break
          case 'why':
            commit(edits.stepWhy(p, need(e, 'step'), str('value')), 'edit a step note', `why:${need(e, 'step')}`)
            break
          case 'tsp':
            commit(edits.setTsp(p, r, need(e, 'key')), 'choose the TSP')
            break
          case 'keep_tsp':
            commit(edits.keepTsp(p, r), 'keep the TSP')
            break
          case 'tsp_type':
            commit(edits.tspText(p, 'tsp_plan_type', str('value')), 'edit the plan type')
            break
          case 'tsp_rationale':
            commit(edits.tspText(p, 'tsp_rationale', str('value')), 'edit the TSP rationale', 'tsp_rationale')
            break
          case 'ws_mode':
            commit(edits.watershedMode(p, r, str('value')), 'change plan formation')
            break
          case 'carry':
            commit(edits.carry(p, need(e, 'site'), need(e, 'alt'), truthy(e.value), r.watershed.carried.get(need(e, 'site')) ?? []),
              'change what a site carries')
            break
          case 'rule_add':
            commit(edits.addRule(p, need(e, 'site'), need(e, 'kind'), need(e, 'other')), 'add a rule')
            break
          case 'rule_remove':
            commit(edits.removeRule(p, pyInt(need(e, 'index'))), 'remove a rule')
            break
          case 'study': {
            const fld = need(e, 'field')
            const nw = edits.studyField(p, fld, str('value'))
            commit(nw, `edit ${edits.STUDY_FIELDS[fld] ?? fld}`, `study:${fld}`)
            break
          }
          case 'cell': {
            const path = str('path')
            if (path.startsWith('id|')) {
              const bits = path.split('|')
              if (bits.length === 2) commit(edits.renameSite(p, r, bits[1], str('value')), 'rename a site')
              else commit(edits.renameAlternative(p, r, bits[1], bits[2], str('value')), 'rename an alternative')
            } else {
              commit(cells.apply(p, path, str('value')), 'edit a value', `cell:${path}`)
            }
            break
          }
          case 'paste': {
            const matrix = gridMatrix(r, str('grid'), inputsOpts.get())
            const block = pasteBlock(e.text === null ? 'None' : String(e.text ?? ''))
            const [nw, n] = cells.applyBlock(p, matrix, pyInt(need(e, 'r')), pyInt(need(e, 'c')), block)
            if (n) {
              commit(nw, `paste ${n} cells`)
              session.notificationShow(`Pasted ${n} cells.`, { duration: 2 })
            }
            break
          }
          case 'add_site': {
            const nw = edits.addSite(p)
            commit(nw, 'add a site')
            focusCell(`t|${nw.sites[nw.sites.length - 1].id}|name`)
            break
          }
          case 'add_alt': {
            const nw = edits.addAlternative(p, need(e, 'site'))
            commit(nw, 'add an alternative')
            const alts = siteOf(nw, need(e, 'site'))!.alternatives
            focusCell(`t|${need(e, 'site')}|${alts[alts.length - 1].id}|name`)
            break
          }
          case 'remove_site':
            commit(edits.removeSite(p, need(e, 'site')), 'remove a site')
            break
          case 'remove_alt':
            commit(edits.removeAlternative(p, need(e, 'site'), need(e, 'alt')), 'remove an alternative')
            break
          case 'add_item': {
            const nw = edits.addItem(p, need(e, 'site'), need(e, 'alt'))
            commit(nw, 'add an OMRRR item')
            const alt = siteOf(nw, need(e, 'site'))!.alternatives.find((a) => a.id === need(e, 'alt'))!
            focusCell(`r|${need(e, 'site')}|${need(e, 'alt')}|${alt.costs.recurring[alt.costs.recurring.length - 1].id}|name`)
            break
          }
          case 'remove_item':
            commit(edits.removeItem(p, need(e, 'site'), need(e, 'alt'), need(e, 'item')), 'remove an OMRRR item')
            break
          case 'copy_items':
            commit(edits.copyItemsToSite(p, need(e, 'site'), need(e, 'alt')), 'copy OMRRR items')
            break
          case 'staf_assessed':
            commit(edits.stafAssessed(p, need(e, 'site'), need(e, 'fn'), truthy(e.value), truthy(e.module) ? e.module as string : null),
              'change the functions assessed')
            break
          case 'staf_fill':
            commit(edits.stafFill(p, need(e, 'site'), need(e, 'alt'), truthy(e.module) ? e.module as string : null), 'start from existing condition')
            break
          case 'module_add':
            showModuleDialog(p, null)
            break
          case 'module_edit':
            showModuleDialog(p, (e.module ?? null) as string | null)
            break
          case 'module_remove': {
            const mid = str('module')
            const nw = edits.removeModule(p, mid)
            const name = moduleOf(p.benefits, mid)!.name
            commit(nw, `remove the module ${name}`)
            if (inputsOpts.get().module === mid) {
              inputsOpts.set(Object.fromEntries(Object.entries(inputsOpts.get()).filter(([k]) => k !== 'module' && k !== 'view')))
            }
            session.notificationShow(`Removed ${name} and its values. Undo brings them back.`, { id: 'module-removed', duration: 6 })
            session.sendCustomMessage('ce_scroll_to', { id: 'study-modules', output: 'page_inputs', block: 'nearest' })
            break
          }
          case 'report_field':
            commit(edits.reportField(p, r, need(e, 'field'), str('value')), 'edit the report settings', `rep:${need(e, 'field')}`)
            break
          case 'report_settings':
            session.modalShow(settingsDialog(r, opts.today()))
            break
        }
      } catch (exc) {
        if (exc instanceof edits.EditError || exc instanceof cells.CellError) {
          session.notificationShow(exc.message, { type: 'warning', duration: 5 })
          // the project did not change, so nothing re-renders: put the cell back
          if (t === 'cell') session.sendCustomMessage('ce_cell_error', { path: str('path'), message: exc.message })
        } else {
          // never let one event close the session (Python's SilentException is an Exception too)
          session.notificationShow(`Could not apply that change: ${errorText(exc)}`, { type: 'error', duration: 8 })
        }
      }
    }))

    // --- start page, new project -----------------------------------------------------------------
    function showStart(): void {
      // each opening starts on the home view
      startView.set('home', 'literal')
      startPicked.set(null)
      session.modalShow(modal([outputUi('start_body')], { title: null, easyClose: project.get() !== null, footer: null, size: 'xl' }))
    }

    session.outputUi('start_body', () => startPage(recents.get(), startView.get(), startPicked.get()), { suspendWhenHidden: false })

    new Effect(event([() => input('ce_recents')], () => {
      const raw = input<{ items?: Recent[] } | null>('ce_recents')
      const items = (truthy(raw) ? raw!.items : null) ?? []
      recents.set(truthy(items) ? items : [])
    }))

    const started = new Value<boolean>(false)
    new Effect(() => {
      if (started.get()) return
      started.set(true)
      isolate(() => {
        if (project.get() === null) showStart()
      })
    })

    function showNewProject(): void {
      const labels = parseLabels({})
      session.modalShow(modal([
        inputText('np_name', 'Study name', '', { placeholder: 'For example, Sandy Run Section 206' }),
        h.div(inputRadioButtons('np_mode', 'How benefits are measured',
          ['HU', 'INDEX_X_QUANTITY', 'STAF', 'AAHU'].map((k) => [k, methodChoice(k, labels)]), { selected: 'HU', width: '100%' }),
        { class: 'ce-choices' }),
        h.p('This sets up the first module. Add more modules (for example, riparian and instream) under Inputs, Study.', { class: 'ce-note' }),
        layoutColumns([
          inputNumeric('np_rate', 'Discount rate (percent)', '3.0', { min: 0, max: 25, step: '0.125' }),
          inputNumeric('np_poa', 'Period of analysis (years)', 50, { min: 1, max: 200 })], { colWidths: [6, 6] }),
        inputText('np_years', 'Target years', '0, 1, 5, 10, 25, 50'),
      ], { title: 'New project', easyClose: true,
        footer: h.div(modalButton('Cancel'), inputActionButton('np_create', 'Create', { cls: 'btn-primary' })) }))
    }

    new Effect(event([() => input('np_create')], () => {
      let p: Project
      try {
        const name = pyStrip(String(orEmpty(input('np_name')))) || 'Untitled study'
        const mode = input<string>('np_mode')
        const years = String(orEmpty(input('np_years'))).replace(/;/g, ',').split(',').filter((x) => pyStrip(x)).map((x) => pyFloatText(x))
        const rateIn = input<number | null>('np_rate')
        const rate = (truthy(rateIn) ? Number(rateIn) : 0) / 100.0
        const poaIn = input<number | null>('np_poa')
        const poa = truthy(poaIn) ? pyInt(poaIn) : 50
        const spec = benefitSpec(years.length ? years : [0.0, poa], firstModule(mode))
        checkSettings(rate, poa)
        p = parseProject({ name, settings: { discount_rate: rate, period_of_analysis: poa },
          benefits: { target_years: spec.target_years, modules: [{ id: 'M1', name: spec.modules[0].name, method: spec.modules[0].method,
            quantity_units: spec.modules[0].quantity_units }] }, labels: labelsDoc(defaultLabels(mode)) })
      } catch (exc) {
        session.notificationShow(`Could not create the project: ${errorText(exc)}`, { type: 'warning' })
        return
      }
      openProject(p, 'new', 'inputs')
    }))

    // --- modules: add, edit (Inputs, Study; the dialog is views/inputsPage.moduleDialog) ---------
    const moduleTarget = new Value<string | null>(null)

    function showModuleDialog(p: Project, moduleId: string | null): void {
      const dialog = moduleDialog(p, moduleId)
      if (dialog === null) {
        session.notificationShow('That module no longer exists.', { type: 'warning' })
        return
      }
      moduleTarget.set(moduleId || null)
      session.modalShow(dialog)
    }

    new Effect(event([() => input('mod_save')], () => {
      const [p, mid0, o] = isolate(() => [project.get(), moduleTarget.get(), { ...inputsOpts.get() }] as const)
      if (p === null) return
      const name = input<string>('mod_name')
      const method = input<string>('mod_method')
      const units = input<string>('mod_units')
      let mid = mid0
      const adding = mid === null
      const old = adding ? null : moduleOf(p.benefits, mid!)
      let nw: Project
      try {
        if (adding) {
          nw = edits.addModule(p, name, method, units)
          mid = nw.benefits.modules[nw.benefits.modules.length - 1].id
        } else {
          nw = edits.editModule(p, mid!, name, method, units)
        }
      } catch (exc) {
        if (exc instanceof edits.EditError) {
          session.notificationShow(exc.message, { type: 'warning', duration: 6 })
          return
        }
        throw exc
      }
      const m = moduleOf(nw.benefits, mid!)!
      const changed = old !== null && old.method !== m.method
      commit(nw, adding ? `add the module ${m.name}` : `edit the module ${m.name}`)
      // Benefits opens this module on its first input view (never on an empty computed view)
      const next: Record<string, string | null | undefined> = { ...o, module: mid }
      if (adding || changed) next.view = VIEWS[m.method][0]
      inputsOpts.set(next)
      session.modalRemove()
      if (adding) {
        session.notificationShow(`Added ${m.name}. Sites are incomplete until its values are entered.`, {
          action: h.button('Enter its values', { type: 'button', class: 'btn btn-sm btn-primary' },
            ev('nav', { page: 'inputs', section: 'benefits', toast: 'module-added' })),
          id: 'module-added', duration: 12 })
      } else if (changed) {
        session.notificationShow(`${m.name} is now entered differently, so its values were cleared. Undo brings them back.`,
          { id: 'module-changed', duration: 8 })
      }
      session.sendCustomMessage('ce_scroll_to', { id: `mod-edit-${mid}`, output: 'page_inputs', block: 'nearest' })
    }))

    // --- open a file -----------------------------------------------------------------------------
    new Effect(event([() => input('open_file')], () => {
      const files = (input<{ name?: string, datapath: string }[] | null>('open_file') ?? [])
      if (!files.length) return
      const f = files[0]
      const name = f.name ?? f.datapath.replace(/^.*[\\/]/, '')
      try {
        const data = opts.readUpload(f.datapath)
        if (name.toLowerCase().endsWith('.xlsx')) {
          const imp = readWorkbook(data)
          openProject(imp.project, 'imported from Excel')
          if (imp.changes.length) {
            session.modalShow(modal([
              h.p(`${imp.changes.length} changes from the workbook were applied:`),
              h.ul(...imp.changes.slice(0, 40).map((c) => h.li(`${c.where}: ${c.before} to ${c.after}`))),
            ], { title: 'Imported changes', easyClose: true, footer: modalButton('Close') }))
          }
          for (const w of imp.warnings) session.notificationShow(w, { type: 'warning', duration: 8 })
        } else {
          const loaded = loads(data)
          openProject(loaded.project, 'project file')
          for (const w of loaded.warnings) session.notificationShow(w, { type: 'warning', duration: 8 })
        }
      } catch (exc) {
        if (exc instanceof ProjectFileError || exc instanceof WorkbookError) session.notificationShow(exc.message, { type: 'error', duration: 10 })
        else session.notificationShow(`Could not open ${name}: ${exc instanceof Error ? exc.message : String(exc)}`, { type: 'error', duration: 10 })
      }
    }))

    // --- STAF: import an existing condition from SFARI, EASI or DEEP (Phase 3) -----------------
    let stafPending: { imp: StafImport, mid: string } | null = null
    new Effect(event([() => input('staf_file')], () => {
      const files = input<{ name?: string, datapath: string }[] | null>('staf_file') ?? []
      const p = isolate(() => project.get())
      const gopts = isolate(() => ({ ...inputsOpts.get() }))
      if (!files.length || p === null) return
      const f = files[0]
      let imp: StafImport
      try {
        imp = readStafFile(opts.readUpload(f.datapath), f.name ?? 'file')
      } catch (exc) {
        if (exc instanceof StafImportError) session.notificationShow(exc.message, { type: 'error', duration: 10 })
        else session.notificationShow(`Could not read ${f.name ?? 'the file'}: ${exc instanceof Error ? exc.message : String(exc)}`, { type: 'error', duration: 10 })
        return
      }
      let [mod] = pickModule(p, gopts)
      if (mod === null || mod.method !== 'STAF') mod = p.benefits.modules.find((m) => m.method === 'STAF') ?? null
      if (mod === null) {
        session.notificationShow('Import STAF scores into a STAF module.', { type: 'warning' })
        return
      }
      stafPending = { imp, mid: mod.id }
      const mapping = p.benefits.staf_mapping
      const sites = p.sites.filter((s) => noAction(s) !== null)
      const here = siteOf(p, gopts.staf_site || '') ? gopts.staf_site! : sites.length ? sites[0].id : null
      // a dict: a site called "new" or "" takes that entry's place
      const choices = new Map<string, string>([['new', 'New site']])
      for (const s of sites) choices.set(s.id, s.name !== s.id ? `${s.id}  ${s.name}` : s.id)
      choices.set('', 'Skip')
      const rows = imp.reaches.map((r, i) => {
        const dflt = imp.reaches.length === 1 && here ? here : siteOf(p, r.reach_id) ? r.reach_id : 'new'
        const assessed = staf.functionIds().filter((fid) => !r.not_assessed.includes(fid))
        const eci = staf.rollup(r.scores, mapping, assessed).eci
        return h.tr(
          h.td(h.strong(r.name), r.reach_id !== r.name ? h.div(r.reach_id, { class: 'ce-muted' }) : null),
          h.td(r.length_ft ? `${Number.isFinite(r.length_ft) ? pyFixedComma(r.length_ft, 0) : 'inf'} ft` : 'n/a', { class: 'num' }),
          h.td(`${assessed.length} of 20`, { class: 'num' }),
          h.td(eci !== null ? pyFixed(eci, 2) : 'n/a', { class: 'num' }),
          h.td(inputSelect(`staf_target_${i}`, null, [...choices], { selected: dflt, width: '220px' })))
      })
      const notes = [...imp.warnings, ...imp.reaches.flatMap((r) => r.notes)]
      const toolMapping = importMapping(imp)
      if (toolMapping !== mapping) {
        const labels = staf.MAPPING_LABELS as Record<string, string>
        notes.unshift(`${imp.tool} uses the ${labels[toolMapping]} mapping; this project uses ${labels[mapping]}, so the ECI here differs `
          + `from ${imp.tool}'s. Change the mapping under Inputs, Study, to match.`)
      }
      const into = p.benefits.modules.filter((m) => m.method === 'STAF').length > 1 ? ` of ${mod.name}` : ''
      session.modalShow(modal([
        h.p(`${imp.tool} ${imp.kind}: ${imp.filename}. The scores become each site's existing condition${into} (No Action at the first target `
          + 'year); functions the source did not assess are marked not assessed.'),
        h.div(h.table(
          h.thead(h.tr(h.th('Reach'), h.th('Length', { class: 'num' }), h.th('Functions', { class: 'num' }), h.th('ECI', { class: 'num' }),
            h.th('Put into'))),
          h.tbody(...rows), { class: 'ce-table' }), { class: 'ce-table-wrap' }),
        notes.length ? h.ul(...[...new Set(notes)].map((n) => h.li(n)), { class: 'ce-note' }) : null,
      ], {
        title: 'Import existing condition', easyClose: true, size: 'l',
        footer: h.div(modalButton('Cancel'), inputActionButton('staf_import_ok', 'Import', { cls: 'btn-primary' })),
      }))
    }))
    new Effect(event([() => input('staf_import_ok')], () => {
      const pending = stafPending
      const p = isolate(() => project.get())
      if (pending === null || p === null) return
      const { imp, mid } = pending
      const targets = new Map(imp.reaches.map((_, i) => [i, input<string>(`staf_target_${i}`)]))
      let nw: Project
      try {
        nw = edits.importReaches(p, imp, targets, mid)
      } catch (exc) {
        if (exc instanceof edits.EditError) {
          session.notificationShow(exc.message, { type: 'warning', duration: 8 })
          return
        }
        throw exc
      }
      const n = [...targets.values()].filter((t) => t).length
      commit(nw, `import the existing condition from ${imp.tool}`)
      stafPending = null
      session.modalRemove()
      session.notificationShow(`Imported the existing condition for ${n} site${n === 1 ? '' : 's'}. Use Start from existing condition to `
        + 'fill each alternative, then change what it improves.', { duration: 8 })
    }))

    new Effect(event([() => input('ce_restore_json')], () => {
      const raw = input<{ json?: string | null } | null>('ce_restore_json')
      const text = truthy(raw) ? raw!.json : null
      if (!text) {
        session.notificationShow(host.AUTOSAVE_GONE, { type: 'warning' })
        return
      }
      try {
        openProject(loads(text).project, 'autosave')
      } catch (exc) {
        if (exc instanceof ProjectFileError) session.notificationShow(exc.message, { type: 'error' })
        else throw exc
      }
    }))

    // --- autosave (where: views/host.ts) -------------------------------------------------------
    new Effect(() => {
      invalidateLater(clock, 1.0)
      const p = isolate(() => {
        if (!dirty.get() || clock.monotonic() - lastChange.get() < AUTOSAVE_QUIET_S) return undefined
        const q = project.get()
        dirty.set(false)
        return q
      })
      if (p === undefined || p === null) return
      const at = stampText(clock.now())
      session.sendCustomMessage('ce_autosave', { id: p.project_id, name: p.name, json: dumps(p, { savedAt: opts.savedAt?.() }), at })
      savedNote.set(host.autosaved(clockText(clock.now())))
    })

    // the web app's reload for an update (src/app/offline.ts; not in app.py, web/README.md): whether a
    // project is open, saved first (past autosave's quiet period) when the page is about to reload
    new Effect(event([() => input('ce_reload')], () => {
      const raw = input<{ save?: boolean } | null>('ce_reload')
      const save = truthy(raw) && raw!.save === true
      const p = project.get()
      if (p !== null && save) {
        dirty.set(false)
        session.sendCustomMessage('ce_autosave', { id: p.project_id, name: p.name, json: dumps(p, { savedAt: opts.savedAt?.() }),
          at: stampText(clock.now()) })
        savedNote.set(host.autosaved(clockText(clock.now())))
      }
      session.sendCustomMessage('ce_reload', { id: p === null ? null : p.project_id, save })
    }))

    new Effect(() => {
      const p = project.get()
      session.sendCustomMessage('ce_title', { title: p ? p.name : '' })
    })

    // --- outputs -------------------------------------------------------------------------------
    session.outputUi('project_name', () => {
      const p = project.get()
      if (p === null) return h.span('No project open', { class: 'ce-project-name', style: 'opacity:.7' })
      return h.button(p.name, { type: 'button', class: 'ce-project-name', title: 'Study details', 'data-ev': 'nav', 'data-page': 'inputs',
        'data-section': 'study' })
    })

    session.outputUi('stagebar', () => {
      histRev.get()
      return stagebarHtml(statuses.get(), page.get(), project.get(), { canUndo: hist.canUndo(), canRedo: hist.canRedo(),
        undoLabel: hist.peekUndo(), redoLabel: hist.peekRedo(), saved: savedNote.get() })
    })

    session.outputUi('panel_body', () => panel(results.get(), page.get(), site.get(), section.get(), statuses.get()))

    session.outputUi('panel_foot', () => {
      histRev.get()
      return historyTools({ canUndo: hist.canUndo(), canRedo: hist.canRedo(), undoLabel: hist.peekUndo(), redoLabel: hist.peekRedo(),
        saved: savedNote.get() })
    })

    session.outputUi('page_inputs', () => inputsPage(results.get(), section.get(), inputsOpts.get()))
    session.outputUi('page_sites', () => sitesPage(results.get(), site.get()))
    session.outputUi('page_watershed', () => watershedPage(results.get(), plansView.get()))

    // --- the Report page: every file on it comes from one files address --------------------------
    session.route('report_files', (q) => {
      try {
        // run inside the session and isolated, so the results can be read here
        const res = results.get()
        const today = opts.today()
        const item = resolve(res, q.get('f') ?? '', q.get('fmt') ?? '', today)
        // a job is made from the project as it stands at the click, as Shiny's route reads the session's
        // results
        const job = item?.job && res !== null ? { project: dumps(res.project), today: isoDay(today) } : {}
        return { item, inline: q.get('view') === '1', ...job }
      } catch {
        // a broken link must not close the session
        return { failed: 'Finding a download failed.' }
      }
    })

    session.outputUi('page_report', () => reportPage(results.get(), opts.filesUrl))

    new Effect(event([() => input('rep_save')], () => {
      const p = isolate(() => project.get())
      if (p === null) return
      let nw: Project
      try {
        nw = edits.reportSettings(p, { title: input<string>('rep_title'), prepared_by: input<string>('rep_by'), date: input<string>('rep_date'),
          contents: input<string>('rep_contents') })
      } catch (exc) {
        if (exc instanceof edits.EditError) {
          session.notificationShow(exc.message, { type: 'warning', duration: 5 })
          return
        }
        throw exc
      }
      commit(nw, 'edit the document settings')
      session.modalRemove()
    }))

    // --- downloads -----------------------------------------------------------------------------
    const stem = (): string => fileStem(project.get(), opts.today())

    session.download('save_project', {
      filename: () => `${stem()}.ceica`,
      build: () => {
        const p = project.get()
        if (p === null) throw new Error('No project is open.')
        savedNote.set(`Downloaded ${clockText(clock.now())}`)
        return dumps(p, { savedAt: opts.savedAt?.() })
      },
    })
    for (const [id, filename, mode] of [['dl_template_generic', 'CEICA template (habitat units).xlsx', 'HU'],
      ['dl_template_ixq', 'CEICA template (index x quantity).xlsx', 'INDEX_X_QUANTITY'],
      ['dl_template_staf', 'CEICA template (STAF).xlsx', 'STAF']]) {
      session.download(id, { filename: () => filename, build: () => buildTemplate(templateProject(mode)) })
    }
  }
}

/** ``x or ""`` for a value from the browser. */
const orEmpty = (v: unknown): unknown => (truthy(v) ? v : '')

/** str(exc), as the notifications show an exception. */
const errorText = (exc: unknown): string => (exc instanceof Error ? exc.message : String(exc))

/** Labels as the plain form the parser takes. */
const labelsDoc = (l: ReturnType<typeof defaultLabels>): Record<string, string> => ({ output_name: l.output_name, output_short: l.output_short,
  annual_output_name: l.annual_output_name, annual_output_short: l.annual_output_short, lift_name: l.lift_name })

export type { Tag }
