// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MeetingCaptureBridge",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "MeetingCaptureBridge", targets: ["MeetingCaptureBridge"])],
    targets: [.executableTarget(name: "MeetingCaptureBridge")]
)

