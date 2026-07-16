// Pie Link 顶栏 app：~/.pie/daemon.sock 的瘦客户端。菜单点开才查询，无常驻轮询。
import AppKit

let socketPath = (NSHomeDirectory() as NSString).appendingPathComponent(".pie/daemon.sock")

/// 菜单 / 活动窗口文案本地化。跟随系统语言，覆盖扩展现有 6 个 locale，未命中回退 en。
/// 实现从简：内联 strings 表按 `Locale.preferredLanguages` 首个匹配项选列，不引
/// .lproj / NSLocalizedString 基建。品牌统一「Pie Link」，不出现 "daemon / 守护进程"。
enum L10n {
    /// 进程启动时定一次的目标语言（6 选 1）。
    static let lang: String = {
        for raw in Locale.preferredLanguages {
            let c = raw.lowercased()
            if c.hasPrefix("zh") {
                if c.contains("hant") || c.contains("-tw") || c.contains("-hk") || c.contains("-mo") { return "zh-TW" }
                return "zh-CN"
            }
            if c.hasPrefix("ja") { return "ja" }
            if c.hasPrefix("es") { return "es-419" }
            if c.hasPrefix("pt") { return "pt-BR" }
            if c.hasPrefix("en") { return "en" }
        }
        return "en"
    }()

    static func t(_ key: String) -> String {
        let row = table[key]
        return row?[lang] ?? row?["en"] ?? key
    }

    private static let table: [String: [String: String]] = [
        // 菜单：状态行
        "running": [
            "en": "Running", "zh-CN": "运行中", "zh-TW": "運行中",
            "ja": "実行中", "es-419": "En ejecución", "pt-BR": "Em execução",
        ],
        "notRunning": [
            "en": "Pie Link · Not running", "zh-CN": "Pie Link · 未运行", "zh-TW": "Pie Link · 未運行",
            "ja": "Pie Link · 停止中", "es-419": "Pie Link · No está en ejecución",
            "pt-BR": "Pie Link · Não está em execução",
        ],
        "extConnected": [
            "en": "Browser extension: Connected", "zh-CN": "浏览器扩展：已连接",
            "zh-TW": "瀏覽器擴充功能：已連接", "ja": "ブラウザ拡張機能：接続済み",
            "es-419": "Extensión del navegador: Conectada", "pt-BR": "Extensão do navegador: Conectada",
        ],
        "extDisconnected": [
            "en": "Browser extension: Disconnected", "zh-CN": "浏览器扩展：未连接",
            "zh-TW": "瀏覽器擴充功能：未連接", "ja": "ブラウザ拡張機能：未接続",
            "es-419": "Extensión del navegador: Desconectada", "pt-BR": "Extensão do navegador: Desconectada",
        ],
        "notResponding": [
            "en": "Pie Link service isn't responding. Try signing out and back in, or run pie doctor",
            "zh-CN": "Pie Link 服务未响应，可尝试重新登录或运行 pie doctor",
            "zh-TW": "Pie Link 服務未回應，可嘗試重新登入或執行 pie doctor",
            "ja": "Pie Link サービスが応答しません。再ログインするか pie doctor を実行してください",
            "es-419": "El servicio de Pie Link no responde. Intenta volver a iniciar sesión o ejecuta pie doctor",
            "pt-BR": "O serviço do Pie Link não está respondendo. Tente sair e entrar de novo, ou execute pie doctor",
        ],
        // 菜单：动作项
        "activityMenu": [
            "en": "Activity / Logs…", "zh-CN": "活动 / 日志…", "zh-TW": "活動 / 日誌…",
            "ja": "アクティビティ / ログ…", "es-419": "Actividad / Registros…", "pt-BR": "Atividade / Registros…",
        ],
        "diagnose": [
            "en": "Diagnose (pie doctor)", "zh-CN": "诊断（pie doctor）", "zh-TW": "診斷（pie doctor）",
            "ja": "診断（pie doctor）", "es-419": "Diagnóstico (pie doctor)", "pt-BR": "Diagnóstico (pie doctor)",
        ],
        "quit": [
            "en": "Quit Pie Link", "zh-CN": "退出 Pie Link", "zh-TW": "結束 Pie Link",
            "ja": "Pie Link を終了", "es-419": "Salir de Pie Link", "pt-BR": "Sair do Pie Link",
        ],
        // 活动窗口
        "activityTitle": [
            "en": "Pie Link · Activity / Logs", "zh-CN": "Pie Link · 活动 / 日志",
            "zh-TW": "Pie Link · 活動 / 日誌", "ja": "Pie Link · アクティビティ / ログ",
            "es-419": "Pie Link · Actividad / Registros", "pt-BR": "Pie Link · Atividade / Registros",
        ],
        "sectionRunning": [
            "en": "Running", "zh-CN": "正在运行", "zh-TW": "正在運行",
            "ja": "実行中", "es-419": "En ejecución", "pt-BR": "Em execução",
        ],
        "sectionRecent": [
            "en": "Recent", "zh-CN": "最近执行", "zh-TW": "最近執行",
            "ja": "最近の実行", "es-419": "Recientes", "pt-BR": "Recentes",
        ],
        "loading": [
            "en": "Loading…", "zh-CN": "查询中…", "zh-TW": "查詢中…",
            "ja": "読み込み中…", "es-419": "Cargando…", "pt-BR": "Carregando…",
        ],
        "noRunning": [
            "en": "No skills running", "zh-CN": "当前无运行中的 skill", "zh-TW": "目前無運行中的 skill",
            "ja": "実行中の skill はありません", "es-419": "No hay skills en ejecución",
            "pt-BR": "Nenhuma skill em execução",
        ],
        "notRespondingShort": [
            "en": "Pie Link service isn't responding", "zh-CN": "Pie Link 服务未响应",
            "zh-TW": "Pie Link 服務未回應", "ja": "Pie Link サービスが応答しません",
            "es-419": "El servicio de Pie Link no responde", "pt-BR": "O serviço do Pie Link não está respondendo",
        ],
        "noRecent": [
            "en": "No execution history", "zh-CN": "暂无执行记录", "zh-TW": "暫無執行記錄",
            "ja": "実行履歴はありません", "es-419": "Sin historial de ejecución", "pt-BR": "Sem histórico de execução",
        ],
        // 表头
        "colSkill": [
            "en": "Skill", "zh-CN": "Skill", "zh-TW": "Skill", "ja": "Skill", "es-419": "Skill", "pt-BR": "Skill",
        ],
        "colElapsed": [
            "en": "Elapsed", "zh-CN": "已运行", "zh-TW": "已運行",
            "ja": "経過時間", "es-419": "Transcurrido", "pt-BR": "Decorrido",
        ],
        "colEntry": [
            "en": "Skill · entry", "zh-CN": "Skill · entry", "zh-TW": "Skill · entry",
            "ja": "Skill · entry", "es-419": "Skill · entry", "pt-BR": "Skill · entry",
        ],
        "colResult": [
            "en": "Result", "zh-CN": "结果", "zh-TW": "結果",
            "ja": "結果", "es-419": "Resultado", "pt-BR": "Resultado",
        ],
        "colDuration": [
            "en": "Duration", "zh-CN": "耗时", "zh-TW": "耗時",
            "ja": "所要時間", "es-419": "Duración", "pt-BR": "Duração",
        ],
        "colTime": [
            "en": "Time", "zh-CN": "时间", "zh-TW": "時間",
            "ja": "時刻", "es-419": "Hora", "pt-BR": "Hora",
        ],
        "timedOut": [
            "en": "⏱ Timed out", "zh-CN": "⏱ 超时", "zh-TW": "⏱ 逾時",
            "ja": "⏱ タイムアウト", "es-419": "⏱ Expiró", "pt-BR": "⏱ Expirou",
        ],
        "cannotRunPie": [
            "en": "Couldn't run /usr/local/bin/pie: ", "zh-CN": "无法运行 /usr/local/bin/pie：",
            "zh-TW": "無法執行 /usr/local/bin/pie：", "ja": "/usr/local/bin/pie を実行できません：",
            "es-419": "No se pudo ejecutar /usr/local/bin/pie: ", "pt-BR": "Não foi possível executar /usr/local/bin/pie: ",
        ],
    ]
}

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
        ensureDaemonRunning()
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
            menu.addItem(disabled("Pie Link v\(ver) · \(L10n.t("running"))"))
            let ext = s["extensionConnected"] as? Bool ?? false
            menu.addItem(disabled(L10n.t(ext ? "extConnected" : "extDisconnected")))
        } else {
            menu.addItem(disabled(L10n.t("notRunning")))
            menu.addItem(indented(L10n.t("notResponding")))
        }
        menu.addItem(.separator())
        menu.addItem(item(L10n.t("activityMenu"), #selector(openActivity)))
        menu.addItem(item(L10n.t("diagnose"), #selector(runDoctor)))
        menu.addItem(.separator())
        // 退出 = 图标和后台服务一起停（Docker Desktop 模型）：先 bootout daemon
        // （直接杀进程会被 launchd KeepAlive 拉活），再退自身。重开 app 时
        // applicationDidFinishLaunching 反向 bootstrap daemon 回来。
        // 自定义 selector 实现在 AppDelegate 上，target=self 可过 autoenablesItems 校验
        //（历史坑仅针对 NSApplication.terminate(_:)——AppDelegate 不响应它）。
        menu.addItem(item(L10n.t("quit"), #selector(quitPieLink)))
    }

    @objc func quitPieLink() {
        _ = Self.launchctl(["bootout", "gui/\(getuid())/ai.wiseria.pie"])
        NSApp.terminate(nil)
    }

    /// Launchpad 重开 app 时把 daemon 一并拉起。已在跑时 bootstrap 报错，忽略即幂等。
    private func ensureDaemonRunning() {
        let plist = (NSHomeDirectory() as NSString)
            .appendingPathComponent("Library/LaunchAgents/ai.wiseria.pie.plist")
        guard FileManager.default.fileExists(atPath: plist) else { return }
        _ = Self.launchctl(["bootstrap", "gui/\(getuid())", plist])
    }

    private static func launchctl(_ args: [String]) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = args
        do {
            try p.run()
            p.waitUntilExit()
            return p.terminationStatus == 0
        } catch { return false }
    }

    // 独立活动窗口：懒建单例，避免重复开窗。accessory app 需显式 activate 才前置。
    @objc func openActivity() {
        ActivityWindowController.shared.present()
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
            out = L10n.t("cannotRunPie") + error.localizedDescription
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

// 独立日志/活动窗口：展示「正在运行」（可见期 1.5s 轮询，关窗即停）+「最近执行」（打开查一次）。
// socket 查询全在后台线程，主线程只做 UI reload——queryDaemon 是 1s 阻塞 socket，直接上主线程会周期性卡 UI。
final class ActivityWindowController: NSWindowController, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate {
    static let shared = ActivityWindowController()

    private struct RunningRow { let skill: String; let dur: String }
    private struct RecentRow { let title: String; let result: String; let ms: String; let time: String }

    private let runningTable = NSTableView()
    private let recentTable = NSTableView()
    private var runningRows: [RunningRow] = []
    private var recentRows: [RecentRow] = []
    private var runningPlaceholder: String? = L10n.t("loading")
    private var recentPlaceholder: String? = L10n.t("loading")
    private var timer: Timer?

    private static let timeFmt: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MM/dd HH:mm:ss"
        return f
    }()

    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 420),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered, defer: false)
        window.title = L10n.t("activityTitle")
        super.init(window: window)
        window.delegate = self
        window.center()
        buildUI()
    }
    required init?(coder: NSCoder) { fatalError("not supported") }

    // MARK: 展示 / 生命周期

    /// 菜单入口调用：显示窗口 + 前置 + 立即刷新两区 + 启动「正在运行」轮询。
    func present() {
        showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
        refreshRecent()   // 历史无实时性要求，打开查一次
        refreshRunning()  // 立即查一次，随后由 timer 续刷
        startTimer()
    }

    private func startTimer() {
        timer?.invalidate()
        // timer 绑窗口可见期；windowWillClose 里 invalidate → 关窗零后台活动。
        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            self?.refreshRunning()
        }
    }

    func windowWillClose(_: Notification) {
        timer?.invalidate()
        timer = nil
    }

    // MARK: 数据刷新（后台查询 → 主线程 reload）

    private func refreshRunning() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let status = queryDaemon("status")
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let s = status {
                    let arr = s["runningSkills"] as? [[String: Any]] ?? []
                    self.runningRows = arr.map { r in
                        let name = r["name"] as? String ?? "?"
                        let started = (r["startedAt"] as? NSNumber)?.doubleValue ?? 0
                        return RunningRow(skill: name, dur: Self.formatDuration(sinceMs: started))
                    }
                    self.runningPlaceholder = self.runningRows.isEmpty ? L10n.t("noRunning") : nil
                } else {
                    self.runningRows = []
                    self.runningPlaceholder = L10n.t("notRespondingShort")
                }
                self.runningTable.reloadData()
            }
        }
    }

    private func refreshRecent() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = queryDaemon("list_audit", ["limit": 50])
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let r = result {
                    let entries = r["entries"] as? [[String: Any]] ?? []
                    self.recentRows = entries.map { e in
                        let name = e["skillName"] as? String ?? "?"
                        let entry = e["entry"] as? String ?? "?"
                        let exit = (e["exitCode"] as? NSNumber)?.intValue ?? -1
                        let timedOut = (e["timedOut"] as? Bool) ?? false
                        let ms = (e["ms"] as? NSNumber)?.intValue ?? 0
                        let ts = (e["ts"] as? NSNumber)?.doubleValue ?? 0
                        let resultStr = timedOut ? L10n.t("timedOut") : (exit == 0 ? "✓" : "✗ exit \(exit)")
                        return RecentRow(
                            title: "\(name) · \(entry)",
                            result: resultStr,
                            ms: Self.formatMs(ms),
                            time: Self.formatTime(ts))
                    }
                    self.recentPlaceholder = self.recentRows.isEmpty ? L10n.t("noRecent") : nil
                } else {
                    self.recentRows = []
                    self.recentPlaceholder = L10n.t("notRespondingShort")
                }
                self.recentTable.reloadData()
            }
        }
    }

    // MARK: 格式化

    private static func formatDuration(sinceMs ms: Double) -> String {
        let secs = max(0, Int(Date().timeIntervalSince1970 - ms / 1000.0))
        if secs < 60 { return "\(secs)s" }
        if secs < 3600 { return "\(secs / 60)m \(secs % 60)s" }
        return "\(secs / 3600)h \((secs % 3600) / 60)m"
    }
    private static func formatMs(_ ms: Int) -> String {
        ms < 1000 ? "\(ms) ms" : String(format: "%.1f s", Double(ms) / 1000.0)
    }
    private static func formatTime(_ tsMs: Double) -> String {
        tsMs > 0 ? timeFmt.string(from: Date(timeIntervalSince1970: tsMs / 1000.0)) : "—"
    }

    // MARK: UI 组装（窗口不可 resize → 固定 frame 布局，无 auto layout）

    private func buildUI() {
        guard let window = window else { return }
        let W: CGFloat = 480, H: CGFloat = 420, M: CGFloat = 12
        let content = NSView(frame: NSRect(x: 0, y: 0, width: W, height: H))

        let runHeader = header(L10n.t("sectionRunning"))
        runHeader.frame = NSRect(x: M, y: H - M - 18, width: W - 2 * M, height: 18)
        let runScroll = makeTable(runningTable, columns: [("skill", L10n.t("colSkill"), 300), ("dur", L10n.t("colElapsed"), 130)])
        runScroll.frame = NSRect(x: M, y: 284, width: W - 2 * M, height: 100)

        let recHeader = header(L10n.t("sectionRecent"))
        recHeader.frame = NSRect(x: M, y: 260, width: W - 2 * M, height: 18)
        let recScroll = makeTable(
            recentTable,
            columns: [
                ("title", L10n.t("colEntry"), 210), ("result", L10n.t("colResult"), 80),
                ("ms", L10n.t("colDuration"), 66), ("time", L10n.t("colTime"), 96),
            ])
        recScroll.frame = NSRect(x: M, y: M, width: W - 2 * M, height: 242)

        content.addSubview(runHeader)
        content.addSubview(runScroll)
        content.addSubview(recHeader)
        content.addSubview(recScroll)
        window.contentView = content
    }

    private func header(_ s: String) -> NSTextField {
        let tf = NSTextField(labelWithString: s)
        tf.font = .boldSystemFont(ofSize: 12)
        tf.textColor = .secondaryLabelColor
        return tf
    }

    private func makeTable(_ table: NSTableView, columns: [(id: String, title: String, width: CGFloat)]) -> NSScrollView {
        for c in columns {
            let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(c.id))
            col.title = c.title
            col.width = c.width
            table.addTableColumn(col)
        }
        table.dataSource = self
        table.delegate = self
        table.usesAlternatingRowBackgroundColors = true
        table.rowHeight = 18
        table.allowsColumnResizing = true
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.autohidesScrollers = true
        return scroll
    }

    // MARK: NSTableViewDataSource / Delegate

    func numberOfRows(in tableView: NSTableView) -> Int {
        if tableView === runningTable { return runningPlaceholder != nil ? 1 : runningRows.count }
        return recentPlaceholder != nil ? 1 : recentRows.count
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let id = tableColumn?.identifier.rawValue ?? ""
        var text = ""
        var dim = false
        if tableView === runningTable {
            if let ph = runningPlaceholder {
                text = id == "skill" ? ph : ""
                dim = true
            } else {
                let r = runningRows[row]
                text = id == "skill" ? r.skill : r.dur
            }
        } else {
            if let ph = recentPlaceholder {
                text = id == "title" ? ph : ""
                dim = true
            } else {
                let r = recentRows[row]
                switch id {
                case "title": text = r.title
                case "result": text = r.result
                case "ms": text = r.ms
                default: text = r.time
                }
            }
        }
        let tf = NSTextField(labelWithString: text)
        tf.lineBreakMode = .byTruncatingTail
        tf.font = .systemFont(ofSize: 12)
        tf.textColor = dim ? .secondaryLabelColor : .labelColor
        return tf
    }

    // 占位/空态行不可选中。
    func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool {
        if tableView === runningTable { return runningPlaceholder == nil }
        return recentPlaceholder == nil
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // 无 Dock 图标（与 Info.plist LSUIElement 双保险）
app.run()
