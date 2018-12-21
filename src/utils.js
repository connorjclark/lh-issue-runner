const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

module.exports.rootDir = path.dirname(path.dirname(require.main.filename))
module.exports.reportsDir = path.join(module.exports.rootDir, 'reports')

module.exports.execCLI = function execCLI(type, file, args) {
  /** @type {ChildProcess} processHandle */
  let processHandle
  const promise = new Promise((resolve) => {
    processHandle = execFile(file, args, (err) => {
      if (err) {
        resolve({
          output,
          lhr: null
        })
        return
      }

      const lhr = JSON.parse(fs.readFileSync(`${module.exports.reportsDir}/${type}.report.json`).toString('utf-8'))

      resolve({
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
  const cancel = () => {
    processHandle && processHandle.kill() // this doesn't seem to work. B/c chrome process?
  }
  return {
    promise,
    cancel,
  }
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

// applies time out, and catches any errors and returns as output
module.exports.attemptRun = async function(type, fn, cancel = null) {
  try {
    let cancelTimeout
    const resultPromise = fn().catch(cancelTimeout)
    const timeoutPromise = new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        reject(new Error(`timed out run for ${type}`))
      }, 60 * 1000)
      cancelTimeout = () => {
        clearTimeout(timeoutHandle)
        resolve()
      }
    })
    const result = await Promise.race([
      resultPromise,
      timeoutPromise,
    ])
    cancelTimeout()
    return {
      type,
      ...result, // should return {output, lhr}
    }
  } catch(err) {
    cancel && await cancel()
    return {
      type,
      output: err.toString(),
      lhr: null,
    }
  }
}
