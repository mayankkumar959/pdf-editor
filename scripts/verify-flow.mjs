import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

await mkdir('test-results', { recursive: true })
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined)
const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
const base = process.env.PAPYORA_TEST_URL ?? 'http://127.0.0.1:5173'

async function fixture(columns = false) {
  const pdf = await PDFDocument.create(), regular = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const p = pdf.addPage(columns ? [450, 400] : [400, 300])
  p.drawRectangle({ x: 12, y: 12, width: p.getWidth() - 24, height: p.getHeight() - 24, borderColor: rgb(.2, .4, .7), borderWidth: 1 })
  if (columns) {
    for (const [x, prefix] of [[35, 'Left'], [255, 'Right']]) for (let i = 0; i < 4; i++) p.drawText(`${prefix} column line ${i + 1}.`, { x, y: 345 - i * 26, size: 12, font: regular })
  } else {
    p.drawText('Flow document', { x: 35, y: 260, size: 18, font: bold, color: rgb(.1, .2, .4) })
    let x = 35
    for (const [text, font] of [['Start ', regular], ['bold', bold], [' tail original.', regular]]) { p.drawText(text, { x, y: 215, size: 12, font }); x += font.widthOfTextAtSize(text, 12) }
    p.drawText('These words belong to the same paragraph.', { x: 35, y: 199, size: 12, font: regular })
    p.drawText('FOLLOWING PARAGRAPH', { x: 35, y: 157, size: 12, font: bold })
    p.drawText('Last paragraph on this page.', { x: 35, y: 124, size: 12, font: regular })
    p.drawText('Original footer', { x: 35, y: 16, size: 9, font: regular })
    pdf.addPage([400, 300]).drawText('Second original page', { x: 35, y: 250, size: 12, font: regular })
  }
  return new Uint8Array(await pdf.save())
}
async function upload(bytes, name) {
  await page.locator('#file-upload').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) })
  await page.waitForFunction(filename => document.querySelector('[aria-label="Download filename"]')?.value === filename && document.querySelector('.flow-document')?.dataset.ready === 'true' && !document.querySelector('.loading-overlay'), name.replace(/\.pdf$/i, '-edited.pdf'))
}
async function caret(text, offset = 0, selectLength = 0) {
  await page.evaluate(({ text, offset, selectLength }) => {
    const walker = document.createTreeWalker(document.querySelector('.flow-document'), NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode, at = node.textContent.indexOf(text)
      if (at < 0 || !node.parentElement.closest('.flow-content')) continue
      node.parentElement.closest('.flow-content').focus()
      const range = document.createRange(); range.setStart(node, at + offset); range.setEnd(node, at + offset + selectLength)
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); return
    }
    throw new Error('Text not found: ' + text)
  }, { text, offset, selectLength })
}
async function position(text) {
  return page.evaluate(text => {
    const span = [...document.querySelectorAll('.flow-content [data-block]')].find(span => span.textContent.includes(text))
    const sheet = span.closest('.flow-sheet').getBoundingClientRect(), box = span.getBoundingClientRect()
    return { page: [...document.querySelectorAll('.flow-sheet')].indexOf(span.closest('.flow-sheet')), top: box.top - sheet.top, left: box.left - sheet.left, size: parseFloat(getComputedStyle(span).fontSize), weight: getComputedStyle(span).fontWeight }
  }, text)
}
async function download(name) {
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download PDF', exact: true }).click()
  const file = await pending, path = resolve('test-results', name)
  await file.saveAs(path)
  return new Uint8Array(await readFile(path))
}
async function inspect(bytes) {
  return page.evaluate(async bytes => {
    const e = await import('/src/pdfEngine.ts'), p = await import('/node_modules/.vite/deps/pdfjs-dist.js')
    const doc = await e.openDocument(new Uint8Array(bytes)), pages = []
    for (let i = 0; i < doc.pages.length; i++) {
      const proxy = await doc.proxy.getPage(i + 1), operators = await proxy.getOperatorList()
      pages.push({ width: doc.pages[i].width, height: doc.pages[i].height, blocks: doc.pages[i].blocks.map(block => ({ text: block.text, size: block.originalFormat.fontSize, bold: block.originalFormat.bold, geometry: e.textGeometry(doc.pages[i], block) })), images: operators.fnArray.filter(op => [p.OPS.paintImageXObject, p.OPS.paintInlineImageXObject].includes(op)).length, paths: operators.fnArray.filter(op => op === p.OPS.constructPath).length })
    }
    await doc.proxy.loadingTask.destroy()
    return pages
  }, Array.from(bytes))
}
async function bounds() {
  return page.evaluate(() => [...document.querySelectorAll('.flow-sheet')].flatMap((sheet, page) => {
    const r = sheet.getBoundingClientRect(), results = []
    for (const column of sheet.querySelectorAll('.flow-content')) {
      const walker = document.createTreeWalker(column, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const node = walker.currentNode, range = document.createRange(); range.selectNodeContents(node)
        for (const box of range.getClientRects()) if (box.width && box.height) results.push({ page, footer:column.classList.contains('flow-footer'), left: box.left-r.left, right: box.right-r.left, top: box.top-r.top, bottom: box.bottom-r.top, width:r.width,height:r.height })
      }
    }
    return results
  }))
}

try {
  await page.goto(base)
  const original = await fixture()
  await writeFile('test-results/flow-original.pdf', original)
  await upload(original, 'flow-original.pdf')
  assert.deepEqual(await download('flow-unchanged.pdf'), original, 'An unchanged document must download without rewriting its PDF')
  assert.equal(await page.locator('.text-target').count(), 0)
  assert.equal(await page.locator('.flow-sheet').count(), 2)
  await page.locator('.flow-content [data-block]').filter({hasText:/^Start\s*$/}).dblclick()
  assert.equal(await page.evaluate(()=>window.getSelection().toString().trim()),'Start')
  const before = await position('FOLLOWING PARAGRAPH'), boldBefore = await position('bold')
  await caret('Start', 5)
  const inserted = 'ReflowToken '.repeat(110)
  await page.keyboard.insertText(inserted)
  const sheetCount = await page.locator('.flow-sheet').count()
  assert.ok(sheetCount > 2, `Expected continuation pages; got ${sheetCount}`)
  const after = await position('FOLLOWING PARAGRAPH'), boldAfter = await position('bold')
  assert.ok(after.page > before.page || after.top > before.top + 15)
  assert.equal(boldAfter.size, boldBefore.size)
  assert.equal(boldAfter.weight, '700')
  assert.equal(await page.locator('.drop-overlay').count(), 0)
  assert.ok(await page.evaluate(() => !!window.getSelection()?.anchorNode?.parentElement?.closest('.flow-content')))
  await page.keyboard.insertText('CaretOK ')
  assert.ok(await page.locator('.flow-content').filter({ hasText: 'CaretOK' }).count(), 'Typing must continue at the caret after pagination')
  for (const box of await bounds()) { assert.ok(box.left >= -1 && box.right <= box.width + 1, JSON.stringify(box)); assert.ok(box.top >= -1 && box.bottom <= box.height - (box.footer ? 3 : 20), JSON.stringify(box)) }
  console.log('PASS: typing in the middle wraps mixed-font text, moves following paragraphs, adds pages and preserves font size/caret')

  await page.keyboard.press('Control+z')
  assert.equal(await page.locator('.flow-sheet').count(), 2)
  assert.equal(await page.locator('.flow-content').filter({ hasText: 'ReflowToken' }).count(), 0)
  await page.keyboard.press('Control+Shift+z')
  assert.equal(await page.locator('.flow-sheet').count(), sheetCount)
  console.log('PASS: undo pulls text back to its original pages; redo restores continuation pages')

  await page.locator('.flow-sheet').nth(1).locator('.flow-content').first().evaluate(column => {
    const walker = document.createTreeWalker(column, NodeFilter.SHOW_TEXT); walker.nextNode()
    column.focus(); const range = document.createRange(); range.setStart(walker.currentNode,0);range.collapse(true)
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
  })
  const lengthBeforeDelete = (await page.locator('.flow-content').allTextContents()).join('').length
  await page.keyboard.press('Backspace')
  assert.equal((await page.locator('.flow-content').allTextContents()).join('').length, lengthBeforeDelete-1)
  await page.keyboard.press('Control+z')
  assert.equal((await page.locator('.flow-content').allTextContents()).join('').length, lengthBeforeDelete)
  console.log('PASS: Backspace and undo work across continuation page boundaries')

  const exported = await download('flow-exported.pdf'), saved = await inspect(exported)
  assert.equal(saved.length, sheetCount)
  assert.equal(saved.flatMap(p => p.blocks).map(b => b.text).join(' ').match(/ReflowToken/g)?.length, 110)
  assert.ok(saved[0].paths > 0, 'Original vector artwork must be preserved')
  assert.equal(saved.reduce((n, p) => n + p.images, 0), 0, 'Export must not rasterize pages')
  const tokenBlocks = saved.flatMap(p => p.blocks).filter(b => b.text.includes('ReflowToken'))
  assert.ok(tokenBlocks.every(b => Math.abs(b.size - 12) < .01), JSON.stringify(tokenBlocks))
  assert.ok(saved.at(-1).blocks.some(b => b.text.includes('Second original page')))
  assert.ok(saved.flatMap(p=>p.blocks).some(b=>b.text.includes('CaretOK')))
  for (const p of saved) for (const b of p.blocks) { assert.ok(b.geometry.top >= -1 && b.geometry.top+b.geometry.height <= p.height+1, JSON.stringify(b)); assert.ok(b.geometry.left >= -1 && b.geometry.left+b.geometry.width <= p.width+1, JSON.stringify(b)) }
  await page.screenshot({ path: 'test-results/flow-reflow.png', fullPage: false })
  console.log('PASS: downloaded PDF has the same pages and text, fixed 12 pt text and vector artwork, with no duplicated hidden original text')

  assert.equal(await page.locator('.page-thumbnail').count(), sheetCount)
  await caret('Second original page', 0)
  assert.equal(await page.locator('.page-thumbnail[aria-current=page] .thumbnail-number').innerText(),String(sheetCount))
  await page.getByRole('button',{name:`Go to page ${sheetCount}`,exact:true}).click()
  await page.getByRole('button',{name:'New text',exact:true}).click()
  await page.getByRole('textbox',{name:'New text content',exact:true}).fill('Added on second original page')
  await page.getByRole('spinbutton',{name:'Object Y',exact:true}).fill('110')
  await page.getByRole('button',{name:'Apply object changes',exact:true}).click()
  const withObject = await inspect(await download('flow-object-mapping.pdf'))
  assert.ok(withObject.at(-1).blocks.some(b=>b.text.includes('Added on second original page')), 'Added objects must follow their source page after continuation sheets are inserted')
  console.log('PASS: added objects remain on their source page after pagination and download')

  await page.getByRole('button',{name:'Go to page 2',exact:true}).click()
  await page.getByRole('button',{name:'New text',exact:true}).click()
  await page.getByRole('textbox',{name:'New text content',exact:true}).fill('Continuation object')
  await page.getByRole('button',{name:'Apply object changes',exact:true}).click()
  assert.equal(await page.locator('.flow-sheet').nth(1).locator('.added-object').count(),1)
  await page.getByRole('combobox',{name:'Zoom level',exact:true}).selectOption('50')
  const moving = await page.locator('.flow-sheet').nth(1).locator('.added-object').boundingBox()
  await page.mouse.move(moving.x+moving.width/2,moving.y+moving.height/2)
  await page.mouse.down();await page.mouse.move(moving.x+moving.width/2+10,moving.y+moving.height/2+10,{steps:4});await page.mouse.up()
  assert.equal(Number(await page.getByRole('spinbutton',{name:'Object X',exact:true}).inputValue()),60)
  const continuationObject = await inspect(await download('flow-continuation-object.pdf'))
  assert.equal(continuationObject.length,sheetCount)
  assert.ok(continuationObject[1].blocks.some(b=>b.text.includes('Continuation object')))
  assert.ok(continuationObject.at(-1).blocks.some(b=>b.text.includes('Added on second original page')))
  console.log('PASS: continuation page navigation, object placement, dragging at 50% zoom and export page mapping')
  for (const zoom of ['25','200']) {
    await page.getByRole('combobox',{name:'Zoom level',exact:true}).selectOption(zoom)
    const zoomed = await inspect(await download(`flow-zoom-${zoom}.pdf`))
    assert.equal(zoomed.length,sheetCount,`Zoom ${zoom}% must not change pagination`)
    assert.equal(zoomed.flatMap(p=>p.blocks).map(b=>b.text).join(' ').match(/ReflowToken/g)?.length,110)
    assert.ok(zoomed.flatMap(p=>p.blocks).filter(b=>b.text.includes('ReflowToken')).every(b=>Math.abs(b.size-12)<.01))
  }
  console.log('PASS: native double-click word selection and identical pagination/font size at 25%, 50% and 200% zoom')

  await upload(exported, 'flow-reopened.pdf')
  assert.ok(await page.locator('.flow-content').filter({ hasText: 'ReflowToken' }).count())
  await caret('ReflowToken', 0, 11)
  await page.keyboard.insertText('ReopenedOK')
  assert.ok(await page.locator('.flow-content').filter({ hasText: 'ReopenedOK' }).count())
  console.log('PASS: downloaded PDF reopens and remains editable')

  await upload(await fixture(true), 'columns.pdf')
  assert.equal(await page.locator('.flow-sheet').first().locator('.flow-content').count(), 2)
  const rightBefore = await position('Right column line 1.')
  await caret('Left column line 1.', 5)
  await page.keyboard.insertText('ColumnToken '.repeat(50))
  const rightAfter = await position('Right column line 1.')
  assert.deepEqual(rightAfter, rightBefore)
  for (const box of await bounds()) assert.ok(box.right <= box.width+1, JSON.stringify(box))
  console.log('PASS: editing a left column preserves the independent right column')

  await upload(original, 'paragraphs.pdf')
  await caret('Start', 5)
  await page.keyboard.press('Enter'); await page.keyboard.insertText('New paragraph ')
  await page.keyboard.press('Shift+Enter'); await page.keyboard.insertText('New line ')
  const paragraphOutput = await inspect(await download('flow-paragraphs.pdf'))
  assert.ok(paragraphOutput.flatMap(p=>p.blocks).some(b=>b.text.includes('New paragraph')))
  assert.ok(paragraphOutput.flatMap(p=>p.blocks).some(b=>b.text.includes('New line')))
  assert.ok(paragraphOutput.flatMap(p=>p.blocks).some(b=>b.text==='Flow document'&&Math.abs(b.size-18)<.01), 'Entering a paragraph must not move the caret into the heading')
  assert.ok(paragraphOutput.flatMap(p=>p.blocks).filter(b=>b.text.includes('New paragraph')||b.text.includes('New line')).every(b=>Math.abs(b.size-12)<.01))
  await caret('New paragraph',0,13)
  await page.getByRole('button',{name:'Bold',exact:true}).click()
  const formatted = await inspect(await download('flow-formatting.pdf'))
  assert.ok(formatted.flatMap(p=>p.blocks).some(b=>b.text.includes('New paragraph')&&b.bold))
  console.log('PASS: Enter, Shift+Enter and selection formatting survive saving')

  await upload(original, 'paste-footer.pdf')
  await caret('Original footer', 0, 15)
  await page.keyboard.insertText('Edited footer')
  await caret('Start', 5)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const pasted = ' pasted ' + 'LongWord'.repeat(35) + '\nPasted next line '
  await page.evaluate(text => navigator.clipboard.writeText(text), pasted)
  await page.keyboard.press('Control+v')
  const pastedOutput = await inspect(await download('flow-paste-footer.pdf'))
  const pastedText = pastedOutput.flatMap(p=>p.blocks).map(b=>b.text).join(' ')
  assert.ok(pastedText.includes('Edited footer'))
  assert.ok(pastedText.includes('Pasted next line'))
  assert.equal(pastedText.replace(/\s/g,'').match(/LongWord/g)?.length,35)
  assert.ok(pastedOutput.flatMap(p=>p.blocks).filter(b=>b.text.includes('LongWord')).every(b=>Math.abs(b.size-12)<.01))
  for (const box of await bounds()) assert.ok(box.left >= -1 && box.right <= box.width+1 && box.bottom <= box.height-3,JSON.stringify(box))
  console.log('PASS: unchanged downloads preserve the original bytes; native paste, long unbroken words and editable footers save safely')

  if (existsSync('test-results/embedded-font.pdf')) {
    await upload(await readFile('test-results/embedded-font.pdf'), 'embedded-flow.pdf')
    await caret('Original font sample', 0, 20)
    await page.keyboard.insertText('Original sample font')
    const embedded = await inspect(await download('flow-embedded-font.pdf'))
    assert.ok(embedded.flatMap(p=>p.blocks).some(b=>b.text.includes('Original sample font')))
    assert.equal(embedded.reduce((n,p)=>n+p.images,0),0)
    console.log('PASS: embedded subset font editing remains vector text')
  }
  if (existsSync('test-results/bold-fallback.pdf')) {
    await upload(await readFile('test-results/bold-fallback.pdf'), 'inline-image-flow.pdf')
    await caret('Dated: 10th June 2026', 0, 20)
    await page.keyboard.insertText('Dated: 12th June 2026')
    const inline = await inspect(await download('flow-inline-image.pdf'))
    assert.equal(inline.reduce((n,p)=>n+p.images,0),1, 'Inline image must remain a single image rather than a flattened page')
    assert.ok(inline.flatMap(p=>p.blocks).some(b=>b.text.includes('12th June')&&b.bold))
    console.log('PASS: complex bold text and inline images reflow without flattening artwork')
  }

  await upload(original,'mobile-flow.pdf')

  await page.setViewportSize({width:390,height:844})
  await page.getByRole('button',{name:'Fit to width',exact:true}).click()
  await caret('Start',5)
  await page.keyboard.insertText(' mobile ')
  assert.equal(await page.locator('[role=alert]').count(),0)
  await page.screenshot({path:'test-results/flow-mobile.png'})
  assert.deepEqual(errors,[])
  await writeFile('test-results/flow-verification.json',JSON.stringify({sheetCount,before,after,boldBefore,boldAfter,saved,errors},null,2))
  console.log('PASS: mobile typing and all browser runtime checks')
} catch (error) {
  console.error('Browser errors:', errors)
  console.error('Alerts:', await page.locator('[role=alert]').allTextContents())
  await page.screenshot({path:'test-results/flow-failure.png'})
  throw error
} finally {
  await browser.close()
}
