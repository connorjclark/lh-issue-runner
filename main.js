const { execFile, execFileSync } = require('child_process')
const fs = require('fs')
const rimraf = require('rimraf')
const octokit = require('@octokit/rest')()

const DEFAULT_GH_PARAMS = {
  owner: 'GoogleChrome',
  repo: 'lighthouse',
}

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
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
}

function parseComment(comment) {
  const matches = /http[^\s]*/.exec(comment)
  return matches ? matches[0] : null
}

function generateComment({ url, runs, surgeDomain }) {
  if (!url) {
    return 'Could not find URL'
  }

  const perRunSummary = runs.map(({ type, success }) => {
    const emojii = success ? '✅' : '❌'
    const htmlUrl = `[html](http://${surgeDomain}/${type}.report.html)`
    const jsonUrl = `[json](http://${surgeDomain}/${type}.report.json)`
    const outputUrl = `[output](http://${surgeDomain}/${type}.output.txt)`
    // add a nbsp so lighthouse@​4.0.0 doesn't become a mailto: link
    const typeNoMailLink = type.replace('@', '@&#8203;')
    return `${emojii} ${htmlUrl} ${jsonUrl} ${outputUrl} ${typeNoMailLink}`
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

function wasRunSuccessfull({ lhr }) {
  if (!lhr) {
    return false
  }
  if (lhr && lhr.runtimeError && lhr.runtimeError.code != 'NO_ERROR') {
    return false
  }
  return true
}

async function driver({issue, commentText, surgeDomain}) {
  // all output will just be saved to this reports folder,
  // and then zipped up and attached to the GH issue
  rimraf.sync(`reports`)
  fs.mkdirSync(`reports`)

  const url = parseComment(commentText)
  if (!url) {
    const outputComment = generateComment({ url })
    await octokit.issues.createComment({
      owner,
      repo,
      number: issue,
      body: outputComment,
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

  execFileSync('./node_modules/.bin/surge', [
    'reports',
    surgeDomain
  ])

  const outputComment = generateComment({
    url,
    runs,
    surgeDomain,
  })
  await octokit.issues.createComment({
    ...DEFAULT_GH_PARAMS,
    number: issue,
    body: outputComment,
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
  })).data.filter(issue => !issue.pull_request).map(({number}) => number)
  
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
      await driver({issue, commentText, surgeDomain})
      await octokit.issues.removeLabel({
        ...DEFAULT_GH_PARAMS,
        number: issue,
        name: label,
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
    console.log('running for comments:', comments.map(({id}) => id))
  }

  for (const {id, body, issue_url, updated_at} of comments) {
    if (/LH Runner Go!/i.test(body)) {
      console.log(`processing comment ${id}`)
      const issueUrlSplit = issue_url.split('/')
      const issue = Number(issueUrlSplit[issueUrlSplit.length - 1])
      const surgeDomain = `lh-issue-runner-${issue}-${id}.surge.sh`
      driver({issue, commentText: body, surgeDomain})
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
  loadState()

  const homeDir = require('os').homedir()
  const token = process.env.LH_RUNNER_TOKEN || fs.readFileSync(`${homeDir}/.devtools-token`).toString('utf-8')
  await octokit.authenticate({
    type: 'token',
    token,
  })

  await runForIssues()
  await runForComments()

  saveState()
})()
