use remote_hub_helper::ipc;

fn main() {
    // OpenSSH runs $SSH_ASKPASS, a symlink named remote-hub-askpass to this binary.
    if let Some(argv0) = std::env::args().next() {
        if remote_hub_helper::askpass::invoked_as_askpass(&argv0) {
            let all: Vec<String> = std::env::args().collect();
            std::process::exit(remote_hub_helper::askpass::run_client(&all));
        }
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--keychain-op") {
        std::process::exit(remote_hub_helper::keychain::run_op());
    }
    if args.iter().any(|a| a == "--rdp-engine") {
        std::process::exit(remote_hub_helper::rdp::engine::run_engine());
    }
    #[cfg(feature = "test-hooks")]
    if let Some(mode) = args.iter().find_map(|a| a.strip_prefix("--rdp-engine-fake=")) {
        std::process::exit(remote_hub_helper::rdp::fake_engine::run_fake_engine(mode));
    }
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("remote-hub-helper {}", env!("CARGO_PKG_VERSION"));
        std::process::exit(0);
    }

    #[cfg(feature = "test-hooks")]
    let echo_argv = parse_echo_command(&args);

    #[cfg(not(feature = "test-hooks"))]
    let echo_argv = {
        if args.iter().any(|a| a == "--echo-command") {
            eprintln!("unknown argument: --echo-command");
            std::process::exit(2);
        }
        None
    };

    std::process::exit(ipc::run(echo_argv));
}

#[cfg(feature = "test-hooks")]
fn parse_echo_command(args: &[String]) -> Option<Vec<String>> {
    if let Some(pos) = args.iter().position(|a| a == "--echo-command") {
        let rest = &args[pos + 1..];
        if rest.is_empty() {
            eprintln!("--echo-command requires at least one argument");
            std::process::exit(2);
        }
        Some(rest.to_vec())
    } else {
        None
    }
}
