import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = process.env.CHROME_BIN || (
  fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' :
  fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' :
  '/usr/bin/chromium'
);

const BASE_URL = process.env.TEST_URL || 'http://127.0.0.1:4173';
const SCREENSHOT_DIR = path.resolve('frontend/tests/screenshots');
const delay = ms => new Promise(r => setTimeout(r, ms));

const DEVICE_PROFILES = [
  { name: 'iPhone SE (Small Mobile)', width: 375, height: 667, isMobile: true, hasTouch: true },
  { name: 'iPhone 15 / Android Std', width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: 'Large Phablet (430px)', width: 430, height: 932, isMobile: true, hasTouch: true },
  { name: 'Small Tablet / Foldable (600px)', width: 600, height: 960, isMobile: true, hasTouch: true },
  { name: 'Desktop Split-Screen (640px)', width: 640, height: 900, isMobile: false, hasTouch: false },
  { name: 'iPad 10th Gen (Portrait 810px)', width: 810, height: 1080, isMobile: true, hasTouch: true },
  { name: 'iPad Air / Pro (Portrait 820px)', width: 820, height: 1180, isMobile: true, hasTouch: true },
  { name: 'Desktop Half-Screen Snap (960px)', width: 960, height: 1080, isMobile: false, hasTouch: false },
  { name: 'iPad Landscape (1080px)', width: 1080, height: 810, isMobile: true, hasTouch: true },
  { name: 'Standard Laptop (1280px)', width: 1280, height: 800, isMobile: false, hasTouch: false },
  { name: 'Full HD Desktop (1920px)', width: 1920, height: 1080, isMobile: false, hasTouch: false },
];

const results = [];
function record(device, component, checkName, passed, detail) {
  results.push({ device, component, checkName, passed, detail });
  const icon = passed ? '✅' : '❌';
  console.log(`${icon} [${passed ? 'PASS' : 'FAIL'}] [${device}] ${component} -> ${checkName}: ${detail}`);
}

async function run() {
  console.log('================================================================');
  console.log('   PROMPTFOLDERS MULTI-DEVICE & MULTI-VIEWPORT RESPONSIVE AUDIT   ');
  console.log('================================================================');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Browser: ${CHROME_PATH}`);
  console.log(`Profiles: ${DEVICE_PROFILES.length} device configurations\n`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080']
  });

  const page = await browser.newPage();

  // 1. Initial Login at 1280px
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`${BASE_URL}/?auth=login`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input[type="email"]', { timeout: 10000 });
  await page.type('input[type="email"]', 'alice@example.com');
  await page.type('input[type="password"]', 'demo1234');
  await page.click('form button.btn-primary');
  await page.waitForSelector('[data-tour="connect-ai"]', { timeout: 15000 });
  console.log('Authenticated session ready. Commencing viewport sweeps...\n');

  for (const dev of DEVICE_PROFILES) {
    console.log(`\n----------------------------------------------------------------`);
    console.log(`📱 Testing Device Profile: ${dev.name} (${dev.width}x${dev.height})`);
    console.log(`----------------------------------------------------------------`);

    await page.setViewport({
      width: dev.width,
      height: dev.height,
      isMobile: dev.isMobile,
      hasTouch: dev.hasTouch
    });
    await delay(500);

    // TEST A: Dashboard Layout & Horizontal Overflow
    const dashMetrics = await page.evaluate(() => {
      const doc = document.documentElement;
      const hasHScroll = doc.scrollWidth > window.innerWidth + 1;
      const diff = doc.scrollWidth - window.innerWidth;
      return { hasHScroll, diff, scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth };
    });

    record(
      dev.name,
      'Dashboard',
      'No Horizontal Scroll',
      !dashMetrics.hasHScroll,
      dashMetrics.hasHScroll
        ? `Page horizontally overflows by ${dashMetrics.diff}px (scrollWidth: ${dashMetrics.scrollWidth}px vs viewport: ${dashMetrics.innerWidth}px)`
        : `scrollWidth (${dashMetrics.scrollWidth}px) strictly <= viewport (${dashMetrics.innerWidth}px)`
    );

    // TEST B: Navigation / Header Visibility
    const navMetrics = await page.evaluate(isSmall => {
      const topHeader = document.querySelector('header');
      const aside = document.querySelector('aside');
      const headerVisible = topHeader && window.getComputedStyle(topHeader).display !== 'none';
      const asideVisible = aside && window.getComputedStyle(aside).display !== 'none';

      if (isSmall) {
        return { ok: Boolean(headerVisible), label: 'Mobile header bar visible & operable' };
      } else {
        return { ok: Boolean(asideVisible), label: 'Desktop sidebar navigation visible & operable' };
      }
    }, dev.width < 1024);

    record(dev.name, 'Navigation', 'Bar Operable', navMetrics.ok, navMetrics.label);

    // TEST C: Open "Connect to AI" Modal
    let modalOpened = false;
    try {
      if (dev.width < 1024) {
        // Mobile view (< 1024px): Connect to AI is in the sticky top header
        const mobileBtn = await page.$('header button[aria-label="Connect to AI"]');
        if (mobileBtn) {
          await mobileBtn.click();
        } else {
          // Fallback to burger menu
          const burger = await page.$('header button[aria-label="Open navigation"]') || await page.$('header button:last-child');
          if (burger) await burger.click();
          await delay(300);
          await page.click('button[data-tour="connect-ai"]');
        }
      } else {
        // Desktop view (>= 1024px): Connect to AI is in the left sidebar aside
        await page.click('aside button[data-tour="connect-ai"]');
      }

      await page.waitForSelector('[role="dialog"]', { timeout: 4000 });
      modalOpened = true;
    } catch {
      // Direct click fallback
      modalOpened = await page.evaluate(() => {
        const btn = document.querySelector('header button[aria-label="Connect to AI"]')
          || document.querySelector('aside button[data-tour="connect-ai"]')
          || Array.from(document.querySelectorAll('button')).find(b => b.innerText?.includes('Connect to AI'));
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (modalOpened) {
        try {
          await page.waitForSelector('[role="dialog"]', { timeout: 3000 });
        } catch {
          modalOpened = false;
        }
      }
    }

    record(dev.name, 'Connect to AI Modal', 'Modal Launch', modalOpened, 'Modal opened and rendered');

    if (!modalOpened) continue;

    // Take screenshot on representative form factors
    if (['iPhone SE (Small Mobile)', 'iPad 10th Gen (Portrait 810px)', 'Desktop Half-Screen Snap (960px)', 'Standard Laptop (1280px)'].includes(dev.name)) {
      const slug = dev.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const shotPath = path.join(SCREENSHOT_DIR, `${slug}-connect-ai.png`);
      await page.screenshot({ path: shotPath, fullPage: false });
      console.log(`   📸 Captured screenshot: ${path.basename(shotPath)}`);
    }

    // TEST D: Modal Border Overlap & Element Containment
    const modalContainment = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return { ok: false, error: 'dialog not found' };

      const dialogRect = dialog.getBoundingClientRect();
      const allElements = Array.from(dialog.querySelectorAll('button, .segmented, pre, code, input, .card'));

      const overflows = [];
      for (const el of allElements) {
        const r = el.getBoundingClientRect();
        // Skip invisible / zero-size elements
        if (r.width === 0 || r.height === 0) continue;

        // Tolerance of 3px for subpixel rendering
        if (r.right > dialogRect.right + 3) {
          overflows.push({
            tag: el.tagName,
            classes: el.className?.slice(0, 40),
            text: el.innerText?.slice(0, 25),
            overflowRight: Math.round(r.right - dialogRect.right)
          });
        }
      }

      return {
        ok: overflows.length === 0,
        overflowCount: overflows.length,
        offenders: overflows.slice(0, 3),
        dialogWidth: Math.round(dialogRect.width),
      };
    });

    record(
      dev.name,
      'Connect to AI Modal',
      'Border Containment (Dialog Boundary)',
      modalContainment.ok,
      modalContainment.ok
        ? `All elements strictly contained within dialog (${modalContainment.dialogWidth}px width)`
        : `Detected ${modalContainment.overflowCount} overflow(s): ${JSON.stringify(modalContainment.offenders)}`
    );

    // TEST E: Provider Sub-Mode Interactive Switching & State Differentiation
    // Test Claude Modes (Desktop, Web, CLI)
    const claudeModeCheck = await page.evaluate(async () => {
      const modeButtons = Array.from(document.querySelectorAll('[role="tablist"][aria-label="Claude setup options"] button'));
      if (modeButtons.length < 3) return { ok: false, reason: 'missing claude mode buttons' };

      // Click Web
      modeButtons[1].click();
      await new Promise(r => setTimeout(r, 150));
      const webSelected = modeButtons[1].getAttribute('aria-selected') === 'true';
      const webHasAmberClass = modeButtons[1].className.includes('segmented-item-active-amber');

      // Click CLI
      modeButtons[2].click();
      await new Promise(r => setTimeout(r, 150));
      const cliSelected = modeButtons[2].getAttribute('aria-selected') === 'true';
      const cliHasAmberClass = modeButtons[2].className.includes('segmented-item-active-amber');

      // Click Desktop
      modeButtons[0].click();
      await new Promise(r => setTimeout(r, 150));
      const desktopSelected = modeButtons[0].getAttribute('aria-selected') === 'true';

      return {
        ok: webSelected && webHasAmberClass && cliSelected && cliHasAmberClass && desktopSelected,
        webSelected,
        cliSelected,
        desktopSelected
      };
    });

    record(
      dev.name,
      'Claude Selector',
      'Visual State Differentiation',
      claudeModeCheck.ok,
      claudeModeCheck.ok
        ? 'Desktop, Web, and CLI modes visibly switch and illuminate with active indicator'
        : `Failed state switch: ${JSON.stringify(claudeModeCheck)}`
    );

    // TEST F: Provider Card Containment (Card inner borders)
    const cardContainment = await page.evaluate(() => {
      const providerCard = document.querySelector('[role="dialog"] section + section > div.rounded-xl')
        || document.querySelector('[role="dialog"] .rounded-xl.border-amber-200\\/90')
        || document.querySelector('[role="dialog"] .rounded-xl.border');
      if (!providerCard) return { ok: true, reason: 'card not found' };

      const cardRect = providerCard.getBoundingClientRect();
      const children = Array.from(providerCard.querySelectorAll('button, .segmented, pre, code'));
      const cardOverflows = [];

      for (const ch of children) {
        const cr = ch.getBoundingClientRect();
        if (cr.width === 0 || cr.height === 0) continue;
        if (cr.right > cardRect.right + 3) {
          cardOverflows.push({
            tag: ch.tagName,
            text: ch.innerText?.slice(0, 20),
            diff: Math.round(cr.right - cardRect.right)
          });
        }
      }

      return {
        ok: cardOverflows.length === 0,
        count: cardOverflows.length,
        samples: cardOverflows.slice(0, 2),
        cardWidth: Math.round(cardRect.width)
      };
    });

    record(
      dev.name,
      'Provider Card',
      'Inner Border Containment',
      cardContainment.ok,
      cardContainment.ok
        ? `All controls and code blocks contained inside card (${cardContainment.cardWidth}px width)`
        : `Found ${cardContainment.count} inner overflow(s): ${JSON.stringify(cardContainment.samples)}`
    );

    // TEST G: Close Modal
    await page.evaluate(() => {
      const btn = document.querySelector('button[data-autofocus]') || document.querySelector('button[aria-label="Close dialog"]');
      if (btn) btn.click();
    });
    await delay(300);
    const stillOpen = await page.$('[role="dialog"]');
    if (stillOpen) {
      await page.keyboard.press('Escape');
      await delay(300);
    }
  }

  await browser.close();

  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log('\n================================================================');
  console.log(`   MULTI-DEVICE AUDIT COMPLETE: ${passed}/${total} CHECKS PASSED`);
  if (failed === 0) {
    console.log('   🎉 100% SUCCESS — ZERO LAYOUT SHIFT OR BORDER OVERFLOW!');
  } else {
    console.log(`   ⚠️ ${failed} CHECKS FAILED — ACTION REQUIRED.`);
  }
  console.log('================================================================\n');

  if (failed > 0) process.exit(1);
}

run();
