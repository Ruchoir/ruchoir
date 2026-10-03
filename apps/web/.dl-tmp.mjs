import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ acceptDownloads: true });
await p.goto('https://limewire.com/d/g4lXz#7BYWHZTjVl', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(6000);
const c = p.getByRole('button', { name: /do not consent|refuse|reject|disagree/i }).first();
if (await c.count()) { await c.click().catch(()=>{}); console.log('consent refused'); }
await p.waitForTimeout(2000);
const btns = p.getByRole('button', { name: /download/i });
console.log('download buttons:', await btns.count());
const [d] = await Promise.all([
  p.waitForEvent('download', { timeout: 180000 }),
  btns.first().evaluate(e => e.click()),
]);
console.log('file:', d.suggestedFilename());
await d.saveAs('/home/theo/notre-mariage.tar.gz');
await b.close();
