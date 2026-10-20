# 타임뱅크 인터넷 서버 (Fly.io)
FROM node:24-alpine
WORKDIR /app
COPY package.json lib.js server.js ./
COPY public ./public
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    SECURE_COOKIE=1 \
    TZ=Asia/Seoul
RUN apk add --no-cache tzdata
EXPOSE 8080
CMD ["node", "server.js"]
