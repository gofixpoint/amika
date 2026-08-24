# Only set TERM if not already set by tmux or a capable terminal like Ghostty or Alacritty.
if [ -z "$TMUX" ] && [ "$TERM" = "linux" -o "$TERM" = "dumb" ]; then
  export TERM=xterm-256color
fi

# Set up the prompt (works on both light and dark terminals)

autoload -Uz colors
colors
PROMPT='%B%F{blue}%n@%m%f%b
%B%F{magenta}%~%f%b%# '

setopt histignorealldups sharehistory

# Use emacs keybindings even if our EDITOR is set to vi
bindkey -e

export VISUAL="vim"
export EDITOR="vim"

# Edit the current command line in $EDITOR with Ctrl-X Ctrl-E
autoload -U edit-command-line
zle -N edit-command-line
bindkey '^X^E' edit-command-line

# Keep 1000 lines of history within the shell and save it to ~/.zsh_history:
HISTSIZE=1000
SAVEHIST=1000
HISTFILE=~/.zsh_history

# Use modern completion system.
#
# -u skips compinit's security audit of $fpath. Without it, a world-writable
# completion directory makes compinit stop and ask
#
#   Ignore insecure directories and files and continue [y] or abort compinit [n]?
#
# There is nobody to answer that in a sandbox and usually no terminal either, so
# zsh gives up and every shell starts with "compinit: initialization aborted"
# and zero completions. E2B's template builder ends with an unconditional
# `chmod -R 777 /usr/local`, which hits /usr/local/share/zsh/site-functions, so
# this is reachable on a stock image with no user involvement.
#
# Skipping the audit rather than ignoring it (-i) is deliberate: -i drops the
# offending directory from $fpath, silently losing any completion installed
# there. A sandbox is a single trust domain — the runtime user already has
# passwordless sudo — so there is no privilege boundary for the audit to
# protect. Amika still repairs the directory modes at boot; this only keeps a
# permissions surprise from ever hanging a shell.
autoload -Uz compinit
compinit -u

zstyle ':completion:*' auto-description 'specify: %d'
zstyle ':completion:*' completer _expand _complete _correct _approximate
zstyle ':completion:*' format 'Completing %d'
zstyle ':completion:*' group-name ''
zstyle ':completion:*' menu select=2
eval "$(dircolors -b)"
zstyle ':completion:*:default' list-colors ${(s.:.)LS_COLORS}
zstyle ':completion:*' list-colors ''
zstyle ':completion:*' list-prompt %SAt %p: Hit TAB for more, or the character to insert%s
zstyle ':completion:*' matcher-list '' 'm:{a-z}={A-Z}' 'm:{a-zA-Z}={A-Za-z}' 'r:|[._-]=* r:|=* l:|=*'
zstyle ':completion:*' menu select=long
zstyle ':completion:*' select-prompt %SScrolling active: current selection at %p%s
zstyle ':completion:*' use-compctl false
zstyle ':completion:*' verbose true

zstyle ':completion:*:*:kill:*:processes' list-colors '=(#b) #([0-9]#)*=0=01;31'
zstyle ':completion:*:kill:*' command 'ps -u $USER -o pid,%cpu,tty,cputime,cmd'

export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"
