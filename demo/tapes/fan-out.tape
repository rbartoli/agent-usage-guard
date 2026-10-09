# Claude starts five agents at once against a limit of four: the fifth waits
# for an answer, and declining it leaves the four running.
Source demo/tapes/settings.tape
Output demo/out/fan-out.gif
Hide
Type "demo/run-demo.sh fan-out" Enter
Wait+Screen /Anything risky in the database change\?/
Sleep 1.5s
Show
Sleep 600ms
Type "Audit the release candidate: one agent per area, all in parallel."
Sleep 500ms
Enter
Wait+Screen /Start this agent\?/
Sleep 7s
Down
Sleep 1.2s
Enter
Wait+Screen /Four audits are running/
Sleep 5.5s
Hide
Ctrl+C
Ctrl+C
Sleep 2s
