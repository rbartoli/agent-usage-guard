# Twenty tool calls in a row at 431k context: the twenty-first asks, and
# "Compact after this turn" lets the turn finish, then compacts.
Source demo/tapes/settings.tape
Output demo/out/heavy-context.gif
Hide
Type "demo/run-demo.sh heavy-context" Enter
Wait+Screen /Is samesite set anywhere else\?/
Sleep 1.5s
Show
Sleep 600ms
Type "Check every caller before we change the cookie flags."
Sleep 500ms
Enter
Wait+Screen /Keep working at/
Sleep 3.5s
Down
Sleep 400ms
Enter
Wait+Screen /\(\d+ lines\)/
Sleep 2s
Hide
Ctrl+C
Ctrl+C
Sleep 2s
