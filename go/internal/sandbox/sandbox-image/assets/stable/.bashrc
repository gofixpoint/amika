# Only set TERM if not already set by tmux or a capable terminal like Ghostty or Alacritty.
if [ -z "$TMUX" ] && [ "$TERM" = "linux" -o "$TERM" = "dumb" ]; then
  export TERM=xterm-256color
fi

# Set up the prompt (works on both light and dark terminals). Just the working
# directory: the user@host line is dropped because the host is an opaque,
# per-sandbox container id that only adds noise to SSH sessions and command output.

PS1='\[\e[1;35m\]\w\[\e[0m\]\$ '

# History settings
HISTCONTROL=ignoredups:erasedups
HISTSIZE=1000
HISTFILESIZE=1000
HISTFILE=~/.bash_history

# Enable color support for ls
eval "$(dircolors -b)"
alias ls='ls --color=auto'

# Enable programmable completion if available
if [ -f /usr/share/bash-completion/bash_completion ]; then
    . /usr/share/bash-completion/bash_completion
elif [ -f /etc/bash_completion ]; then
    . /etc/bash_completion
fi

export PNPM_HOME="$HOME/.local/share/pnpm"
export PATH="$PNPM_HOME:$PATH"

# Greet an interactive SSH login, once. This file runs for every interactive
# bash, so the login test is what keeps a nested shell from repeating the
# banner: sshd starts a session's shell as a login shell, and a shell the user
# opens inside that session is not one. welcome.sh decides the rest; see
# assets/stable/welcome.sh. Kept last so a failure here cannot cost the shell
# any of the setup above.
if shopt -q login_shell && [ -x /usr/lib/amika/welcome.sh ]; then
  /usr/lib/amika/welcome.sh
fi
