# Gleiche Node-Linie wie Yuvomi (node:24-slim). Keine npm-Abhaengigkeiten:
# node:sqlite ist eingebaut.
FROM node:24-slim
LABEL org.opencontainers.image.source="https://github.com/FlessingLabs/yuvomi-kidsstar" \
      org.opencontainers.image.description="KidsStar star ledger service for Yuvomi" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data NODE_NO_WARNINGS=1
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY --chmod=755 entrypoint.sh /entrypoint.sh
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/extensions/kidsstar/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/main.js"]
