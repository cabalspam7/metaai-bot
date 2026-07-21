FROM mcr.microsoft.com/playwright:v1.49.1-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY mailtm.js bot.js ./

ENV TARGET=5
ENV HEADLESS=1
ENV UPLOAD_UGUU=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

CMD ["node", "bot.js"]
