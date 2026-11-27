import os, subprocess, sys
fixture = sys.argv[1]
outputs = [('zip', ['-xOf', fixture + '/mass.zip']),
           ('tar', ['-xOf', fixture + '/mass.tar']),
           ('7z-create', ['-cf', fixture + '/mass.7z', '--format=7zip', '--options=7zip:compression=store', '@' + fixture + '/mass.tar']),
           ('7z', ['-xOf', fixture + '/mass.7z'])]
for kind, args in outputs:
    with open(os.devnull, 'wb') as sink:
        process = subprocess.Popen(['/usr/bin/bsdtar', *args], stdout=sink)
        _, status, usage = os.wait4(process.pid, 0)
        process.returncode = os.waitstatus_to_exitcode(status)
        print(kind, 'exit', process.returncode, 'peak RSS bytes', usage.ru_maxrss, flush=True)
        if process.returncode:
            sys.exit(process.returncode)
