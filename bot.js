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
  // Bokumanga API ignores prefix, generates random email itself.
  // We pass domain only and use what it returns.
  const placeholder = `meta${randStr(8)}@${domain}`;
  const pass = `Mp${randStr(12)}!`;
  const { id, address: actualEmail } = await createAccount(placeholder, pass);
  const { token } = await getToken(actualEmail, pass);
  log(`createInbox: placeholder=${placeholder} actual=${actualEmail}`);
  return { email: actualEmail, pass, token, accountId: id };
}

async function pollOtp(token, email, timeoutMs = 180000) {
  const start = Date.now();
  const seen = new Set();
  while (Date.now() - start < timeoutMs) {
    try {
      const msgs = await getMessages(token);
      // Sort by date newest first (if available) — but in-date might not be ordered
      // Only look at emails FROM Meta (notification@email.meta.com or similar)
      const metaMsgs = msgs.filter(m =>
        /@meta\.com|@facebookmail\.com|@facebook\.com/i.test(m.from || '') ||
        /meta|facebook/i.test(m.from || '') ||
        /confirmation code|verify your account|confirm your account|enter.*code/i.test(m.subject || '')
      );
      const targets = metaMsgs.length > 0 ? metaMsgs : msgs; // fallback to all if no meta email found
      for (const m of targets) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        let full;
        try { full = await getMessage(token, m.id); } catch { continue; }
        const rawHtml = full.html || '';
        const text = full.text || '';
        // Strip CSS hex colors (#RRGGBB) and hex-like tokens BEFORE scanning for OTP digits.
        // Meta emails contain `color:#141823` which is NOT the OTP — it's a known false positive.
        const htmlNoHex = rawHtml.replace(/#[0-9a-fA-F]{3,8}\b/g, ' ');
        // Also strip HTML entities like &#064; and inline style attrs to avoid numeric noise
        const htmlCleaned = htmlNoHex.replace(/&#[0-9]+;/g, ' ').replace(/style="[^"]*"/gi, ' ');
        const combined = `${full.subject || ''} | ${text} | ${htmlCleaned}`;
        log(`  [pollOtp] Email from=${full.from} subj=${full.subject?.substring(0, 80)} bodyPreview=${(text || rawHtml).substring(0, 200).replace(/\n/g,' ')}`);

        let code = null;

        // 1) Meta-specific: the confirmation code is wrapped in a large-font div:
        //    <div style="font-size: 24px;...">812114</div>
        // This is the most reliable signal — the actual OTP is styled big.
        const styledDiv = rawHtml.match(/font-size:\s*2[0-9]px[^>]*>\s*([0-9]{6})\s*</i);
        if (styledDiv) {
          code = styledDiv[1];
          log(`    Found via styledDiv (font-size:2xpx): ${code}`);
        }

        // 2) Keyword-based: "confirmation code" followed by digits (allow non-digit separator up to 80 chars)
        if (!code) {
          const kwPattern = /(?:confirmation code|your code|enter.*code|verify.*code|code is|code:)[^\d]{0,80}([0-9]{6})/i;
          const kwMatch = combined.match(kwPattern);
          if (kwMatch) { code = kwMatch[1]; log(`    Found via kwPattern: ${code}`); }
        }

        // 3) Near pattern on cleaned (no hex) html
        if (!code) {
          const nearMatch = combined.match(/([0-9]{6})[^\d]{0,30}(?:confirm|code|verify|digit)/i) ||
                            combined.match(/(?:confirm|code|verify|digit)[^\d]{0,30}([0-9]{6})/i);
          if (nearMatch) {
            const g = nearMatch[1];
            if (/^[0-9]{6}$/.test(g)) { code = g; log(`    Found via nearPattern: ${code}`); }
          }
        }

        // 4) Fallback: collect ALL 6-digit from hex-stripped text, skip known false positives
        if (!code) {
          const allSix = [...combined.matchAll(/\b([0-9]{6})\b/g)].map(x => x[1]);
          if (allSix.length) {
            // Filter out known non-OTP numbers (CSS hex leftovers like 141823, ffffff, etc.)
            const filtered = allSix.filter(c => !['141823','ffffff','1c1e21','141823','000000'].includes(c.toLowerCase()));
            code = filtered[filtered.length - 1] || allSix[allSix.length - 1];
            log(`    Fallback allSix=[${allSix.join(',')}] → picking ${code}`);
          }
        }

        if (code && /^\d{6}$/.test(code)) {
          log(`    ✅ OTP = ${code} (from ${full.from})`);
          return { code, messageId: m.id };
        }
      }
    } catch (e) {
      log(`pollOtp error: ${e.message}`);
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

    // Setup network capture BEFORE submit — intercept API key creation
    let capturedApiKey = '';
    let capturedResponses = [];
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('api.meta.ai') || url.includes('dev.meta.ai') || url.includes('auth.meta.com') || url.includes('facebook.com')) {
        if (url.includes('/v1/') || url.includes('api_key') || url.includes('api-key') || url.includes('graphql') || url.includes('/api/') || url.includes('register') || url.includes('oidc')) {
          try {
            const txt = await response.text();
            const llmMatch = txt.match(/LLM\|\d+\|[A-Za-z0-9_-]{15,}/);
            const keyFieldMatch = txt.match(/"api_key"\s*:\s*"(LLM[^"]+)"/) || txt.match(/"key"\s*:\s*"(LLM\|[^"]+)"/);
            if (llmMatch || keyFieldMatch) {
              const foundKey = keyFieldMatch ? keyFieldMatch[1] : llmMatch[0];
              if (!capturedApiKey) {
                capturedApiKey = foundKey;
                log(`[${email}] 📡 Captured API key: ${url.substring(0, 100)} → ${capturedApiKey.substring(0, 40)}...`);
              }
            }
            if (txt.length > 20 && txt.length < 10000) {
              // Log interesting responses that might contain key/redirect
              const isInteresting = /api_?key|LLM\|/i.test(txt) || /dev\.meta\.ai/i.test(txt);
              if (isInteresting) {
                capturedResponses.push({ url: url.substring(0, 150), status: response.status(), body: txt.substring(0, 1000) });
              }
            }
          } catch {}
        }
      }
    });

    // Enter OTP — find 6-digit input or single inputs
    await enterOtp(page, otp.code);
    await page.waitForTimeout(2000);

    // Submit OTP (Next/Continue/Verify/Confirm) — use waitForNavigation not fixed sleep
    const submitBtn = page.getByRole('button', { name: /next|continue|verify|confirm/i }).first();
    if (await submitBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      log(`[${email}] Clicking Next/Continue button`);
      const text1 = await submitBtn.textContent().catch(() => 'unknown');
      log(`[${email}] Button text: "${text1}"`);
      // Click with navigation wait
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
          submitBtn.click({ timeout: 10000 }).catch(() => {}),
        ]);
      } catch {}
      // Some Meta flows use evaluate click, try that too if URL didn't change
      await page.waitForTimeout(3000);
      if (page.url().includes('register/confirm')) {
        log(`[${email}] Still on confirm after click, trying evaluate click`);
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('[role=\"button\"]'));
          const nextBtn = btns.find(b => /next|continue|verify|confirm/i.test(b.textContent));
          if (nextBtn) nextBtn.click();
        }).catch(() => {});
        await page.waitForTimeout(5000);
      }
    } else {
      log(`[${email}] No submit button visible, trying Enter key`);
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(5000);
    }

    // === Post-OTP submit & redirect handling ===
    let postOtpUrl = page.url().substring(0, 150);
    let postOtpText = '';
    try { postOtpText = await page.evaluate(() => (document.body?.innerText || '').substring(0, 600)); } catch {}
    log(`[${email}] After OTP submit — URL: ${postOtpUrl}`);
    log(`[${email}] After OTP submit — Page: ${postOtpText.substring(0, 350)}`);

    // If still on confirm page, try additional button clicks
    if (postOtpUrl.includes('register/confirm')) {
      for (let i = 0; i < 4; i++) {
        await page.waitForTimeout(3000);
        const loopUrl = page.url();
        if (!loopUrl.includes('register/confirm')) {
          log(`[${email}] Left confirm page: ${loopUrl.substring(0, 100)}`);
          break;
        }
        log(`[${email}] Still on confirm, clicking buttons (attempt ${i + 1}), capturedResponses=${capturedResponses.length}`);
        try {
          const btns = await page.getByRole('button').all();
          let clicked = false;
          for (const b of btns) {
            const txt = await b.textContent().catch(() => '');
            if (/continue|confirm|verify|next|ok/i.test(txt)) {
              const visible = await b.isVisible({ timeout: 1000 }).catch(() => false);
              if (visible) {
                log(`[${email}] Clicking button: "${txt}"`);
                await b.click({ timeout: 5000 }).catch(() => {});
                await page.waitForTimeout(3000);
                clicked = true;
                break;
              }
            }
          }
          if (!clicked) {
            log(`[${email}] No usable buttons found, checking network for redirect/code`);
            break;
          }
        } catch {}
      }
    }

    // Log captured responses
    if (capturedResponses.length > 0) {
      log(`[${email}] Captured ${capturedResponses.length} interesting network responses`);
      for (const r of capturedResponses.slice(-3)) {
        log(`[${email}]  - ${r.status} ${r.url.substring(0, 80)} → ${r.body.substring(0, 200)}`);
      }
    }

    // Capture cookies from current page (before redirect)
    const cookies = await context.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Wait for redirect to dev.meta.ai after successful OTP
    log(`[${email}] Waiting for redirect to dev.meta.ai...`);
    let landedOnDevMeta = false;
    for (let i = 0; i < 20; i++) {
      const url = page.url();
      if (url.includes('dev.meta.ai') && !url.includes('oidc') && !url.includes('auth.meta.com')) {
        landedOnDevMeta = true;
        break;
      }
      // Try clicking any visible "Continue" button (post-OTP confirmation)
      try {
        const contBtn = page.getByRole('button', { name: /continue|confirm|verify|next/i }).first();
        if (await contBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await contBtn.click({ timeout: 5000 }).catch(() => {});
        }
      } catch {}
      await page.waitForTimeout(2000);
    }

    // If still not on dev.meta.ai, navigate manually
    if (!landedOnDevMeta) {
      log(`[${email}] Redirect didn't land on dev.meta.ai, navigating manually...`);
      await page.goto('https://dev.meta.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(5000);
    }

    log(`[${email}] Final URL: ${page.url().substring(0, 100)}`);

    const devCookies = await context.cookies('https://dev.meta.ai');
    const devCookieStr = devCookies.map(c => `${c.name}=${c.value}`).join('; ');

    // Try to grab access token from localStorage
    const token = await page.evaluate(() => {
      return localStorage.getItem('access_token') ||
             localStorage.getItem('token') ||
             localStorage.getItem('accessToken') || '';
    }).catch(() => '');

    // === API key extraction — priority: network capture > dashboard ===
    let apiKey = capturedApiKey || '';
    if (apiKey) {
      log(`[${email}] ✅ API key from network capture: ${apiKey.substring(0, 40)}...`);
    }

    // If not captured from network, try dashboard extraction
    if (!apiKey) {
    try {
      log(`[${email}] Not captured from network, trying dashboard...`);

      // Navigate to dev.meta.ai (if not already there)
      const currUrl = page.url();
      if (!currUrl.includes('dev.meta.ai')) {
        log(`[${email}] Navigating to dev.meta.ai...`);
        await page.goto('https://dev.meta.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(5000);
        log(`[${email}] After goto dev.meta.ai — URL: ${page.url().substring(0, 100)}`);
      }

      // Log page content
      const pageContent = await page.evaluate(() => {
        return {
          url: location.href,
          title: document.title,
          text: (document.body?.innerText || '').substring(0, 3000),
          lsKeys: Object.keys(localStorage || {}).join(', '),
        };
      }).catch(() => ({ url: '', title: '', text: '', lsKeys: '' }));
      log(`[${email}] URL: ${pageContent.url.substring(0, 100)}`);
      log(`[${email}] Title: ${pageContent.title}`);
      log(`[${email}] Page text: ${pageContent.text.substring(0, 500)}`);

      // Check localStorage for API key tokens
      const lsData = await page.evaluate(() => {
        const keys = Object.keys(localStorage);
        const result = {};
        for (const k of keys) {
          try {
            const v = localStorage.getItem(k);
            if (v && v.length > 15 && v.length < 1000 && !v.startsWith('{') && !v.startsWith('[')) {
              if (k === 'Session' || k === 'signal_flush_timestamp' || k === 'hb_timestamp' || k === 'banzai:last_storage_flush') continue;
              result[k] = v.substring(0, 200);
            }
          } catch {}
        }
        return result;
      }).catch(() => ({}));
      const lsKeys = Object.keys(lsData);
      if (lsKeys.length > 0) {
        log(`[${email}] localStorage: ${lsKeys.length} keys`);
        for (const k of lsKeys) {
          const v = lsData[k] || '';
          if (/LLM\|\d+\|/.test(v)) { apiKey = v.match(/LLM\|\d+\|[A-Za-z0-9_-]{15,}/)?.[0] || v; break; }
          log(`[${email}]   LS ${k} → ${v.substring(0, 80)}`);
        }
      }

      // Scan page text for LLM| pattern
      if (!apiKey && pageContent.text) {
        const m = pageContent.text.match(/LLM\|\d+\|[A-Za-z0-9_-]{15,}/);
        if (m) { apiKey = m[0]; log(`[${email}] ✅ API key from page text: ${apiKey.substring(0, 40)}...`); }
      }

      // Try to find API key in all inputs / buttons / code blocks
      if (!apiKey) {
        const pageKey = await page.evaluate(() => {
          // Check inputs
          for (const inp of document.querySelectorAll('input')) {
            const v = (inp.value || '').trim();
            if (/LLM\|\d+\|/.test(v)) return v;
          }
          // Check code/pre elements
          for (const el of document.querySelectorAll('code, pre, [class*=\"api\"], [class*=\"key\"], [data-testid*=\"key\"], [data-testid*=\"api\"]')) {
            const t = (el.textContent || '').trim();
            if (/LLM\|\d+\|/.test(t)) {
              const mm = t.match(/LLM\|\d+\|[A-Za-z0-9_-]{15,}/);
              if (mm) return mm[0];
            }
          }
          // Check entire body for LLM pattern
          const body = document.body?.innerText || '';
          const mm = body.match(/LLM\|\d+\|[A-Za-z0-9_-]{15,}/);
          if (mm) return mm[0];
          return '';
        }).catch(() => '');
        if (pageKey) { apiKey = pageKey; log(`[${email}] ✅ API key from DOM scan: ${apiKey.substring(0, 40)}...`); }
      }

      // Try GraphQL and REST endpoints on dev.meta.ai
      if (!apiKey) {
        try {
          log(`[${email}] Trying GraphQL endpoints...`);
          const queries = [
            'query { viewer { user { id name } developerApiKeys { edges { node { id key name } } } } }',
            'query { viewer { apiKeys { id key } } }',
            'query { me { apiKey } }',
          ];
          for (const q of queries) {
            const gqlRes = await page.evaluate(async (query) => {
              try {
                const r = await fetch('/api/graphql/', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include',
                  body: JSON.stringify({ query }),
                });
                return { status: r.status, text: (await r.text()).substring(0, 2000), url: r.url };
              } catch (e) { return { status: 0, text: e.message, url: '' }; }
            }, q).catch(() => ({ status: 0, text: 'error', url: '' }));
            if (/LLM\|\d+\|/.test(gqlRes.text)) {
              const m = gqlRes.text.match(/LLM\|\d+\|[A-Za-z0-9_-]{15,}/);
              if (m) { apiKey = m[0]; log(`[${email}] ✅ API key from GraphQL: ${apiKey.substring(0, 40)}...`); break; }
            }
          }

          // Also try REST: /api/keys or /api/api_keys
          if (!apiKey) {
            const restUrls = ['/api/keys', '/api/api_keys', '/api/v1/keys', '/api/v1/api_keys', '/api/model/keys'];
            for (const restPath of restUrls) {
              const restRes = await page.evaluate(async (url) => {
                try {
                  const r = await fetch(url, { credentials: 'include' });
                  return { status: r.status, text: (await r.text()).substring(0, 2000) };
                } catch (e) { return { status: 0, text: e.message }; }
              }, restPath).catch(() => ({ status: 0, text: '' }));
              if (/LLM\|\d+\|/.test(restRes.text)) {
                const m = restRes.text.match(/LLM\|\d+\|[A-Za-z0-9_-]{15,}/);
                if (m) { apiKey = m[0]; log(`[${email}] ✅ API key from REST ${restPath}: ${apiKey.substring(0, 40)}...`); break; }
              }
            }
          }
        } catch (e) { log(`[${email}] API query failed: ${e.message}`); }
      }

      // Try API.meta.ai directly with cookies — create API key if needed
      if (!apiKey) {
        try {
          log(`[${email}] Trying api.meta.ai directly...`);
          const allCookies = await context.cookies();
          const metaCookies = allCookies.filter(c => c.domain.includes('meta.com') || c.domain.includes('meta.ai'));
          log(`[${email}] Meta cookies: ${metaCookies.map(c => c.name).join(', ')}`);

          // Try to create an API key via api.meta.ai using session
          // The API key creation flow might be POST /v1/api_keys or similar
          const createEndpoints = [
            { url: 'https://api.meta.ai/v1/api-keys', method: 'POST', body: JSON.stringify({ name: 'my-key' }) },
            { url: 'https://api.meta.ai/v1/keys', method: 'POST', body: JSON.stringify({ name: 'my-key' }) },
            { url: 'https://dev.meta.ai/api/keys', method: 'POST', body: JSON.stringify({ name: 'my-key' }) },
          ];
          for (const ep of createEndpoints) {
            const createRes = await page.evaluate(async (endpoint) => {
              try {
                const r = await fetch(endpoint.url, {
                  method: endpoint.method,
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include',
                  body: endpoint.body,
                });
                return { status: r.status, text: (await r.text()).substring(0, 2000) };
              } catch (e) { return { status: 0, text: e.message }; }
            }, ep).catch(() => ({ status: 0, text: '' }));
            log(`[${email}] Create key ${ep.url}: ${createRes.status} → ${createRes.text.substring(0, 200)}`);
            if (/LLM\|\d+\|/.test(createRes.text)) {
              const m = createRes.text.match(/LLM\|\d+\|[A-Za-z0-9_-]{15,}/);
              if (m) { apiKey = m[0]; log(`[${email}] ✅ API key created via ${ep.url}: ${apiKey.substring(0, 40)}...`); break; }
            }
          }
        } catch (e) { log(`[${email}] Direct API attempt failed: ${e.message}`); }
      }
    } catch (e) {
      log(`[${email}] API key extraction error: ${e.message}`);
    }
    } // end if !apiKey from network

    // Use captured from network as fallback if still no key
    if (!apiKey && capturedApiKey) {
      apiKey = capturedApiKey;
      log(`[${email}] Using captured API key from network: ${apiKey.substring(0, 40)}...`);
    }

    // If network responses didn't capture but had interesting data
    if (!apiKey && capturedResponses.length > 0) {
      for (const r of capturedResponses) {
        const m = r.body.match(/LLM\|\d+\|[A-Za-z0-9_-]{15,}/);
        if (m) { apiKey = m[0]; log(`[${email}] ✅ API key from captured response: ${apiKey.substring(0, 40)}...`); break; }
      }
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
  log(`Entering OTP ${code} — checking page structure...`);
  // Log inputs
  try {
    const inputs = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('input'));
      return all.map((inp, i) => `${i}: type=${inp.type} name=${inp.name} maxLen=${inp.maxLength} autoComplete=${inp.autocomplete} inputMode=${inp.inputMode} value=${inp.value} class=${inp.className.substring(0, 50)}`);
    });
    log(`OTP inputs: ${inputs.join(' | ').substring(0, 600)}`);
  } catch {}

  // Try 6 separate inputs (most common for Meta)
  const sixInputs = page.locator('input[maxlength="1"]');
  let sixCount = 0;
  try { sixCount = await sixInputs.count(); } catch {}
  if (sixCount >= 6) {
    log(`Found ${sixCount} single-char inputs, filling one-by-one`);
    for (let i = 0; i < 6; i++) {
      await sixInputs.nth(i).click({ timeout: 2000 }).catch(() => {});
      await sixInputs.nth(i).fill(code[i], { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(200);
    }
    return;
  }

  // Try single input
  const single = page.locator('input[name="code"], input[name="otp"], input[autocomplete="one-time-code"], input[inputmode="numeric"][maxlength="6"], input[type="text"][maxlength="6"]').first();
  if (await single.isVisible({ timeout: 3000 }).catch(() => false)) {
    log('Single OTP input found');
    await single.click({ timeout: 2000 }).catch(() => {});
    await single.fill(code, { timeout: 5000 }).catch(() => {});
    return;
  }

  // Try numeric inputs more broadly
  const numericInputs = page.locator('input[inputmode="numeric"], input[type="number"], input[name*="code"], input[id*="code"]');
  const numericCount = await numericInputs.count().catch(() => 0);
  if (numericCount >= 6) {
    log(`Found ${numericCount} numeric inputs`);
    for (let i = 0; i < 6; i++) {
      await numericInputs.nth(i).fill(code[i], { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(100);
    }
    return;
  }
  if (numericCount >= 1) {
    await numericInputs.first().fill(code, { timeout: 5000 }).catch(() => {});
    return;
  }

  // Fallback: keyboard type
  log('Fallback keyboard.type');
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.press('Delete').catch(() => {});
  await page.keyboard.type(code, { delay: 80 });
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
