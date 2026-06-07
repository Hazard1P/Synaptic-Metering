FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public
COPY templates ./templates
COPY data ./data

ENV NODE_ENV=production
EXPOSE 8080

CMD ["sh", "-c", "node src/db/migrate.js && node src/server.js"]
