import Foundation
import NodeAPI

/// Runs `operation` on the main actor and settles the returned promise on the calling add-on's
/// JS thread.
///
/// NodeSwift 1.5's NodeActor executor finds its JS queue through a task-local value, but since
/// the Swift 6.1 runtime (macOS 15.4) a task hopping back from MainActor is enqueued after it
/// stops being the current task, so the value reads as nil. NodeSwift then falls back to a
/// process-wide queue, which it disables once a second add-on environment loads, and aborts.
///
/// This captures the queue while still on the JS thread and completes through it, so no Swift
/// job ever hops back onto NodeActor. The handle keeps the JS loop alive until completion.
/// Return plain Swift values: NodeAPI values must not be created on the main actor.
@NodeActor
public func mainActorPromise<T: NodeValueConvertible & Sendable>(
    _ operation: @escaping @MainActor @Sendable () async throws -> T
) throws -> NodePromise {
    let deferred = try NodePromise.Deferred()
    let queue = try NodeAsyncQueue(label: "chord.main-actor-action").handle()
    Task { @MainActor in
        let result: Result<T, Error>
        do {
            result = .success(try await operation())
        } catch {
            result = .failure(error)
        }
        do {
            try queue.queue.run { [queue] in
                _ = queue
                try deferred(result.map { $0 as NodeValueConvertible })
            }
        } catch {
            // Queue teardown means JS can no longer receive a result. Never
            // convert shutdown into a process-wide fatal error.
            NSLog("Chord native completion queue unavailable: %@", String(describing: error))
        }
    }
    return deferred.promise
}

/// Resolves to `undefined` once `operation` finishes on the main actor.
@NodeActor
public func mainActorPromise(
    _ operation: @escaping @MainActor @Sendable () async throws -> Void
) throws -> NodePromise {
    try mainActorPromise { () async throws -> NodeDeferredValue in
        try await operation()
        return NodeDeferredValue { try NodeUndefined() }
    }
}
