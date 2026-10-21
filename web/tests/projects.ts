// The project goldens (web/parity/make_project_fixtures.py): each .ceica input and what the Python
// engine makes of it.

const inputs = import.meta.glob<string>('./fixtures/projects/*.ceica', { query: '?raw', import: 'default', eager: true })
const goldens = import.meta.glob<Record<string, unknown>>('./fixtures/projects/*.json', { import: 'default', eager: true })

/** The date every golden saves under. */
export const SAVED_AT = '2026-09-27T00:00:00Z'

export interface ProjectGolden {
  name: string
  input: string
  expected: Record<string, any>
}

export function projectGoldens(): ProjectGolden[] {
  return Object.keys(inputs).sort().map((path) => {
    const name = path.replace(/^.*\/(.*)\.ceica$/, '$1')
    return { name, input: inputs[path], expected: goldens[path.replace(/\.ceica$/, '.json')] }
  })
}

const edgeInputs = import.meta.glob<string>('./fixtures/files/projects/*.ceica', { query: '?raw', import: 'default', eager: true })

/** The projects the file goldens cover (make_file_fixtures.py): make_project_fixtures' projects, then the
 * edge projects made from the examples. */
export function fileProjects(): { name: string, input: string }[] {
  const edge = Object.keys(edgeInputs).sort().map((path) => ({ name: path.replace(/^.*\/(.*)\.ceica$/, '$1'), input: edgeInputs[path] }))
  return [...projectGoldens().map(({ name, input }) => ({ name, input })), ...edge]
}
