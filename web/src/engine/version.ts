// The app's identity: one version number and the names every surface shows (ceica/version.py).
//
// APP_VERSION moves together with the newest section of CHANGELOG.md, CITATION.cff and
// web/package.json (CONTRIBUTING.md rule 7; tests/repo_rules.test.ts pins them all). The tests see
// the version and repo the goldens were made with instead (tests/identity.ts).

export const APP_VERSION = '1.0.0'
export const APP_VERSION_LABEL = `v${APP_VERSION}`

export const APP_NAME = 'CEICA'
/** What the app does, on the start page and in About. */
export const APP_TAGLINE = 'Cost-effectiveness and incremental cost analysis'
/** The header's short subtitle. */
export const APP_SUBTITLE = 'Cost-effectiveness and incremental cost analysis'

/** Version of the numerical engine. Bumped when a result could change for the same inputs. */
export const ENGINE_VERSION = '1'

export const REPO = 'USACE-WRISES/ceica'
export const REPO_URL = `https://github.com/${REPO}`
export const ISSUES_URL = `${REPO_URL}/issues`
