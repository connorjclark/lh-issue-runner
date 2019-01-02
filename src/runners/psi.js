const fs = require('fs')
const { attemptRun, getContent, reportsDir } = require('../utils')

module.exports = {
  run(url, { key }) {
    const type = 'PSI'
    return attemptRun(type, async () => {
      const apiEndpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?key=${key}&url=${url}&strategy=mobile`
      const responseJson = await getContent(apiEndpoint)
      const responseObject = responseJson && JSON.parse(responseJson)
      const lhr = responseObject && responseObject.lighthouseResult
      fs.writeFileSync(`${reportsDir}/${type}.report.json`, JSON.stringify(lhr, null, 2))
      return {
        output: responseJson,
        lhr,
      }
    })
  },
}
