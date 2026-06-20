FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public
COPY templates ./templates
COPY data ./data
COPY docker-entrypoint.sh ./docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 8080

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npm", "start"]
