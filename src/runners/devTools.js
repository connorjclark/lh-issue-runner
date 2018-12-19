const fs = require('fs')

module.exports = {
  async run(url) {
    // const type = `DevTools@${version}`
    // ok but how?
    // 1. launch chrome w/ debugging port
    // 2. open target page
    // 3. launch puppeteer, connect to localhost:port
    // 4. find page, append &can_dock=true&test=true, open
    // 5. open audits panel, run
    // 6. switch to target tab (otherwise snapshots won't be saved)
    return {
      type,
      output: 'TODO',
      lhr: null,
    }
  }
}
