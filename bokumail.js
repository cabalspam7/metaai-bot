/**
 * bokumail.js — Wrapper untuk TempBokuMail API (https://email-api.bokumanga.my.id)
 * Drop-in replacement untuk mailtm.js dengan signature yang sama.
 *
 * API: TempBokuMail v2.0
 *   GET  /create?domain=X        → {success, email, domain, prefix}
 *   GET  /domains                → {success, domains:[...], count}
 *   GET  /check?email=X          → {success, emails:[{key, from, subject, date}]}
 *   GET  /read?key=KEY           → {success, email:{to, from, subject, date, raw}}
 *   GET  /wait?email=X&timeout=N → {success, emails:[...], timeout:bool}
 *   DELETE /inbox?email=X        → hapus inbox
 *
 * Karena bokumanga API tidak butuh auth/token (inbox = email address),
 * kita map: token = email address, accountId = email address.
 */

import axios from "axios";

const BASE_URL = process.env.BOKUMAIL_API || "https://email-api.bokumanga.my.id";

const api = axios.create({
  baseURL: BASE_URL,
  timeout: 20000,
  headers: { Accept: "application/json" },
});

// Cache domain list (rotate untuk distribusi)
let _domainsCache = null;
let _domainIdx = 0;

/**
 * Ambil daftar domain, return salah satu secara random/round-robin.
 * @returns {Promise<string>}
 */
async function getDomain() {
  if (!_domainsCache) {
    const res = await api.get("/domains");
    _domainsCache = res.data.domains || [];
    if (_domainsCache.length === 0) {
      throw new Error("Tidak ada domain tersedia dari TempBokuMail.");
    }
  }
  // Round-robin untuk distribusi
  const d = _domainsCache[_domainIdx % _domainsCache.length];
  _domainIdx++;
  return d;
}

/**
 * Buat inbox baru. Untuk bokumanga, "create account" = create inbox.
 * Password diabaikan (API tidak butuh auth).
 * @returns {Promise<{id: string, address: string}>}
 */
async function createAccount(address, password) {
  // address = user@domain; bokumanga generate prefix sendiri jika tidak diisi
  // Tapi kita bisa specify domain via ?domain=
  let domain = null;
  if (address && address.includes("@")) {
    domain = address.split("@")[1];
  }
  const url = "/create" + (domain ? `?domain=${encodeURIComponent(domain)}` : "");
  const res = await api.get(url);
  if (!res.data.success) {
    throw new Error(`BokuMail create failed: ${JSON.stringify(res.data)}`);
  }
  return { id: res.data.email, address: res.data.email };
}

/**
 * Bokumanga tidak punya token JWT. Kita return email sebagai "token" (dipakai
 * sebagai identifier di getMessages/getMessage).
 * @returns {Promise<{id: string, token: string}>}
 */
async function getToken(address, password) {
  return { id: address, token: address };
}

/**
 * Ambil daftar pesan di inbox.
 * @param {string} token — email address (di bokumanga, token = email)
 * @returns {Promise<Array<{id: string, from: string, subject: string, date: string}>>}
 */
async function getMessages(token) {
  const res = await api.get("/check", { params: { email: token } });
  if (!res.data.success) return [];
  const emails = res.data.emails || [];
  // Map key → id untuk kompatibilitas dengan bot.js (yang pakai m.id)
  return emails.map((e) => ({
    id: e.key,
    from: e.from,
    subject: e.subject,
    date: e.date,
  }));
}

/**
 * Ambil detail satu pesan. Parse raw RFC822 untuk extract text/html body.
 * @param {string} token — email (tidak dipakai di bokumanga, tapi konsisten)
 * @param {string} messageId — key dari getMessages
 * @returns {Promise<{id, from, subject, text, html, date}>}
 */
async function getMessage(token, messageId) {
  const res = await api.get("/read", { params: { key: messageId } });
  if (!res.data.success) {
    throw new Error(`BokuMail read failed: ${JSON.stringify(res.data)}`);
  }
  const email = res.data.email || {};
  const raw = email.raw || "";

  // Parse raw RFC822 untuk extract body (text + html)
  const { text, html } = parseRawEmail(raw);

  return {
    id: messageId,
    from: email.from,
    subject: email.subject,
    text,
    html,
    date: email.date,
    raw,
  };
}

/**
 * Hapus inbox.
 * @param {string} token — email
 * @param {string} accountId — email (sama)
 * @returns {Promise<boolean>}
 */
async function deleteAccount(token, accountId) {
  try {
    await api.delete("/inbox", { params: { email: accountId || token } });
    return true;
  } catch {
    return false;
  }
}

/**
 * Long-poll untuk email masuk. Mengembalikan daftar pesan baru.
 * Wrapper untuk /wait endpoint.
 * @param {string} email
 * @param {number} timeout — detik
 * @returns {Promise<Array>}
 */
async function waitForEmail(email, timeout = 30) {
  const res = await api.get("/wait", {
    params: { email, timeout },
    timeout: (timeout + 5) * 1000, // axios timeout sedikit lebih besar
  });
  if (!res.data.success) return [];
  return (res.data.emails || []).map((e) => ({
    id: e.key,
    from: e.from,
    subject: e.subject,
    date: e.date,
  }));
}

/**
 * Helper: parse raw RFC822 email untuk extract text & html body.
 * Mendukung: plain text, multipart/alternative, multipart/mixed.
 * Decoding: quoted-printable & base64.
 */
function parseRawEmail(raw) {
  let text = "";
  let html = "";

  // Split header/body
  const bodyMatch = raw.match(/\r?\n\r?\n([\s\S]*)$/);
  const bodyPart = bodyMatch ? bodyMatch[1] : raw;
  const headerPart = bodyMatch ? raw.substring(0, bodyMatch.index) : "";

  // Extract Content-Type & Transfer-Encoding dari top-level header
  const ctMatch = headerPart.match(/Content-Type:\s*([^;\r\n]+)/i);
  const contentType = ctMatch ? ctMatch[1].trim().toLowerCase() : "text/plain";
  const cteMatch = headerPart.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i);
  const encoding = cteMatch ? cteMatch[1].trim().toLowerCase() : "";

  if (contentType.startsWith("multipart/")) {
    // Extract boundary
    const bMatch = headerPart.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i);
    if (bMatch) {
      const boundary = bMatch[1].trim();
      const parts = splitMultipart(bodyPart, boundary);
      for (const part of parts) {
        const { text: pt, html: ph } = parseRawEmail(part);
        if (pt && !text) text = pt;
        if (ph && !html) html = ph;
      }
    }
  } else {
    // Single part
    let decoded = bodyPart;
    if (encoding === "base64") {
      try { decoded = Buffer.from(decoded.trim(), "base64").toString("utf-8"); } catch {}
    } else if (encoding === "quoted-printable") {
      decoded = decodeQP(decoded);
    }
    if (contentType.includes("text/html")) {
      html = decoded;
    } else {
      text = decoded;
    }
  }

  return { text, html };
}

function splitMultipart(body, boundary) {
  const delim = `--${boundary}`;
  const parts = body.split(delim);
  const result = [];
  for (let i = 1; i < parts.length - 1; i++) {
    // Skip preamble & epilogue
    let p = parts[i];
    // Remove leading CRLF and trailing CRLF before next boundary
    p = p.replace(/^\r?\n/, "").replace(/\r?\n--$/, "");
    result.push(p);
  }
  return result;
}

function decodeQP(str) {
  // Quoted-printable decode
  return str
    .replace(/=\r?\n/g, "") // soft line breaks
    .replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Helper: coba login ulang otomatis jika token expired (error 401).
 * Bokumanga tidak punya token expiration, jadi ini pass-through.
 */
async function withAutoRelogin(fn, userData, updateTokenFn) {
  return await fn(userData.token);
}

/**
 * Download attachment — bokumanga API tidak expose attachment download terpisah.
 * Return empty untuk kompatibilitas.
 */
async function downloadAttachment(token, messageId, attachmentIndex) {
  throw new Error("BokuMail API tidak mendukung attachment download terpisah.");
}

export {
  getDomain,
  createAccount,
  getToken,
  getMessages,
  getMessage,
  deleteAccount,
  downloadAttachment,
  withAutoRelogin,
  waitForEmail,
};
