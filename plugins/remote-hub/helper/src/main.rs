use remote_hub_helper::ipc;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("remote-hub-helper {}", env!("CARGO_PKG_VERSION"));
        std::process::exit(0);
    }
    std::process::exit(ipc::run());
}
