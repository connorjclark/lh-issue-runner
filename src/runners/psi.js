const fs = require('fs')
const { getContent, reportsDir } = require('../utils')

module.exports = {
  async run(url, { key }) {
    const type = 'PSI'
    const apiEndpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?key=${key}&url=${url}`
    const responseJson = await getContent(apiEndpoint)
    const responseObject = responseJson && JSON.parse(responseJson)
    const lhr = responseObject && responseObject.lighthouseResult
    fs.writeFileSync(`${reportsDir}/${type}.report.json`, JSON.stringify(lhr, null, 2))
    return {
      type,
      output: responseJson,
      lhr,
    }
  },
}
