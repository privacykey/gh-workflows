# List available commands
default:
    @just --list

# Lint reusable workflows and composite actions
[group("dev")]
lint:
    actionlint
    for f in actions/*/action.yml; do python3 -c "import sys,yaml; yaml.safe_load(open(sys.argv[1]))" "$f"; done

# Verify Apple workflow source/tag selection with isolated Git fixtures.
[group("dev")]
test:
    python3 tests/test_apple_provenance.py
    python3 tests/test_project_publication.py
