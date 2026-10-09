# Four agents process 10.9M tokens between them: the next agent Claude starts
# waits for an answer, and declining it keeps the work in the main conversation.
Source demo/tapes/settings.tape
Output demo/out/agent-tokens.gif
Hide
Type "demo/run-demo.sh agent-tokens" Enter
Wait+Screen /Is anything still unreviewed\?/
Sleep 1.5s
Show
Sleep 600ms
Type "Re-check each finding with its own agent."
Sleep 500ms
Enter
Wait+Screen /Start this agent\?/
Sleep 8s
Down
Sleep 1.2s
Enter
Wait+Screen /Holding off on the fixes agent/
Sleep 7s
Hide
Ctrl+C
Ctrl+C
Sleep 2s
