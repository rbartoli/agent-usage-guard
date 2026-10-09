# A heavy session resumed after two hours: the guard asks before the first
# prompt re-writes its expired cache, and "Compact, then send" shrinks it first.
Source demo/tapes/settings.tape
Output demo/out/cold-cache.gif
Hide
Type "demo/run-demo.sh cold-cache" Enter
Wait+Screen /Which tests cover it\?/
Sleep 1.5s
Show
Sleep 600ms
Type "Wire secure_cookies through and fix the README claim."
Sleep 500ms
Enter
Wait+Screen /Send this prompt\?/
Sleep 3.5s
Enter
Wait+Screen /Secure only when it is set/
Sleep 2s
Hide
Ctrl+C
Ctrl+C
Sleep 2s
