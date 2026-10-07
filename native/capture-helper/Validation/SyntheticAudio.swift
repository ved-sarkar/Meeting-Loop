// Opt-in native validation fixture. Plays only a provided synthetic speech file.
// It never opens the microphone or captures a screen.
import AppKit
import Foundation

guard CommandLine.arguments.count == 2,
      let sound = NSSound(contentsOfFile: CommandLine.arguments[1], byReference: false) else {
    fputs("Expected a generated speech file\n", stderr)
    exit(1)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 400, height: 120),
                      styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Meeting Loop — synthetic audio test"
let label = NSTextField(wrappingLabelWithString: "Synthetic speech validation only.\nMicrophone is OFF.\nOnly this test application's audio is selected.")
label.frame = NSRect(x: 20, y: 20, width: 360, height: 80)
window.contentView?.addSubview(label)
window.makeKeyAndOrderFront(nil)
sound.volume = 0.05
sound.loops = true
DispatchQueue.global().async {
    while let line = readLine() {
        DispatchQueue.main.async {
            switch line {
            case "play": sound.play()
            case "pause": sound.stop()
            case "stop": sound.stop(); app.terminate(nil)
            default: break
            }
        }
    }
    DispatchQueue.main.async { sound.stop(); app.terminate(nil) }
}
print("synthetic-source-ready")
fflush(stdout)
app.run()
