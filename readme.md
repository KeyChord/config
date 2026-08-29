# @keychord/config

## Usage

```ts
import { config } from "@keychord/config";

export default config({
  dts: false, // set to true to generate `.d.ts` files in js/
  vendor: [
    // an array of chord packages used in this package
  ],
});
```

## Compiling a package

`vpr compile` (i.e. `vp run compile`) builds every distributable folder of a chord package in one step:

- `js/` — portable JavaScript artifacts, via `vp pack`
- `target/<triple>/…/` — native handler modules, via `buildNative`

```sh
vpr compile                      # build js/ and native artifacts for the host triple
vpr compile --triple aarch64-apple-darwin --triple x86_64-apple-darwin   # cross-build
vpr compile --skip-js            # native only
vpr compile --skip-native        # js only
vpr -r compile                   # every package in the workspace
```

The task reads the same `native`/`vendor` options as `vp pack` from the package's `vite.config.ts`, so the two never drift. Native builds use a content cache and share NodeSwift's SwiftPM build products across packages in the same workspace.

## Native add-ons

When a package has `src/swift`, `config()` compiles every `src/swift/<path>/<name>.swift` entry point into a [NodeSwift](https://github.com/kabiroberai/node-swift) Node-API add-on at `target/<triple>/<path>/<name>.node` before packing. For example:

```text
src/swift/menu/menu.swift -> target/aarch64-apple-darwin/menu/{menu.node,libNodeAPI.dylib}
```

The entry point imports `NodeAPI` and declares its exports with `#NodeModule`. JavaScript resolves the platform-specific add-on through Chord's built-in `resolveNativeModulePath(import.meta, "menu")` and loads it with `process.dlopen`. There is no handwritten C ABI or pointer ownership protocol. The build copies NodeSwift's dynamic `libNodeAPI.dylib` beside each add-on; this lets a single Chord process safely load add-ons from multiple packages without registering duplicate Swift/Objective-C classes. Published chord packages do not need an npm dependency on NodeSwift.

Requires a Swift toolchain (`swift --version`) and currently builds Apple triples. Build state is kept in `.chord-native-build/` (add it to `.gitignore`); `target/` is distributable output and is meant to be committed like `js/`.

`src/swift/_shared/**` is compiled into every add-on. Additional `.swift` files beside an entry point are compiled into that add-on. The Swift module name is deterministic — `moduleName("@keychord/chords-menu", "menu") === "KeychordChordsMenuNativeMenu"` — but it is an implementation detail of the build; packages consume each other's JavaScript and `.node` artifacts rather than importing generated Swift modules.

Vendoring copies a dependency's `js/`, `chords/`, and `target/` trees. A vendored handler therefore resolves to `target/@scope/package/target/<triple>/<path>/<name>.node` without special-casing in its JavaScript.

```ts
import { config } from "@keychord/config";

export default config({
  vendor: ["@keychord/chords-menu"],
  native: {
    triples: ["aarch64-apple-darwin"],
    targets: {
      menu: {
        frameworks: ["ApplicationServices"],
        swiftFlags: [],
        linkerFlags: [],
      },
    },
  },
});
```

`buildNative(root, options)`, `discoverNativeTargets(root)`, `hostTriple()`, `moduleName(pkg, name)`, `nativeOutputRelpath(root, file)` and `nativeSourceDirs(root)` are exported for custom scripts. See Chord's `scripting.md` for the complete authoring contract.

## Publishing this package

`pnpm pack` and `pnpm publish` run the `prepack` lifecycle automatically. It rebuilds the package
with `vp pack` and verifies that the runtime export points to compiled JavaScript, its declaration
file exists, and every CLI entry exists. Publication fails before creating a tarball if an export
points back into `src/` or to a missing file; `publishConfig.exports` is deliberately not used.
