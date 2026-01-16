package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Println("wisp - a command-line tool")
		os.Exit(0)
	}

	fmt.Printf("Hello, %s!\n", os.Args[1])
}
