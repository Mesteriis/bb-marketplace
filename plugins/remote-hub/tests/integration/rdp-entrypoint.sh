#!/bin/sh
set -e
if [ -z "$RDP_USER" ] || [ -z "$RDP_PASSWORD" ]; then
    echo "RDP_USER and RDP_PASSWORD are required" >&2
    exit 1
fi
useradd -m -s /bin/bash "$RDP_USER" 2>/dev/null || true
echo "$RDP_USER:$RDP_PASSWORD" | chpasswd
# The session logs button events of an xev window at +0+0 (400x300) to
# /tmp/xev.log, and runs xterm in the foreground (keeps the session alive).
# xterm prints a listing in an anti-aliased font (so the desktop is not one
# colour), then runs `cat > /tmp/typed.txt` so typed scancodes land in that file.
cat > /etc/xrdp/startwm.sh <<'INNER'
#!/bin/sh
xev -geometry 400x300+0+0 -event button > /tmp/xev.log 2>&1 &
exec xterm -fa 'DejaVu Sans Mono' -fs 11 -geometry 50x20+410+0 -e sh -c 'ls -la /etc | head -15; cat > /tmp/typed.txt'
INNER
chmod +x /etc/xrdp/startwm.sh
rm -f /var/run/xrdp/xrdp.pid /var/run/xrdp/sesman.pid
/usr/sbin/xrdp-sesman --nodaemon &
/usr/sbin/xrdp --nodaemon
