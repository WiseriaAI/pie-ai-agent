// Pie Link 顶栏 app：~/.pie/daemon.sock 的瘦客户端。菜单点开才查询，无常驻轮询。
import AppKit

let socketPath = (NSHomeDirectory() as NSString).appendingPathComponent(".pie/daemon.sock")

/// Pie 品牌 mark（被咬一口的派）template 版。比例对齐 public/icons/icon-128.svg
/// （派 r44、咬口 r22、咬口心距派心 48，右上 45°）。咬口跨越派边缘，须用
/// blend .clear 挖真透明（evenOdd 会在派外留月牙）。isTemplate 跟随菜单栏明暗。
func pieTemplateIcon() -> NSImage {
    let img = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
        guard let cg = NSGraphicsContext.current?.cgContext else { return false }
        cg.setFillColor(NSColor.black.cgColor)
        cg.fillEllipse(in: CGRect(x: 2, y: 2, width: 14, height: 14)) // 派 r7 心(9,9)
        cg.setBlendMode(.clear)
        cg.fillEllipse(in: CGRect(x: 10.9, y: 10.9, width: 7, height: 7)) // 咬口 r3.5 心(14.4,14.4)
        return true
    }
    img.isTemplate = true
    return img
}

/// 一问一答：连 unix socket，发一行 JSON 请求，读一行 JSON 响应（1s 超时）。
func queryDaemon(_ method: String, _ params: [String: Any] = [:]) -> [String: Any]? {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var tv = timeval(tv_sec: 1, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let ok = socketPath.withCString { src -> Bool in
        guard strlen(src) < 104 else { return false }
        return withUnsafeMutablePointer(to: &addr.sun_path) {
            $0.withMemoryRebound(to: CChar.self, capacity: 104) { dst in
                strcpy(dst, src)
                return true
            }
        }
    }
    guard ok else { return nil }
    let connected = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard connected == 0 else { return nil }
    let req: [String: Any] = ["id": UUID().uuidString, "method": method, "params": params]
    guard var line = try? JSONSerialization.data(withJSONObject: req) else { return nil }
    line.append(0x0A)
    let sent = line.withUnsafeBytes { write(fd, $0.baseAddress, line.count) }
    guard sent == line.count else { return nil }
    var buf = Data()
    var chunk = [UInt8](repeating: 0, count: 65536)
    while !buf.contains(0x0A) {
        let n = read(fd, &chunk, chunk.count)
        if n <= 0 || buf.count > 4_000_000 { return nil }
        buf.append(contentsOf: chunk[0..<n])
    }
    guard let nl = buf.firstIndex(of: 0x0A),
          let obj = try? JSONSerialization.jsonObject(with: buf[..<nl]) as? [String: Any],
          obj["ok"] as? Bool == true
    else { return nil }
    return obj["result"] as? [String: Any]
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var statusItem: NSStatusItem!

    func applicationDidFinishLaunching(_: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = pieTemplateIcon()
        statusItem.button?.image?.accessibilityDescription = "Pie Link"
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
    }

    // 点开菜单才查 daemon（status 一次）。正在运行/最近执行 skill 不进菜单
    // （不可交互的列表在菜单里是噪音）——留给后续独立日志页面，数据源
    // status.runningSkills / list_audit 保持可用。
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let status = queryDaemon("status")
        if let s = status {
            let ver = s["version"] as? String ?? "?"
            menu.addItem(disabled("Pie Link v\(ver) · 运行中"))
            let ext = s["extensionConnected"] as? Bool ?? false
            menu.addItem(disabled(ext ? "浏览器扩展：已连接" : "浏览器扩展：未连接"))
        } else {
            menu.addItem(disabled("Pie Link · 未运行"))
            menu.addItem(indented("守护进程未响应，可尝试重新登录或运行 pie doctor"))
        }
        menu.addItem(.separator())
        menu.addItem(item("诊断（pie doctor）", #selector(runDoctor)))
        // 退出：target 必须留 nil 走 responder chain 到 NSApp——AppDelegate 不响应
        // terminate(_:)，设 target=self 会被 autoenablesItems 校验禁用（真机验收抓到的 bug）
        menu.addItem(NSMenuItem(title: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: ""))
    }

    @objc func runDoctor() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/local/bin/pie")
        p.arguments = ["doctor"]
        let pipe = Pipe()
        p.standardError = pipe
        p.standardOutput = pipe
        let out: String
        do {
            try p.run()
            p.waitUntilExit()
            out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        } catch {
            out = "无法运行 /usr/local/bin/pie：\(error.localizedDescription)"
        }
        let alert = NSAlert()
        alert.messageText = "pie doctor"
        alert.informativeText = out
        alert.runModal()
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        i.isEnabled = false
        return i
    }
    private func indented(_ title: String) -> NSMenuItem {
        let i = disabled(title)
        i.indentationLevel = 1
        return i
    }
    private func item(_ title: String, _ sel: Selector) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: sel, keyEquivalent: "")
        i.target = self
        return i
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // 无 Dock 图标（与 Info.plist LSUIElement 双保险）
app.run()
