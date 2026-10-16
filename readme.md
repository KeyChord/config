# @keychord/config

## Usage

```ts
import { config } from "@keychord/config";

export default config();
```

The config only builds packages. Chord runs handlers under Bun, so packages test with `bun test`
and the `@keychord/chordtest` preload (configured in their `bunfig.toml`), which provides the
mockable `chord` module and package-bound `import.meta.chord` helpers. Production bundles keep the
real host API.

Pass options when the package needs additional build settings:

```ts
export default config({
  dts: false, // set to true to generate `.d.ts` files in js/
  vendor: [
    // an array of chord packages used in this package
  ],
});
```

The chords workspace links `@keychord/config` to this checkout. Run `vp pack` here after changing
the config, because consumers load its built `exports/` entry. Run this package's own tests with
`vp run test` (`bun test`).

## `js/package.json.js`

`vp pack` bundles the package's `package.json` into `js/package.json.js` with an added `chords`
property: the `chords/` directory as nested objects, one per folder, with each `.toml` file parsed
under its filename. It is exported both on the default export and as a named `chords` export:

```ts
import pkg, { chords } from "@keychord/chords-chromium/js/package.json.js";

chords.com.google.Chrome["macos.toml"].name; // "Google Chrome"
chords["base.toml"].chords; // the shared shortcut table
```

Leaves keep their `.toml` filename, so a key path matches the `file` paths used by `import`, and a
file never collides with a sibling folder. Vendored packages appear where `vendor` copies them
(`chords["@keychord"]["chords-menu"].chords["macos.toml"]`), read from `node_modules` because the
copy runs after bundling. The source `package.json` is never modified. Invalid TOML fails the build.

Symbol-prefixed global chords and their hints must be defined in each package's root
`chords/macos.toml`, alongside any handlers they use. Builds fail with the chord key and source
file when a global binding appears elsewhere, including in shared or nested application files.
Vendored packages keep their own root `chords/macos.toml`.

`packageChordsPlugin({ root, vendor })` is exported for custom builds.

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

The task reads the same `native`/`vendor` options as `vp pack` from the package's `vite.config.ts`, so the two never drift. Swift dependencies and language settings come from the package's `Package.swift`, and SwiftPM handles incremental rebuilds in place.

## Native add-ons

A package builds native add-ons when it has a SwiftPM manifest at its root. `Package.swift` is the
single source of truth for everything SwiftPM understands -- dependencies, platform, language mode,
compiler and linker settings -- so the package can be opened in Xcode, indexed by SourceKit-LSP,
and built with a plain `swift build` like any other Swift package.

Every `.dynamic` library product becomes one [NodeSwift](https://github.com/kabiroberai/node-swift)
Node-API add-on:

```text
Sources/KeychordChordsMenuNativeMenu/menu.swift
  -> target/aarch64-apple-darwin/menu/{menu.node,libNodeAPI.dylib,libAXorcistRuntime.dylib}
```

The add-on filename is the product name with its package prefix stripped, so the long, globally
unique Swift module name `KeychordChordsMenuNativeMenu` is written as `menu.node`. Module names
must stay unique across every chord package loaded into one Chord process: NodeAPI is linked
dynamically precisely so several add-ons can coexist, and two products sharing a module name would
register duplicate Swift/Objective-C classes.

```swift
// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ChordsMenu",
    platforms: [.macOS("14.0")],
    products: [
        .library(name: "KeychordChordsMenuNativeMenu", type: .dynamic,
                 targets: ["KeychordChordsMenuNativeMenu"]),
    ],
    dependencies: [
        .package(url: "https://github.com/kabiroberai/node-swift.git", exact: "1.5.1"),
        .package(url: "https://github.com/KeyChord/config.git", exact: "0.0.10"),
    ],
    targets: [
        .target(name: "KeychordChordsMenuNativeMenu", dependencies: [
            .product(name: "NodeAPI", package: "node-swift"),
            .product(name: "NodeModuleSupport", package: "node-swift"),
            .product(name: "AXorcistRuntime", package: "config"),
            .product(name: "ChordNodeSupport", package: "config"),
        ]),
    ],
    swiftLanguageModes: [.v6]
)
```

### Shared Swift libraries

This repository is also a Swift package. Its root `Package.swift` publishes the Swift code that
chord packages share, so they declare it as a normal SwiftPM dependency instead of copying source
files. Release tags match the npm version.

- `AXorcistRuntime` re-exports AXorcist. It is a dynamic library that includes AXorcist and
  swift-log, so loading several add-ons registers their classes only once. AXorcist requires
  macOS 14+ and Swift 6.2+.
- `ChordNodeSupport` provides `mainActorPromise`, which runs work on the main actor and settles a
  JS promise. Use it instead of NodeSwift's `async` functions: since the Swift 6.1 runtime,
  NodeSwift aborts when a task hops back from `MainActor` while several add-ons are loaded.

Every add-on loaded into one Chord process, including vendored ones, must use the same release:
dyld loads one `libAXorcistRuntime.dylib` for all of them. Pin it with `exact:` and bump packages
together. Its own dependencies are pinned to released versions, because SwiftPM rejects a
version-pinned package whose dependencies are pinned by branch, revision or path. The same rule
applies to any chord package that other packages depend on.

To build against an unreleased checkout, temporarily declare
`.package(path: "node_modules/@keychord/config")` instead. Both forms have the identity `config`,
so product references stay the same.

The target imports `NodeAPI` and declares its exports with `#NodeModule`. Handlers load the addon
with a normal relative import:

```ts
import menu from "./menu.node";
```

Declare its API in a `.d.ts` file under `src/types/`:

```ts
declare module "*/menu.node" {
  const menu: { openMenu(): Promise<void> };
  export default menu;
}
```

Static imports load the addon when the handler module is imported. To load it on the first action
instead, use a require inside a function:

```ts
type MenuAddon = { openMenu(): Promise<void> };

function openAddon(): MenuAddon {
  return require("./menu.node") as MenuAddon;
}
```

`config()` automatically installs its native-addon plugin in each handler's `pack.plugins`.
The missing source-side `./menu.node` resolves to `target/<triple>/menu/menu.node`; no alias,
JavaScript shim, or `import.meta.chord.resolveNative` call is needed. Real relative files keep
their normal resolution. The plugin emits the addon and its shared runtime libraries under
`js/native/<triple>/menu/`, with a content hash in the addon's filename. Loading remains lazy
when the require is inside a function.
Published chord packages do not need an npm dependency on NodeSwift.

Each manifest pins node-swift by exact version while npm installs its own copy. Nothing structural
keeps the two in step, so `buildNative` compares them and fails loudly on a mismatch; set
`native.allowNodeSwiftVersionMismatch` to override while testing an unreleased bridge.

Requires a Swift toolchain (`swift --version`) and currently builds Apple triples. Build state is
kept in `node_modules/.cache/chord/native/`, covered by the usual `node_modules/` ignore;
`target/` is distributable output and is meant to be committed like `js/`.

Sharing Swift code between add-ons in one package is a plain internal target that each product's
target depends on -- SwiftPM handles it, with no build-tool convention involved.

`native` options carry only build orchestration, since everything else lives in the manifest:

```ts
import { config } from "@keychord/config";

export default config({
  vendor: ["@keychord/chords-menu"],
  native: {
    triples: ["aarch64-apple-darwin", "x86_64-apple-darwin"],
    optimize: true, // false for a debug build
  },
});
```

The plugin packages every configured `native.triples` target and selects the matching platform
and architecture at runtime. The default is the build machine's triple. Missing addons or runtime
libraries fail the build; an unsupported runtime architecture reports which addon is unavailable.
`compile --triple` overrides also apply to the JavaScript package.

Vendoring copies a dependency's `js/`, `chords/`, and `target/` trees. Plugin-built handlers keep
their addons inside `js/`, so the copied JavaScript remains usable after relocation. Existing
handlers using `import.meta.chord.resolveNative` still resolve through the vendored `target/` tree.

`buildNative(root, options)`, `discoverNativeTargets(root)`, `addonName(module)`, `hostTriple()`,
`hasNativeManifest(root)`, `manifestPath(root)` and `nativeSourceDirs(root)` are exported for
custom scripts. `nativeAddonPlugin({ root, triples, targetDir })` is exported for custom
Vite/Rolldown builds. See Chord's `scripting.md` for the complete authoring contract.

## Publishing this package

`pnpm pack` and `pnpm publish` run the `prepack` lifecycle automatically. It rebuilds the package
with `vp pack` and verifies that the runtime export points to compiled JavaScript, its declaration
file exists, and every CLI entry exists. Publication fails before creating a tarball if an export
points back into `src/` or to a missing file; `publishConfig.exports` is deliberately not used.
