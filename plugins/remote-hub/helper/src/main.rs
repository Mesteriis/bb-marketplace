use remote_hub_helper::ipc;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
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
