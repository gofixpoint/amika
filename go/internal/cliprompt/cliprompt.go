// Package cliprompt holds the interactive confirmation prompt shared by the
// CLI's destructive commands.
package cliprompt

import (
	"bufio"
	"fmt"
	"strings"
)

// Confirm asks message as a yes/no question and reads the answer from reader,
// repeating the question until it gets one it understands. It returns an error
// only when reader fails (including EOF), so a caller that cannot prompt
// surfaces that rather than silently treating it as "no".
func Confirm(message string, reader *bufio.Reader) (bool, error) {
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
