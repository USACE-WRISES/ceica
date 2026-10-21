// The page skeleton: app.py's app_ui (ui.page_fillable), its body as py-shiny renders it.
//
// The head is site.ts's: the stylesheets and scripts in the Shiny page's order. The pages are the
// panels of a hidden navset, each one output; the two file inputs are hidden and opened from the
// page (Open a file, the STAF import).
import { h, type Tag, tag } from '../shiny/htm.ts'
import { inputFile, navsetHidden, outputUi } from '../shiny/shinyui.ts'
import { headerUi, panelFrame } from '../views/frame.ts'

export const PAGES = [['Inputs', 'inputs'], ['Sites', 'sites'], ['Watershed', 'watershed'], ['Report', 'report']] as const

/** The body of app_ui; ``tabset`` is the navset's id (py-shiny draws one at random each page). */
export function pageBody(tabset = '0'): Tag {
  return tag('body',
    h.a('Skip to the page', { href: '#ce-content', class: 'ce-skip' }),
    h.div(
      headerUi(),
      outputUi('stagebar'),
      h.div(
        panelFrame(),
        h.main(navsetHidden('page', PAGES.map(([title, value]) => ({ title, value, content: outputUi(`page_${value}`) })),
          { selected: 'sites', tabset }), { id: 'ce-content', class: 'ce-content', tabindex: '-1' }),
        { class: 'ce-body' }),
      { class: 'ce-shell' }),
    h.div(inputFile('open_file', null, { accept: ['.ceica', '.json', '.xlsx'] }),
      inputFile('staf_file', null, { accept: ['.json', '.geojson', '.csv', '.zip', '.xlsx'] }),
      { style: 'display:none', 'aria-hidden': 'true' }),
    { class: 'bslib-page-fill bslib-gap-spacing html-fill-container', style: 'padding:0;gap:0;' })
}
