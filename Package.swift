// swift-tools-version: 6.2
//
// Swift libraries shared by Chord package add-ons. Depend on a tagged release:
//
//   .package(url: "https://github.com/KeyChord/config.git", exact: "<version>")
//
// Every add-on loaded into one Chord process must use the same release: AXorcistRuntime is a
// shared dynamic library, and dyld loads the first copy for all of them.
import PackageDescription

let package = Package(
    name: "KeychordConfig",
    platforms: [.macOS("14.0")],
    products: [
        // Dynamic so AXorcist and swift-log register their classes once per process.
        .library(name: "AXorcistRuntime", type: .dynamic, targets: ["AXorcistRuntime"]),
        // Static: plain functions, so each add-on can carry its own copy.
        .library(name: "ChordNodeSupport", targets: ["ChordNodeSupport"]),
    ],
    dependencies: [
        // Released versions only: SwiftPM rejects a version-pinned package whose own
        // dependencies are pinned by branch, revision or path.
        .package(url: "https://github.com/kabiroberai/node-swift.git", exact: "1.5.1"),
        .package(url: "https://github.com/openclaw/AXorcist.git", exact: "0.1.10"),
        .package(url: "https://github.com/apple/swift-log.git", exact: "1.15.1"),
    ],
    targets: [
        .target(
            name: "AXorcistRuntime",
            dependencies: [
                .product(name: "AXorcist", package: "AXorcist"),
                .product(name: "Logging", package: "swift-log"),
            ],
            path: "swift/AXorcistRuntime"
        ),
        .target(
            name: "ChordNodeSupport",
            dependencies: [.product(name: "NodeAPI", package: "node-swift")],
            path: "swift/ChordNodeSupport"
        ),
    ],
    swiftLanguageModes: [.v6]
)
