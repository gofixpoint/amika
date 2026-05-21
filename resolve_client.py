import sys
import re

with open("internal/apiclient/client.go", "r") as f:
    content = f.read()

# For the CreateSandboxRequest conflict, keep HEAD (which has TTL, WarnBefore, ClaudeCredentialName)
def resolve_struct(match):
    head = match.group(1)
    return head

content = re.sub(r'<<<<<<< HEAD\n(.*?ClaudeCredentialName.*?)=======\n.*?\n>>>>>>> upstream/main\n', resolve_struct, content, flags=re.DOTALL)

# For all the other conflicts (which are about doJSON calls with apiBasePath), use upstream/main
def resolve_apipath(match):
    main = match.group(2)
    return main

content = re.sub(r'<<<<<<< HEAD\n(.*?)\n=======\n(.*?)\n>>>>>>> upstream/main\n', resolve_apipath, content, flags=re.DOTALL)

with open("internal/apiclient/client.go", "w") as f:
    f.write(content)

