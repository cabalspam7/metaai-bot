// Meta AI dev bulk registration bot
// Uses Playwright + mail.tm (BokuLabs wrapper)
// Deploy on Railway (US region) to bypass Meta AI region lock

import { chromium } from 'playwright';
import { appendFileSync, writeFileSync } from 'fs';
import { getDomain, createAccount, getToken, getMessages, getMessage } from './mailtm.js';

const TARGET = parseInt(process.env.TARGET || '5');
const OUTPUT_FILE = process.env.OUTPUT_FILE || 'accounts.txt';
const PASSWORD = process.env.PASSWORD || 'Xk9#mB2$pL7!nQ4v';
const BIRTHDAY = { year: '1990', month: 'July', day: '21' };
const HEADLESS = process.env.HEADLESS !== '0';
const MAX_RETRIES = 2;
const OTP_TIMEOUT_MS = parseInt(process.env.OTP_TIMEOUT || '180000');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function randStr(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// === mail.tm inbox (using BokuLabs wrapper) ===
async function createInbox() {
  const domain = await getDomain();
  const email = `meta${randStr(8)}@${domain}`;
  const pass = `Mp${randStr(12)}!`;
  await createAccount(email, pass);
  const { id, token } = await getToken(email, pass);
  return { email, pass, token, accountId: id };
}

async function pollOtp(token, email, timeoutMs = 180000) {
  const start = Date.now();
  const seen = new Set();
  while (Date.now() - start < timeoutMs) {
    try {
      const msgs = await getMessages(token);
      for (const m of msgs) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const full = await getMessage(token, m.id);
        const body = (full.text || full.html || full.intro || '') + ' ' + (full.subject || '');
        // Meta OTP: 6-digit code in subject or body
        const codeMatch = body.match(/\b(\d{6})\b/);
        if (codeMatch) {
          return { code: codeMatch[1], messageId: m.id };
        }
      }
    } catch (e) {
      // ignore transient errors
    }
    await sleep(5000);
  }
  return null;
}

// === Playwright bot ===
async function registerOne(attempt = 0) {
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    viewport: { width: 1280, height: 800 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  const page = await context.newPage();

  try {
    const inbox = await createInbox();
    const email = inbox.email;
    log(`[${email}] Inbox created (mail.tm)`);

    // Navigate to dev.meta.ai → redirects to auth.meta.com.
    // Meta sometimes aborts during OIDC redirect; retry and accept if auth page is visible.
    await safeGotoAuth(page, email);
    await page.waitForTimeout(3000);

    // Click "Use mobile number or email"
    await page.getByRole('button', { name: 'Use mobile number or email' }).click({ timeout: 20000 });
    await page.waitForTimeout(1000);
    await page.waitForTimeout(1500);

    // Type email
    const emailInput = page.locator('input').first();
    await emailInput.fill(email, { timeout: 10000 });
    await page.waitForTimeout(500);

    // Click Continue
    await page.getByRole('button', { name: 'Continue' }).click({ timeout: 10000 });
    await page.waitForTimeout(3000);

    // Should be on "Create a new account" page
    // Set birthday year via custom React combobox
    await setReactCombobox(page, 'Select Year', BIRTHDAY.year);
    await page.waitForTimeout(500);

    // Set password via native value setter (React controlled input)
    await page.evaluate((pw) => {
      const inp = document.querySelector('input[type="password"]');
      if (!inp) throw new Error('No password input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, pw);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.dispatchEvent(new Event('blur', { bubbles: true }));
    }, PASSWORD);
    await page.waitForTimeout(1500);

    // Click enabled Confirm button
    const confirmBtn = await findEnabledConfirm(page);
    if (!confirmBtn) throw new Error('Confirm button not enabled (password validation may have failed)');
    await confirmBtn.click({ timeout: 10000 });
    log(`[${email}] Confirm clicked, waiting for OTP screen...`);

    await page.waitForTimeout(5000);

    // Check what happened after Confirm — OTP screen or error
    const postConfirm = await page.evaluate(() => {
      const body = document.body.innerText.substring(0, 1000);
      const hasOtp = !!document.querySelector('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]');
      const hasError = /something went wrong|isn't available|not available|error|try again/i.test(body);
      return { hasOtp, hasError, bodyText: body };
    }).catch(() => ({ hasOtp: false, hasError: false, bodyText: 'eval failed' }));

    log(`[${email}] Post-Confirm: hasOtp=${postConfirm.hasOtp} hasError=${postConfirm.hasError}`);
    if (postConfirm.bodyText) log(`[${email}] Page text: ${postConfirm.bodyText.substring(0, 200)}`);

    // Screenshot + upload regardless of outcome
    const postSs = `/tmp/post-confirm-${Date.now()}.png`;
    await page.screenshot({ path: postSs }).catch(() => {});
    if (process.env.UPLOAD_UGUU === '1') {
      try {
        const { execSync } = await import('child_process');
        const ssUrl = execSync(`curl -s -F "files[]=@${postSs}" https://uguu.se/upload`, { encoding: 'utf-8' });
        log(`[${email}] Post-Confirm screenshot: ${ssUrl.trim()}`);
      } catch (e) { log(`[${email}] Screenshot upload failed: ${e.message}`); }
    }

    if (postConfirm.hasError) {
      throw new Error(`Meta error after Confirm: ${postConfirm.bodyText.substring(0, 200)}`);
    }

    if (!postConfirm.hasOtp) {
      // Maybe OTP screen takes longer to load — wait more
      await page.waitForTimeout(5000);
    }

    // Poll for OTP from mail.tm
    const otp = await pollOtp(inbox.token, email, OTP_TIMEOUT_MS);
    if (!otp) throw new Error('OTP not received within timeout');
    log(`[${email}] OTP received: ${otp.code}`);

    // Enter OTP — find 6-digit input or single inputs
    await enterOtp(page, otp.code);
    await page.waitForTimeout(2000);

    // Submit OTP (Continue/Verify/Confirm)
    const submitBtn = page.getByRole('button', { name: 'Continue' }).or(page.getByRole('button', { name: 'Verify' })).or(page.getByRole('button', { name: 'Confirm' })).first();
    if (await submitBtn.isVisible().catch(() => false)) {
      await submitBtn.click({ timeout: 10000 }).catch(() => {});
    }
    await page.waitForTimeout(5000);

    // Capture cookies
    const cookies = await context.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Try to navigate to dev.meta.ai to grab API key / session
    await page.goto('https://dev.meta.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000);
    const devCookies = await context.cookies('https://dev.meta.ai');
    const devCookieStr = devCookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Try to grab access token from page
    const token = await page.evaluate(() => {
      return localStorage.getItem('access_token') ||
             localStorage.getItem('token') ||
             localStorage.getItem('accessToken') ||
             (window.__NEXT_DATA__?.props?.pageProps?.session?.accessToken) || '';
    }).catch(() => '');

    // === Grab API key from dashboard ===
    let apiKey = '';
    try {
      log(`[${email}] Navigating to /api_keys...`);
      await page.goto('https://dev.meta.ai/api_keys', { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);

      // Screenshot for debugging
      await page.screenshot({ path: `dashboard-${email.replace(/[@.]/g, '_')}.png` }).catch(() => {});

      // Try to find "Create API Key" / "Generate" / "Create" button
      const createBtn = page.getByRole('button', { name: /create.*key|generate.*key|create.*api/i }).or(
        page.getByRole('button', { name: /create|generate/i })
      ).first();
      if (await createBtn.isVisible().catch(() => false)) {
        log(`[${email}] Found create button, clicking...`);
        await createBtn.click({ timeout: 10000 });
        await page.waitForTimeout(3000);
        await page.screenshot({ path: `create-key-${email.replace(/[@.]/g, '_')}.png` }).catch(() => {});
      }

      // Look for API key in DOM — could be in input, code block, or text
      apiKey = await page.evaluate(() => {
        // Check for input with key value
        const inputs = document.querySelectorAll('input[value*="AI"], input[value*="sk-"], input[value*="key"], input[value*="ea-"], input[readonly]');
        for (const inp of inputs) {
          const v = inp.value || inp.getAttribute('value') || '';
          if (v.length > 10) return v;
        }
        // Check for code/pre blocks
        const codeBlocks = document.querySelectorAll('code, pre, [class*="key"], [class*="token"], [data-key]');
        for (const cb of codeBlocks) {
          const t = cb.textContent.trim();
          if (t.length > 10 && t.length < 200 && /^[A-Za-z0-9_\-]+$/.test(t)) return t;
        }
        // Check clipboard-copy buttons
        const copyBtns = document.querySelectorAll('button[aria-label*="copy"], button[title*="copy"], [class*="copy"]');
        for (const cb of copyBtns) {
          const v = cb.getAttribute('data-clipboard-text') || cb.getAttribute('data-copy') || '';
          if (v.length > 10) return v;
        }
        // Fallback: scrape any long alphanumeric string from page text
        const body = document.body.innerText;
        const match = body.match(/(?:sk-|EA-|AI|key)[A-Za-z0-9_\-]{20,}/);
        if (match) return match[0];
        return '';
      }).catch(() => '');
      if (apiKey) {
        log(`[${email}] ✅ API key: ${apiKey.substring(0, 20)}...`);
      } else {
        log(`[${email}] No API key found in DOM, check dashboard screenshot`);
      }
    } catch (e) {
      log(`[${email}] API key grab failed: ${e.message}`);
    }

    appendFileSync(OUTPUT_FILE, `${email}|${PASSWORD}|${apiKey || 'no-apikey'}|${token || 'no-token'}|${(devCookieStr || cookieStr).substring(0, 500)}\n`);
    log(`[${email}] ✅ Saved to ${OUTPUT_FILE}`);

    // Upload per-account to uguu.se for remote access
    if (process.env.UPLOAD_UGUU === '1') {
      try {
        const { execSync } = await import('child_process');
        const upTmp = `/tmp/acct-${Date.now()}.txt`;
        writeFileSync(upTmp, `${email}|${PASSWORD}|${apiKey || 'no-apikey'}|${token || 'no-token'}\n`);
        const uguuUrl = execSync(`curl -s -F "files[]=@${upTmp}" https://uguu.se/upload`, { encoding: 'utf-8' });
        log(`[${email}] Uploaded to uguu: ${uguuUrl.trim()}`);
      } catch (e) {
        log(`[${email}] Upload failed: ${e.message}`);
      }
    }

    return { email, password: PASSWORD, apiKey, token, cookies: devCookieStr || cookieStr };
  } catch (err) {
    log(`Attempt ${attempt} failed: ${err.message}`);
    try {
      const ss = `/tmp/error-${Date.now()}.png`;
      await page.screenshot({ path: ss });
      log(`Screenshot saved: ${ss}`);
      if (process.env.UPLOAD_UGUU === '1') {
        try {
          const { execSync } = await import('child_process');
          const ssUrl = execSync(`curl -s -F "files[]=@${ss}" https://uguu.se/upload`, { encoding: 'utf-8' });
          log(`Error screenshot upload: ${ssUrl.trim()}`);
        } catch (uerr) { log(`Error screenshot upload failed: ${uerr.message}`); }
      }
    } catch {}
    if (attempt < MAX_RETRIES) {
      log(`Retrying... (${attempt + 1}/${MAX_RETRIES})`);
      await browser.close().catch(() => {});
      return registerOne(attempt + 1);
    }
    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function safeGotoAuth(page, email) {
  for (let i = 0; i < 4; i++) {
    try {
      await page.goto('https://dev.meta.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2500);
    } catch (e) {
      log(`[${email}] goto dev.meta.ai attempt ${i + 1} failed/aborted: ${e.message}`);
      await page.waitForTimeout(2500);
    }
    const ok = await page.getByRole('button', { name: 'Use mobile number or email' }).isVisible({ timeout: 5000 }).catch(() => false);
    if (ok) return;
    // If redirect left us at blank page, reload from dev.meta.ai again.
    const loc = await page.evaluate(() => location.href).catch(() => 'unknown');
    log(`[${email}] auth page not visible after goto attempt ${i + 1}, url=${loc}`);
  }
  throw new Error('Auth landing page not visible after retries');
}

async function setReactCombobox(page, label, value) {
  const combo = page.getByRole('combobox', { name: label });
  await combo.click({ timeout: 10000 });
  await page.waitForTimeout(500);
  const option = page.getByRole('option', { name: value });
  await option.click({ timeout: 10000 });
  await page.waitForTimeout(500);
}

async function findEnabledConfirm(page) {
  const handle = await page.evaluateHandle(() => {
    const btns = Array.from(document.querySelectorAll('[role="button"]'));
    const confirm = btns.find(b => b.textContent.trim() === 'Confirm' && !b.getAttribute('aria-disabled'));
    return confirm || null;
  });
  return handle.asElement();
}

async function enterOtp(page, code) {
  // Try single input first
  const single = page.locator('input[name="code"], input[name="otp"], input[autocomplete="one-time-code"]').first();
  if (await single.isVisible().catch(() => false)) {
    await single.fill(code, { timeout: 5000 });
    return;
  }
  // Try 6 separate inputs
  const inputs = page.locator('input[maxlength="1"], input[inputmode="numeric"]');
  const count = await inputs.count();
  if (count >= 6) {
    for (let i = 0; i < 6; i++) {
      await inputs.nth(i).fill(code[i], { timeout: 3000 });
    }
    return;
  }
  // Fallback: type into focused element
  await page.keyboard.type(code, { delay: 100 });
}

// === Main loop ===
async function main() {
  log(`Starting Meta AI bulk registration — target=${TARGET}`);
  let count = 0;
  while (count < TARGET) {
    log(`--- Account ${count + 1}/${TARGET} ---`);
    const result = await registerOne();
    if (result) count++;
    else log('Failed, continuing to next attempt...');
    await sleep(2000);
  }
  log(`✅ Done: ${count} accounts registered. Output: ${OUTPUT_FILE}`);

  // Upload to uguu.se if requested
  if (process.env.UPLOAD_UGUU === '1') {
    try {
      const { execSync } = await import('child_process');
      const out = execSync(`curl -s -F "files[]=@${OUTPUT_FILE}" https://uguu.se/upload`, { encoding: 'utf-8' });
      log(`Uploaded to uguu: ${out}`);
    } catch (e) {
      log(`Upload failed: ${e.message}`);
    }
  }
}

main().catch(e => {
  log(`Fatal: ${e.message}`);
  process.exit(1);
});
