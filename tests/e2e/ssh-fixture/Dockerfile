FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends openssh-server \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/bash omxterm-e2e \
  && passwd --delete omxterm-e2e \
  && install --directory --mode 0700 --owner omxterm-e2e --group omxterm-e2e /home/omxterm-e2e/.ssh \
  && install --directory --mode 0755 /run/sshd /run/omxterm-e2e

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/omxterm-e2e-sshd
RUN chmod 0755 /usr/local/bin/omxterm-e2e-sshd

ENTRYPOINT ["/usr/local/bin/omxterm-e2e-sshd"]
