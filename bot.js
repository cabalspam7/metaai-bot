// Meta AI dev bulk registration bot
// Uses Playwright + mail.tm (BokuLabs wrapper)
// Deploy on Railway (US region) to bypass Meta AI region lock

import { chromium } from 'playwright';
import { appendFileSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { getDomain, createAccount, getToken, getMessages, getMessage } from './bokumail.js';

const TARGET = parseInt(process.env.TARGET || '5');
const OUTPUT_FILE = process.env.OUTPUT_FILE || 'accounts.txt';
const PASSWORD = process.env.PASSWORD || 'Xk9#mB2$pL7!nQ4v';
const BIRTHDAY = { year: '1990', month: 'July', day: '21' };
const HEADLESS = process.env.HEADLESS !== '0';
const MAX_RETRIES = 2;
const OTP_TIMEOUT_MS = parseInt(process.env.OTP_TIMEOUT || '180000');
const PROXY_LIST = (process.env.PROXY_LIST || '').split(/[,\n\s]+/).filter(Boolean);
const PROXY_FILE = process.env.PROXY_FILE || 'proxies.txt';

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

const BAD_PROXY_FILE = process.env.BAD_PROXY_FILE || 'bad_proxies.txt';
const MAX_PROXY_ATTEMPTS = parseInt(process.env.MAX_PROXY_ATTEMPTS || '50');

function loadBadProxies() {
  if (!existsSync(BAD_PROXY_FILE)) return new Set();
  return new Set(readFileSync(BAD_PROXY_FILE, 'utf8').split(/\r?\n/).map(x => x.trim()).filter(Boolean));
}

function blacklistProxy(proxyStr) {
  // Don't blacklist rotating proxy endpoints (DataImpulse, BrightData, etc.)
  // These are gateway endpoints that give different IPs per request
  if (proxyStr && (proxyStr.includes('dataimpulse') || proxyStr.includes('brightdata') ||
      proxyStr.includes('smartproxy') || proxyStr.includes('iproyal') ||
      proxyStr.includes('oxylabs') || proxyStr.includes('soax'))) {
    log(`🔄 Rotating proxy (not blacklisted): ${proxyStr}`);
    return;
  }
  if (!proxyStr) return;
  try {
    appendFileSync(BAD_PROXY_FILE, proxyStr + '\n');
    badProxies.add(proxyStr);
    log(`⛔ Blacklisted proxy: ${proxyStr} (total bad: ${badProxies.size})`);
  } catch (e) { log(`Failed to blacklist proxy: ${e.message}`); }
}

function loadProxies() {
  let proxies = [...PROXY_LIST];
  if (existsSync(PROXY_FILE)) {
    proxies.push(...readFileSync(PROXY_FILE, 'utf8').split(/\r?\n/).map(x => x.trim()).filter(Boolean));
  }
  // Env single proxy support: http://user:pass@host:port or user:pass@host:port
  if (process.env.PROXY) proxies.unshift(process.env.PROXY);
  return [...new Set(proxies)];
}

function parseProxy(p) {
  if (!p) return null;
  let raw = p.trim();
  if (!raw.startsWith('http://') && !raw.startsWith('https://')) raw = `http://${raw}`;
  const u = new URL(raw);
  return {
    server: `${u.protocol}//${u.hostname}:${u.port}`,
    username: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
  };
}

const badProxies = loadBadProxies();
let proxyCursor = Math.floor(Math.random() * 100000);

function pickProxy() {
  const proxies = loadProxies();
  if (!proxies.length) return null;
  // Try proxies in order, skipping bad ones
  for (let i = 0; i < proxies.length; i++) {
    const p = proxies[proxyCursor++ % proxies.length];
    if (!badProxies.has(p)) {
      return { proxyStr: p, config: parseProxy(p) };
    }
  }
  // All proxies blacklisted — reset and try anyway
  log('⚠️ All proxies blacklisted, resetting bad list');
  badProxies.clear();
  if (existsSync(BAD_PROXY_FILE)) {
    try { writeFileSync(BAD_PROXY_FILE, ''); } catch {}
  }
  const p = proxies[proxyCursor++ % proxies.length];
  return { proxyStr: p, config: parseProxy(p) };
}

// Check if page shows Meta region restriction modal
async function checkRegionModal(page) {
  try {
    const text = await page.evaluate(() => document.body.innerText.substring(0, 1000));
    if (/isn't available in your region|isn't available in your country|Model API/i.test(text)) {
      return { isRegionBlocked: true, text };
    }
    return { isRegionBlocked: false, text };
  } catch { return { isRegionBlocked: false, text: '' }; }
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
async function registerOne(attempt = 0, proxyAttempt = 0) {
  const proxyInfo = pickProxy();
  const proxyConfig = proxyInfo?.config || null;
  const proxyStr = proxyInfo?.proxyStr || '';
  if (proxyConfig) log(`[attempt ${proxyAttempt}] Using proxy: ${proxyConfig.server}`);
  else log(`[attempt ${proxyAttempt}] No proxy available, using direct connection`);
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
    ...(proxyConfig ? { proxy: proxyConfig } : {}),
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
    log(`[${email}] Inbox created (TempBokuMail)`);

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

    // Click enabled Confirm button — wait for it to be enabled, then click
    // Meta's React combobox + password validation takes a moment to enable the button
    let confirmClicked = false;
    for (let i = 0; i < 10; i++) {
      const enabled = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('[role="button"]'));
        const confirm = btns.find(b => b.textContent.trim() === 'Confirm' && !b.getAttribute('aria-disabled'));
        return !!confirm;
      }).catch(() => false);
      if (enabled) {
        // Click via evaluate (most reliable for React custom buttons)
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('[role="button"]'));
          const confirm = btns.find(b => b.textContent.trim() === 'Confirm' && !b.getAttribute('aria-disabled'));
          if (confirm) confirm.click();
        });
        confirmClicked = true;
        break;
      }
      await page.waitForTimeout(1000);
    }
    if (!confirmClicked) {
      // Fallback: try Playwright locator
      try {
        await page.getByRole('button', { name: 'Confirm' }).click({ timeout: 5000 });
        confirmClicked = true;
      } catch {
        throw new Error('Confirm button not enabled after 10s (password validation may have failed)');
      }
    }
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

    // Check for region restriction modal
    const regionCheck = await checkRegionModal(page);
    if (regionCheck.isRegionBlocked) {
      log(`[${email}] ⛔ Region blocked by Meta: ${regionCheck.text.substring(0, 100)}`);
      if (proxyStr) {
        blacklistProxy(proxyStr);
        // Click OK to dismiss modal if possible
        await page.getByRole('button', { name: 'OK' }).click({ timeout: 3000 }).catch(() => {});
      }
      // Rotate to next proxy
      if (proxyAttempt < MAX_PROXY_ATTEMPTS) {
        log(`[${email}] Rotating to next proxy (attempt ${proxyAttempt + 1}/${MAX_PROXY_ATTEMPTS})...`);
        await browser.close().catch(() => {});
        return registerOne(0, proxyAttempt + 1);
      }
      throw new Error('Max proxy attempts reached, all blocked by region restriction');
    }

    if (postConfirm.hasError && !regionCheck.isRegionBlocked) {
      throw new Error(`Meta error after Confirm: ${postConfirm.bodyText.substring(0, 200)}`);
    }

    if (!postConfirm.hasOtp) {
      // Maybe OTP screen takes longer to load — wait more
      await page.waitForTimeout(5000);
    }

    // Poll for OTP from TempBokuMail
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

    // === Grab API key from Meta for Developers (not from dev.meta.ai) ===
    let apiKey = '';
    try {
      // Navigate to Meta for Developers and get API key from Model API
      // Docs say: meta.com -> Meta for Developers -> My Apps -> Model API dashboard
      const keyUrls = [
        'https://developers.facebook.com/apps/',
        'https://meta.com/developers/',
        'https://developers.meta.com/',
      ];
      let onDevPortal = false;
      for (const url of keyUrls) {
        log(`[${email}] Navigating to ${url}...`);
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(3000);
        const currUrl = page.url();
        log(`[${email}] Landed at: ${currUrl.substring(0, 100)}`);
        if (!currUrl.includes('login') && !currUrl.includes('auth.meta.com') && !currUrl.includes('oidc')) {
          onDevPortal = true;
          break;
        }
      }

      if (!onDevPortal) {
        // Maybe we need to login via the existing session - try dev.meta.ai first to establish session
        log(`[${email}] Re-authenticating via dev.meta.ai first...`);
        await page.goto('https://dev.meta.ai/', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(3000);
        // Now try again
        for (const url of keyUrls) {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
          await page.waitForTimeout(3000);
          const currUrl = page.url();
          log(`[${email}] Retry landed at: ${currUrl.substring(0, 100)}`);
          if (!currUrl.includes('login') && !currUrl.includes('auth.meta.com') && !currUrl.includes('oidc')) {
            onDevPortal = true;
            break;
          }
        }
      }

      if (onDevPortal) {
        log(`[${email}] ✅ On developer portal, looking for API key...`);
        await page.screenshot({ path: `devportal-${email.replace(/[@.]/g, '_')}.png` }).catch(() => {});
        await page.waitForTimeout(3000);

        // Try to find and click "Create App" / "Model API" / "API Keys"
        const targetTexts = [
          /model.api|model api|model/i,
          /create.*app|buat.*aplikasi/i,
          /api.*key|generate.*key|my.*key/i,
        ];
        for (const pattern of targetTexts) {
          try {
            const link = page.getByText(pattern).first();
            if (await link.isVisible({ timeout: 2000 }).catch(() => false)) {
              log(`[${email}] Clicking "${pattern}"...`);
              await link.click({ timeout: 10000 }).catch(() => {});
              await page.waitForTimeout(3000);
            }
          } catch {}
        }

        await page.waitForTimeout(2000);
        await page.screenshot({ path: `apikey-page-${email.replace(/[@.]/g, '_')}.png` }).catch(() => {});
      }

      // Try to extract any API key from the page
      apiKey = await page.evaluate(() => {
        // Check all inputs for long values
        const allInputs = document.querySelectorAll('input');
        for (const inp of allInputs) {
          const v = (inp.value || inp.getAttribute('value') || '').trim();
          if (v.length > 15 && v.length < 300) return v;
        }
        // Check for code/pre blocks
        const codes = document.querySelectorAll('code, pre, [class*="key"], [class*="token"], [class*="apikey"], [data-key]');
        for (const c of codes) {
          const t = c.textContent.trim();
          if (t.length > 10 && t.length < 300 && /^[A-Za-z0-9_\-:/+=.]+$/.test(t)) return t;
        }
        // Check clipboard elements
        const clips = document.querySelectorAll('[data-clipboard-text], [data-copy], [aria-label*="copy"], [title*="copy"]');
        for (const c of clips) {
          const v = c.getAttribute('data-clipboard-text') || c.getAttribute('data-copy') || c.textContent.trim();
          if (v.length > 10) return v;
        }
        // Check textareas
        const ta = document.querySelectorAll('textarea');
        for (const t of ta) {
          const v = t.value.trim();
          if (v.length > 10) return v;
        }
        // Broad regex scan
        const body = document.body?.innerText || '';
        const match = body.match(/\b(sk-[A-Za-z0-9_\-]{20,}|ea-[A-Za-z0-9_\-]{20,}|AI[A-Za-z0-9_\-]{30,}|[A-Za-z0-9_\-/+=.]{30,100})\b/);
        if (match) return match[1];
        return '';
      }).catch(() => '');
      if (apiKey) {
        log(`[${email}] ✅ API key: ${apiKey.substring(0, 32)}...`);
      }

      // If still no key, try GraphQL queries with credentials:'include'
      if (!apiKey) {
        log(`[${email}] No API key in DOM — trying GraphQL...`);
        const possibleQueries = [
          `query { viewer { user { id name email } developerApiKeys { edges { node { id key name createdAt } } } } }`,
          `query { me { apiKeys { id key name createdAt } } }`,
          `query { currentUser { apiKeys { id key name } } }`,
        ];
        let graphqlRes = '';
        for (const q of possibleQueries) {
          try {
            const res = await page.evaluate(async (queryStr) => {
              const r = await fetch('/api/graphql/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ query: queryStr })
              });
              return (await r.text()).substring(0, 2000);
            }, q).catch(() => '');
            if (res && !res.includes('<!DOCTYPE') && !res.includes('login') && !(res.length < 500 && res.includes('error'))) {
              graphqlRes = res;
              log(`[${email}] GraphQL success`);
              break;
            }
          } catch {}
        }
        log(`[${email}] GraphQL: ${graphqlRes.substring(0, 300)}`);
        const gk = graphqlRes.match(/"key"\s*:\s*"((?:sk-|ea-|AI)[^"]+)"/i) || graphqlRes.match(/"key"\s*:\s*"([^"]+)"/);
        if (gk) apiKey = gk[1];
      }

      // Strategy 4: Try /api/keys endpoint
      if (!apiKey && page.url().includes('meta.com') || page.url().includes('facebook.com')) {
        try {
          log(`[${email}] Trying /api/keys endpoint...`);
          const apiRes = await page.evaluate(async () => {
            const r = await fetch('/api/keys', { credentials: 'include' });
            return (await r.text()).substring(0, 1000);
          }).catch(() => '');
          log(`[${email}] /api/keys: ${apiRes.substring(0, 200)}`);
          const ak = apiRes.match(/"key"\s*:\s*"([^"]+)"/) || apiRes.match(/sk-[A-Za-z0-9_-]{20,}/);
          if (ak) apiKey = ak[1] || ak[0];
        } catch {}
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
    log(`Attempt ${attempt} failed (proxyAttempt=${proxyAttempt}): ${err.message}`);
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
    // If region error already handled above, this is a different failure
    // Retry with same proxy if attempt < MAX_RETRIES
    if (attempt < MAX_RETRIES) {
      log(`Retrying... (${attempt + 1}/${MAX_RETRIES})`);
      await browser.close().catch(() => {});
      return registerOne(attempt + 1, proxyAttempt);
    }
    // Exhausted retries on this proxy — try next proxy
    if (proxyAttempt < MAX_PROXY_ATTEMPTS) {
      log(`Switching proxy (attempt ${proxyAttempt + 1}/${MAX_PROXY_ATTEMPTS})...`);
      await browser.close().catch(() => {});
      return registerOne(0, proxyAttempt + 1);
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
