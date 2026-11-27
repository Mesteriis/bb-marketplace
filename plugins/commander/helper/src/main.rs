use archive_helper::server::{self, Server, HELPER_VERSION};

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--version") if args.next().is_none() => {
            println!("commander-archive-helper {HELPER_VERSION}");
        }
        None => {
            let rlimit_as = server::startup_limits();
            let mut s = Server::new(rlimit_as);
            s.run();
        }
        // Paths and passwords never travel in argv; nothing else is accepted.
        Some(_) => {
            eprintln!("usage: commander-archive-helper [--version]");
            std::process::exit(64);
        }
    }
}
