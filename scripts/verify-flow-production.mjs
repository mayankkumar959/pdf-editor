import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { PDFDocument, StandardFonts } from 'pdf-lib'

await mkdir('test-results', { recursive: true })
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined)
const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = [], failedRequests = []
page.on('pageerror', error => errors.push(error.message))
page.on('requestfailed', request => { if (!request.failure()?.errorText.includes('ERR_ABORTED')) failedRequests.push(request.url()) })
async function upload(buffer, name) {
  await page.locator('#file-upload').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(buffer) })
  await page.waitForFunction(filename => document.querySelector('[aria-label="Download filename"]')?.value === filename && document.querySelector('.flow-document')?.dataset.ready === 'true' && !document.querySelector('.loading-overlay'), name.replace(/\.pdf$/i, '-edited.pdf'))
}
try {
  const original = await PDFDocument.create(), font = await original.embedFont(StandardFonts.Helvetica)
  original.addPage([400, 300]).drawText('Production editable paragraph.', { x: 35, y: 230, size: 12, font })
  await page.goto(process.env.PAPYORA_TEST_URL ?? 'http://127.0.0.1:4173')
  await upload(await original.save(), 'production-flow.pdf')
  await page.locator('.flow-content').first().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText(' ProductionFlowToken'.repeat(100))
  const count = await page.locator('.flow-sheet').count()
  assert.ok(count > 1)
  assert.equal(await page.locator('.text-target').count(), 0)
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download PDF', exact: true }).click()
  const path = resolve('test-results/production-flow-exported.pdf')
  await (await pending).saveAs(path)
  const bytes = await readFile(path), saved = await PDFDocument.load(bytes)
  assert.equal(saved.getPageCount(), count)
  await upload(bytes, 'production-flow-reopened.pdf')
  assert.equal((await page.locator('.flow-content').allTextContents()).join(' ').match(/ProductionFlowToken/g)?.length, 100)
  assert.ok(await page.locator('.flow-content [data-block]').evaluateAll(nodes => nodes.every(node => Math.abs(parseFloat(getComputedStyle(node).fontSize) - 12) < .01)))
  await page.locator('.flow-content').first().click()
  await page.keyboard.press('Home')
  await page.keyboard.insertText('Reopened ')
  assert.ok((await page.locator('.flow-content').allTextContents()).join(' ').includes('Reopened '))
  assert.deepEqual(errors, [])
  assert.deepEqual(failedRequests, [])
  await writeFile('test-results/flow-production-verification.json', JSON.stringify({ result: 'PASS', pages: count, vectorPdfBytes: bytes.length, errors, failedRequests }, null, 2))
  console.log('PASS: bundled production flow editor, native typing, pagination, unchanged font size, actual download/reopen and further editing; no runtime or asset failures.')
} finally {
  await browser.close()
}
