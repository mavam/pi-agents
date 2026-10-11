# Agent-to-agent messaging, with real tools and an offline scripted provider.
# Run demo/record.sh messaging to regenerate demo/messaging.gif.
# The fixer edits only the throwaway copy of demo/project.

Set Shell "bash"
Set FontFamily "FiraCode Nerd Font Mono"
Set FontSize 14
Set Width 1240
Set Height 880
Set Padding 12
Set Framerate 15
Set TypingSpeed 25ms
Set Theme "Catppuccin Mocha"

Hide
Type `export HOME="$DEMO" PI_CODING_AGENT_DIR="$DEMO/.pi/agent" PS1='$ '` Enter
Type `alias pi='pi --no-extensions -e "$AGENTS/src/index.ts" -e "$AGENTS/demo/provider.ts" --no-session --offline --no-skills --no-context-files --no-prompt-templates --no-themes --model demo/sol'` Enter
Type `cd "$DEMO/project" && clear` Enter
Show

Type "pi" Enter
Sleep 2.5s
Type "Find and fix a concurrency bug in src/agents/graphs.ts. Have scout message fixer with the finding, and fixer message scout back."
Sleep 0.8s
Enter
Sleep 4s

# Watch scout's steer queue while fixer is working.
Ctrl+Q
Wait+Screen@60s /scout → fixer/
Sleep 3s
Wait+Screen@60s /The repair is in/
Sleep 3s

# Read the exchange, filter by agent, and expand the finding.
Type "/messages" Enter
Sleep 2s
Type "scout"
Sleep 1.5s
Down
Enter
Sleep 4s

# Attach to the recipient to see the received finding, edit, and reply.
Right
Sleep 4s
Escape
Sleep 1s

# Return to the stream and attach to the reply's recipient (scout).
Type "/messages" Enter
Sleep 2s
Right
Sleep 3s
Escape
Sleep 1s
