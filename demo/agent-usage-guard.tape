# Render from the repository root:
# Requires an authenticated Claude Code CLI, VHS v0.11.0, ttyd, ffmpeg,
# and the DejaVu Sans Mono font.
# Reproducing this recording launches Claude's interactive UI and consumes usage.
# vhs demo/agent-usage-guard.tape

Output assets/agent-usage-guard.gif

Set Shell "bash"
Set Width 1200
Set Height 640
Set FontSize 18
Set FontFamily "DejaVu Sans Mono"
Set LetterSpacing 0
Set LineHeight 1.15
Set Padding 28
Set Framerate 24
Set TypingSpeed 1ms
Set WaitTimeout 150s
Set Theme {"background":"#0d1117","foreground":"#c9d1d9","black":"#484f58","red":"#ff7b72","green":"#3fb950","yellow":"#d29922","blue":"#58a6ff","magenta":"#bc8cff","cyan":"#39c5cf","white":"#f0f6fc","brightBlack":"#6e7681","brightRed":"#ffa198","brightGreen":"#56d364","brightYellow":"#e3b341","brightBlue":"#79c0ff","brightMagenta":"#d2a8ff","brightCyan":"#56d4dd","brightWhite":"#ffffff"}

# The prompt asks for five parallel agents against a default ceiling of four, so
# the fifth call trips the active-agent guard on its own. Nothing here tells
# Claude what to say about it: what lands on screen is Claude Code's permission
# dialog carrying the guard's own message, and the wait below matches that hook
# text rather than anything the model wrote.
Hide
Type "python3 demo/run_demo.py"
Enter
Sleep 5s
Type "Audit this fictional release candidate. Your first response must contain exactly five Agent tool calls in one parallel batch and no other tools: audit session cookies in src/auth.py; audit cookie lifetime handling in src/auth.py; audit note lookup in src/database.py; audit container hardening in deploy/Dockerfile; audit the security claims in README.md. Use each description once, and never resume or retry an Agent afterwards."
Enter
Wait+Screen@120s /4 agents are already active/
Sleep 2s
Show
Sleep 4s
Hide
Escape
Sleep 1s
Type "/exit"
Enter
Sleep 2s
