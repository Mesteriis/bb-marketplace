//! gitwand-bridge entry point (Makosh GitWand plugin for BB).
//! `--version` prints the build identity; otherwise the stdio loop runs
//! until stdin closes. See `src/bridge/mod.rs` for the protocol.
fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!(
            "gitwand-bridge {} ({}) commands={}",
            option_env!("GITWAND_RUNTIME_VERSION").unwrap_or("dev"),
            option_env!("GITWAND_COMMIT").unwrap_or("unknown"),
            gitwand_desktop_lib::bridge_generated_count()
        );
        return;
    }
    gitwand_desktop_lib::bridge_run();
}
