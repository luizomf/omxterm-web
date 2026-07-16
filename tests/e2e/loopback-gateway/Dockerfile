FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends socat \
  && rm -rf /var/lib/apt/lists/*

USER nobody

ENTRYPOINT ["socat", "TCP-LISTEN:3000,fork,reuseaddr", "TCP:omxterm:3000"]
