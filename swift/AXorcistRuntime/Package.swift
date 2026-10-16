// swift-tools-version: 6.2
import PackageDescription

// All addons share one image so AXorcist and swift-log register their classes once.
let package = Package(
    name: "AXorcistRuntime",
    platforms: [.macOS("14.0")],
    products: [
        .library(name: "AXorcistRuntime", type: .dynamic, targets: ["AXorcistRuntime"]),
    ],
    dependencies: [
        .package(url: "https://github.com/openclaw/AXorcist.git", revision: "aa07d72fbb1861b56f5833b4cff8d9101c8dfbb3"),
        .package(url: "https://github.com/apple/swift-log.git", exact: "1.15.1"),
    ],
    targets: [
        .target(name: "AXorcistRuntime", dependencies: [
            .product(name: "AXorcist", package: "AXorcist"),
            .product(name: "Logging", package: "swift-log"),
        ]),
    ],
    swiftLanguageModes: [.v6]
)
