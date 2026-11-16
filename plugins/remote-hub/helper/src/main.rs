use remote_hub_helper::ipc;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("remote-hub-helper {}", env!("CARGO_PKG_VERSION"));
        std::process::exit(0);
    }

    // Test-only hook (never exposed over RPC): everything after
    // --echo-command becomes the argv exec'd by open_echo instead of /bin/cat.
    let echo_argv = if let Some(pos) = args.iter().position(|a| a == "--echo-command") {
        let rest = &args[pos + 1..];
        if rest.is_empty() {
            eprintln!("--echo-command requires at least one argument");
            std::process::exit(2);
        }
        Some(rest.to_vec())
    } else {
        None
    };

    std::process::exit(ipc::run(echo_argv));
}
