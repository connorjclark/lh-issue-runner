const fs = require('fs')
const path = require('path')
const puppeteer = require('puppeteer')
const rimraf = require('rimraf')
const { execFileSync } = require('child_process')
const { rootDir, reportsDir } = require('../utils')

const tmpDownloadsDir = `${rootDir}/tmp-downloads`
const extensionDir = `${rootDir}/lh-extension`

module.exports = {
  async oneTimeSetup() {
    if (fs.existsSync(tmpDownloadsDir)) {
      rimraf.sync(tmpDownloadsDir)
    }
    if (fs.existsSync(extensionDir)) {
      rimraf.sync(extensionDir)
    }
    fs.mkdirSync(tmpDownloadsDir)

    const extensionId = 'blipmdconlkpinefehnmjammfjpmpbjk'

    let browser
    try {
      browser = await puppeteer.launch({
        headless: false,
        args: [
          '--disable-extensions',
          // '--remote-debugging-port=9222',
        ]
      })

      const page = await browser.newPage()
      await page.goto('https://robwu.nl/crxviewer/')

      const xidInput = await page.$('input[name="xid"]')
      await xidInput.type(extensionId)

      const submitBtn = await page.$('#advanced-open-cws-extension input[type="submit"]')
      await submitBtn.click()
      await new Promise((resolve, reject) => {
        const timeoutHandle = setTimeout(reject, 30 * 1000)
        page.on('console', (msg) => {
          if (/Calculated extension ID/i.test(msg.text())) {
            clearTimeout(timeoutHandle)
            resolve()
          }
        })
      })

      const downloadLink = await page.$('#download-link')
      await page._client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: tmpDownloadsDir,
      });
      await downloadLink.click()

      // wait idk, 5s?
      await new Promise(resolve => setTimeout(resolve, 5 * 1000))

      // finally, unzip
      const zipPath = tmpDownloadsDir + '/' + fs.readdirSync(tmpDownloadsDir).find(f => /\.zip$/.test(f))
      execFileSync('unzip', [
        '-a',
        zipPath,
        '-d',
        extensionDir,
      ])

      // make a little tweak
      const manifestPath = path.join(extensionDir, 'manifest.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      manifest.permissions.push('tabs')
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

      // make a really gross tweak
      // remove when this lands: https://github.com/GoogleChrome/lighthouse/pull/6839
      const bundlePath = path.join(extensionDir, 'scripts', 'lighthouse-ext-bundle.js')
      const bundleCode = fs.readFileSync(bundlePath, 'utf-8')
      const hookPoint = 'await new Promise(resolve=>chrome.windows.create({url:blobURL},resolve));'
      fs.writeFileSync(bundlePath, bundleCode.replace(hookPoint, hookPoint + 'return runnerResult;'))
    } catch (err) {
      throw err
    } finally {
      await browser.close()
    }
  },

  async run(url) {
    let browser
    try {
      browser = await puppeteer.launch({
        headless: false,
        executablePath: process.env.CHROME_PATH,
        args: [
          `--disable-extensions-except=${extensionDir}`,
          `--load-extension=${extensionDir}`,
        ],
      })
      const page = await browser.newPage()
      await page.goto(url, { waitUntil: 'networkidle2' })

      const targets = await browser.targets()
      const extensionTarget = targets.find(({ _targetInfo }) => {
        return _targetInfo.title === 'Lighthouse' && _targetInfo.type === 'background_page'
      })
      const extensionPage = await extensionTarget.page()
      const outputLines = []
      extensionPage.on('console', (msg) => {
        outputLines.push(msg.text())
      })

      const client = await extensionTarget.createCDPSession()
      // won't actually return anything until this: https://github.com/GoogleChrome/lighthouse/pull/6839
      // but it will b/c of the earlier gross tweak
      const { lhr, report } = (await client.send('Runtime.evaluate', {
        expression: `runLighthouseInExtension({
          restoreCleanState: true,
        })`,
        awaitPromise: true,
        returnByValue: true,
      })).result.value

      const extensionManifest = JSON.parse(fs.readFileSync(`${extensionDir}/manifest.json`))
      const version = extensionManifest.version

      const type = `Extension@${version}`
      fs.writeFileSync(`${reportsDir}/${type}.report.html`, report)
      fs.writeFileSync(`${reportsDir}/${type}.report.json`, JSON.stringify(lhr, null, 2))
      return {
        type,
        output: outputLines.join("\n"),
        lhr,
      }
    } finally {
      browser.close()
    }
  },
}
