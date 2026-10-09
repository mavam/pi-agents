# The README demo: an audit graph two levels deep, a look at its results in
# /agents, and three luna agents telling jokes. Run `demo/record.sh` from
# anywhere to regenerate demo/agents.gif.
#
# pi runs with DEMO as its HOME, offline, and with demo/provider.ts as its
# only model provider, so the recording shows neither personal skills,
# paths, nor accounts, and nothing is sent anywhere. The agents are real:
# they read the files of demo/project, start helpers, and pass results on.

# demo/record.sh supplies the output path with vhs -o.

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

Type "pi"
Enter
Sleep 2.5s

# A graph two levels deep, on three models.
Type "Audit src: a luna agent maps it, a fable and a luna agent review src/agents and src/ui with one helper per file, and a sol agent ranks the top findings."
Sleep 0.8s
Enter
Sleep 4s
# Focus the panel to see the whole tree.
Ctrl+Q
Wait+Screen@90s /The audit is in/
Sleep 3.5s

# The results, agent by agent.
Type "/agents"
Sleep 0.4s
Enter
Sleep 2.5s
Down
Sleep 1.2s
Down
Sleep 1.2s
Down
Sleep 2.5s
Down
Sleep 3s
Space
Sleep 1.5s
Down
Sleep 2s
Escape
Sleep 1s

# Three agents at once, on one model.
Type "Spawn three luna agents that each tell a one-line joke: about Rust, Go, and TypeScript."
Sleep 0.8s
Enter
Wait+Screen@60s /All three jokes are in/
Sleep 4s
