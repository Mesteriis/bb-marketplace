#!/bin/sh
set -e
if [ -z "$RDP_USER" ] || [ -z "$RDP_PASSWORD" ]; then
    echo "RDP_USER and RDP_PASSWORD are required" >&2
    exit 1
fi
useradd -m -s /bin/bash "$RDP_USER" 2>/dev/null || true
echo "$RDP_USER:$RDP_PASSWORD" | chpasswd
# The session runs xterm in the foreground (keeps the session alive); xterm
# runs `cat > /tmp/typed.txt` so typed scancodes land in that file.
cat > /etc/xrdp/startwm.sh <<'INNER'
#!/bin/sh
exec xterm -e 'cat > /tmp/typed.txt'
INNER
chmod +x /etc/xrdp/startwm.sh
# IPv4-only listener avoids the IPv6 sesman back-connection issue.
sed -i 's/^address=.*/address=127.0.0.1/' /etc/xrdp/xrdp.ini
rm -f /var/run/xrdp/xrdp.pid /var/run/xrdp/sesman.pid
/usr/sbin/xrdp-sesman --nodaemon &
/usr/sbin/xrdp --nodaemon
