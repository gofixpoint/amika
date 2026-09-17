package sandboxcmd

// confirm.go holds the interactive confirmation prompt shared by the
// destructive rig commands.

import (
	"bufio"
	"fmt"
	"strings"
)

func confirmAction(message string, reader *bufio.Reader) (bool, error) {
	for {
		fmt.Printf("%s [y/n] ", message)
		answer, err := reader.ReadString('\n')
		if err != nil {
			return false, fmt.Errorf("failed to read confirmation: %w", err)
		}
		answer = strings.TrimSpace(strings.ToLower(answer))
		switch answer {
		case "y", "yes":
			return true, nil
		case "n", "no":
			return false, nil
		case "":
			fmt.Println("Please enter 'y' or 'n'.")
		default:
			fmt.Println("Invalid response. Please enter 'y' or 'n'.")
		}
	}
}
