fn main() {
    // Tauri embeds the icons when the crate compiles but only watches the config
    // file; without this, a changed icon keeps the old one until a clean build.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
