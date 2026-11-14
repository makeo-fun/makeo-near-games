# The NEAR AI dispatcher: one bundled file (bun build actors/src/dispatch.ts), no node_modules.
FROM oven/bun:1.4.0
WORKDIR /app
COPY --chown=root:root --chmod=0444 dispatch.js /app/dispatch.js
USER bun
ENV HOST=0.0.0.0 PORT=8790 NODE_ENV=production
EXPOSE 8790
CMD ["bun", "/app/dispatch.js"]
