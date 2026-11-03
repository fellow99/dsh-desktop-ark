// ark（ArkWeb）驱动：Playwright over CDP
// 用法: node ark-drive.js <mode> [args]
//   keyset  —— 设置 DeepSeek API KEY（从 env DSH_TEST_API_KEY 注入）
//   eval "<js>" —— 在页面求值
const { chromium } = require('playwright');

const CDP = 'http://127.0.0.1:9223';
const mode = process.argv[2] || 'eval';

async function page() {
  const b = await chromium.connectOverCDP(CDP);
  const p = b.contexts()[0].pages()[0];
  return { b, p };
}

(async () => {
  const { b, p } = await page();
  if (mode === 'keyset') {
    const key = process.env.DSH_TEST_API_KEY;
    if (!key) { console.error('need DSH_TEST_API_KEY'); process.exit(2); }
    // 账号菜单 → 设置
    await p.getByRole('button', { name: /账号菜单/ }).first().click();
    await p.waitForTimeout(700);
    await p.locator('button[role=menuitem]', { hasText: '设置' }).first().click();
    await p.waitForTimeout(900);
    // 设置栏 → 模型
    await p.locator('button', { hasText: /^模型$/ }).first().click();
    await p.waitForTimeout(900);
    const pw = p.locator('input[type=password]').first();
    await pw.fill(key);
    await p.waitForTimeout(200);
    await p.locator('button', { hasText: /^保存$/ }).first().click();
    await p.waitForTimeout(1500);
    const toast = await p.evaluate(() => (document.body.innerText.match(/已保存[^\n]*/) || ['(none)'])[0]);
    console.log('toast:', toast);
  } else if (mode === 'eval') {
    const r = await p.evaluate(process.argv[3] || '1+1');
    console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 1));
  } else if (mode === 'shot') {
    await p.screenshot({ path: process.argv[3] || 'ark-shot.png' });
    console.log('saved');
  }
  await b.close();
})().catch(e => { console.error('ERR', e.message.slice(0, 300)); process.exit(1); });
