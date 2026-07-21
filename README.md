# Meta AI Bulk Registration Bot

Deploy ke Railway untuk bulk register akun dev.meta.ai. Railway IP region US = bypass region lock.

## Env vars

| Var | Default | Desc |
|---|---|---|
| `TARGET` | `5` | Jumlah akun yang dibuat |
| `OUTPUT_FILE` | `accounts.txt` | Output file |
| `PASSWORD` | `Xk9#mB2$pL7!nQ4v` | Password untuk semua akun |
| `HEADLESS` | `1` | `0` untuk headed (debug) |
| `UPLOAD_UGUU` | `0` | `1` = upload output ke uguu.se saat selesai |

## Output

File `accounts.txt` dengan format:
```
email|password|token|cookies
```

## Local test

```bash
cd /home/rafacorps/metaai-bot
npm install
npx playwright install chromium
TARGET=2 HEADLESS=1 node bot.js
```

## Railway deploy

1. Push repo ke `cabalspam7/metaai-bot` (public)
2. Railway: New Service → GitHub Repo → pilih `metaai-bot`
3. Set env: `TARGET=5`, `HEADLESS=1`
4. Deploy → logs muncul di Railway dashboard
5. Setelah selesai, `accounts.txt` di-download dari Railway volume atau via uguu upload
