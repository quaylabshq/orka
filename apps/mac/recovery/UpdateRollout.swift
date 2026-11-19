import Foundation

// The account token is sent only to this fixed Orka Cloud endpoint. The signed
// policy and archive downloads use separate requests without credentials.
let rolloutEndpoint = URL(string: "https://api.tryorka.ai/v2/desktop-updates")!

enum RolloutAudience: String, Codable {
    case early, `public`
}

private struct RolloutResponse: Decodable {
    let manifest: SignedPolicy?
    let audience: RolloutAudience?
}

private struct RolloutManifest: Decodable {
    let schema: Int
    let purpose: String
    let release: Release
}

struct UpdateOffer {
    let release: Release
    var audience: RolloutAudience?
}

final class RolloutConnection: HTTPSOnly {
    override func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                             newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

func rolloutSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 5
    configuration.timeoutIntervalForResource = 8
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    return URLSession(configuration: configuration, delegate: RolloutConnection(), delegateQueue: nil)
}

func readRolloutToken() -> String? {
    var data = Data()
    do {
        while let chunk = try FileHandle.standardInput.read(upToCount: 8193 - data.count), !chunk.isEmpty {
            data.append(chunk)
            guard data.count <= 8192 else { return nil }
        }
    } catch {
        return nil
    }
    guard !data.isEmpty, data.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) ||
              [45, 46, 95].contains($0) }) else { return nil }
    return String(data: data, encoding: .utf8)
}

struct Rollout {
    var endpoint = rolloutEndpoint
    var makeSession: () -> URLSession = rolloutSession

    func offer(key: Data, token: String?) async throws -> UpdateOffer? {
        let session = makeSession()
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: endpoint)
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (bytes, response) = try await session.bytes(for: request)
        guard response.url == endpoint else { throw UpdateError("The rollout server returned an unexpected address.") }
        if token != nil, let http = response as? HTTPURLResponse, [401, 403].contains(http.statusCode) {
            return try await offer(key: key, token: nil)
        }
        try checkResponse(response)
        var data = Data()
        for try await byte in bytes {
            guard data.count < 24_576 else { throw UpdateError("The rollout response is too large.") }
            data.append(byte)
        }
        let responseBody = try JSONDecoder().decode(RolloutResponse.self, from: data)
        guard let manifest = responseBody.manifest, let audience = responseBody.audience,
              audience != .early || token != nil else { return nil }
        let payload = try manifest.verifiedPayload(key: key)
        let release = try JSONDecoder().decode(RolloutManifest.self, from: payload)
        guard release.schema == 1, release.purpose == "orka-desktop-rollout" else {
            throw UpdateError("The release approval format is invalid.")
        }
        try release.release.validate()
        return UpdateOffer(release: release.release, audience: audience)
    }
}
