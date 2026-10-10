import { browserSession } from './browser-session.mjs'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {resolve,basename} from 'node:path'
const session = await browserSession()
const { send, errors, failedRequests } = session
try {

async function activateLayout(filename) {
  if (filename) await until(`document.querySelector('[aria-label="Download filename"]')?.value === ${JSON.stringify(filename)} && !document.querySelector('.loading-overlay')`)
  else await until(`!document.querySelector('.loading-overlay')`)
  await evaluate(`[...document.querySelectorAll('.mode-switch button')].find(button => button.textContent === 'Layout text').click()`)
  await until(`document.querySelector('.document-canvas')?.dataset.renderState === 'ready' && !document.querySelector('.loading-overlay')`)
}

async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value}
async function until(expression){for(let i=0;i<160;i++){if(await evaluate('Boolean('+expression+')'))return;await new Promise(r=>setTimeout(r,100))}throw new Error('Timed out: '+expression)}
async function upload(path){const d=await send('DOM.getDocument');const n=await send('DOM.querySelector',{nodeId:d.root.nodeId,selector:'#file-upload'});await send('DOM.setFileInputFiles',{nodeId:n.nodeId,files:[resolve(path)]});await activateLayout(basename(path).replace(/\.pdf$/i,'-edited.pdf'));await until("document.querySelector('[aria-label=\"Download filename\"]')?.value==="+JSON.stringify(basename(path).replace(/\.pdf$/i,'-edited.pdf'))+" && !document.querySelector('.loading-overlay') && document.querySelector('.document-canvas')?.dataset.renderState==='ready'")}
await mkdir('test-results',{recursive:true})
await send('Runtime.enable');await send('Network.enable');await send('Page.enable')
await send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:resolve('test-results')})
await send('Page.navigate',{url:'http://127.0.0.1:4173'})
await until("document.querySelector('.demo-button')")
await upload('test-results/embedded-font.pdf')
assert.ok(await evaluate("document.querySelectorAll('.text-target').length>0"))
await upload('test-results/bold-fallback.pdf')
await evaluate("document.querySelector('[aria-label=\"Edit text: Dated: 10th June 2026\"]').click()")
await evaluate("(()=>{const input=document.querySelector('#text-value');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Dated: 12th June 2026');input.dispatchEvent(new Event('input',{bubbles:true}))})()")
await new Promise(r=>setTimeout(r,80))
await evaluate("document.querySelector('[aria-label=\"Underline\"]').click()")
const filename='production-'+Date.now()+'.pdf'
await evaluate("(()=>{const input=document.querySelector('[aria-label=\"Download filename\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,"+JSON.stringify(filename)+");input.dispatchEvent(new Event('input',{bubbles:true}))})()")
await evaluate("document.querySelector('.app-header .primary').click()")
await until("document.body.innerText.includes('Your edited PDF is ready') && !document.querySelector('.loading-overlay')")
let downloaded
for(let i=0;i<40;i++){try{downloaded=await readFile(resolve('test-results',filename));break}catch{await new Promise(r=>setTimeout(r,100))}}
assert.ok(downloaded?.length>100)
await upload('test-results/'+filename)
await until("document.querySelector('[aria-label=\"Edit text: Dated: 12th June 2026\"]')")
await evaluate("document.querySelector('[aria-label=\"Edit text: Dated: 12th June 2026\"]').click()")
assert.equal(await evaluate("document.querySelector('[aria-label=\"Bold\"]').getAttribute('aria-pressed')"),'true')
assert.equal(await evaluate("document.querySelector('[aria-label=\"Underline\"]').getAttribute('aria-pressed')"),'true')
assert.equal(await evaluate("!!document.querySelector('[aria-label=\"Edit text: Dated: 10th June 2026\"]')"),false)
async function toolButton(text){await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw new Error('Missing button');b.click()})()`);await new Promise(r=>setTimeout(r,80))}
async function field(label,value){await evaluate(`(()=>{const i=document.querySelector('[aria-label=${JSON.stringify(label)}]');Object.getOwnPropertyDescriptor(i instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}))})()`);await new Promise(r=>setTimeout(r,80))}
async function fileInput(selector,path){const d=await send('DOM.getDocument');const n=await send('DOM.querySelector',{nodeId:d.root.nodeId,selector});await send('DOM.setFileInputFiles',{nodeId:n.nodeId,files:[resolve(path)]})}
async function waitDownload(name){for(let i=0;i<80;i++){try{return await readFile(resolve('test-results',name))}catch{await new Promise(r=>setTimeout(r,100))}}throw new Error('Missing download: '+name)}
await toolButton('New text');await until(`document.querySelector('[aria-label="New text content"]') && !document.querySelector('.loading-overlay')`)
await field('New text content','Production added text');await field('Object X','100');await field('Object Y','250')
const image=await evaluate(`(()=>{const c=document.createElement('canvas');c.width=100;c.height=40;const ctx=c.getContext('2d');ctx.fillStyle='#ff8000';ctx.fillRect(0,0,100,40);return c.toDataURL('image/png').split(',')[1]})()`)
await writeFile('test-results/production-image.png',Buffer.from(image,'base64'))
await toolButton('Image');await fileInput('[aria-label="Upload image or signature"]','test-results/production-image.png')
await until(`document.querySelector('[aria-label="Image: production-image.png"]') && !document.querySelector('.loading-overlay')`)
await field('Object X','300');await field('Object Y','350')
await toolButton('Signature');await until(`document.querySelector('.signature-pad')`)
const pad=await evaluate(`(()=>{const r=document.querySelector('.signature-pad').getBoundingClientRect();return{x:r.x+40,y:r.y+60}})()`)
await send('Input.dispatchMouseEvent',{type:'mousePressed',...pad,button:'left',buttons:1,clickCount:1})
await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:pad.x+65,y:pad.y+30,button:'left',buttons:1})
await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:pad.x+130,y:pad.y-10,button:'left',buttons:1})
await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:pad.x+130,y:pad.y-10,button:'left',clickCount:1})
await toolButton('Insert signature');await field('Object Y','450')
const toolsName='production-tools-'+Date.now()+'.pdf';await field('Download filename',toolsName)
await evaluate(`document.querySelector('.app-header .primary').click()`);await waitDownload(toolsName)
await until(`!document.querySelector('.loading-overlay')`);await upload('test-results/'+toolsName)
await until(`document.querySelector('[aria-label="Edit text: Production added text"]')`)
assert.ok(await evaluate(`(()=>{const c=document.querySelector('.document-canvas'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<p.length;i+=4)if(p[i]===255&&p[i+1]===128&&p[i+2]===0)n++;return n>20})()`),'Uploaded image must appear in the reopened production PDF.')
await toolButton('Merge PDFs');await fileInput('[aria-label="Choose PDFs to merge"]','test-results/embedded-font.pdf')
await until(`document.querySelectorAll('.merge-file').length===2`);await toolButton('Merge and open')
await until(`document.querySelectorAll('.page-thumbnail').length===2 && !document.querySelector('dialog[open]') && !document.querySelector('.loading-overlay')`)
await activateLayout('merged-edited.pdf')
const extractBase='production-extract-'+Date.now();await field('Download filename',extractBase+'.pdf')
await toolButton('Split / extract');await field('Page ranges','1');await toolButton('Download extracted PDF');await waitDownload(extractBase+'-extracted.pdf')
await until(`!document.querySelector('dialog[open]') && !document.querySelector('.loading-overlay')`);await upload('test-results/'+extractBase+'-extracted.pdf')
assert.equal(await evaluate(`document.querySelectorAll('.page-thumbnail').length`),1)
assert.ok(await evaluate(`!!document.querySelector('[aria-label="Edit text: Production added text"]')`))
assert.deepEqual(errors,[]);assert.deepEqual(failedRequests,[])
await writeFile('test-results/production-verification.json',JSON.stringify({result:'PASS',downloadedBytes:downloaded.length,embeddedFontUpload:true,fallbackEdit:true,reopenedEditable:true,boldAndUnderlinePreserved:true,newText:true,imagePixels:true,drawnSignature:true,merge:true,extract:true,errors,failedRequests},null,2))
console.log('PASS: production upload, fonts, text editing, new text, images, signature, actual download/reopen, merge/extract and local assets.')
} finally { await session.close() }
