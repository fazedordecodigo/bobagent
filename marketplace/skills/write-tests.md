---
name: write-tests
description: Add focused automated tests for new or changed behaviour using the project's existing test setup
---
1. Detect the test runner and conventions from the repo (package.json scripts, pytest.ini, Cargo.toml, existing test files). Do not add a new framework.
2. List the behaviours to cover: the happy path, edge cases, and the failure modes the code explicitly handles.
3. Write the smallest tests that would fail if the behaviour broke. Prefer real inputs and outputs over mocks; mock only slow or external systems.
4. Name tests after the behaviour ("rejects expired tokens"), not the function.
5. Run the suite, make it pass, and run it once more to check for flakiness.
6. Summarize which behaviours are now covered and anything you chose not to test.
