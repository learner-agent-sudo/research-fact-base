# Hugging Face Spaces (Docker SDK) — runs the Next.js app as-is, no porting.
#
# HF Spaces serve on the port declared as `app_port` in the Space README
# (7860 here) and run the container as UID 1000, so we create that user.
#
# Secrets are injected by HF at RUNTIME (Space → Settings → Variables and
# secrets), not at build time — the app reads them from process.env on the
# server, so the image builds fine without them.

FROM node:22-slim

RUN useradd -m -u 1000 user
USER user

ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /home/user/app

# Install dependencies first so this layer caches across code changes.
# NODE_ENV is deliberately unset here: `next build` needs devDependencies.
COPY --chown=user:user package.json package-lock.json ./
RUN npm ci

COPY --chown=user:user . .
RUN npm run build

# `next start` honours both of these.
ENV PORT=7860 \
    HOSTNAME=0.0.0.0

EXPOSE 7860
CMD ["npm", "start"]
