/**
 * mailtm.js — Wrapper untuk API mail.tm
 * Dokumentasi: https://docs.mail.tm
 */

import axios from "axios";

const BASE_URL = "https://api.mail.tm";

/**
 * Buat instance axios dengan timeout default.
 */
const api = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
  },
});

/**
 * Ambil daftar domain yang tersedia.
 * @returns {Promise<string>} domain pertama yang aktif
 */
async function getDomain() {
  const res = await api.get("/domains?page=1");
  const domains = res.data["hydra:member"] || res.data.member || res.data;
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new Error("Tidak ada domain yang tersedia dari mail.tm saat ini.");
  }
  // Cari domain yang aktif
  const active = domains.find((d) => d.isActive !== false) || domains[0];
  return active.domain;
}

/**
 * Buat akun baru di mail.tm.
 * @param {string} address - email lengkap, misal: user@domain.com
 * @param {string} password - password akun
 * @returns {Promise<{id: string, address: string}>}
 */
async function createAccount(address, password) {
  const res = await api.post("/accounts", { address, password });
  return { id: res.data.id, address: res.data.address };
}

/**
 * Login dan dapatkan token JWT.
 * @param {string} address
 * @param {string} password
 * @returns {Promise<{id: string, token: string}>}
 */
async function getToken(address, password) {
  const res = await api.post("/token", { address, password });
  return { id: res.data.id, token: res.data.token };
}

/**
 * Ambil daftar pesan di inbox.
 * @param {string} token - JWT token
 * @returns {Promise<Array>} daftar pesan
 */
async function getMessages(token) {
  const res = await api.get("/messages?page=1", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data["hydra:member"] || res.data.member || res.data || [];
}

/**
 * Ambil detail satu pesan berdasarkan ID.
 * @param {string} token
 * @param {string} messageId
 * @returns {Promise<Object>} detail pesan
 */
async function getMessage(token, messageId) {
  const res = await api.get(`/messages/${messageId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data;
}

/**
 * Hapus akun dari mail.tm.
 * @param {string} token
 * @param {string} accountId
 * @returns {Promise<boolean>}
 */
async function deleteAccount(token, accountId) {
  await api.delete(`/accounts/${accountId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return true;
}

/**
 * Download attachment dari pesan.
 * @param {string} token
 * @param {string} messageId
 * @param {number} attachmentIndex - index attachment dalam array
 * @returns {Promise<{data: Buffer, contentType: string, filename: string}>}
 */
async function downloadAttachment(token, messageId, attachmentIndex) {
  // Ambil detail pesan dulu untuk dapat info attachment
  const message = await getMessage(token, messageId);
  const attachments = message.attachments || [];

  if (attachmentIndex < 0 || attachmentIndex >= attachments.length) {
    throw new Error("Lampiran tidak ditemukan.");
  }

  const attachment = attachments[attachmentIndex];

  // mail.tm menyimpan URL download di field `downloadUrl` atau kita bangun dari `id`
  let downloadUrl = attachment.downloadUrl || `/messages/${messageId}/attachment/${attachment.id}`;

  // Kalau URL tidak absolut, tambahkan base
  if (!downloadUrl.startsWith("http")) {
    downloadUrl = BASE_URL + downloadUrl;
  }

  const res = await axios.get(downloadUrl, {
    headers: { Authorization: `Bearer ${token}` },
    responseType: "arraybuffer",
    timeout: 30000,
  });

  const contentType = res.headers["content-type"] || attachment.contentType || "application/octet-stream";
  const filename = attachment.filename || attachment.name || `lampiran_${attachmentIndex + 1}`;

  return {
    data: Buffer.from(res.data),
    contentType,
    filename,
  };
}

/**
 * Helper: coba login ulang otomatis jika token expired (error 401).
 * @param {Function} fn - fungsi yang memanggil API (async)
 * @param {Object} userData - data user dari DB (berisi address, password, token)
 * @param {Function} updateTokenFn - callback untuk simpan token baru
 */
async function withAutoRelogin(fn, userData, updateTokenFn) {
  try {
    return await fn(userData.token);
  } catch (err) {
    if (err.response && err.response.status === 401) {
      // Token expired, login ulang
      try {
        const { token } = await getToken(userData.address, userData.password);
        await updateTokenFn(token);
        userData.token = token;
        return await fn(token);
      } catch (reloginErr) {
        throw new Error("Sesi expired dan gagal login ulang. Coba hapus email dan buat baru.");
      }
    }
    throw err;
  }
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
};
