/* Keeps the Rust crate at package.json's version. `npm version` runs this
 * (the "version" script) after it sets package.json and before it commits
 * and tags, so the commit carries Cargo.toml and Cargo.lock too.
 * tauri.conf.json reads its version from package.json. */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const { version } = require(path.join(root, "package.json"));

function set(file, line) {
  const at = path.join(root, file);
  const text = fs.readFileSync(at, "utf8");
  if (!line.test(text)) throw new Error(`No version to set in ${file}`);
  fs.writeFileSync(at, text.replace(line, `$1"${version}"`));
}

// [package]'s, the first version line
set("src-tauri/Cargo.toml", /^(version = )"[^"]*"/m);
// The app's own entry in the lock file
set("src-tauri/Cargo.lock", /(\[\[package\]\]\nname = "app"\nversion = )"[^"]*"/);
console.log(`Cargo.toml and Cargo.lock at ${version}`);
