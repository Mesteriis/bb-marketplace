# Test sshd for the Remote Hub integration suite. The base image is pinned by
# digest. apk packages are not pinned by version because Alpine's latest-stable
# repository does not offer an immutable versioned snapshot without also pinning
# the entire repository URL; the throwaway test image accepts that trade-off.
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

RUN apk add --no-cache openssh-server openssh-keygen bash     && ssh-keygen -A     && mkdir -p /run/sshd     && echo "root:root" | chpasswd     && printf 'PermitRootLogin yes
PasswordAuthentication yes
' >> /etc/ssh/sshd_config

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
