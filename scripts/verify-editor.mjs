import { browserSession } from './browser-session.mjs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

const base = 'http://127.0.0.1:5173'
const session = await browserSession()
const { send } = session
const browserErrors = session.errors
try {

async function activateLayout(filename) {
  if (filename) await until(`document.querySelector('[aria-label="Download filename"]')?.value === ${JSON.stringify(filename)} && !document.querySelector('.loading-overlay')`)
  else await until(`!document.querySelector('.loading-overlay')`)
  await evaluate(`[...document.querySelectorAll('.mode-switch button')].find(button => button.textContent === 'Layout text').click()`)
  await until(`document.querySelector('.document-canvas')?.dataset.renderState === 'ready' && !document.querySelector('.loading-overlay')`)
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
async function until(expression, timeout = 20000) {
  const started = Date.now()
  while (Date.now() - started < timeout) { const value = await evaluate(`Boolean(${expression})`); if (value) return value; await new Promise(resolve => setTimeout(resolve, 150)) }
  await screenshot('failure.png')
  throw new Error(`Timed out: ${expression}\n${await evaluate('document.documentElement.outerHTML')}\n${JSON.stringify(browserErrors)}`)
}
async function pointerClick(label, count = 1) {
  const point = await evaluate(`(() => { const element = document.querySelector('[aria-label=${JSON.stringify(label)}]'); element.scrollIntoView({block:'center',inline:'nearest'}); const rect = element.getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}; })()`)
  await send('Input.dispatchMouseEvent', { type:'mousePressed', ...point, button:'left', clickCount:count })
  await send('Input.dispatchMouseEvent', { type:'mouseReleased', ...point, button:'left', clickCount:count })
  await new Promise(resolve => setTimeout(resolve, 80))
}
async function click(label) {
  if (label.startsWith('Edit text:')) { await pointerClick(label); await pointerClick(label, 2) }
  else { await evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`); await new Promise(resolve => setTimeout(resolve, 80)) }
}
async function fill(text) {
  await evaluate(`(() => { const input = document.querySelector('#text-value'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await new Promise(resolve => setTimeout(resolve, 80))
}
async function dragHandle(label, dx, dy) {
  const point = await evaluate(`(() => { const element=document.querySelector('[aria-label=${JSON.stringify(label)}]');element.scrollIntoView({block:'center',inline:'nearest'});const rect=element.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}; })()`)
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1})
  for(let step=1;step<=4;step++) await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+dx*step/4,y:point.y+dy*step/4,button:'left',buttons:1})
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+dx,y:point.y+dy,button:'left',clickCount:1})
  await new Promise(resolve=>setTimeout(resolve,120))
}
async function screenshot(filename) { const { data } = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(`test-results/${filename}`, Buffer.from(data, 'base64')) }

await mkdir('test-results', { recursive: true })
await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: base })
await until(`document.querySelector('.demo-button')`)
await screenshot('welcome.png')
await evaluate(`document.querySelector('.demo-button').click()`)
await activateLayout('sample-edited.pdf')
await until(`document.querySelectorAll('.text-target').length > 0 && !document.querySelector('.loading-overlay')`)
await until(`document.querySelector('.document-canvas')?.dataset.renderState === 'ready'`)
const initial = await evaluate(`({ text: document.body.innerText, editable: document.querySelectorAll('.text-target:not(.locked)').length, locked: document.querySelectorAll('.text-target.locked').length })`)
assert.equal(initial.editable, 10, JSON.stringify(initial))
assert.equal(initial.locked, 0)
await screenshot('editor.png')
await pointerClick('Edit text: Make it your own.')
assert.equal(await evaluate(`!!document.querySelector('.inline-text-input')`), false, 'A first click must not mount an input that steals the second click.')
await click('Edit text: Make it your own.')
assert.deepEqual(await evaluate(`(() => {const input=document.querySelector('.inline-text-input');return {focused:document.activeElement===input,start:input.selectionStart,end:input.selectionEnd,text:input.value};})()`), {focused:true,start:0,end:17,text:'Make it your own.'})
await fill('Make it even better.')
await evaluate(`document.querySelector('.apply-button').click()`)
await until(`document.querySelector('[aria-label="Edit text: Make it even better."]') && !document.body.innerText.includes('Updating preview')`)
await until(`document.querySelector('.document-canvas')?.dataset.renderState === 'ready'`)
await screenshot('editing.png')
await click('Next page')
await click('Edit text: This is the second page.')
await fill('Your updated second page.')
await evaluate(`document.querySelector('.apply-button').click()`)
await until(`!document.body.innerText.includes('Updating preview')`)
await click('Previous page')
await click('Edit text: Make it even better.')
assert.equal(await evaluate(`document.querySelector('#text-value').value`), 'Make it even better.')
await click('Zoom in')
await click('Undo')
await click('Redo')
await until(`!document.body.innerText.includes('Updating preview')`)
// The actual exported PDF is inspected independently by PDF.js, including glyph fonts.
const engineResult = await evaluate(`(async () => {
  const engine = await import('/src/pdfEngine.ts');
  const pdfjs = await import('/node_modules/.vite/deps/pdfjs-dist.js');
  pdfjs.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs';
  const original = await engine.openDocument(await engine.createDemo());
  const first = original.pages[0].blocks.find(block => block.text === 'Make it your own.');
  const second = original.pages[1].blocks.find(block => block.text === 'This is the second page.');
  const bytes = await engine.exportDocument(original, { [first.id]: 'Make it even better.', [second.id]: 'Your updated second page.' });
  const exported = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  const before = await (await original.proxy.getPage(1)).getTextContent();
  const after = await (await exported.getPage(1)).getTextContent();
  const secondText = await (await exported.getPage(2)).getTextContent();
  const oldTitle = before.items.find(item => item.str === 'Make it your own.');
  const newTitle = after.items.find(item => item.str === 'Make it even better.');
  const result = { firstText: after.items.filter(item => 'str' in item).map(item => item.str), secondText: secondText.items.filter(item => 'str' in item).map(item => item.str), titleWidthBefore:oldTitle.width,titleWidthAfter:newTitle?.width,titleTransformBefore: oldTitle.transform, titleTransformAfter: newTitle?.transform, titleFontBefore: oldTitle.fontName.split('_').slice(-1)[0], titleFontAfter: newTitle?.fontName.split('_').slice(-1)[0], bytes: Array.from(bytes) };
  await original.proxy.loadingTask.destroy(); await exported.loadingTask.destroy(); return result;
})()`)
assert.ok(engineResult.firstText.includes('Make it even better.'))
assert.ok(!engineResult.firstText.includes('Make it your own.'))
assert.ok(engineResult.secondText.includes('Your updated second page.'))
assert.deepEqual(engineResult.titleTransformAfter.slice(4), engineResult.titleTransformBefore.slice(4))
assert.ok(engineResult.titleTransformAfter[0] < engineResult.titleTransformBefore[0], 'A longer replacement must auto-fit.')
assert.ok(engineResult.titleWidthAfter <= engineResult.titleWidthBefore + .01)
assert.equal(engineResult.titleFontAfter, engineResult.titleFontBefore)
await writeFile('test-results/edited-sample.pdf', new Uint8Array(engineResult.bytes))
delete engineResult.bytes
await writeFile('test-results/verification.json', JSON.stringify({ engineResult, browserErrors }, null, 2))
assert.deepEqual(browserErrors, [])
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
await screenshot('mobile.png')
// Chrome's PDF printer produces a real embedded subset font, with CID-encoded glyphs.
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
const html = '<html><body style="margin:60px;font-family:Arial;background:white"><h1 style="color:#25457a;background:#edf2fb;padding:20px">Original font sample</h1><p style="font-size:19px;font-family:Georgia">Editable text in a serif font.</p><p style="font-size:16px">Keep this adjacent text unchanged.</p></body></html>'
await send('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(html) })
await until(`document.querySelector('h1')`)
const printed = await send('Page.printToPDF', { printBackground: true })
await writeFile('test-results/embedded-font.pdf', Buffer.from(printed.data, 'base64'))
await send('Page.navigate', { url: base })
await until(`document.querySelector('.demo-button')`)
const dom = await send('DOM.getDocument')
const fileNode = await send('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '#file-upload' })
await send('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [resolve('test-results/embedded-font.pdf')] })
await activateLayout('embedded-font-edited.pdf')
await until(`document.querySelectorAll('.text-target').length > 0 && !document.querySelector('.loading-overlay')`)
await click('Edit text: Original font sample')
assert.equal(await evaluate(`document.querySelector('#text-value').disabled`), false)
await evaluate(`(() => { const input = document.querySelector('.inline-text-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Original sample font'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
await new Promise(resolve => setTimeout(resolve, 80))
assert.equal(await evaluate(`document.querySelector('#text-value').value`), 'Original sample font')
await evaluate(`document.querySelector('.apply-button').click()`)
await until(`document.querySelector('[aria-label="Edit text: Original sample font"]') && !document.body.innerText.includes('Updating preview') && document.querySelector('.document-canvas')?.dataset.renderState === 'ready'`)
await screenshot('embedded-edit.png')
const embedded = await evaluate(`(async () => {
  const engine = await import('/src/pdfEngine.ts');
  const bytes = Uint8Array.from(atob(${JSON.stringify(printed.data)}), char => char.charCodeAt(0));
  const original = await engine.openDocument(bytes);
  const block = original.pages[0].blocks.find(block => block.text === 'Original font sample');
  const error = engine.validateEdit(original, block, 'New character Ж');
  const editedBytes = await engine.exportDocument(original, { [block.id]: 'Original sample font' });
  const edited = await engine.openDocument(editedBytes);
  const result = { font: block.font, editable: block.editable, unsupportedCharacterError: error, before: original.pages[0].blocks.map(b => ({text:b.text,transform:b.item.transform})), after: edited.pages[0].blocks.map(b => ({text:b.text,font:b.font,transform:b.item.transform})) };
  await original.proxy.loadingTask.destroy(); await edited.proxy.loadingTask.destroy(); return result;
})()`)
assert.ok(embedded.editable)
assert.ok(embedded.unsupportedCharacterError)
const embeddedTitle = embedded.after.find(block => block.text === 'Original sample font')
assert.ok(embeddedTitle)
assert.equal(embeddedTitle.font, embedded.font)
assert.deepEqual(embeddedTitle.transform, embedded.before.find(block => block.text === 'Original font sample').transform)
const adjacent = 'Keep this adjacent text unchanged.'
assert.deepEqual(embedded.after.find(block => block.text === adjacent).transform, embedded.before.find(block => block.text === adjacent).transform)
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: resolve('test-results') })
await click('Edit text: Original sample font')
await fill('font sample Original')
const downloadName = `verified-${Date.now()}.pdf`
await evaluate(`(() => { const input = document.querySelector('[aria-label="Download filename"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(downloadName)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
await new Promise(resolve => setTimeout(resolve, 80))
await evaluate(`document.querySelector('.app-header .primary').click()`)
await until(`document.body.innerText.includes('Your edited PDF is ready')`)
let downloaded
for (let attempt = 0; attempt < 30; attempt++) {
  try { downloaded = await readFile(resolve('test-results', downloadName)); break } catch { await new Promise(resolve => setTimeout(resolve, 100)) }
}
assert.ok(downloaded, 'The actual Download PDF button must create a file.')
const actualDownloadText = await evaluate(`(async () => { const engine = await import('/src/pdfEngine.ts'); const doc = await engine.openDocument(Uint8Array.from(atob(${JSON.stringify(downloaded.toString('base64'))}), char => char.charCodeAt(0))); const text = doc.pages[0].blocks.map(block => block.text); await doc.proxy.loadingTask.destroy(); return text; })()`)
assert.ok(actualDownloadText.includes('font sample Original'), 'Download must include a draft even when Apply has not been clicked.')
const structures = await evaluate(`(async () => {
  const engine = await import('/src/pdfEngine.ts');
  const { PDFDocument, StandardFonts, PDFName, PDFArray, PDFRawStream, rgb, degrees } = await import('/node_modules/.vite/deps/pdf-lib.js');
  const source = await PDFDocument.create(); const font = await source.embedFont(StandardFonts.TimesRoman);
  source.addPage([300,200]).drawText('Shared form original', {x:20,y:130,size:15,font});
  await source.save();
  const native = await PDFDocument.create(); const form = await native.embedPage(source.getPage(0));
  for (let i=0; i<2; i++) { const page = native.addPage([600,600]); page.drawPage(form,{x:20,y:300}); page.drawPage(form,{x:20,y:70}); }
  const model = await engine.openDocument(new Uint8Array(await native.save()));
  const first = model.pages[0].blocks[0];
  const output = await engine.openDocument(await engine.exportDocument(model, {[first.id]:'Shared form updated'}));
  const formResult = { editable: first.editable, pageOne:output.pages[0].blocks.map(b=>b.text), pageTwo:output.pages[1].blocks.map(b=>b.text) };
  await model.proxy.loadingTask.destroy(); await output.proxy.loadingTask.destroy();
  const positional = await PDFDocument.create(); const regular = await positional.embedFont(StandardFonts.Helvetica);
  const page = positional.addPage([600,700]); page.setCropBox(30,40,500,580); page.setRotation(degrees(90));
  page.drawRectangle({x:40,y:420,width:400,height:110,color:rgb(.7,.8,.95)});
  page.drawText('Before',{x:50,y:500,size:18,font:regular}); page.drawText('Adjacent',{x:200,y:500,size:18,font:regular});
  const rotationModel = await engine.openDocument(new Uint8Array(await positional.save()));
  const block = rotationModel.pages[0].blocks.find(b=>b.text==='Before');
  const rotationOutput = await engine.openDocument(await engine.exportDocument(rotationModel,{[block.id]:'A longer replacement'}));
  const deletion = await engine.openDocument(await engine.exportDocument(rotationModel,{[block.id]:''}));
  const rotationResult = {width:rotationOutput.pages[0].width,height:rotationOutput.pages[0].height,rotation:rotationOutput.pages[0].rotation,before:rotationModel.pages[0].blocks.map(b=>({text:b.text,transform:b.item.transform})),after:rotationOutput.pages[0].blocks.map(b=>({text:b.text,transform:b.item.transform})),deleted:deletion.pages[0].blocks.map(b=>b.text)};
  await rotationModel.proxy.loadingTask.destroy(); await rotationOutput.proxy.loadingTask.destroy(); await deletion.proxy.loadingTask.destroy();
  return {formResult,rotationResult};
})()`)
assert.ok(structures.formResult.editable)
assert.deepEqual(structures.formResult.pageOne, ['Shared form updated','Shared form original'])
assert.deepEqual(structures.formResult.pageTwo, ['Shared form original','Shared form original'])
assert.equal(structures.rotationResult.rotation,90)
assert.deepEqual(structures.rotationResult.after.find(b=>b.text==='Adjacent').transform, structures.rotationResult.before.find(b=>b.text==='Adjacent').transform)
assert.deepEqual(structures.rotationResult.deleted, ['Adjacent'])
const alignment = await evaluate(`(async () => {
  const engine = await import('/src/pdfEngine.ts');
  const {PDFDocument,StandardFonts,PDFName,degrees} = await import('/node_modules/.vite/deps/pdf-lib.js');
  const native = await PDFDocument.create(); const font = await native.embedFont(StandardFonts.Helvetica); const nextFont = await native.embedFont(StandardFonts.Courier);
  const page = native.addPage([420,360]); page.node.set(PDFName.of('Resources'),native.context.obj({Font:{F1:font.ref,F2:nextFont.ref}}));
  const stream = ['BT /F1 16 Tf 0.7 Tc 1.5 Tw 24 TL 1 0 0 1 36 300 Tm (Alpha beta) Tj /F2 16 Tf (Adjacent) Tj /F1 16 Tf (Second line)',String.fromCharCode(39),'2 0.3 (Third line)',String.fromCharCode(34),'(Last line)',String.fromCharCode(39),'ET'].join(' ');
  page.node.set(PDFName.of('Contents'),native.context.register(native.context.stream(stream)));
  const model = await engine.openDocument(new Uint8Array(await native.save()));
  const first = model.pages[0].blocks.find(b=>b.text==='Alpha beta'); const third = model.pages[0].blocks.find(b=>b.text==='Third line');
  const longFirst = 'Alpha beta with a considerably longer replacement that must stay inside this line';
  const longThird = 'Third line with more text that must never overlap the line below';
  const edits = {[first.id]:longFirst,[third.id]:longThird};
  const bytes = await engine.exportDocument(model,edits); const output = await engine.openDocument(bytes);
  const rows = model.pages[0].blocks.map(original=>{
    const text = edits[original.id] ?? original.text;
    const saved = output.pages[0].blocks.find(b=>b.text===text);
    const predicted = edits[original.id]!==undefined ? engine.layoutText(model.pages[0],original,text) : null;
    return {original:original.text,text,found:!!saved,oldWidth:original.item.width,newWidth:saved?.item.width,before:original.item.transform,after:saved?.item.transform,predictedWidth:predicted?.width,slot:predicted?.availableWidth};
  });
  const geometry = output.pages[0].blocks.map(block=>engine.textGeometry(output.pages[0],block));
  const edge = await PDFDocument.create(); const edgeFont = await edge.embedFont(StandardFonts.Helvetica);
  const edgePage = edge.addPage([420,360]); edgePage.drawText('Edge',{x:390,y:20,size:16,font:edgeFont});
  const edgeModel = await engine.openDocument(new Uint8Array(await edge.save())); const edgeBlock = edgeModel.pages[0].blocks[0];
  const edgeBytes = await engine.exportDocument(edgeModel,{[edgeBlock.id]:'Longer edge text stays on the page'}); const edgeOutput = await engine.openDocument(edgeBytes);
  const edgeGeometry = engine.textGeometry(edgeOutput.pages[0],edgeOutput.pages[0].blocks[0]);
  const rotated = await PDFDocument.create(); const rotatedFont = await rotated.embedFont(StandardFonts.Helvetica);
  const rotatedPage = rotated.addPage([450,600]); rotatedPage.setCropBox(30,40,390,520); rotatedPage.setRotation(degrees(90));
  rotatedPage.drawText('Rotated line',{x:55,y:480,size:18,font:rotatedFont}); rotatedPage.drawText('Neighbor stays',{x:55,y:450,size:18,font:rotatedFont});
  const rotatedModel = await engine.openDocument(new Uint8Array(await rotated.save())); const rotatedBlock = rotatedModel.pages[0].blocks[0];
  const rotatedText = 'A substantially longer line of text on a rotated and cropped page';
  const rotatedOutput = await engine.openDocument(await engine.exportDocument(rotatedModel,{[rotatedBlock.id]:rotatedText}));
  const rotatedGeometry = engine.textGeometry(rotatedOutput.pages[0],rotatedOutput.pages[0].blocks.find(b=>b.text===rotatedText));
  const rotationHit = engine.hitTestText(rotatedModel.pages[0],{[rotatedBlock.id]:rotatedText},rotatedGeometry.left+rotatedGeometry.right[0]*rotatedGeometry.width/2+rotatedGeometry.down[0]*rotatedGeometry.height/2,rotatedGeometry.top+rotatedGeometry.right[1]*rotatedGeometry.width/2+rotatedGeometry.down[1]*rotatedGeometry.height/2)?.id===rotatedBlock.id;
  const result = {rows,geometry,width:420,height:360,edgeGeometry,rotatedGeometry,rotatedPage:{width:rotatedOutput.pages[0].width,height:rotatedOutput.pages[0].height},rotationHit,originalBytes:Array.from(model.bytes),editedBytes:Array.from(bytes)};
  for(const doc of [model,output,edgeModel,edgeOutput,rotatedModel,rotatedOutput]) await doc.proxy.loadingTask.destroy();
  return result;
})()`)
for (const row of alignment.rows) {
  assert.ok(row.found, 'The full replacement must survive export without truncation: '+row.original)
  assert.ok(row.after.slice(4).every((value,index)=>Math.abs(value-row.before[index+4])<.001),'Baselines and later text positions must not move: '+row.original)
  if (row.slot !== undefined) { assert.ok(row.newWidth <= row.slot+.02, 'Replacement exceeds its safe slot: '+JSON.stringify(row)); assert.ok(Math.abs(row.newWidth-row.predictedWidth)<.02,'Preview and actual PDF widths differ: '+JSON.stringify(row)) }
  else { assert.ok(row.after.every((value,index)=>Math.abs(value-row.before[index])<.001)); assert.ok(Math.abs(row.newWidth-row.oldWidth)<.02,'Fitting must restore character and word spacing') }
}
function assertInside(geometry,width,height) {
  for(const [x,y] of [[0,0],[geometry.width,0],[0,geometry.height],[geometry.width,geometry.height]]) {
    const px=geometry.left+geometry.right[0]*x+geometry.down[0]*y, py=geometry.top+geometry.right[1]*x+geometry.down[1]*y;
    assert.ok(px>=-.02 && py>=-.02 && px<=width+.02 && py<=height+.02,`Text escaped the page: ${px}, ${py}`)
  }
}
alignment.geometry.forEach(geometry=>assertInside(geometry,alignment.width,alignment.height))
assertInside(alignment.edgeGeometry,alignment.width,alignment.height)
assertInside(alignment.rotatedGeometry,alignment.rotatedPage.width,alignment.rotatedPage.height)
assert.ok(alignment.rotationHit, 'Rotated edited text must remain selectable.')
await writeFile('test-results/alignment-original.pdf',new Uint8Array(alignment.originalBytes))
await writeFile('test-results/alignment-edited.pdf',new Uint8Array(alignment.editedBytes))
delete alignment.originalBytes; delete alignment.editedBytes
// Duplicate font resources are common in offer letters exported from Word.
// Different resource/map identities must not lock a line rendered in one font.
const offerLetter = await evaluate(`(async()=>{
  const e=await import('/src/pdfEngine.ts');const p=await import('/node_modules/.vite/deps/pdf-lib.js');
  const doc=await p.PDFDocument.create();const firstFont=await doc.embedFont(p.StandardFonts.TimesRomanBold),aliasFont=await doc.embedFont(p.StandardFonts.TimesRomanBold);
  const page=doc.addPage([595,842]);page.node.set(p.PDFName.of('Resources'),doc.context.obj({Font:{F1:firstFont.ref,F2:aliasFont.ref}}));
  page.node.set(p.PDFName.of('Contents'),doc.context.register(doc.context.stream('BT /F1 18 Tf 1 0 0 1 40 700 Tm (Dated: ) Tj /F2 18 Tf (10th June 2026) Tj 0 -40 Td (Dear Mayank Kumar,) Tj 0 -40 Td (We are pleased to extend our offer of employment.) Tj ET')));
  const model=await e.openDocument(new Uint8Array(await doc.save()));const date=model.pages[0].blocks.find(b=>b.text==='Dated: 10th June 2026');const greeting=model.pages[0].blocks.find(b=>b.text==='Dear Mayank Kumar,');
  if(!date.editable)throw new Error('Duplicate-font date still locked: '+JSON.stringify(date));
  const output=await e.openDocument(await e.exportDocument(model,{[date.id]:'Dated: 12th June 2026',[greeting.id]:'Dear Amit Kumar,'}));
  const result={before:model.pages[0].blocks.map(b=>({text:b.text,editable:b.editable})),after:output.pages[0].blocks.map(b=>({text:b.text,font:b.font})),bytes:Array.from(model.bytes)};
  await model.proxy.loadingTask.destroy();await output.proxy.loadingTask.destroy();return result;
})()`)
assert.ok(offerLetter.before.every(block=>block.editable))
assert.ok(offerLetter.after.some(block=>block.text==='Dated: 12th June 2026' && block.font==='Times-Bold'))
assert.ok(offerLetter.after.some(block=>block.text==='Dear Amit Kumar,' && block.font==='Times-Bold'))
await writeFile('test-results/offer-letter-aliases.pdf',new Uint8Array(offerLetter.bytes))
delete offerLetter.bytes
// Exercise real double-clicks after zooming, then leave selection for the next edit.
for (const percent of [25,200]) {
  await evaluate(`(() => {const select=document.querySelector('[aria-label="Zoom level"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(String(percent))});select.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  await until(`document.querySelector('.document-canvas')?.dataset.renderState==='ready'`)
  await click('Edit text: font sample Original')
  assert.equal(await evaluate(`document.activeElement?.className`),'inline-text-input')
  assert.equal(await evaluate(`document.querySelector('.inline-text-input').selectionEnd`),'font sample Original'.length)
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'})
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'})
}
const offerDom=await send('DOM.getDocument');const offerInput=await send('DOM.querySelector',{nodeId:offerDom.root.nodeId,selector:'#file-upload'});
await send('DOM.setFileInputFiles',{nodeId:offerInput.nodeId,files:[resolve('test-results/offer-letter-aliases.pdf')]});
await activateLayout('offer-letter-aliases-edited.pdf')
await until(`document.querySelector('[aria-label="Edit text: Dated: 10th June 2026"]') && !document.querySelector('.loading-overlay') && document.querySelector('.document-canvas')?.dataset.renderState==='ready'`)
assert.equal(await evaluate(`document.querySelector('[aria-label="Edit text: Dated: 10th June 2026"]').classList.contains('locked')`),false)
await click('Edit text: Dated: 10th June 2026')
assert.equal(await evaluate(`document.activeElement?.className`),'inline-text-input')
await fill('Dated: 12th June 2026');await evaluate(`document.querySelector('.apply-button').click()`)
await until(`document.querySelector('[aria-label="Edit text: Dated: 12th June 2026"]') && !document.body.innerText.includes('Updating preview') && document.querySelector('.document-canvas')?.dataset.renderState==='ready'`)
await click('Edit text: Dear Mayank Kumar,')
assert.equal(await evaluate(`document.activeElement?.className`),'inline-text-input')
await screenshot('offer-letter-edit.png')
// A previously unsupported inline-image stream must still permit bold editing.
// Its native parser cannot link the text, so exercise the entire fallback save.
const fallback = await evaluate(`(async()=>{
  const e=await import('/src/pdfEngine.ts');const p=await import('/node_modules/.vite/deps/pdf-lib.js');
  const doc=await p.PDFDocument.create();const bold=await doc.embedFont(p.StandardFonts.TimesRomanBold);const regular=await doc.embedFont(p.StandardFonts.Helvetica);
  const page=doc.addPage([595,842]);page.node.set(p.PDFName.of('Resources'),doc.context.obj({Font:{F1:bold.ref,F2:regular.ref}}));
  const source='q 8 0 0 8 20 760 cm BI /W 1 /H 1 /BPC 8 /CS /RGB ID '+String.fromCharCode(255,0,0)+' EI Q\\n0.9 0.94 1 rg 20 650 480 90 re f\\nBT /F1 18 Tf 0.2 0.3 0.5 rg 1 0 0 1 40 700 Tm (Dated: 10th June 2026) Tj /F2 12 Tf 0 0 0 rg 1 0 0 1 40 610 Tm (Keep adjacent text unchanged.) Tj ET';
  page.node.set(p.PDFName.of('Contents'),doc.context.register(doc.context.stream(source)));
  const bytes=new Uint8Array(await doc.save());const model=await e.openDocument(bytes);const date=model.pages[0].blocks.find(b=>b.text==='Dated: 10th June 2026');
  if(!date || !date.editable || date.native)throw new Error('Expected editable bold fallback: '+JSON.stringify(model.pages[0].blocks));
  const edits={[date.id]:'Dated: 12th June 2026 - Confirmed'};
  const predicted=e.layoutText(model.pages[0],date,edits[date.id]);
  const saved=await e.exportDocument(model,edits);const output=await e.openDocument(saved);
  const edited=output.pages[0].blocks.find(b=>b.text===edits[date.id]);
  const second=await e.openDocument(await e.exportDocument(output,{[edited.id]:'Dated: 15th June 2026'}));
  const deleted=await e.openDocument(await e.exportDocument(model,{[date.id]:''}));
  const deletedPage=await deleted.proxy.getPage(1);const deletedCanvas=document.createElement('canvas');deletedCanvas.width=595;deletedCanvas.height=842;const ctx=deletedCanvas.getContext('2d');await deletedPage.render({canvas:deletedCanvas,canvasContext:ctx,viewport:deletedPage.getViewport({scale:1})}).promise;
  const region=ctx.getImageData(39,120,180,30).data;let oldInk=0;for(let i=0;i<region.length;i+=4)if(region[i]<220 || region[i+1]<230 || region[i+2]<245)oldInk++;
  const result={before:model.pages[0].blocks.map(b=>({text:b.text,font:b.font,native:b.native,editable:b.editable})),after:output.pages[0].blocks.map(b=>({text:b.text,font:b.font,width:b.item.width,transform:b.item.transform})),second:second.pages[0].blocks.map(b=>b.text),deleted:deleted.pages[0].blocks.map(b=>b.text),oldInk,predictedWidth:predicted.width,bytes:Array.from(bytes),saved:Array.from(saved)};
  for(const value of [model,output,second,deleted])await value.proxy.loadingTask.destroy();return result;
})()`)
assert.ok(fallback.before.every(block=>block.editable))
const fallbackDate=fallback.after.find(block=>block.text==='Dated: 12th June 2026 - Confirmed')
assert.ok(fallbackDate && /Bold/.test(fallbackDate.font),'Fallback must retain bold styling.')
assert.ok(Math.abs(fallbackDate.width-fallback.predictedWidth)<.03,'Fallback fit must match exported width.')
assert.ok(!fallback.after.some(block=>block.text==='Dated: 10th June 2026'),'Old text must be removed from saved PDF.')
assert.ok(fallback.after.some(block=>block.text==='Keep adjacent text unchanged.'))
assert.ok(fallback.second.includes('Dated: 15th June 2026'),'Reopened fallback exports must remain editable.')
assert.ok(!fallback.deleted.includes('Dated: 10th June 2026'))
assert.equal(fallback.oldInk,0,'Deleted text must disappear visually, including the original pixels.')
await writeFile('test-results/bold-fallback.pdf',new Uint8Array(fallback.bytes))
await writeFile('test-results/bold-fallback-edited.pdf',new Uint8Array(fallback.saved))
delete fallback.bytes;delete fallback.saved
const fallbackDom=await send('DOM.getDocument');const fallbackInput=await send('DOM.querySelector',{nodeId:fallbackDom.root.nodeId,selector:'#file-upload'});
await send('DOM.setFileInputFiles',{nodeId:fallbackInput.nodeId,files:[resolve('test-results/bold-fallback.pdf')]});
await activateLayout('bold-fallback-edited.pdf')
await until(`document.querySelector('[aria-label="Edit text: Dated: 10th June 2026"]') && !document.querySelector('.loading-overlay') && document.querySelector('.document-canvas')?.dataset.renderState==='ready'`)
assert.equal(await evaluate(`document.querySelectorAll('.text-target.locked').length`),0)
await click('Edit text: Dated: 10th June 2026')
assert.equal(await evaluate(`document.activeElement?.className`),'inline-text-input')
assert.equal(await evaluate(`document.querySelector('#text-value').disabled`),false)
await fill('Dated: 12th June 2026 - Confirmed');await evaluate(`document.querySelector('.apply-button').click()`)
await until(`document.querySelector('[aria-label="Edit text: Dated: 12th June 2026 - Confirmed"]') && !document.body.innerText.includes('Updating preview') && document.querySelector('.document-canvas')?.dataset.renderState==='ready'`)
await screenshot('bold-fallback-edit.png')
// Enlarging the box must restore the original size in both native and fallback exports.
const resized = await evaluate(`(async()=>{
  const e=await import('/src/pdfEngine.ts');const p=await import('/node_modules/.vite/deps/pdf-lib.js');
  const doc=await p.PDFDocument.create();const font=await doc.embedFont(p.StandardFonts.TimesRomanBold);const page=doc.addPage([595,842]);
  page.drawText('Dear Mayank Kumar,',{x:40,y:700,size:18,font});page.drawText('Next line stays.',{x:40,y:660,size:18,font});
  page.drawText('Column',{x:40,y:600,size:18,font});page.drawText('Neighbor',{x:210,y:600,size:18,font});
  const model=await e.openDocument(new Uint8Array(await doc.save()));const greeting=model.pages[0].blocks[0];const long='Dear Mayank Pratap Singh Kumar,';
  const small=e.layoutText(model.pages[0],greeting,long);const size=e.resizeTextBox(model.pages[0],greeting,{width:400,height:26});const boxes={[greeting.id]:size};
  const large=e.layoutText(model.pages[0],greeting,long,size,boxes);const output=await e.openDocument(await e.exportDocument(model,{[greeting.id]:long},boxes));
  const enlarged=output.pages[0].blocks.find(b=>b.text===long);const safe=e.resizeTextBox(model.pages[0],greeting,{width:10000,height:10000});
  const column=model.pages[0].blocks.find(b=>b.text==='Column');const columnSize=e.resizeTextBox(model.pages[0],column,{width:1000,height:20});
  const raw=new Uint8Array(await (await fetch('/test-results/bold-fallback.pdf')).arrayBuffer());const fallbackModel=await e.openDocument(raw);const date=fallbackModel.pages[0].blocks[0];const dateBoxes={[date.id]:e.resizeTextBox(fallbackModel.pages[0],date,{width:450,height:30})};
  const fallbackOutput=await e.openDocument(await e.exportDocument(fallbackModel,{[date.id]:'Dated: 12th June 2026 - Confirmed'},dateBoxes));const fallbackDate=fallbackOutput.pages[0].blocks[0];
  const result={smallFont:small.fontSize,largeFont:large.fontSize,size,safe,columnSize,largeGeometry:large.geometry,exportedFontSize:Math.hypot(enlarged.item.transform[2],enlarged.item.transform[3]),exportedFont:enlarged.font,exportedWidth:enlarged.item.width,baseline:enlarged.item.transform.slice(4),neighborBefore:model.pages[0].blocks[1].item.transform,neighborAfter:output.pages[0].blocks.find(b=>b.text==='Next line stays.').item.transform,fallbackFontSize:Math.hypot(fallbackDate.item.transform[2],fallbackDate.item.transform[3])};
  for(const value of [model,output,fallbackModel,fallbackOutput])await value.proxy.loadingTask.destroy();return result;
})()`)
assert.ok(resized.smallFont<18)
assert.equal(resized.largeFont,18)
assert.equal(resized.exportedFontSize,18)
assert.equal(resized.exportedFont,'Times-Bold')
assert.deepEqual(resized.baseline,[40,700])
assert.deepEqual(resized.neighborAfter,resized.neighborBefore)
assert.ok(resized.safe.width<=555.01 && resized.safe.height<40,'Resized box must stop at the page and next line.')
assert.ok(resized.columnSize.width<=169.25,'Resized box must stop before the next column.')
assert.equal(resized.fallbackFontSize,18)
assertInside(resized.largeGeometry,595,842)
// Real pointer dragging at 50% zoom must use document units, not screen pixels.
const resizeDom=await send('DOM.getDocument');const resizeInput=await send('DOM.querySelector',{nodeId:resizeDom.root.nodeId,selector:'#file-upload'});
await send('DOM.setFileInputFiles',{nodeId:resizeInput.nodeId,files:[resolve('test-results/offer-letter-aliases.pdf')]});
await activateLayout('offer-letter-aliases-edited.pdf')
await until(`document.querySelector('[aria-label="Edit text: Dear Mayank Kumar,"]') && !document.querySelector('.loading-overlay') && document.querySelector('.document-canvas')?.dataset.renderState==='ready'`)
await evaluate(`(() => {const select=document.querySelector('[aria-label="Zoom level"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'50');select.dispatchEvent(new Event('change',{bubbles:true}));})()`)
await until(`document.querySelector('.document-canvas')?.dataset.renderState==='ready'`)
await click('Edit text: Dear Mayank Kumar,')
await fill('Dear Mayank Pratap Singh Kumar,')
const originalBoxWidth=await evaluate(`Number(document.querySelector('[aria-label="Text box width"]').value)`)
await dragHandle('Resize text box width',110,0)
const enlargedBoxWidth=await evaluate(`Number(document.querySelector('[aria-label="Text box width"]').value)`)
assert.ok(Math.abs(enlargedBoxWidth-originalBoxWidth-220)<.2,`50% zoom drag must enlarge by 220 PDF points: ${originalBoxWidth} -> ${enlargedBoxWidth}`)
assert.ok(await evaluate(`document.querySelector('.font-card').innerText.includes('18.0 pt')`),'Widening must restore original font size immediately.')
await dragHandle('Resize text box',20,5)
assert.ok(await evaluate(`Number(document.querySelector('[aria-label="Text box height"]').value)>18`))
const committedBoxWidth=await evaluate(`Number(document.querySelector('[aria-label="Text box width"]').value)`)
await evaluate(`document.querySelector('.apply-button').click()`)
await until(`document.querySelector('[aria-label="Edit text: Dear Mayank Pratap Singh Kumar,"]') && !document.body.innerText.includes('Updating preview') && document.querySelector('.document-canvas')?.dataset.renderState==='ready'`)
await click('Undo');await until(`document.querySelector('[aria-label="Edit text: Dear Mayank Kumar,"]') && !document.body.innerText.includes('Updating preview')`)
await click('Redo');await until(`document.querySelector('[aria-label="Edit text: Dear Mayank Pratap Singh Kumar,"]') && !document.body.innerText.includes('Updating preview')`)
await click('Edit text: Dear Mayank Pratap Singh Kumar,')
assert.equal(await evaluate(`Number(document.querySelector('[aria-label="Text box width"]').value)`),committedBoxWidth)
await screenshot('resized-name.png')
const resizeDownloadName=`resized-${Date.now()}.pdf`
await evaluate(`(() => {const input=document.querySelector('[aria-label="Download filename"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(resizeDownloadName)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
await evaluate(`document.querySelector('.app-header .primary').click()`)
await until(`document.body.innerText.includes('Your edited PDF is ready')`)
let resizedDownload
for(let attempt=0;attempt<30;attempt++){try{resizedDownload=await readFile(resolve('test-results',resizeDownloadName));break}catch{await new Promise(resolve=>setTimeout(resolve,100))}}
assert.ok(resizedDownload)
const resizedSaved=await evaluate(`(async()=>{const e=await import('/src/pdfEngine.ts');const model=await e.openDocument(Uint8Array.from(atob(${JSON.stringify(resizedDownload?.toString('base64'))}),c=>c.charCodeAt(0)));const name=model.pages[0].blocks.find(b=>b.text==='Dear Mayank Pratap Singh Kumar,');const result={font:name.font,size:Math.hypot(name.item.transform[2],name.item.transform[3]),width:name.item.width,baseline:name.item.transform.slice(4)};await model.proxy.loadingTask.destroy();return result})()`)
assert.equal(resizedSaved.size,18)
assert.equal(resizedSaved.font,'Times-Bold')
assert.ok(resizedSaved.width<=committedBoxWidth+.02)
const formatting = await evaluate(`(async()=>{
  const e=await import('/src/pdfEngine.ts');const p=await import('/node_modules/.vite/deps/pdf-lib.js');const js=await import('/node_modules/.vite/deps/pdfjs-dist.js');
  const doc=await p.PDFDocument.create();const font=await doc.embedFont(p.StandardFonts.TimesRoman);const page=doc.addPage([595,842]);page.drawText('Style sample',{x:40,y:700,size:18,font,color:p.rgb(.125,.25,.5)});page.drawText('Neighbor stays',{x:40,y:660,size:18,font});
  const model=await e.openDocument(new Uint8Array(await doc.save()));const block=model.pages[0].blocks[0];const boxes={[block.id]:{width:240,height:30}};const styles={[block.id]:{bold:true,italic:true,underline:true,strike:true,fontSize:20,color:'#cc2255'}};
  const bytes=await e.exportDocument(model,{},boxes,styles);const output=await e.openDocument(bytes);const edited=output.pages[0].blocks.find(b=>b.text==='Style sample');
  const ops=await(await output.proxy.getPage(1)).getOperatorList();const strokes=ops.fnArray.filter(fn=>fn===js.OPS.stroke || fn===js.OPS.constructPath).length;
  const clear=await e.openDocument(await e.exportDocument(output,{}, {}, {[edited.id]:{underline:false,strike:false}}));const cleared=clear.pages[0].blocks.find(b=>b.text==='Style sample');const clearOps=await(await clear.proxy.getPage(1)).getOperatorList();const clearedStrokes=clearOps.fnArray.filter(fn=>fn===js.OPS.stroke || fn===js.OPS.constructPath).length;
  const fallback=await e.openDocument(new Uint8Array(await(await fetch('/test-results/bold-fallback.pdf')).arrayBuffer()));const date=fallback.pages[0].blocks[0];const fallbackStyles={[date.id]:{bold:false,italic:true,underline:true,color:'#008877'}};const fallbackBytes=await e.exportDocument(fallback,{}, {[date.id]:{width:450,height:30}},fallbackStyles);const fallbackOut=await e.openDocument(fallbackBytes);
  const result={originalColor:block.originalFormat.color,font:edited.font,size:Math.hypot(edited.item.transform[2],edited.item.transform[3]),format:edited.originalFormat,baseline:edited.item.transform.slice(4),neighborBefore:model.pages[0].blocks[1].item.transform,neighborAfter:output.pages[0].blocks.find(b=>b.text==='Neighbor stays').item.transform,strokes,clearedStrokes,cleared:cleared.originalFormat,fallbackFont:fallbackOut.pages[0].blocks[0].font,fallbackFormat:fallbackOut.pages[0].blocks[0].originalFormat,bytes:Array.from(bytes)};
  for(const d of [model,output,clear,fallback,fallbackOut])await d.proxy.loadingTask.destroy();return result;
})()`)
assert.equal(formatting.font,'Times-BoldItalic')
assert.equal(formatting.size,20)
assert.equal(formatting.format.bold,true)
assert.equal(formatting.format.italic,true)
assert.equal(formatting.format.underline,true)
assert.equal(formatting.format.strike,true)
assert.equal(formatting.format.color,'#cc2255')
assert.deepEqual(formatting.baseline,[40,700])
assert.deepEqual(formatting.neighborAfter,formatting.neighborBefore)
assert.ok(formatting.strokes>0)
assert.equal(formatting.clearedStrokes,0,'Turning decorations off must remove their real PDF drawing operations.')
assert.equal(formatting.cleared.underline,false)
assert.equal(formatting.cleared.strike,false)
assert.equal(formatting.fallbackFont,'Times-Italic')
assert.equal(formatting.fallbackFormat.underline,true)
assert.equal(formatting.fallbackFormat.color,'#008877')
await writeFile('test-results/formatted-text.pdf',new Uint8Array(formatting.bytes));delete formatting.bytes
// Existing bold formatting is reflected in the toolbar; new styles survive save.
assert.equal(await evaluate(`document.querySelector('[aria-label="Bold"]').getAttribute('aria-pressed')`),'true')
await click('Italic');await click('Underline');await click('Strikethrough')
await evaluate(`(() => {const input=document.querySelector('[aria-label="Text colour"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'#cc2255');input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`)
await evaluate(`(() => {const input=document.querySelector('[aria-label="Font size"]');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'20');input.dispatchEvent(new Event('input',{bubbles:true}));input.blur();})()`)
await evaluate(`document.querySelector('.apply-button').click()`)
await until(`!document.body.innerText.includes('Updating preview') && document.querySelector('.document-canvas')?.dataset.renderState==='ready' && document.querySelector('.apply-button').disabled`)
await screenshot('formatting-options.png')
await click('Undo');await until(`!document.body.innerText.includes('Updating preview')`);await click('Edit text: Dear Mayank Pratap Singh Kumar,')
assert.equal(await evaluate(`document.querySelector('[aria-label="Italic"]').getAttribute('aria-pressed')`),'false')
await click('Redo');await until(`!document.body.innerText.includes('Updating preview')`);await click('Edit text: Dear Mayank Pratap Singh Kumar,')
assert.equal(await evaluate(`document.querySelector('[aria-label="Italic"]').getAttribute('aria-pressed')`),'true')
const formatDownloadName=`formatted-${Date.now()}.pdf`
await evaluate(`(() => {const input=document.querySelector('[aria-label="Download filename"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(formatDownloadName)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
await evaluate(`document.querySelector('.app-header .primary').click()`);await until(`document.body.innerText.includes('Your edited PDF is ready')`)
let formatDownload
for(let attempt=0;attempt<30;attempt++){try{formatDownload=await readFile(resolve('test-results',formatDownloadName));break}catch{await new Promise(resolve=>setTimeout(resolve,100))}}
assert.ok(formatDownload)
const formatSaved=await evaluate(`(async()=>{const e=await import('/src/pdfEngine.ts');const doc=await e.openDocument(Uint8Array.from(atob(${JSON.stringify(formatDownload?.toString('base64'))}),c=>c.charCodeAt(0)));const block=doc.pages[0].blocks.find(b=>b.text==='Dear Mayank Pratap Singh Kumar,');const result={font:block.font,format:block.originalFormat};await doc.proxy.loadingTask.destroy();return result})()`)
assert.equal(formatSaved.font,'Times-BoldItalic')
assert.equal(formatSaved.format.fontSize,20)
assert.equal(formatSaved.format.color,'#cc2255')
assert.equal(formatSaved.format.underline,true)
assert.equal(formatSaved.format.strike,true)
// Audit regressions: preserve TJ kerning for decoration-only edits and reserve enlarged neighbors.
const audit = await evaluate(`(async()=>{
  const e=await import('/src/pdfEngine.ts');const p=await import('/node_modules/.vite/deps/pdf-lib.js');const js=await import('/node_modules/.vite/deps/pdfjs-dist.js');
  const d=await p.PDFDocument.create();const f=await d.embedFont(p.StandardFonts.TimesRoman);const page=d.addPage([595,842]);
  page.node.set(p.PDFName.of('Resources'),d.context.obj({Font:{F:f.ref}}));
  page.node.addContentStream(d.context.register(d.context.flateStream('BT /F 18 Tf 1 0 0 1 40 700 Tm [(AV) -300 (ATAR)] TJ ET BT /F 18 Tf 1 0 0 1 40 674 Tm (Second line) Tj ET')));
  const model=await e.openDocument(new Uint8Array(await d.save()));const a=model.pages[0].blocks[0],b=model.pages[0].blocks[1];
  const decorated=await e.openDocument(await e.exportDocument(model,{}, {},{[a.id]:{underline:true}}));
  const glyphs=async(doc)=>{const ops=await(await doc.proxy.getPage(1)).getOperatorList();return ops.argsArray[ops.fnArray.indexOf(js.OPS.showText)][0].map(x=>typeof x==='number'?x:{unicode:x.unicode,width:x.width})};
  const boxes={[a.id]:{width:300,height:30},[b.id]:{width:300,height:30}};const formats={[a.id]:{fontSize:50},[b.id]:{fontSize:50}};
  const expanded=await e.openDocument(await e.exportDocument(model,{},boxes,formats));const ga=e.textGeometry(expanded.pages[0],expanded.pages[0].blocks[0]),gb=e.textGeometry(expanded.pages[0],expanded.pages[0].blocks[1]);
  const result={originalWidth:a.item.width,decoratedWidth:decorated.pages[0].blocks[0].item.width,originalGlyphs:await glyphs(model),decoratedGlyphs:await glyphs(decorated),originalBaselines:model.pages[0].blocks.map(b=>b.item.transform.slice(4)),expandedBaselines:expanded.pages[0].blocks.map(b=>b.item.transform.slice(4)),firstBottom:ga.top+ga.height,secondTop:gb.top};
  for(const doc of [model,decorated,expanded])await doc.proxy.loadingTask.destroy();return result;
})()`)
assert.equal(audit.decoratedWidth,audit.originalWidth,'Underline must not reshape the original text.')
assert.deepEqual(audit.decoratedGlyphs,audit.originalGlyphs,'Preserve every original TJ spacing adjustment.')
assert.deepEqual(audit.expandedBaselines,audit.originalBaselines)
assert.ok(audit.firstBottom<=audit.secondTop-.5,'Two enlarged lines must not overlap.')
// Simply focusing a rounded dimension field must not modify a precise stored box.
await evaluate(`document.querySelector('[aria-label="Text box width"]').focus();document.querySelector('[aria-label="Text box width"]').blur()`)
assert.equal(await evaluate(`document.querySelector('.apply-button').disabled`),true)
// A font size being typed must be included by Ctrl+S without requiring blur.
const numericDownloadName=`numeric-${Date.now()}.pdf`
await evaluate(`(() => {const input=document.querySelector('[aria-label="Download filename"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(numericDownloadName)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
await evaluate(`(() => {const input=document.querySelector('[aria-label="Font size"]');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'22');input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
await new Promise(resolve=>setTimeout(resolve,80))
assert.equal(await evaluate(`document.activeElement.getAttribute('aria-label')`),'Font size','Typing must not lose focus to the inline editor.')
await send('Input.dispatchKeyEvent',{type:'keyDown',key:'s',code:'KeyS',modifiers:2})
await send('Input.dispatchKeyEvent',{type:'keyUp',key:'s',code:'KeyS',modifiers:2})
await until(`document.body.innerText.includes('Your edited PDF is ready') && !document.querySelector('.loading-overlay')`)
let numericDownload
for(let attempt=0;attempt<30;attempt++){try{numericDownload=await readFile(resolve('test-results',numericDownloadName));break}catch{await new Promise(resolve=>setTimeout(resolve,100))}}
assert.ok(numericDownload)
const numericSaved=await evaluate(`(async()=>{const e=await import('/src/pdfEngine.ts');const doc=await e.openDocument(Uint8Array.from(atob(${JSON.stringify(numericDownload.toString('base64'))}),c=>c.charCodeAt(0)));const b=doc.pages[0].blocks.find(b=>b.text==='Dear Mayank Pratap Singh Kumar,');const result=b.originalFormat.fontSize;await doc.proxy.loadingTask.destroy();return result})()`)
assert.equal(numericSaved,22,'Ctrl+S must save the pending numeric value.')
await until(`!document.body.innerText.includes('Updating preview') && document.querySelector('.document-canvas')?.dataset.renderState==='ready'`)
// Rapid undo/redo must keep the last live preview worker available.
await click('Undo');await click('Redo');await click('Undo');await click('Redo')
await until(`!document.body.innerText.includes('Updating preview') && document.querySelector('.document-canvas')?.dataset.renderState==='ready'`)
assert.equal(await evaluate(`!!document.querySelector('.toast.error')`),false)
// A corrupt upload must fail visibly while leaving the current document usable.
await writeFile('test-results/invalid-upload.pdf','This is not a PDF document.')
const invalidDom=await send('DOM.getDocument');const invalidInput=await send('DOM.querySelector',{nodeId:invalidDom.root.nodeId,selector:'#file-upload'});
await send('DOM.setFileInputFiles',{nodeId:invalidInput.nodeId,files:[resolve('test-results/invalid-upload.pdf')]});
await until(`document.body.innerText.includes('Could not open this PDF') && !document.querySelector('.loading-overlay')`)
assert.ok(await evaluate(`!!document.querySelector('[aria-label="Edit text: Dear Mayank Pratap Singh Kumar,"]')`),'Invalid upload must keep the previous document available.')
await click('Dismiss message')
await writeFile('test-results/verification.json', JSON.stringify({ engineResult, embedded, actualDownloadText, structures, alignment, offerLetter, fallback, resized, resizedSaved, formatting, formatSaved, audit, numericSaved, browserErrors }, null, 2))
assert.deepEqual(browserErrors, [])
console.log('PASS: real double-click selection at 25%/100%/200%, auto-fit, long text, columns, page edges, rotation/crop, PDF spacing restoration, download, fonts, multi-page edits, undo/redo, and browser console.')
} finally { await session.close() }
