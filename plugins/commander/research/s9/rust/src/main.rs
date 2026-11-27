use std::{fs::File, io, time::Instant};
fn write(kind: &str, path: &str) {
    use std::io::{Read, Write};
    let size = 2147483648u64;
    let f = File::create(path).unwrap();
    if kind == "zip" {
        let mut zip = zip::ZipWriter::new(f);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("large.txt", options.large_file(true)).unwrap();
        assert_eq!(io::copy(&mut io::repeat(b'A').take(size), &mut zip).unwrap(), size);
        for i in 1..100000 {
            zip.start_file(format!("empty-{i}"), options).unwrap();
            zip.write_all(&[]).unwrap();
        }
        zip.finish().unwrap();
    } else {
        let mut tar = tar::Builder::new(f);
        for i in 0..100000 {
            let mut header = tar::Header::new_ustar();
            header.set_size(if i == 0 { size } else { 0 });
            header.set_mode(0o600);
            let name = if i == 0 { "large.txt".into() } else { format!("empty-{i}") };
            let stream = io::repeat(b'A').take(header.size().unwrap());
            tar.append_data(&mut header, name, stream).unwrap();
        }
        tar.finish().unwrap();
    }
}
fn print_rss() {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    assert_eq!(unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) }, 0);
    println!("peak RSS bytes: {}", unsafe { usage.assume_init() }.ru_maxrss);
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let start = Instant::now();
    if args[1] == "compat" {
        use std::io::Read;
        let mut archive = zip::ZipArchive::new(File::open(&args[2]).unwrap()).unwrap();
        if let Ok(mut file) = archive.by_index_decrypt(0, b"incorrect") {
            // ZipCrypto's one-byte header check can accept a wrong password.
            // Drain the entry so the reader can check its CRC at EOF.
            let mut data = Vec::new();
            if file.read_to_end(&mut data).is_ok() {
                assert_ne!(data, b"payload");
            }
            println!("Wrong password passed the header check; payload rejected");
        }
        let mut file = archive.by_index_decrypt(0, b"synthetic").unwrap();
        assert_eq!(file.name(), "café.txt");
        assert_eq!(file.name_raw(), b"caf\x82.txt");
        let mut data = Vec::new();
        file.read_to_end(&mut data).unwrap();
        assert_eq!(data, b"payload");
        println!("ZIP64 CP437 encrypted read PASS");
        return;
    }
    if args.get(3).map(String::as_str) == Some("write") {
        write(&args[1], &args[2]);
        print_rss();
        println!("write {} {} ms PASS", args[1], start.elapsed().as_millis());
        return;
    }
    let f = File::open(&args[2]).unwrap();
    let mut bytes = 0;
    let mut count = 0;
    if args[1] == "zip" {
        let mut archive = zip::ZipArchive::new(f).unwrap();
        for i in 0..archive.len() {
            bytes += io::copy(&mut archive.by_index(i).unwrap(), &mut io::sink()).unwrap();
            count += 1;
        }
    } else {
        let mut archive = tar::Archive::new(f);
        for entry in archive.entries().unwrap() {
            bytes += io::copy(&mut entry.unwrap(), &mut io::sink()).unwrap();
            count += 1;
        }
    }
    assert_eq!(bytes, 2147483648);
    assert_eq!(count, 100000);
    print_rss();
    println!("{}: {count} entries {bytes} bytes {} ms PASS", args[1], start.elapsed().as_millis());
}
