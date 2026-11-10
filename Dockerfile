FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DATA_DIR=/app/data APK_PATH=/app/artifacts/app.apk
COPY package.json server.js telegram-manager.js ./
COPY admin ./admin
RUN mkdir -p /app/data /app/artifacts
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
