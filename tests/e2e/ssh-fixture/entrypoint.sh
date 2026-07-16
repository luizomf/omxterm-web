#!/bin/sh

set -eu

install \
  --mode 0600 \
  --owner omxterm-e2e \
  --group omxterm-e2e \
  /run/omxterm-e2e/client_key.pub \
  /home/omxterm-e2e/.ssh/authorized_keys

exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
