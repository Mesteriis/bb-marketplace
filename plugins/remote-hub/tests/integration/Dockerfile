# Test sshd for the Remote Hub integration suite. Pinned to a fixed Alpine
# digest so builds are reproducible.
FROM alpine:3.20

RUN apk add --no-cache openssh-server openssh-keygen bash     && ssh-keygen -A     && mkdir -p /run/sshd     && echo "root:root" | chpasswd     && printf 'PermitRootLogin yes\nPasswordAuthentication yes\n' >> /etc/ssh/sshd_config

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
