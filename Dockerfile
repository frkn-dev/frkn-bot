FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY . .

RUN npm run build

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
