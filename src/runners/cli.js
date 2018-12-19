const { execCLI, rootDir, reportsDir } = require('../utils')

module.exports = {
  async run(url, { versions }) {
    const runs = []
    
    for (const version of versions) {
      runs.push(await this.runSingle(url, version))
    }

    return runs
  },

  runSingle(url, version) {
    const type = `lighthouse@${version}`
    return execCLI(type, 'node', [
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
  }
}
