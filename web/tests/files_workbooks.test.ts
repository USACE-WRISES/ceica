// The Excel templates and calculators against openpyxl (files/templates.json and files/calculator/,
// make_file_fixtures.py), part by part.
import { describe as group, expect, it } from 'vitest'
import { templateProject } from '../src/app/server'
import { analyze } from '../src/engine/analysis'
import type { Project } from '../src/engine/model'
import { loads } from '../src/engine/projectfile'
import { buildCalculator } from '../src/engine/workbook/export'
import { buildTemplate } from '../src/engine/workbook/template'
import { PyValueError } from '../src/py/pystr'
import { expectFile } from './fileCheck'
import templates from './fixtures/files/templates.json'
import { fileProjects, projectGoldens } from './projects'

const calculators = import.meta.glob<Record<string, any>>('./fixtures/files/calculator/*.json', { import: 'default', eager: true })

const inputs = new Map(projectGoldens().map((p) => [p.name, p.input]))

group('templates', () => {
  for (const [mode, golden] of Object.entries(templates.blank)) {
    it(`a blank template, ${mode}`, () => expectFile(buildTemplate(templateProject(mode)), golden, `template-${mode}.xlsx`))
  }
  for (const [name, golden] of Object.entries(templates.filled)) {
    it(`a template filled with ${name}`, () => expectFile(buildTemplate(loads(inputs.get(name)!).project), golden, `template-${name}.xlsx`))
  }
})

/** The calculator, or the error that stops it as Python names it ("ValueError: ..."). */
function calculator(project: Project): Uint8Array | { error: string } {
  try {
    return buildCalculator(project, analyze(project))
  } catch (exc) {
    return { error: `${exc instanceof PyValueError ? 'ValueError' : (exc as Error).name}: ${(exc as Error).message}` }
  }
}

function expectCalculator(project: Project, name: string): void {
  const golden = calculators[`./fixtures/files/calculator/${name}.json`]
  const made = calculator(project)
  if (made instanceof Uint8Array) expectFile(made, golden, `${name}-calculator.xlsx`)
  else expect(made).toEqual(golden)
}

group('calculators', () => {
  for (const { name, input } of fileProjects()) it(`the calculator of ${name}`, () => expectCalculator(loads(input).project, name))
  for (const mode of Object.keys(templates.blank)) {
    // the maker's fixed id (make_file_fixtures.BLANK_ID): a new project draws one at random
    const project = () => ({ ...templateProject(mode), project_id: '5b1d3c7e9a2f4b6d8e0c1a3f5d7b9e21' })
    it(`the calculator of a blank ${mode} study`, () => expectCalculator(project(), `blank-${mode}`))
  }
})
