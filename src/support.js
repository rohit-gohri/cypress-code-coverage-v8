/// <reference types="cypress" />
const dayjs = require('dayjs')
const duration = require('dayjs/plugin/duration')
const {
  logMessage,
  filterFilesFromCoverage
} = require('./lib/support/support-utils')

dayjs.extend(duration)

/**
 * Sends collected code coverage object to the backend code
 * via "cy.task".
 * @param {import('./lib/plugin/chromeRemoteInterface').ClientCoverageResult} coverage
 * @param {string} comment
 * @param {string | null} projectRoot
 */
const sendCoverage = (coverage, comment, projectRoot = null) => {
  const logInstance = logMessage(`Saving code coverage for **${comment}**`)
  const totalCoverage = filterFilesFromCoverage(coverage)

  // stringify coverage object for speed
  return cy
    .task(
      'combineCoverage',
      JSON.stringify({
        projectRoot,
        coverage: totalCoverage
      }),
      {
        log: false
      }
    )
    .then((result) => {
      const res = JSON.parse(String(result))
      logInstance.set('consoleProps', () => ({
        'collected coverage': coverage,
        'combined report': res
      }))
      logInstance.end()
    })
}

/**
 * @typedef {{
 *  client?: boolean;
 *  clientRoots?: Record<string, string>;
 *  ssr?: string;
 *  api?: string[] | string;
 *  expectBackendCoverageOnly?: boolean;
 * }} CodeCoverageConfig
 */

/**
 * @typedef {{url: string, comment: string, projectRoot: string | null}} CoverageHostConfig
 */

const registerHooks = () => {
  /** @type {CodeCoverageConfig} */
  const codeCoverageConfig = Cypress.env('codeCoverage') || {}
  const clientRoots = codeCoverageConfig.clientRoots || {}
  const clientCoverageEnabled =
    String(codeCoverageConfig.client ?? false) !== 'false'

  /** @type {CoverageHostConfig[]} */
  let hostObjects = []

  before(() => {
    // each object will have the url pathname
    // to let the user know the coverage will be collected
    hostObjects = []
    // we need to reset the coverage when running
    // in the interactive mode, otherwise the counters will
    // keep increasing every time we rerun the tests
    const logInstance = logMessage('Initialize')
    cy.task(
      'resetCoverage',
      {
        isInteractive: Cypress.config('isInteractive')
      },
      { log: false }
    )

    if (clientCoverageEnabled) {
      cy.task('startPreciseCoverage', null, { log: false }).then(() => {
        logInstance.end()
      })
    }

    const ssrCoveragePath = codeCoverageConfig.ssr
    if (!ssrCoveragePath) {
      return
    }
    logMessage('Saving hosts for SSR coverage')

    /**
     * @param {Cypress.AUTWindow} win
     */
    const saveHost = (win) => {
      if (!win?.location?.host) {
        return
      }
      const url = `${win.location.protocol}//${win.location.host}${ssrCoveragePath}`
      const existingHost = Cypress._.find(hostObjects, {
        url
      })
      if (existingHost) {
        return
      }

      const projectRoot =
        clientRoots[`${win.location.protocol}//${win.location.host}`] ?? null

      logMessage(`Saved "${url}" for SSR coverage`)
      hostObjects.push({
        url,
        projectRoot,
        comment: `ssr - ${win.location.host}`
      })
    }

    // save reference to coverage for each app window loaded in the test
    cy.on('window:load', saveHost)

    // save reference if visiting a page inside a before() hook
    cy.window({ log: false }).then(saveHost)
  })

  if (clientCoverageEnabled) {
    afterEach(function collectClientCoverage() {
      cy.location({ log: false }).then((loc) => {
        const projectRoot = clientRoots[`${loc.protocol}//${loc.host}`]
        const comment = `client - ${loc.href}`
        logMessage(`Project root found - ${loc.href} - ${projectRoot}`)

        // collect and merge frontend coverage
        cy.task(
          'takePreciseCoverage',
          {
            comment,
            projectRoot,
            clientRoots
          },
          {
            timeout: dayjs.duration(30, 'seconds').asMilliseconds(),
            log: false
          }
        ).then(
          /**
           * @param {any} clientCoverage
           */
          (clientCoverage) => {
            if (clientCoverage) {
              sendCoverage(clientCoverage, comment, projectRoot)
            } else {
              logMessage(
                `Could not load client coverage - ${loc.href}. ${clientCoverage}`
              )
            }
          }
        )
      })
    })

    after(() => {
      cy.task('stopPreciseCoverage', null, {
        timeout: dayjs.duration(1, 'minutes').asMilliseconds(),
        log: false
      })
    })
  }

  after(async function collectBackendCoverage() {
    // I wish I could fail the tests if there is no code coverage information
    // but throwing an error here does not fail the test run due to
    // https://github.com/cypress-io/cypress/issues/2296

    // there might be server-side code coverage information
    // we should grab it once after all tests finish
    const runningEndToEndTests = Cypress.testingType === 'e2e'
    const specType = Cypress._.get(Cypress.spec, 'specType', 'integration')
    const isIntegrationSpec = specType === 'integration'

    // we can only request server-side code coverage
    // if we are running end-to-end tests,
    // otherwise where do we send the request?
    if (!runningEndToEndTests || !isIntegrationSpec) {
      return
    }

    const backendUrls = Cypress._.castArray(codeCoverageConfig.api ?? [])

    /** @type {CoverageHostConfig[]} */
    const finalHostConfigs = [
      ...backendUrls.map((url) => ({
        url,
        projectRoot: null,
        comment: `backend - ${url}`
      })),
      ...hostObjects
    ].filter(Boolean)

    await Cypress.Promise.mapSeries(finalHostConfigs, (hostConfig) => {
      const { url, comment, projectRoot } = hostConfig
      return new Cypress.Promise((resolve, reject) => {
        cy.request({
          url,
          log: true,
          failOnStatusCode: false
        })
          .then((r) => {
            return Cypress._.get(r, 'body.coverage', null)
          })
          .then((coverage) => {
            if (coverage) {
              sendCoverage(coverage, comment, projectRoot).then(() => {
                resolve()
              })
              return
            }

            // we did not get code coverage
            const expectBackendCoverageOnly = Cypress._.get(
              codeCoverageConfig,
              'expectBackendCoverageOnly',
              false
            )

            if (expectBackendCoverageOnly) {
              reject(
                new Error(
                  `Expected to collect backend code coverage from ${url}`
                )
              )
              return
            } else {
              resolve()
              // we did not really expect to collect the backend code coverage
              return
            }
          })
      })
    })
  })

  after(function generateReport() {
    // when all tests finish, lets generate the coverage report
    const logInstance = logMessage('Generating report')
    cy.task('coverageReport', null, {
      timeout: dayjs.duration(3, 'minutes').asMilliseconds(),
      log: false
    }).then((coverageReportFolder) => {
      logInstance.set('consoleProps', () => ({
        'coverage report folder': coverageReportFolder
      }))
      logInstance.end()
      return coverageReportFolder
    })
  })
}

// to disable code coverage commands and save time
// pass environment variable coverage=false
//  cypress run --env coverage=false
// or
//  CYPRESS_COVERAGE=false cypress run
// see https://on.cypress.io/environment-variables

// to avoid "coverage" env variable being case-sensitive, convert to lowercase
const cyEnvs = Cypress._.mapKeys(Cypress.env(), (value, key) =>
  key.toLowerCase()
)

if (String(cyEnvs.coverage) !== 'true') {
  console.log('Skipping code coverage hooks')
} else if (Cypress.env('codeCoverageTasksRegistered') !== true) {
  // register a hook just to log a message
  before(() => {
    logMessage(`
      ⚠️ Code coverage tasks were not registered by the plugins file.
      See [support issue](https://github.com/cypress-io/code-coverage/issues/179)
      for possible workarounds.
    `)
  })
} else {
  registerHooks()
}
