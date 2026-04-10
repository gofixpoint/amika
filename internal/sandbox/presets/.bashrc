# Set terminal type for proper rendering in tools like less, git, etc.
export TERM=xterm

# Set up the prompt (works on both light and dark terminals)

PS1='\[\e[1;34m\]\u@\h\[\e[0m\]\n\[\e[1;35m\]\w\[\e[0m\]\$ '

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
