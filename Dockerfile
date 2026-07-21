FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY bokumail.js bot.js proxies.txt ./
RUN test -s proxies.txt && echo "proxies.txt included:" && wc -l proxies.txt && head -1 proxies.txt | sed 's/:.*@/:***@/'

ENV TARGET=5
ENV HEADLESS=1
ENV UPLOAD_UGUU=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

CMD ["node", "bot.js"]
