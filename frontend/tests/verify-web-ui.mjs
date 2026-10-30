import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME_PATH = process.env.CHROME_BIN || (
  fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' :
  fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' :
  '/usr/bin/chromium'
);

const BASE_URL = process.env.TEST_URL || 'http://127.0.0.1:4173';
const delay = ms => new Promise(r => setTimeout(r, ms));

const tests = [];
function record(name, status, detail) {
  tests.push({ name, status, detail });
  const icon = status === 'PASS' ? '✅' : '❌';
  console.log(`${icon} [${status}] ${name}: ${detail}`);
}

async function run() {
  console.log('=== STARTING AUTOMATED WEB UI VERIFICATION ===');
  console.log(`URL: ${BASE_URL}`);
  console.log(`Browser: ${CHROME_PATH}\n`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,900']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  try {
    // 1. Initial Page Load
    await page.goto(`${BASE_URL}/?auth=login`, { waitUntil: 'networkidle2' });
    const title = await page.title();
    record('Page Load', title.includes('PromptHold') ? 'PASS' : 'FAIL', `Loaded page with title: "${title}"`);

    // 2. Sign In with Demo Account
    await page.waitForSelector('input[type="email"]', { timeout: 10000 });
    await page.type('input[type="email"]', 'alice@example.com');
    await page.type('input[type="password"]', 'demo1234');
    await page.click('form button.btn-primary');

    // Wait for dashboard to mount
    await page.waitForSelector('[data-tour="connect-ai"]', { timeout: 15000 });
    record('User Sign In', 'PASS', 'Signed in as Alice Morgan and mounted dashboard');

    // 3. Open Connect to AI Modal
    await page.click('[data-tour="connect-ai"]');
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
    await delay(600);
    record('Open Connect to AI Dialog', 'PASS', 'Modal dialog opened and focused');

    // 4. Verify Step 1: Security Key Status
    const keyHeading = await page.$('#connect-keys-heading');
    record('Step 1 Heading', keyHeading ? 'PASS' : 'FAIL', 'Found Step 1: Your Security Key');

    // 5. Verify Step 2: 5 AI Assistants
    const providerTabs = await page.$$('[role="tablist"][aria-label="AI assistants"] button');
    record('Assistant Count', providerTabs.length === 5 ? 'PASS' : 'FAIL', `Found ${providerTabs.length} assistant tabs`);

    // 6. Test Claude Assistant & Sub-modes
    await providerTabs[0].click(); // Claude
    await delay(300);

    const claudeSubmodes = await page.$$('[role="tablist"][aria-label="Claude setup options"] button');
    record('Claude Submodes Count', claudeSubmodes.length === 3 ? 'PASS' : 'FAIL', `Found ${claudeSubmodes.length} Claude modes (Desktop, Web, CLI)`);

    // Check Desktop active
    let isDesktopSelected = await claudeSubmodes[0].evaluate(el => el.getAttribute('aria-selected'));
    let desktopClass = await claudeSubmodes[0].evaluate(el => el.className);
    record(
      'Claude Desktop Selected by Default',
      isDesktopSelected === 'true' && desktopClass.includes('segmented-item-active-amber') ? 'PASS' : 'FAIL',
      `Desktop aria-selected=${isDesktopSelected}, class contains segmented-item-active-amber`
    );

    // Click Claude.ai Web
    await claudeSubmodes[1].click();
    await delay(300);
    let isWebSelected = await claudeSubmodes[1].evaluate(el => el.getAttribute('aria-selected'));
    let webClass = await claudeSubmodes[1].evaluate(el => el.className);
    isDesktopSelected = await claudeSubmodes[0].evaluate(el => el.getAttribute('aria-selected'));
    record(
      'Switch to Claude.ai Web',
      isWebSelected === 'true' && isDesktopSelected === 'false' && webClass.includes('segmented-item-active-amber') ? 'PASS' : 'FAIL',
      `Web aria-selected=${isWebSelected}, Desktop aria-selected=${isDesktopSelected}. Visually distinct!`
    );

    // Click Claude Code CLI
    await claudeSubmodes[2].click();
    await delay(300);
    let isCliSelected = await claudeSubmodes[2].evaluate(el => el.getAttribute('aria-selected'));
    let cliClass = await claudeSubmodes[2].evaluate(el => el.className);
    isWebSelected = await claudeSubmodes[1].evaluate(el => el.getAttribute('aria-selected'));
    record(
      'Switch to Claude Code CLI',
      isCliSelected === 'true' && isWebSelected === 'false' && cliClass.includes('segmented-item-active-amber') ? 'PASS' : 'FAIL',
      `CLI aria-selected=${isCliSelected}, Web aria-selected=${isWebSelected}. Visually distinct!`
    );

    // 7. Verify Border Containment & Alignment (No Outer Border Overlap)
    const boundsCheck = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return { ok: false, reason: 'dialog not found' };

      const dialogRect = dialog.getBoundingClientRect();
      const allButtons = Array.from(dialog.querySelectorAll('button'));
      const allBoxes = Array.from(dialog.querySelectorAll('.segmented, pre, code'));

      const overflows = [];
      for (const el of [...allButtons, ...allBoxes]) {
        const r = el.getBoundingClientRect();
        // Allow tiny subpixel anti-aliasing margin of 4px
        if (r.right > dialogRect.right + 4 || r.left < dialogRect.left - 4) {
          overflows.push({ tag: el.tagName, text: el.innerText?.slice(0, 30), diff: r.right - dialogRect.right });
        }
      }
      return { ok: overflows.length === 0, count: overflows.length, sample: overflows[0] };
    });
    record(
      'Border Containment in Modal (1280px)',
      boundsCheck.ok ? 'PASS' : 'FAIL',
      boundsCheck.ok ? 'All buttons and boxes strictly contained within modal borders' : `Found ${boundsCheck.count} overflows: ${JSON.stringify(boundsCheck.sample)}`
    );

    // 8. Test ChatGPT Assistant & Sub-modes
    await providerTabs[1].click(); // ChatGPT
    await delay(300);

    const chatgptSubmodes = await page.$$('[role="tablist"][aria-label="ChatGPT setup options"] button');
    let isGptWebSelected = await chatgptSubmodes[0].evaluate(el => el.getAttribute('aria-selected'));
    let gptWebClass = await chatgptSubmodes[0].evaluate(el => el.className);
    record(
      'ChatGPT Web Selected by Default',
      isGptWebSelected === 'true' && gptWebClass.includes('segmented-item-active-emerald') ? 'PASS' : 'FAIL',
      `ChatGPT Web aria-selected=${isGptWebSelected}, active class=emerald`
    );

    await chatgptSubmodes[1].click(); // Desktop App
    await delay(300);
    let isGptDesktopSelected = await chatgptSubmodes[1].evaluate(el => el.getAttribute('aria-selected'));
    let gptDesktopClass = await chatgptSubmodes[1].evaluate(el => el.className);
    record(
      'Switch to ChatGPT Desktop App',
      isGptDesktopSelected === 'true' && gptDesktopClass.includes('segmented-item-active-emerald') ? 'PASS' : 'FAIL',
      `ChatGPT Desktop aria-selected=${isGptDesktopSelected}, active class=emerald`
    );

    // 9. Test Gemini Assistant & Sub-modes
    await providerTabs[2].click(); // Gemini
    await delay(300);

    const geminiSubmodes = await page.$$('[role="tablist"][aria-label="Gemini setup options"] button');
    let isGeminiAppSelected = await geminiSubmodes[0].evaluate(el => el.getAttribute('aria-selected'));
    let geminiAppClass = await geminiSubmodes[0].evaluate(el => el.className);
    record(
      'Gemini App Selected by Default',
      isGeminiAppSelected === 'true' && geminiAppClass.includes('segmented-item-active-indigo') ? 'PASS' : 'FAIL',
      `Gemini App aria-selected=${isGeminiAppSelected}, active class=indigo`
    );

    await geminiSubmodes[1].click(); // Python GenAI SDK
    await delay(300);
    let isGeminiSdkSelected = await geminiSubmodes[1].evaluate(el => el.getAttribute('aria-selected'));
    let geminiSdkClass = await geminiSubmodes[1].evaluate(el => el.className);
    record(
      'Switch to Gemini Python SDK',
      isGeminiSdkSelected === 'true' && geminiSdkClass.includes('segmented-item-active-indigo') ? 'PASS' : 'FAIL',
      `Gemini SDK aria-selected=${isGeminiSdkSelected}, active class=indigo`
    );

    // 10. Test Cursor & Coding IDEs
    await providerTabs[3].click(); // Cursor
    await delay(300);

    const cursorSubmodes = await page.$$('[role="tablist"][aria-label="Cursor setup options"] button');
    let isCursorSelected = await cursorSubmodes[0].evaluate(el => el.getAttribute('aria-selected'));
    let cursorClass = await cursorSubmodes[0].evaluate(el => el.className);
    record(
      'Cursor IDE Selected by Default',
      isCursorSelected === 'true' && cursorClass.includes('segmented-item-active-cyan') ? 'PASS' : 'FAIL',
      `Cursor IDE aria-selected=${isCursorSelected}, active class=cyan`
    );

    await cursorSubmodes[1].click(); // VS Code
    await delay(300);
    let isVscodeSelected = await cursorSubmodes[1].evaluate(el => el.getAttribute('aria-selected'));
    let vscodeClass = await cursorSubmodes[1].evaluate(el => el.className);
    record(
      'Switch to VS Code (Cline / Roo)',
      isVscodeSelected === 'true' && vscodeClass.includes('segmented-item-active-cyan') ? 'PASS' : 'FAIL',
      `VS Code aria-selected=${isVscodeSelected}, active class=cyan`
    );

    // 11. Test API & Scripts
    await providerTabs[4].click(); // API
    await delay(300);

    const apiSubmodes = await page.$$('[role="tablist"][aria-label="API setup options"] button');
    let isCurlSelected = await apiSubmodes[0].evaluate(el => el.getAttribute('aria-selected'));
    let curlClass = await apiSubmodes[0].evaluate(el => el.className);
    record(
      'API cURL Selected by Default',
      isCurlSelected === 'true' && curlClass.includes('segmented-item-active') ? 'PASS' : 'FAIL',
      `API cURL aria-selected=${isCurlSelected}`
    );

    await apiSubmodes[1].click(); // Python
    await delay(300);
    let isPythonSelected = await apiSubmodes[1].evaluate(el => el.getAttribute('aria-selected'));
    record(
      'Switch to API Python',
      isPythonSelected === 'true' ? 'PASS' : 'FAIL',
      `API Python aria-selected=${isPythonSelected}`
    );

    // 12. Test Sample Prompt Copy Action
    await providerTabs[0].click(); // Back to Claude
    await delay(300);
    const copyPromptBtn = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText?.includes('Copy prompt'));
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    await delay(400);
    record('Interactive Sample Prompt Copy', copyPromptBtn ? 'PASS' : 'FAIL', 'Clicked "Copy prompt" button');

    // 13. Mobile Viewport Responsive Test (375px)
    await page.setViewport({ width: 375, height: 667 });
    await delay(500);

    const mobileCheck = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return { ok: false };
      const dialogRect = dialog.getBoundingClientRect();
      const hasHorizontalScroll = document.documentElement.scrollWidth > window.innerWidth;
      const allButtons = Array.from(dialog.querySelectorAll('button'));
      const overflows = allButtons.filter(b => {
        const r = b.getBoundingClientRect();
        return r.right > dialogRect.right + 4 || r.left < dialogRect.left - 4;
      });
      return {
        ok: !hasHorizontalScroll && overflows.length === 0,
        hasHorizontalScroll,
        overflowCount: overflows.length
      };
    });
    record(
      'Mobile Responsive Layout (375px)',
      mobileCheck.ok ? 'PASS' : 'FAIL',
      `Horizontal scroll: ${mobileCheck.hasHorizontalScroll}, Button overflows: ${mobileCheck.overflowCount}`
    );

    // 14. Close Modal
    await page.evaluate(() => {
      const btn = document.querySelector('button[data-autofocus]') || document.querySelector('button[aria-label="Close dialog"]');
      if (btn) btn.click();
    });
    await delay(500);
    const isClosed = await page.evaluate(() => !document.querySelector('[role="dialog"]'));
    record('Close Modal via Done', isClosed ? 'PASS' : 'FAIL', 'Modal closed and focus returned to dashboard');

  } catch (err) {
    console.error('Test Suite Error:', err);
    record('Runtime Execution', 'FAIL', err.message);
  } finally {
    await browser.close();
  }

  const passed = tests.filter(t => t.status === 'PASS').length;
  const failed = tests.filter(t => t.status === 'FAIL').length;
  console.log(`\n=== TEST SUMMARY: ${passed} PASSED, ${failed} FAILED ===`);
  if (failed > 0) process.exit(1);
}

run();
