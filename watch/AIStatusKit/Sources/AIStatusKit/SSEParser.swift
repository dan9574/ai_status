import Foundation

/// One dispatched Server-Sent Event.
public struct SSEEvent: Equatable, Sendable {
    public var event: String
    public var data: String
    public var id: String?

    public init(event: String = "message", data: String, id: String? = nil) {
        self.event = event
        self.data = data
        self.id = id
    }
}

/// Incremental, byte-oriented `text/event-stream` parser following the WHATWG
/// algorithm (the parts a client needs): lines end in LF, CRLF or CR; a blank line
/// dispatches; `:` lines are comments; `data` lines are joined with "\n";
/// `retry` must be all digits; a leading UTF-8 BOM is skipped.
///
/// It is fed raw bytes on purpose: `URLSession.AsyncBytes.lines` drops empty
/// lines, and empty lines are what delimit SSE events.
public struct SSEParser: Sendable {
    public private(set) var retryMs: Int?
    public private(set) var lastEventId: String?
    /// Comment lines seen (the daemon sends `: ping <ms>` every 15 s).
    public private(set) var commentCount = 0

    private var line: [UInt8] = []
    private var lastWasCR = false
    private var atStreamStart = true
    private var eventType = ""
    private var dataBuffer = ""
    private var hasData = false

    public init() {}

    /// Feed one byte; returns an event when a blank line completes one.
    public mutating func push(_ byte: UInt8) -> SSEEvent? {
        if lastWasCR {
            lastWasCR = false
            if byte == 0x0A { return nil } // CRLF: the CR already ended the line
        }
        switch byte {
        case 0x0A:
            return endLine()
        case 0x0D:
            lastWasCR = true
            return endLine()
        default:
            line.append(byte)
            return nil
        }
    }

    /// Feed a chunk; returns all events completed by it, in order.
    public mutating func push<S: Sequence>(contentsOf bytes: S) -> [SSEEvent] where S.Element == UInt8 {
        var out: [SSEEvent] = []
        for b in bytes {
            if let e = push(b) { out.append(e) }
        }
        return out
    }

    private mutating func endLine() -> SSEEvent? {
        var bytes = line
        line.removeAll(keepingCapacity: true)
        if atStreamStart {
            atStreamStart = false
            if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { bytes.removeFirst(3) }
        }
        if bytes.isEmpty { return dispatch() }
        let text = String(decoding: bytes, as: UTF8.self)
        if text.hasPrefix(":") {
            commentCount += 1
            return nil
        }
        let field: Substring
        var value: Substring
        if let colon = text.firstIndex(of: ":") {
            field = text[..<colon]
            value = text[text.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(text)
            value = ""
        }
        switch field {
        case "event":
            eventType = String(value)
        case "data":
            dataBuffer += value
            dataBuffer += "\n"
            hasData = true
        case "id":
            if !value.contains("\0") { lastEventId = String(value) }
        case "retry":
            if !value.isEmpty, value.allSatisfy({ $0.isASCII && $0.isNumber }), let ms = Int(value) { retryMs = ms }
        default:
            break
        }
        return nil
    }

    private mutating func dispatch() -> SSEEvent? {
        defer {
            eventType = ""
            dataBuffer = ""
            hasData = false
        }
        guard hasData else { return nil }
        var data = dataBuffer
        if data.hasSuffix("\n") { data.removeLast() }
        return SSEEvent(event: eventType.isEmpty ? "message" : eventType, data: data, id: lastEventId)
    }
}
