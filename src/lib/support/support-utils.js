/// <reference types="Cypress" />
// helper functions that are safe to use in the browser
// from support.js file - no file system access

/** excludes files that shouldn't be in code coverage report */
const filterFilesFromCoverage = (
  totalCoverage,
  config = Cypress.config,
  env = Cypress.env,
  spec = Cypress.spec
) => {
  totalCoverage = filterSpecsFromCoverage(totalCoverage, config, env, spec)
  totalCoverage = filterExternalFromCoverage(totalCoverage)
  return totalCoverage
}

const filterExternalFromCoverage = (totalCoverage) => {
  return Cypress._.omitBy(
    totalCoverage,
    /**
     * @param {{path: string}} param0
     * @param {string} filePath
     */
    ({ path: absolutePath }, filePath) => {
      const fileName = /([^\/\\]+)$/.exec(absolutePath)?.[1]

      if (
        fileName?.startsWith('webpack ') ||
        absolutePath.includes('/webpack/') ||
        absolutePath.match(/\/external\s(\w|-)+\s"/)
      ) {
        return true
      }

      return false
    }
  )
}

/**
 * remove coverage for the spec files themselves,
 * only keep "external" application source file coverage
 */
const filterSpecsFromCoverage = (
  totalCoverage,
  config = Cypress.config,
  env = Cypress.env,
  spec = Cypress.spec
) => {
  const testFilePatterns = getCypressExcludePatterns(config, env, spec)

  const isTestFile = (_, filePath) => {
    const workingDir = spec.absolute.replace(spec.relative, '')
    const filename = filePath.replace(workingDir, '')
    const matchedPattern = testFilePatterns.some((specPattern) =>
      Cypress.minimatch(filename, specPattern, { debug: false })
    )
    const matchedEndOfPath = testFilePatterns.some((specPattern) =>
      filename.endsWith(specPattern)
    )
    return matchedPattern || matchedEndOfPath
  }

  const coverage = Cypress._.omitBy(totalCoverage, isTestFile)
  return coverage
}

/**
 * Reads Cypress config and exclude patterns and combines them into one array
 * @param {*} config
 * @param {*} env
 * @returns string[]
 */
function getCypressExcludePatterns(config, env, spec) {
  let testFilePatterns = []

  const testFilePattern = config('specPattern') || config('testFiles')
  const excludePattern = env().codeCoverage && env().codeCoverage.exclude

  if (Array.isArray(testFilePattern)) {
    testFilePatterns = testFilePattern
  } else {
    testFilePatterns = [testFilePattern]
  }

  // combine test files pattern and exclude patterns into single exclude pattern
  if (Array.isArray(excludePattern)) {
    testFilePatterns = [...testFilePatterns, ...excludePattern]
  } else if (excludePattern) {
    testFilePatterns = [...testFilePatterns, excludePattern]
  }

  return testFilePatterns
}

module.exports = {
  filterFilesFromCoverage
}
