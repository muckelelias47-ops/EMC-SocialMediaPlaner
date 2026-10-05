FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node server/ ./server/
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production
ENV PORT=8787
ENV DATA_DIR=/data
EXPOSE 8787
CMD ["node", "--use-env-proxy", "server/index.js"]
