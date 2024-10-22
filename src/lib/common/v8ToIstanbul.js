const path = require('path')
const fs = require('fs/promises')
const slugify = require('slug')
const libCoverage = require('istanbul-lib-coverage')
const v8toIstanbul = require('v8-to-istanbul')
const { getSources } = require('./sourceMap')
const { exists, cacheDir } = require('./common-utils')

const debugDir = path.join(__dirname, '..', '..', '..', '.cache', '_debug')

/**
 * @param {any} payload
 * @param {string} name
 */
async function saveDebugFile(payload, name) {
  if (!(await exists(debugDir))) {
    await fs.mkdir(debugDir, { recursive: true })
  }
  await fs.writeFile(
    path.join(debugDir, `${slugify(name)}.json`),
    typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
  )
  return null
}

/**
 * @param {import('devtools-protocol').Protocol.Profiler.TakePreciseCoverageResponse['result'][number]} obj
 * @param {Record<string, string>} clientRoots
 * @param {any} sourceMapCache
 */
async function convertToIstanbul(obj, clientRoots, sourceMapCache = {}) {
  let res = await getSources(obj.url, clientRoots, sourceMapCache)
  if (!res) {
    return null
  }
  const { filePath, sources } = res
  const converter = v8toIstanbul(filePath, undefined, sources, (path) => {
    if (
      path.includes('/node_modules/') ||
      path.includes('/__cypress/') ||
      path.includes('/__/assets/')
    ) {
      return true
    }
    return false
  })
  await converter.load()
  converter.applyCoverage(obj.functions)
  const coverage = converter.toIstanbul()
  converter.destroy()
  return coverage
}

/**
 * @see https://github.com/bcoe/c8/issues/376
 * @see https://github.com/tapjs/processinfo/blob/33c72e547139630cde35a4126bb4575ad7157065/lib/register-coverage.cjs
 * @param {Omit<import('devtools-protocol').Protocol.Profiler.TakePreciseCoverageResponse, 'timestamp'>} cov
 * @param {{clientRoots?: Record<string, string>, comment: string}} param1
 */
export async function convertProfileCoverageToIstanbul(
  cov,
  { comment, clientRoots = {} }
) {
  // @ts-ignore
  const sourceMapCache = (cov['source-map-cache'] = {})
  if (!(await exists(cacheDir))) {
    await fs.mkdir(cacheDir, { recursive: true })
  }

  const filteredCoverage = {
    ...cov,
    result: cov.result.filter((obj) => {
      if (!/^file:/.test(obj.url) && !/^https?:/.test(obj.url)) {
        return false
      }

      if (
        obj.url.includes('/node_modules/') ||
        obj.url.includes('/__cypress/') ||
        obj.url.includes('/__/assets/')
      ) {
        return false
      }

      return true
    })
  }

  const coverages = await Promise.all(
    filteredCoverage.result.map((obj) => {
      return convertToIstanbul(obj, clientRoots, sourceMapCache).catch(
        (err) => {
          console.error(err, `Could not convert to istanbul - ${obj.url}`)
          return null
        }
      )
    })
  )

  const map = libCoverage.createCoverageMap()
  coverages.reduce((_, coverage) => {
    if (coverage) {
      map.merge(coverage)
    }
    return null
  }, null)

  const result = map.toJSON()

  await saveDebugFile(
    {
      coverage: filteredCoverage,
      result
    },
    comment
  )
  return result
}
