import { chromium } from "playwright";

async function run() {
  console.log("=== Launching Playwright Chromium Headless ===");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const logs = [];
  const errors = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") {
      errors.push(text);
      console.log(`[BROWSER ERROR] ${text}`);
    } else {
      logs.push(text);
    }
  });

  page.on("pageerror", (err) => {
    errors.push(err.message);
    console.log(`[PAGE UNCAUGHT ERROR] ${err.message}`);
  });

  console.log("Navigating to http://localhost:3000 ...");
  await page.goto("http://localhost:3000", { waitUntil: "networkidle", timeout: 30000 });

  // Verify page title
  const title = await page.title();
  console.log(`Page title: "${title}"`);

  // Wait for 3D canvas
  await page.waitForSelector("canvas", { timeout: 10000 });
  console.log("✓ 3D Canvas element rendered");

  // Check top bar buttons
  const autoFixBtn = page.getByRole("button", { name: "Auto-fix" });
  console.log("Auto-fix button visible:", await autoFixBtn.isVisible());

  // Click on Copilot tab in RightDock
  console.log("Opening Copilot tab...");
  const copilotTab = page.getByRole("button", { name: "Copilot" });
  if (await copilotTab.isVisible()) {
    await copilotTab.click();
    console.log("✓ Copilot tab clicked");
  }

  // Type a question in the chat input
  const chatInput = page.getByPlaceholder("Ask question or describe change...");
  await chatInput.waitFor({ state: "visible", timeout: 5000 });
  await chatInput.fill("Why is the camera vibrating?");
  console.log("Filled chat input with: 'Why is the camera vibrating?'");

  // Click send button
  const sendBtn = page.locator("button:has(svg.lucide-send)");
  await sendBtn.click();
  console.log("Clicked Send button. Waiting for live AI response...");

  // Wait for assistant response to appear
  await page.waitForTimeout(6000);

  // Read chat messages
  const chatText = await page.locator(".flex-1.overflow-y-auto").innerText().catch(() => "");
  console.log("\n--- CHAT RESPONSE IN UI ---");
  console.log(chatText.slice(0, 500));
  console.log("---------------------------\n");

  // Now test Auto-fix button
  console.log("Testing Auto-fix button in top bar...");
  await autoFixBtn.waitFor({ state: "visible" });
  await autoFixBtn.click();
  console.log("Clicked Auto-fix. Waiting for optimization & Compare view...");

  // Wait for compare view elements
  await page.waitForSelector("text=Original Design", { timeout: 25000 });
  console.log("✓ Compare view successfully engaged!");

  // Wait 3 seconds for vibration animation to render in Compare View
  await page.waitForTimeout(3000);

  // Take screenshot
  await page.screenshot({ path: "playwright-e2e-result.png", fullPage: true });
  console.log("✓ Screenshot saved to frontend/playwright-e2e-result.png");

  console.log(`\nTotal browser console errors: ${errors.length}`);
  if (errors.length > 0) {
    console.log("Errors logged:", errors);
  }

  await browser.close();
  console.log("=== Playwright E2E Run Complete ===");
}

run().catch((err) => {
  console.error("Playwright E2E failed:", err);
  process.exit(1);
});
