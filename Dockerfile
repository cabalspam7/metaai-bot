FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY mailtm.js bot.js ./

ENV TARGET=5
ENV HEADLESS=1
ENV UPLOAD_UGUU=1

CMD ["node", "bot.js"]
