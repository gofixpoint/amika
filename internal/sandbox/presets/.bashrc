# Set up the prompt (multi-line, similar to zsh adam1 theme)

PS1='\u@\h\n\w\$ '

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
