import { existsSync } from 'node:fs'
import { chromium } from 'playwright'

// Use an isolated browser and a debugging pipe; no existing user profile or
// externally accessible debugging port is needed for the verification scripts.
export async function browserSession() {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined)
  const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true })
  const page = await browser.newPage()
  const session = await page.context().newCDPSession(page)
  const errors = [], failedRequests = []
  session.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text))
  session.on('Network.loadingFailed', event => { if (!event.canceled) failedRequests.push(event.errorText) })
  return { send: (method, params = {}) => session.send(method === 'Browser.setDownloadBehavior' ? 'Page.setDownloadBehavior' : method, params), errors, failedRequests, close: () => browser.close() }
}
