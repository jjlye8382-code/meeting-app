# Pal runs as one always-on container. Keep exactly ONE copy running:
# two copies polling the same Telegram bot conflict (HTTP 409).
ARG BASE_IMAGE=node:22-alpine
FROM ${BASE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Kuala_Lumpur DATA_DIR=/data
RUN apk add --no-cache tzdata
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
# Mount a persistent volume here so reminders, expenses and minutes survive redeploys.
VOLUME ["/data"]
CMD ["node", "src/index.js"]
