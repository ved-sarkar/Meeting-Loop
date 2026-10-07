import AppKit
let size:CGFloat = 1024
let image = NSImage(size: NSSize(width:size,height:size))
image.lockFocus()
NSColor(calibratedRed:0.90,green:0.94,blue:0.85,alpha:1).setFill()
NSBezierPath(roundedRect:NSRect(x:32,y:32,width:960,height:960),xRadius:214,yRadius:214).fill()
let green=NSColor(calibratedRed:0.29,green:0.38,blue:0.23,alpha:1)
for y:CGFloat in [370,495,620] {
 let p=NSBezierPath();p.lineWidth=33;p.lineJoinStyle = .round;p.lineCapStyle = .round
 p.move(to:NSPoint(x:245,y:y));p.line(to:NSPoint(x:512,y:y-126));p.line(to:NSPoint(x:779,y:y));
 if y==620 {p.line(to:NSPoint(x:512,y:y+126));p.close()}
 green.setStroke();p.stroke()
}
image.unlockFocus()
let data=NSBitmapImageRep(data:image.tiffRepresentation!)!.representation(using:.png,properties:[:])!
try data.write(to:URL(fileURLWithPath:CommandLine.arguments[1]))
