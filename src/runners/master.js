const fs = require('fs')
const { execFileSync } = require('child_process')
const { execCLI, rootDir, reportsDir } = require('../utils')

module.exports = {
  oneTimeSetup() {
    if (!fs.existsSync('lh-master')) {
      execFileSync('git', ['clone', 'https://github.com/GoogleChrome/lighthouse.git', `${rootDir}/lh-master`])
    }
    const opts = { cwd: 'lh-master' }
    // clean all but node_modules
    execFileSync('git', ['clean', '-fxd', '-e', 'node_modules'], opts)
    execFileSync('git', ['pull'], opts)
    execFileSync('yarn', opts)
  },

  run(url) {
    const opts = { cwd: 'lh-master' }
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], opts).toString('utf-8').substr(0, 6)
    const type = `lighthouse@master-${sha}`
    return execCLI(type, 'node', [
      `lh-master/lighthouse-cli`,
      url,
      '--output',
      'html',
      '--output',
      'json',
      '--output-path',
      `${reportsDir}/${type}`,
    ])
  },
}
