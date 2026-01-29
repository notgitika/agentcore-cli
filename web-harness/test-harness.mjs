import { chromium } from 'playwright';

async function testHarness() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Collect console messages
  const consoleLogs = [];
  const consoleErrors = [];

  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    } else {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    }
  });

  page.on('pageerror', err => {
    consoleErrors.push(`PAGE ERROR: ${err.message}`);
  });

  try {
    console.log('Navigating to http://localhost:5173/...');
    await page.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 30000 });

    // Wait a bit for React to render
    await page.waitForTimeout(2000);

    // Get page title
    const title = await page.title();
    console.log(`\nPage title: ${title}`);

    // Check if root has content
    const rootContent = await page.$eval('#root', el => el.innerHTML.length);
    console.log(`Root element content length: ${rootContent} chars`);

    // Look for terminal frames
    const terminals = await page.$$('div[style*="background"]');
    console.log(`Found ${terminals.length} styled divs`);

    // Get visible text
    const bodyText = await page.textContent('body');
    console.log(`\nVisible text preview: ${bodyText?.substring(0, 500)}...`);

    // Take a screenshot
    await page.screenshot({ path: '/Users/owenkaplan/code/agentcore-cli/web-harness/screenshot.png', fullPage: true });
    console.log('\nScreenshot saved to web-harness/screenshot.png');

    // Report errors
    if (consoleErrors.length > 0) {
      console.log('\n❌ CONSOLE ERRORS:');
      consoleErrors.forEach(e => console.log(`  - ${e}`));
    } else {
      console.log('\n✅ No console errors!');
    }

    // Report some logs
    if (consoleLogs.length > 0) {
      console.log(`\nConsole logs (${consoleLogs.length} total):`);
      consoleLogs.slice(0, 10).forEach(l => console.log(`  ${l}`));
      if (consoleLogs.length > 10) {
        console.log(`  ... and ${consoleLogs.length - 10} more`);
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await browser.close();
  }
}

testHarness();
