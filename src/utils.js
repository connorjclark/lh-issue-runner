const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

module.exports.rootDir = path.dirname(path.dirname(require.main.filename))
module.exports.reportsDir = path.join(module.exports.rootDir, 'reports')

module.exports.execCLI = function execCLI(type, file, args) {
  return new Promise((resolve) => {
    const processHandle = execFile(file, args, (err) => {
      if (err) {
        resolve({
          type,
          output,
          lhr: null
        })
        return
      }

      const lhr = JSON.parse(fs.readFileSync(`${module.exports.reportsDir}/${type}.report.json`).toString('utf-8'))

      resolve({
        type,
        output,
        lhr,
      })
    })

    let output = ''
    processHandle.stdout.on('data', (data) => {
      output += data
    })
    processHandle.stderr.on('data', (data) => {
      output += data
    })
  })
}

// https://www.tomas-dvorak.cz/posts/nodejs-request-without-dependencies/
module.exports.getContent = function getContent(url, shouldJoin = true) {
  // return new pending promise
  return new Promise((resolve, reject) => {
    // select http or https module, depending on reqested url
    const lib = url.startsWith('https') ? require('https') : require('http');
    const request = lib.get(url, (response) => {
      // handle http errors
      if (response.statusCode < 200 || response.statusCode > 299) {
        reject(new Error('Failed to load page, status code: ' + response.statusCode))
      }
      // temporary data holder
      const body = []
      // on every content chunk, push it to the data array
      response.on('data', (chunk) => body.push(chunk))
      // we are done, resolve promise with those joined chunks
      response.on('end', () => resolve(shouldJoin ? body.join('') : body))
    });
    // handle connection errors of the request
    request.on('error', (err) => reject(err))
  })
}
