const { execFile, execFileSync } = require('child_process')
const fs = require('fs')
const rimraf = require('rimraf')
const octokit = require('@octokit/rest')()

// default to true
const DRY_RUN = process.env.DRY_RUN ? process.env.DRY_RUN !== '0' : true

// https://www.tomas-dvorak.cz/posts/nodejs-request-without-dependencies/
const getContent = function (url) {
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
      response.on('end', () => resolve(body.join('')))
    });
    // handle connection errors of the request
    request.on('error', (err) => reject(err))
  })
}

const DEFAULT_GH_PARAMS = {
  owner: 'GoogleChrome',
  repo: 'lighthouse',
}

const homeDir = require('os').homedir()
const githubToken = process.env.LH_RUNNER_TOKEN || fs.readFileSync(`${homeDir}/.devtools-token`).toString('utf-8')
const psiKey = process.env.LH_RUNNER_PSI_KEY || fs.readFileSync(`${homeDir}/.psi-key`).toString('utf-8')

const statePath = 'state.json'
let state = {
  since: '2018-12-17T01:01:01Z',
}

function loadState() {
  if (fs.existsSync(statePath)) {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
  }
}

function saveState() {
  if (DRY_RUN) return
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
}

async function sendComment({ body, issue }) {
  if (DRY_RUN) {
    console.log('sendComment', issue, body)
    return
  }

  await octokit.issues.createComment({
    ...DEFAULT_GH_PARAMS,
    number: issue,
    body,
  })
}

async function removeLabel({ issue, label }) {
  if (DRY_RUN) {
    console.log('removeLabel', issue, label)
    return
  }

  await octokit.issues.removeLabel({
    ...DEFAULT_GH_PARAMS,
    number: issue,
    name: label,
  })
}

function uploadReports(surgeDomain) {
  if (DRY_RUN) {
    console.log('uploadReports', surgeDomain)
    return
  }

  execFileSync('./node_modules/.bin/surge', [
    'reports',
    surgeDomain
  ])
}

function parseComment(comment) {
  const matches = /http[^\s]*/.exec(comment)
  return matches ? matches[0] : null
}

function generateComment({ url, runs, surgeDomain }) {
  if (!url) {
    return 'Could not find URL'
  }

  const getUrlIfExists = (text, file) => {
    console.log(`reports/${file}`, fs.existsSync(`reports/${file}`))
    if (!fs.existsSync(`reports/${file}`)) {
      return
    }

    return `[${text}](http://${surgeDomain}/${file})`
  }

  const perRunSummary = runs.map(({ type, success }) => {
    const emojii = success ? '✅' : '❌'
    const htmlUrl = getUrlIfExists('html', `${type}.report.html`)
    const jsonUrl = getUrlIfExists('json', `${type}.report.json`)
    const outputUrl = getUrlIfExists('output', `${type}.output.txt`)
    const urls = [htmlUrl, jsonUrl, outputUrl].filter(Boolean).join(' ')
    // add a nbsp so lighthouse@​4.0.0 doesn't become a mailto: link
    const typeNoMailLink = type.replace('@', '@&#8203;')
    return `${emojii} ${urls} ${typeNoMailLink}`
  }).join("\n")
  return `I ran Lighthouse for ${url}, here's what I found.\n\n[index](http://${surgeDomain})\n${perRunSummary}`
}

function execCLI(type, file, args) {
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

      const lhr = JSON.parse(fs.readFileSync(`reports/${type}.report.json`).toString('utf-8'))

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

function runCLIMaster({ url }) {
  if (!fs.existsSync('lh-master')) {
    execFileSync('git', ['clone', 'https://github.com/GoogleChrome/lighthouse.git', 'lh-master'])
  }
  const opts = { cwd: 'lh-master' }
  // clean all but node_modules
  execFileSync('git', ['clean', '-fxd', '-e', 'node_modules'], opts)
  execFileSync('git', ['pull'], opts)
  execFileSync('yarn', opts)
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
    `reports/${type}`,
  ])
}

function runCLI({ version, url }) {
  const type = `lighthouse@${version}`
  return execCLI(type, 'node', [
    'node_modules/npx',
    '-p',
    `lighthouse@${version}`,
    'lighthouse',
    url,
    '--output',
    'html',
    '--output',
    'json',
    '--output-path',
    `reports/${type}`,
  ])
}

async function runDevTools({ version, url }) {
  const type = `DevTools@${version}`
  // ok but how?
  return {
    type,
    output: 'TODO',
    lhr: null,
  }
}

async function runPSI({ url }) {
  const type = 'PSI'
  const apiEndpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?key=${psiKey}&url=${url}`
  const responseJson = await getContent(apiEndpoint)
  const responseObject = responseJson && JSON.parse(responseJson)
  const lhr = responseObject && responseObject.lighthouseResult
  fs.writeFileSync(`reports/${type}.report.json`, JSON.stringify(lhr, null, 2))
  return {
    type,
    output: responseJson,
    lhr,
  }
}

function wasRunSuccessfull({ lhr }) {
  if (!lhr) {
    return false
  }
  if (lhr && lhr.runtimeError && lhr.runtimeError.code != 'NO_ERROR') {
    return false
  }
  return true
}

async function driver({ issue, commentText, surgeDomain }) {
  // all output will just be saved to this reports folder,
  // and then zipped up and attached to the GH issue
  rimraf.sync(`reports`)
  fs.mkdirSync(`reports`)

  const url = parseComment(commentText)
  if (!url) {
    await sendComment({
      issue,
      body: generateComment({ url }),
    })
    return
  }

  const runs = []

  runs.push(await runCLIMaster({ url }))

  const cliVersions = [
    '4.0.0-beta',
    '3.2.1',
  ]

  for (const version of cliVersions) {
    const run = await runCLI({
      version,
      url
    })
    runs.push(run)
  }

  runs.push(await runPSI({ url }))

  // {
  //   const version = '71'
  //   const run = await runDevTools({
  //     version,
  //     url
  //   })
  //   runs.push(run)
  // }

  for (const { type, output } of runs) {
    const outputPath = `reports/${type}.output.txt`
    fs.writeFileSync(outputPath, output)
  }

  for (const run of runs) {
    run.success = wasRunSuccessfull(run)
  }

  // save just the success summary
  const runsJustSuccess = runs.map(run => {
    const { success, type } = run
    return { success, type }
  })
  fs.writeFileSync('reports/summary.json', JSON.stringify({ runs: runsJustSuccess, url }, null, 2))

  // create an index for the surge site
  const indexHtml = `
    <html>
      <head>
        <title>LH #${issue} ${url}</title>
      </head>
      <body>
        <a href='https://github.com/GoogleChrome/lighthouse/issues/${issue}'>#${issue}</a><br>
        <a href='${url}'>${url}</a><br>
        ${fs.readdirSync('reports').map(f => `<a href='${f}'>${f}</a>`).join('<br>')}
      </body>
    </html>
  `
  fs.writeFileSync('reports/index.html', indexHtml)
  uploadReports(surgeDomain)
  await sendComment({
    issue,
    body: generateComment({
      url,
      runs,
      surgeDomain,
    })
  })
}

// run on all issues with 'needs-lh-runnner' label
async function runForIssues() {
  const label = 'needs-lh-runner'
  const issues = (await octokit.issues.list({
    ...DEFAULT_GH_PARAMS,
    filter: 'all',
    state: 'all', // comment out when not testing
    labels: label
  })).data.filter(issue => !issue.pull_request).map(({ number }) => number)

  // if testing, ensure at least one issue will be processed
  if (DRY_RUN && issues.indexOf(6830) === -1) {
    issues.push(6830)
  }

  if (issues.length) {
    console.log('running for issues:', issues)
  }

  for (const issue of issues) {
    try {
      console.log(`processing issue ${issue}`)
      const surgeDomain = `lh-issue-runner-${issue}.surge.sh`
      const commentText = (await octokit.issues.get({
        ...DEFAULT_GH_PARAMS,
        number: issue
      })).data.body
      await driver({ issue, commentText, surgeDomain })
      await removeLabel({
        issue,
        label,
      })
    } catch (err) {
      console.error(err)
    }
  }
}

// run for comments requesting like so: LH Issue Runner go!
async function runForComments() {
  const comments = (await octokit.issues.listCommentsForRepo({
    ...DEFAULT_GH_PARAMS,
    sort: 'updated',
    direction: 'asc',
    since: state.since,
    per_page: 100,
  })).data.filter(c => c.updated_at != state.since)

  if (comments.length) {
    console.log('running for comments:', comments.map(({ id }) => id))
  }

  for (const { id, body, issue_url, updated_at } of comments) {
    if (/LH Runner Go!/i.test(body)) {
      console.log(`processing comment ${id}`)
      const issueUrlSplit = issue_url.split('/')
      const issue = Number(issueUrlSplit[issueUrlSplit.length - 1])
      const surgeDomain = `lh-issue-runner-${issue}-${id}.surge.sh`
      driver({ issue, commentText: body, surgeDomain })
      // only save state if any work was done
      state.since = updated_at
      saveState()
    }
  }

  if (comments.length) {
    state.since = comments[comments.length - 1].updated_at
    saveState()
    await runForComments()
  }
}

(async function () {
  if (DRY_RUN) {
    console.log('*** dry run. set env var DRY_RUN=0 to run for realsies ***')
  }

  loadState()

  await octokit.authenticate({
    type: 'token',
    token: githubToken,
  })

  await runForIssues()
  await runForComments()

  saveState()
})()
