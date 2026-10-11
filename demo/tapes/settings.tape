# Shared by every scene. demo/render.sh runs the scenes and builds the video.
# A scene holds the guard's dialog, and the screen that follows the answer,
# long enough to read at about 20 characters a second.
# About 70 columns, so the text stays readable when a feed shows the video
# 600-700 px wide; the window sits on a margin in the caption's colour.
# Lines wrap at that width, so a Wait+Screen matches text that cannot: the
# guard dialog's footer, or the first words of a reply.
Set Shell "bash"
Set Width 1440
Set Height 1336
Set FontSize 30
Set FontFamily "DejaVu Sans Mono"
Set LetterSpacing 0
Set LineHeight 1.15
Set Padding 32
Set Margin 48
Set MarginFill "#1c2230"
Set WindowBar Colorful
Set WindowBarSize 44
Set BorderRadius 12
Set Framerate 25
Set TypingSpeed 22ms
Set WaitTimeout 90s
Set Theme {"background":"#0d1117","foreground":"#c9d1d9","black":"#484f58","red":"#ff7b72","green":"#3fb950","yellow":"#d29922","blue":"#58a6ff","magenta":"#bc8cff","cyan":"#39c5cf","white":"#f0f6fc","brightBlack":"#6e7681","brightRed":"#ffa198","brightGreen":"#56d364","brightYellow":"#e3b341","brightBlue":"#79c0ff","brightMagenta":"#d2a8ff","brightCyan":"#56d4dd","brightWhite":"#ffffff"}
