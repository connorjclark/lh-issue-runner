const { attemptRun, execCLI, rootDir, reportsDir } = require('../utils')

module.exports = {
  async run(url, { versions }) {
    const runs = []

    for (const version of versions) {
      try {
        const result = await this.runSingle(url, version)
        result && runs.push(result)
      } catch (err) {
        console.error(err)
      }
    }

    return runs
  },

  runSingle(url, version) {
    const type = `lighthouse@${version}`
    const { promise, cancel } = execCLI(type, 'node', [
      `${rootDir}/node_modules/npx`,
      '-p',
      `lighthouse@${version}`,
      'lighthouse',
      url,
      '--output',
      'html',
      '--output',
      'json',
      '--output-path',
      `${reportsDir}/${type}`,
    ])
    return attemptRun(type, () => promise, cancel)
  }
}
