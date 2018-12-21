const { execFileSync } = require('child_process')
const fs = require('fs')
const rimraf = require('rimraf')
const octokit = require('@octokit/rest')()
const homeDir = require('os').homedir()
const { reportsDir } = require('./utils')

// default to true
const DRY_RUN = process.env.DRY_RUN ? process.env.DRY_RUN !== '0' : true
const githubToken = process.env.LH_RUNNER_TOKEN || fs.readFileSync(`${homeDir}/.devtools-token`).toString('utf-8')

const runSettings = {
  cli: {
    versions: getCliVersions(),
  },
  psi: {
    key: process.env.LH_RUNNER_PSI_KEY || fs.readFileSync(`${homeDir}/.psi-key`).toString('utf-8')
  },
  master: true,
  devTools: false,
  extension: true,
}

// load './runners/${keyof runSettinngs}' if value is truthy
// put in runners object (type => module)
const truthyRunners = Object.entries(runSettings).filter(([, value]) => Boolean(value)).map(([type,]) => type)
const runners = truthyRunners.reduce((acc, el) => (acc[el] = require('./runners/' + el), acc), {})

const DEFAULT_GH_PARAMS = {
  owner: 'GoogleChrome',
  repo: 'lighthouse',
}

// const psiKey = process.env.LH_RUNNER_PSI_KEY || fs.readFileSync(`${homeDir}/.psi-key`).toString('utf-8')

const statePath = 'state.json'
let state = {
  since: '2018-12-17T01:01:01Z',
}

// returns the latest release of the last two major versions
function getCliVersions() {
  // this seems to be ordered by semver
  const versionsJson = execFileSync('npm', [
    'view',
    'lighthouse',
    'versions',
    '--json',
  ])
  const versions = JSON.parse(versionsJson)
  const lastVersionOfMajor = {}
  for (const version of versions) {
    const major = version.split('.')[0]
    lastVersionOfMajor[major] = version
  }

  const latestMajorVersion = Math.max(...Object.keys(lastVersionOfMajor).map(Number))
  return [
    lastVersionOfMajor[latestMajorVersion],
    lastVersionOfMajor[latestMajorVersion - 1],
  ]
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
    console.log('-----------')
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
    reportsDir,
    surgeDomain
  ])
}

function parseComment(comment) {
  const matches = /http[^\s]*/.exec(comment)
  const url = matches ? matches[0] : null

  if (url && url.includes('localhost')) {
    return null
  }

  return url
}

function generateComment({ url, runs, surgeDomain }) {
  if (!url) {
    return 'Could not find URL'
  }

  const getUrlIfExists = (text, file) => {
    if (!fs.existsSync(`${reportsDir}/${file}`)) {
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
  // and then uploaded to surge
  rimraf.sync(reportsDir)
  fs.mkdirSync(reportsDir)

  const url = parseComment(commentText)
  if (!url) {
    await sendComment({
      issue,
      body: generateComment({ url }),
    })
    return
  }

  const runs = []
  for (const [type, settings] of Object.entries(runSettings)) {
    const runner = runners[type]
    if (!runner) {
      continue
    }

    try {
      const result = await runner.run(url, settings)
      if (result && Array.isArray(result)) {
        runs.push(...result)
      } else if (result) {
        runs.push(result)
      }
    } catch (err) {
      console.error(err)
    }
  }

  for (const { type, output } of runs) {
    const outputPath = `${reportsDir}/${type}.output.txt`
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
  fs.writeFileSync(`${reportsDir}/summary.json`, JSON.stringify({ runs: runsJustSuccess, url }, null, 2))

  // create an index for the surge site
  const indexHtml = `
    <html>
      <head>
        <title>LH #${issue} ${url}</title>
      </head>
      <body>
        <a href='https://github.com/GoogleChrome/lighthouse/issues/${issue}'>#${issue}</a><br>
        <a href='${url}'>${url}</a><br>
        ${fs.readdirSync(reportsDir).map(f => `<a href='${f}'>${f}</a>`).join('<br>')}
      </body>
    </html>
  `
  fs.writeFileSync(`${reportsDir}/index.html`, indexHtml)
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

async function findIssues() {
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

  return issues
}

// run on all issues with 'needs-lh-runnner' label
async function runForIssues(issues) {
  const label = 'needs-lh-runner'

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
      debugger;
      await removeLabel({
        issue,
        label,
      })
    } catch (err) {
      console.error(err)
    }
  }
}

async function findComments() {
  // don't bother paginating, just look at 100 per run
  return (await octokit.issues.listCommentsForRepo({
    ...DEFAULT_GH_PARAMS,
    sort: 'updated',
    direction: 'asc',
    since: state.since,
    per_page: 100,
  })).data.filter(c => c.updated_at != state.since).filter(({ body }) => /LH Runner Go!/i.test(body))
}

// run for comments requesting like so: LH Issue Runner go!
async function runForComments(comments) {
  if (comments.length) {
    console.log('running for comments:', comments.map(({ id }) => id))
  }

  for (const { id, body, issue_url, updated_at } of comments) {
    console.log(`processing comment ${id}`)
    const issueUrlSplit = issue_url.split('/')
    const issue = Number(issueUrlSplit[issueUrlSplit.length - 1])
    const surgeDomain = `lh-issue-runner-${issue}-${id}.surge.sh`
    await driver({ issue, commentText: body, surgeDomain })
    // only save state if any work was done
    state.since = updated_at
    saveState()
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

  const issues = await findIssues()
  const comments = await findComments()

  if (issues.length || comments.length) {
    for (const [type, runner] of Object.entries(runners)) {
      if (runner.oneTimeSetup) {
        try {
          await runner.oneTimeSetup()
        } catch (err) {
          console.error(err)
          delete runner[type]
        }
      }
    }

    await runForIssues(issues)
    await runForComments(comments)

    // be nice and wait a whole second before shutting down
    // for some reason the cli process isn't correctly canceled,
    // so if the page causes LH to hang for some reason this helps
    // shuts things down all the way
    setTimeout(process.exit, 1000)
  }

  saveState()
})()
