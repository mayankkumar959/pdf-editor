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
async function dragHandle(label, dx, dy) {
  const point = await evaluate(`(() => { const element=document.querySelector('[aria-label=${JSON.stringify(label)}]');element.scrollIntoView({block:'center',inline:'nearest'});const rect=element.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}; })()`)
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1})
  for(let step=1;step<=4;step++) await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+dx*step/4,y:point.y+dy*step/4,button:'left',buttons:1})
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x+dx,y:point.y+dy,button:'left',clickCount:1})
  await new Promise(resolve=>setTimeout(resolve,120))
}
async function screenshot(filename) { const { data } = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(`test-results/${filename}`, Buffer.from(data, 'base64')) }

async function press(text) {
  await evaluate(`(() => {const button=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)});if(!button)throw new Error('Missing button: '+${JSON.stringify(text)});button.click()})()`)
  await new Promise(resolve=>setTimeout(resolve,80))
}
async function input(label, value) {
  await evaluate(`(() => {const input=document.querySelector('[aria-label=${JSON.stringify(label)}]');const prototype=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:input instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event(input instanceof HTMLSelectElement?'change':'input',{bubbles:true}))})()`)
  await new Promise(resolve=>setTimeout(resolve,80))
}
async function upload(selector, files) {
  const dom=await send('DOM.getDocument'),node=await send('DOM.querySelector',{nodeId:dom.root.nodeId,selector})
  await send('DOM.setFileInputFiles',{nodeId:node.nodeId,files:files.map(file=>resolve(file))})
}
async function downloaded(name) {
  for(let i=0;i<100;i++){try{return await readFile(resolve('test-results',name))}catch{await new Promise(resolve=>setTimeout(resolve,100))}}
  throw new Error('Download missing: '+name)
}
async function inspect(bytes) {
  return evaluate(`(async()=>{const e=await import('/src/pdfEngine.ts');const js=await import('/node_modules/.vite/deps/pdfjs-dist.js');const d=await e.openDocument(Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),c=>c.charCodeAt(0)));const pages=[];for(let i=0;i<d.pages.length;i++){const ops=await(await d.proxy.getPage(i+1)).getOperatorList();pages.push({texts:d.pages[i].blocks.map(b=>b.text),fonts:d.pages[i].blocks.map(b=>b.font),images:ops.fnArray.filter(fn=>fn===js.OPS.paintImageXObject||fn===js.OPS.paintInlineImageXObject).length})}await d.proxy.loadingTask.destroy();return pages})()`)
}
await mkdir('test-results',{recursive:true})
await send('Runtime.enable');await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false})
await send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:resolve('test-results')})
await send('Page.navigate',{url:base});await until(`document.querySelector('.demo-button')`)

// PDF coordinate transforms must agree with screen placement for every rotation.
const geometry=await evaluate(`(async()=>{
  const e=await import('/src/pdfEngine.ts'),t=await import('/src/documentTools.ts'),p=await import('/node_modules/.vite/deps/pdf-lib.js');await t.prepareObjectFonts();
  const canvas=document.createElement('canvas');canvas.width=80;canvas.height=40;const cx=canvas.getContext('2d');cx.fillStyle='#ff0000';cx.fillRect(0,0,40,40);cx.fillStyle='#0000ff';cx.fillRect(40,0,40,40);const data=canvas.toDataURL('image/png');
  const results=[];for(const rotation of [0,90,180,270]){
    const d=await p.PDFDocument.create();const page=d.addPage([600,800]);page.setCropBox(20,40,500,700);page.setRotation(p.degrees(rotation));page.drawText('Original page',{x:50,y:700,size:14});
    const original=await e.openDocument(new Uint8Array(await d.save()));const text={id:'text',page:0,kind:'text',x:45,y:100,width:220,height:80,text:'Added text\\nSecond line',family:'Helvetica',format:{fontSize:18,bold:true,color:'#224466'}};
    const image={id:'image',page:0,kind:'image',x:300,y:250,width:120,height:60,data,label:'test'};const output=await e.openDocument(await t.addObjects(original.bytes,original.pages,[text,image]));
    const added=output.pages[0].blocks.find(b=>b.text==='Added text');const g=e.textGeometry(output.pages[0],added);const outputPage=await output.proxy.getPage(1),viewport=outputPage.getViewport({scale:1});const view=document.createElement('canvas');view.width=viewport.width;view.height=viewport.height;await outputPage.render({canvas:view,viewport}).promise;const ctx=view.getContext('2d');
    results.push({rotation,baseline:g.baseline,right:g.right,down:g.down,texts:output.pages[0].blocks.map(b=>b.text),leftPixel:Array.from(ctx.getImageData(320,270,1,1).data),rightPixel:Array.from(ctx.getImageData(400,270,1,1).data)});view.width=0;await original.proxy.loadingTask.destroy();await output.proxy.loadingTask.destroy();
  }
  const extra=await p.PDFDocument.create();extra.addPage([595,842]).drawText('Extra document page',{x:50,y:700,size:20});
  let invalidRejected=false;try{t.parsePages('0,999',3)}catch{invalidRejected=true}
  return {results,image:data.split(',')[1],extra:Array.from(await extra.save()),range:t.parsePages('3,1-2,1',3),invalidRejected};
})()`)
for(const result of geometry.results){assert.ok(Math.abs(result.baseline[0]-50)<.01);assert.ok(Math.abs(result.baseline[1]-123)<.01);assert.deepEqual(result.right,[1,0]);assert.ok(result.texts.includes('Second line'));assert.deepEqual(result.leftPixel,[255,0,0,255]);assert.deepEqual(result.rightPixel,[0,0,255,255])}
assert.deepEqual(geometry.range,[2,0,1]);assert.equal(geometry.invalidRejected,true)
await writeFile('test-results/tools-image.png',Buffer.from(geometry.image,'base64'))
await writeFile('test-results/tools-extra.pdf',new Uint8Array(geometry.extra));delete geometry.image;delete geometry.extra

await evaluate(`document.querySelector('.demo-button').click()`)
await activateLayout('sample-edited.pdf')
await until(`document.querySelector('.document-canvas')?.dataset.renderState==='ready' && !document.querySelector('.loading-overlay')`)
await press('New text');await until(`document.querySelector('[aria-label="New text content"]') && !document.querySelector('.loading-overlay')`)
await input('New text content','Project update\nApproved')
await click('Bold');await input('Font size','18')
await input('Zoom level','50');await until(`document.querySelector('.document-canvas')?.dataset.renderState==='ready'`)
const beforeMove=await evaluate(`({x:Number(document.querySelector('[aria-label="Object X"]').value),y:Number(document.querySelector('[aria-label="Object Y"]').value)})`)
await dragHandle('Added text box',50,30)
const afterMove=await evaluate(`({x:Number(document.querySelector('[aria-label="Object X"]').value),y:Number(document.querySelector('[aria-label="Object Y"]').value)})`)
assert.ok(Math.abs(afterMove.x-beforeMove.x-100)<.1);assert.ok(Math.abs(afterMove.y-beforeMove.y-60)<.1)
const beforeResize=await evaluate(`Number(document.querySelector('[aria-label="Object width"]').value)`)
await dragHandle('Resize added object',40,10)
const afterResize=await evaluate(`Number(document.querySelector('[aria-label="Object width"]').value)`)
assert.ok(Math.abs(afterResize-beforeResize-80)<.1)
await click('Undo');await pointerClick('Added text box');assert.equal(await evaluate(`Number(document.querySelector('[aria-label="Object width"]').value)`),beforeResize)
await click('Redo');await pointerClick('Added text box');assert.equal(await evaluate(`Number(document.querySelector('[aria-label="Object width"]').value)`),afterResize)
await press('Image');await upload('[aria-label="Upload image or signature"]',['test-results/tools-image.png'])
await until(`document.querySelector('[aria-label="Image: tools-image.png"]') && !document.querySelector('.loading-overlay')`)
await input('Object X','350');await input('Object Y','300');await press('Apply object changes')
const imageRatio=await evaluate(`Number(document.querySelector('[aria-label="Object width"]').value)/Number(document.querySelector('[aria-label="Object height"]').value)`)
await dragHandle('Resize added object',20,10)
assert.ok(Math.abs(await evaluate(`Number(document.querySelector('[aria-label="Object width"]').value)/Number(document.querySelector('[aria-label="Object height"]').value)`)-imageRatio)<.01)
await press('Signature');await until(`document.querySelector('.signature-pad')`)
const pad=await evaluate(`(()=>{const r=document.querySelector('.signature-pad').getBoundingClientRect();return{x:r.x+50,y:r.y+70}})()`)
await send('Input.dispatchMouseEvent',{type:'mousePressed',...pad,button:'left',buttons:1,clickCount:1})
for(const [dx,dy]of[[30,-30],[50,20],[85,-20],[130,10],[170,-5]])await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:pad.x+dx,y:pad.y+dy,button:'left',buttons:1})
await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:pad.x+170,y:pad.y-5,button:'left',clickCount:1})
await press('Insert signature');await until(`document.querySelector('[aria-label="Signature: Drawn signature"]')`)
await input('Object X','120');await input('Object Y','400')
await screenshot('new-tools.png')
// Saving inline text must include pending objects and preserve multiline text.
await pointerClick('Added text box');await pointerClick('Added text box',2)
await until(`document.querySelector('[aria-label="Edit added text on page"]')`)
await input('Edit added text on page','Project update\nApproved today')
const stamp=Date.now(),name=`tools-${stamp}.pdf`
await input('Download filename',name)
await evaluate(`document.querySelector('[aria-label="Edit added text on page"]')?.focus()`)
await send('Input.dispatchKeyEvent',{type:'keyDown',key:'s',code:'KeyS',modifiers:2});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'s',code:'KeyS',modifiers:2})
const saved=await downloaded(name),savedPages=await inspect(saved)
assert.ok(savedPages[0].texts.includes('Project update'));assert.ok(savedPages[0].texts.includes('Approved today'));assert.equal(savedPages[0].images,2);assert.ok(savedPages[0].fonts.includes('Helvetica-Bold'))
await until(`!document.querySelector('.loading-overlay')`)
await press('Merge PDFs');await upload('[aria-label="Choose PDFs to merge"]',['test-results/tools-extra.pdf'])
await until(`document.querySelectorAll('.merge-file').length===2`)
await click('Move tools-extra.pdf up')
assert.ok(await evaluate(`document.querySelector('.merge-file').textContent.includes('tools-extra.pdf')`))
await press('Merge and open')
await until(`document.querySelectorAll('.page-thumbnail').length===3 && !document.querySelector('.loading-overlay') && !document.querySelector('dialog[open]')`)
await activateLayout('merged-edited.pdf')
assert.ok(await evaluate(`!!document.querySelector('[aria-label="Edit text: Extra document page"]')`))
await click('Go to page 2');await until(`document.querySelector('[aria-label="Edit text: Project update"]')`)
await input('Download filename',`merged-tools-${stamp}.pdf`)
await press('Split / extract');await input('Page ranges','0')
assert.equal(await evaluate(`[...document.querySelectorAll('dialog button')].find(b=>b.textContent==='Download extracted PDF').disabled`),true)
await input('Page ranges','2,1');await press('Download extracted PDF')
const extracted=await downloaded(`merged-tools-${stamp}-extracted.pdf`),extractedPages=await inspect(extracted)
assert.equal(extractedPages.length,2);assert.ok(extractedPages[0].texts.includes('Project update'));assert.equal(extractedPages[0].images,2);assert.ok(extractedPages[1].texts.includes('Extra document page'))
await until(`!document.querySelector('dialog[open]') && !document.querySelector('.loading-overlay')`)
await press('Split / extract');await input('Split mode','parts');await input('Page ranges','1;2-3');await press('Download split PDFs (ZIP)')
const zip=await downloaded(`merged-tools-${stamp}-split.zip`)
await writeFile('test-results/tools-split.zip',zip)
const zipPages=[];let offset=0
while(zip.readUInt32LE(offset)===0x04034b50){const length=zip.readUInt32LE(offset+18),nameLength=zip.readUInt16LE(offset+26),extraLength=zip.readUInt16LE(offset+28),start=offset+30+nameLength+extraLength;zipPages.push(await inspect(zip.subarray(start,start+length)));offset=start+length}
assert.equal(zipPages.length,2);assert.equal(zipPages[0].length,1);assert.equal(zipPages[1].length,2);assert.ok(zipPages[0][0].texts.includes('Extra document page'));assert.ok(zipPages[1][0].texts.includes('Project update'))
await screenshot('tools-merged.png')
assert.deepEqual(browserErrors,[])
await writeFile('test-results/tools-verification.json',JSON.stringify({geometry,beforeMove,afterMove,beforeResize,afterResize,imageRatio,savedPages,extractedPages,zipPageCounts:zipPages.map(p=>p.length),browserErrors},null,2))
console.log('PASS: new text, multiline formatting, pointer move/resize, undo/redo, image upload, signature drawing, actual save, all page rotations/crops, ordered merge, selected-page extraction and split ZIP.')
} finally { await session.close() }
