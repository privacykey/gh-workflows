# List available commands
default:
    @just --list

# Lint reusable workflows and composite actions
[group("dev")]
lint:
    actionlint
    for f in actions/*/action.yml; do python3 -c "import sys,yaml; yaml.safe_load(open(sys.argv[1]))" "$f"; done
